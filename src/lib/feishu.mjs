// 飞书机器人发卡片。cards 可以是单张卡片，也可以是 [主卡片, 兜底卡片]：
// 当主卡片被飞书判定为结构非法时，自动降级重发兜底卡片。

async function post(webhookUrl, card) {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ msg_type: "interactive", card }),
  });
  const body = await response.json().catch(() => ({}));
  const ok = response.ok && !body.code;
  return { ok, status: response.status, body };
}

export async function sendCard(webhookUrl, cards) {
  const candidates = Array.isArray(cards) ? cards : [cards];
  let lastError;
  for (const [index, card] of candidates.entries()) {
    const { ok, status, body } = await post(webhookUrl, card);
    if (ok) return { sent: true, degraded: index > 0 };
    lastError = new Error(`Feishu webhook error: HTTP ${status} ${JSON.stringify(body)}`);
    // 只有"卡片结构被拒"才降级重试；限流、签名等错误直接失败，避免重复播报。
    const text = JSON.stringify(body || {});
    const schemaIssue = Boolean(body?.code) && /card|content|parse|format|schema|field|卡片|格式|解析|字段|内容/i.test(text);
    if (!schemaIssue) break;
    if (index === 0 && candidates.length > 1) {
      console.warn(`[feishu] 主卡片被拒，降级重发：${text}`);
    }
  }
  throw lastError;
}
