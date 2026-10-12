// Encrypted, verified backups and the explicit recovery paths around them
// (handoff §9.6, §14.4). Backups are taken with SQLite's backup API (never a raw
// copy of a live file), encrypted with AES-256-GCM under a Keychain-held key, and
// restored only into a data directory that is not in use. Corruption never leads
// to a blank database: damaged files are quarantined byte-for-byte and recovery
// is a separate, explicit restore from a backup that passes verification.
import { DatabaseSync } from 'node:sqlite';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  appendFileSync, chmodSync, closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync,
  renameSync, rmSync, writeFileSync, writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { CompatibilityError, CorruptionError, InstanceLockedError, Store, type OpenOptions } from './db.ts';
import { MIGRATIONS, type Migration } from './schema.ts';
import { sha256 } from '../util/canon.ts';

export const APP_VERSION: string = (() => {
  try { return JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')).version; } catch { return 'unknown'; }
})();

const MAGIC = Buffer.from('BILLYBAK\x01', 'latin1'); // 9 bytes: format + version
const IV_LEN = 12;
const TAG_LEN = 16;
const DB_FILES = ['billy.db', 'billy.db-wal', 'billy.db-shm'];
const RECOVERY_MARKER = 'RECOVERY_REQUIRED.json';

export class BackupError extends Error {}
export class RestoreRefusedError extends Error {}
export class KeyUnavailableError extends Error {}

// ---------------------------------------------------------------- keys

export interface KeyProvider { getKey(): Buffer }

/** In-memory key (tests, or a key already unwrapped by the caller). */
export class StaticKeyProvider implements KeyProvider {
  private key: Buffer;
  constructor(key: Buffer = randomBytes(32)) {
    if (key.length !== 32) throw new KeyUnavailableError('backup key must be 32 bytes');
    this.key = Buffer.from(key);
  }
  getKey(): Buffer { return this.key; }
}

export type SecurityRunner = (args: string[], stdin?: string) => { status: number | null; stdout: string; stderr: string };

const realSecurity: SecurityRunner = (args, stdin) => {
  const r = spawnSync('/usr/bin/security', args, { encoding: 'utf8', timeout: 15_000, ...(stdin !== undefined ? { input: stdin } : {}) });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};

/**
 * Production key source: a generic-password item in the login Keychain holding a
 * base64 32-byte key. The key is created only when `allowCreate` is set (first-run
 * setup); otherwise a missing item is an error, never a silent new key that would
 * orphan existing backups. `run` is injectable so tests never touch the real Keychain.
 * Creation uses `security -i` with the command on stdin, so the key never appears on argv.
 */
export class KeychainKeyProvider implements KeyProvider {
  private opts: { allowCreate: boolean; service: string; account: string; run: SecurityRunner };
  private cached: Buffer | null = null;
  constructor(opts: { allowCreate?: boolean; service?: string; account?: string; run?: SecurityRunner } = {}) {
    this.opts = { allowCreate: opts.allowCreate ?? false, service: opts.service ?? 'com.billy.backup-key',
      account: opts.account ?? 'billy', run: opts.run ?? realSecurity };
  }

  private find(): Buffer | null {
    const r = this.opts.run(['find-generic-password', '-s', this.opts.service, '-w']);
    if (r.status === 0) {
      const key = Buffer.from(r.stdout.trim(), 'base64');
      if (key.length !== 32) throw new KeyUnavailableError(`keychain item ${this.opts.service} is not a 32-byte key`);
      return key;
    }
    if (r.status === 44) return null; // errSecItemNotFound
    throw new KeyUnavailableError(`security find-generic-password failed (${r.status}): ${r.stderr.trim()}`);
  }

  getKey(): Buffer {
    if (this.cached) return this.cached;
    let key = this.find();
    if (!key) {
      if (!this.opts.allowCreate) throw new KeyUnavailableError(`no backup key in Keychain (${this.opts.service}); run setup`);
      const fresh = randomBytes(32).toString('base64');
      const r = this.opts.run(['-i'], `add-generic-password -s ${this.opts.service} -a ${this.opts.account} -w ${fresh}\n`);
      if (r.status !== 0) throw new KeyUnavailableError(`security add-generic-password failed (${r.status}): ${r.stderr.trim()}`);
      key = this.find();
      if (!key) throw new KeyUnavailableError('backup key not readable after creation');
    }
    this.cached = key;
    return key;
  }
}

function keyFingerprint(key: Buffer): string { return sha256(Buffer.concat([Buffer.from('billy-backup-key-id:'), key])).slice(0, 16); }

// ---------------------------------------------------------------- helpers

export interface BackupManifest {
  id: string;
  label: string;
  format: 'billybak-v1';
  cipher: 'aes-256-gcm';
  key_fingerprint: string;
  created_at: string;
  schema_version: number;
  app_version: string;
  db_sha256: string;
  ciphertext_sha256: string;
  counts: { tasks: number; attempts: number; memory: number; outbox: number };
  last_event_seq: number;
}

function writeFileDurable(path: string, data: Buffer | string, mode = 0o600): void {
  const tmp = `${path}.tmp-${randomBytes(4).toString('hex')}`;
  const fd = openSync(tmp, 'wx', mode);
  try { writeSync(fd, typeof data === 'string' ? Buffer.from(data) : data); fsyncSync(fd); } finally { closeSync(fd); }
  renameSync(tmp, path);
  chmodSync(path, mode);
  fsyncDir(path.slice(0, path.lastIndexOf('/')) || '/');
}

function fsyncDir(dir: string): void {
  try { const fd = openSync(dir, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); } } catch { /* best effort */ }
}

