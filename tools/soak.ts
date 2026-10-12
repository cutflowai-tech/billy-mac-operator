// T-REL-07 active soak against the PACKAGED artifact.
//   node tools/soak.ts --zip artifacts/release/<v>/Billy-<v>.zip [--minutes 62]
// Real wall clock. Writes artifacts/soak/<run>/report.json and artifacts/measurements/T-REL-07.json.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, realpathSync, statSync, existsSync, appendFileSync } from 'node:fs';
import { join } from 'node:path';
import { sha256 } from '../release/evaluator/review.ts';
import { arg } from '../release/lib/cli.ts';

const ROOT = join(import.meta.dirname, '..');
const ZIP = arg('--zip') ?? join(ROOT, 'artifacts/release/0.1.0/Billy-0.1.0.zip');
const MINUTES = Number(arg('--minutes') ?? 62);
const run = new Date().toISOString().replace(/[:.]/g, '-');
const OUT = join(ROOT, 'artifacts/soak', run); mkdirSync(OUT, { recursive: true });
const log = (m: string) => { const l = `${new Date().toISOString()} ${m}`; console.log(l); appendFileSync(join(OUT, 'soak.log'), l + '\n'); };
const base = realpathSync(mkdtempSync('/tmp/claude-501/bsoak-'));
// Hash exactly the bytes that are unpacked and exercised (before unpacking, not at the end of the run).
const ZIP_SHA = sha256(readFileSync(ZIP));
spawnSync('/usr/bin/ditto', ['-x', '-k', ZIP, join(base, 'Applications')]);
const app = join(base, 'Applications/Billy.app');
const data = join(base, 'data'); const ws = join(base, 'ws'); mkdirSync(ws);
const ENV = { HOME: process.env.HOME!, PATH: '/usr/bin:/bin:/usr/sbin:/sbin' };

// Receiver (authoritative effect counter) runs from the source harness, separate process.
const recv = spawn(process.execPath, [join(ROOT, 'core/test/harness/receiver.ts'), join(OUT, 'receiver.jsonl'), '0'], { stdio: ['ignore', 'pipe', 'inherit'] });
const recvUrl: string = await new Promise((res) => recv.stdout!.on('data', (d) => { const m = /LISTENING (\d+)/.exec(String(d)); if (m) res(`http://127.0.0.1:${m[1]}`); }));

let daemon: ChildProcess | null = null;
async function start() {
  daemon = spawn(join(app, 'Contents/Resources/billyd/billyd'), ['--data-dir', data, '--allow-unsafe-location'], { env: ENV, stdio: ['ignore', 'pipe', 'pipe'] });
  daemon.stderr!.on('data', (d) => appendFileSync(join(OUT, 'daemon.err'), d));
  await new Promise<void>((res, rej) => { daemon!.stdout!.on('data', (d) => { if (/listening/.test(String(d))) res(); }); setTimeout(() => rej(new Error('start timeout')), 30000); });
}
const { apiCall } = await import('../core/src/daemon/api.ts');
const api = (m: string, p: string, b?: unknown) => apiCall(join(data, 'run/billyd.sock'), readFileSync(join(data, 'run/api.token'), 'utf8').trim(), m, p, b);
const stats = async () => (await fetch(`${recvUrl}/stats`)).json() as Promise<any>;
const control = (c: object) => fetch(`${recvUrl}/control`, { method: 'POST', body: JSON.stringify(c) }).catch(() => {});

await start(); daemon!.kill('SIGTERM'); await new Promise((r) => daemon!.once('exit', r));
const cfg = JSON.parse(readFileSync(join(data, 'config.json'), 'utf8'));
cfg.endpoints = [{ id: 'recv', base_url: recvUrl, account_id: 'acct', lookup_path: 'ops', supports_idempotency_keys: true }];
writeFileSync(join(data, 'config.json'), JSON.stringify(cfg, null, 2));
await start();
await api('PUT', '/v1/policy', { expires_at: new Date(Date.now() + 864e5).toISOString(), scope: {
  apps: [], file_roots: [ws], browser_profiles: [], domains: [], account_ids: ['acct'], tool_classes: ['file', 'api.message', 'worker', 'process', 'memory'],
  allowed_effects: ['READ_ONLY', 'IDEMPOTENT_WRITE', 'NON_IDEMPOTENT_EFFECT'], secret_references: [], network_destinations: [new URL(recvUrl).host],
  foreground: 'never', spend_scopes: [], protected_actions: [], delegation: { allowed: true, max_depth: 2 }, model_egress: [], recipients: ['*'] } });
