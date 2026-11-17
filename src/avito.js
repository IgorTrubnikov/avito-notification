export const MESSENGER = 'https://www.avito.ru/profile/messenger';

export async function unreadCount(page, { log = () => {}, markProbe = () => {} } = {}) {
  const current = new URL(page.url());
  if (current.origin !== 'https://www.avito.ru') throw new Error('Avito: unexpected page origin; check login');
  if (current.hash === '#block') log('Messenger URL contains #block; validating unread count instead of assuming failure');
  if (await page.getByRole('heading', { name: 'Страница не загрузилась из-за проблем с IP', exact: true }).isVisible()) {
    const error = new Error('Avito: visible IP error page; unread count is not trusted');
    error.status = 403;
    throw error;
  }
  const probeId = Date.now();
  markProbe(probeId);
  const result = await page.evaluate(async rpcId => {
    const response = await fetch('/web/1/socket/fallback', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: rpcId, method: 'messenger.getUnreadCount.v1', params: {} }),
      signal: AbortSignal.timeout(20000)
    });
    // Never return response bodies to logs: they may contain private messages.
    if (!response.ok) return { error: `HTTP ${response.status}`, status: response.status };
    let parsed;
    try { parsed = await response.json(); } catch { return { error: 'response is not JSON; check login/captcha' }; }
    const items = Array.isArray(parsed) ? parsed : [parsed];
    const item = items.find(x => Number.isSafeInteger(x?.result?.unreadChats) && x.result.unreadChats >= 0);
    return item ? { count: item.result.unreadChats } : { error: 'unreadChats missing; check login or protocol change' };
  }, probeId);
  if (result.error) {
    const error = new Error(`Avito: ${result.error}`);
    error.status = result.status;
    throw error;
  }
  return result.count;
}

export async function openMessenger(page, { log = () => {} } = {}) {
  // Open only the chat list, never an individual conversation. Loading the
  // messenger lets the site's own scripts reinitialise its session/connections.
  const response = await page.goto(MESSENGER, { waitUntil: 'load', timeout: 45000 });
  const status = response?.status() ?? null;
  if (status === 403) {
    // The document may contain working application scripts despite its status.
    // Navigation alone never establishes health: the caller must validate RPC.
    log('Messenger navigation HTTP 403; waiting 5s for page scripts before checking unread count');
    await page.waitForTimeout(5000);
  } else if (response && !response.ok()) {
    const error = new Error(`Avito: messenger page HTTP ${status}`);
    error.status = status;
    throw error;
  }
  return status;
}
