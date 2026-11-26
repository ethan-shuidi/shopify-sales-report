// v2 飞书卡片：按文档 §2 的五个区块，尽量还原设计稿的视觉层次。
//
// 飞书卡片引擎的边界（已实测）：
//   ✅ markdown 的 text_size / 字色 / 粗体      → 大数字、涨跌染色
//   ✅ column 的 background_style + padding    → 灰色底板卡片
//   ✅ chart 组件（VChart spec 对象）          → 近 7 日柱状图，可嵌在 column 里
//   ✅ table 的 markdown 单元格               → 渠道名下的字符进度条
//   ❌ 卡片级背景/圆角/阴影、表格内原生进度条  → 只能用字符与底色近似

const COLOR_UP = "green";
const COLOR_DOWN = "red";
const COLOR_MUTED = "grey";

function md(content, extra = {}) {
  return { tag: "markdown", content, ...extra };
}

function table(columns, rows) {
  return {
    tag: "table",
    columns: columns.map((column) => ({ ...column, horizontal_align: column.horizontal_align || "center", vertical_align: "center" })),
    rows,
    page_size: Math.min(10, Math.max(1, rows.length)),
    row_height: "auto",
    header_style: {
      text_align: "center",
      text_size: "normal",
      background_style: "grey",
      bold: true,
      lines: 1,
    },
  };
}

function panel({ weight = 1, padding = "12px", elements }) {
  return { tag: "column", width: "weighted", weight, background_style: "grey", padding, elements };
}

export function fmtMoney(value, currency) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency, maximumFractionDigits: 2 }).format(value);
}

export function pct(current, previous) {
  if (previous === 0) return current === 0 ? "0%" : "新增";
  return `${(((current - previous) / previous) * 100).toFixed(1)}%`;
}

export function percent(value, digits = 2) {
  return value === null || value === undefined ? "—" : `${(value * 100).toFixed(digits)}%`;
}

function signedPoints(current, previous) {
  const delta = (current - previous) * 100;
  return `${delta >= 0 ? "+" : ""}${delta.toFixed(2)}pp`;
}

// 涨跌文本：默认上涨为好（绿色），inverse=true 时上涨为坏（红色）。
function deltaText(current, previous, { inverse = false, label = "较昨日", suffix = "" } = {}) {
  if (previous === undefined || previous === null) return `<font color='${COLOR_MUTED}'>无对比</font>`;
  const diff = current - previous;
  if (!Number.isFinite(diff) || diff === 0) return `<font color='${COLOR_MUTED}'>持平</font> ${label}`;
  const up = diff > 0;
  const good = inverse ? !up : up;
  const arrow = up ? "↑" : "↓";
  // 箭头已经表达方向，数值用绝对值，避免出现 "↓ -6.8%" 这样的双重符号。
  const value = previous === 0 ? "新增" : `${(Math.abs((current - previous) / previous) * 100).toFixed(1)}%`;
  return `<font color='${good ? COLOR_UP : COLOR_DOWN}'>${arrow} ${value}${suffix}</font> ${label}`;
}

function bigKpi(label, value, delta) {
  return panel({
    weight: 1,
    elements: [
      md(`<font color='${COLOR_MUTED}'>${label}</font>`),
      md(`**${value}**`, { text_size: "heading" }),
      md(delta),
    ],
  });
}

function smallKpi(label, value, note) {
  return panel({
    weight: 1,
    padding: "10px",
    elements: [
      md(`<font color='${COLOR_MUTED}'>${label}</font>`),
      md(`**${value}**`),
      md(note),
    ],
  });
}

function bar(value, max, slots = 12) {
  const filled = max > 0 ? Math.max(1, Math.round((value / max) * slots)) : 0;
  return `<font color='blue'>${"█".repeat(filled)}</font><font color='${COLOR_MUTED}'>${"░".repeat(Math.max(0, slots - filled))}</font>`;
}

function moneyChart(salesTrend) {
  return {
    tag: "chart",
    color_theme: "brand",
    height: "170px",
    chart_spec: {
      type: "bar",
      data: [{
        id: "sales",
        values: salesTrend.map((row) => ({ x: row.date.slice(5).replace("-", "/"), y: Math.round(row.sales) })),
      }],
      xField: "x",
      yField: "y",
      axes: [{ orient: "bottom", type: "band" }, { orient: "left", type: "linear" }],
    },
  };
}

