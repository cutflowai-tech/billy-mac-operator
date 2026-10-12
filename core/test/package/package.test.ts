// PACKAGE lane: tests run against the delivered release artifact (zip), installed
// into a fresh location and launched with a scrubbed environment.
// T-FOUND-06, T-REL-01, T-UX-04, T-REL-04, T-REL-06, T-REL-10, T-REL-09.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const ZIP = process.env.BILLY_ARTIFACT_ZIP ?? join(ROOT, 'artifacts/release/0.1.0/Billy-0.1.0.zip');
const sha = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');
let base = ''; let app = ''; let data = ''; let userFiles = ''; let daemon: ChildProcess | null = null;
const KEY = randomBytes(32).toString('hex');
const ENV = () => ({ HOME: process.env.HOME!, PATH: '/usr/bin:/bin:/usr/sbin:/sbin', BILLY_DATA_DIR: data, BILLY_TEST_BACKUP_KEY_HEX: KEY });
const ctl = (...a: string[]) => spawnSync(join(app, 'Contents/Resources/billyd/billyctl'), ['--data-dir', data, ...a], { encoding: 'utf8', env: ENV(), timeout: 60_000 });

function startDaemon(): Promise<void> {
  daemon = spawn(join(app, 'Contents/Resources/billyd/billyd'), ['--data-dir', data, '--allow-unsafe-location'], { env: ENV(), stdio: ['ignore', 'pipe', 'pipe'] });
  return new Promise((res, rej) => { daemon!.stdout!.on('data', (d) => { if (/listening/.test(String(d))) res(); }); daemon!.on('exit', (c) => rej(new Error(`billyd exited ${c}`))); setTimeout(() => rej(new Error('billyd start timeout')), 20_000); });
}
async function stopDaemon() { if (!daemon) return; daemon.kill('SIGTERM'); await new Promise((r) => daemon!.once('exit', r)); daemon = null; }

before(async () => {
  assert.ok(existsSync(ZIP), `release artifact missing: ${ZIP}`);
  base = realpathSync(mkdtempSync('/tmp/billy-bpkg-'));
  mkdirSync(join(base, 'Applications'));
  const x = spawnSync('/usr/bin/ditto', ['-x', '-k', ZIP, join(base, 'Applications')], { encoding: 'utf8' });
  assert.equal(x.status, 0, x.stderr);
  app = join(base, 'Applications', 'Billy.app');
  data = join(base, 'data');
  userFiles = join(base, 'owner-files'); mkdirSync(userFiles);
  writeFileSync(join(userFiles, 'thesis.docx'), randomBytes(4096)); writeFileSync(join(userFiles, 'notes.md'), '# my notes\n');
  await startDaemon();
});
after(async () => { await stopDaemon(); if (base) rmSync(base, { recursive: true, force: true }); });

test('T-FOUND-06: Billy identity is distinct from upstream; notices and helper identity explicit', () => {
  const plist = spawnSync('/usr/bin/plutil', ['-extract', 'CFBundleIdentifier', 'raw', join(app, 'Contents/Info.plist')], { encoding: 'utf8' }).stdout.trim();
  assert.equal(plist, 'com.billy.app');
  assert.ok(!['ai.openclaw.mac', 'com.trycua.driver'].includes(plist));
  const label = spawnSync('/usr/bin/plutil', ['-extract', 'Label', 'raw', join(app, 'Contents/Library/LaunchAgents/com.billy.core.plist')], { encoding: 'utf8' }).stdout.trim();
  assert.equal(label, 'com.billy.core');
  assert.ok(existsSync(join(app, 'Contents/Resources/core/THIRD_PARTY_NOTICES.txt')));
  const notices = readFileSync(join(app, 'Contents/Resources/core/THIRD_PARTY_NOTICES.txt'), 'utf8');
  for (const n of ['@anthropic-ai/sdk', 'Node.js runtime', 'CuaDriver (not bundled)']) assert.ok(notices.includes(n), n);
  // Billy's private driver socket lives in Billy's own run dir, never the upstream default.
  const cua = readFileSync(join(app, 'Contents/Resources/core/src/desktop/cua.ts'), 'utf8');
  assert.match(cua, /join\(runDir, `cua-\$\{generation\}\.sock`\)/);
  assert.ok(!existsSync(join(data, 'run', 'cua.sock')), 'driver daemon is not started until a desktop task needs it');
});