function removeDbFiles(path: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) rmSync(path + suffix, { force: true });
}

/** Read-only inspection of a standalone database file: quick_check, schema, counts. */
function inspectDb(path: string): { quick_check: string; schema_version: number; counts: BackupManifest['counts']; last_event_seq: number } {
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const quick = (db.prepare('PRAGMA quick_check').all() as any[]).map((r) => r.quick_check).join('; ');
    if (quick !== 'ok') return { quick_check: quick, schema_version: -1, counts: { tasks: 0, attempts: 0, memory: 0, outbox: 0 }, last_event_seq: 0 };
    const n = (t: string) => Number((db.prepare(`SELECT count(*) c FROM ${t}`).get() as any).c);
    return {
      quick_check: quick,
      schema_version: Number((db.prepare('SELECT max(version) v FROM schema_migrations').get() as any).v ?? 0),
      counts: { tasks: n('tasks'), attempts: n('attempts'), memory: n('memory'), outbox: n('outbox') },
      last_event_seq: Number((db.prepare('SELECT coalesce(max(seq), 0) s FROM events').get() as any).s),
    };
  } finally {
    db.close();
  }
}

/**
 * Take the data directory's instance lock with the same semantics as Store.open, so a
 * restore or quarantine can never run underneath a live core.
 */
function acquireInstanceLock(dir: string): DatabaseSync {
  let l: DatabaseSync | null = null;
  try {
    l = new DatabaseSync(join(dir, 'instance.lock'), { timeout: 50 });
    l.exec('PRAGMA locking_mode=EXCLUSIVE; CREATE TABLE IF NOT EXISTS owner(pid INTEGER, at TEXT);');
    l.prepare('INSERT INTO owner VALUES (?, ?)').run(process.pid, new Date().toISOString());
    l.exec('DELETE FROM owner WHERE rowid NOT IN (SELECT max(rowid) FROM owner)');
    return l;
  } catch (e) {
    try { l?.close(); } catch { /* ignore */ }
    throw new InstanceLockedError(`data directory in use: ${dir}: ${(e as Error).message}`);
  }
}

function maxSchema(migrations: Migration[]): number { return Math.max(...migrations.map((m) => m.version)); }

// ---------------------------------------------------------------- manager

export interface BackupManagerOptions {
  dataDir: string;
  keys: KeyProvider;
  store?: Store;            // required for create(); absent during corruption recovery
  backupDir?: string;       // default <dataDir>/backups
  appVersion?: string;
  migrations?: Migration[]; // compatibility range; default MIGRATIONS
  clock?: () => number;
}

export type VerifyResult = { ok: true; manifest: BackupManifest } | { ok: false; id: string; reason: string };

export class BackupManager {
  readonly dir: string;
  private o: BackupManagerOptions;

  constructor(o: BackupManagerOptions) {
    this.o = o;
    this.dir = o.backupDir ?? join(o.dataDir, 'backups');
    mkdirSync(this.dir, { recursive: true, mode: 0o700 });
    chmodSync(this.dir, 0o700);
  }

  private now(): Date { return new Date((this.o.clock ?? Date.now)()); }
  private paths(id: string) {
    if (!/^[A-Za-z0-9._-]+$/.test(id)) throw new BackupError(`bad backup id ${id}`);
    return { bak: join(this.dir, `${id}.billybak`), manifest: join(this.dir, `${id}.manifest.json`) };
  }
  private aad(id: string): Buffer { return Buffer.from(`billybak:v1:${id}`); }

