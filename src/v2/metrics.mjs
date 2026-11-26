// v2 指标口径（与 v1 不同，按文档 §6 定义，互不影响）：
//   销售额   = 有效订单的订单总额 totalPriceSet（before returns，未扣退款）
//   PCS      = 有效订单行项目 quantity 之和（不做台数换算）
//   订单数   = 有效订单数（排除已取消、测试订单）
//   客单价   = 净销售额 ÷ 订单数
//   退款率   = 退款金额 ÷ 销售额
//   净销售额 = 销售额 - 退款金额

import { dateKey } from "../lib/time.mjs";

function money(set) {
  return Number(set?.shopMoney?.amount || 0);
}

export function isCountableOrder(order, start, end, timezone) {
  if (!order.createdAt || order.cancelledAt || order.test) return false;
  const key = dateKey(new Date(order.createdAt), timezone);
  return key >= start && key < end;
}

export function orderMetrics(orders, start, end, timezone) {
  const included = orders.filter((order) => isCountableOrder(order, start, end, timezone));
  const sales = included.reduce((sum, order) => sum + money(order.totalPriceSet), 0);
  const refunds = included.reduce((sum, order) => sum + money(order.totalRefundedSet), 0);
  const pcs = included.reduce((sum, order) => (
    sum + (order.lineItems?.edges || []).reduce((lineSum, edge) => lineSum + Number(edge.node.quantity || 0), 0)
  ), 0);
  const orderCount = included.length;
  const netSales = sales - refunds;
  return {
    orderCount,
    sales,
    refunds,
    netSales,
    pcs,
    aov: orderCount > 0 ? netSales / orderCount : 0,
    refundRate: sales > 0 ? refunds / sales : 0,
  };
}

// 订单级归因：整单销售额记到 last-click 渠道；没有 UTM 时用 sourceType
// （DIRECT / SEO / SOCIAL / REFERRAL / UNKNOWN）兜底，避免全部压进"未归因"。
export function attributionRows(orders, start, end, timezone, internalHosts = []) {
  const map = new Map();
  let pending = 0;
  for (const order of orders) {
    if (!isCountableOrder(order, start, end, timezone)) continue;
    const journey = order.customerJourneySummary;
    // ready=false 表示 Shopify 还在处理该订单的归因，先算作未归因并单独计数。
    if (journey && journey.ready === false) pending += 1;

    // Shopify 的 lastVisit 经常只有 source=direct 而没有 utmParameters，
    // 真正的来源信息留在 firstVisit 里。所以按 last → first 找第一个带 UTM 的触点，
    // 都找不到时才退回 lastVisit 自身的 source / referrer 做判断。
    const visits = [journey?.lastVisit, journey?.firstVisit].filter(Boolean);
    const visitWithUtm = visits.find((v) => {
      const u = v.utmParameters;
      return u && (u.source || u.medium || u.campaign);
    });
    const visit = visitWithUtm || visits[0] || null;
    const utm = visit?.utmParameters || null;
    const source = utm?.source || "";
    const medium = utm?.medium || "";
    const sourceType = visit?.sourceType || "";
    const campaign = utm?.campaign || "";
    // source 有时是 URL，referrerUrl 更稳；两者取其一即可。
    const referrerUrl = visit?.referrerUrl || (String(visit?.source || "").includes("://") ? visit.source : "");
    // 没有 UTM 时用 referring channel（sourceType）作为兜底键。
    const key = source || medium
      ? `utm:${String(source).toLowerCase()}\u0000${String(medium).toLowerCase()}`
      : `ref:${String(referrerUrl).toLowerCase() || String(sourceType).toLowerCase()}`;
    const row = map.get(key) || { source, medium, sourceType, campaign, referrerUrl, visitSource: visit?.source || "", internalHosts, orders: 0, sales: 0 };
    row.orders += 1;
    row.sales += money(order.totalPriceSet);
    map.set(key, row);
  }
  return { rows: [...map.values()], pending };
}
