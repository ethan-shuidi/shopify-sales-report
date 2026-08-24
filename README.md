# Shopify 销售与发货播报

通过 Shopify Admin GraphQL API 直接查询多个店铺的订单、商品数量、退款和履约状态，并通过各店铺对应的飞书群机器人发送日报、周报或月报。不使用 Shopify Flow，也不需要数据库。新版 Dev Dashboard App 使用 Client Credentials Grant 自动获取 24 小时有效的 Admin API token。

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

工作流已拆分为日报、周报、月报三个独立任务，分别在每天 09:17、每周一 09:17 和每月 1 日 09:17（北京时间）运行，避免整点高峰造成调度延迟。

US 与 JP 报告使用独立 workflow：

- US：`shopify-daily.yml`、`shopify-weekly.yml`、`shopify-monthly.yml`
- JP：`shopify-daily-jp.yml`、`shopify-weekly-jp.yml`、`shopify-monthly-jp.yml`

通过 `MARKET_FILTER` 选择店铺市场；同一份 `SHOPIFY_STORES_JSON` 可以包含多个店铺，但每个 workflow 只播报对应市场。cron-job.org 需要分别调用 US 和 JP 的 workflow，并在各自需要的本地时间触发。

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
    "name": "第二店铺",
    "market": "JP",
    "store": "second-store.myshopify.com",
    "clientId": "第二个 App Client ID",
    "clientSecret": "第二个 App Client Secret",
    "feishuWebhookUrl": "https://open.feishu.cn/open-apis/bot/v2/hook/yyy",
    "timezone": "Asia/Shanghai",
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
