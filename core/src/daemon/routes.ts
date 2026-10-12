// Owner API routes. All task-creating commands go through the inbox (dedup by
// client_message_id) so local, remote and voice commands share one admission path.
import type { Core } from '../core.ts';
import { ApiError, type LocalApi } from './api.ts';
import { assertValid, type Schema } from '../contracts/schema.ts';
import { GRANT_SCOPE_SCHEMA, type GrantScope } from '../policy/policy.ts';
import { saveConfig, type BillyConfig } from './config.ts';
import { doctor, type Check } from './doctor.ts';
import type { SecretStore } from '../secrets/keychain.ts';

export interface RouteDeps {
  core: Core;
  cfg: BillyConfig;
  dataDir: string;
  secrets: SecretStore;
  startedAt: string;
  extraChecks?: () => Check[];
  onConfigChanged?: (cfg: BillyConfig) => void;
  onGrantChanged?: () => void;
}

const COMMAND: Schema = {
  type: 'object', required: ['goal', 'client_message_id'],
  properties: {
    goal: { type: 'string', minLength: 1, maxLength: 8000 },
    client_message_id: { type: 'string', minLength: 8, maxLength: 128 },
    project_scope: { type: 'string', pattern: '^[a-z0-9][a-z0-9._-]{0,63}$' },
    locale: { type: 'string', maxLength: 16 },
    source: { enum: ['local-app', 'voice', 'cli'] },
    plan: { type: 'object', required: ['steps'], properties: { steps: { type: 'array', minItems: 1, maxItems: 50, items: { type: 'object', additionalProperties: true } }, summary: { type: 'string', maxLength: 500 } } },
    success_criteria: { type: 'array', maxItems: 16, items: { type: 'object', additionalProperties: true } },
  },
};

/** Shared admission used by local, voice, CLI and (with its own identity check) remote channels. */
export function admitOwnerCommand(d: RouteDeps, source: string, messageId: string, senderId: string, goal: string, opts: { project_scope?: string; locale?: string; plan?: { steps: any[]; summary?: string }; success_criteria?: any[] } = {}) {
  const { core, cfg } = d;
  return core.inbox.admit(source, messageId, senderId, 'ADMITTED', () => {
    const id = core.tasks.create({ owner_id: cfg.owner_id, goal, project_scope: opts.project_scope ?? cfg.default_project_scope,
      grant_id: cfg.default_grant_id, budget_scope: cfg.provider.budget_scope, locale: opts.locale ?? null,
      source_command_id: `${source}:${messageId}`,
      success_criteria: { description: goal, postconditions: opts.success_criteria ?? [] } });
    // An owner-supplied fixed plan (routine automation) runs on the scripted planner; every step still passes the broker.
    if (opts.plan) core.executor.seedPlan(id, 1, 'scripted', { steps: opts.plan.steps.map((s: any) => ({ kind: 'action', step_key: String(s.step_key), tool_id: String(s.tool_id), arguments: s.arguments ?? {} })), summary: opts.plan.summary });
    else core.executor.seedPlan(id, 1, 'model', null);
    core.notify('admitted', id, `Got it: ${goal.slice(0, 140)}`);
    return { task_id: id, revision: 1 };
  });
}

export function taskView(core: Core, id: string, detail = false): any {
  const t = core.tasks.get(id);
  if (!t) return null;
  const base = { task_id: t.task_id, status: t.status, goal: t.goal, revision: t.revision, project_scope: t.project_scope,
    created_at: t.created_at, updated_at: t.updated_at, wait_reason: t.wait_reason, parent_task_id: t.parent_task_id,
    result: t.result_json ? JSON.parse(t.result_json) : null };
  if (!detail) return base;
  const attempts = core.store.db.prepare(`SELECT attempt_id, attempt_no, tool_id, status, error, uncertainty, created_at, dispatched_at,
    json_extract(envelope_json,'$.step_key') step_key, json_extract(envelope_json,'$.target.resource_id') target
    FROM attempts WHERE task_id=? ORDER BY created_at`).all(id);
  const events = core.store.db.prepare(`SELECT seq, kind, payload_json, at FROM events WHERE entity_id=? ORDER BY seq`).all(id)
    .map((e: any) => ({ seq: e.seq, kind: e.kind, at: e.at, payload: JSON.parse(e.payload_json) }));
  return { ...base, success_criteria: t.success_criteria, attempts, events };
}

