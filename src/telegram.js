export async function sendTelegram(token, chatId, text, fetcher = fetch) {
  // Do not log request URLs: the Telegram token is part of the path.
  let response;
  try {
    response = await fetcher(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, link_preview_options: { is_disabled: true } }),
      signal: AbortSignal.timeout(15000)
    });
  } catch { throw new Error('Telegram: network error or timeout'); }
  let body;
  try { body = await response.json(); } catch { throw new Error(`Telegram: invalid response (HTTP ${response.status})`); }
  if (!response.ok || body.ok !== true) {
    const error = new Error(`Telegram: delivery failed (HTTP ${response.status})`);
    error.retryAfter = Number(body.parameters?.retry_after) || 0;
    throw error;
  }
}

export async function deliver(store, send) {
  for (const item of store.pending()) {
    await send(item.text);
    store.sent(item.id);
  }
}
