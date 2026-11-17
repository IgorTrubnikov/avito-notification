import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { Store } from './store.js';
import { sendTelegram, deliver } from './telegram.js';
import { telegramTransport } from './telegram-proxy.js';
import { unreadCount, openMessenger } from './avito.js';

process.umask(0o077);
const mode = process.argv[2] || 'monitor';
const data = process.env.DATA_DIR || '/data';
const token = process.env.TELEGRAM_BOT_TOKEN;
const chat = process.env.TELEGRAM_CHAT_ID;
const seconds = Number(process.env.POLL_SECONDS || 30);
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
    page.setDefaultTimeout(25000);
    try {
      await openMessenger(page);
    } catch (error) {
      log(mode === 'login'
        ? 'Initial navigation failed. Use the remote browser to check network and open Avito manually.'
        : 'Initial navigation failed; monitor will retry and report a prolonged outage.');
    }
    if (mode === 'login') {
      log('Complete login in the remote browser, then stop the login service. Profile is saved automatically.');
      while (!stopping) await sleep(1000, undefined, { signal: controller.signal }).catch(() => {});
    } else {
      log('Monitor started: unread-chat counter mode (not individual messages)');
      log(`Chromium mode: ${monitorHeadless === 'true' ? 'headless' : 'graphical; remote display available'}`);
      let failures = 0;
      let recoveryNeeded = false;
      let failureStart = 0;
      let delay = seconds * 1000;
      while (!stopping) {
        try {
          if (page.isClosed()) throw new Error('Browser page closed');
          if (recoveryNeeded) {
            log('Reloading messenger before retry');
            await openMessenger(page);
            recoveryNeeded = false;
          }
          const count = await unreadCount(page);
          store.observe(count);
          if (store.get('unhealthy') === '1') {
            store.enqueue('✅ Проверка Авито снова работает.');
            store.set('unhealthy', '0');
          }
          failures = 0;
          failureStart = 0;
          delay = seconds * 1000;
          await writeFile(join(data, 'health.json'), JSON.stringify({ lastSuccess: Date.now(), unreadChats: count }));
          log(`Avito check OK; unread chats: ${count}`);
        } catch (error) {
          if (stopping) break;
          if (page.isClosed()) throw new Error('Browser closed; restarting service is required');
          failures++;
          recoveryNeeded = true;
          failureStart ||= Date.now();
          log(error.message.startsWith('Avito:') ? error.message : 'Avito check failed; browser/network unavailable');
          // Temporary network errors should not spam Telegram or trigger login claims.
          if (Date.now() - failureStart >= 5 * 60000 && store.get('unhealthy') !== '1') {
            store.enqueue('⚠️ Более 5 минут не удаётся проверить Авито. Возможны проблемы сети, проверка Авито или истёкшая сессия. Проверьте логи и при необходимости войдите заново.');
            store.set('unhealthy', '1');
          }
          delay = Math.min(300000, seconds * 1000 * 2 ** Math.min(failures, 4));

        }
        try { await deliver(store, send); }
        catch (error) { log(error.message); delay = Math.max(delay, (error.retryAfter || 0) * 1000); }
        if (failures) log(`Next Avito check in ${Math.ceil(delay / 1000)}s; messenger will reload before retry`);
        await sleep(delay, undefined, { signal: controller.signal }).catch(() => {});
      }
    }
  } finally {
    await context?.close().catch(() => {});
    store.close();
    await telegram.close();
  }
}