export function installRoutes(api: LocalApi, d: RouteDeps): void {
  const { core } = d;
  const need = (id: string) => { if (!core.tasks.get(id)) throw new ApiError(404, 'unknown task'); return id; };

  api.route('GET', /^\/v1\/status$/, () => {
    const counts = Object.fromEntries((core.store.db.prepare('SELECT status, count(*) c FROM tasks GROUP BY status').all() as any[]).map((r) => [r.status, r.c]));
    const desk = core.store.db.prepare(`SELECT holder FROM resource_claims WHERE resource_key LIKE 'desktop:%' LIMIT 1`).get() as any;
    const last = (core.store.db.prepare('SELECT max(seq) s FROM events').get() as any).s ?? 0;
    return { body: { pid: process.pid, started_at: d.startedAt, stop: core.store.stopLatch(), tasks: counts,
      provider: d.cfg.provider.kind, timezone: d.cfg.timezone, schema: core.store.schemaVersion(), device_id: d.cfg.device_id,
      desktop_owner: desk ? 'billy' : null, last_seq: last } };
  });
  api.route('GET', /^\/v1\/doctor$/, () => ({ body: doctor(core, d.cfg, d.dataDir, d.secrets, d.extraChecks?.() ?? []) }));
  api.route('GET', /^\/v1\/tasks$/, ({ query }) => {
    const limit = Math.min(200, Number(query.get('limit') ?? 50));
    const rows = core.store.db.prepare('SELECT task_id FROM tasks WHERE parent_task_id IS NULL ORDER BY created_at DESC LIMIT ?').all(limit) as any[];
    return { body: rows.map((r) => taskView(core, r.task_id)) };
  });
  api.route('GET', /^\/v1\/tasks\/([0-9a-f-]{36})$/, ({ params }) => ({ body: taskView(core, need(params[0]), true) }));
  api.route('POST', /^\/v1\/tasks$/, ({ body }) => {
    const b = assertValid<any>(COMMAND, body, 'command');
    const r = admitOwnerCommand(d, b.source ?? 'local-app', b.client_message_id, d.cfg.owner_id, b.goal, b);
    return { status: r.duplicate ? 200 : 201, body: { ...r, task: r.task_id ? taskView(core, r.task_id) : null } };
  });
  api.route('POST', /^\/v1\/tasks\/([0-9a-f-]{36})\/(pause|resume|cancel)$/, ({ params }) => {
    const [id, op] = params; need(id);
    if (op === 'pause') core.control.pause(id, 'local-app');
    else if (op === 'resume') core.control.resume(id, 'local-app');
    else core.control.cancel(id, 'local-app');
    core.control.finalizeCancellations();
    return { body: taskView(core, id) };
  });
  api.route('POST', /^\/v1\/tasks\/([0-9a-f-]{36})\/revise$/, ({ params, body }) => {
    const b = assertValid<any>(COMMAND, body, 'revision');
    const id = need(params[0]);
    const r = core.inbox.admit('local-app', b.client_message_id, d.cfg.owner_id, 'CONTROL', () => {
      const rev = core.control.revise(id, b.goal, { description: b.goal, postconditions: [] }, `local-app:${b.client_message_id}`);
      core.executor.seedPlan(id, rev, 'model', null);
      return { task_id: id, revision: rev };
    });
    return { body: { ...r, task: taskView(core, id) } };
  });
  api.route('POST', /^\/v1\/tasks\/(pause|resume)-all$/, ({ params }) => {
    const op = params[0];
    const rows = core.store.db.prepare(op === 'pause'
      ? `SELECT task_id FROM tasks WHERE status IN ('READY','RUNNING','PLANNING','RECEIVED','VERIFYING','RECONCILING') OR status LIKE 'WAITING_%'`
      : `SELECT task_id FROM tasks WHERE status='PAUSED_BY_OWNER'`).all() as any[];
    const done: string[] = [];
    for (const r of rows) { try { op === 'pause' ? core.control.pause(r.task_id, 'local-app') : core.control.resume(r.task_id, 'local-app'); done.push(r.task_id); } catch { /* illegal from current state: skip */ } }
    return { body: { [op === 'pause' ? 'paused' : 'resumed']: done } };
  });
  api.route('POST', /^\/v1\/stop$/, ({ body }) => ({ body: core.control.stopAll('local-app', body?.reason ?? 'owner pressed stop') }));
  api.route('POST', /^\/v1\/stop\/clear$/, () => { core.control.clearStop('local-app'); return { body: core.store.stopLatch() }; });
  api.route('GET', /^\/v1\/policy$/, () => ({ body: d.cfg.default_grant_id ? core.policy.current(d.cfg.default_grant_id, true) : null }));
  api.route('PUT', /^\/v1\/policy$/, ({ body }) => {
    const scope = assertValid<GrantScope>(GRANT_SCOPE_SCHEMA, body?.scope, 'grant scope');
    const expires = String(body?.expires_at ?? '');
    if (!/^\d{4}-\d{2}-\d{2}T/.test(expires) || Date.parse(expires) <= Date.now()) throw new ApiError(400, 'expires_at must be a future UTC timestamp');
    const gid = d.cfg.default_grant_id ?? crypto.randomUUID();
    const g = core.policy.putGrant({ grant_id: gid, owner_id: d.cfg.owner_id, scope, parent_grant_id: null, task_id: null,
      expires_at: new Date(expires).toISOString(), source: 'local-app-owner' });
    if (!d.cfg.default_grant_id) { d.cfg.default_grant_id = gid; saveConfig(d.dataDir, d.cfg); d.onConfigChanged?.(d.cfg); }
    // A revised grant changes revision: queued actions under the old revision are refused at dispatch.
    d.onGrantChanged?.();
    core.executor.wake('grant_changed');
    return { body: g };
  });
  api.route('GET', /^\/v1\/budget$/, () => {
    const rows = core.store.db.prepare('SELECT scope, ceiling_micros, period, updated_at FROM budgets').all() as any[];
    return { body: rows.map((r) => ({ ...r, remaining_micros: core.budget.remaining(r.scope) })) };
  });
  api.route('PUT', /^\/v1\/budget$/, ({ body }) => {
    const b = assertValid<any>({ type: 'object', required: ['scope', 'ceiling_usd', 'period'], properties: {
      scope: { type: 'string', pattern: '^[a-z0-9._-]{1,64}$' }, ceiling_usd: { type: 'number', minimum: 0, maximum: 100000 },
      period: { enum: ['total', 'daily'] } } }, body, 'budget');
    core.budget.setCeiling(b.scope, Math.round(b.ceiling_usd * 1e6), b.period, 'local-app-owner');
    core.executor.wake('budget_changed');
    return { body: { scope: b.scope, remaining_micros: core.budget.remaining(b.scope) } };
  });
  api.route('GET', /^\/v1\/events$/, ({ query }) => {
    const after = Number(query.get('after') ?? 0);
    const rows = core.store.db.prepare(`SELECT seq, domain, entity_id, kind, at FROM events WHERE seq > ? ORDER BY seq LIMIT 500`).all(after);
    return { body: rows };
  });
}