  /** Consistent online backup -> quick_check -> encrypt -> manifest. Plaintext never outlives this call. */
  async create(label = 'manual'): Promise<BackupManifest> {
    const store = this.o.store;
    if (!store) throw new BackupError('BackupManager.create requires an open store');
    const at = this.now();
    const safeLabel = label.replace(/[^A-Za-z0-9_-]/g, '-').slice(0, 40) || 'backup';
    const id = `${at.toISOString().replace(/[:.]/g, '-')}-${safeLabel}-${randomBytes(3).toString('hex')}`;
    const p = this.paths(id);
    const plain = join(this.dir, `.plain-${id}.db`);
    try {
      // Observed on Node 26.8: under node:test the backup() promise can sit unresolved for
      // many seconds of an otherwise idle loop; a short ref'd timer keeps it ticking.
      const keepAlive = setInterval(() => {}, 10);
      let b: Awaited<ReturnType<Store['backupTo']>>;
      try { b = await store.backupTo(plain); } finally { clearInterval(keepAlive); }
      const info = inspectDb(plain);
      if (info.quick_check !== 'ok') throw new CorruptionError(`backup quick_check: ${info.quick_check}`);
      const data = readFileSync(plain);
      const dbSha = sha256(data);
      if (dbSha !== b.sha256) throw new BackupError('backup changed between verification and encryption');
      const key = this.o.keys.getKey();
      const iv = randomBytes(IV_LEN);
      const c = createCipheriv('aes-256-gcm', key, iv);
      c.setAAD(this.aad(id));
      const body = Buffer.concat([c.update(data), c.final()]);
      const blob = Buffer.concat([MAGIC, iv, c.getAuthTag(), body]);
      writeFileDurable(p.bak, blob);
      const manifest: BackupManifest = {
        id, label, format: 'billybak-v1', cipher: 'aes-256-gcm', key_fingerprint: keyFingerprint(key),
        created_at: at.toISOString(), schema_version: info.schema_version, app_version: this.o.appVersion ?? APP_VERSION,
        db_sha256: dbSha, ciphertext_sha256: sha256(blob), counts: info.counts, last_event_seq: info.last_event_seq,
      };
      writeFileDurable(p.manifest, JSON.stringify(manifest, null, 2));
      return manifest;
    } finally {
      removeDbFiles(plain);
    }
  }

  manifest(id: string): BackupManifest {
    return JSON.parse(readFileSync(this.paths(id).manifest, 'utf8'));
  }

