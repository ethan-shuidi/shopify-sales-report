// v2 销售日播报：Shopify 订单 + ShopifyQL sessions + 渠道归因。
// 与 v1（src/report.mjs）完全独立，环境变量契约一致，可共存。
//
// 环境变量：
//   REPORT_DAY=today|yesterday  报表主视角的"今天"（默认 today，按文档口径）
//   V2_TOP_CHANNELS=5           渠道效率主表条数
//   V2_COLLAPSIBLE=true         其他流量结构是否用折叠面板（被飞书拒绝时自动降级）
//   DRY_RUN=true                只打印卡片 JSON，不发送
//   WRITE_SNAPSHOT=true         落盘每日快照（文档 §8）
//   SNAPSHOT_DIR=snapshots      快照目录

import { readStores, flag } from "../lib/env.mjs";
import { sendCard } from "../lib/feishu.mjs";
import { buildStoreModel, saveSnapshot, reportDay } from "./pipeline.mjs";
import { buildCards, percent } from "./card.mjs";

const useCollapsible = flag("V2_COLLAPSIBLE", true);
const dryRun = flag("DRY_RUN", false);
const writeSnapshot = flag("WRITE_SNAPSHOT", false);

const stores = readStores();
const failures = [];

for (const storeConfig of stores) {
  try {
    const model = await buildStoreModel(storeConfig);
    const cards = buildCards(model, { collapsible: useCollapsible });

    if (writeSnapshot) {
      const file = await saveSnapshot(model);
      console.log(`[v2] snapshot written: ${file}`);
    }

    if (dryRun) {
      console.log(JSON.stringify({ store: model.store, market: model.market, card: cards[0] }, null, 2));
    } else {
      const result = await sendCard(storeConfig.feishuWebhookUrl, cards);
      console.log(JSON.stringify({
        store: model.store,
        market: model.market,
        day: model.day,
        orders: model.today.orderCount,
        sessions: model.today.sessions,
        conversionRate: model.today.conversionRate === null ? null : percent(model.today.conversionRate),
        channelGroups: model.channels.groups.map((row) => `${row.name}:${row.orders}单`),
        degradedCard: result.degraded,
        steps: model.status.steps,
      }, null, 2));
    }
  } catch (error) {
    failures.push(`${storeConfig.name} (${storeConfig.store}): ${error.message}`);
    console.error(`[v2] report failed for ${storeConfig.store}:`, error);
  }
}

if (failures.length > 0) {
  throw new Error(`One or more v2 store reports failed:\n${failures.join("\n")}`);
}
