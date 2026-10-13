import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { fixture } from '../fixtures.ts';
import { webFetch } from '../../src/tools/web.ts';

test('web.fetch stops consuming an unbounded chunked body at the byte limit', async () => {
  let bytes = 0;
  const server = createServer((_req, res) => {
    const timer = setInterval(() => { const chunk = Buffer.alloc(32_000, 'x'); bytes += chunk.length; res.write(chunk); }, 2);
    res.on('close', () => clearInterval(timer));
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const host = `127.0.0.1:${(server.address() as { port: number }).port}`;
  const fx = fixture({}, { tool_classes: ['web.read'], network_destinations: [host] });
  fx.core.registry.register(webFetch(fx.core.policy));
  try {
    const id = fx.task(); fx.run(id);
    const r = await fx.core.broker.submit(fx.proposal(id, 'web.fetch', { url: `http://${host}/stream` }, 'fetch'));
    assert.equal(r.verdict, 'COMMITTED', r.reason);
    assert.equal((r.receipt as any).truncated, true);
    assert.equal((r.receipt as any).text.length, 200_000);
    await new Promise((resolve) => setTimeout(resolve, 30));
    const stopped = bytes; await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(bytes, stopped, 'upstream stream was cancelled');
    assert.ok(bytes < 2_000_000, `consumed bounded prefix, server sent ${bytes}`);
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); fx.cleanup(); }
});

test('every non-public address form is recognised, including mapped, compatible and expanded IPv6', async () => {
  const { privateAddr } = await import('../../src/tools/web.ts');
  const internal = ['127.0.0.1', '10.1.2.3', '172.16.0.1', '192.168.1.1', '169.254.169.254', '100.64.0.1', '100.127.255.255', '0.0.0.0', '198.18.0.1',
    '224.0.0.1', '255.255.255.255', '::1', '[::1]', '0:0:0:0:0:0:0:1', '::', '::ffff:127.0.0.1', '::ffff:7f00:1', '::ffff:169.254.169.254', '::127.0.0.1',
    '::ffff:a9fe:a9fe', 'fc00::1', 'fd12:3456::1', 'fe80::1%en0', 'fec0::1', 'ff02::1', '2001:db8::1', 'not-an-ip', ''];
  for (const ip of internal) assert.equal(privateAddr(ip), true, ip);
  for (const ip of ['93.184.216.34', '1.1.1.1', '100.128.0.1', '172.32.0.1', '2606:4700:4700::1111', '::ffff:93.184.216.34']) assert.equal(privateAddr(ip), false, ip);
});

test('web.fetch connects to the vetted address, not a second DNS answer', async () => {
  // A granted name that resolves to loopback is refused without an explicit network grant, before any connection.
  let hits = 0;
  const server = createServer((_req, res) => { hits++; res.end('internal'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = (server.address() as { port: number }).port;
  const fx = fixture({}, { tool_classes: ['web.read'], domains: ['localhost'] });
  fx.core.registry.register(webFetch(fx.core.policy));
  try {
    const id = fx.task(); fx.run(id);
    const r = await fx.core.broker.submit(fx.proposal(id, 'web.fetch', { url: `http://localhost:${port}/` }, 'fetch'));
    assert.notEqual(r.verdict, 'COMMITTED');
    assert.equal(hits, 0, 'no connection was made to the internal address');
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); fx.cleanup(); }
});

test('web.fetch reaches a granted host name through its vetted addresses', async () => {
  const server = createServer((req, res) => { res.setHeader('content-type', 'text/html'); res.end(`<p>hello ${req.headers.host}</p>`); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const host = `localhost:${(server.address() as { port: number }).port}`;
  const fx = fixture({}, { tool_classes: ['web.read'], network_destinations: [host] });
  fx.core.registry.register(webFetch(fx.core.policy));
  try {
    const id = fx.task(); fx.run(id);
    const r = await fx.core.broker.submit(fx.proposal(id, 'web.fetch', { url: `http://${host}/` }, 'fetch'));
    assert.equal(r.verdict, 'COMMITTED', r.reason);
    assert.equal((r.receipt as any).text, `hello ${host}`, 'Host header carries the name, not the pinned address');
  } finally { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); fx.cleanup(); }
});
