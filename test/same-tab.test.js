import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { recoverMessengerTab, retryDelay } from '../src/recovery.js';
import { openMessenger, unreadCount, MESSENGER } from '../src/avito.js';
import { Store } from '../src/store.js';

test('403 uses a 10 second recovery pause; other errors keep backoff', () => {
  assert.equal(retryDelay({ status: 403 }, 1, 120000), 10000);
  assert.equal(retryDelay({ status: 403 }, 20, 120000), 10000);
  assert.equal(retryDelay({ status: 500 }, 1, 120000), 240000);
  assert.equal(retryDelay(new Error('network'), 2, 120000), 300000);
});

test('removing #block keeps the document, tab and cookies while triggering the page router', async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium' });
  const store = new Store(':memory:');
  try {
    const context = await browser.newContext();
    await context.addCookies([{ name: 'session', value: 'fixture', domain: 'www.avito.ru', path: '/', secure: true }]);
    const page = await context.newPage();
    let documents = 0;
    let rpcRequests = 0;
    await context.route('https://www.avito.ru/**', async route => {
      const request = route.request();
      if (request.url().includes('/socket/fallback')) {
        rpcRequests++;
        assert.match(request.headers().cookie, /session=fixture/);
        await route.fulfill({ json: { result: { unreadChats: 1 } } });
      } else {
        documents++;
        await route.fulfill({ contentType: 'text/html; charset=utf-8', body: `<script>
          window.documentIdentity = 'preserve-me';
          window.addEventListener('hashchange', () => { window.routerHash = location.hash; });
        </script>` });
      }
    });
    store.observe(0);
    await openMessenger(page);
    await page.evaluate(() => { location.hash = 'block'; });
    await page.waitForURL(url => url.hash === '#block');
    await recoverMessengerTab(page);
    assert.equal(page.url(), MESSENGER);
    assert.equal(page.isClosed(), false);
    assert.deepEqual(context.pages(), [page]);
    assert.equal(documents, 1, 'hash recovery does not request another document');
    assert.equal(await page.evaluate(() => window.documentIdentity), 'preserve-me');
    assert.equal(await page.evaluate(() => window.routerHash), '');
    store.observe(await unreadCount(page));
    assert.equal(store.pending().length, 1);
    assert.equal(rpcRequests, 1);
    await recoverMessengerTab(page);
    assert.equal(documents, 2, 'without #block recovery reloads only the same tab');
    assert.deepEqual(context.pages(), [page]);
  } finally { store.close(); await browser.close(); }
});

test('visible IP block cannot be reported healthy merely because RPC could return zero', async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium' });
  try {
    const page = await browser.newPage();
    let rpcRequests = 0;
    await page.route('https://www.avito.ru/**', route => {
      if (route.request().url().includes('/socket/fallback')) {
        rpcRequests++;
        return route.fulfill({ json: { result: { unreadChats: 0 } } });
      }
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<h1>Страница не загрузилась из-за проблем с IP</h1>' });
    });
    await openMessenger(page);
    await assert.rejects(unreadCount(page), error => error.status === 403 && error.message.includes('visible IP error'));
    assert.equal(rpcRequests, 0);
  } finally { await browser.close(); }
});
