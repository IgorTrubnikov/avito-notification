const METHOD = 'messenger.getUnreadCount.v1';

// Observe only the known HTTP fallback RPC. Do not log bodies, IDs, headers,
// credentials or chats, and do not change/issue any requests here.
export function observeNativeUnread(page, { log = () => {} } = {}) {
  const probes = new Set();
  let enabled = true;
  let revision = 0;
  let state = { kind: 'none', revision: 0 };
  const counts = [];
  const waiters = new Set();
  const publish = event => {
    state = { ...event, at: Date.now(), revision: ++revision };
    if (state.kind === 'count') counts.push(state.count);
    for (const wake of [...waiters]) wake(state);
  };
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
        publish({ kind: 'error', status: response.status(), message: `HTTP ${response.status()}` });
        log(`Native unread RPC: HTTP ${response.status()}`);
        return;
      }
      let parsed;
      try { parsed = await response.json(); }
      catch { if (enabled) { publish({ kind: 'error', message: 'response is not JSON' }); log('Native unread RPC: response is not JSON'); } return; }
      if (!enabled) return;
      const items = Array.isArray(parsed) ? parsed : [parsed];
      const item = items.find(r => {
        const matches = native.some(n => n.id === r?.id) || (requests.length === 1 && items.length === 1 && r?.id === undefined);
        return matches && Number.isSafeInteger(r?.result?.unreadChats) && r.result.unreadChats >= 0;
      });
      publish(item ? { kind: 'count', count: item.result.unreadChats } : { kind: 'error', message: 'no usable count' });
      log(item ? `Native unread RPC: OK; unread chats: ${item.result.unreadChats}` : 'Native unread RPC: no usable count');
    } catch { /* Non-JSON requests, closed pages, or unrelated traffic. */ }
  };
  page.on('response', listener);
  return {
    markProbe,
    snapshot: () => ({ ...state }),
    consumeCounts: consume => { while (counts.length) { consume(counts[0]); counts.shift(); } },
    waitForUpdate: (timeout, after, { countsOnly = false, signal } = {}) => new Promise(resolve => {
      let timer;
      const finish = value => { clearTimeout(timer); waiters.delete(wake); signal?.removeEventListener('abort', aborted); resolve(value); };
      const wake = value => { if (value.revision > after && (!countsOnly || value.kind === 'count')) finish(value); };
      const aborted = () => finish(null);
      if (!enabled || signal?.aborted) return resolve(null);
      waiters.add(wake);
      timer = setTimeout(() => finish(null), timeout);
      signal?.addEventListener('abort', aborted, { once: true });
      wake(state);
    }),
    dispose: () => {
      enabled = false;
      page.off('response', listener);
      probes.clear();
      for (const wake of [...waiters]) wake({ kind: 'count', revision: Infinity });
    }
  };
}
