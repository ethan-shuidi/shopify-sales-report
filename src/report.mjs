const reportType = (process.env.REPORT_TYPE || "daily").toLowerCase();

function readStores() {
  if (process.env.SHOPIFY_STORES_JSON) {
    let stores;
    try {
      stores = JSON.parse(process.env.SHOPIFY_STORES_JSON);
    } catch (error) {
      throw new Error(`SHOPIFY_STORES_JSON is not valid JSON: ${error.message}`);
    }
    if (!Array.isArray(stores) || stores.length === 0) {
      throw new Error("SHOPIFY_STORES_JSON must be a non-empty JSON array");
    }
    return stores.map((config, index) => normalizeStore(config, index));
  }

  // Temporary backwards compatibility for the original one-store setup.
  const required = ["SHOPIFY_STORE", "SHOPIFY_ACCESS_TOKEN", "FEISHU_WEBHOOK_URL"];
  for (const key of required) {
    if (!process.env[key]) throw new Error(`Missing environment variable: ${key}`);
  }
  return [normalizeStore({
    name: process.env.SHOPIFY_STORE,
    store: process.env.SHOPIFY_STORE,
    accessToken: process.env.SHOPIFY_ACCESS_TOKEN,
    feishuWebhookUrl: process.env.FEISHU_WEBHOOK_URL,
    apiVersion: process.env.SHOPIFY_API_VERSION,
    timezone: process.env.SHOPIFY_TIMEZONE,
  }, 0)];
}

function normalizeStore(config, index) {
  const store = String(config.store || config.shopDomain || "")
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
  const name = String(config.name || store || `store-${index + 1}`);
  const accessToken = config.accessToken || config.adminApiToken;
  const clientId = config.clientId || config.apiKey;
  const clientSecret = config.clientSecret || config.apiSecret;
  const feishuWebhookUrl = config.feishuWebhookUrl;
  if (!store || (!accessToken && (!clientId || !clientSecret)) || !feishuWebhookUrl) {
    throw new Error(`Store config ${index + 1} requires store, clientId/clientSecret (or accessToken), and feishuWebhookUrl`);
  }
  return {
    name,
    store,
    accessToken,
    clientId,
    clientSecret,
    feishuWebhookUrl,
    apiVersion: config.apiVersion || process.env.SHOPIFY_API_VERSION || "2026-07",
    timezone: config.timezone || process.env.SHOPIFY_TIMEZONE || "America/Los_Angeles",
  };
}

const query = `#graphql
query Orders($first: Int!, $after: String, $search: String!) {
  orders(first: $first, after: $after, query: $search, sortKey: UPDATED_AT, reverse: false) {
    pageInfo { hasNextPage endCursor }
    edges { node {
      id name createdAt processedAt updatedAt cancelledAt test
      displayFinancialStatus displayFulfillmentStatus currencyCode
      currentTotalPriceSet { shopMoney { amount currencyCode } }
      totalPriceSet { shopMoney { amount currencyCode } }
      totalRefundedSet { shopMoney { amount currencyCode } }
      lineItems(first: 250) { edges { node {
        id title sku quantity
        product { id title }
        variant { id title }
      } } }
      fulfillments(first: 100) {
        id status createdAt updatedAt deliveredAt inTransitAt
        trackingInfo { company number url }
      }
    } }
  }
}`;

function dateParts(date, timezone) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric", month: "2-digit", day: "2-digit"
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((p) => p.type !== "literal").map((p) => [p.type, p.value]));
}

function dateKey(date, timezone) {
  const p = dateParts(date, timezone);
  return `${p.year}-${p.month}-${p.day}`;
}

function addDays(key, amount) {
  const [y, m, d] = key.split("-").map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + amount));
  return date.toISOString().slice(0, 10);
}

function periodFor(type, timezone, now = new Date()) {
  const today = dateKey(now, timezone);
  if (type === "daily") return { label: "日报", start: addDays(today, -1), end: today };
  if (type === "weekly") {
    const weekday = new Date(`${today}T00:00:00Z`).getUTCDay();
    const thisMonday = addDays(today, -(weekday === 0 ? 6 : weekday - 1));
    return { label: "周报", start: addDays(thisMonday, -7), end: thisMonday };
  }
  if (type === "monthly") {
    const first = `${today.slice(0, 7)}-01`;
    const previousFirst = addDays(first, -1).slice(0, 7) + "-01";
    return { label: "月报", start: previousFirst, end: first };
  }
  throw new Error(`REPORT_TYPE must be daily, weekly, or monthly; got ${type}`);
}

function previousPeriod(period) {
  const length = Math.round((Date.parse(`${period.end}T00:00:00Z`) - Date.parse(`${period.start}T00:00:00Z`)) / 86400000);
  return { label: period.label, start: addDays(period.start, -length), end: period.start };
}

function money(set) {
  return Number(set?.shopMoney?.amount || 0);
}

