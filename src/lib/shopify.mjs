// Shopify Admin API 访问层（v2 专用）。v1 保留自己的实现，互不影响。
//
// 限流处理对应文档 §9：按 Shopify throttle 状态退避重试，最多 3 次（SHOPIFY_MAX_RETRIES）。
// 识别两种限流形态：
//   1. HTTP 429 + Retry-After
//   2. HTTP 200 但 errors[].extensions.code === "THROTTLED"

const MAX_RETRIES = Number(process.env.SHOPIFY_MAX_RETRIES || 3);
const RETRY_BASE_MS = Number(process.env.SHOPIFY_RETRY_BASE_MS || 1000);
const MAX_WAIT_MS = Number(process.env.SHOPIFY_MAX_RETRY_WAIT_MS || 30000);

// 供卡片页脚展示"限流重试 N 次"，每次任务开始时由调用方 resetRetryStats()。
export const retryStats = { count: 0, lastWaitMs: 0 };

export function resetRetryStats() {
  retryStats.count = 0;
  retryStats.lastWaitMs = 0;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function backoffMs(attempt) {
  const base = RETRY_BASE_MS * 2 ** attempt;
  return Math.min(MAX_WAIT_MS, base + Math.floor(Math.random() * 250));
}

// 用 Shopify 返回的 cost 信息算"还需要多久才能凑够本次查询的成本"。
function throttleWaitMs(body) {
  const cost = body?.extensions?.cost;
  const status = cost?.throttleStatus;
  if (!status?.restoreRate) return null;
  const needed = Number(cost.requestedQueryCost || 0) - Number(status.currentlyAvailable || 0);
  if (needed <= 0) return null;
  return Math.min(MAX_WAIT_MS, Math.ceil((needed / status.restoreRate) * 1000));
}

function isThrottled(body) {
  return Array.isArray(body?.errors)
    && body.errors.some((error) => String(error?.extensions?.code || "").toUpperCase() === "THROTTLED");
}

async function post(queryText, variables, storeConfig) {
  const accessToken = await getAccessToken(storeConfig);
  const url = `https://${storeConfig.store}/admin/api/${storeConfig.apiVersion}/graphql.json`;

  for (let attempt = 0; ; attempt += 1) {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", "x-shopify-access-token": accessToken },
      body: JSON.stringify({ query: queryText, variables }),
    });

    if (response.status === 429) {
      if (attempt >= MAX_RETRIES) {
        throw new Error(`Shopify API 限流（HTTP 429），已重试 ${MAX_RETRIES} 次仍失败`);
      }
      const retryAfter = Number(response.headers.get("retry-after"));
      const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
        ? Math.min(MAX_WAIT_MS, retryAfter * 1000)
        : backoffMs(attempt);
      retryStats.count += 1;
      retryStats.lastWaitMs = waitMs;
      console.warn(`[shopify] 限流 429，${waitMs}ms 后重试（第 ${attempt + 1}/${MAX_RETRIES} 次）`);
      await sleep(waitMs);
      continue;
    }

    const body = await response.json().catch(() => ({}));

    if (isThrottled(body)) {
      if (attempt >= MAX_RETRIES) {
        throw new Error(`Shopify API 限流（THROTTLED），已重试 ${MAX_RETRIES} 次仍失败：${JSON.stringify(body.errors)}`);
      }
      const waitMs = throttleWaitMs(body) ?? backoffMs(attempt);
      retryStats.count += 1;
      retryStats.lastWaitMs = waitMs;
      console.warn(`[shopify] 限流 THROTTLED，${waitMs}ms 后重试（第 ${attempt + 1}/${MAX_RETRIES} 次）`);
      await sleep(waitMs);
      continue;
    }

    if (!response.ok || body.errors?.length) {
      throw new Error(`Shopify API error: ${JSON.stringify(body.errors || body)}`);
    }
    return body.data;
  }
}

export async function getAccessToken(storeConfig) {
  if (storeConfig.accessToken) return storeConfig.accessToken;
  if (storeConfig.cachedAccessToken) return storeConfig.cachedAccessToken;

  const response = await fetch(`https://${storeConfig.store}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "client_credentials",
      client_id: storeConfig.clientId,
      client_secret: storeConfig.clientSecret,
    }),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || !body.access_token) {
    throw new Error(`Shopify token request failed: HTTP ${response.status} ${JSON.stringify(body)}`);
  }
  storeConfig.cachedAccessToken = body.access_token;
  return body.access_token;
}

export async function graphql(storeConfig, queryText, variables) {
  return post(queryText, variables, storeConfig);
}

const SHOPIFYQL_QUERY = `#graphql
query Shopifyql($q: String!) {
  shopifyqlQuery(query: $q) {
    parseErrors
    tableData { columns { name } rows }
  }
}`;

// 执行一条 ShopifyQL 查询，返回 [{ 列名: 值 }] 形式的行。
export async function shopifyql(storeConfig, q) {
  const data = await post(SHOPIFYQL_QUERY, { q }, storeConfig);
  const result = data.shopifyqlQuery;
  if (result?.parseErrors?.length) {
    throw new Error(`ShopifyQL parse error: ${result.parseErrors.join(" | ")} (query: ${q})`);
  }
  return result?.tableData?.rows || [];
}
