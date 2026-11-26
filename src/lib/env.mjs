// 共享配置解析：与 v1 (src/report.mjs) 的环境变量契约保持一致，
// 因此同一份 SHOPIFY_STORES_JSON 可以同时驱动 v1 与 v2。

const marketFilter = String(process.env.MARKET_FILTER || "").trim().toUpperCase();

function normalizeStore(config, index) {
  const store = String(config.store || config.shopDomain || "")
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");
  const name = String(config.name || store || `store-${index + 1}`);
  const market = String(config.market || config.region || process.env.SHOPIFY_MARKET || "US").trim().toUpperCase() || "US";
  const accessToken = config.accessToken || config.adminApiToken;
  const clientId = config.clientId || config.apiKey;
  const clientSecret = config.clientSecret || config.apiSecret;
  const feishuWebhookUrl = config.feishuWebhookUrl;
  if (!store || (!accessToken && (!clientId || !clientSecret)) || !feishuWebhookUrl) {
    throw new Error(`Store config ${index + 1} requires store, clientId/clientSecret (or accessToken), and feishuWebhookUrl`);
  }
  const timezone = config.timezone || process.env.SHOPIFY_TIMEZONE || "America/Los_Angeles";
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  } catch (error) {
    throw new Error(`Store config ${index + 1} has invalid IANA timezone "${timezone}": ${error.message}`);
  }
  return {
    name,
    market,
    store,
    accessToken,
    clientId,
    clientSecret,
    feishuWebhookUrl,
    apiVersion: config.apiVersion || process.env.SHOPIFY_API_VERSION || "2026-07",
    timezone,
  };
}

export function readStores() {
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
    const normalized = stores.map((config, index) => normalizeStore(config, index));
    const filtered = marketFilter ? normalized.filter((store) => store.market === marketFilter) : normalized;
    if (filtered.length === 0) throw new Error(`No stores matched MARKET_FILTER="${marketFilter}"`);
    return filtered;
  }

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
    market: process.env.SHOPIFY_MARKET,
  }, 0)];
}

export function flag(name, fallback = false) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
}
