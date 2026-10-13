// Durable notification outbox (handoff §9.3, §16.3, REQ-28).
// Delivery is decoupled from task execution: a failed notification is retried
// on its own and never re-runs the task. Messages are deduplicated by a stable
// key, and an identical unchanged blocker is never re-sent.
import { newId } from '../util/canon.ts';
import { fault } from '../util/fault.ts';
import type { Store } from '../store/db.ts';
import { redact } from '../util/redact.ts';

export interface Channel {
  id: string;
  /** Returns a receipt on success; throws on definite failure; returns 'unknown' on ambiguous transport loss. */
  send(destination: string, payload: { title: string; body: string; task_id?: string | null }, dedupKey: string): Promise<unknown | 'unknown'>;
  /** Optional provider-side lookup used to reconcile UNKNOWN deliveries. */
  lookup?(dedupKey: string): Promise<'delivered' | 'absent' | 'error'>;
  /** The provider deduplicates by the key, so an UNKNOWN delivery may simply be re-sent. */
  keyedDedup?: boolean;
  /**
   * For a channel that can neither look up nor deduplicate: re-send an UNKNOWN delivery (bounded by
   * MAX_DELIVERY_ATTEMPTS) rather than drop it, accepting a possible duplicate over a lost notice.
   */
  resendUnknown?: boolean;
}

export const MAX_DELIVERY_ATTEMPTS = 8;

export class Outbox {
  private store: Store;
  private channels = new Map<string, Channel>();
  constructor(store: Store) { this.store = store; }

  register(c: Channel): void { this.channels.set(c.id, c); }

  enqueue(dedupKey: string, channel: string, destination: string, title: string, body: string, taskId?: string | null): boolean {
    return this.store.tx(() => {
      const exists = this.store.db.prepare('SELECT 1 FROM outbox WHERE dedup_key=?').get(dedupKey);
      if (exists) return false;
      const payload = { title: redact(title), body: redact(body), task_id: taskId ?? null };
      this.store.db.prepare(`INSERT INTO outbox VALUES (?,?,?,?,?, 'PENDING', 0, NULL, ?, NULL, ?, ?)`)
        .run(newId(), dedupKey, channel, destination, JSON.stringify(payload), this.store.now(), this.store.now(), this.store.now());
      return true;
    });
  }

  async deliverDue(): Promise<{ delivered: number; failed: number; unknown: number }> {
    const due = this.store.db.prepare(`SELECT * FROM outbox WHERE status IN ('PENDING','UNKNOWN') AND next_attempt_at <= ? ORDER BY created_at LIMIT 50`).all(this.store.now()) as any[];
    let delivered = 0, failed = 0, unknown = 0;
    for (const m of due) {
      const ch = this.channels.get(m.channel);
      if (!ch) continue; // channel not configured yet: stays pending (no busy loop: next_attempt_at unchanged is fine, caller paces)
      if (m.status === 'UNKNOWN' && m.attempts >= MAX_DELIVERY_ATTEMPTS) {
        this.mark(m.delivery_id, 'FAILED', { reason: `delivery outcome still unknown after ${m.attempts} attempts` }); failed++; continue;
      }
      if (m.status === 'UNKNOWN' && ch.lookup) {
        let l: 'delivered' | 'absent' | 'error';
        try { l = await ch.lookup(m.dedup_key); } catch { l = 'error'; } // one failing lookup must not stall the pass
        if (l === 'delivered') { this.mark(m.delivery_id, 'DELIVERED', { reconciled: true }); delivered++; continue; }
        if (l === 'error') { this.backoff({ ...m, attempts: m.attempts + 1 }, 'lookup error', 'UNKNOWN'); unknown++; continue; }
      } else if (m.status === 'UNKNOWN' && !ch.lookup) {
        // No reconciliation possible: resend only if the provider deduplicates by key, or the channel prefers a
        // possible duplicate over a lost notice.
        if (!ch.keyedDedup && !ch.resendUnknown) { this.mark(m.delivery_id, 'FAILED', { reason: 'delivery outcome unknown and channel cannot reconcile' }); failed++; continue; }
      }
      const claimed = this.store.tx(() => Number(this.store.db.prepare(`UPDATE outbox SET status='SENDING', attempts=attempts+1, updated_at=?
        WHERE delivery_id=? AND status=?`).run(this.store.now(), m.delivery_id, m.status).changes));
      if (claimed !== 1) continue; // another delivery pass owns it
      fault('outbox.after_sending_mark');
      let receipt: unknown;
      try {
        receipt = await ch.send(m.destination, JSON.parse(m.payload_json), m.dedup_key);
      } catch (e) {
        if (m.attempts + 1 >= MAX_DELIVERY_ATTEMPTS) { this.mark(m.delivery_id, 'FAILED', { error: (e as Error).message }); failed++; }
        else { this.backoff({ ...m, attempts: m.attempts + 1 }, (e as Error).message, 'PENDING'); }
        continue;
      }
      fault('outbox.after_send');
      if (receipt === 'unknown') {
        if (m.attempts + 1 >= MAX_DELIVERY_ATTEMPTS) { this.mark(m.delivery_id, 'FAILED', { reason: 'delivery outcome unknown after the last attempt' }); failed++; continue; }
        this.backoff({ ...m, attempts: m.attempts + 1 }, 'transport outcome unknown', 'UNKNOWN'); unknown++; continue;
      }
      this.mark(m.delivery_id, 'DELIVERED', receipt); delivered++;
    }
    return { delivered, failed, unknown };
  }

  /** Startup: SENDING rows were interrupted mid-send -> UNKNOWN (reconcile before resending). */
  recover(): number {
    return this.store.tx(() => Number(this.store.db.prepare(`UPDATE outbox SET status='UNKNOWN', updated_at=? WHERE status='SENDING'`).run(this.store.now()).changes));
  }

  private mark(id: string, status: string, receipt: unknown): void {
    this.store.tx(() => this.store.db.prepare(`UPDATE outbox SET status=?, receipt_json=?, updated_at=? WHERE delivery_id=?`)
      .run(status, JSON.stringify(receipt ?? null), this.store.now(), id));
  }

  private backoff(m: any, err: string, status: 'PENDING' | 'UNKNOWN' = m.status): void {
    const delay = Math.min(30 * 60_000, 2_000 * 2 ** Math.min(10, m.attempts));
    // attempts is persisted here too: lookup retries count towards MAX_DELIVERY_ATTEMPTS like sends do.
    this.store.tx(() => this.store.db.prepare(`UPDATE outbox SET status=?, attempts=?, last_error=?, next_attempt_at=?, updated_at=? WHERE delivery_id=?`)
      .run(status, m.attempts, err.slice(0, 500), new Date(this.store.clock() + delay).toISOString(), this.store.now(), m.delivery_id));
  }
}
