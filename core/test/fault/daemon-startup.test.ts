// Daemon startup on a corrupt store: quarantine once, then exit cleanly so launchd
// (KeepAlive SuccessfulExit=false) does not restart into the same failure forever.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readdirSync, statSync, writeSync } from 'node:fs';
import { join } from 'node:path';
import { fixture } from '../fixtures.ts';

const MAIN = join(import.meta.dirname, '../../src/daemon/main.ts');

test('a corrupt store is quarantined at startup and the daemon exits cleanly instead of crash-looping', () => {
  const fx = fixture();
  const dataDir = join(fx.dir, 'data');
  try {
    fx.task();
    fx.core.close();
    const db = join(dataDir, 'billy.db');
    const size = statSync(db).size;
    assert.ok(size > 4096, 'fixture store spans several pages');
    const fd = openSync(db, 'r+');
    for (let off = 4096; off < size; off += 4096) writeSync(fd, Buffer.alloc(Math.min(4096, size - off), 0xa5), 0, Math.min(4096, size - off), off);
    closeSync(fd);
    const start = () => spawnSync(process.execPath, [MAIN, '--data-dir', dataDir, '--allow-unsafe-location'], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, BILLY_LAUNCHD: '' } });
    const first = start();
    assert.equal(first.status, 0, first.stderr);
    assert.match(first.stderr, /recovery required; incident/);
    assert.equal(existsSync(join(dataDir, 'RECOVERY_REQUIRED.json')), true);
    assert.equal(readdirSync(join(dataDir, 'quarantine')).length, 1, 'damaged bytes preserved once');
    assert.equal(existsSync(db), false, 'no blank database was created in its place');
    const second = start();
    assert.equal(second.status, 0, second.stderr);
    assert.equal(readdirSync(join(dataDir, 'quarantine')).length, 1, 'a later start does not quarantine again');
    assert.equal(existsSync(db), false);
  } finally { fx.cleanup(); }
});
