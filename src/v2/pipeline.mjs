// v2 数据装配：把一个店铺的 Shopify 数据组装成卡片模型。
// 与 CLI 入口（report.mjs）分离，方便单独调试或复用。

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { graphql, shopifyql, resetRetryStats, retryStats } from "../lib/shopify.mjs";
import { addDays, dateKey, formatClock, formatDateTime, startOfMonthKey, todayKey } from "../lib/time.mjs";
import { fetchSessionChannels, fetchSessionTrend, fetchOrders, SHOP_INFO_QUERY } from "./queries.mjs";
import { attributionRows, orderMetrics } from "./metrics.mjs";
import { mergeChannels } from "./channels.mjs";
import { fetchEfficiency } from "./feishu-base.mjs";

export const reportDay = (process.env.REPORT_DAY || "today").toLowerCase();
const snapshotDir = process.env.SNAPSHOT_DIR || "snapshots";

if (!["today", "yesterday"].includes(reportDay)) {
  throw new Error(`REPORT_DAY must be today or yesterday; got ${reportDay}`);
}

function emptyMetrics() {
  return { orderCount: 0, sales: 0, refunds: 0, netSales: 0, pcs: 0, aov: 0, refundRate: 0 };
}

export async function buildStoreModel(storeConfig) {
  resetRetryStats();
  const steps = [];
  const sources = [];

  // 用店铺真实时区切日：ShopifyQL 的 day 边界就是店铺时区，
  // 若配置时区与店铺不一致，两边会错开，所以 v2 统一以店铺时区为准。
  const info = await graphql(storeConfig, SHOP_INFO_QUERY);
  const timezone = info.shop.ianaTimezone || storeConfig.timezone;
  const internalHosts = [storeConfig.store, info.shop.primaryDomain?.host].filter(Boolean);
  const currency = info.shop.currencyCode || "USD";
  if (timezone !== storeConfig.timezone) {
    console.warn(`[v2] ${storeConfig.market}: 配置时区 ${storeConfig.timezone} 与店铺时区 ${timezone} 不一致，v2 使用店铺时区。`);
  }

  const today = todayKey(timezone);
  const day = reportDay === "today" ? today : addDays(today, -1);
  const previousDay = addDays(day, -1);
  const monthStart = startOfMonthKey(day);
  const fetchStart = monthStart < addDays(day, -7) ? monthStart : addDays(day, -7);

  // 一次取回 [月初, day+1) 的订单，供今日/昨日/近 7 日/本月四个口径复用。
  const orders = await fetchOrders(graphql, storeConfig, fetchStart, addDays(day, 1));
  sources.push("Shopify Admin GraphQL");
  steps.push(`订单 ✓ 共 ${orders.length} 笔原始记录`);

  const todayMetrics = orderMetrics(orders, day, addDays(day, 1), timezone);
  const yesterdayMetrics = orderMetrics(orders, previousDay, day, timezone);
  const monthMetrics = orderMetrics(orders, monthStart, addDays(day, 1), timezone);
  const last7Orders = orders.filter((order) => {
    if (!order.createdAt || order.cancelledAt || order.test) return false;
    const key = dateKey(new Date(order.createdAt), timezone);
    return key >= addDays(day, -7) && key < day;
  });
  const last7Sales = last7Orders.reduce((sum, order) => sum + Number(order.totalPriceSet?.shopMoney?.amount || 0), 0);

  // 近 7 日逐日销售额，供趋势柱状图使用（与卡片上的销售额同一口径）。
  const salesTrend = [];
  for (let offset = 6; offset >= 0; offset -= 1) {
    const key = addDays(day, -offset);
    salesTrend.push({ date: key, sales: 0 });
  }
  const salesTrendIndex = new Map(salesTrend.map((row) => [row.date, row]));
  for (const order of orders) {
    if (!order.createdAt || order.cancelledAt || order.test) continue;
    const row = salesTrendIndex.get(dateKey(new Date(order.createdAt), timezone));
    if (row) row.sales += Number(order.totalPriceSet?.shopMoney?.amount || 0);
  }

  // sessions：整体 sessions / 转化率，按日取近 7 日
  let trend = [];
  let sessionsOk = true;
  try {
    trend = await fetchSessionTrend(shopifyql, storeConfig, addDays(day, -6), day);
    sources.push("ShopifyQL sessions");
    steps.push("Sessions ✓");
  } catch (error) {
    sessionsOk = false;
    steps.push(`Sessions ✗ ${error.message}`);
    console.warn(`[v2] ${storeConfig.market}: sessions 获取失败，降级展示。`, error.message);
  }

  const trendRow = (key) => trend.find((row) => row.date === key);
  const todaySessions = trendRow(day)?.sessions ?? 0;
  const yesterdaySessions = trendRow(previousDay)?.sessions ?? 0;
  // 文档 §6：优先用 Shopify 返回的 conversion rate，没有返回时用 订单数 ÷ Sessions 兜底。
  const shopifyCvr = (key) => {
    const value = trendRow(key)?.conversionRate;
    return typeof value === "number" ? value : null;
  };
  let todayCvr = shopifyCvr(day);
  let yesterdayCvr = shopifyCvr(previousDay);
  let cvrSource = "shopify";
  if (todayCvr === null && todaySessions > 0) {
    todayCvr = todayMetrics.orderCount / todaySessions;
    cvrSource = "computed";
  }
  if (yesterdayCvr === null && yesterdaySessions > 0) {
    yesterdayCvr = yesterdayMetrics.orderCount / yesterdaySessions;
  }

  // 渠道拆分：今日 / 昨日各一次，用于付费进站与较昨日对比
  let channelRows = [];
  let yesterdayChannelRows = [];
  if (sessionsOk) {
    try {
      channelRows = await fetchSessionChannels(shopifyql, storeConfig, day);
      yesterdayChannelRows = await fetchSessionChannels(shopifyql, storeConfig, previousDay);
    } catch (error) {
      steps.push(`渠道拆分 ✗ ${error.message}`);
    }
  }

  let attribution = [];
  let pendingAttribution = 0;
  let attributionOk = true;
  try {
    const result = attributionRows(orders, day, addDays(day, 1), timezone, internalHosts);
    attribution = result.rows;
    pendingAttribution = result.pending;
    steps.push("归因 ✓");
  } catch (error) {
    attributionOk = false;
    steps.push(`归因 ✗ ${error.message}`);
  }

  const channels = mergeChannels({ sessionRows: channelRows, orderRows: attribution });
  const yesterdayChannels = mergeChannels({ sessionRows: yesterdayChannelRows, orderRows: [] });

  // 经营效率（净MER / ROI）来自飞书多维表格，读不到不影响主报表
  let efficiency = null;
  try {
    efficiency = await fetchEfficiency(storeConfig.market);
    steps.push(efficiency
      ? `底表 ✓ ${efficiency.label} ${efficiency.value.toFixed(2)}（${efficiency.date}）`
      : "底表 ✗ 无可用数据");
  } catch (error) {
    steps.push(`底表 ✗ ${error.message}`);
    console.warn(`[v2] ${storeConfig.market}: 底表读取失败，跳过经营效率：${error.message}`);
  }

  const model = {
    market: storeConfig.market,
    store: storeConfig.store,
    currency,
    timezone,
    day,
    dateLabel: day,
    dayWord: reportDay === "today" ? "今日" : "昨日",
    asOf: formatClock(new Date(), timezone),
    today: {
      ...todayMetrics,
      sales: todayMetrics.sales || 0,
      sessions: todaySessions,
      conversionRate: todayCvr,
      paidSessions: channels.paidSessions,
    },
    yesterday: {
      ...(yesterdayMetrics || emptyMetrics()),
      sessions: yesterdaySessions,
      conversionRate: yesterdayCvr ?? 0,
      paidSessions: yesterdayChannels.paidSessions,
    },
    trend,
    last7Sales,
    salesTrend,
    channels,
    efficiency,
    month: monthMetrics,
    status: {
      updatedAt: `${formatDateTime(new Date(), timezone)}（${timezone}）`,
      sources,
      steps,
    },
    flags: { sessionsOk, attributionOk, cvrSource, pendingAttribution, throttleRetries: retryStats.count },
  };

  return model;
}

