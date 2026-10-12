// app.launch: start (or find) a granted app in the background without taking focus.
import type { ToolAdapter } from '../../broker/types.ts';
import { bundleArg, call, mapErr, pidFor, svc, toolSpec } from './common.ts';

export const appLaunch: ToolAdapter = {
  spec: toolSpec({ tool_id: 'app.launch', description: 'Launch a granted app in the background (does not take focus)', effect_class: 'IDEMPOTENT_WRITE', idempotency: 'inherent',
    tool_class: 'app', input_schema: { type: 'object', required: ['bundle_id'], properties: { bundle_id: bundleArg, open_paths: { type: 'array', maxItems: 8, items: { type: 'string', pattern: '^/', maxLength: 1024 } } } } }),
  paths: (a) => a.open_paths ?? [],
  resolve(a) { return { resource_id: `app:${a.bundle_id}`, account_id: null, facts: { app: a.bundle_id, ...(a.open_paths?.length ? { file_paths: a.open_paths } : {}) }, claims: [] }; },
  preconditions: () => ({ ok: true }),
  postconditions: (a) => [{ kind: 'app_running', bundle_id: a.bundle_id }],
  async dispatch(a, _r, ctx) {
    const d = svc(ctx);
    try {
      const sc = await call(d, 'launch_app', { bundle_id: a.bundle_id, ...(a.open_paths?.length ? { urls: a.open_paths } : {}) });
      return { outcome: 'success', receipt: { pid: sc.pid ?? null } };
    } catch (e) { return mapErr(e); }
  },
  async verify(a, _r, _p, _rc, ctx) { const pid = await pidFor(svc(ctx), a.bundle_id).catch(() => null); return { verdict: pid ? 'verified' : 'failed', evidence: { pid } }; },
  async reconcile(a, _r, _p, ctx) { const pid = await pidFor(svc(ctx), a.bundle_id).catch(() => null); return { status: pid ? 'applied' : 'not_applied', evidence: { pid } }; },
};
