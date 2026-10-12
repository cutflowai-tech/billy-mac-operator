// Durable command admission (handoff §9.3, §15.4, REQ-24).
// A command is identified by (source, source_message_id). Re-delivery of the
// same message returns the originally admitted task instead of creating one.
// Only verified owner identities may admit; content never overrides source.
import type { Store } from '../store/db.ts';

export type Disposition = 'ADMITTED' | 'REJECTED_IDENTITY' | 'REJECTED_REVOKED' | 'CONTROL';

export interface AdmitResult { duplicate: boolean; disposition: Disposition; task_id: string | null; revision: number | null }

export class Inbox {
  private store: Store;
  constructor(store: Store) { this.store = store; }

  /**
   * Atomically record the message and (when admitted) run `create` to make
   * the task in the same transaction. `create` must not have external effects.
   */
  admit(source: string, sourceMessageId: string, senderId: string, verified: Disposition,
    create: () => { task_id: string | null; revision: number | null }): AdmitResult {
    return this.store.tx(() => {
      const prev = this.store.db.prepare('SELECT * FROM inbox WHERE source=? AND source_message_id=?').get(source, sourceMessageId) as any;
      if (prev) {
        this.store.event('inbox', `${source}:${sourceMessageId}`, 'duplicate', { sender_id: senderId });
        return { duplicate: true, disposition: prev.disposition, task_id: prev.task_id, revision: prev.revision };
      }
      let task_id: string | null = null, revision: number | null = null;
      if (verified === 'ADMITTED' || verified === 'CONTROL') ({ task_id, revision } = create());
      this.store.db.prepare('INSERT INTO inbox VALUES (?,?,?,?,?,?,?)').run(source, sourceMessageId, senderId, this.store.now(), verified, task_id, revision);
      this.store.event('inbox', `${source}:${sourceMessageId}`, 'received', { disposition: verified, task_id });
      return { duplicate: false, disposition: verified, task_id, revision };
    });
  }

  lookup(source: string, sourceMessageId: string): any {
    return this.store.db.prepare('SELECT * FROM inbox WHERE source=? AND source_message_id=?').get(source, sourceMessageId) ?? null;
  }
}