test('T-REL-01: clean install launches from the artifact with a scrubbed environment and no development paths', () => {
  assert.equal(spawnSync('/usr/bin/codesign', ['--verify', '--strict', app]).status, 0);
  const team = spawnSync('/usr/bin/codesign', ['-dv', join(app, 'Contents/Resources/node/bin/node')], { encoding: 'utf8' }).stderr;
  assert.match(team, /TeamIdentifier=HX7739G8FX/, 'embedded Node keeps its official signature');
  const st = ctl('status', '--json');
  assert.equal(st.status, 0, st.stderr);
  // No reference to the developer checkout is needed at runtime.
  const ps = spawnSync('/bin/ps', ['-o', 'command=', '-p', String(daemon!.pid)], { encoding: 'utf8' }).stdout;
  assert.ok(!ps.includes('/Volumes/Zeno'), ps);
  assert.ok(ps.includes(join(app, 'Contents/Resources')), ps);
});

test('packaged session helper returns bounded read-only OS facts with no development runtime', () => {
  const helper = join(app, 'Contents/Resources/bin/billy-session');
  assert.equal(spawnSync('/usr/bin/codesign', ['--verify', '--strict', helper]).status, 0);
  const r = spawnSync(helper, [], { encoding: 'utf8', env: ENV(), timeout: 3000 });
  assert.equal(r.status, 0, r.stderr);
  const facts = JSON.parse(r.stdout);
  assert.equal(typeof facts.locked, 'boolean');
  assert.ok(Number.isFinite(facts.idle_ms) && facts.idle_ms >= 0);
});

test('T-UX-04: doctor names the missing capability accurately and changes nothing', () => {
  const before = [join(data, 'config.json'), ...readdirSync(userFiles).map((f) => join(userFiles, f))].map(sha);
  const d = ctl('doctor', '--json');
  assert.equal(d.status, 1, 'doctor exits nonzero when a capability is missing');
  const rep = JSON.parse(d.stdout);
  const prov = rep.checks.find((c: any) => c.id === 'provider.credential');
  assert.equal(prov.status, 'fail');
  assert.match(prov.fix, /security add-generic-password -U -s com\.billy\.provider\.anthropic/);
  const after = [join(data, 'config.json'), ...readdirSync(userFiles).map((f) => join(userFiles, f))].map(sha);
  assert.deepEqual(after, before, 'protected state unchanged');
});

test('T-REL-04 (PACKAGE): installed billyctl backup -> verify -> offline restore into a separate dir with consistent state', async () => {
  for (let i = 0; i < 5; i++) assert.equal(ctl('task-add', `package fixture task ${i}`).status, 0);
  const b = ctl('backup-create', 'pkg', '--json');
  assert.equal(b.status, 0, b.stderr);
  const id = JSON.parse(b.stdout).id;
  assert.equal(ctl('backup-verify', id).status, 0);
  // Restore always targets a NEW directory (never the live data dir), and refuses an occupied one.
  const occupied = ctl('restore', id, '--to', data);
  assert.notEqual(occupied.status, 0, 'restore into the live data dir is refused');
  await stopDaemon();
  const r = ctl('restore', id, '--to', join(base, 'restored'), '--json');
  assert.equal(r.status, 0, r.stderr);
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(join(base, 'restored', 'billy.db'), { readOnly: true });
  const n = (db.prepare(`SELECT count(*) c FROM tasks`).get() as any).c;
  assert.equal((db.prepare('PRAGMA integrity_check').get() as any).integrity_check, 'ok');
  db.close();
  assert.equal(n, JSON.parse(b.stdout).counts.tasks);
  await startDaemon();
});

test('T-REL-10: documented runbook commands work; stop/uninstall preserve owner data', () => {
  const before = readdirSync(userFiles).map((f) => sha(join(userFiles, f)));
  for (const args of [['status'], ['tasks'], ['backup-list'], ['uninstall-plan']]) { const r = ctl(...args); assert.equal(r.status, 0, `${args}: ${r.stderr}`); }
  const s = ctl('stop', 'runbook check', '--json'); assert.equal(s.status, 0); assert.ok(JSON.parse(s.stdout).ack_ms < 2000);
  assert.equal(JSON.parse(ctl('status', '--json').stdout).stop.stopped, true);
  assert.equal(ctl('resume').status, 0);
  assert.equal(JSON.parse(ctl('status', '--json').stdout).stop.stopped, false);
  const diag = join(base, 'diag.json');
  assert.equal(ctl('diagnostics-export', diag).status, 0);
  assert.ok(!readFileSync(diag, 'utf8').includes('package fixture task'), 'diagnostics export omits goals');
  const trash = ctl('data-trash', '--confirm');
  assert.equal(trash.status, 4, 'data removal refused while the service runs');
  assert.ok(existsSync(join(data, 'billy.db')));
  const plan = ctl('uninstall-plan').stdout;
  assert.match(plan, /Never touched/);
  assert.deepEqual(readdirSync(userFiles).map((f) => sha(join(userFiles, f))), before, 'owner files untouched');
  for (const doc of ['operator-runbook.md', 'developer-runbook.md', 'remote-access.md']) assert.ok(statSync(join(ROOT, 'docs', doc)).size > 500, doc);
});

