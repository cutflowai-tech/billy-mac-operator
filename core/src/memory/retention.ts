// Evidence retention (handoff §14.4, T-MEM-06). Only Billy-owned evidence files
// recorded in the `evidence` table and resolving to a regular file under the
// configured evidence directory are ever removed. Symlinks, paths that escape
// the directory, database/journal files and anything not in the table are
// refused. Storage pressure removes raw (unsanitized) evidence oldest-first.
import { lstatSync, realpathSync, unlinkSync } from 'node:fs';
import { basename, dirname, join, sep } from 'node:path';
import type { Store } from '../store/db.ts';
import { ACTION_UNSETTLED } from '../domain/machines.ts';
import { newId } from '../util/canon.ts';

export interface EvidenceInput {
  kind: string; source: string; location: string; sanitized: boolean; retain_until: string | null;
  task_id?: string | null; attempt_id?: string | null; digest?: string | null; captured_at?: string;
}

export interface SweepResult { deleted: string[]; refused: { evidence_id: string; reason: string }[] }
export interface PressureResult extends SweepResult { free_bytes: number; threshold: number; relieved: boolean }

const DB_FILES = new Set(['billy.db', 'billy.db-wal', 'billy.db-shm', 'instance.lock']);

export class Retention {
  private store: Store;
  private root: string;

  constructor(store: Store, evidenceDir: string) {
    this.store = store;
    this.root = realpathSync(evidenceDir);
  }

  track(e: EvidenceInput): string {
    const id = newId();
    this.store.tx(() => this.store.db.prepare(`INSERT INTO evidence(evidence_id, kind, task_id, attempt_id, captured_at,
      source, location, digest, sanitized, retain_until) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(id, e.kind, e.task_id ?? null,
      e.attempt_id ?? null, e.captured_at ?? this.store.now(), e.source, e.location, e.digest ?? null, e.sanitized ? 1 : 0,
      e.retain_until));
    return id;
  }

  /** Delete evidence whose retain_until has passed. */
  sweep(now: Date | string): SweepResult {
    const iso = typeof now === 'string' ? now : now.toISOString();
    const rows = this.store.db.prepare(`SELECT evidence_id, location, attempt_id FROM evidence
      WHERE deleted_at IS NULL AND retain_until IS NOT NULL AND retain_until < ? ORDER BY retain_until`).all(iso) as any[];
    const res: SweepResult = { deleted: [], refused: [] };
    for (const r of rows) this.remove(r, 'expired', res);
    this.store.tx(() => this.store.event('retention', 'sweep', 'completed',
      { at: iso, deleted: res.deleted.length, refused: res.refused.length }));
    return res;
  }

  /** Free space by removing eligible raw evidence oldest-first until freeBytes() >= threshold. */
  relievePressure(threshold: number, freeBytes: () => number): PressureResult {
    const res: SweepResult = { deleted: [], refused: [] };
    let free = freeBytes();
    if (free < threshold) {
      this.store.tx(() => this.store.event('retention', 'pressure', 'alert', { free_bytes: free, threshold }));
      const rows = this.store.db.prepare(`SELECT evidence_id, location, attempt_id FROM evidence
        WHERE deleted_at IS NULL AND sanitized = 0 ORDER BY captured_at, rowid`).all() as any[];
      for (const r of rows) {
        if (free >= threshold) break;
        this.remove(r, 'storage_pressure', res);
        free = freeBytes();
      }
    }
    const relieved = free >= threshold;
    this.store.tx(() => this.store.event('retention', 'pressure', relieved ? 'relieved' : 'unresolved',
      { free_bytes: free, threshold, deleted: res.deleted.length, refused: res.refused.length }));
    return { ...res, free_bytes: free, threshold, relieved };
  }

  private remove(r: { evidence_id: string; location: string | null; attempt_id: string | null }, why: string, res: SweepResult): void {
    const refuse = (reason: string) => {
      res.refused.push({ evidence_id: r.evidence_id, reason });
      this.store.tx(() => this.store.event('retention', r.evidence_id, 'refused', { reason }));
    };
    if (r.attempt_id) {
      const a = this.store.db.prepare('SELECT status FROM attempts WHERE attempt_id=?').get(r.attempt_id) as any;
      if (a && ACTION_UNSETTLED.has(a.status)) return refuse('evidence of an unsettled action is required');
    }
    if (!r.location) return this.mark(r.evidence_id, why, 'no file', res);
    let st;
    try { st = lstatSync(r.location); } catch { return this.mark(r.evidence_id, why, 'already absent', res); }
    if (st.isSymbolicLink()) return refuse('symlink');
    if (!st.isFile()) return refuse('not a regular file');
    let real: string;
    try { real = join(realpathSync(dirname(r.location)), basename(r.location)); } catch { return refuse('unresolvable path'); }
    if (!real.startsWith(this.root + sep)) return refuse('outside evidence directory');
    if (DB_FILES.has(basename(real)) || /\.db(-wal|-shm)?$/.test(real)) return refuse('database or journal file');
    try { unlinkSync(real); } catch (e) { return refuse(`unlink failed: ${(e as Error).message}`); }
    this.mark(r.evidence_id, why, 'deleted', res);
  }

  private mark(id: string, why: string, outcome: string, res: SweepResult): void {
    this.store.tx(() => {
      this.store.db.prepare('UPDATE evidence SET deleted_at=? WHERE evidence_id=? AND deleted_at IS NULL').run(this.store.now(), id);
      this.store.event('retention', id, 'deleted', { why, outcome });
    });
    res.deleted.push(id);
  }
}
