import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { Store } from './store.js';
import { sendTelegram, deliver } from './telegram.js';
import { telegramTransport } from './telegram-proxy.js';
import { MESSENGER, unreadCount } from './avito.js';

process.umask(0o077);
const mode = process.argv[2] || 'monitor';
const data = process.env.DATA_DIR || '/data';
const token = process.env.TELEGRAM_BOT_TOKEN;
const chat = process.env.TELEGRAM_CHAT_ID;
const seconds = Number(process.env.POLL_SECONDS || 30);
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
      headless: mode !== 'login', viewport: { width: 1280, height: 800 },
      args: ['--disable-dev-shm-usage'], timeout: 60000
    });
    const page = context.pages()[0] || await context.newPage();
    for (const extra of context.pages().filter(p => p !== page)) await extra.close();
    // The RPC works from any Avito page in the extension; avoid opening a chat.
    const startUrl = mode === 'login' ? MESSENGER : 'https://www.avito.ru/';
    page.setDefaultTimeout(25000);
    try {
      await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
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
      let failures = 0;
      let failureStart = 0;
      let delay = seconds * 1000;
      while (!stopping) {
        try {
          if (page.isClosed()) throw new Error('Browser page closed');
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
          failureStart ||= Date.now();
          log(error.message.startsWith('Avito:') ? error.message : 'Avito check failed; browser/network unavailable');
          // Temporary network errors should not spam Telegram or trigger login claims.
          if (Date.now() - failureStart >= 5 * 60000 && store.get('unhealthy') !== '1') {
            store.enqueue('⚠️ Более 5 минут не удаётся проверить Авито. Возможны проблемы сети, проверка Авито или истёкшая сессия. Проверьте логи и при необходимости войдите заново.');
            store.set('unhealthy', '1');
          }
          delay = Math.min(300000, seconds * 1000 * 2 ** Math.min(failures, 4));
          if (failures >= 3) await page.goto(startUrl, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
        }
        try { await deliver(store, send); }
        catch (error) { log(error.message); delay = Math.max(delay, (error.retryAfter || 0) * 1000); }
        await sleep(delay, undefined, { signal: controller.signal }).catch(() => {});
      }
    }
  } finally {
    await context?.close().catch(() => {});
    store.close();
    await telegram.close();
  }
}
