import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';
import { Store } from '../src/store.js';
import { sendTelegram, deliver } from '../src/telegram.js';
import { unreadCount, MESSENGER } from '../src/avito.js';

test('baseline, rises, decreases, invalid data and persistent pending notifications', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'avito-store-'));
  let store = new Store(join(dir, 'state.sqlite'));
  try {
    store.observe(2);
    assert.equal(store.pending().length, 0);
    store.observe(3);
    store.observe(3);
    assert.equal(store.pending().length, 1);
    await assert.rejects(deliver(store, async () => { throw new Error('network'); }));
    assert.equal(store.pending().length, 1);
    store.close();
    store = new Store(join(dir, 'state.sqlite'));
    assert.equal(store.pending().length, 1);
    store.observe(1);
    store.observe(2);
    assert.equal(store.pending().length, 2);
    assert.throws(() => store.observe(-1));
    assert.equal(store.get('unread'), '2');
    const messages = [];
    await deliver(store, async text => messages.push(text));
    assert.equal(messages.length, 2);
    assert.equal(store.pending().length, 0);
    await deliver(store, async () => assert.fail('already delivered'));
  } finally { store.close(); rmSync(dir, { recursive: true }); }
});

test('Telegram payload, API errors, retry_after and token-safe network errors', async () => {
  const token = 'SECRET';
  await sendTelegram(token, '123', 'hello', async (url, options) => {
    assert.equal(url, 'https://api.telegram.org/botSECRET/sendMessage');
    assert.equal(JSON.parse(options.body).chat_id, '123');
    return Response.json({ ok: true });
  });
  await assert.rejects(sendTelegram(token, '123', 'hello', async () => Response.json({ ok: false, parameters: { retry_after: 60 } }, { status: 429 })), error => error.retryAfter === 60);
  await assert.rejects(sendTelegram(token, '123', 'hello', async () => { throw new Error('SECRET'); }), error => !error.message.includes(token));
  await assert.rejects(sendTelegram(token, '123', 'hello', async () => new Response('<html>')), /invalid response/);
});

test('Chromium executes Avito RPC with session cookies; rejects login/protocol failures', async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true });
  try {
    const context = await browser.newContext();
    await context.addCookies([{ name: 'session', value: 'test', domain: 'www.avito.ru', path: '/', secure: true }]);
    let reply = { result: { unreadChats: 4 } };
    let status = 200;
    await context.route('https://www.avito.ru/**', async route => {
      if (route.request().url().includes('/web/1/socket/fallback')) {
        assert.equal(route.request().postDataJSON().method, 'messenger.getUnreadCount.v1');
        assert.match(route.request().headers().cookie, /session=test/);
        await route.fulfill({ status, json: reply });
      } else await route.fulfill({ contentType: 'text/html', body: '<html>mock Avito</html>' });
    });
    const page = await context.newPage();
    await page.goto(MESSENGER);
    assert.equal(await unreadCount(page), 4);
    reply = [{ result: { unreadChats: 0 } }];
    assert.equal(await unreadCount(page), 0);
    reply = { error: { code: 401 } };
    await assert.rejects(unreadCount(page), /unreadChats missing/);
    status = 403;
    await assert.rejects(unreadCount(page), /HTTP 403/);
  } finally { await browser.close(); }
});
