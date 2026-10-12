// REMOTE_LIVE (supervised): the owner's REAL phone, the real Telegram Bot API,
// and the real Billy daemon process on this Mac. The owner performs the phone
// side when prompted on this console. Prerequisites (setup packet):
//   S4  bot token in Keychain item com.billy.remote.telegram / bot, phone with Telegram
//       on a separate network (cellular, Wi-Fi off)
//   S1  Anthropic credential, S2 BILLY_LIVE_BUDGET_USD (phone goals are planned by the real model)
//   BILLY_REMOTE_LIVE=1  the owner is present to operate the phone
// Without them every test SKIPS (never a pass).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { STAMP } from '../stamp.ts';
import { DatabaseSync } from 'node:sqlite';
import { apiCall } from '../../src/daemon/api.ts';
import { Keychain, KNOWN_REFS } from '../../src/secrets/keychain.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const MAIN = join(import.meta.dirname, '..', '..', 'src', 'daemon', 'main.ts');
const MEAS = join(ROOT, 'artifacts/measurements'); mkdirSync(MEAS, { recursive: true });
const WAIT_MS = Number(process.env.BILLY_REMOTE_WAIT_MS ?? 10 * 60_000);
let unavailable: string | null = null;

const base = realpathSync(mkdtempSync('/tmp/billy-brl-'));
const data = join(base, 'd'); const ws = join(base, 'ws');
let child: ChildProcess | null = null;
let sock = '';
let token = '';

function say(msg: string) { process.stdout.write(`\n>>> OWNER ACTION: ${msg}\n`); writeFileSync(join(ROOT, 'artifacts/remote-live-prompt.txt'), msg + '\n'); }
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const call = (m: string, p: string, b?: unknown) => apiCall(sock, token, m, p, b);
async function until<T>(f: () => Promise<T | null | undefined | false> | T | null | undefined | false, what: string, ms = WAIT_MS): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await f(); if (v) return v as T; if (Date.now() > end) throw new Error(`timed out waiting for: ${what}`); await sleep(1000); }
}
function db() { return new DatabaseSync(join(data, 'billy.db'), { readOnly: true }); }
function rows(sql: string, ...p: any[]): any[] { const d = db(); try { return d.prepare(sql).all(...p) as any[]; } finally { d.close(); } }
function record(id: string, m: Record<string, number>, note: object = {}) {
  writeFileSync(join(MEAS, `${id}.json`), JSON.stringify({ test_id: id, lane: 'REMOTE_LIVE', measurements: m, at: new Date().toISOString(), ...STAMP, ...note }, null, 2));
}

async function startDaemon(faults = ''): Promise<void> {
  child = spawn(process.execPath, [MAIN, '--data-dir', data, '--allow-unsafe-location'], { stdio: ['ignore', 'pipe', 'inherit'], env: { ...process.env, BILLY_FAULT_POINTS: faults } });
  let out = '';
  child.stdout!.on('data', (b) => { out += b; });
  sock = await until(() => /listening on (\S+)/.exec(out)?.[1], 'daemon start', 30_000);
  token = readFileSync(join(data, 'run', 'api.token'), 'utf8').trim();
}
async function stopDaemon(): Promise<void> {
  if (!child || child.exitCode !== null) return;
  child.kill('SIGTERM');
  await until(() => child!.exitCode !== null || child!.signalCode !== null, 'daemon exit', 20_000);
}
const exited = () => !!child && (child.exitCode !== null || child.signalCode !== null);
const telegramTasks = () => rows(`SELECT t.task_id, t.status, r.source_command_id FROM tasks t JOIN task_revisions r ON r.task_id=t.task_id AND r.revision=1 WHERE r.source_command_id LIKE 'telegram:%' ORDER BY t.created_at`);
const activeDevice = () => rows(`SELECT platform_identity FROM devices WHERE channel='telegram' AND revoked_at IS NULL`)[0]?.platform_identity as string | undefined;