  /** Newest first. Unreadable manifests are skipped (verify() reports them). */
  list(): BackupManifest[] {
    const out: BackupManifest[] = [];
    for (const f of readdirSync(this.dir)) {
      if (!f.endsWith('.manifest.json')) continue;
      try { out.push(JSON.parse(readFileSync(join(this.dir, f), 'utf8'))); } catch { /* corrupt manifest */ }
    }
    return out.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : b.id.localeCompare(a.id)));
  }

  /** Decrypt `id` into `dest` (0600); checks ciphertext digest, GCM tag and plaintext digest. */
  private decryptTo(id: string, dest: string): BackupManifest {
    const m = this.manifest(id);
    const blob = readFileSync(this.paths(id).bak);
    if (sha256(blob) !== m.ciphertext_sha256) throw new BackupError('ciphertext digest mismatch');
    if (!blob.subarray(0, MAGIC.length).equals(MAGIC)) throw new BackupError('not a billybak-v1 file');
    const key = this.o.keys.getKey();
    if (keyFingerprint(key) !== m.key_fingerprint) throw new BackupError('backup was encrypted under a different key');
    const iv = blob.subarray(MAGIC.length, MAGIC.length + IV_LEN);
    const tag = blob.subarray(MAGIC.length + IV_LEN, MAGIC.length + IV_LEN + TAG_LEN);
    const d = createDecipheriv('aes-256-gcm', key, iv);
    d.setAAD(this.aad(id));
    d.setAuthTag(tag);
    let plain: Buffer;
    try { plain = Buffer.concat([d.update(blob.subarray(MAGIC.length + IV_LEN + TAG_LEN)), d.final()]); } catch {
      throw new BackupError('authentication failed (tampered or wrong key)');
    }
    if (sha256(plain) !== m.db_sha256) throw new BackupError('plaintext digest mismatch');
    writeFileDurable(dest, plain);
    return m;
  }

  /** Full verification: decrypt to a temp file, digest + quick_check + manifest agreement, then delete. */
  verify(id: string): VerifyResult {
    const tmp = join(this.dir, `.verify-${randomBytes(6).toString('hex')}.db`);
    try {
      const m = this.decryptTo(id, tmp);
      const info = inspectDb(tmp);
      if (info.quick_check !== 'ok') return { ok: false, id, reason: `quick_check: ${info.quick_check}` };
      if (info.schema_version !== m.schema_version) return { ok: false, id, reason: 'schema version disagrees with manifest' };
      if (info.last_event_seq !== m.last_event_seq) return { ok: false, id, reason: 'event sequence disagrees with manifest' };
      return { ok: true, manifest: m };
    } catch (e) {
      return { ok: false, id, reason: (e as Error).message };
    } finally {
      removeDbFiles(tmp);
    }
  }

  /** Keep the newest `keep` backups; returns removed ids. */
  prune(keep: number): string[] {
    if (!Number.isInteger(keep) || keep < 1) throw new BackupError('prune keeps at least one backup');
    const removed: string[] = [];
    for (const m of this.list().slice(keep)) {
      const p = this.paths(m.id);
      rmSync(p.bak, { force: true });
      rmSync(p.manifest, { force: true });
      removed.push(m.id);
    }
    return removed;
  }

  /**
   * Restore backup `id` into `targetDataDir`, which must not be in use and must not
   * already hold a database (move a newer/damaged one aside first). Never creates a
   * blank database: the only bytes written are the verified backup.
   */
  restore(id: string, targetDataDir: string): { db_path: string; manifest: BackupManifest } {
    const m = this.manifest(id);
    const max = maxSchema(this.o.migrations ?? MIGRATIONS);
    if (m.schema_version > max) throw new CompatibilityError(`backup schema v${m.schema_version} is newer than this build (max v${max})`);
    mkdirSync(targetDataDir, { recursive: true, mode: 0o700 });
    chmodSync(targetDataDir, 0o700);
    const lock = acquireInstanceLock(targetDataDir);
    const dbPath = join(targetDataDir, 'billy.db');
    const staging = join(targetDataDir, `.restoring-${randomBytes(6).toString('hex')}.db`);
    try {
      const present = DB_FILES.filter((f) => existsSync(join(targetDataDir, f)));
      if (present.length) throw new RestoreRefusedError(`target already has ${present.join(', ')}; move it aside first`);
      this.decryptTo(id, staging);
      const info = inspectDb(staging);
      if (info.quick_check !== 'ok') throw new CorruptionError(`restored copy quick_check: ${info.quick_check}`);
      if (info.schema_version !== m.schema_version || info.schema_version > max) throw new CompatibilityError('restored schema version mismatch');
      rmSync(staging + '-wal', { force: true }); rmSync(staging + '-shm', { force: true });
      renameSync(staging, dbPath);
      chmodSync(dbPath, 0o600);
      fsyncDir(targetDataDir);
      const rec = { at: this.now().toISOString(), backup_id: id, db_sha256: m.db_sha256, schema_version: m.schema_version,
        last_event_seq: m.last_event_seq, backup_created_at: m.created_at };
      appendFileSync(join(targetDataDir, 'restore-log.jsonl'), JSON.stringify(rec) + '\n', { mode: 0o600 });
      return { db_path: dbPath, manifest: m };
    } finally {
      removeDbFiles(staging);
      lock.close();
    }
  }
}

// ---------------------------------------------------------------- corruption flow

export interface Incident {
  incident_id: string;
  kind: 'database_corruption';
  detected_at: string;
  data_dir: string;
  error: string;
  quarantine_dir: string;
  files: { name: string; bytes: number; sha256: string }[];
  dispatch: 'stopped';
  next_step: 'restoreLatestVerified';
}

export type OpenResult = { status: 'OK'; store: Store } | { status: 'CORRUPT'; incident: Incident };

/**
 * Open the store, or on corruption stop: move the damaged files (byte-preserving rename)
 * into <dataDir>/quarantine/<ts>/, write an incident, and leave a recovery marker so a
 * later open does not proceed either. No database is created on this path.
 */