const NODE = join(app, 'Contents/Resources/node/bin/node');

let seq = 0; let expectedSends = 0; const submitted: string[] = [];
function plan(kind: number, n: number) {
  const d = join(ws, `t${n}`); const tag = `soak-${run}-${n}`;
  switch (kind % 5) {
    case 0: return { steps: [{ step_key: 'mk', tool_id: 'proc.run', arguments: { workspace: ws, argv: ['/bin/sh', '-c', `mkdir -p t${n}`] } },
      { step_key: 'w', tool_id: 'fs.write', arguments: { path: join(d, 'a.txt'), content: tag, mode: 'create' } },
      { step_key: 'c', tool_id: 'fs.copy', arguments: { from: join(d, 'a.txt'), to: join(d, 'b.txt') } },
      { step_key: 'r', tool_id: 'fs.read', arguments: { path: join(d, 'b.txt') } }], criteria: [{ kind: 'file_contains', path: join(d, 'b.txt'), text: tag }] };
    case 1: expectedSends += 2; return { steps: [0, 1].map((i) => ({ step_key: `send-${i}`, tool_id: 'api.send_message', arguments: { endpoint_id: 'recv', account_id: 'acct', to: 'owner', body: `${tag} ${i}` } })), criteria: [] };
    case 2: return { steps: [{ step_key: 'mk', tool_id: 'proc.run', arguments: { workspace: ws, argv: ['/bin/sh', '-c', `mkdir -p t${n}`] } },
      { step_key: 'del', tool_id: 'agent.delegate', arguments: { goal: `child ${n}`, file_roots: [d], tool_classes: ['file'], planner: 'scripted',
        script: { steps: [{ kind: 'action', step_key: 'cw', tool_id: 'fs.write', arguments: { path: join(d, 'child.txt'), content: tag, mode: 'create' } }] },
        success_criteria: [{ kind: 'file_contains', path: join(d, 'child.txt'), text: tag }] } }], criteria: [] };
    case 3: return { steps: [{ step_key: 'mk', tool_id: 'proc.run', arguments: { workspace: ws, argv: ['/bin/sh', '-c', `mkdir -p t${n}`] } },
      { step_key: 'compute', tool_id: 'proc.run', arguments: { workspace: d, argv: [NODE, '-e', `require('fs').writeFileSync('sum.txt', String([...Array(100000).keys()].reduce((a,b)=>a+b,0)))`] } }],
      criteria: [{ kind: 'file_contains', path: join(d, 'sum.txt'), text: '4999950000' }] };
    default: return { steps: [{ step_key: 'note', tool_id: 'memory.note', arguments: { key: `soak-${n}`, value: tag } }, { step_key: 'q', tool_id: 'memory.search', arguments: { query: `soak ${n}` } }], criteria: [] };
  }
}
async function submit() {
  const n = seq++; const p = plan(n, n);
  const r = await api('POST', '/v1/tasks', { goal: `soak task ${n}`, client_message_id: `soak-${run}-${n}`, plan: { steps: p.steps }, success_criteria: p.criteria });
  if (r.status < 300) submitted.push(r.body.task_id); else log(`submit failed ${r.status} ${JSON.stringify(r.body)}`);
}

const samples: any[] = []; let recoveries = 0, stops = 0, maxReadyAgeS = 0;
async function sample() {
  try {
    const rss = Number(spawnSync('/bin/ps', ['-o', 'rss=', '-p', String(daemon!.pid)], { encoding: 'utf8' }).stdout.trim()) * 1024;
    const dbBytes = ['billy.db', 'billy.db-wal'].map((f) => existsSync(join(data, f)) ? statSync(join(data, f)).size : 0).reduce((a, b) => a + b, 0);
    const tasks = (await api('GET', '/v1/tasks?limit=200')).body as any[];
    const ready = tasks.filter((t) => t.status === 'READY').map((t) => (Date.now() - Date.parse(t.updated_at)) / 1000);
    maxReadyAgeS = Math.max(maxReadyAgeS, ...ready, 0);
    const by: Record<string, number> = {}; for (const t of tasks) by[t.status] = (by[t.status] ?? 0) + 1;
    samples.push({ at: new Date().toISOString(), rss, dbBytes, by });
  } catch (e) { log(`sample error ${(e as Error).message}`); }
}

