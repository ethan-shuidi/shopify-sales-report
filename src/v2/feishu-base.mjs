// 从飞书多维表格读取经营效率指标（净MER / 独立站ROI / 整体ROI）。
//
// 用应用身份（tenant_access_token）读取，凭据来自 FEISHU_APP_ID / FEISHU_APP_SECRET。
// 三个市场各有一张底表、一个指标列，只取「最新有值的一天」——因为底表经常
// 已经插入当天行但指标还没回填（EU 就出现过），直接 limit=1 会拿到 null。

const BASE_TOKEN = "JOhHbynSMajxbPsQK1PcQXjdnwg";

// market → 底表配置
const TABLE_BY_MARKET = {
  US: { tableId: "tbl3CnCFICLi3Ii9", field: "净MER", label: "净MER" },
  JP: { tableId: "tbl3uOVA7Cy0rnY9", field: "独立站整体ROI", label: "独立站整体 ROI" },
  EU: { tableId: "tblOCYY4od9Tl97A", field: "整体ROI", label: "整体 ROI" },
};

let cachedToken = null;

async function getTenantToken() {
  if (cachedToken) return cachedToken;
  const appId = process.env.FEISHU_APP_ID;
  const appSecret = process.env.FEISHU_APP_SECRET;
  if (!appId || !appSecret) throw new Error("FEISHU_APP_ID / FEISHU_APP_SECRET 未配置");

  const response = await fetch("https://open.feishu.cn/open-apis/auth/v3/tenant_access_token/internal", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ app_id: appId, app_secret: appSecret }),
  });
  const body = await response.json();
  if (body.code !== 0 || !body.tenant_access_token) {
    throw new Error(`获取 tenant_access_token 失败: ${body.code} ${body.msg}`);
  }
  cachedToken = body.tenant_access_token;
  return cachedToken;
}

/**
 * 读取某个市场的最新指标。
 * @returns {Promise<{label: string, value: number, date: string} | null>} 失败或没数据时返回 null
 */
export async function fetchEfficiency(market) {
  const config = TABLE_BY_MARKET[market];
  if (!config) return null;

  const token = await getTenantToken();
  const params = new URLSearchParams();
  params.append("field_id", "日期");
  params.append("field_id", config.field);
  params.append("sort", JSON.stringify([{ field: "日期", desc: true }]));
  params.append("limit", "10");

  const url = `https://open.feishu.cn/open-apis/base/v3/bases/${BASE_TOKEN}/tables/${config.tableId}/records?${params}`;
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  const body = await response.json();
  if (body.code !== 0) throw new Error(`读取底表失败: ${body.code} ${body.msg}`);

  const rows = body.data?.data || [];
  // 数据是列式返回：[日期, 指标]
  const hit = rows.find((row) => row[1] !== null && row[1] !== undefined && row[1] !== "");
  if (!hit) return null;

  const value = Number(hit[1]);
  if (!Number.isFinite(value)) return null;

  return {
    label: config.label,
    value,
    date: String(hit[0] || "").slice(0, 10),
  };
}
