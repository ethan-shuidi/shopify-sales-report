# Shopify 销售与发货播报

通过 Shopify Admin GraphQL API 直接查询多个店铺的订单、商品数量、退款和履约状态，并通过各店铺对应的飞书群机器人发送日报、周报或月报。不使用 Shopify Flow，也不需要数据库。新版 Dev Dashboard App 使用 Client Credentials Grant 自动获取 24 小时有效的 Admin API token。

## 两个版本

仓库里并存两套播报，代码与 workflow 完全独立，互不影响：

| | v1（原有播报） | v2（销售日播报，新增） |
|---|---|---|
| 入口 | `src/report.mjs` | `src/v2/report.mjs` |
| 内容 | 销售额、销量（台数）、退款、净销售额、SKU×颜色矩阵、日销量、发货状态、订单明细、延保、预售 | 销售额、PCS、订单数、客单价、Sessions、转化率、近 7 日趋势、渠道效率（六分组）、本月经营数据 |
| 数据源 | Shopify Admin GraphQL | Admin GraphQL + ShopifyQL `sessions` + 订单级归因 `customerJourneySummary` |
| 周期 | `REPORT_TYPE=daily/rolling7/weekly/monthly` | `REPORT_DAY=today/yesterday` |
| workflow | `shopify-daily*.yml`、`shopify-weekly*.yml`、`shopify-monthly*.yml` | `shopify-daily-v2.yml` |
| 存储 | 无 | 可选每日快照（`WRITE_SNAPSHOT`） |

```bash
npm run report          # v1，行为与之前完全一致
npm run report:v1       # 同上，显式指定
npm run report:v2       # v2 销售日播报
npm run report:v2:dry   # v2 只打印卡片 JSON，不发飞书（调试用）
```

两套都用同一份 `SHOPIFY_STORES_JSON`，所以新增店铺只需要配一次。

## 从 v1 切换到 v2（不改编排器）

三个市场的日报 workflow（`shopify-daily.yml` / `-jp.yml` / `-eu.yml`）内置了一个开关，用仓库变量控制跑哪一版，**cron-job.org 的调用地址完全不用改**：

| 仓库变量 | 值 | 行为 |
|---|---|---|
| `REPORT_VERSION` | 未设置 / `v1` | 跑 v1：日报 + 近 7 日滚动（原有行为） |
| `REPORT_VERSION` | `v2` | 只跑 v2 销售日播报 |
| `REPORT_DAY` | 未设置 | v2 默认 `yesterday`（播报完整前一天） |

切换步骤：

1. 把代码推到 `main`
2. 仓库 **Settings → Secrets and variables → Actions → Variables** 标签页，新建变量：
   - `REPORT_VERSION` = `v2`
   - 可选：`REPORT_DAY` = `yesterday`（默认已是）或 `today`
3. 不需要动 cron-job.org——URL 和请求体都保持原样

回滚只需把 `REPORT_VERSION` 改成 `v1` 或直接删掉这个变量。

**切换前先验证**：用 `workflow_dispatch` 手动触发一次，勾选 `dry_run` 看日志里的卡片 JSON，或在本地跑 `npm run report:v2:dry`。

切换后需要注意：

- v2 每次只发 **1 条**消息；v1 每天发「日报 + 近 7 日滚动」**2 条**
- 周报（`shopify-weekly*.yml`）和月报（`shopify-monthly*.yml`）没有 v2 版本，继续走 v1
- 切换后每次运行会额外上传一个 `snapshots/` 产物（保留 30 天）

## 本地运行

要求 Node.js 22+。

```bash
cp .env.example .env
# 编辑 .env 填入多店铺 JSON 配置和飞书 Webhook
npm run check
REPORT_TYPE=daily npm run report
```

`REPORT_TYPE` 可选：`daily`、`rolling7`、`weekly`、`monthly`。

每日 workflow 会先发送昨天的日报，再发送最近 7 个完整自然日的滚动报告。滚动报告会对比前一个连续 7 日周期，不包含订单明细。

