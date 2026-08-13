# Shopify 销售与发货播报

通过 Shopify Admin GraphQL API 直接查询多个店铺的订单、商品数量、退款和履约状态，并通过各店铺对应的飞书群机器人发送日报、周报或月报。不使用 Shopify Flow，也不需要数据库。

## 本地运行

要求 Node.js 20+。

```bash
cp .env.example .env
# 编辑 .env 填入多店铺 JSON 配置和飞书 Webhook
npm run check
REPORT_TYPE=daily npm run report
```

`REPORT_TYPE` 可选：`daily`、`weekly`、`monthly`。

## GitHub Actions 配置

在仓库 Settings → Secrets and variables → Actions 中添加：

```text
SHOPIFY_STORES_JSON       # 必填，多店铺 JSON 数组
SHOPIFY_API_VERSION       # 可选，作为每店铺的默认值
SHOPIFY_TIMEZONE          # 可选，作为每店铺的默认值
```

工作流已拆分为日报、周报、月报三个独立任务，分别在每天、每周一和每月 1 日运行，避免同一天重复发送多个报告。

## 权限

Custom app 至少需要 `read_orders`。读取较早历史订单可能需要 Shopify 批准 `read_all_orders`。

## 统计口径

- 统计日期使用 `SHOPIFY_TIMEZONE`。
- 订单按 `createdAt` 归属统计周期。
- 订单查询按 `updated_at`，并向前扩大 3 天，以覆盖退款、取消和发货变化。
- 排除已取消和测试订单。
- 销售额使用订单当前总额，退款金额单独展示，净销售额为两者相减。
- 发货状态按订单的 `displayFulfillmentStatus` 汇总。

## 多店铺配置示例

`SHOPIFY_STORES_JSON` 的值是一行 JSON：

```json
[
  {
    "name": "主店铺",
    "store": "bhuvt5-ds.myshopify.com",
    "accessToken": "shpat_xxx",
    "feishuWebhookUrl": "https://open.feishu.cn/open-apis/bot/v2/hook/xxx",
    "timezone": "America/Los_Angeles",
    "apiVersion": "2026-01"
  },
  {
    "name": "第二店铺",
    "store": "second-store.myshopify.com",
    "accessToken": "shpat_yyy",
    "feishuWebhookUrl": "https://open.feishu.cn/open-apis/bot/v2/hook/yyy",
    "timezone": "Asia/Shanghai",
    "apiVersion": "2026-01"
  }
]
```

程序会逐个店铺执行；某店铺失败时，其余店铺仍会继续，最终 GitHub Actions 会以失败状态结束并显示失败店铺。
