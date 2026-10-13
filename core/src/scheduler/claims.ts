// Resource claims with fencing generations and FIFO fairness (REQ-12, REQ-35).
// Exclusive claims (e.g. "desktop:<session>") admit one holder; shared claims
// admit many shared holders but no exclusive holder. Acquisition of several
// keys happens in sorted order inside one transaction (all-or-nothing), so
// there is no lock-ordering deadlock. Waiters are queued; a waiter that is not
// at the head of a key's queue cannot jump ahead (no starvation).
import type { Store } from '../store/db.ts';

export interface ClaimReq { resource_key: string; mode: 'shared' | 'exclusive' }

export class Claims {
  private store: Store;
  private ttlMs: number;
  constructor(store: Store, ttlMs = 10 * 60_000) { this.store = store; this.ttlMs = ttlMs; }

  onRelease: ((keys: string[]) => void)[] = [];

  acquireAll(reqs: ClaimReq[], holder: string, waiter: string = holder): { ok: true; generation: number } | { ok: false; blocked: string } {
    if (!reqs.length) return { ok: true, generation: 0 };
    const sorted = [...reqs].sort((a, b) => a.resource_key.localeCompare(b.resource_key));
    return this.store.tx(() => {
      const db = this.store.db;
      // A task that left the resource wait must not block the FIFO head forever.
      db.prepare(`DELETE FROM resource_waiters WHERE waiter LIKE 'task:%' AND NOT EXISTS
        (SELECT 1 FROM tasks WHERE task_id=substr(waiter,6) AND status IN ('WAITING_RESOURCE','READY','RUNNING'))`).run();
      let blocked: string | null = null;
      for (const r of sorted) {
        const holders = db.prepare('SELECT holder, mode FROM resource_claims WHERE resource_key=? AND holder<>?').all(r.resource_key, holder) as any[];
        const conflict = r.mode === 'exclusive' ? holders.length > 0 : holders.some((h) => h.mode === 'exclusive');
        const head = db.prepare('SELECT waiter FROM resource_waiters WHERE resource_key=? ORDER BY enqueued_seq, waiter LIMIT 1').get(r.resource_key) as any;
        if (conflict || (head && head.waiter !== waiter)) { blocked = r.resource_key; break; }
      }
      if (blocked) {
        // One ticket per waiter, shared by all of its keys: waiters are then totally ordered the same
        // way on every key, so the oldest waiter heads every queue it is in and no cycle of heads can
        // form. Entries for keys this waiter no longer requests are dropped (they would block others).
        const keys = sorted.map((r) => r.resource_key);
        db.prepare(`DELETE FROM resource_waiters WHERE waiter=? AND resource_key NOT IN (${keys.map(() => '?').join(',')})`).run(waiter, ...keys);
        const own = db.prepare('SELECT min(enqueued_seq) s FROM resource_waiters WHERE waiter=?').get(waiter) as any;
        const ticket = own?.s ?? (db.prepare('SELECT coalesce(max(enqueued_seq),0)+1 s FROM resource_waiters').get() as any).s;
        for (const k of keys) {
          db.prepare(`INSERT INTO resource_waiters VALUES (?,?,?) ON CONFLICT(resource_key, waiter) DO UPDATE SET enqueued_seq=excluded.enqueued_seq`).run(k, waiter, ticket);
        }
        return { ok: false as const, blocked };
      }
      let gen = 0;
      for (const r of sorted) {
        const g = ((db.prepare('SELECT generation FROM resource_generations WHERE resource_key=?').get(r.resource_key) as any)?.generation ?? 0) + 1;
        db.prepare(`INSERT INTO resource_generations VALUES (?,?) ON CONFLICT(resource_key) DO UPDATE SET generation=excluded.generation`).run(r.resource_key, g);
        db.prepare(`INSERT OR REPLACE INTO resource_claims(resource_key, holder, mode, generation, expires_at, acquired_at) VALUES (?,?,?,?,?,?)`)
          .run(r.resource_key, holder, r.mode, g, new Date(this.store.clock() + this.ttlMs).toISOString(), this.store.now());
        db.prepare('DELETE FROM resource_waiters WHERE resource_key=? AND waiter=?').run(r.resource_key, waiter);
        gen = Math.max(gen, g);
      }
      this.store.event('claims', holder, 'acquired', { keys: sorted.map((s) => s.resource_key), generation: gen });
      return { ok: true as const, generation: gen };
    });
  }

  /** Wrapper that converts the internal "blocked" throw into a result without losing the queue entry. */
  tryAcquire(reqs: ClaimReq[], holder: string) { return this.acquireAll(reqs, holder); }

  stillHeld(reqs: ClaimReq[], holder: string, generation: number): boolean {
    for (const r of reqs) {
      const row = this.store.db.prepare('SELECT generation FROM resource_claims WHERE resource_key=? AND holder=?').get(r.resource_key, holder) as any;
      if (!row) return false;
      if (r.mode === 'exclusive' && row.generation > generation) return false;
    }
    return true;
  }

  releaseAll(holder: string): void {
    const keys = this.store.tx(() => {
      const k = (this.store.db.prepare('SELECT resource_key FROM resource_claims WHERE holder=?').all(holder) as any[]).map((r) => r.resource_key);
      this.store.db.prepare('DELETE FROM resource_claims WHERE holder=?').run(holder);
      this.store.db.prepare('DELETE FROM resource_waiters WHERE waiter=?').run(holder);
      return k as string[];
    });
    if (keys.length) for (const f of this.onRelease) { try { f(keys); } catch { /* best effort */ } }
  }

  /** Withdraw from waiting queues without holding anything (e.g. task cancelled while waiting). */
  withdraw(holder: string): void {
    const keys = this.store.tx(() => {
      const rows = this.store.db.prepare('SELECT resource_key FROM resource_waiters WHERE waiter=?').all(holder) as { resource_key: string }[];
      this.store.db.prepare('DELETE FROM resource_waiters WHERE waiter=?').run(holder);
      return rows.map((r) => r.resource_key);
    });
    if (keys.length) for (const f of this.onRelease) { try { f(keys); } catch { /* next scheduling event retries */ } }
  }

  holders(key: string): { holder: string; mode: string; generation: number }[] {
    return this.store.db.prepare('SELECT holder, mode, generation FROM resource_claims WHERE resource_key=?').all(key) as any;
  }

  /** Startup: all in-process holders are gone; external worker holders are fenced by the recovery path. */
  clearAll(): void {
    this.store.tx(() => { this.store.db.exec('DELETE FROM resource_claims; DELETE FROM resource_waiters;'); });
  }
}