## GitHub Actions 配置

在仓库 Settings → Secrets and variables → Actions 中添加：

```text
SHOPIFY_STORES_JSON       # 必填，多店铺 JSON 数组
SHOPIFY_API_VERSION       # 可选，作为每店铺的默认值
SHOPIFY_TIMEZONE          # 可选，作为每店铺的默认值
```

工作流按日报、周报、月报拆分；当前日报任务会连续发送日报和近 7 日滚动报告，周报可按需要停用，月报单独触发。

US、JP 与 EU 报告使用独立 workflow：

- US：`shopify-daily.yml`、`shopify-weekly.yml`、`shopify-monthly.yml`
- JP：`shopify-daily-jp.yml`、`shopify-weekly-jp.yml`、`shopify-monthly-jp.yml`
- EU：`shopify-daily-eu.yml`、`shopify-monthly-eu.yml`

通过 `MARKET_FILTER` 选择店铺市场；同一份 `SHOPIFY_STORES_JSON` 可以包含多个店铺，但每个 workflow 只播报对应市场。日报 workflow 会发送日报和近 7 日滚动报告。cron-job.org 需要分别调用各市场的日报和月报 workflow，并按各店铺需要的本地时间触发。

## 权限

报表需要 `read_orders`。订单行中的 `variant.selectedOptions` 用于读取 Shopify 变体的颜色选项，因此还需要 `read_products`；读取较早历史订单可能需要 Shopify 批准 `read_all_orders`。

颜色识别优先使用订单行对应变体的颜色选项（支持 `Color`、`Colour`、`颜色`、`色`、`カラー`），再尝试从变体标题识别，最后才使用代码中的 SKU 映射兜底。这样新增店铺或产品时，只要 Shopify 变体正确维护了颜色选项，通常不需要再新增站点专属映射。

## 统计口径

- 统计日期使用 `SHOPIFY_TIMEZONE`。
- 订单按 `createdAt` 归属统计周期。
- 订单查询按 `updated_at`，并向前扩大 3 天，以覆盖退款、取消和发货变化。
- 排除已取消和测试订单。
- 销售额使用订单当前总额，退款金额单独展示，净销售额为两者相减。
- 发货状态按订单的 `displayFulfillmentStatus` 汇总。
- 播报会附带 `SKU | 颜色 | 销量` 汇总，以及 `订单号 | 风险等级 | 发货状态 | 销量` 明细；订单较多时会自动拆成多条飞书消息。
- SKU 销量沿用业务换算：`TN10P011/012/013-2/3/5/10/50/100/300` 按后缀换算台数；黑/银/橙和预售按 SKU/标题规则归类，其余 SKU 标记为“未分类”。
- 颜色来源优先级为：Shopify 变体颜色选项 → 变体标题 → SKU 映射兜底；日本变体标题 `ブラック/シルバー/チェリーレッド` 也会转换为中文颜色。

## 多店铺配置示例

`SHOPIFY_STORES_JSON` 的值是一行 JSON：

```json
[
  {
    "name": "主店铺",
    "market": "US",
    "store": "bhuvt5-ds.myshopify.com",
    "clientId": "你的 Client ID",
    "clientSecret": "你的 Client Secret",
    "feishuWebhookUrl": "https://open.feishu.cn/open-apis/bot/v2/hook/xxx",
    "timezone": "America/Los_Angeles",
    "apiVersion": "2026-07"
  },
  {
    "name": "Comu JP",
    "market": "JP",
    "store": "second-store.myshopify.com",
    "clientId": "第二个 App Client ID",
    "clientSecret": "第二个 App Client Secret",
    "feishuWebhookUrl": "https://open.feishu.cn/open-apis/bot/v2/hook/yyy",
    "timezone": "Asia/Shanghai",
    "apiVersion": "2026-07"
  },
  {
    "name": "Comu EU",
    "market": "EU",
    "store": "eu-store.myshopify.com",
    "clientId": "EU App Client ID",
    "clientSecret": "EU App Client Secret",
    "feishuWebhookUrl": "https://open.feishu.cn/open-apis/bot/v2/hook/xxx",
    "timezone": "Europe/Berlin",
    "apiVersion": "2026-07"
  }
]
```

