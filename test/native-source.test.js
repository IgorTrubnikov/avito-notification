import test from 'node:test';
import assert from 'node:assert/strict';
import { chromium } from 'playwright-core';
import { observeNativeUnread } from '../src/native-unread.js';
import { readNativeCount } from '../src/native-source.js';
import { Store } from '../src/store.js';
import { MESSENGER } from '../src/avito.js';

test('native response queue preserves a transient unread increase without bot probes', async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium' });
  const store = new Store(':memory:');
  try {
    const page = await browser.newPage();
    let value = 0;
    let requests = 0;
    let status = 200;
    await page.route('https://www.avito.ru/**', route => {
      if (route.request().url().includes('/socket/fallback')) {
        requests++;
        return route.fulfill({ status, json: { result: { unreadChats: value } } });
      }
      return route.fulfill({ contentType: 'text/html; charset=utf-8', body: '<h1>Страница не загрузилась из-за проблем с IP</h1>' });
    });
    const observer = observeNativeUnread(page);
    await page.goto(MESSENGER);
    for (const count of [0, 1, 0]) {
      value = count;
      const before = observer.snapshot().revision;
      await page.evaluate(() => fetch('/web/1/socket/fallback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'messenger.getUnreadCount.v1', params: {} }) }).then(r => r.json()));
      await observer.waitForUpdate(1000, before);
    }
    const sample = await readNativeCount(observer, { maxAgeMs: 120000 });
    assert.equal(sample.count, 0);
    observer.consumeCounts(count => store.observe(count));
    assert.equal(store.pending().length, 1, 'a short-lived unread increase is not overwritten by the last zero');
    observer.consumeCounts(() => assert.fail('a native response may only be consumed once'));
    assert.equal(requests, 3, 'no notifier probe was added');
    status = 403;
    const before = observer.snapshot().revision;
    await page.evaluate(() => fetch('/web/1/socket/fallback', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ method: 'messenger.getUnreadCount.v1' }) }));
    await observer.waitForUpdate(1000, before);
    await assert.rejects(readNativeCount(observer, { maxAgeMs: 120000 }), error => error.status === 403);
    observer.dispose();
  } finally { store.close(); await browser.close(); }
});

test('cached native count cannot establish fresh success after expiry or page recovery', async () => {
  const old = { kind: 'count', count: 0, at: Date.now() - 130000, revision: 3 };
  const observer = { snapshot: () => old, waitForUpdate: async () => null };
  await assert.rejects(readNativeCount(observer, { maxAgeMs: 120000 }), /missing or stale/);
  old.at = Date.now();
  await assert.rejects(readNativeCount(observer, { maxAgeMs: 120000, after: 3 }), /missing or stale/);
  assert.equal((await readNativeCount(observer, { maxAgeMs: 120000 })).count, 0);
});

test('during backoff errors do not postpone recovery while a fresh count wakes it', async () => {
  const { EventEmitter } = await import('node:events');
  const page = new EventEmitter();
  const observer = observeNativeUnread(page);
  const response = (status, count) => ({
    url: () => MESSENGER.replace('/profile/messenger', '/web/1/socket/fallback'),
    request: () => ({ postDataJSON: () => ({ id: 1, method: 'messenger.getUnreadCount.v1' }) }),
    ok: () => status === 200, status: () => status,
    json: async () => ({ id: 1, result: { unreadChats: count } })
  });
  let resumed = false;
  const pending = observer.waitForUpdate(1000, 0, { countsOnly: true }).then(s => { resumed = true; return s; });
  page.emit('response', response(403));
  await Promise.resolve();
  assert.equal(resumed, false);
  page.emit('response', response(200, 1));
  assert.equal((await pending).count, 1);
  const controller = new AbortController();
  const aborted = observer.waitForUpdate(1000, observer.snapshot().revision, { signal: controller.signal });
  controller.abort();
  assert.equal(await aborted, null);
  observer.dispose();
});
