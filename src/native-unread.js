const METHOD = 'messenger.getUnreadCount.v1';

// Observe only the known HTTP fallback RPC. Do not log bodies, IDs, headers,
// credentials or chats, and do not change/issue any requests here.
export function observeNativeUnread(page, { log = () => {} } = {}) {
  const probes = new Set();
  let enabled = true;
  const markProbe = id => {
    probes.add(id);
    if (probes.size > 128) probes.delete(probes.values().next().value);
  };
  const listener = async response => {
    try {
      const url = new URL(response.url());
      if (url.origin !== 'https://www.avito.ru' || url.pathname !== '/web/1/socket/fallback') return;
      const body = response.request().postDataJSON();
      const requests = Array.isArray(body) ? body : [body];
      const native = requests.filter(r => r?.method === METHOD && !probes.has(r.id));
      if (!native.length || !enabled) return;
      if (!response.ok()) {
        log(`Native unread RPC: HTTP ${response.status()}`);
        return;
      }
      let parsed;
      try { parsed = await response.json(); }
      catch { if (enabled) log('Native unread RPC: response is not JSON'); return; }
      if (!enabled) return;
      const items = Array.isArray(parsed) ? parsed : [parsed];
      const item = items.find(r => {
        const matches = native.some(n => n.id === r?.id) || (requests.length === 1 && items.length === 1 && r?.id === undefined);
        return matches && Number.isSafeInteger(r?.result?.unreadChats) && r.result.unreadChats >= 0;
      });
      log(item ? `Native unread RPC: OK; unread chats: ${item.result.unreadChats}` : 'Native unread RPC: no usable count');
    } catch { /* Non-JSON requests, closed pages, or unrelated traffic. */ }
  };
  page.on('response', listener);
  return { markProbe, dispose: () => { enabled = false; page.off('response', listener); probes.clear(); } };
}
