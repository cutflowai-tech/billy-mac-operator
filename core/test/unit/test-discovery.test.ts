// A bare `node --test` (or a glob that is too wide) discovers every file under test/. Harness processes must
// fail fast instead of hanging the runner, and the native GUI suite must never run without explicit opt-in.
// Regression for a diagnostic run that hung for 10 h on test/harness/receiver.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';

const CORE = join(import.meta.dirname, '..', '..');
const STRICT = { timeout: 60_000 };
/** A nested `node --test` must not inherit this runner's child protocol (NODE_TEST_CONTEXT). */
const runnerEnv = (extra: Record<string, string> = {}, drop: string[] = []) => {
  const env: Record<string, string | undefined> = { ...process.env, ...extra };
  for (const k of ['NODE_TEST_CONTEXT', ...drop]) delete env[k];
  return env as NodeJS.ProcessEnv;
};

test('the side-effect receiver refuses to start without its arguments (no listening forever)', STRICT, () => {
  const t0 = Date.now();
  const r = spawnSync(process.execPath, [join(CORE, 'test/harness/receiver.ts')], { encoding: 'utf8', timeout: 10_000 });
  assert.equal(r.error, undefined, 'exited on its own (not killed by the timeout)');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /harness process/);
  assert.ok(Date.now() - t0 < 10_000);
});

test('the test runner discovering the receiver finishes promptly instead of hanging', STRICT, async () => {
  // Own process group: on timeout the whole group (runner AND any receiver it spawned) is killed, so a
  // regression fails this test without leaking an orphan listener (spawnSync's timeout kills only the runner).
  const child = spawn(process.execPath, ['--test', '--test-reporter=tap', 'test/harness/receiver.ts'], { cwd: CORE, env: runnerEnv(), detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout!.on('data', (d) => { out += d; });
  const timer = setTimeout(() => { try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* gone */ } }, 30_000);
  const [status, signal] = await once(child, 'exit') as [number | null, string | null];
  clearTimeout(timer);
  try { process.kill(-child.pid!, 'SIGKILL'); } catch { /* group already empty */ }
  assert.equal(signal, null, 'runner finished on its own within 30 s');
  assert.equal(status, 1, 'reported as a failing file, not left running');
  assert.match(out, /^not ok 1 - test\/harness\/receiver\.ts$/m);
});

test('the native GUI suite skips everything without BILLY_NATIVE_LIVE=1 and launches nothing', STRICT, () => {
  const rigs = () => readdirSync('/tmp').filter((n) => /^billy-(blv|blive)-/.test(n)).sort();
  const before = rigs();
  // Second fence: a missing OCR helper stops the suite before any driver launch even if the gate regressed.
  const env = runnerEnv({ BILLY_OCR_PATH: '/nonexistent/billy-ocr' }, ['BILLY_NATIVE_LIVE']);
  const r = spawnSync(process.execPath, ['--test', '--test-reporter=tap', 'test/live/native.test.ts'], { cwd: CORE, encoding: 'utf8', timeout: 45_000, env });
  assert.equal(r.error, undefined, 'finished within the timeout');
  assert.equal(r.status, 0, r.stdout.slice(-2000));
  assert.match(r.stdout, /# SKIP BILLY_NATIVE_LIVE=1 not set/);
  assert.match(r.stdout, /^# pass 0$/m, 'no native test ran');
  assert.deepEqual(rigs(), before, 'no live rig or driver run directory was created');
});

test('the package test script lists only deterministic suites, with a per-file timeout', STRICT, async () => {
  const { readFileSync } = await import('node:fs');
  const script = JSON.parse(readFileSync(join(CORE, 'package.json'), 'utf8')).scripts.test as string;
  assert.match(script, /--test-timeout=\d+/);
  assert.ok(!/test\/\*\*|test\/live|test\/package|test\/harness/.test(script), script);
});