function lineItems(order) {
  return (order.lineItems?.edges || []).map((edge) => edge.node);
}

function searchFor(start, end) {
  // The end is exclusive. Add a three-day overlap so late refunds/fulfillments are refreshed.
  const syncStart = addDays(start, -3);
  const syncEnd = addDays(end, 1);
  return `updated_at:>=${syncStart} updated_at:<${syncEnd}`;
}

async function getAccessToken(storeConfig) {
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

async function shopify(storeConfig, queryText, variables) {
  const accessToken = await getAccessToken(storeConfig);
  const response = await fetch(`https://${storeConfig.store}/admin/api/${storeConfig.apiVersion}/graphql.json`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-shopify-access-token": accessToken },
    body: JSON.stringify({ query: queryText, variables })
  });
  const body = await response.json();
  if (!response.ok || body.errors?.length) throw new Error(`Shopify API error: ${JSON.stringify(body.errors || body)}`);
  return body.data;
}

async function fetchOrders(storeConfig, start, end) {
  const result = [];
  let after = null;
  do {
    const data = await shopify(storeConfig, query, { first: 250, after, search: searchFor(start, end) });
    result.push(...data.orders.edges.map((edge) => edge.node));
    after = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
  } while (after);
  return result;
}

function inRange(date, start, end, timezone) {
  const key = dateKey(new Date(date), timezone);
  return key >= start && key < end;
}

function aggregate(orders, start, end, timezone) {
  const included = orders.filter((o) => o.createdAt && inRange(o.createdAt, start, end, timezone) && !o.cancelledAt && !o.test);
  const currency = included.find((o) => o.currencyCode)?.currencyCode || "USD";
  const fulfilled = included.filter((o) => o.displayFulfillmentStatus === "FULFILLED").length;
  const partiallyFulfilled = included.filter((o) => o.displayFulfillmentStatus === "PARTIALLY_FULFILLED").length;
  const unfulfilled = included.filter((o) => ["UNFULFILLED", "ON_HOLD"].includes(o.displayFulfillmentStatus)).length;
  const units = included.reduce((sum, o) => sum + lineItems(o).reduce((n, item) => n + Number(item.quantity || 0), 0), 0);
  const sales = included.reduce((sum, o) => sum + money(o.currentTotalPriceSet || o.totalPriceSet), 0);
  const refunds = included.reduce((sum, o) => sum + money(o.totalRefundedSet), 0);
  return { orderCount: included.length, units, sales, refunds, netSales: sales - refunds, fulfilled, partiallyFulfilled, unfulfilled, currency };
}

function fmtMoney(value, currency) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value);
}

function pct(current, previous) {
  if (previous === 0) return current === 0 ? "0%" : "+100%";
  const value = ((current - previous) / previous) * 100;
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function buildMessage(storeConfig, period, current, previous) {
  const title = `📊 Shopify ${storeConfig.name}｜${period.label}｜${period.start} 至 ${addDays(period.end, -1)}`;
  return [
    title,
    "",
    `订单数：${current.orderCount}（${pct(current.orderCount, previous.orderCount)}）`,
    `商品销量：${current.units}（${pct(current.units, previous.units)}）`,
    `销售额：${fmtMoney(current.sales, current.currency)}（${pct(current.sales, previous.sales)}）`,
    `退款金额：${fmtMoney(current.refunds, current.currency)}`,
    `净销售额：${fmtMoney(current.netSales, current.currency)}`,
    "",
    `已发货订单：${current.fulfilled}`,
    `部分发货订单：${current.partiallyFulfilled}`,
    `待发货订单：${current.unfulfilled}`,
    "",
    "请查看 Shopify 看板或后台详情。"
  ].join("\n");
}

async function sendFeishu(storeConfig, text) {
  const response = await fetch(storeConfig.feishuWebhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ msg_type: "text", content: { text } })
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok || body.code) throw new Error(`Feishu webhook error: ${JSON.stringify(body)}`);
}

const stores = readStores();
const failures = [];

for (const storeConfig of stores) {
  try {
    const period = periodFor(reportType, storeConfig.timezone);
    const previous = previousPeriod(period);
    const orders = await fetchOrders(storeConfig, previous.start, period.end);
    const currentMetrics = aggregate(orders, period.start, period.end, storeConfig.timezone);
    const previousMetrics = aggregate(orders, previous.start, period.start, storeConfig.timezone);
    const message = buildMessage(storeConfig, period, currentMetrics, previousMetrics);
    await sendFeishu(storeConfig, message);
    console.log(JSON.stringify({ store: storeConfig.store, reportType, period, orderCount: currentMetrics.orderCount }, null, 2));
  } catch (error) {
    failures.push(`${storeConfig.name} (${storeConfig.store}): ${error.message}`);
    console.error(`Report failed for ${storeConfig.store}:`, error);
  }
}

if (failures.length > 0) {
  throw new Error(`One or more store reports failed:\n${failures.join("\n")}`);
}
