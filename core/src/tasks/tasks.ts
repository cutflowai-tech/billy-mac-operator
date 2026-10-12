// Task identity, revisions, dependency graph (handoff §7, §9.2).
import { digest, newId } from '../util/canon.ts';
import type { Store } from '../store/db.ts';
import { TASK_TERMINAL, type TaskState } from '../domain/machines.ts';
import type { Condition } from '../contracts/action.ts';

export interface SuccessCriteria {
  description: string;
  postconditions: Condition[];   // frozen at admission; a later revision may change them, a worker may not
  requires_delivery?: { channel: string; destination: string } | null;
}

export interface NewTask {
  owner_id: string;
  goal: string;
  project_scope: string;
  grant_id: string | null;
  budget_scope?: string | null;
  parent_task_id?: string | null;
  success_criteria: SuccessCriteria;
  source_command_id?: string | null;
  locale?: string | null;
}

export class CycleError extends Error {}

export class Tasks {
  private store: Store;
  constructor(store: Store) { this.store = store; }

  create(t: NewTask): string {
    const id = newId();
    this.store.tx(() => {
      const now = this.store.now();
      this.store.db.prepare(`INSERT INTO tasks(task_id, owner_id, parent_task_id, project_scope, revision, status,
        cancellation_generation, grant_id, budget_scope, locale, created_at, updated_at)
        VALUES (?,?,?,?,1,'RECEIVED',0,?,?,?,?,?)`).run(id, t.owner_id, t.parent_task_id ?? null, t.project_scope,
        t.grant_id, t.budget_scope ?? null, t.locale ?? null, now, now);
      this.store.db.prepare(`INSERT INTO task_revisions VALUES (?,?,?,?,?,?,?)`).run(id, 1, t.goal,
        JSON.stringify(t.success_criteria), digest(t.success_criteria), t.source_command_id ?? null, now);
      if (t.parent_task_id) this.addEdge(t.parent_task_id, id, 'child');
      this.store.event('task', id, 'created', { project_scope: t.project_scope, parent: t.parent_task_id ?? null });
    });
    return id;
  }

  get(id: string): any {
    const t = this.store.db.prepare('SELECT * FROM tasks WHERE task_id=?').get(id) as any;
    if (!t) return null;
    const rev = this.store.db.prepare('SELECT * FROM task_revisions WHERE task_id=? AND revision=?').get(id, t.revision) as any;
    return { ...t, goal: rev.goal, success_criteria: JSON.parse(rev.success_criteria_json), success_criteria_digest: rev.success_criteria_digest };
  }

  /** Owner-only: a new revision invalidates in-flight plans (broker checks revision). */
  revise(id: string, goal: string, criteria: SuccessCriteria, sourceCommandId: string | null): number {
    return this.store.tx(() => {
      const t = this.store.db.prepare('SELECT revision, status FROM tasks WHERE task_id=?').get(id) as any;
      if (TASK_TERMINAL.has(t.status)) throw new Error('terminal task revisions are immutable; create a follow-up task');
      const rev = t.revision + 1;
      this.store.db.prepare('INSERT INTO task_revisions VALUES (?,?,?,?,?,?,?)').run(id, rev, goal, JSON.stringify(criteria),
        digest(criteria), sourceCommandId, this.store.now());
      this.store.db.prepare('UPDATE tasks SET revision=?, updated_at=? WHERE task_id=?').run(rev, this.store.now(), id);
      this.store.event('task', id, 'revised', { revision: rev });
      return rev;
    });
  }

  /** Criteria are bound to a revision; workers cannot rewrite them (T-ACTION-08). */
  criteriaDigest(id: string, revision: number): string {
    return (this.store.db.prepare('SELECT success_criteria_digest d FROM task_revisions WHERE task_id=? AND revision=?').get(id, revision) as any).d;
  }

  addEdge(parent: string, child: string, kind: 'child' | 'depends_on'): void {
    this.store.tx(() => {
      if (parent === child) throw new CycleError('self edge');
      // Reject cycles: is `parent` reachable from `child`?
      const reach = this.store.db.prepare(`WITH RECURSIVE r(n) AS (SELECT ? UNION SELECT e.child_task_id FROM task_edges e JOIN r ON e.parent_task_id = r.n)
        SELECT 1 FROM r WHERE n = ? LIMIT 1`).get(child, parent);
      if (reach) throw new CycleError(`edge ${parent}->${child} would create a cycle`);
      const dup = this.store.db.prepare('SELECT 1 FROM task_edges WHERE parent_task_id=? AND child_task_id=? AND kind=?').get(parent, child, kind);
      if (dup) throw new Error('duplicate logical edge');
      this.store.db.prepare('INSERT INTO task_edges VALUES (?,?,?)').run(parent, child, kind);
    });
  }

  dependenciesSatisfied(id: string): boolean {
    const r = this.store.db.prepare(`SELECT count(*) c FROM task_edges e JOIN tasks t ON t.task_id = e.parent_task_id
      WHERE e.child_task_id=? AND e.kind='depends_on' AND t.status <> 'COMPLETED'`).get(id) as any;
    return r.c === 0;
  }

  descendants(id: string): string[] {
    return (this.store.db.prepare(`WITH RECURSIVE r(n) AS (SELECT ? UNION SELECT e.child_task_id FROM task_edges e JOIN r ON e.parent_task_id=r.n AND e.kind='child')
      SELECT n FROM r WHERE n <> ?`).all(id, id) as any[]).map((x) => x.n);
  }

  status(id: string): TaskState { return this.store.taskStatus(id); }
}
