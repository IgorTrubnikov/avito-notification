import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chromium } from 'playwright-core';

test('persistent Chromium profile retains login cookies after restart', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'avito-profile-'));
  const options = { executablePath: process.env.CHROMIUM_PATH || '/usr/bin/chromium', headless: true };
  let context;
  try {
    context = await chromium.launchPersistentContext(dir, options);
    await context.addCookies([{ name: 'test-session', value: 'persisted', domain: 'www.avito.ru', path: '/', expires: Math.floor(Date.now() / 1000) + 3600, secure: true }]);
    await context.close();
    context = await chromium.launchPersistentContext(dir, options);
    const cookie = (await context.cookies('https://www.avito.ru')).find(c => c.name === 'test-session');
    assert.equal(cookie?.value, 'persisted');
  } finally { await context?.close(); rmSync(dir, { recursive: true }); }
});
