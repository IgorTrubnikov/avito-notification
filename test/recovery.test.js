import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { openMessenger, unreadCount, MESSENGER } from '../src/avito.js';
import { Store } from '../src/store.js';
import { deliver } from '../src/telegram.js';

test('reopening messenger recovers a failed RPC without losing notification baseline', async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium' });
  const store = new Store(':memory:');
  try {
    const page = await browser.newPage();
    let navigations = 0;
    let pageStatus = 200;
    await page.route('https://www.avito.ru/**', async route => {
      if (route.request().url() === MESSENGER) {
        navigations++;
        await route.fulfill({ status: pageStatus, contentType: 'text/html', body: '<html>Messenger</html>' });
      } else if (route.request().url().includes('/socket/fallback')) {
        await route.fulfill(navigations < 2 ? { status: 403, body: 'Forbidden' } : { json: { result: { unreadChats: 1 } } });
      } else await route.abort();
    });
    store.observe(0);
    await openMessenger(page);
    await assert.rejects(unreadCount(page), /HTTP 403/);
    assert.equal(store.get('unread'), '0');
    assert.equal(store.pending().length, 0);
    await openMessenger(page);
    store.observe(await unreadCount(page));
    const sent = [];
    await deliver(store, async text => sent.push(text));
    assert.equal(sent.length, 1);
    assert.match(sent[0], /0 → 1/);
    pageStatus = 403;
    await assert.rejects(openMessenger(page), /messenger page HTTP 403/);
  } finally { store.close(); await browser.close(); }
});
