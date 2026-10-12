import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, readFileSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { tempDir } from '../helpers.ts';
import { until } from '../fixtures.ts';
import { MacSessionProbe, DesktopArbiter } from '../../src/desktop/session.ts';

function helper(stream: boolean) {
  const tmp = tempDir();
  const executable = join(tmp.dir, 'session-probe'); const starts = join(tmp.dir, 'starts');
  const body = `#!${process.execPath}\nimport { appendFileSync } from 'node:fs';
appendFileSync(${JSON.stringify(starts)}, 'start\\n');
const emit = () => process.stdout.write(JSON.stringify({ idle_ms: 60000, locked: false, frontmost_bundle: 'fixture', at: Date.now() }) + '\\n');
emit(); if (process.argv.includes('--watch')) setInterval(${stream ? 'emit' : '() => {}'}, 50);\n`;
  writeFileSync(executable, body); chmodSync(executable, 0o755);
  return { ...tmp, executable, starts };
}

test('resident session probe performs repeated reads without launching subprocesses per read', async () => {
  const h = helper(true); const probe = new MacSessionProbe(h.executable);
  try {
    assert.equal(probe.read().locked, false, 'direct read uses bounded one-shot helper');
    probe.start();
    await until(() => !probe.read().locked);
    for (let i = 0; i < 10000; i++) assert.equal(probe.read().idle_ms, 60000);
    assert.equal(readFileSync(h.starts, 'utf8').trim().split('\n').length, 2, 'one direct and one resident invocation');
  } finally { probe.stop(); h.cleanup(); }
});

test('stalled and missing session probes fail closed instead of assuming owner idle', async () => {
  const h = helper(false); const probe = new MacSessionProbe(h.executable);
  try {
    probe.start(); await until(() => !probe.read().locked);
    await until(() => probe.read().locked);
    assert.equal(probe.read().idle_ms, 0);
    const missing = new MacSessionProbe(join(h.dir, 'missing'));
    assert.equal(missing.read().locked, true);
    assert.equal(new DesktopArbiter(missing).mayInput('allowed', true).ok, false);
  } finally { probe.stop(); h.cleanup(); }
});

test('takeover history remains bounded during extended owner activity', async () => {
  const arbiter = new DesktopArbiter({ read: () => ({ idle_ms: 0, locked: true, frontmost_bundle: null, at: Date.now() }) },
    { activeWindowMs: 1500, resumeIdleMs: 5000, selfEchoMs: 250, pollMs: 1 });
  let events = 0; arbiter.onTakeover.push(() => { events++; });
  try { arbiter.start(); await until(() => events > 120); assert.equal(arbiter.takeovers.length, 100); }
  finally { arbiter.stop(); }
});