程序会逐个店铺执行；某店铺失败时，其余店铺仍会继续，最终 GitHub Actions 会以失败状态结束并显示失败店铺。

## 新版应用认证

每个店铺配置 `clientId` 和 `clientSecret`。任务运行时向该店铺请求：

```text
POST https://{shop}.myshopify.com/admin/oauth/access_token
grant_type=client_credentials
```

Shopify 返回的 Admin API token 有效期为 24 小时，程序会在每次任务运行时自动获取，且不会打印 token。Client Secret 只能放在 GitHub Actions Secret 中。Client Credentials Grant 适用于你们组织开发、并安装在你们拥有的店铺中的应用；如果未来服务外部商户，应改用 OAuth/Token Exchange。

## v2 销售日播报

对应飞书文档《Shopify 飞书销售日播报 Bot》，卡片按文档 §2 分为五个区块：

1. **核心指标**：销售额、销售 PCS（两张主卡）+ 订单数、客单价（两张辅助卡），每项都带较昨日变化
2. **转化率浮动 · 近 7 日趋势**：整体转化率、较昨日百分点变化、今日 Sessions、今日订单、近 7 日销售额，右侧是近 7 日销售额柱状图
3. **渠道效率**：广告 / 红人 / 联盟 / 自然搜索 / 直接访问 / AI 搜索导流 / 其他渠道 / 待确定（进站 / 订单 / CVR / 销售额），明细收进「渠道明细」折叠区；待确定占比 ≥30% 时在标题旁提示
4. **本月经营数据**：订单数、产品销量、退款金额、退款率、净销售额
5. **底部状态**：更新时间、数据来源、拉取状态

### 视觉还原度

卡片视觉按设计稿还原，其中这几项依赖飞书卡片引擎的能力，已实测确认：

| 设计稿元素 | 实现方式 | 状态 |
|---|---|---|
| 大号 KPI 数字 | `markdown` 的 `text_size: "heading"` | ✅ |
| 灰色圆角底板卡片 | `column` 的 `background_style: "grey"` + `padding` | ✅ |
| 涨跌染色箭头 | `<font color='green/red'>↑ 18.4%</font>` | ✅ |
| 近 7 日销售额柱状图 | `chart` 组件 + VChart spec（对象，不是字符串） | ✅ |
| 渠道名下的进度条 | 用 `█` / `░` 字符 + 字色，放在 `data_type: "markdown"` 的表格单元格里 | ✅ 近似 |
| 其他流量结构折叠 | `collapsible_panel` + 头部 `▼ 点击展开` 提示；内部不能放 `table` 组件，改用 **markdown 表格** | ✅ 近似 |
| 卡片级背景、圆角、阴影、徽章胶囊 | 飞书卡片不开放 | ❌ 用字色和分隔线近似 |
| 表格内原生进度条 | 飞书 `table` 无此组件 | ❌ 用字符条替代 |

三个实测踩过的坑（写在这里省得再踩）：

- `column` 没有 `background_color`，只有 `background_style`，传错属性会报 `200621 unknown property`
- `chart_spec` 必须是 **对象**，传 JSON 字符串会报 `chart spec is invalid`
- `table` 不能嵌套在 `collapsible_panel` 里，套一层 `column` 也不行（`type of element is not supported tag: table`）；折叠区改用 markdown 表格语法

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `REPORT_DAY` | `today` | `today` 走文档的"今日"口径（当日未结束时数据为部分日）；`yesterday` 播报完整的前一天 |
| `V2_COLLAPSIBLE` | `true` | "其他流量结构"是否用折叠面板。注意飞书卡片不允许 `table` 嵌套在 `collapsible_panel` 内（会报 `200621`），所以折叠区用文本行展示，表格只在非折叠版里用；被飞书拒绝时会自动降级为普通表格 |
| `DRY_RUN` | `false` | 只打印卡片 JSON，不发送 |
| `WRITE_SNAPSHOT` | `false` | 落盘每日快照到 `SNAPSHOT_DIR`（文档 §8 的最小存储要求） |
| `SNAPSHOT_DIR` | `snapshots` | 快照目录，`snapshots/` 已在 `.gitignore` |

