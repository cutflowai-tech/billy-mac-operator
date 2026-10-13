// Telegram owner channel (ADR-0001): outbound long-polling only — Billy never
// opens an inbound port. Identity is the immutable numeric Telegram user id of
// a device paired through a one-time code shown in the local app (REQ-23/24).
//
// Commands from unpaired, revoked, group, forwarded or bot senders are never
// admitted. Message text cannot change the sender identity. Stop is processed
// before ordinary dispatch and acknowledged only after the local latch commits.
import { createHash, randomInt } from 'node:crypto';
import type { Core } from '../core.ts';
import type { Channel } from '../notify/outbox.ts';
import { redact } from '../util/redact.ts';
import { newId } from '../util/canon.ts';
import { fault } from '../util/fault.ts';

export interface TelegramTransport {
  getUpdates(offset: number, timeoutSec: number, signal: AbortSignal): Promise<any[]>;
  sendMessage(chatId: number, text: string): Promise<{ message_id: number }>;
}

/** Real Bot API transport. The token never appears in logs (registered with the redactor by the Keychain reader). */
export class BotApi implements TelegramTransport {
  private base: string;
  constructor(token: string, apiBase = 'https://api.telegram.org') { this.base = `${apiBase}/bot${token}`; }
  private async call(method: string, body: object, signal?: AbortSignal): Promise<any> {
    const res = await fetch(`${this.base}/${method}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal, redirect: 'error' });
    const j: any = await res.json().catch(() => ({}));
    if (!res.ok || !j.ok) { const e: any = new Error(`telegram ${method} failed: ${res.status} ${redact(String(j.description ?? ''))}`); e.status = res.status; e.retryAfter = j.parameters?.retry_after; throw e; }
    return j.result;
  }
  getUpdates(offset: number, timeoutSec: number, signal: AbortSignal) {
    return this.call('getUpdates', { offset, timeout: timeoutSec, allowed_updates: ['message'] }, AbortSignal.any([signal, AbortSignal.timeout((timeoutSec + 10) * 1000)]));
  }
  sendMessage(chatId: number, text: string) { return this.call('sendMessage', { chat_id: chatId, text: text.slice(0, 4000), disable_web_page_preview: true }); }
}

const CODE_TTL_MS = 10 * 60_000;
const hashCode = (c: string) => createHash('sha256').update(`billy-pair:${c}`).digest('hex');

export class TelegramRemote {
  private core: Core;
  private t: TelegramTransport;
  private ownerId: string;
  private controller = new AbortController();
  private running = false;
  private rate = new Map<number, number[]>();
  onPaired: ((userId: string) => void)[] = [];
  /** Called to admit an owner goal through the shared admission path. */
  admitGoal: (messageId: string, senderUserId: string, goal: string) => { task_id: string | null; duplicate: boolean };

  constructor(core: Core, transport: TelegramTransport, ownerId: string, admitGoal: TelegramRemote['admitGoal']) {
    this.core = core; this.t = transport; this.ownerId = ownerId; this.admitGoal = admitGoal;
  }

  /** Local-app only: create a short single-use pairing code. */
  createPairingCode(): { code: string; expires_at: string } {
    const code = String(randomInt(0, 1e8)).padStart(8, '0');
    const expires = new Date(this.core.store.clock() + CODE_TTL_MS).toISOString();
    this.core.store.tx(() => {
      this.core.store.db.prepare(`INSERT INTO pairing_challenges VALUES (?,?,?,?,?,?,NULL,NULL,?)`)
        .run(newId(), hashCode(code), this.ownerId, 'telegram', 'owner-device', expires, this.core.store.now());
      this.core.store.event('pairing', 'telegram', 'challenge_created', { expires_at: expires });
    });
    return { code, expires_at: expires };
  }

  /** Consume a pairing code: first valid, unexpired use only (T-REMOTE-08). */
  consumePairing(code: string, userId: number, chatType: string): 'PAIRED' | 'INVALID' {
    if (chatType !== 'private') return 'INVALID';
    return this.core.store.tx(() => {
      const row = this.core.store.db.prepare(`SELECT * FROM pairing_challenges WHERE code_digest=? AND channel='telegram'`).get(hashCode(code)) as any;
      const ok = row && !row.consumed_at && row.expires_at > this.core.store.now() && row.owner_id === this.ownerId;
      if (!ok) { this.core.store.event('pairing', 'telegram', 'rejected', { user: String(userId), reason: !row ? 'unknown' : row.consumed_at ? 'replayed' : 'expired_or_wrong_owner' }); return 'INVALID'; }
      this.core.store.db.prepare(`UPDATE pairing_challenges SET consumed_at=?, consumed_by=? WHERE challenge_id=?`).run(this.core.store.now(), String(userId), row.challenge_id);
      this.core.store.db.prepare(`INSERT INTO devices VALUES (?,?,?,?,?,?,NULL) ON CONFLICT(channel, platform_identity) DO UPDATE SET revoked_at=NULL, paired_at=excluded.paired_at`)
        .run(newId(), this.ownerId, 'telegram', String(userId), 'Telegram', this.core.store.now());
      this.core.store.event('pairing', 'telegram', 'paired', { user: String(userId) });
      for (const f of this.onPaired) { try { f(String(userId)); } catch { /* best effort */ } }
      return 'PAIRED';
    });
  }

  revoke(userId: string): void {
    this.core.store.tx(() => {
      this.core.store.db.prepare(`UPDATE devices SET revoked_at=? WHERE channel='telegram' AND platform_identity=?`).run(this.core.store.now(), userId);
      this.core.store.event('pairing', 'telegram', 'revoked', { user: userId });
    });
  }

  devices(): any[] { return this.core.store.db.prepare(`SELECT device_id, platform_identity, label, paired_at, revoked_at FROM devices WHERE channel='telegram'`).all() as any[]; }

  private activeDevice(userId: number): boolean {
    const r = this.core.store.db.prepare(`SELECT revoked_at FROM devices WHERE channel='telegram' AND platform_identity=?`).get(String(userId)) as any;
    return !!r && !r.revoked_at;
  }

  private limited(userId: number): boolean {
    const now = Date.now();
    const w = (this.rate.get(userId) ?? []).filter((t) => now - t < 60_000);
    w.push(now); this.rate.set(userId, w);
    return w.length > 20;
  }

  /** Classify and act on one update. Returns the disposition (for tests and audit). */
  async handle(u: any): Promise<string> {
    const m = u.message;
    if (!m || typeof m.text !== 'string') return 'IGNORED_NON_TEXT';
    const from = m.from ?? {};
    const userId: number = from.id;
    const chat = m.chat ?? {};
    // Source identity comes only from Telegram's sender fields, never from the text.
    const forwarded = !!(m.forward_origin || m.forward_from || m.forward_from_chat || m.forward_date || m.is_automatic_forward);
    if (from.is_bot || chat.type !== 'private' || chat.id !== userId || forwarded) {
      this.core.store.tx(() => this.core.store.event('remote', 'telegram', 'rejected', { reason: forwarded ? 'forwarded' : from.is_bot ? 'bot' : 'not_private', user: String(userId ?? '') }));
      return 'REJECTED_SOURCE';
    }
    const text = m.text.trim();
    const msgId = `${chat.id}:${m.message_id}`;
    // The emergency stop is never rate limited: it must work precisely when a flood of messages is arriving.
    const isStop = /^\/(stop|توقف|وقف)$/i.test(text);
    if (!(isStop && this.activeDevice(userId)) && this.limited(userId)) return 'RATE_LIMITED';
    const pair = /^\/pair\s+(\d{8})$/.exec(text);
    if (pair) {
      const r = this.consumePairing(pair[1], userId, chat.type);
      await this.safeSend(chat.id, r === 'PAIRED' ? 'Paired. You can now send Billy tasks from this chat.' : 'Pairing code invalid or expired.');
      return r;
    }
    if (!this.activeDevice(userId)) {
      this.core.store.tx(() => this.core.store.event('remote', 'telegram', 'rejected', { reason: 'unpaired_or_revoked', user: String(userId) }));
      // Record the message id so a later pairing does not retroactively admit it.
      this.core.inbox.admit('telegram', msgId, String(userId), 'REJECTED_IDENTITY', () => ({ task_id: null, revision: null }));
      return 'REJECTED_IDENTITY';
    }
    if (isStop) {
      const r = this.core.inbox.admit('telegram', msgId, String(userId), 'CONTROL', () => ({ task_id: null, revision: null }));
      if (!r.duplicate) {
        const ack = this.core.control.stopAll(`telegram:${userId}`, 'owner stop from phone');
        await this.safeSend(chat.id, `Stopped on the Mac (generation ${ack.generation}). ${ack.in_flight.length ? `${ack.in_flight.length} action(s) were already in flight and are being checked.` : 'Nothing was in flight.'}`);
      }
      return 'STOPPED';
    }
    if (/^\/status$/.test(text)) {
      const rows = this.core.store.db.prepare(`SELECT t.task_id, t.status, r.goal FROM tasks t JOIN task_revisions r ON r.task_id=t.task_id AND r.revision=t.revision
        WHERE t.parent_task_id IS NULL ORDER BY t.updated_at DESC LIMIT 5`).all() as any[];
      const latch = this.core.store.stopLatch();
      await this.safeSend(chat.id, `${latch.stopped ? '⏹ Stopped. Send /resume to clear.\n' : ''}${rows.map((r) => `• ${r.status}: ${r.goal.slice(0, 60)}`).join('\n') || 'No tasks.'}`);
      return 'STATUS';
    }
    if (/^\/resume$/.test(text)) {
      const r = this.core.inbox.admit('telegram', msgId, String(userId), 'CONTROL', () => ({ task_id: null, revision: null }));
      if (!r.duplicate) {
        this.core.control.clearStop(`telegram:${userId}`);
        const paused = this.core.store.db.prepare(`SELECT task_id FROM tasks WHERE status='PAUSED_BY_OWNER'`).all() as any[];
        for (const p of paused) this.core.control.resume(p.task_id, `telegram:${userId}`);
        await this.safeSend(chat.id, `Resumed ${paused.length} task(s).`);
      }
      return 'RESUMED';
    }
    const res = this.admitGoal(msgId, String(userId), text);
    if (!res.duplicate) await this.safeSend(chat.id, 'Received. I will report back when it is done or if I am blocked.');
    return res.duplicate ? 'DUPLICATE' : 'ADMITTED';
  }

  private async safeSend(chatId: number, text: string): Promise<void> {
    try { await this.t.sendMessage(chatId, redact(text)); } catch { /* replies are best-effort; durable notices go through the outbox */ }
  }

  /** Durable notification channel bound to paired devices only. */
  channel(): Channel {
    return {
      id: 'telegram',
      // Telegram offers no message lookup or idempotency key: after a transport loss a duplicate notice is
      // preferable to a lost one (a lost "needs authority" or "failed" notice strands the owner).
      resendUnknown: true,
      send: async (destination, payload) => {
        if (!this.activeDevice(Number(destination))) throw new Error('destination is not an active paired device');
        try { return await this.t.sendMessage(Number(destination), redact(`${payload.title}: ${payload.body}`)); }
        catch (e: any) { if (e?.status && e.status < 500 && e.status !== 429) throw e; return 'unknown'; }
      },
    };
  }

  offset(): number {
    return Number((this.core.store.db.prepare(`SELECT value FROM meta WHERE key='telegram_offset'`).get() as any)?.value ?? 0);
  }

  private saveOffset(o: number): void {
    this.core.store.tx(() => this.core.store.db.prepare(`INSERT INTO meta VALUES ('telegram_offset', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(String(o)));
  }

  /** Long-poll loop. Each update is handled (idempotently via the inbox) before the offset advances. */
  async run(timeoutSec = 25): Promise<void> {
    this.running = true;
    let backoff = 1000;
    while (this.running) {
      try {
        const updates = await this.t.getUpdates(this.offset(), timeoutSec, this.controller.signal);
        for (const u of updates) {
          await this.handle(u);
          fault('telegram.after_handle'); // crash window: admitted but offset not yet confirmed -> Telegram redelivers
          this.saveOffset(u.update_id + 1);
        }
        backoff = 1000;
      } catch (e: any) {
        if (!this.running) break;
        const wait = e?.retryAfter ? e.retryAfter * 1000 : backoff;
        backoff = Math.min(60_000, backoff * 2);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
  }

  stop(): void { this.running = false; this.controller.abort(); }
}
