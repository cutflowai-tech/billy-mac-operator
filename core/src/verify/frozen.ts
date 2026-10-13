// Verifier that also enforces planner-proposed criteria frozen before the first
// action of a revision (stored in plan state), in addition to owner criteria.
import type { Store } from '../store/db.ts';
import type { TaskVerifier, StepRecord } from '../scheduler/executor.ts';
import { CriteriaVerifier } from './taskVerifier.ts';
import { PolicyStore } from '../policy/policy.ts';
import type { Condition } from '../contracts/action.ts';

export class FrozenCriteriaVerifier implements TaskVerifier {
  private store: Store;
  private inner: CriteriaVerifier;
  constructor(store: Store, inner = new CriteriaVerifier([], new PolicyStore(store))) { this.store = store; this.inner = inner; }
  async verify(task: any, history: StepRecord[]) {
    const plan = this.store.db.prepare('SELECT state_json FROM plans WHERE task_id=? AND revision=?').get(task.task_id, task.revision) as any;
    const frozen = plan ? (JSON.parse(plan.state_json ?? 'null')?.frozen_criteria ?? []) : [];
    const merged = { ...task, success_criteria: { ...task.success_criteria, postconditions: [...(task.success_criteria?.postconditions ?? []), ...frozen] } };
    const failedEffects = history.filter((h) => h.verdict === 'FAILED').length;
    const r = await this.inner.verify(merged, history);
    return { ...r, evidence: { criteria: r.evidence, frozen_count: frozen.length, failed_attempts: failedEffects } };
  }
  /** Which of `conditions` hold right now, each checked exactly as at completion (authority included). */
  async holds(task: any, conditions: Condition[], history: StepRecord[]): Promise<boolean[]> {
    const r = await this.inner.verify({ ...task, success_criteria: { ...task.success_criteria, postconditions: conditions } }, history);
    return (r.evidence as { ok: boolean }[]).map((x) => !!x.ok);
  }
}