### 指标口径（与 v1 不同，这是有意为之）

| 指标 | v2 口径 |
|---|---|
| 销售额 | 有效订单的 `totalPriceSet`（`before returns`，未扣退款；含运费与税） |
| PCS | 有效订单行项目 `quantity` 之和，**不做台数换算** |
| 订单数 | 排除已取消、测试订单 |
| 客单价 | 净销售额 ÷ 订单数 |
| 退款率 | 退款金额 ÷ 销售额 |
| 净销售额 | 销售额 − 退款金额 |
| 整体转化率 | 优先 ShopifyQL `sessions.conversion_rate`；没有返回值时用 `订单数 ÷ Sessions` 兜底，并在页脚标注"估算" |
| 转化率浮动 | 今日转化率 − 昨日转化率，以百分点（pp）展示 |
| 渠道 CVR | 归因订单数 ÷ 渠道 Sessions；Sessions 为 0 显示 `—` 而不是 0% |

### 渠道归类（七分组）

判定顺序：**①联盟 → ②广告 → ③红人 → ④自然搜索 → ⑤直接访问 → ⑥AI 搜索导流 → ⑦其他渠道 → ⑧待确定**，命中即停。

| 分组 | 判定规则 |
|---|---|
| **广告** | ① channel 命中 `google_ads / meta_ads / microsoft_ads / bing_ads / tiktok_ads`；② channel 以 `_ads` 结尾（你们数据里的 `chatgpt_ads`）；③ 广告平台 + 付费 medium（`cpc / ppc / paid / paid_social / paid_search / display / pmax / cpm / cpa / sem / shopping`） |
| **红人** | `campaign` / channel(`utm_source`) 文本含 `KOL / Creator / Influencer / 红人 / 达人`；或 `utm_medium` 含同类标签。**普通 Instagram / YouTube / 媒体 referrer 不自动归红人** |
| **联盟** | channel（≈`marketing_platform` / `utm_source` / referrer 域名）命中：`affiliate_impact`、`impact`、`impact_ads`、`capitaloneshopping`、`gocertify`、`rakuten`、`promocodes`、`dailypickjournal`、`thevouchercode`、`refermate`、`coupon-pilot` |
| **AI 搜索导流** | platform / source / referrer 命中 `chatgpt`、`openai`、`perplexity`、`copilot`、`gemini`、`claude` |
| **自然搜索** | platform 为 `google / microsoft / bing / brave / duckduckgo / yahoo / ecosia / startpage / qwant / seznam / naver / baidu / yandex / aol`，或订单 `sourceType=SEO`，或 referrer 域名命中搜索引擎 |
| **直接访问** | `platform=direct`、`sourceType=DIRECT`、`source=direct`，或 referrer 指向店铺自己的域名 |
| **其他渠道** | 邮件、社媒（自然）、App / 站内、外部引荐 |
| **待确定** | 以上都未命中：命名不规范、未知 referral、异常媒介、归因数据为空的订单 |

### 订单归因取值顺序

Shopify 的 `customerJourneySummary` 有两段触点，取值顺序直接影响分组结果：

1. 先看 `lastVisit.utmParameters`（末次点击）
2. **末次点击没有 UTM 时，回退到 `firstVisit.utmParameters`**（等价于 last non-direct click）
3. 两者都没有 UTM，才用 `referrerUrl` 域名
4. 再没有，用 `visit.source` 的纯文本名（`Google` / `email` / `direct` / `Instagram` …）
5. 都没有 → 待确定