const started = new Date();
const end = started.getTime() + MINUTES * 60_000;
let lastKill = Date.now(), lastStop = Date.now(), lastSubmit = 0, lastSample = 0;
log(`soak start: ${MINUTES} min, artifact ${ZIP_SHA.slice(0, 16)}`);
while (Date.now() < end) {
  if (Date.now() - lastSubmit > 110_000) { await submit(); await submit(); lastSubmit = Date.now(); if (seq % 6 === 0) await control({ mode: 'drop_after_commit', n: 1 }); if (seq % 8 === 0) await control({ mode: 'fail_before_commit', n: 1 }); }
  if (Date.now() - lastSample > 30_000) { await sample(); lastSample = Date.now(); }
  if (Date.now() - lastKill > 9 * 60_000) { daemon!.kill('SIGKILL'); await new Promise((r) => daemon!.once('exit', r)); await start(); recoveries++; lastKill = Date.now(); log('recovery event: SIGKILL + restart'); }
  if (Date.now() - lastStop > 13 * 60_000) { await api('POST', '/v1/stop', { reason: 'soak stop' }); await new Promise((r) => setTimeout(r, 15_000)); await api('POST', '/v1/stop/clear'); await api('POST', '/v1/tasks/resume-all'); stops++; lastStop = Date.now(); log('stop/resume cycle'); }
  await new Promise((r) => setTimeout(r, 1000));
}
log('workload window over; draining');
await control({ mode: 'normal' });
const drainEnd = Date.now() + 10 * 60_000;
let tasks: any[] = [];
while (Date.now() < drainEnd) {
  tasks = (await api('GET', '/v1/tasks?limit=200')).body;
  const live = tasks.filter((t) => !['COMPLETED', 'FAILED', 'CANCELLED'].includes(t.status));
  if (!live.length) break;
  if (live.every((t) => t.status === 'PAUSED_BY_OWNER')) await api('POST', '/v1/tasks/resume-all');
  await new Promise((r) => setTimeout(r, 5000));
}
await sample();
const finished = new Date();
const rec = await stats();
const sendKeys = readFileSync(join(OUT, 'receiver.jsonl'), 'utf8').trim().split('\n').filter(Boolean).length;
const q = Math.max(1, Math.floor(samples.length / 4));
const avg = (a: any[]) => a.reduce((s, x) => s + x.rss, 0) / a.length;
const rssFirst = avg(samples.slice(0, q)), rssLast = avg(samples.slice(-q));
const completed = tasks.filter((t) => t.status === 'COMPLETED').length;
const notDone = tasks.filter((t) => t.status !== 'COMPLETED').map((t) => `${t.task_id.slice(0, 8)}:${t.status}:${t.wait_reason ?? ''}`);
const report = {
  run, started_at: started.toISOString(), finished_at: finished.toISOString(), wall_minutes: (finished.getTime() - started.getTime()) / 60000,
  artifact_sha256: ZIP_SHA, tasks_submitted: submitted.length, tasks_completed: completed, not_completed: notDone,
  recovery_events: recoveries, stop_cycles: stops, expected_receiver_effects: expectedSends, receiver_effects: rec.effects, receiver_ledger_entries: sendKeys,
  rss_first_quarter_mb: rssFirst / 1e6, rss_last_quarter_mb: rssLast / 1e6, max_ready_age_s: maxReadyAgeS, samples: samples.length,
};
const pass = report.wall_minutes >= 60 && report.tasks_submitted >= 20 && completed === submitted.length && rec.effects === expectedSends
  && rssLast <= rssFirst * 1.5 + 30e6 && maxReadyAgeS < 300 && recoveries >= 3;
writeFileSync(join(OUT, 'report.json'), JSON.stringify({ ...report, pass, samples_detail: samples }, null, 2));
mkdirSync(join(ROOT, 'artifacts/measurements'), { recursive: true });
writeFileSync(join(ROOT, 'artifacts/measurements/T-REL-07.json'), JSON.stringify({ test_id: 'T-REL-07', report: join('artifacts/soak', run, 'report.json'), started_at: report.started_at, finished_at: report.finished_at, pass,
  measurements: { tasks: report.tasks_submitted, minutes: report.wall_minutes, recovery_events: recoveries, duplicate_effects: rec.effects - expectedSends } }, null, 2));
log(`soak ${pass ? 'PASS' : 'FAIL'}: ${JSON.stringify(report)}`);
daemon!.kill('SIGTERM'); recv.kill();
process.exit(pass ? 0 : 1);
