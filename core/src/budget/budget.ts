// Shared budget accounting (handoff §10.4, REQ-18).
// - No ceiling configured => chargeable admission waits (never "unlimited").
// - Reservations, actual spend and UNCERTAIN spend all count against ceilings.
// - Children share the parent's scopes; delegation never creates new headroom.
// - All state is in the store, so restart cannot reset a ceiling.
import { newId } from '../util/canon.ts';
import type { Store } from '../store/db.ts';

export class BudgetWait extends Error {
  readonly scope: string;
  readonly why: string;
  constructor(scope: string, why: string) { super(`budget wait on ${scope}: ${why}`); this.scope = scope; this.why = why; }
}

export const NO_COST = 'no-cost';

export class Budget {
  private store: Store;
  constructor(store: Store) { this.store = store; }

  /** Owner-authenticated path only. Amounts are integer micro-dollars. */
  setCeiling(scope: string, ceilingMicros: number, period: 'total' | 'daily', source: string): void {
    if (!Number.isSafeInteger(ceilingMicros) || ceilingMicros < 0) throw new Error('invalid ceiling');
    this.store.tx(() => {
      this.store.db.prepare(`INSERT INTO budgets(scope, ceiling_micros, period, source, updated_at) VALUES (?,?,?,?,?)
        ON CONFLICT(scope) DO UPDATE SET ceiling_micros=excluded.ceiling_micros, period=excluded.period,
        source=excluded.source, updated_at=excluded.updated_at`).run(scope, ceilingMicros, period, source, this.store.now());
      this.store.event('budget', scope, 'ceiling', { ceilingMicros, period, source });
    });
  }

  ceiling(scope: string): { ceiling_micros: number; period: string } | null {
    return (this.store.db.prepare('SELECT ceiling_micros, period FROM budgets WHERE scope=?').get(scope) as any) ?? null;
  }

  private periodStart(period: string): string {
    if (period === 'total') return '0000';
    // Daily periods reset at UTC midnight of the store clock (explicit, documented).
    const d = new Date(this.store.clock());
    return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())).toISOString();
  }

  committed(scope: string): number {
    const c = this.ceiling(scope);
    const since = this.periodStart(c?.period ?? 'total');
    // Open reservations count regardless of when they were made (F-16); settled spend counts in its period.
    const held = this.store.db.prepare(`SELECT coalesce(sum(CASE WHEN kind='RESERVE' THEN amount_micros WHEN kind='RELEASE' THEN -amount_micros ELSE 0 END),0) v
      FROM budget_entries WHERE scope=?`).get(scope) as any;
    const spent = this.store.db.prepare(`SELECT coalesce(sum(amount_micros),0) v FROM budget_entries
      WHERE scope=? AND kind IN ('ACTUAL','UNCERTAIN') AND at >= ?`).get(scope, since) as any;
    return Number(held.v) + Number(spent.v);
  }

  remaining(scope: string): number | null {
    const c = this.ceiling(scope);
    if (!c) return null;
    return c.ceiling_micros - this.committed(scope);
  }

  /** Reserve atomically across every applicable scope or not at all. */
  reserve(scopes: string[], estimateMicros: number, ref: string): string {
    if (estimateMicros === 0) return NO_COST;
    if (!scopes.length) throw new BudgetWait('(none)', 'chargeable call has no budget scope');
    return this.store.tx(() => {
      for (const s of scopes) {
        const rem = this.remaining(s);
        if (rem === null) throw new BudgetWait(s, 'no explicit ceiling configured');
        if (rem < estimateMicros) throw new BudgetWait(s, `remaining ${rem} < estimate ${estimateMicros}`);
      }
      const rid = newId();
      for (const s of scopes) {
        this.store.db.prepare(`INSERT INTO budget_entries VALUES (?,?,?,?,?,?,?)`)
          .run(newId(), rid, s, 'RESERVE', estimateMicros, ref, this.store.now());
      }
      this.store.event('budget', rid, 'reserved', { scopes, estimateMicros, ref });
      return rid;
    });
  }

  /** Settle with actual usage (known) or keep the full reservation as UNCERTAIN spend. */
  settle(reservationId: string, actualMicros: number | 'unknown'): void {
    if (reservationId === NO_COST) return;
    this.store.tx(() => {
      const rows = this.store.db.prepare(`SELECT scope, amount_micros, ref FROM budget_entries
        WHERE reservation_id=? AND kind='RESERVE'`).all(reservationId) as any[];
      const done = this.store.db.prepare(`SELECT count(*) c FROM budget_entries WHERE reservation_id=? AND kind='RELEASE'`).get(reservationId) as any;
      if (done.c > 0) return; // idempotent settle
      for (const r of rows) {
        this.store.db.prepare(`INSERT INTO budget_entries VALUES (?,?,?,?,?,?,?)`)
          .run(newId(), reservationId, r.scope, 'RELEASE', r.amount_micros, r.ref, this.store.now());
        const kind = actualMicros === 'unknown' ? 'UNCERTAIN' : 'ACTUAL';
        const amt = actualMicros === 'unknown' ? r.amount_micros : actualMicros;
        this.store.db.prepare(`INSERT INTO budget_entries VALUES (?,?,?,?,?,?,?)`)
          .run(newId(), reservationId, r.scope, kind, amt, r.ref, this.store.now());
      }
      this.store.event('budget', reservationId, 'settled', { actualMicros });
    });
  }
}
