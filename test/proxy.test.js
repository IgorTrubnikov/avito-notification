import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { telegramTransport } from '../src/telegram-proxy.js';

test('unset proxy preserves direct fetch; invalid proxy errors hide credentials', async () => {
  const direct = telegramTransport();
  assert.equal(direct.fetch, globalThis.fetch);
  await direct.close();
  for (const value of ['socks5://user:SECRET@host:1080', 'http://user:SECRET@host:broken', 'http://user:SECRET@host/?query']) {
    assert.throws(() => telegramTransport(value), error => error.message.includes('TELEGRAM_PROXY_URL') && !error.message.includes('SECRET'));
  }
});

test('explicit HTTP proxy uses CONNECT and Basic auth without changing global fetch', async () => {
  const directFetch = globalThis.fetch;
  const origin = http.createServer((req, res) => {
    assert.equal(req.headers['proxy-authorization'], undefined);
    res.end('telegram mock');
  });
  origin.listen(0, '127.0.0.1');
  await once(origin, 'listening');
  const connections = [];
  const sockets = new Set();
  const proxy = http.createServer();
  proxy.on('connect', (req, socket, head) => {
    connections.push({ target: req.url, auth: req.headers['proxy-authorization'] });
    const upstream = net.connect(origin.address().port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (head.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    });
    for (const s of [socket, upstream]) {
      sockets.add(s);
      s.on('error', () => { socket.destroy(); upstream.destroy(); });
    }
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const transport = telegramTransport(`http://test:pass@127.0.0.1:${proxy.address().port}`);
  try {
    const result = await transport.fetch('http://telegram.invalid/test', { signal: AbortSignal.timeout(5000) });
    assert.equal(await result.text(), 'telegram mock');
    assert.equal(connections.length, 1);
    assert.equal(connections[0].target, 'telegram.invalid:80');
    assert.equal(connections[0].auth, `Basic ${Buffer.from('test:pass').toString('base64')}`);
    assert.equal(globalThis.fetch, directFetch);
  } finally {
    await transport.close();
    for (const socket of sockets) socket.destroy();
    await Promise.all([new Promise(resolve => proxy.close(resolve)), new Promise(resolve => origin.close(resolve))]);
  }
});