test('T-REL-06: shipped identities/licenses match the artifact; reproducibility claims limited to measured properties', () => {
  const rel = join(ZIP, '..');
  const sbom = JSON.parse(readFileSync(join(rel, 'sbom.json'), 'utf8'));
  assert.deepEqual(sbom.unknown_licenses, []);
  const bundledNode = sha(join(app, 'Contents/Resources/node/bin/node'));
  assert.equal(sbom.components.find((c: any) => c.name === 'node').files_sha256, bundledNode);
  const sums = readFileSync(join(rel, 'SHA256SUMS'), 'utf8');
  assert.ok(sums.includes(sha(ZIP)), 'zip digest is published');
  const manifest = JSON.parse(readFileSync(join(rel, 'build-manifest.json'), 'utf8'));
  assert.match(manifest.commit, /^[0-9a-f]{40}$/);
  // Measured reproducibility: the shipped core tree is byte-identical to the committed sources.
  const show = (p: string) => spawnSync('git', ['-C', ROOT, 'show', `${manifest.commit}:core/${p}`], { encoding: 'buffer' }).stdout;
  for (const p of ['src/broker/broker.ts', 'src/policy/policy.ts', 'src/daemon/main.ts', 'package-lock.json']) {
    assert.equal(createHash('sha256').update(show(p)).digest('hex'), sha(join(app, 'Contents/Resources/core', p)), p);
  }
  const lock = JSON.parse(readFileSync(join(app, 'Contents/Resources/core/package-lock.json'), 'utf8'));
  for (const [k, v] of Object.entries<any>(lock.packages)) if (k.startsWith('node_modules/') && !v.dev) assert.ok(existsSync(join(app, 'Contents/Resources/core', k)), `${k} shipped`);
  assert.ok(!existsSync(join(app, 'Contents/Resources/core/node_modules/typescript')), 'dev dependencies are not shipped');
});

test('T-REL-09: an independent review approves the installed artifact by fingerprint, with recorded reproduction of every critical test, and no critical/high defect is unresolved', async () => {
  const info = JSON.parse(readFileSync(join(app, 'Contents/Resources/core/build-info.json'), 'utf8'));
  assert.match(info.commit, /^[0-9a-f]{40}$/, 'artifact seals a full commit id');
  const { reviewProblems, criticalScenarioIds, sha256, unresolvedFindings } = await import('../../../release/evaluator/review.ts');
  const { repoReviewContext } = await import('../../../release/evaluator/evaluate.ts');
  const manifestText = readFileSync(join(ROOT, 'release/requirements.manifest.json'), 'utf8');
  const ctx = { candidateCommit: info.commit, manifestSha256: sha256(manifestText), criticalIds: criticalScenarioIds(JSON.parse(manifestText)), ...repoReviewContext(ROOT, info.commit) };
  const reviews = JSON.parse(readFileSync(join(ROOT, 'release/reviews.json'), 'utf8')) as any[];
  const judged = reviews.map((r) => ({ r, problems: reviewProblems(r, ctx) }));
  const approving = judged.filter((j) => j.problems.length === 0).map((j) => j.r);
  assert.ok(approving.length > 0, `no review approves artifact commit ${info.commit}: ${JSON.stringify(judged.at(-1)?.problems ?? ['no review records'])}`);
  // Who reproduced what, against which candidate, with what result: recorded as this scenario's evidence.
  const reproduced = approving.flatMap((r) => (r.reproduced ?? []).map((run: any) => ({ reviewer: r.reviewer, independence_basis: r.independence_basis, candidate_commit: run.candidate_commit,
    suite: run.suite, command: run.command, tests: run.tests, pass: run.pass, fail: run.fail, scenario_ids: run.scenario_ids, log: run.log })));
  const { STAMP } = await import('../stamp.ts');
  mkdirSync(join(ROOT, 'artifacts/measurements'), { recursive: true });
  writeFileSync(join(ROOT, 'artifacts/measurements/T-REL-09.json'), JSON.stringify({ test_id: 'T-REL-09', at: new Date().toISOString(), ...STAMP,
    measurements: { critical_scenarios_reproduced: ctx.criticalIds.length, reproduction_runs: reproduced.length }, artifact_commit: info.commit, reproduced }, null, 2));
  // Handoff pass condition: no unresolved critical/high release defect remains ("accepted" is not resolved, and a
  // fix awaiting verification is resolved only once an approving review verified it).
  const findings = JSON.parse(readFileSync(join(ROOT, 'release/findings.json'), 'utf8')) as any[];
  const unresolved = unresolvedFindings(findings, approving).map((f) => `${f.id} (${f.severity}, ${f.status}${f.requires_verification ? ', awaiting verification' : ''})`);
  assert.deepEqual(unresolved, [], 'unresolved critical/high release defects');
});