第 2 步和第 4 步是必须的：Shopify 大量订单的 `lastVisit` 只有 `source=direct` 而没有 UTM，真正的来源留在 `firstVisit` 或 `source` 文本里。实测美国店 11 月 624 单中有 **95 单**是这种情况，修复前全部被算进「待确定」。

**字段映射说明**：文档里的 `channel` 来自 Shopify Attribution 导出，Admin API 拿不到原值，所以用 `marketing_platform` / `utm_source` / referrer 域名近似。实测三个店铺的 channel 实际取值只有 `google`、`meta`、`affiliate_impact`、`chatgpt_ads` 这类，**不存在 `google_ads` / `meta_ads`**，因此广告白名单额外增加了「广告平台 + 付费 medium」这条等价规则，否则广告分组会恒为 0。

### 时区

v2 以**店铺真实时区**（`shop.ianaTimezone`）切日，因为 ShopifyQL 的 `day` 边界就是店铺时区。若 `.env` 里配的 `timezone` 与店铺不一致，会打印告警并按店铺时区计算。当前 JP 店铺实际是 `Asia/Tokyo`，而配置里写的是 `Asia/Hong_Kong`——v1 仍按配置走，v2 会提示这个差异。

### 限流重试

对应文档 §9。`src/lib/shopify.mjs` 对每次 GraphQL / ShopifyQL 请求做统一重试，识别两种限流形态：

| 形态 | 处理 |
|---|---|
| HTTP `429` | 优先用响应头 `Retry-After` 的秒数；没有则指数退避 |
| HTTP `200` + `errors[].extensions.code = "THROTTLED"` | 用响应里的 `extensions.cost.throttleStatus` 计算等待时间：`(requestedQueryCost - currentlyAvailable) / restoreRate` |

等待时间有上限（默认 30s），重试次数默认为 3（即最多 4 次请求）。非限流类错误（字段不存在、权限不足等）**不重试**，避免掩盖真实问题。

| 变量 | 默认 | 说明 |
|---|---|---|
| `SHOPIFY_MAX_RETRIES` | `3` | 最多重试次数 |
| `SHOPIFY_RETRY_BASE_MS` | `1000` | 没有 `Retry-After` / cost 信息时的指数退避基数 |
| `SHOPIFY_MAX_RETRY_WAIT_MS` | `30000` | 单次等待上限 |

发生过重试时，卡片页脚会显示「限流重试 N 次」。回归测试：`npm test`（用假 `fetch` 模拟 THROTTLED / 429，不访问真实 API）。

### 权限

v2 需要 `read_orders`（订单与归因）+ `read_reports`（ShopifyQL）。`read_products` 不是必需。这三个店铺当前已授予 `read_orders, read_products, read_reports`，但 `shopify.app.toml` 只声明了前两个，新增店铺时请以后台实际授予为准。

### 已知限制

- **ROAS 拿不到**：券后 ROI 需要广告花费，Shopify 的 `marketing_engagements` 在三个店铺都为空/0，`shop_campaign_insights` 也没有数据。接入 Meta / Google Ads API 之前该字段只能不展示。
- **`campaign_sales` / `campaign_sessions` 为空**：文档推荐用这两张表做渠道效率，但你们没有接入 Shopify Campaigns，实测返回空。所以 v2 改用 `sessions` + 订单归因的组合。
- **UTM 脏数据**：同一店铺里存在 `KOL`、`Joe_KOL`、`Penny_Zhang_KOL`、`YouTube/KOL`、`Youtube/KOL`、`Paid-social`、`affiliate_Impact` 与 `impact` 等多种写法。v2 已把它们归并成"红人 / 联盟 / 广告"三类，但**红人专属链接的参数不统一时，红人的进站与订单仍然会分散**，需要投放侧统一 UTM 规范。
- **今日口径是部分日**：卡片标题会标注"截至 HH:mm，当日未结束"。如果定时任务在店铺清晨触发而希望播报完整一天，把 `REPORT_DAY` 设为 `yesterday`。