before(async () => {
  if (process.env.BILLY_REMOTE_LIVE !== '1') { unavailable = 'BILLY_REMOTE_LIVE=1 not set (owner must be present with the phone)'; return; }
  const kc = new Keychain();
  if (!kc.has(KNOWN_REFS.telegram)) { unavailable = 'S4: no Telegram bot token in Keychain (com.billy.remote.telegram / bot)'; return; }
  if (!kc.has(KNOWN_REFS.anthropic)) { unavailable = 'S1: no Anthropic credential in Keychain'; return; }
  const usd = Number(process.env.BILLY_LIVE_BUDGET_USD ?? NaN);
  if (!(usd > 0)) { unavailable = 'S2: BILLY_LIVE_BUDGET_USD not set'; return; }
  mkdirSync(ws, { recursive: true });
  await startDaemon();
  // Onboarding through the real local API.
  const scope = { apps: [], file_roots: [ws], browser_profiles: [], domains: [], account_ids: [], tool_classes: ['file'],
    allowed_effects: ['READ_ONLY', 'IDEMPOTENT_WRITE', 'NON_IDEMPOTENT_EFFECT'], secret_references: [], network_destinations: [], foreground: 'never',
    spend_scopes: ['provider-total'], protected_actions: [], delegation: { allowed: false, max_depth: 0 }, model_egress: ['anthropic'], recipients: [] };
  assert.equal((await call('PUT', '/v1/policy', { scope, expires_at: new Date(Date.now() + 86400000).toISOString() })).status, 200);
  assert.equal((await call('PUT', '/v1/budget', { scope: 'provider-total', ceiling_usd: usd, period: 'total' })).status, 200);
  assert.equal((await call('PUT', '/v1/provider', { kind: 'anthropic_api' })).status, 200);
  assert.equal((await call('PUT', '/v1/remote/telegram', { enabled: true })).status, 200);
  const pair = await call('POST', '/v1/remote/telegram/pairing');
  assert.equal(pair.status, 200, JSON.stringify(pair.body));
  say(`On your phone (Wi-Fi OFF, cellular only), open a private chat with your Billy bot and send exactly:\n/pair ${pair.body.code}`);
  await until(() => activeDevice(), 'phone pairing');
});

after(async () => { await stopDaemon(); });

test('T-REMOTE-01 T-REMOTE-02: phone command -> one owner-bound task completes on the Mac; progress and result delivered to the phone', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const target = join(ws, 'phone-check.txt');
  const n0 = telegramTasks().length;
  say(`Send this message to the bot:\nCreate a file named phone-check.txt in ${ws} containing exactly: sent from my phone`);
  const task = await until(() => telegramTasks()[n0], 'phone command admission');
  const done = await until(async () => { const s = (await call('GET', `/v1/tasks/${task.task_id}`)).body; return ['COMPLETED', 'FAILED', 'BLOCKED_EXTERNAL'].includes(s.status) ? s : null; }, 'task completion');
  assert.equal(done.status, 'COMPLETED', JSON.stringify(done.result));
  assert.equal(readFileSync(target, 'utf8').trim(), 'sent from my phone');
  assert.equal(telegramTasks().length, n0 + 1, 'exactly one task for one phone command');
  const owner = activeDevice()!;
  // Delivery receipts from the real Bot API for this task's notifications.
  const sent = await until(() => { const r = rows(`SELECT status, payload_json, receipt_json FROM outbox WHERE channel='telegram' AND destination=? AND payload_json LIKE ?`, owner, `%${task.task_id}%`);
    return r.some((x) => x.status === 'DELIVERED' && /complet/i.test(x.payload_json)) ? r : null; }, 'completion notification delivered');
  for (const r of sent) assert.doesNotMatch(r.payload_json, /sk-ant-|\d{8,10}:[A-Za-z0-9_-]{30,}/, 'no secret in notifications');
  say('Check the phone shows the "Got it" and completion messages for phone-check.txt (receipts above are from the Bot API).');
  record('T-REMOTE-01', { tasks: 1, completed: 1 }, { task_id: task.task_id, source: task.source_command_id });
  record('T-REMOTE-02', { delivered: sent.filter((x) => x.status === 'DELIVERED').length, leaked_secrets: 0 }, { receipts: sent.map((x) => JSON.parse(x.receipt_json ?? 'null')) });
});

