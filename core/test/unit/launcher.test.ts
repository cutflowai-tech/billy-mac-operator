import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

test('launchd launcher resolves private logs from the installing user HOME; manual stdout stays piped', () => {
  const dir = mkdtempSync(join(tmpdir(), 'billy-launcher-'));
  const resources = join(dir, 'Billy.app', 'Contents', 'Resources');
  const launcher = join(resources, 'billyd', 'billyd');
  const home = join(dir, 'installing user');
  const manualHome = join(dir, 'manual user');
  try {
    for (const path of [join(resources, 'billyd'), join(resources, 'node', 'bin'), join(resources, 'core', 'src', 'daemon'), home, manualHome]) mkdirSync(path, { recursive: true });
    copyFileSync(new URL('../../../native/Resources/billyd', import.meta.url), launcher);
    writeFileSync(join(resources, 'core', 'src', 'daemon', 'main.ts'), '// fake daemon, never executed');
    writeFileSync(join(resources, 'node', 'bin', 'node'), '#!/bin/sh\nprintf "fixture stdout:%s\\n" "$2"\nprintf "fixture stderr\\n" >&2\n', { mode: 0o755 });
    const env = { ...process.env, HOME: home, BILLY_LAUNCHD: '1' };
    const first = spawnSync('/bin/sh', [launcher, 'first-run'], { env, encoding: 'utf8', timeout: 5000 });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stdout, ''); assert.equal(first.stderr, '');
    const logs = join(home, 'Library', 'Logs', 'Billy');
    assert.equal(readFileSync(join(logs, 'billyd.out.log'), 'utf8'), 'fixture stdout:first-run\n');
    assert.equal(readFileSync(join(logs, 'billyd.err.log'), 'utf8'), 'fixture stderr\n');
    assert.equal(statSync(join(logs, 'billyd.out.log')).mode & 0o777, 0o600);
    const second = spawnSync('/bin/sh', [launcher, 'second-run'], { env, encoding: 'utf8', timeout: 5000 });
    assert.equal(second.status, 0, second.stderr);
    assert.equal(readFileSync(join(logs, 'billyd.out.log'), 'utf8'), 'fixture stdout:first-run\nfixture stdout:second-run\n');
    const manualEnv: NodeJS.ProcessEnv = { ...process.env, HOME: manualHome };
    delete manualEnv.BILLY_LAUNCHD;
    const manual = spawnSync('/bin/sh', [launcher, 'manual-run'], { env: manualEnv, encoding: 'utf8', timeout: 5000 });
    assert.equal(manual.status, 0, manual.stderr);
    assert.equal(manual.stdout, 'fixture stdout:manual-run\n');
    assert.equal(manual.stderr, 'fixture stderr\n');
    assert.equal(existsSync(join(manualHome, 'Library', 'Logs', 'Billy')), false);
    const plist = readFileSync(new URL('../../../native/Resources/com.billy.core.plist', import.meta.url), 'utf8');
    assert.match(plist, /<key>EnvironmentVariables<\/key>/);
    assert.match(plist, /<key>BILLY_LAUNCHD<\/key>\s*<string>1<\/string>/);
    assert.ok(!/StandardOutPath|StandardErrorPath|__HOME__/.test(plist));
    // Crashes restart; a clean exit (owner stop, or a corrupt store awaiting restore) does not loop.
    assert.match(plist, /<key>KeepAlive<\/key>\s*<dict>\s*<key>SuccessfulExit<\/key>\s*<false\/>/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an empty or truncated API token file is replaced, never accepted', async () => {
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { ensureToken, MIN_TOKEN_CHARS } = await import('../../src/daemon/api.ts');
  const dir = mkdtempSync(join(tmpdir(), 'billy-tok-'));
  try {
    for (const weak of ['', '\n', 'short']) {
      writeFileSync(join(dir, 'api.token'), weak);
      const t = ensureToken(dir);
      assert.ok(t.length >= MIN_TOKEN_CHARS, JSON.stringify(weak));
      assert.equal(readFileSync(join(dir, 'api.token'), 'utf8').trim(), t);
    }
    assert.equal(ensureToken(dir), readFileSync(join(dir, 'api.token'), 'utf8').trim(), 'a strong token is kept');
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