// markdown 表格：折叠面板里不能放 table 组件，只能用 markdown 语法画表。
function markdownTable(headers, rows) {
  const cell = (value) => String(value).replace(/\|/g, "\\|");
  const lines = [
    `| ${headers.map(cell).join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((row) => `| ${row.map(cell).join(" | ")} |`),
  ];
  return lines.join("\n");
}

function detailTable(rows, currency) {
  return table([
    { name: "channel", display_name: "子渠道", data_type: "text", width: "auto", horizontal_align: "left" },
    { name: "group", display_name: "分组", data_type: "text", width: "100px" },
    { name: "sessions", display_name: "进站", data_type: "number", width: "80px" },
    { name: "orders", display_name: "订单", data_type: "number", width: "80px" },
    { name: "sales", display_name: "销售额", data_type: "text", width: "110px" },
  ], rows.map((row) => ({
    channel: row.name,
    group: row.groupName,
    sessions: row.sessions,
    orders: row.orders,
    sales: fmtMoney(row.sales, currency),
  })));
}

function channelTable(rows, currency, { withCvr = true } = {}) {
  const maxSessions = Math.max(...rows.map((row) => row.sessions), 0);
  const columns = [
    { name: "channel", display_name: "渠道", data_type: "markdown", width: "200px", horizontal_align: "left" },
    { name: "sessions", display_name: "进站", data_type: "number", width: "80px" },
    { name: "orders", display_name: "订单", data_type: "number", width: "80px" },
  ];
  if (withCvr) columns.push({ name: "cvr", display_name: "CVR", data_type: "text", width: "80px" });
  columns.push({ name: "sales", display_name: "销售额", data_type: "text", width: "110px" });

  return table(columns, rows.map((row) => {
    const result = {
      channel: `**${row.name}**\n${bar(row.sessions, maxSessions)}`,
      sessions: row.sessions,
      orders: row.orders,
      sales: fmtMoney(row.sales, currency),
    };
    if (withCvr) result.cvr = row.cvr === null ? "—" : percent(row.cvr);
    return result;
  }));
}

function buildElements(model, { collapsible }) {
  const { today, yesterday, trend, salesTrend, last7Sales, channels, month, status, currency } = model;
  const dayWord = model.dayWord || "今日";
  const prevWord = dayWord === "今日" ? "昨日" : "前日";
  const elements = [];

  elements.push(md(
    `<font color='${COLOR_MUTED}'>Comu ${model.market}｜${model.dateLabel} · 数据更新时间 ${model.asOf}`
    + `${dayWord === "今日" ? "（当日未结束）" : ""}</font>　<font color='blue'>日度视图</font>`,
  ));

  // 区块 1：两张主 KPI 卡
  elements.push({
    tag: "column_set",
    flex_mode: "none",
    horizontal_spacing: "large",
    columns: [
      bigKpi(`${dayWord}销售额`, fmtMoney(today.sales, currency), deltaText(today.sales, yesterday.sales, { label: `较${prevWord}` })),
      bigKpi(`${dayWord}销售 PCS`, today.pcs, deltaText(today.pcs, yesterday.pcs, { label: `较${prevWord}` })),
    ],
  });

  // 区块 1b：两张辅助 KPI 卡（与上方两张主卡对齐）
  elements.push({
    tag: "column_set",
    flex_mode: "none",
    horizontal_spacing: "large",
    columns: [
      smallKpi(`${dayWord}订单数`, today.orderCount, deltaText(today.orderCount, yesterday.orderCount, { label: `较${prevWord}` })),
      smallKpi(`${dayWord}客单价`, fmtMoney(today.aov, currency), deltaText(today.aov, yesterday.aov, { label: `较${prevWord}` })),
    ],
  });

  // 区块 2：转化率浮动 · 近 7 日趋势
  elements.push(md("**转化率浮动 · 近7日趋势**"));
  elements.push({
    tag: "column_set",
    flex_mode: "none",
    horizontal_spacing: "large",
    columns: [
      panel({
        weight: 3,
        elements: [
          md(`<font color='${COLOR_MUTED}'>整体站点转化率</font>`),
          md(`**${percent(today.conversionRate)}**`, { text_size: "heading" }),
          md(yesterday.conversionRate === null || today.conversionRate === null
            ? `<font color='${COLOR_MUTED}'>无对比</font>`
            : `<font color='${today.conversionRate >= yesterday.conversionRate ? COLOR_UP : COLOR_DOWN}'>${today.conversionRate >= yesterday.conversionRate ? "↑" : "↓"} ${Math.abs((today.conversionRate - yesterday.conversionRate) * 100).toFixed(2)} 个百分点</font> 较${prevWord}`),
          md(`${dayWord}进站流量 ${today.sessions}　订单 ${today.orderCount}`),
        ],
      }),
      panel({
        weight: 4,
        padding: "8px",
        elements: [
          md("**近7日销售额**"),
          moneyChart(salesTrend || []),
          md(`<font color='${COLOR_MUTED}'>单位：${currency}　7 日合计 ${fmtMoney(last7Sales, currency)}</font>`),
        ],
      }),
    ],
  });

  // 区块 3：渠道效率（文档五分组：广告 / 红人 / 联盟 / 其他已识别 / 待确认）
  elements.push(md("**渠道效率**　广告 / 红人 / 联盟 / 自然搜索 / 直接访问 / AI 搜索导流 / 其他渠道 / 待确定"));
  if (channels.groups.length > 0) {
    elements.push(channelTable(channels.groups, currency));
  } else {
    elements.push(md("本周期没有可归因的渠道数据。"));
  }

  const pendingSessionRate = channels.totals.sessions > 0 ? channels.pendingSessions / channels.totals.sessions : 0;
  const pendingSalesRate = channels.totals.sales > 0 ? channels.pendingSales / channels.totals.sales : 0;
  const highPending = Math.max(pendingSessionRate, pendingSalesRate) >= 0.3;
  const othersTitle = `渠道明细 · ${channels.details.length} 条`
    + (highPending ? `　⚠️ 待确定 进站 ${percent(pendingSessionRate, 0)} / 销售额 ${percent(pendingSalesRate, 0)}` : "");

  if (collapsible) {
    // 折叠面板内不能放 table 组件（飞书报 200621），改用 markdown 表格承载。
    const inner = channels.details.length > 0
      ? md(markdownTable(
        ["子渠道", "分组", "进站", "订单", "销售额"],
        channels.details.map((row) => [row.name, row.groupName, row.sessions, row.orders, fmtMoney(row.sales, currency)]),
      ))
      : md("没有明细。");
    elements.push({
      tag: "collapsible_panel",
      expanded: false,
      header: {
        title: { tag: "markdown", content: `**${othersTitle}**　<font color='blue'>▼ 点击展开</font>` },
        vertical_align: "center",
      },
      elements: [inner],
    });
  } else {
    const othersContent = channels.details.length > 0
      ? [detailTable(channels.details, currency)]
      : [md("没有明细。")];
    elements.push(md(`**${othersTitle}**`), ...othersContent);
  }

  // 区块 4：本月经营数据
  elements.push(md("**本月经营数据**"));
  elements.push({
    tag: "column_set",
    flex_mode: "none",
    horizontal_spacing: "large",
    columns: [
      smallKpi("订单数", month.orderCount, `<font color='${COLOR_MUTED}'>累计至 ${model.dateLabel}</font>`),
      smallKpi("产品销量", `${month.pcs} PCS`, `<font color='${COLOR_MUTED}'>累计至 ${model.dateLabel}</font>`),
      smallKpi("退款金额", fmtMoney(month.refunds, currency), `<font color='${COLOR_MUTED}'>退款率 ${percent(month.refundRate)}</font>`),
      smallKpi("净销售额", fmtMoney(month.netSales, currency), `<font color='${COLOR_MUTED}'>${model.dateLabel.slice(0, 7)} 累计</font>`),
    ],
  });

  // 区块 5：底部状态
  const notes = [];
  if (model.flags?.sessionsOk === false) notes.push("Sessions 数据暂不可用");
  if (model.flags?.attributionOk === false) notes.push("归因数据暂不可用");
  if (model.flags?.cvrSource === "computed") notes.push("转化率按 订单数÷Sessions 估算");
  if (model.flags?.pendingAttribution > 0) notes.push(`${model.flags.pendingAttribution} 笔订单归因数据尚未就绪`);
  if (model.flags?.throttleRetries > 0) notes.push(`限流重试 ${model.flags.throttleRetries} 次`);

  // 退款率不再作为 KPI 展示，只在超过 5% 阈值时以异常提示出现。
  const refundAlert = today.refundRate > 0.05
    ? `<font color='${COLOR_DOWN}'>异常检查：退款率 ${percent(today.refundRate)}，超出 5% 阈值，需关注</font>\n`
    : "";
  elements.push(md(
    refundAlert
    + `<font color='${COLOR_MUTED}'>`
    + (notes.length > 0 ? `${notes.join("；")}\n` : "")
    + `数据更新时间：${status.updatedAt}　来源：${status.sources.join(" / ")}\n`
    + `拉取状态：${status.steps.join("　")}</font>`,
  ));

  return elements;
}

export function buildCard(model, options = {}) {
  const { collapsible = true } = options;
  const title = `Shopify 销售日播报 · Comu ${model.market}`;
  return {
    schema: "2.0",
    config: { width_mode: "fill", summary: { content: title } },
    header: { template: "blue", title: { tag: "plain_text", content: title } },
    body: {
      direction: "vertical",
      padding: "16px 16px 16px 16px",
      elements: buildElements(model, { collapsible }),
    },
  };
}

// 主卡片（带折叠面板）+ 兜底卡片（纯表格），交给 sendCard 决定用哪张。
export function buildCards(model, options = {}) {
  const { collapsible = true } = options;
  if (!collapsible) return [buildCard(model, { collapsible: false })];
  return [buildCard(model, { collapsible: true }), buildCard(model, { collapsible: false })];
}
