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
    let rpcFailure = false;
    await page.route('https://www.avito.ru/**', async route => {
      if (route.request().url() === MESSENGER) {
        navigations++;
        await route.fulfill({ status: pageStatus, contentType: 'text/html', body: '<html>Messenger</html>' });
      } else if (route.request().url().includes('/socket/fallback')) {
        await route.fulfill(navigations < 2 || rpcFailure ? { status: 403, body: 'Forbidden' } : { json: { result: { unreadChats: 1 } } });
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
    const logs = [];
    assert.equal(await openMessenger(page, { log: text => logs.push(text) }), 403);
    assert.match(logs[0], /waiting 5s/);
    // A 403 document must not prevent a valid RPC from being checked.
    assert.equal(await unreadCount(page), 1);
    rpcFailure = true;
    await assert.rejects(unreadCount(page), /HTTP 403/);
    assert.equal(store.get('unread'), '1');
    assert.equal(store.pending().length, 0);
    pageStatus = 500;
    await assert.rejects(openMessenger(page), /messenger page HTTP 500/);
  } finally { store.close(); await browser.close(); }
});


test('stale #block does not hide valid RPC or suppress actual RPC errors', async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium' });
  try {
    const page = await browser.newPage();
    let rpcRequests = 0;
    let rpcFailure = false;
    await page.route('https://www.avito.ru/**', async route => {
      if (route.request().url().includes('/socket/fallback')) {
        rpcRequests++;
        await route.fulfill(rpcFailure ? { status: 403, body: 'Forbidden' } : { json: { result: { unreadChats: 0 } } });
      } else await route.fulfill({ contentType: 'text/html', body: '<html>Messenger</html>' });
    });
    await openMessenger(page);
    await page.evaluate(() => { location.hash = 'block'; });
    await page.waitForURL(url => url.hash === '#block');
    const logs = [];
    assert.equal(await unreadCount(page, { log: text => logs.push(text) }), 0);
    assert.match(logs[0], /validating unread count/);
    assert.equal(rpcRequests, 1);
    rpcFailure = true;
    await assert.rejects(unreadCount(page), /HTTP 403/);
    assert.equal(rpcRequests, 2);
    rpcFailure = false;
    await openMessenger(page);
    assert.equal(page.url(), MESSENGER);
    assert.equal(await unreadCount(page), 0);
    assert.equal(rpcRequests, 3);
  } finally { await browser.close(); }
});


test('403 document can finish a client-side transition before the RPC check', async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium' });
  try {
    const page = await browser.newPage();
    await page.route('https://www.avito.ru/**', route => route.request().url().includes('/socket/fallback')
      ? route.fulfill({ json: { result: { unreadChats: 2 } } })
      : route.fulfill({ status: 403, contentType: 'text/html', body: `<script>
          location.hash = 'block';
          setTimeout(() => { location.hash = ''; document.body.textContent = 'Messages'; }, 100);
        </script>` }));
    assert.equal(await openMessenger(page), 403);
    assert.equal(new URL(page.url()).hash, '');
    assert.equal(await unreadCount(page), 2);
    // A stale fragment is also harmless after a 403 document if RPC succeeds.
    await page.evaluate(() => { location.hash = 'block'; });
    await page.waitForURL(url => url.hash === '#block');
    assert.equal(await unreadCount(page), 2);
  } finally { await browser.close(); }
});
