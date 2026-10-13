// Private driver lifecycle: shutdown is awaited and drivers left by an earlier Billy process are retired.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { retireStaleDaemons, stopPrivateDaemon } from '../../src/desktop/cua.ts';

function fakeDriver(path: string, closeOnShutdown = true): { server: Server; got: string[]; ready: Promise<void> } {
  const got: string[] = [];
  const server = createServer((c) => {
    let buf = '';
    c.on('data', (d) => {
      buf += d.toString();
      if (buf.includes('\n')) { got.push(JSON.parse(buf.split('\n')[0]).method); if (closeOnShutdown) { c.end(); server.close(); } }
    });
    c.on('error', () => {});
  });
  const ready = new Promise<void>((r) => server.listen(path, r));
  return { server, got, ready };
}

test('stopping the private driver waits until it has received shutdown', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'billy-cua-'));
  try {
    const d = fakeDriver(join(dir, 'cua-1-abc.sock'));
    await d.ready;
    await stopPrivateDaemon(join(dir, 'cua-1-abc.sock'));
    assert.deepEqual(d.got, ['shutdown'], 'shutdown was delivered before the promise resolved');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('stopping a driver that never closes is bounded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'billy-cua-'));
  const d = fakeDriver(join(dir, 'cua-1-x.sock'), false);
  try {
    await d.ready;
    const t0 = Date.now();
    await stopPrivateDaemon(join(dir, 'cua-1-x.sock'), 300);
    assert.ok(Date.now() - t0 < 2000);
  } finally { d.server.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('startup retires drivers left by an earlier process and removes their sockets and manifests', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'billy-cua-'));
  try {
    const live = fakeDriver(join(dir, 'cua-1.sock'));          // legacy name from an older build
    await live.ready;
    writeFileSync(join(dir, 'cua-2-dead.sock'), '');          // dead socket file
    writeFileSync(join(dir, 'cua-manifest.yaml'), 'old grant');
    writeFileSync(join(dir, 'api.sock.keep'), '');
    const retired = await retireStaleDaemons(dir);
    assert.deepEqual(retired.sort(), ['cua-1.sock', 'cua-2-dead.sock']);
    assert.deepEqual(live.got, ['shutdown']);
    for (const n of ['cua-1.sock', 'cua-2-dead.sock', 'cua-manifest.yaml']) assert.equal(existsSync(join(dir, n)), false, n);
    assert.equal(existsSync(join(dir, 'api.sock.keep')), true, 'unrelated files are untouched');
    assert.deepEqual(await retireStaleDaemons(join(dir, 'missing')), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the driver pin requires a valid seal over the whole bundle, not just the executable digest', async () => {
  const { verifyPin } = await import('../../src/desktop/cua.ts');
  const { cpSync, readFileSync, appendFileSync } = await import('node:fs');
  const { createHash } = await import('node:crypto');
  const dir = mkdtempSync(join(tmpdir(), 'billy-pin-'));
  try {
    // An Apple-signed bundle stands in for the driver: copy it and tamper with a sealed resource.
    const src = '/System/Applications/Calculator.app';
    const app = join(dir, 'Driver.app');
    cpSync(src, app, { recursive: true });
    const exe = join(app, 'Contents/MacOS/Calculator');
    const pin = { app_path: app, binary_sha256: createHash('sha256').update(readFileSync(exe)).digest('hex'), team_id: 'not-checked-here' };
    // verifyPin hashes Contents/MacOS/cua-driver: point it at a copy of the real executable.
    cpSync(exe, join(app, 'Contents/MacOS/cua-driver'));
    appendFileSync(join(app, 'Contents/Info.plist'), '\n<!-- tampered -->\n');
    const v = verifyPin(pin);
    assert.equal(v.ok, false);
    assert.equal(v.team, 'invalid-signature', 'a modified sealed bundle never passes on the executable digest alone');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
