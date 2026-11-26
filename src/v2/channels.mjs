// 渠道分组：严格按《Shopify Attribution 渠道分组逻辑说明》的五个分组输出。
//
//   广告     ← Shopify channel 白名单 google_ads / meta_ads / microsoft_ads / bing_ads / tiktok_ads
//   红人     ← channel / campaign 文本含 KOL、Creator、Influencer、红人（大小写不敏感）
//   联盟     ← Shopify channel 白名单 capitaloneshopping / gocertify / impact_ads /
//              affiliate_impact / rakuten / promocodes / dailypickjournal / thevouchercode /
//              refermate / coupon-pilot
//   AI 搜索导流 ← chatgpt / openai / perplexity / copilot / gemini / claude
//   自然搜索   ← google / bing / yahoo / ecosia … 的自然搜索流量
//   其他渠道   ← direct / email / social / app 等其余自然流量
//   待确定     ← 以上都未命中
//
// 判定顺序：联盟 → 广告 → 红人 → 自然搜索 / 其他渠道 → AI 搜索导流 → 待确定，命中即停。
//
// 字段映射说明：Admin API 拿不到文档里的 `channel` 原值（它来自 Shopify Attribution 导出），
// 所以 channel 用 marketing_platform / utm_source 近似，并且允许用
// "广告平台 + 付费 medium" 命中广告白名单——否则 google_ads 这类命名在真实数据里一条都命中不了
// （实测三个店铺的 channel 只有 google / meta / affiliate_impact / chatgpt_ads）。

const GROUP_ORDER = ["ad", "kol", "affiliate", "search", "direct", "ai", "other", "unknown"];

export const GROUPS = {
  ad: { name: "广告" },
  kol: { name: "红人" },
  affiliate: { name: "联盟" },
  search: { name: "自然搜索" },
  direct: { name: "直接访问" },
  ai: { name: "AI 搜索导流" },
  other: { name: "其他渠道" },
  unknown: { name: "待确定" },
};

const PAID_MEDIUMS = new Set([
  "cpc", "ppc", "paid", "paid-social", "paid_social", "paid-search", "paid_search",
  "display", "pmax", "cpm", "cpa", "sem", "shopping",
]);

// 文档 §4 广告白名单
const AD_CHANNELS = new Set(["googleads", "metaads", "microsoftads", "bingads", "tiktokads"]);

// 广告平台（channel 近似值）→ 展示名
const AD_PLATFORMS = new Map([
  ["meta", "Meta"], ["facebook", "Meta"], ["fb", "Meta"], ["instagram", "Meta"], ["ig", "Meta"],
  ["google", "Google"], ["googleads", "Google"], ["adwords", "Google"],
  ["youtube", "YouTube"], ["youtu.be", "YouTube"],
  ["tiktok", "TikTok"],
  ["bing", "Bing"], ["microsoftads", "Bing"], ["microsoft", "Microsoft"],
]);

// 文档 §4 联盟白名单（squash 后比较，忽略大小写与下划线/连字符）
const AFFILIATE_TOKENS = [
  ["capitaloneshopping", "Capital One Shopping"],
  ["gocertify", "Go Certify"],
  ["impactads", "Impact"],
  ["affiliateimpact", "Impact"],
  ["impact", "Impact"],
  ["rakuten", "Rakuten"],
  ["promocodes", "Promocodes"],
  ["dailypickjournal", "Daily Pick Journal"],
  ["thevouchercode", "The Voucher Code"],
  ["refermate", "Refermate"],
  ["couponpilot", "Coupon Pilot"],
];

// 红人合作标签（文档 §4：普通 Instagram / YouTube / 媒体 referral 不自动归红人）
const KOL_PATTERN = /kol|creator|influencer|红人|达人/;

// 其他已识别：自然流量 / 站内 / 工具类
const SEARCH_PLATFORMS = new Set([
  "google", "microsoft", "bing", "brave", "duckduckgo", "yahoo", "ecosia",
  "startpage", "qwant", "seznam", "naver", "baidu", "yandex", "aol",
]);
const SOCIAL_PLATFORMS = new Set(["meta", "facebook", "instagram", "tiktok", "pinterest", "linkedin", "threads", "social-media", "social", "ig"]);
const AI_PLATFORMS = new Set(["openai", "chatgpt", "perplexity", "copilot", "gemini", "claude"]);
const EMAIL_PLATFORMS = new Set(["klaviyo", "mailchimp", "omnisend"]);
const APP_PLATFORMS = new Set(["app", "appuser", "shop_app", "shopify"]);

