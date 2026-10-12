// Owner-scheduled goals (handoff §10.6, §25, T-DUR-11). Instants are explicit UTC;
// the IANA timezone is display metadata only. Each firing is admitted through the
// inbox with identity "<schedule>@<instant>", so a wall-clock jump backwards can
// never fire the same instant twice, and a jump forwards fires a missed interval
// once (no catch-up flood).
import type { Store } from '../store/db.ts';
import { newId } from '../util/canon.ts';

export interface NewSchedule { owner_id: string; goal: string; project_scope: string; kind: 'once' | 'interval'; first_fire_utc: string; interval_seconds?: number; display_timezone: string }

export class Schedules {
  private store: Store;
  /** Admission callback shared with every other owner command path. */
  admit: (messageId: string, goal: string, scope: string) => { task_id: string | null; duplicate: boolean };
  constructor(store: Store, admit: Schedules['admit']) { this.store = store; this.admit = admit; }

  create(s: NewSchedule): string {
    if (!/Z$/.test(s.first_fire_utc) || Number.isNaN(Date.parse(s.first_fire_utc))) throw new Error('first_fire_utc must be an explicit UTC instant');
    if (s.kind === 'interval' && !(s.interval_seconds && s.interval_seconds >= 60)) throw new Error('interval must be >= 60 seconds');
    try { new Intl.DateTimeFormat('en', { timeZone: s.display_timezone }); } catch { throw new Error('unknown IANA timezone'); }
    const id = newId();
    const iso = new Date(s.first_fire_utc).toISOString();
    this.store.tx(() => {
      this.store.db.prepare(`INSERT INTO schedules VALUES (?,?,?,?,?,?,?,?,?,NULL,1,?)`).run(id, s.owner_id, s.goal, s.project_scope, s.kind, iso,
        s.interval_seconds ?? null, s.display_timezone, iso, this.store.now());
      this.store.event('schedule', id, 'created', { kind: s.kind, first_fire_utc: iso, tz: s.display_timezone });
    });
    return id;
  }

  /** Fire due schedules once. Safe to call at any cadence and after any clock change. */
  tick(): { fired: string[]; duplicates: number } {
    const now = this.store.clock();
    const due = this.store.db.prepare(`SELECT * FROM schedules WHERE enabled=1 AND next_fire_utc IS NOT NULL AND next_fire_utc <= ?`).all(new Date(now).toISOString()) as any[];
    const fired: string[] = []; let duplicates = 0;
    for (const s of due) {
      const r = this.admit(`${s.schedule_id}@${s.next_fire_utc}`, s.goal, s.project_scope);
      if (r.duplicate) duplicates++; else fired.push(`${s.schedule_id}@${s.next_fire_utc}`);
      let next: string | null = null;
      if (s.kind === 'interval') {
        const step = s.interval_seconds * 1000;
        let t = Date.parse(s.next_fire_utc) + step;
        if (t <= now) t += Math.ceil((now - t + 1) / step) * step; // skip missed slots: one firing per catch-up
        next = new Date(t).toISOString();
      }
      this.store.tx(() => {
        this.store.db.prepare(`UPDATE schedules SET last_fired_utc=?, next_fire_utc=?, enabled=? WHERE schedule_id=?`).run(s.next_fire_utc, next, next ? 1 : 0, s.schedule_id);
        this.store.event('schedule', s.schedule_id, r.duplicate ? 'duplicate_suppressed' : 'fired', { instant: s.next_fire_utc, next });
      });
    }
    return { fired, duplicates };
  }

  /** Display helper: an instant rendered in the owner's timezone with the zone label. */
  static display(utc: string, tz: string): string {
    return `${new Intl.DateTimeFormat('en-GB', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(utc))} (${tz})`;
  }
}
