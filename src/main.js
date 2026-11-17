import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { Store } from './store.js';
import { sendTelegram, deliver } from './telegram.js';
import { telegramTransport } from './telegram-proxy.js';
import { openMessenger } from './avito.js';
import { freshNative, readNativeCount } from './native-source.js';
import { recoverMessengerTab, retryDelay } from './recovery.js';
import { observeNativeUnread } from './native-unread.js';

process.umask(0o077);
const mode = process.argv[2] || 'monitor';
const data = process.env.DATA_DIR || '/data';
const token = process.env.TELEGRAM_BOT_TOKEN;
const chat = process.env.TELEGRAM_CHAT_ID;
const seconds = Number(process.env.POLL_SECONDS || 120);
const monitorHeadless = process.env.MONITOR_HEADLESS || 'true';
if (!['true', 'false'].includes(monitorHeadless)) throw new Error('MONITOR_HEADLESS must be true or false');
if (!['monitor', 'login', 'telegram-test'].includes(mode)) throw new Error('Unknown command');
if (mode !== 'login' && (!token || !chat)) throw new Error('Set TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env');
if (!Number.isFinite(seconds) || seconds < 30 || seconds > 3600) throw new Error('POLL_SECONDS must be 30..3600');
const telegram = telegramTransport(mode === 'login' ? '' : (process.env.TELEGRAM_PROXY_URL || ''));
const send = text => sendTelegram(token, chat, text, telegram.fetch);
const log = text => console.log(`${new Date().toISOString()} ${text}`);
if (mode === 'telegram-test') {
  try {
    await send('✅ Проверка связи: сервер → Telegram работает.');
    log('Telegram test delivered');
  } finally { await telegram.close(); }
} else {
  await mkdir(data, { recursive: true, mode: 0o700 });
  const store = new Store(join(data, 'state.sqlite'));
  let stopping = false;
  let context;
  let nativeUnread;
  const controller = new AbortController();
  for (const signal of ['SIGTERM', 'SIGINT']) process.on(signal, () => {
    stopping = true;
    controller.abort();
    context?.close().catch(() => {});
  });
  try {
    context = await chromium.launchPersistentContext(join(data, 'profile'), {
      executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium',
      headless: mode !== 'login' && monitorHeadless === 'true', viewport: { width: 1280, height: 800 },
      args: ['--disable-dev-shm-usage'], timeout: 60000
    });
    const page = context.pages()[0] || await context.newPage();
    for (const extra of context.pages().filter(p => p !== page)) await extra.close();
    context.setDefaultTimeout(25000);
    nativeUnread = observeNativeUnread(page, { log });
    log('Native unread HTTP RPC observation enabled');
    try {
      await openMessenger(page, { log });
    } catch (error) {
      log(mode === 'login'
        ? 'Initial navigation failed. Use the remote browser to check network and open Avito manually.'
        : 'Initial navigation failed; monitor will retry and report a prolonged outage.');
    }
    if (mode === 'login') {
      log('Complete login in the remote browser, then stop the login service. Profile is saved automatically.');
      while (!stopping) await sleep(1000, undefined, { signal: controller.signal }).catch(() => {});
    } else {
      log('Monitor started: native unread responses only; no notifier RPC probes');
      log(`Chromium mode: ${monitorHeadless === 'true' ? 'headless' : 'graphical; remote display available'}`);
      let failures = 0;
      let recoveryNeeded = false;
      let failureStart = 0;
      let delay = seconds * 1000;
      let handledRevision = 0;
      while (!stopping) {
        try {
          if (page.isClosed()) throw new Error('Browser page closed');
          const before = nativeUnread.snapshot();
          let after = -1;
          if (!freshNative(before, seconds * 1000) && (recoveryNeeded || before.kind === 'count')) {
            after = before.revision;
            await recoverMessengerTab(page, { log });
            recoveryNeeded = false;
          }
          const sample = await readNativeCount(nativeUnread, {
            maxAgeMs: seconds * 1000, after, signal: controller.signal
          });
          if (store.get('unhealthy') === '1') {
            store.enqueue('✅ Проверка Авито снова работает.');
            store.set('unhealthy', '0');
          }
          recoveryNeeded = false;
          failures = 0;
          failureStart = 0;
          delay = seconds * 1000;
          await writeFile(join(data, 'health.json'), JSON.stringify({ lastSuccess: sample.at, unreadChats: sample.count, source: 'native' }));
          if (sample.revision !== handledRevision) {
            log(`Native count accepted; unread chats: ${sample.count}; page availability not asserted`);
            handledRevision = sample.revision;
          }
          delay = Math.max(1, seconds * 1000 - (Date.now() - sample.at));
        } catch (error) {
          if (stopping) break;
          if (page.isClosed()) throw new Error('Browser closed; restarting service is required');
          if (error.status === undefined && await page.getByRole('heading', { name: 'Страница не загрузилась из-за проблем с IP', exact: true }).isVisible().catch(() => false)) error.status = 403;
          failures++;
          recoveryNeeded = true;
          failureStart ||= Date.now();
          log(error.message.startsWith('Avito:') ? error.message : 'Avito check failed; browser/network unavailable');
          // Temporary network errors should not spam Telegram or trigger login claims.
          if (Date.now() - failureStart >= 5 * 60000 && store.get('unhealthy') !== '1') {
            store.enqueue('⚠️ Более 5 минут не удаётся проверить Авито. Возможны проблемы сети, проверка Авито или истёкшая сессия. Проверьте логи и при необходимости войдите заново.');
            store.set('unhealthy', '1');
          }
          delay = retryDelay(error, failures, seconds * 1000);

        }
        nativeUnread.consumeCounts(count => store.observe(count));
        const waitRevision = nativeUnread.snapshot().revision;
        try { await deliver(store, send); }
        catch (error) { log(error.message); delay = Math.max(delay, (error.retryAfter || 0) * 1000); }
        if (failures) log(`Next Avito check in ${Math.ceil(delay / 1000)}s; messenger will recover in the current tab before retry`);
        await nativeUnread.waitForUpdate(delay, waitRevision, { countsOnly: failures > 0, signal: controller.signal });
      }
    }
  } finally {
    nativeUnread?.dispose();
    await context?.close().catch(() => {});
    store.close();
    await telegram.close();
  }
}
