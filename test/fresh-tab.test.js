import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { freshMessengerTab, retryDelay } from '../src/recovery.js';
import { openMessenger, unreadCount, MESSENGER } from '../src/avito.js';
import { Store } from '../src/store.js';

test('403 uses a 10 second recovery pause; other errors keep backoff', () => {
  assert.equal(retryDelay({ status: 403 }, 1, 120000), 10000);
  assert.equal(retryDelay({ status: 403 }, 20, 120000), 10000);
  assert.equal(retryDelay({ status: 500 }, 1, 120000), 240000);
  assert.equal(retryDelay(new Error('network'), 2, 120000), 300000);
});

test('new tab replaces blocked tab, preserves cookies and validates count before notification', async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium' });
  const store = new Store(':memory:');
  try {
    const context = await browser.newContext();
    await context.addCookies([{ name: 'session', value: 'fixture', domain: 'www.avito.ru', path: '/', secure: true }]);
    const old = await context.newPage();
    let oldRequests = 0;
    await context.route('https://www.avito.ru/**', async route => {
      const request = route.request();
      const isOld = request.frame().page() === old;
      if (request.url().includes('/socket/fallback')) {
        assert.match(request.headers().cookie, /session=fixture/);
        if (isOld) oldRequests++;
        await route.fulfill(isOld ? { status: 403, body: 'Forbidden' } : { json: { result: { unreadChats: 1 } } });
      } else {
        if (!isOld) assert.equal(old.isClosed(), true, 'close old tab before navigating the new one');
        assert.equal(request.url(), MESSENGER, 'new page URL has no block fragment');
        await route.fulfill({ contentType: 'text/html', body: '<script>window.pageState="new"</script>' });
      }
    });
    store.observe(0);
    await openMessenger(old);
    await old.evaluate(() => { location.hash = 'block'; window.pageState = 'broken'; });
    const error = await unreadCount(old).catch(e => e);
    assert.equal(error.status, 403);
    assert.equal(retryDelay(error, 1, 120000), 10000);
    assert.equal(store.pending().length, 0);
    const page = await freshMessengerTab(context, old);
    await openMessenger(page);
    assert.equal(page.url(), MESSENGER);
    assert.equal(await page.evaluate(() => window.pageState), 'new');
    assert.equal(context.pages().length, 1);
    store.observe(await unreadCount(page));
    assert.equal(store.pending().length, 1);
    assert.equal(oldRequests, 1);
  } finally { store.close(); await browser.close(); }
});
