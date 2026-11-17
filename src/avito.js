export const MESSENGER = 'https://www.avito.ru/profile/messenger';

export async function unreadCount(page) {
  if (new URL(page.url()).origin !== 'https://www.avito.ru') throw new Error('Avito: unexpected page origin; check login');
  const result = await page.evaluate(async () => {
    const response = await fetch('/web/1/socket/fallback', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: Date.now(), method: 'messenger.getUnreadCount.v1', params: {} }),
      signal: AbortSignal.timeout(20000)
    });
    // Never return response bodies to logs: they may contain private messages.
    if (!response.ok) return { error: `HTTP ${response.status}` };
    let parsed;
    try { parsed = await response.json(); } catch { return { error: 'response is not JSON; check login/captcha' }; }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    const item = items.find(x => Number.isSafeInteger(x?.result?.unreadChats) && x.result.unreadChats >= 0);
    return item ? { count: item.result.unreadChats } : { error: 'unreadChats missing; check login or protocol change' };
  });
  if (result.error) throw new Error(`Avito: ${result.error}`);
  return result.count;
}