const SEARCH_HOSTS = /google\.|bing\.|yahoo\.|duckduckgo|ecosia|search\.brave\.|baidu\.|yandex\.|naver\.|startpage|qwant\.|seznam\./;
const SOCIAL_HOSTS = /facebook\.|fb\.me|instagram\.|t\.co|twitter\.|x\.com|tiktok\.|pinterest\.|linkedin\.|threads\.net|youtube\.|youtu\.be/;
const MAIL_HOSTS = /mail\.google\.|gmail|outlook\.|mail\.yandex|mail\.qq\.|proton\.|mail\.ru|com\.google\.android\.gm/;

// visit.source 的纯文本取值（Shopify 会把来源写成 "Google" / "email" / "direct" 这类名字）
const TEXT_SOURCE_BUCKETS = [
  [/^direct$/, { group: "direct", key: "direct:direct", name: "直接访问" }],
  [/an unknown source|^unknown$|^$/, null],
  [/google|bing|yahoo|duckduckgo|brave|ecosia|startpage|qwant|seznam|baidu|yandex|naver|aol/, { group: "search", key: "search:organic", name: "自然搜索" }],
  [/instagram|facebook|fb|youtube|tiktok|twitter|^x$|pinterest|linkedin|threads/, { group: "other", key: "organic:social", name: "社媒（自然）" }],
  [/chatgpt|gemini|perplexity|copilot|claude|openai/, { group: "ai", key: "ai:search", name: "AI 搜索导流" }],
  [/email|newsletter|klaviyo|mailchimp|omnisend/, { group: "other", key: "organic:email", name: "邮件" }],
  [/bshop\b|shop\.app|shopify|^app$|appuser/, { group: "other", key: "organic:app", name: "App / 站内" }],
  [/^referral$|^referrer$/, { group: "other", key: "organic:referral", name: "外部引荐" }],
];

const AD_PLATFORM_KEYS = new Set(["meta", "facebook", "fb", "instagram", "ig", "google", "googleads", "adwords", "youtube", "youtu.be", "tiktok", "bing", "microsoftads", "microsoft"]);

function norm(value) {
  return String(value || "").trim().toLowerCase().replace(/!+$/, "");
}

// 去掉大小写、下划线、连字符、点号，便于和文档白名单对比
function squash(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, "");
}

