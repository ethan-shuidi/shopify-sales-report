// 用假的 fetch 验证限流重试逻辑，不访问真实 API。
const store = { store: "test.myshopify.com", apiVersion: "2026-07", accessToken: "fake" };
const { graphql, retryStats, resetRetryStats } = await import("/Users/shuidi/workspace/shopify-sales-report/src/lib/shopify.mjs");

const json = (obj, init = {}) => new Response(JSON.stringify(obj), { status: 200, headers: { "content-type": "application/json" }, ...init });

async function scenario(name, responses, expectCalls, expectThrow) {
  resetRetryStats();
  let calls = 0;
  const waits = [];
  globalThis.fetch = async () => {
    calls += 1;
    return responses[Math.min(calls - 1, responses.length - 1)]();
  };
  const realSetTimeout = setTimeout;
  globalThis.setTimeout = (fn, ms) => { waits.push(ms); return realSetTimeout(fn, 0); };
  let error = null;
  try { await graphql(store, "{ shop { name } }"); } catch (e) { error = e; }
  globalThis.setTimeout = realSetTimeout;
  const ok = calls === expectCalls && (expectThrow ? Boolean(error) : !error);
  if (!ok) process.exitCode = 1;
  console.log(`${ok ? "PASS" : "FAIL"} ${name}: calls=${calls} retries=${retryStats.count} waits=${waits.join(",")}${error ? " err=" + error.message.slice(0, 60) : ""}`);
}

const throttled = () => json({ errors: [{ message: "Throttled", extensions: { code: "THROTTLED" } }],
  extensions: { cost: { requestedQueryCost: 100, throttleStatus: { currentlyAvailable: 10, restoreRate: 50 } } } });
const success = () => json({ data: { shop: { name: "x" } } });

await scenario("THROTTLED 后成功", [throttled, success], 2, false);
await scenario("THROTTLED 连续 4 次则放弃", [throttled], 4, true);
await scenario("429 + Retry-After", [() => json({}, { status: 429, headers: { "retry-after": "2" } }), success], 2, false);
await scenario("普通错误不重试", [() => json({ errors: [{ message: "Field not found" }] })], 1, true);

if (process.exitCode) console.error("限流重试测试未通过");

