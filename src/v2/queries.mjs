// v2 数据源：订单（含归因）+ ShopifyQL sessions。
// 只查询 v2 卡片需要的字段，比 v1 的订单查询更轻。

export const SHOP_INFO_QUERY = `#graphql
query ShopInfo {
  shop { ianaTimezone currencyCode myshopifyDomain primaryDomain { host } plan { displayName } }
  currentAppInstallation { accessScopes { handle } }
}`;

const ORDERS_QUERY = `#graphql
query Orders($first: Int!, $after: String, $search: String!) {
  orders(first: $first, after: $after, query: $search, sortKey: CREATED_AT, reverse: false) {
    pageInfo { hasNextPage endCursor }
    edges { node {
      id name createdAt cancelledAt test
      displayFinancialStatus
      totalPriceSet { shopMoney { amount currencyCode } }
      currentTotalPriceSet { shopMoney { amount currencyCode } }
      totalRefundedSet { shopMoney { amount currencyCode } }
      lineItems(first: 250) { edges { node { quantity } } }
      customerJourneySummary {
        ready
        firstVisit { sourceType referrerUrl utmParameters { source medium campaign } }
        lastVisit { sourceType referrerUrl utmParameters { source medium campaign } }
      }
    } }
  }
}`;

export function searchFor(start, end) {
  return `created_at:>=${start} created_at:<${end}`;
}

export async function fetchOrders(shopify, storeConfig, start, end) {
  const result = [];
  let after = null;
  do {
    const data = await shopify(storeConfig, ORDERS_QUERY, { first: 250, after, search: searchFor(start, end) });
    result.push(...data.orders.edges.map((edge) => edge.node));
    after = data.orders.pageInfo.hasNextPage ? data.orders.pageInfo.endCursor : null;
  } while (after);
  return result;
}

// 日粒度 sessions 与转化率。UNTIL 为闭区间，所以 end 传当天即可。
export async function fetchSessionTrend(shopifyql, storeConfig, start, end) {
  const q = `FROM sessions SHOW sessions, conversion_rate WHERE human_or_bot_session = 'human' SINCE ${start} UNTIL ${end} TIMESERIES day ORDER BY day ASC`;
  const rows = await shopifyql(storeConfig, q);
  return rows.map((row) => ({
    date: String(row.day || "").slice(0, 10),
    sessions: Number(row.sessions || 0),
    conversionRate: Number(row.conversion_rate || 0),
  }));
}

// 按 UTM + Shopify marketing channel 拆分的 sessions，用于渠道效率表。
// marketing_platform 是 Shopify 自己的渠道归类（meta / google / direct / klaviyo …），
// 用来覆盖"没有 UTM 但有 marketing channel"的那部分流量。
export async function fetchSessionChannels(shopifyql, storeConfig, day) {
  const q = `FROM sessions SHOW sessions GROUP BY utm_source, utm_medium, marketing_platform, utm_campaign SINCE ${day} UNTIL ${day} ORDER BY sessions DESC LIMIT 500`;
  const rows = await shopifyql(storeConfig, q);
  return rows.map((row) => ({
    source: row.utm_source ? String(row.utm_source) : "",
    medium: row.utm_medium ? String(row.utm_medium) : "",
    platform: row.marketing_platform ? String(row.marketing_platform) : "",
    campaign: row.utm_campaign ? String(row.utm_campaign) : "",
    sessions: Number(row.sessions || 0),
  }));
}
