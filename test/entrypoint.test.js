import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, lstatSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), 'avito-entry-'));
  mkdirSync(join(dir, 'profile'));
  mkdirSync(join(dir, 'bin'));
  writeFileSync(join(dir, 'profile', 'Cookies'), 'preserve-session');
  for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
    symlinkSync('/missing-previous-container', join(dir, 'profile', name));
  }
  // Stub only the final Node invocation, while exercising the actual flock and cleanup.
  writeFileSync(join(dir, 'bin', 'node'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const script = join(dir, 'entrypoint.sh');
  writeFileSync(script, readFileSync(new URL('../scripts/entrypoint.sh', import.meta.url), 'utf8').replaceAll('/data', dir));
  return {
    dir,
    run: () => spawnSync('sh', [script, 'monitor'], { encoding: 'utf8', env: { ...process.env, MONITOR_HEADLESS: 'true', PATH: `${dir}/bin:${process.env.PATH}` } }),
    clean: () => rmSync(dir, { recursive: true, force: true })
  };
}

test('startup removes stale Chromium symlinks but preserves cookies', () => {
  const f = fixture();
  try {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    for (const name of ['SingletonLock', 'SingletonCookie', 'SingletonSocket']) {
      assert.throws(() => lstatSync(join(f.dir, 'profile', name)), { code: 'ENOENT' });
    }
    assert.equal(readFileSync(join(f.dir, 'profile', 'Cookies'), 'utf8'), 'preserve-session');
  } finally { f.clean(); }
});

test('active service lock prevents cleanup and a second launch', async () => {
  const f = fixture();
  const holder = spawn('flock', ['-x', join(f.dir, 'service.lock'), 'sh', '-c', 'printf ready; cat'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const exited = once(holder, 'exit');
  try {
    await once(holder.stdout, 'data');
    const result = f.run();
    assert.equal(result.status, 1);
    assert.match(result.stdout, /Profile is in use/);
    assert.ok(lstatSync(join(f.dir, 'profile', 'SingletonLock')).isSymbolicLink());
  } finally { holder.stdin.end(); await exited; f.clean(); }
});

test('unexpected regular lock file is preserved and blocks startup', () => {
  const f = fixture();
  try {
    const path = join(f.dir, 'profile', 'SingletonLock');
    rmSync(path);
    writeFileSync(path, 'unexpected');
    assert.equal(f.run().status, 1);
    assert.equal(readFileSync(path, 'utf8'), 'unexpected');
  } finally { f.clean(); }
});
