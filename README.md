# Shopify 销售与发货播报

通过 Shopify Admin GraphQL API 直接查询订单、商品数量、退款和履约状态，并通过飞书群机器人发送日报、周报或月报。不使用 Shopify Flow，也不需要数据库。

## 本地运行

要求 Node.js 20+。

```bash
cp .env.example .env
# 编辑 .env 填入 Shopify Token、店铺域名和飞书 Webhook
npm run check
REPORT_TYPE=daily npm run report
```

`REPORT_TYPE` 可选：`daily`、`weekly`、`monthly`。

## GitHub Actions 配置

在仓库 Settings → Secrets and variables → Actions 中添加：

```text
SHOPIFY_STORE
SHOPIFY_ACCESS_TOKEN
FEISHU_WEBHOOK_URL
SHOPIFY_API_VERSION       # 可选，默认 2026-01
SHOPIFY_TIMEZONE          # 可选，默认 America/Los_Angeles
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
