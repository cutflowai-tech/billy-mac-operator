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