test('T-REMOTE-03: transport interrupted after Mac admission, message redelivered -> exactly one task/effect', async (t) => {
  if (unavailable) return t.skip(unavailable);
  // Arm the crash window: the daemon dies after admitting the next update but before confirming its offset.
  await stopDaemon(); await startDaemon('telegram.after_handle:1');
  const n0 = telegramTasks().length;
  say(`Send this message to the bot:\nCreate a file named once-only.txt in ${ws} containing exactly: one`);
  await until(() => exited(), 'daemon crash inside the admission window');
  assert.equal(telegramTasks().length, n0 + 1, 'admitted before the crash');
  // Restart: Telegram redelivers the unconfirmed update with the same message identity.
  await startDaemon();
  const dup = await until(() => rows(`SELECT entity_id FROM events WHERE domain='inbox' AND kind='duplicate' AND entity_id LIKE 'telegram:%'`)[0], 'Telegram redelivery recognised as a duplicate', 120_000);
  const task = telegramTasks()[n0];
  await until(async () => ['COMPLETED', 'FAILED', 'BLOCKED_EXTERNAL'].includes((await call('GET', `/v1/tasks/${task.task_id}`)).body.status), 'completion');
  assert.equal(telegramTasks().length, n0 + 1, 'redelivered message did not create a second task');
  const writes = rows(`SELECT count(*) c FROM attempts WHERE task_id=? AND tool_id='fs.write' AND status='COMMITTED'`, task.task_id)[0].c;
  assert.equal(writes, 1);
  assert.equal(readFileSync(join(ws, 'once-only.txt'), 'utf8').trim(), 'one');
  record('T-REMOTE-03', { tasks: 1, effects: writes }, { redelivered: dup.entity_id });
});

test('T-REMOTE-04: revoked device -> old-session requests rejected before dispatch; owner can inspect revocation locally', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const owner = activeDevice()!;
  const rev = await call('POST', `/v1/remote/devices/${owner}/revoke`);
  assert.equal(rev.status, 200);
  assert.ok(rev.body.find((d: any) => d.platform_identity === owner).revoked_at, 'revocation visible to the local owner');
  const n0 = telegramTasks().length;
  const rej0 = rows(`SELECT count(*) c FROM events WHERE domain='remote' AND kind='rejected'`)[0].c;
  say(`Send this message to the bot (it must be REJECTED):\nCreate a file named should-not-exist.txt in ${ws} containing exactly: no`);
  await until(() => rows(`SELECT count(*) c FROM events WHERE domain='remote' AND kind='rejected'`)[0].c > rej0, 'rejection');
  await sleep(5000);
  assert.equal(telegramTasks().length, n0, 'no task admitted from a revoked device');
  assert.equal(existsSync(join(ws, 'should-not-exist.txt')), false);
  record('T-REMOTE-04', { rejected: 1, admitted: 0 });
  // Re-pair for the remaining scenario.
  const pair = await call('POST', '/v1/remote/telegram/pairing');
  say(`Re-pair: send exactly\n/pair ${pair.body.code}`);
  await until(() => activeDevice(), 're-pairing');
});

test('T-REMOTE-06: stop sent while the phone is offline is enforced when it arrives; latch preserved; no early success claim', async (t) => {
  if (unavailable) return t.skip(unavailable);
  // A long-running fixture task keeps the Mac busy while the phone is offline.
  const t0 = await call('POST', '/v1/tasks', { goal: 'fixture: slow writes', client_message_id: `rl-${Date.now()}`,
    plan: { steps: Array.from({ length: 40 }, (_, i) => ({ step_key: `w${i}`, tool_id: 'fs.write', arguments: { path: join(ws, `slow-${i}.txt`), content: String(i), mode: 'create' } })) } });
  assert.equal(t0.status, 201, JSON.stringify(t0.body));
  say('Turn on Airplane Mode on the phone, send /stop to the bot (it will show as pending/clock icon), wait 20 seconds, then turn Airplane Mode off.');
  const lat0 = rows(`SELECT count(*) c FROM events WHERE domain='control' AND kind='stop'`)[0].c;
  const stopAt = await until(() => { const r = rows(`SELECT at FROM events WHERE domain='control' AND kind='stop' ORDER BY seq DESC LIMIT 1`); return rows(`SELECT count(*) c FROM events WHERE domain='control' AND kind='stop'`)[0].c > lat0 ? r[0].at : null; }, 'stop arrival');
  const st = (await call('GET', '/v1/status')).body.stop;
  assert.equal(st.stopped, true, 'latch set');
  const after = rows(`SELECT count(*) c FROM attempts WHERE task_id=? AND created_at > ?`, t0.body.task_id, stopAt)[0].c;
  await sleep(5000);
  assert.equal(rows(`SELECT count(*) c FROM attempts WHERE task_id=? AND created_at > ?`, t0.body.task_id, stopAt)[0].c, after, 'no new effects after the stop barrier');
  assert.equal((await call('GET', '/v1/status')).body.stop.stopped, true, 'latch preserved');
  say('Confirm the phone received "Stopped on the Mac" only AFTER Airplane Mode was turned off.');
  record('T-REMOTE-06', { latch_preserved: 1, effects_after_stop: 0 }, { stop_at: stopAt });
  await call('POST', '/v1/stop/clear');
});
