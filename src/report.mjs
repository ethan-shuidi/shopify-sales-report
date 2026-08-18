const reportType = (process.env.REPORT_TYPE || "daily").toLowerCase();
const diagnoseMissingSku = String(process.env.DIAGNOSE_MISSING_SKU || "false").toLowerCase() === "true";

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
    market: process.env.SHOPIFY_MARKET,
  }, 0)];
}

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

const query = `#graphql
query Orders($first: Int!, $after: String, $search: String!) {
  orders(first: $first, after: $after, query: $search, sortKey: CREATED_AT, reverse: false) {
    pageInfo { hasNextPage endCursor }
    edges { node {
      id name createdAt processedAt updatedAt cancelledAt test
      displayFinancialStatus displayFulfillmentStatus riskLevel currencyCode
      currentTotalPriceSet { shopMoney { amount currencyCode } }
      totalPriceSet { shopMoney { amount currencyCode } }
      totalRefundedSet { shopMoney { amount currencyCode } }
      lineItems(first: 250) { edges { node {
        id title name variantTitle sku quantity
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
  if (type === "rolling7") return { label: "近7日滚动报告", start: addDays(today, -7), end: today };
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
  throw new Error(`REPORT_TYPE must be daily, rolling7, weekly, or monthly; got ${type}`);
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

const singleValueSkus = new Set(["TN10P051", "TN10P052", "TN10P053", "TN10P011", "TN10P012", "TN10P013", "X0051AFG1N"]);
const allowedSuffixValues = new Set([2, 3, 5, 10, 50, 100, 300]);
const finalPaymentTitleKeywords = ["final payment", "balance payment", "remaining payment", "balance due"];
const warrantyTitleKeywords = ["warranty", "extended warranty", "comucare"];
const presaleTitleKeywords = ["presale", "pre-sale", "voucher", "privilege voucher"];

function titleMatches(title, keywords) {
  const normalized = String(title || "").toLowerCase();
  return keywords.some((keyword) => normalized.includes(keyword));
}

function isFinalPaymentItem(item) {
  return titleMatches(item?.title, finalPaymentTitleKeywords);
}

function isWarrantyItem(item) {
  return titleMatches(item?.title, warrantyTitleKeywords);
}

function warrantyServiceLabel(item) {
  const title = String(item?.title || "延保服务").trim() || "延保服务";
  const variantTitle = String(item?.variantTitle || "").trim();
  const warrantyText = `${variantTitle} ${item?.name || ""} ${title}`.toLowerCase();
  if (/\b1[\s-]*year\b|1\s*年/.test(warrantyText)) return "一年延保";
  if (/\b2[\s-]*year\b|2\s*年/.test(warrantyText)) return "两年延保";
  if (!variantTitle || variantTitle.toLowerCase() === "default title") return String(item?.name || title).trim() || title;
  if (title.toLowerCase().includes(variantTitle.toLowerCase())) return title;
  return `${title}（${variantTitle}）`;
}

function isPresaleItem(item) {
  return titleMatches(item?.title, presaleTitleKeywords);
}

function normalizedSku(value) {
  return String(value || "").trim().toUpperCase() || "(无 SKU)";
}

function skuUnitValue(rawSku) {
  const sku = normalizedSku(rawSku);
  if (singleValueSkus.has(sku)) return 1;
  const match = sku.match(/^(TN10P011|TN10P012|TN10P013)-(\d+)$/);
  if (!match || !allowedSuffixValues.has(Number(match[2]))) return 1;
  return Number(match[2]);
}

function variantColor(variant) {
  const options = variant?.selectedOptions || [];
  const colorOption = options.find((option) => {
    const name = String(option?.name || "").trim().toLowerCase();
    return name === "color" || name === "colour" || name === "颜色" || name.includes("color") || name.includes("colour");
  });
  return String(colorOption?.value || "").trim();
}

function skuColor(rawSku, title = "", variant = null) {
  const sku = normalizedSku(rawSku);
  if (titleMatches(title, warrantyTitleKeywords)) return "延保服务";
  if (!titleMatches(title, finalPaymentTitleKeywords) && titleMatches(title, presaleTitleKeywords)) return "预售";
  const shopifyColor = variantColor(variant);
  if (shopifyColor) return shopifyColor;
  if (sku === "X0051AFG1N" || sku === "TN10P011" || sku === "TN10P051" || sku === "TN20P011" || sku.startsWith("TN10P011-")) return "黑色";
  if (sku === "TN10P012" || sku === "TN10P052" || sku === "TN20P012" || sku.startsWith("TN10P012-")) return "银色";
  if (sku === "TN10P013" || sku === "TN10P053" || sku === "TN20P014" || sku.startsWith("TN10P013-")) return sku === "TN20P014" ? "樱桃红" : "橙色";
  return "未分类";
}

function orderUnits(order) {
  return lineItems(order).reduce((sum, item) => {
    if (isWarrantyItem(item)) return sum;
    if (isFinalPaymentItem(item)) {
      if (!String(item.sku || "").trim()) return sum;
    } else if (isPresaleItem(item)) {
      return sum;
    }
    return sum + Number(item.quantity || 0) * skuUnitValue(item.sku);
  }, 0);
}

function fulfillmentLabel(order) {
  const labels = {
    FULFILLED: "已发货",
    PARTIALLY_FULFILLED: "部分发货",
    UNFULFILLED: "待发货",
    ON_HOLD: "暂停发货",
    SCHEDULED: "已排期",
    IN_PROGRESS: "处理中",
    RESTOCKED: "已补货",
    REQUEST_DECLINED: "发货请求拒绝",
  };
  return labels[order.displayFulfillmentStatus] || order.displayFulfillmentStatus || "未知";
}

function riskLabel(value) {
  const labels = { LOW: "低", MEDIUM: "中", HIGH: "高" };
  return labels[value] || value || "未知";
}

function searchFor(start, end) {
  return `created_at:>=${start} created_at:<${end}`;
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
  const unfulfilled = included.length - fulfilled - partiallyFulfilled;
  const units = included.reduce((sum, o) => sum + orderUnits(o), 0);
  const sales = included.reduce((sum, o) => sum + money(o.currentTotalPriceSet || o.totalPriceSet), 0);
  const refunds = included.reduce((sum, o) => sum + money(o.totalRefundedSet), 0);
  const skuMap = new Map();
  const warrantyMap = new Map();
  const dailyMap = new Map();
  for (let day = start; day < end; day = addDays(day, 1)) {
    dailyMap.set(day, { date: day, units: 0, skuMap: new Map() });
  }
  const abnormalOrderIds = new Set();
  let presaleUnits = 0;
  for (const order of included) {
    const daily = dailyMap.get(dateKey(new Date(order.createdAt), timezone));
    for (const item of lineItems(order)) {
      if (isWarrantyItem(item)) {
        const title = warrantyServiceLabel(item);
        const orderId = order.name || order.id;
        const warrantyDate = dateKey(new Date(order.createdAt), timezone);
        const warrantyKey = `${warrantyDate}\u0000${orderId}\u0000${title}`;
        const warranty = warrantyMap.get(warrantyKey) || { date: warrantyDate, title, quantity: 0, orderId };
        warranty.quantity += Number(item.quantity || 0);
        warrantyMap.set(warrantyKey, warranty);
        continue;
      }
      if (isFinalPaymentItem(item)) {
        if (!String(item.sku || "").trim()) {
          abnormalOrderIds.add(order.name || order.id);
          continue;
        }
      } else if (isPresaleItem(item)) {
        presaleUnits += Number(item.quantity || 0) * skuUnitValue(item.sku);
        continue;
      }
      const sku = normalizedSku(item.sku);
      const color = skuColor(item.sku, item.title, item.variant);
      const quantity = Number(item.quantity || 0) * skuUnitValue(item.sku);
      const key = `${sku}\u0000${color}`;
      const row = skuMap.get(key) || { sku, color, quantity: 0 };
      row.quantity += quantity;
      skuMap.set(key, row);
      if (daily) {
        daily.units += quantity;
        const dailyRow = daily.skuMap.get(key) || { sku, color, quantity: 0 };
        dailyRow.quantity += quantity;
        daily.skuMap.set(key, dailyRow);
      }
    }
  }
  const orderDetails = included
    .sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
    .map((order) => ({ name: order.name || order.id, risk: riskLabel(order.riskLevel), fulfillment: fulfillmentLabel(order), units: orderUnits(order) }));
  const dailySummary = [...dailyMap.values()].map((row) => ({
    date: row.date,
    units: row.units,
    skuSummary: [...row.skuMap.values()].sort((a, b) => b.quantity - a.quantity),
  }));
  const warrantySummary = [...warrantyMap.values()]
    .sort((a, b) => a.date.localeCompare(b.date) || a.orderId.localeCompare(b.orderId));
  const warrantyUnits = warrantySummary.reduce((sum, row) => sum + row.quantity, 0);
  return { orderCount: included.length, units, presaleUnits, warrantyUnits, warrantySummary, sales, refunds, netSales: sales - refunds, fulfilled, partiallyFulfilled, unfulfilled, currency, skuSummary: [...skuMap.values()].sort((a, b) => b.quantity - a.quantity), dailySummary, abnormalOrderIds: [...abnormalOrderIds], orderDetails };
}

function missingSkuDiagnostics(orders, start, end, timezone) {
  const included = orders.filter((o) => o.createdAt && inRange(o.createdAt, start, end, timezone) && !o.cancelledAt && !o.test);
  const rows = [];
  for (const order of included) {
    for (const item of lineItems(order)) {
      if (isWarrantyItem(item)) continue;
      const rawSku = String(item.sku || "").trim();
      const color = skuColor(item.sku, item.title, item.variant);
      const reasons = [];
      if (!rawSku) reasons.push("无 SKU");
      if (color === "未分类") reasons.push("颜色未分类");
      if (reasons.length === 0) continue;
      rows.push({
        order: order.name || order.id,
        orderDate: dateKey(new Date(order.createdAt), timezone),
        title: item.title || "",
        sku: rawSku || "(无 SKU)",
        color,
        quantity: Number(item.quantity || 0),
        reasons,
      });
    }
  }
  return rows;
}

function fmtMoney(value, currency) {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(value);
}

function pct(current, previous) {
  if (previous === 0) return current === 0 ? "0%" : "+100%";
  const value = ((current - previous) / previous) * 100;
  return `${value >= 0 ? "+" : ""}${value.toFixed(1)}%`;
}

function makeTable(columns, rows) {
  for (const [index, column] of columns.entries()) {
    const pixelWidth = String(column.width || "").match(/^(\d+)px$/);
    if (pixelWidth && (Number(pixelWidth[1]) < 80 || Number(pixelWidth[1]) > 600)) {
      throw new Error(`Feishu table column ${index + 1} width must be between 80px and 600px; got ${column.width}`);
    }
  }
  return {
    tag: "table",
    columns: columns.map((column) => ({
      ...column,
      horizontal_align: "center",
      vertical_align: "center",
    })),
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

function markdown(content) {
  return { tag: "markdown", content };
}

function kpiColumn(label, value, change = "") {
  return {
    tag: "column",
    width: "weighted",
    weight: 1,
    elements: [{ ...markdown(`**${label}**\n${value}${change ? `（${change}）` : ""}`), text_align: "left" }],
  };
}

function kpiGrid(metrics) {
  const rows = [];
  for (let offset = 0; offset < metrics.length; offset += 3) {
    const columns = metrics.slice(offset, offset + 3);
    while (columns.length < 3) {
      columns.push({
        tag: "column",
        width: "weighted",
        weight: 1,
        elements: [markdown("　")],
      });
    }
    rows.push({
      tag: "column_set",
      flex_mode: "none",
      horizontal_spacing: "large",
      columns,
    });
  }
  return rows;
}

function makeCard(title, elements, template = "blue") {
  return {
    schema: "2.0",
    config: {
      width_mode: "fill",
      summary: { content: title },
    },
    header: {
      template,
      title: { tag: "plain_text", content: title },
    },
    body: {
      direction: "vertical",
      padding: "12px 12px 12px 12px",
      elements,
    },
  };
}

function skuKey(row) {
  return `${row.sku}\u0000${row.color}`;
}

function skuLabel(row) {
  return `${row.sku} / ${row.color}`;
}

function signedNumber(value) {
  return `${value > 0 ? "+" : ""}${value}`;
}

function ancillaryComparisonRows(current, previous) {
  return [
    {
      item: "预售量",
      current: current.presaleUnits,
      previous: previous.presaleUnits,
      delta: signedNumber(current.presaleUnits - previous.presaleUnits),
      growth: pct(current.presaleUnits, previous.presaleUnits),
    },
    {
      item: "延保服务",
      current: current.warrantyUnits,
      previous: previous.warrantyUnits,
      delta: signedNumber(current.warrantyUnits - previous.warrantyUnits),
      growth: pct(current.warrantyUnits, previous.warrantyUnits),
    },
  ];
}

function periodComparisonRows(current, previous, groupByFamilyColor = false, includeAncillary = true) {
  const currentMap = new Map(current.skuSummary.map((row) => [skuKey(row), row]));
  const previousMap = new Map(previous.skuSummary.map((row) => [skuKey(row), row]));
  let productRows;
  if (groupByFamilyColor) {
    const currentFamilyColors = aggregateFamilyColors(current.skuSummary);
    const previousFamilyColors = aggregateFamilyColors(previous.skuSummary);
    productRows = familyColorDimensions([...current.skuSummary, ...previous.skuSummary])
      .filter((dimension) => (currentFamilyColors.get(dimension.key) || 0) > 0 || (previousFamilyColors.get(dimension.key) || 0) > 0)
      .map((dimension) => {
        const currentQuantity = currentFamilyColors.get(dimension.key) || 0;
        const previousQuantity = previousFamilyColors.get(dimension.key) || 0;
        return {
          item: `${dimension.family}${dimension.color}`,
          current: currentQuantity,
          previous: previousQuantity,
          delta: signedNumber(currentQuantity - previousQuantity),
          growth: pct(currentQuantity, previousQuantity),
        };
      });
  } else {
    const keys = [...new Set([...currentMap.keys(), ...previousMap.keys()])]
      .sort((a, b) => (currentMap.get(b)?.quantity || 0) - (currentMap.get(a)?.quantity || 0));
    productRows = keys.map((key) => {
      const currentRow = currentMap.get(key);
      const previousRow = previousMap.get(key);
      const currentQuantity = currentRow?.quantity || 0;
      const previousQuantity = previousRow?.quantity || 0;
      return {
        item: skuLabel(currentRow || previousRow),
        current: currentQuantity,
        previous: previousQuantity,
        delta: signedNumber(currentQuantity - previousQuantity),
        growth: pct(currentQuantity, previousQuantity),
      };
    });
  }
  return [
    {
      item: "全部商品",
      current: current.units,
      previous: previous.units,
      delta: signedNumber(current.units - previous.units),
      growth: pct(current.units, previous.units),
    },
    ...(includeAncillary ? ancillaryComparisonRows(current, previous) : []),
    ...productRows,
  ];
}

function familyColorKey(row) {
  return `${skuFamily(row.sku)}\u0000${row.color}`;
}

function familyColorDimensions(skuSummary) {
  const preferred = [
    { family: "TN20", color: "黑色" },
    { family: "TN20", color: "银色" },
    { family: "TN20", color: "樱桃红" },
    { family: "TN10", color: "黑色" },
    { family: "TN10", color: "银色" },
    { family: "TN10", color: "橙色" },
  ].map((row) => ({ ...row, key: `${row.family}\u0000${row.color}` }));
  const preferredKeys = new Set(preferred.map((row) => row.key));
  const extras = [...new Map(skuSummary.map((row) => {
    const family = skuFamily(row.sku);
    const key = `${family}\u0000${row.color}`;
    return [key, { key, family, color: row.color }];
  })).values()]
    .filter((row) => !preferredKeys.has(row.key))
    .sort((a, b) => a.family.localeCompare(b.family) || a.color.localeCompare(b.color));
  return [...preferred, ...extras];
}

function aggregateFamilyColors(skuSummary) {
  const quantities = new Map();
  for (const row of skuSummary) {
    const key = familyColorKey(row);
    quantities.set(key, (quantities.get(key) || 0) + row.quantity);
  }
  return quantities;
}

function dailySalesTable(current) {
  const dimensions = familyColorDimensions(current.skuSummary);
  const totals = aggregateFamilyColors(current.skuSummary);
  const columns = [
    { name: "date", display_name: "日期", data_type: "text", width: "110px" },
    { name: "total", display_name: "合计", data_type: "number", width: "80px" },
    ...dimensions.map((row, index) => ({
      name: `variant_${index}`,
      display_name: `${row.family}${row.color}`,
      data_type: "number",
      width: "100px",
    })),
  ];
  const rows = current.dailySummary.map((daily) => {
    const quantities = aggregateFamilyColors(daily.skuSummary);
    const result = { date: daily.date.replaceAll("-", "/"), total: daily.units };
    dimensions.forEach((row, index) => {
      result[`variant_${index}`] = quantities.get(row.key) || 0;
    });
    return result;
  });
  const summary = { date: "合计", total: current.units };
  dimensions.forEach((row, index) => {
    summary[`variant_${index}`] = totals.get(row.key) || 0;
  });
  rows.push(summary);
  return makeTable(columns, rows);
}

function skuFamily(rawSku) {
  const sku = normalizedSku(rawSku);
  const match = sku.match(/^(TN\d+)/);
  return match ? match[1] : "其他";
}

function skuMatrixTable(current) {
  const familyTotals = new Map();
  const colorFamilies = new Map();
  for (const row of current.skuSummary) {
    const family = skuFamily(row.sku);
    familyTotals.set(family, (familyTotals.get(family) || 0) + row.quantity);
    const colorMap = colorFamilies.get(row.color) || new Map();
    colorMap.set(family, (colorMap.get(family) || 0) + row.quantity);
    colorFamilies.set(row.color, colorMap);
  }
  const families = [...familyTotals.keys()].sort((a, b) => {
    const order = ["TN10", "TN20", "其他"];
    const aIndex = order.indexOf(a);
    const bIndex = order.indexOf(b);
    if (aIndex !== -1 || bIndex !== -1) return (aIndex === -1 ? order.length : aIndex) - (bIndex === -1 ? order.length : bIndex);
    return a.localeCompare(b);
  });
  const preferredColors = ["黑色", "银色", "樱桃红", "橙色", "白色", "绿色", "蓝色", "紫色", "未分类", "其他"];
  const colors = [...colorFamilies.keys()].sort((a, b) => {
    const aIndex = preferredColors.indexOf(a);
    const bIndex = preferredColors.indexOf(b);
    if (aIndex !== -1 || bIndex !== -1) return (aIndex === -1 ? preferredColors.length : aIndex) - (bIndex === -1 ? preferredColors.length : bIndex);
    return a.localeCompare(b);
  });
  const columns = [
    { name: "color", display_name: "颜色", data_type: "text", width: "110px" },
    ...families.map((family, index) => ({ name: `family_${index}`, display_name: family, data_type: "text", width: "100px" })),
    { name: "total", display_name: "合计", data_type: "text", width: "80px" },
  ];
  const rows = colors.map((color) => {
    const colorMap = colorFamilies.get(color);
    const row = {
      color,
      total: String([...colorMap.values()].reduce((sum, quantity) => sum + quantity, 0)),
    };
    families.forEach((family, index) => {
      row[`family_${index}`] = colorMap.has(family) ? String(colorMap.get(family)) : "—";
    });
    return row;
  });
  const subtotal = { color: "小计" };
  families.forEach((family, index) => {
    subtotal[`family_${index}`] = familyTotals.has(family) ? String(familyTotals.get(family)) : "—";
  });
  subtotal.total = String([...familyTotals.values()].reduce((sum, quantity) => sum + quantity, 0));
  rows.push(subtotal);
  return makeTable(columns, rows);
}

function warrantyTable(current) {
  return makeTable([
    { name: "date", display_name: "日期", data_type: "text", width: "110px" },
    { name: "service", display_name: "延保服务", data_type: "text", width: "auto" },
    { name: "quantity", display_name: "数量", data_type: "number", width: "80px" },
    { name: "orders", display_name: "订单号", data_type: "text", width: "auto" },
  ], current.warrantySummary.map((row) => ({
    date: row.date.replaceAll("-", "/"),
    service: row.title,
    quantity: row.quantity,
    orders: row.orderId,
  })));
}

function appendWarrantyDetails(elements, current) {
  if (current.warrantyUnits > 0) {
    elements.push(markdown(`**延保服务明细**　共 ${current.warrantyUnits} 份`), warrantyTable(current));
  }
}

function buildMessages(storeConfig, period, current, previous) {
  const dateLabel = `${period.start} 至 ${addDays(period.end, -1)}`;
  const title = `📊 Shopify Comu ${storeConfig.market}｜${period.label}｜${dateLabel}`;
  const headerTemplate = period.label === "周报"
    ? "green"
    : period.label === "月报"
      ? "purple"
      : period.label === "近7日滚动报告"
        ? "orange"
        : "blue";
  const isDaily = period.label === "日报";
  const dayCount = current.dailySummary.length || 1;
  const averageDailyUnits = Number((current.units / dayCount).toFixed(1));
  const metrics = [
    kpiColumn("订单数", current.orderCount, pct(current.orderCount, previous.orderCount)),
    kpiColumn("商品销量", current.units, pct(current.units, previous.units)),
    kpiColumn("销售额", fmtMoney(current.sales, current.currency), pct(current.sales, previous.sales)),
    kpiColumn("退款金额", fmtMoney(current.refunds, current.currency)),
    kpiColumn("净销售额", fmtMoney(current.netSales, current.currency)),
  ];
  if (!isDaily) {
    metrics.push(kpiColumn("日均销量", averageDailyUnits, pct(averageDailyUnits, Number((previous.units / (previous.dailySummary.length || 1)).toFixed(1)))));
  }
  if (isDaily && current.presaleUnits > 0) {
    metrics.push(kpiColumn("预售量", current.presaleUnits, pct(current.presaleUnits, previous.presaleUnits)));
  }
  const elements = kpiGrid(metrics);

  if (!isDaily) {
    const isRolling7 = period.label === "近7日滚动报告";
    const comparisonColumns = [
      { name: "item", display_name: "商品", data_type: "text", width: "180px" },
      { name: "current", display_name: "本周期", data_type: "number", width: "80px" },
      { name: "previous", display_name: "上周期", data_type: "number", width: "80px" },
      { name: "delta", display_name: "增长量", data_type: "text", width: "80px" },
      { name: "growth", display_name: "增长率", data_type: "text", width: "80px" },
    ];
    elements.push(markdown(`**发货状态**　已发货：${current.fulfilled}　部分发货：${current.partiallyFulfilled}　待发货：${current.unfulfilled}`));
    elements.push(
      markdown(`**${period.label === "月报" ? "月度" : "周度"}对比**`),
      makeTable(comparisonColumns, periodComparisonRows(current, previous, isRolling7, !isRolling7)),
    );
    if (isRolling7) {
      elements.push(
        markdown("**其他**"),
        makeTable([
          { ...comparisonColumns[0], display_name: "项目" },
          ...comparisonColumns.slice(1),
        ], ancillaryComparisonRows(current, previous)),
      );
    }
    elements.push(markdown("**日销量明细**"), dailySalesTable(current));
    appendWarrantyDetails(elements, current);
    if (current.abnormalOrderIds.length > 0) {
      elements.push(markdown(`<font color='red'>**异常订单（尾款缺少 SKU）**</font>\n${current.abnormalOrderIds.join("、")}`));
    }
    elements.push(markdown("统计周期与每日切分均按店铺配置时区计算。"));
    return [makeCard(title, elements, headerTemplate)];
  }

  elements.push(markdown("**SKU 销量明细**"));

  if (current.skuSummary.length > 0) {
    elements.push(skuMatrixTable(current));
  } else {
    elements.push(markdown("本周期没有商品销量。"));
  }

  appendWarrantyDetails(elements, current);

  if (current.abnormalOrderIds.length > 0) {
    elements.push(markdown(`<font color='red'>**异常订单（尾款缺少 SKU）**</font>\n${current.abnormalOrderIds.join("、")}`));
  }

  elements.push(markdown("请查看 Shopify 看板或后台了解完整详情。"));
  const messages = [makeCard(title, elements, headerTemplate)];
  const orderRows = current.orderDetails.map((row) => ({
    name: row.name,
    risk: row.risk,
    fulfillment: row.fulfillment,
    units: row.units,
  }));
  const orderColumns = [
    { name: "name", display_name: "订单号", data_type: "text", width: "auto" },
    { name: "risk", display_name: "风险等级", data_type: "text", width: "80px" },
    { name: "fulfillment", display_name: "发货状态", data_type: "text", width: "auto" },
    { name: "units", display_name: "销量", data_type: "number", width: "80px" },
  ];
  const orderChunkSize = 50;
  for (let offset = 0; offset < orderRows.length; offset += orderChunkSize) {
    const chunk = orderRows.slice(offset, offset + orderChunkSize);
    messages.push(makeCard(`${title}｜订单明细 ${Math.floor(offset / orderChunkSize) + 1}`, [
      markdown(`**发货汇总**　已发货：${current.fulfilled}　部分发货：${current.partiallyFulfilled}　待发货：${current.unfulfilled}`),
      markdown(`**订单明细**　共 ${orderRows.length} 笔，本卡显示第 ${offset + 1}–${offset + chunk.length} 笔`),
      makeTable(orderColumns, chunk),
    ], headerTemplate));
  }
  return messages;
}

async function sendFeishu(storeConfig, cardPayload) {
  const response = await fetch(storeConfig.feishuWebhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ msg_type: "interactive", card: cardPayload })
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
    if (diagnoseMissingSku) {
      console.log(JSON.stringify({
        store: storeConfig.store,
        timezone: storeConfig.timezone,
        reportType,
        period,
        missingSkuDiagnostics: missingSkuDiagnostics(orders, period.start, period.end, storeConfig.timezone),
      }, null, 2));
      continue;
    }
    const currentMetrics = aggregate(orders, period.start, period.end, storeConfig.timezone);
    const previousMetrics = aggregate(orders, previous.start, period.start, storeConfig.timezone);
    const messages = buildMessages(storeConfig, period, currentMetrics, previousMetrics);
    for (const message of messages) await sendFeishu(storeConfig, message);
    console.log(JSON.stringify({
      store: storeConfig.store,
      timezone: storeConfig.timezone,
      reportType,
      period,
      orderCount: currentMetrics.orderCount,
    }, null, 2));
  } catch (error) {
    failures.push(`${storeConfig.name} (${storeConfig.store}): ${error.message}`);
    console.error(`Report failed for ${storeConfig.store}:`, error);
  }
}

if (failures.length > 0) {
  throw new Error(`One or more store reports failed:\n${failures.join("\n")}`);
}
