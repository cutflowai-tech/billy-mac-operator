// Task-level completion verifier (§7.5): checks the success criteria frozen
// with the task revision against actual state, independently of any planner or
// worker claim.
import type { TaskVerifier, StepRecord } from '../scheduler/executor.ts';
import { verifyFileConditions } from '../tools/fs.ts';
import type { Condition } from '../contracts/action.ts';
import { isAbsolute, dirname, basename, resolve } from 'node:path';
import { lstatSync, realpathSync } from 'node:fs';
import { pathWithinRoots, type PolicyStore } from '../policy/policy.ts';

export type ConditionChecker = (c: Condition, history: StepRecord[]) => Promise<{ ok: boolean; got: unknown } | null>;

export class CriteriaVerifier implements TaskVerifier {
  private extra: ConditionChecker[];
  private policy: PolicyStore | undefined;
  constructor(extra: ConditionChecker[] = [], policy?: PolicyStore) { this.extra = extra; this.policy = policy; }

  private authorizedFile(task: any, c: Condition): boolean {
    if (typeof c.path !== 'string' || !isAbsolute(c.path) || c.path.includes('\0')) return false;
    const grant = task.grant_id ? this.policy?.effective(task.grant_id) : null;
    if (!grant || grant.expires_at <= new Date().toISOString() || !grant.scope.allowed_effects.includes('READ_ONLY')
      || !grant.scope.tool_classes.includes('file')) return false;
    const path = resolve(c.path);
    // Check authority before any filesystem probe (including existence).
    if (!pathWithinRoots(path, grant.scope.file_roots)) return false;
    let existing = path;
    const suffix: string[] = [];
    try {
      for (;;) {
        try {
          const st = lstatSync(existing);
          if (st.isSymbolicLink()) return false;
          break;
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || dirname(existing) === existing) return false;
          suffix.unshift(basename(existing)); existing = dirname(existing);
        }
      }
      return !!pathWithinRoots(resolve(realpathSync(existing), ...suffix), grant.scope.file_roots);
    } catch { return false; }
  }

  async verify(task: any, history: StepRecord[]) {
    const post: Condition[] = task.success_criteria?.postconditions ?? [];
    const results: unknown[] = [];
    let ok = true;
    for (const c of post) {
      if (['file_sha256', 'file_contains', 'file_absent'].includes(c.kind) && !this.authorizedFile(task, c)) {
        results.push({ condition: c, ok: false, got: 'criterion outside current file authority' });
        ok = false;
        continue;
      }
      let r: { ok: boolean; got: unknown } | null = null;
      for (const x of this.extra) { r = await x(c, history); if (r) break; }
      if (!r) {
        // A step of an earlier revision cannot satisfy the current revision's criteria.
        if (c.kind === 'step_committed') r = { ok: history.some((h) => h.step_key === c.step_key && h.verdict === 'COMMITTED' && (h.revision ?? task.revision) === task.revision), got: null };
        else { const v = verifyFileConditions([c]); r = { ok: v.verdict === 'verified', got: v.evidence }; }
      }
      results.push({ condition: c, ...r });
      ok &&= r.ok;
    }
    return { ok, evidence: results, reason: ok ? undefined : 'one or more postconditions failed' };
  }

  /** Which of `conditions` hold right now, each checked exactly as at completion (authority included). */
  async holds(task: any, conditions: Condition[], history: StepRecord[]): Promise<boolean[]> {
    const r = await this.verify({ ...task, success_criteria: { ...task.success_criteria, postconditions: conditions } }, history);
    return (r.evidence as { ok: boolean }[]).map((x) => !!x.ok);
  }
}
