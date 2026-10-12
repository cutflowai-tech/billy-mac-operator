// Out-of-process core driver for crash boundaries beyond the broker:
// outbox, stop latch, scheduler, reconciliation and worker supervision.
//   node core-proc.ts <dataDir> <json>
import { join } from 'node:path';
import { Core } from '../../src/core.ts';
import { apiSendMessage, type Endpoint } from '../../src/tools/api.ts';
import { agentDelegate, agentCollect } from '../../src/tools/agents.ts';
import { WorkerManager } from '../../src/agents/workers.ts';
import type { Channel } from '../../src/notify/outbox.ts';

const [dataDir, json] = process.argv.slice(2);
const fx = JSON.parse(json);
const recv: string = fx.receiver;
const endpoints = new Map<string, Endpoint>([['fixture', { id: 'fixture', base_url: recv, account_id: 'acct', supports_idempotency_keys: true, lookup_path: 'ops' }]]);
const services: Record<string, unknown> = { endpoints };
const core = new Core({ dir: dataDir, allowUnsafeLocation: true, extraTools: [apiSendMessage, agentDelegate, agentCollect], services, maxConcurrent: 2 });
const out = (o: unknown) => process.stdout.write(JSON.stringify(o) + '\n');

const channel: Channel & { keyedDedup: boolean } = {
  id: 'recv', keyedDedup: true,
  async send(_d, p, key) {
    try {
      const r = await fetch(`${recv}/messages`, { method: 'POST', headers: { 'idempotency-key': `n-${key}` }, body: JSON.stringify(p), redirect: 'error' });
      if (r.status >= 500) return 'unknown';
      if (!r.ok) throw new Error(`status ${r.status}`);
      return await r.json();
    } catch (e) { if ((e as Error).message.startsWith('status')) throw e; return 'unknown'; }
  },
  async lookup(key) {
    try { const r = await fetch(`${recv}/ops/${encodeURIComponent(`n-${key}`)}`); const j: any = await r.json(); return j.found ? 'delivered' : 'absent'; } catch { return 'error'; }
  },
};
core.outbox.register(channel);

function grant(delegation = false) {
  const gid = crypto.randomUUID();
  core.policy.putGrant({ grant_id: gid, owner_id: 'owner', parent_grant_id: null, task_id: null, expires_at: '2099-01-01T00:00:00.000Z', source: 'harness', scope: {
    apps: [], file_roots: [fx.root], browser_profiles: [], domains: [], account_ids: ['acct'], tool_classes: ['file', 'api.message', 'worker'],
    allowed_effects: ['READ_ONLY', 'IDEMPOTENT_WRITE', 'NON_IDEMPOTENT_EFFECT'], secret_references: [], network_destinations: [new URL(recv).host],
    foreground: 'never', spend_scopes: [], protected_actions: [], delegation: { allowed: delegation, max_depth: delegation ? 2 : 0 }, model_egress: [], recipients: ['*'] } });
  return gid;
}

const sends = (n: number, tag: string) => Array.from({ length: n }, (_, i) => ({ kind: 'action', step_key: `send-${i}`, tool_id: 'api.send_message',
  arguments: { endpoint_id: 'fixture', account_id: 'acct', to: 'r', body: `${tag} ${i}` } }));

async function settle(ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    await core.executor.drain(ms).catch(() => {});
    core.control.finalizeCancellations();
    const live = (core.store.db.prepare(`SELECT count(*) c FROM tasks WHERE status NOT IN ('COMPLETED','FAILED','CANCELLED','PAUSED_BY_OWNER','BLOCKED_EXTERNAL')`).get() as any).c;
    if (!live) return;
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function main() {
  const m = fx.mode;
  if (m === 'outbox-setup') { grant(); core.outbox.enqueue(fx.key, 'recv', 'owner', 'Done', `notification ${fx.key}`); out({ ok: true }); return; }
  if (m === 'outbox-run') { await core.outbox.deliverDue(); out({ ok: true }); return; }
  if (m === 'outbox-recover') {
    await core.recover();
    for (let i = 0; i < 5; i++) { core.store.db.prepare(`UPDATE outbox SET next_attempt_at='1970-01-01T00:00:00.000Z' WHERE status IN ('PENDING','UNKNOWN')`).run(); await core.outbox.deliverDue(); }
    out({ outbox: core.store.db.prepare('SELECT status, attempts FROM outbox').all() }); return;
  }
  if (m === 'task-setup') {
    const g = grant();
    const id = core.tasks.create({ owner_id: 'owner', goal: 'harness', project_scope: 'fx', grant_id: g, success_criteria: { description: 'x', postconditions: [] } });
    core.executor.seedPlan(id, 1, 'scripted', { steps: sends(fx.steps ?? 3, fx.tag) });
    out({ task_id: id }); return;
  }
  if (m === 'run') { await core.recover(); await settle(); out({ status: core.store.taskStatus(fx.task_id) }); return; }
  if (m === 'run-stop') {
    await core.recover();
    core.executor.tick();
    for (let i = 0; i < 400 && !(core.store.db.prepare(`SELECT count(*) c FROM attempts WHERE status='DISPATCHING'`).get() as any).c; i++) await new Promise((r) => setTimeout(r, 5));
    const ack = core.control.stopAll('harness');
    out({ ack_at: ack.acknowledged_at }); return;
  }
  if (m === 'recover-only') {
    await core.recover(); core.executor.tick(); await new Promise((r) => setTimeout(r, 300));
    out({ status: core.store.taskStatus(fx.task_id), stopped: core.store.stopLatch().stopped,
      dispatched_after: (core.store.db.prepare(`SELECT count(*) c FROM attempts WHERE dispatched_at > ?`).get(fx.after ?? '9999') as any).c }); return;
  }
  if (m === 'agents-setup') {
    const g = grant(true);
    const id = core.tasks.create({ owner_id: 'owner', goal: 'parent', project_scope: 'fx', grant_id: g, success_criteria: { description: 'x', postconditions: [] } });
    core.executor.seedPlan(id, 1, 'scripted', { steps: [{ kind: 'action', step_key: 'delegate', tool_id: 'agent.delegate', arguments: {
      goal: 'child send', file_roots: [fx.root], tool_classes: ['api.message'], planner: 'scripted', script: { steps: sends(1, fx.tag) }, success_criteria: [{ kind: 'step_committed', step_key: 'send-0' }] } }] });
    out({ task_id: id }); return;
  }
  if (m === 'agents-run') {
    const mgr = new WorkerManager(core, join(fx.sock), { leaseMs: 1500, heartbeatMs: 200, maxWorkers: 2, killFenced: true });
    services.workers = mgr;
    await core.recover();
    await mgr.start(50);
    core.executor.start(50);
    const end = Date.now() + 25_000;
    while (Date.now() < end && !['COMPLETED', 'FAILED'].includes(core.store.taskStatus(fx.task_id))) await new Promise((r) => setTimeout(r, 50));
    await core.executor.stop(); await mgr.stop();
    out({ status: core.store.taskStatus(fx.task_id), workers: core.store.db.prepare('SELECT generation, status FROM workers').all() }); return;
  }
  throw new Error(`unknown mode ${m}`);
}
main().then(() => { core.close(); process.exit(0); }, (e) => { process.stderr.write(String(e?.stack ?? e)); process.exit(2); });
