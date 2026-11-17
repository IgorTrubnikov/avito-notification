import { ProxyAgent, fetch as proxyFetch } from 'undici';

// An explicit dispatcher scopes the proxy to Telegram only. Never change the
// global dispatcher or Chromium's proxy settings.
export function telegramTransport(proxyUrl = '') {
  if (!proxyUrl.trim()) return { fetch: globalThis.fetch, close: async () => {} };
  let agent;
  try {
    const parsed = new URL(proxyUrl.trim());
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname || parsed.hash || parsed.search || parsed.pathname !== '/') {
      throw new Error('Invalid proxy');
    }
    agent = new ProxyAgent({ uri: parsed.href, proxyTunnel: true });
  } catch {
    // URL parser and ProxyAgent errors can include credentials. Do not rethrow.
    throw new Error('TELEGRAM_PROXY_URL must be http://user:password@host:port or https://host:port');
  }
  return {
    fetch: (url, options) => proxyFetch(url, { ...options, dispatcher: agent }),
    close: () => agent.close()
  };
}