function hostOf(url) {
  const raw = String(url || "").trim().toLowerCase();
  if (!raw) return "";
  const match = raw.match(/^[a-z][a-z0-9+.-]*:\/\/([^/?#]+)/);
  if (match) return match[1];
  return raw.startsWith("android-app:") || raw.startsWith("ios-app:") ? raw : "";
}

function affiliateMatch(candidates) {
  for (const value of candidates) {
    const s = squash(value);
    if (!s) continue;
    for (const [token, label] of AFFILIATE_TOKENS) {
      if (s.includes(token)) return { key: `affiliate:${squash(label)}`, name: label };
    }
  }
  return null;
}

function adMatch({ source, medium, platform, paid }) {
  const s = norm(source);
  const p = norm(platform);
  const m = norm(medium);

  // 1) 命中文档白名单（google_ads 这类）
  for (const value of [s, p]) {
    const squashed = squash(value);
    if (AD_CHANNELS.has(squashed)) return { key: `ad:${squashed}`, name: AD_PLATFORMS.get(value) || value };
  }
  // 2) 名称本身以 _ads 结尾（例如你们数据里的 chatgpt_ads）
  if (/_?ads$/.test(s) && s.length > 4) return { key: `ad:${s}`, name: s };

  // 3) 来源名本身带 paid / advert 标记（例如 Paid-social）
  if (/paid|advert|广告/.test(s)) return { key: `ad:${s}`, name: `${source} 广告` };

  // 4) 广告平台 + 付费 medium —— 等价于文档说的"明确标记的付费广告来源"
  const platformKey = AD_PLATFORM_KEYS.has(s) ? s : (AD_PLATFORM_KEYS.has(p) ? p : "");
  if (platformKey && paid) {
    const label = AD_PLATFORMS.get(platformKey) || platformKey;
    return { key: `ad:${label}`, name: `${label} 广告` };
  }
  return null;
}

function kolMatch({ source, campaign, medium }) {
  // campaign 里带 KOL 标签最可信；其次看 channel(≈utm_source)；medium 只能证明是红人流量，
  // 展示名仍用 source/campaign，否则会出现"primeday 红人"这种看不出是哪个红人的名字。
  if (KOL_PATTERN.test(norm(campaign))) {
    const label = String(campaign).trim();
    return { key: `kol:${squash(label)}`, name: label };
  }
  if (KOL_PATTERN.test(norm(source))) {
    const label = String(source).trim();
    return { key: `kol:${squash(label)}`, name: label };
  }
  if (KOL_PATTERN.test(norm(medium))) {
    // 只有 medium 带 KOL 时，source 通常是红人/账号名，比 campaign 更有辨识度
    const label = String(source || campaign || "红人").trim();
    return { key: `kol:${squash(label)}`, name: label };
  }
  return null;
}

function textSourceMatch(raw) {
  const value = norm(raw);
  if (!value || value.includes("://")) return null;
  if (KOL_PATTERN.test(value)) return { group: "kol", key: `kol:${squash(value)}`, name: String(raw).trim() };
  for (const [pattern, bucket] of TEXT_SOURCE_BUCKETS) {
    if (pattern.test(value)) return bucket ? { ...bucket } : null;
  }
  return null;
}

function aiMatch({ source, platform, referrerUrl }) {
  const p = norm(platform);
  const s = norm(source);
  const host = hostOf(referrerUrl);
  if (AI_PLATFORMS.has(p)
    || /chatgpt|openai|perplexity|copilot|gemini|claude/.test(s)
    || /chatgpt\.|openai\.|perplexity\.|gemini\.|claude\.|copilot\./.test(host)) {
    return { key: "ai:search", name: "AI 搜索导流" };
  }
  return null;
}

function organicMatch({ source, medium, platform, sourceType, referrerUrl, internalHosts }) {
  const p = norm(platform);
  const st = norm(sourceType);
  const m = norm(medium);
  const s = norm(source);
  const host = hostOf(referrerUrl);

  const isInternal = host && (internalHosts || []).some((domain) => domain && host.endsWith(String(domain).toLowerCase()));
  if (isInternal) return { group: "direct", key: "direct:direct", name: "直接访问" };
  if (MAIL_HOSTS.test(host)) return { group: "other", key: "organic:email", name: "邮件" };
  if (SEARCH_HOSTS.test(host)) return { group: "search", key: "search:organic", name: "自然搜索" };
  if (SOCIAL_HOSTS.test(host)) return { group: "other", key: "organic:social", name: "社媒（自然）" };

  if (p === "direct" || st === "direct" || s === "direct") return { group: "direct", key: "direct:direct", name: "直接访问" };
  if (/^referral$|^referrer$/.test(s) || st === "referral") return { group: "other", key: "organic:referral", name: "外部引荐" };
  if (/instagram|facebook|^fb$|youtube|tiktok|twitter|^x$|pinterest|linkedin|threads|social/.test(s)) {
    return { group: "other", key: "organic:social", name: "社媒（自然）" };
  }
  if (/google|bing|yahoo|duckduckgo|brave|ecosia|naver|baidu|yandex|aol|startpage|qwant/.test(s)) {
    return { group: "search", key: "search:organic", name: "自然搜索" };
  }
  if (EMAIL_PLATFORMS.has(p) || EMAIL_PLATFORMS.has(squash(s)) || m === "email" || s === "email" || st === "email") {
    return { group: "other", key: "organic:email", name: "邮件" };
  }
  if (SEARCH_PLATFORMS.has(p) || st === "seo") return { group: "search", key: "search:organic", name: "自然搜索" };
  if (SOCIAL_PLATFORMS.has(p) || st === "social") return { group: "other", key: "organic:social", name: "社媒（自然）" };
  if (APP_PLATFORMS.has(p) || APP_PLATFORMS.has(squash(s))) return { group: "other", key: "organic:app", name: "App / 站内" };
  return null;
}

/**
 * 按文档五分组判定。命中即返回，顺序：联盟 → 广告 → 红人 → 其他已识别 → 待确认。
 * @returns {{group: string, key: string, name: string, paid: boolean}}
 */
export function classifyChannel({ source, medium, platform, sourceType, campaign, referrerUrl, visitSource, storeDomain, internalHosts } = {}) {
  const m = norm(medium);
  const paid = PAID_MEDIUMS.has(m);
  const candidates = [source, platform, hostOf(referrerUrl)];

  // ① 联盟白名单
  const affiliate = affiliateMatch(candidates);
  if (affiliate) return { group: "affiliate", key: affiliate.key, name: affiliate.name, paid: false };

  // ② 广告白名单
  const ad = adMatch({ source, medium, platform, paid });
  if (ad) return { group: "ad", key: ad.key, name: ad.name, paid: true };

  // ③ 红人合作标签
  const kol = kolMatch({ source, campaign, medium });
  if (kol) return { group: "kol", key: kol.key, name: kol.name, paid: false };

  // ④ 订单 visit.source 的纯文本来源（"Google" / "email" / "direct" / "Instagram" …）
  const byText = textSourceMatch(visitSource);
  if (byText) return { group: byText.group, key: byText.key, name: byText.name, paid: false };

  // ⑤ 自然搜索 / 其他渠道（直接访问、邮件、社媒、App）
  const hosts = internalHosts || (storeDomain ? [storeDomain] : []);
  const organic = organicMatch({ source, medium, platform, sourceType, referrerUrl, internalHosts: hosts });
  if (organic) return { group: organic.group, key: organic.key, name: organic.name, paid: false };

  // ⑥ AI 搜索导流
  const ai = aiMatch({ source, platform, referrerUrl });
  if (ai) return { group: "ai", key: ai.key, name: ai.name, paid: false };

  // ⑦ 待确定：保留原始来源名，便于排查命名问题
  const raw = String(source || platform || hostOf(referrerUrl) || visitSource || "").trim();
  const display = !raw || squash(raw) === "unknown" ? "未归因" : raw;
  return { group: "unknown", key: `unknown:${squash(raw) || "empty"}`, name: display, paid: false };
}

function emptyRow(classified) {
  return {
    key: classified.key,
    group: classified.group,
    groupName: GROUPS[classified.group].name,
    name: classified.name,
    paid: classified.paid,
    sessions: 0,
    orders: 0,
    sales: 0,
  };
}

// 把 sessions 与订单归因合并：先按明细渠道聚合，再汇总成五个分组。
export function mergeChannels({ sessionRows, orderRows }) {
  const details = new Map();
  let paidSessions = 0;

  const ensure = (classified) => {
    if (!details.has(classified.key)) details.set(classified.key, emptyRow(classified));
    const row = details.get(classified.key);
    if (classified.paid) row.paid = true;
    return row;
  };

  for (const row of sessionRows) {
    const classified = classifyChannel({ source: row.source, medium: row.medium, platform: row.platform, campaign: row.campaign });
    ensure(classified).sessions += row.sessions;
  }

  for (const row of orderRows) {
    const classified = classifyChannel({
      source: row.source,
      medium: row.medium,
      sourceType: row.sourceType,
      campaign: row.campaign,
      referrerUrl: row.referrerUrl,
      visitSource: row.visitSource,
      internalHosts: row.internalHosts,
    });
    const target = ensure(classified);
    target.orders += row.orders;
    target.sales += row.sales;
  }

  const detailList = [...details.values()]
    .map((row) => ({ ...row, cvr: row.sessions > 0 ? row.orders / row.sessions : null }))
    .sort((a, b) => b.sales - a.sales || b.orders - a.orders || b.sessions - a.sessions || a.name.localeCompare(b.name));

  const groups = GROUP_ORDER.map((group) => {
    const rows = detailList.filter((row) => row.group === group);
    const sessions = rows.reduce((sum, row) => sum + row.sessions, 0);
    const orders = rows.reduce((sum, row) => sum + row.orders, 0);
    const sales = rows.reduce((sum, row) => sum + row.sales, 0);
    return {
      key: group,
      group,
      name: GROUPS[group].name,
      sessions,
      orders,
      sales,
      cvr: sessions > 0 ? orders / sessions : null,
      details: rows,
    };
  }).filter((row) => row.sessions > 0 || row.orders > 0);

  paidSessions = groups.find((row) => row.group === "ad")?.sessions || 0;

  const totals = detailList.reduce((sum, row) => ({
    sessions: sum.sessions + row.sessions,
    orders: sum.orders + row.orders,
    sales: sum.sales + row.sales,
  }), { sessions: 0, orders: 0, sales: 0 });

  const pending = groups.find((row) => row.group === "unknown") || { sessions: 0, sales: 0, orders: 0 };

  return {
    groups,
    details: detailList,
    totals,
    paidSessions,
    pendingSessions: pending.sessions,
    pendingSales: pending.sales,
  };
}