export function openOrQuarantine(dataDir: string, opts: Omit<OpenOptions, 'dir'> = {}): OpenResult {
  const marker = join(dataDir, RECOVERY_MARKER);
  if (existsSync(marker)) return { status: 'CORRUPT', incident: JSON.parse(readFileSync(marker, 'utf8')) };
  try {
    return { status: 'OK', store: Store.open({ ...opts, dir: dataDir }) };
  } catch (e) {
    if (!(e instanceof CorruptionError)) throw e;
    const lock = acquireInstanceLock(dataDir);
    try {
      const ts = new Date().toISOString().replace(/[:.]/g, '-');
      const qdir = join(dataDir, 'quarantine', `${ts}-${randomBytes(3).toString('hex')}`);
      mkdirSync(qdir, { recursive: true, mode: 0o700 });
      const files: Incident['files'] = [];
      for (const f of DB_FILES) {
        const src = join(dataDir, f);
        if (!existsSync(src)) continue;
        const before = readFileSync(src);
        renameSync(src, join(qdir, f));
        const after = sha256(readFileSync(join(qdir, f)));
        if (after !== sha256(before)) throw new Error(`quarantine changed bytes of ${f}`);
        files.push({ name: f, bytes: before.length, sha256: after });
      }
      fsyncDir(qdir); fsyncDir(dataDir);
      const incident: Incident = {
        incident_id: crypto.randomUUID(), kind: 'database_corruption', detected_at: new Date().toISOString(), data_dir: dataDir,
        error: (e as Error).message, quarantine_dir: qdir, files, dispatch: 'stopped', next_step: 'restoreLatestVerified',
      };
      writeFileDurable(join(qdir, 'incident.json'), JSON.stringify(incident, null, 2));
      writeFileDurable(marker, JSON.stringify(incident, null, 2));
      return { status: 'CORRUPT', incident };
    } finally {
      lock.close();
    }
  }
}

export type RecoveryResult =
  | { status: 'RESTORED'; backup_id: string; manifest: BackupManifest; skipped: { id: string; reason: string }[]; incident_id: string | null }
  | { status: 'NO_VERIFIED_BACKUP'; skipped: { id: string; reason: string }[] };

/**
 * Explicit recovery: restore the newest backup that passes verify() into dataDir, record
 * which backup was used (restore-log.jsonl + quarantine incident), and clear the marker.
 */
export function restoreLatestVerified(dataDir: string, manager: BackupManager): RecoveryResult {
  const skipped: { id: string; reason: string }[] = [];
  const markerPath = join(dataDir, RECOVERY_MARKER);
  const incident: Incident | null = existsSync(markerPath) ? JSON.parse(readFileSync(markerPath, 'utf8')) : null;
  for (const m of manager.list()) {
    const v = manager.verify(m.id);
    if (!v.ok) { skipped.push({ id: m.id, reason: v.reason }); continue; }
    manager.restore(m.id, dataDir);
    if (incident) {
      const resolved = { ...incident, resolved_at: new Date().toISOString(), restored_from_backup: m.id, skipped_backups: skipped };
      writeFileDurable(join(incident.quarantine_dir, 'incident.json'), JSON.stringify(resolved, null, 2));
      rmSync(markerPath, { force: true });
    }
    return { status: 'RESTORED', backup_id: m.id, manifest: v.manifest, skipped, incident_id: incident?.incident_id ?? null };
  }
  return { status: 'NO_VERIFIED_BACKUP', skipped };
}

// ---------------------------------------------------------------- post-restore

const NEEDS_RECONCILIATION = ['PROPOSED', 'VALIDATED', 'AUTHORIZED', 'PREPARED', 'DISPATCHING', 'OBSERVED_SUCCESS',
  'OUTCOME_UNKNOWN', 'RECONCILING', 'UNRESOLVED'];

/**
 * What a restored store must reconcile before dispatch resumes. Attempts listed here
 * are left untouched; Core.recover() reconciles them against the real world. Effects
 * after `last_event_seq` happened after the backup point and are discovered by that
 * reconciliation, never replayed blindly. COMMITTED attempts stay committed (dedup).
 */
export function postRestoreReport(store: Store): {
  last_event_seq: number; schema_version: number; committed: number;
  needs_reconciliation: { attempt_id: string; task_id: string; tool_id: string; status: string; semantic_operation_id: string }[];
  restore: Record<string, unknown> | null;
} {
  const db = store.db;
  const ph = NEEDS_RECONCILIATION.map(() => '?').join(',');
  const rows = db.prepare(`SELECT attempt_id, task_id, tool_id, status, semantic_operation_id FROM attempts
    WHERE status IN (${ph}) ORDER BY created_at`).all(...NEEDS_RECONCILIATION) as any[];
  const logPath = join(store.dir, 'restore-log.jsonl');
  const lines = existsSync(logPath) ? readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean) : [];
  return {
    last_event_seq: Number((db.prepare('SELECT coalesce(max(seq), 0) s FROM events').get() as any).s),
    schema_version: store.schemaVersion(),
    committed: Number((db.prepare(`SELECT count(*) c FROM attempts WHERE status='COMMITTED'`).get() as any).c),
    needs_reconciliation: rows.map((r) => ({ ...r })),
    restore: lines.length ? JSON.parse(lines[lines.length - 1]) : null,
  };
}

