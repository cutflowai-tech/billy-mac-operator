// Authoritative store: single controlled writer, short transactions,
// foreign keys, bounded busy handling, versioned migrations, integrity gate.
import { DatabaseSync, backup as sqliteBackup } from 'node:sqlite';
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { MIGRATIONS, type Migration } from './schema.ts';
import { sha256, utcNow } from '../util/canon.ts';
import {
  checkAction, checkTask, type ActionState, type TaskState,
} from '../domain/machines.ts';

export class CorruptionError extends Error {}
export class InstanceLockedError extends Error {}
export class CompatibilityError extends Error {}
export class UnsafeLocationError extends Error {}

export interface OpenOptions {
  dir: string;
  allowUnsafeLocation?: boolean; // tests on temp dirs only
  clock?: () => number;
  busyTimeoutMs?: number;
  migrations?: Migration[]; // default MIGRATIONS; tests inject upgrade/failure simulations
}

const UNSAFE_PREFIXES = () => [
  '/Volumes/',
  join(homedir(), 'Library/Mobile Documents'),
  join(homedir(), 'Library/CloudStorage'),
  join(homedir(), 'Dropbox'),
  join(homedir(), 'Google Drive'),
];

export function assertSafeLocation(dir: string): void {
  const abs = existsSync(dir) ? realpathSync(dir) : resolve(dir);
  for (const p of UNSAFE_PREFIXES()) {
    if (abs.startsWith(p)) throw new UnsafeLocationError(`refusing live database under ${p}: ${abs}`);
  }
}

/** True when a live Billy core owns this data dir (probe touches only instance.lock, never billy.db). */
export function instanceLocked(dir: string): boolean {
  const p = join(dir, 'instance.lock');
  if (!existsSync(p)) return false;
  try {
    const db = new DatabaseSync(p, { timeout: 50 });
    try { db.exec('BEGIN EXCLUSIVE; ROLLBACK;'); return false; } finally { db.close(); }
  } catch { return true; }
}

export function defaultDataDir(): string {
  return join(homedir(), 'Library', 'Application Support', 'Billy');
}

export class Store {
  readonly db: DatabaseSync;
  private lockDb: DatabaseSync;
  readonly dir: string;
  readonly clock: () => number;
  private inTx = false;
  private migrations: Migration[];

  private constructor(dir: string, db: DatabaseSync, lockDb: DatabaseSync, clock: () => number, migrations: Migration[]) {
    this.dir = dir; this.db = db; this.lockDb = lockDb; this.clock = clock; this.migrations = migrations;
  }

  static open(opts: OpenOptions): Store {
    const dir = opts.dir;
    if (!opts.allowUnsafeLocation) assertSafeLocation(dir);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    // Never silently start empty after a quarantined corruption: restore must clear the marker first.
    if (existsSync(join(dir, 'RECOVERY_REQUIRED.json'))) {
      throw new CorruptionError(`recovery required: restore from a verified backup (see ${join(dir, 'RECOVERY_REQUIRED.json')})`);
    }
    // Single-instance ownership: an exclusive-locking-mode SQLite handle holds
    // an OS file lock for the process lifetime and is released on process death.
    let lockDb: DatabaseSync;
    try {
      lockDb = new DatabaseSync(join(dir, 'instance.lock'), { timeout: 50 });
      lockDb.exec('PRAGMA locking_mode=EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner(pid INTEGER, at TEXT);');
      lockDb.prepare('INSERT INTO owner VALUES (?, ?)').run(process.pid, new Date().toISOString());
      lockDb.exec('DELETE FROM owner WHERE rowid NOT IN (SELECT max(rowid) FROM owner)');
    } catch (e) {
      throw new InstanceLockedError(`another Billy core owns ${dir}: ${(e as Error).message}`);
    }
    const path = join(dir, 'billy.db');
    const db = new DatabaseSync(path, { timeout: opts.busyTimeoutMs ?? 2000, enableForeignKeyConstraints: true });
    const s = new Store(dir, db, lockDb, opts.clock ?? Date.now, opts.migrations ?? MIGRATIONS);
    try {
      s.integrityGate();
      db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
      s.migrate();
      s.ensureSingletons();
    } catch (e) {
      // Release the file handles and instance lock so quarantine/restore can proceed.
      s.close();
      throw e;
    }
    try { chmodSync(path, 0o600); } catch { /* best effort */ }
    return s;
  }

  close(): void {
    try { this.db.close(); } catch { /* already closed */ }
    try { this.lockDb.close(); } catch { /* already closed */ }
  }

  now(): string { return utcNow(this.clock); }

  private integrityGate(): void {
    let res: string;
    try {
      const rows = this.db.prepare('PRAGMA quick_check').all() as { quick_check: string }[];
      res = rows.map((r) => r.quick_check).join('; ');
    } catch (e) {
      throw new CorruptionError(`integrity check failed to run: ${(e as Error).message}`);
    }
    if (res !== 'ok') throw new CorruptionError(`integrity check: ${res}`);
  }

  pragmas(): Record<string, unknown> {
    const one = (p: string) => (this.db.prepare(`PRAGMA ${p}`).get() as Record<string, unknown>)[p];
    return {
      journal_mode: one('journal_mode'), synchronous: one('synchronous'), foreign_keys: one('foreign_keys'),
      busy_timeout: (this.db.prepare('PRAGMA busy_timeout').get() as any).timeout,
      sqlite_version: (this.db.prepare('select sqlite_version() v').get() as any).v,
    };
  }

