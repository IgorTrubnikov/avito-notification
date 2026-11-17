import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as sleep } from 'node:timers/promises';
import { chromium } from 'playwright-core';
import { observeNativeUnread } from '../src/native-unread.js';
import { unreadCount, MESSENGER } from '../src/avito.js';

test('native observer separates browser RPC from probes and logs no response secrets', async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium' });
  try {
    const page = await browser.newPage();
    const logs = [];
    let rpcCount = 0;
    let status = 200;
    await page.route('https://www.avito.ru/**', async route => {
      if (route.request().url().includes('/socket/fallback')) {
        rpcCount++;
        const body = route.request().postDataJSON();
        await route.fulfill({ status, json: { id: body.id, result: { unreadChats: 2 }, secret: 'DO-NOT-LOG', message: 'private text' } });
      } else await route.fulfill({ contentType: 'text/html', body: '<html>Messenger</html>' });
    });
    const observer = observeNativeUnread(page, { log: line => logs.push(line) });
    await page.goto(MESSENGER);
    assert.equal(await unreadCount(page, { markProbe: observer.markProbe }), 2);
    // Explicit native-style call, independent of the notifier's probe.
    const nativeCall = id => page.evaluate(async id => {
      await fetch('/web/1/socket/fallback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id, method: 'messenger.getUnreadCount.v1' }) });
    }, id);
    await nativeCall(1);
    await sleep(100);
    assert.deepEqual(logs, ['Native unread RPC: OK; unread chats: 2']);
    status = 403;
    await nativeCall(2);
    await sleep(100);
    assert.equal(logs.at(-1), 'Native unread RPC: HTTP 403');
    assert.equal(logs.some(line => /DO-NOT-LOG|private text/.test(line)), false);
    observer.dispose();
    await nativeCall(3);
    await sleep(100);
    assert.equal(logs.length, 2);
    assert.equal(rpcCount, 4, 'observer creates no additional requests');
  } finally { await browser.close(); }
});