export async function saveSnapshot(model) {
  const dir = path.join(snapshotDir, model.day);
  await mkdir(dir, { recursive: true });
  const snapshot = {
    date: model.day,
    shop_id: model.store,
    market: model.market,
    sales: model.today.sales,
    net_sales: model.today.netSales,
    pcs: model.today.pcs,
    orders: model.today.orderCount,
    aov: model.today.aov,
    refund_amount: model.today.refunds,
    refund_rate: model.today.refundRate,
    sessions: model.today.sessions,
    conversion_rate: model.today.conversionRate,
    channel_groups: model.channels.groups.map((row) => ({
      group: row.name, sessions: row.sessions, orders: row.orders, sales: row.sales,
    })),
    channel_details: model.channels.details.map((row) => ({
      channel: row.name, group: row.groupName, sessions: row.sessions, orders: row.orders, sales: row.sales,
    })),
    pending_share: {
      sessions: model.channels.totals.sessions > 0 ? model.channels.pendingSessions / model.channels.totals.sessions : 0,
      sales: model.channels.totals.sales > 0 ? model.channels.pendingSales / model.channels.totals.sales : 0,
    },
    attribution_model: "last_click",
    updated_at: new Date().toISOString(),
  };
  const file = path.join(dir, `${model.market}.json`);
  await writeFile(file, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  return file;
}