  private migrate(): void {
    this.db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY, name TEXT NOT NULL, digest TEXT NOT NULL, applied_at TEXT NOT NULL)`);
    const applied = new Map((this.db.prepare('SELECT version, digest FROM schema_migrations').all() as any[])
      .map((r) => [r.version as number, r.digest as string]));
    const known = new Set(this.migrations.map((m) => m.version));
    for (const v of applied.keys()) {
      if (!known.has(v)) throw new CompatibilityError(`database schema v${v} is newer than this build`);
    }
    for (const m of this.migrations) {
      const d = sha256(m.sql);
      if (applied.has(m.version)) {
        if (applied.get(m.version) !== d) throw new CompatibilityError(`migration v${m.version} digest mismatch`);
        continue;
      }
      this.tx(() => {
        this.db.exec(m.sql);
        this.db.prepare('INSERT INTO schema_migrations VALUES (?,?,?,?)').run(m.version, m.name, d, this.now());
      });
    }
  }

  schemaVersion(): number {
    return (this.db.prepare('SELECT max(version) v FROM schema_migrations').get() as any).v ?? 0;
  }

  private ensureSingletons(): void {
    this.tx(() => {
      this.db.prepare(`INSERT OR IGNORE INTO stop_latch(id, generation, stopped, reason, source, updated_at)
        VALUES (1, 0, 0, NULL, NULL, ?)`).run(this.now());
      const inst = this.db.prepare(`SELECT value FROM meta WHERE key='instance_id'`).get() as any;
      if (!inst) this.db.prepare(`INSERT INTO meta VALUES ('instance_id', ?)`).run(crypto.randomUUID());
    });
  }

  /** Short IMMEDIATE transaction. Nested calls join the outer transaction. */
  tx<T>(fn: () => T): T {
    if (this.inTx) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this.inTx = true;
    try {
      const r = fn();
      this.db.exec('COMMIT');
      return r;
    } catch (e) {
      try { this.db.exec('ROLLBACK'); } catch { /* connection may be gone */ }
      throw e;
    } finally {
      this.inTx = false;
    }
  }

  event(domain: string, entityId: string, kind: string, payload: unknown, correlationId?: string | null,
    causationId?: string | null): number {
    const r = this.db.prepare(`INSERT INTO events(domain, entity_id, kind, correlation_id, causation_id, payload_json, at)
      VALUES (?,?,?,?,?,?,?)`).run(domain, entityId, kind, correlationId ?? null, causationId ?? null,
      JSON.stringify(payload ?? {}), this.now());
    return Number(r.lastInsertRowid);
  }

  // ---- tasks ----
  taskStatus(taskId: string): TaskState {
    const r = this.db.prepare('SELECT status FROM tasks WHERE task_id=?').get(taskId) as any;
    if (!r) throw new Error(`unknown task ${taskId}`);
    return r.status as TaskState;
  }

  transitionTask(taskId: string, to: TaskState, fields: Record<string, unknown> = {}, reason?: string): void {
    this.tx(() => {
      const from = this.taskStatus(taskId);
      checkTask(from, to);
      const cols = Object.keys(fields);
      for (const c of cols) if (!/^[a-z_]+$/.test(c)) throw new Error(`bad column ${c}`);
      const sets = ['status=?', 'updated_at=?', ...cols.map((c) => `${c}=?`)].join(', ');
      this.db.prepare(`UPDATE tasks SET ${sets} WHERE task_id=?`)
        .run(to, this.now(), ...cols.map((c) => fields[c] as any), taskId);
      this.event('task', taskId, 'transition', { from, to, reason: reason ?? null });
    });
  }

  // ---- attempts ----
  attemptStatus(attemptId: string): ActionState {
    const r = this.db.prepare('SELECT status FROM attempts WHERE attempt_id=?').get(attemptId) as any;
    if (!r) throw new Error(`unknown attempt ${attemptId}`);
    return r.status as ActionState;
  }

  transitionAttempt(attemptId: string, to: ActionState, fields: Record<string, unknown> = {}): void {
    this.tx(() => {
      const from = this.attemptStatus(attemptId);
      checkAction(from, to);
      const cols = Object.keys(fields);
      for (const c of cols) if (!/^[a-z_]+$/.test(c)) throw new Error(`bad column ${c}`);
      const sets = ['status=?', 'updated_at=?', ...cols.map((c) => `${c}=?`)].join(', ');
      this.db.prepare(`UPDATE attempts SET ${sets} WHERE attempt_id=?`)
        .run(to, this.now(), ...cols.map((c) => fields[c] as any), attemptId);
      this.event('attempt', attemptId, 'transition', { from, to });
    });
  }

  // ---- stop latch ----
  stopLatch(): { generation: number; stopped: boolean; reason: string | null } {
    const r = this.db.prepare('SELECT generation, stopped, reason FROM stop_latch WHERE id=1').get() as any;
    return { generation: r.generation, stopped: r.stopped === 1, reason: r.reason };
  }

  // ---- backup ----
  /** Consistent online backup via SQLite's backup API, then verified. */
  async backupTo(destPath: string): Promise<{ path: string; sha256: string; schema: number }> {
    await sqliteBackup(this.db, destPath);
    const check = new DatabaseSync(destPath, { readOnly: true });
    try {
      const qc = (check.prepare('PRAGMA quick_check').get() as any).quick_check;
      if (qc !== 'ok') throw new CorruptionError(`backup verification failed: ${qc}`);
      const schema = (check.prepare('SELECT max(version) v FROM schema_migrations').get() as any).v;
      chmodSync(destPath, 0o600);
      return { path: destPath, sha256: sha256(readFileSync(destPath)), schema };
    } finally {
      check.close();
    }
  }
}
