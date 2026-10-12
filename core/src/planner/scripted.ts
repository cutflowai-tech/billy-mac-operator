// Deterministic planner: executes a fixed list of steps stored as durable plan
// state. Used for fixture workflows, routine owner automations, and tests. A
// step is skipped once a committed/deduplicated attempt exists for its key.
import type { Planner, PlanContext, PlanStep } from '../scheduler/executor.ts';

export interface ScriptState { steps: Extract<PlanStep, { kind: 'action' }>[]; summary?: string }

export const scriptedPlanner: Planner = {
  id: 'scripted',
  async next(ctx: PlanContext) {
    const st = ctx.state as ScriptState | null;
    if (!st || !Array.isArray(st.steps)) return { step: { kind: 'fail', reason: 'no script' }, state: st };
    const done = new Set(ctx.history.filter((h) => h.verdict === 'COMMITTED').map((h) => h.step_key));
    const next = st.steps.find((s) => !done.has(s.step_key));
    if (!next) return { step: { kind: 'done', summary: st.summary ?? `completed ${st.steps.length} steps` }, state: st };
    if (ctx.lastFailure && ctx.lastFailure.step_key === next.step_key && ctx.replans >= 2) {
      return { step: { kind: 'fail', reason: `step ${next.step_key} failed: ${ctx.lastFailure.reason}` }, state: st };
    }
    return { step: next, state: st };
  },
};
