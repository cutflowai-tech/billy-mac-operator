// Shared fixtures for broker-level tests: a Core over a temp store, an owner
// grant over a fixture root, and a RUNNING task bound to that grant.
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { Core, type CoreOptions } from '../src/core.ts';
import { Tasks } from '../src/tasks/tasks.ts';
import type { GrantScope } from '../src/policy/policy.ts';
import { tempDir } from './helpers.ts';
import { fsWrite } from '../src/tools/fs.ts';
import type { ToolAdapter } from '../src/broker/types.ts';

export function scope(over: Partial<GrantScope> = {}): GrantScope {
  return {
    apps: [], file_roots: [], browser_profiles: [], domains: [], account_ids: [], tool_classes: ['file'],
    allowed_effects: ['READ_ONLY', 'IDEMPOTENT_WRITE', 'NON_IDEMPOTENT_EFFECT'], secret_references: [],
    network_destinations: [], foreground: 'never', spend_scopes: [], protected_actions: [],
    delegation: { allowed: false, max_depth: 0 }, model_egress: [], recipients: ['*'], ...over,
  };
}

export interface Fx {
  core: Core; tasks: Tasks; root: string; outside: string; dir: string; grantId: string;
  task: (over?: Partial<{ grant_id: string | null; budget_scope: string | null }>) => string;
  run: (taskId: string) => void;
  proposal: (taskId: string, tool: string, args: Record<string, unknown>, step: string) => any;
  cleanup: () => void;
}

export function fixture(opts: Partial<CoreOptions> = {}, grantOver: Partial<GrantScope> = {}): Fx {
  const t = tempDir();
  const dir = realpathSync(t.dir);
  const root = join(dir, 'root');
  const outside = join(dir, 'outside');
  mkdirSync(root); mkdirSync(outside);
  const core = new Core({ dir: join(dir, 'data'), allowUnsafeLocation: true, ...opts });
  const tasks = new Tasks(core.store);
  const grantId = crypto.randomUUID();
  core.policy.putGrant({ grant_id: grantId, owner_id: 'owner', scope: scope({ file_roots: [root], ...grantOver }),
    parent_grant_id: null, task_id: null, expires_at: '2099-01-01T00:00:00.000Z', source: 'test-owner' });
  const fx: Fx = {
    core, tasks, root, outside, dir, grantId,
    task: (over = {}) => tasks.create({ owner_id: 'owner', goal: 'fixture', project_scope: 'fx',
      grant_id: over.grant_id === undefined ? grantId : over.grant_id, budget_scope: over.budget_scope ?? null,
      success_criteria: { description: 'fixture', postconditions: [] } }),
    run: (id) => { core.store.transitionTask(id, 'PLANNING'); core.store.transitionTask(id, 'READY'); core.store.transitionTask(id, 'RUNNING'); },
    proposal: (taskId, tool, args, step) => {
      const row = core.store.db.prepare('SELECT revision, cancellation_generation FROM tasks WHERE task_id=?').get(taskId) as any;
      return { task_id: taskId, task_revision: row.revision, cancellation_generation: row.cancellation_generation,
        actor_id: `core:${taskId}`, core_key: core.broker.coreKey, tool_id: tool, arguments: args, step_key: step };
    },
    cleanup: () => { core.close(); t.cleanup(); },
  };
  return fx;
}

/**
 * fs.write wrapper that counts real dispatches and can be held open mid-dispatch
 * (attempt persisted as DISPATCHING) so tests can snapshot state at that point.
 */
export function gatedWrite(toolId = 'fs.write_gated') {
  let release: () => void = () => {};
  let gate: Promise<void> = Promise.resolve();
  const g = {
    dispatches: 0,
    hold() { gate = new Promise<void>((r) => { release = r; }); },
    release() { release(); },
    tool: {
      ...fsWrite, spec: { ...fsWrite.spec, tool_id: toolId },
      async dispatch(a: any, r: any, ctx: any) { g.dispatches++; await gate; return fsWrite.dispatch(a, r, ctx); },
    } as ToolAdapter,
  };
  return g;
}

/** Poll (yielding to the event loop) until `cond` holds. */
export async function until(cond: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('condition not reached');
    await new Promise((r) => setTimeout(r, 2));
  }
}
