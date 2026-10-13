// File tool family (handoff §16.1): bounded reads, hashes, atomic no-clobber
// writes, copy, move and reversible trash. Every mutating tool canonicalises
// the target, refuses symlinked components, re-checks root identity (dev:ino)
// at dispatch, and verifies resulting bytes independently of the dispatch call.
import {
  closeSync, constants as C, fchmodSync, fstatSync, existsSync, fsyncSync, linkSync, lstatSync, mkdirSync,
  openSync, readdirSync, readFileSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, isAbsolute, join, normalize, sep } from 'node:path';
import { sha256 } from '../util/canon.ts';
import type { Condition, ToolSpec } from '../contracts/action.ts';
import type { Schema } from '../contracts/schema.ts';
import type { ToolAdapter, ResolvedTarget, CheckResult } from '../broker/types.ts';
import { TargetError } from '../broker/types.ts';

export const MAX_READ_BYTES = 4 * 1024 * 1024;
export const MAX_WRITE_BYTES = 16 * 1024 * 1024;

const pathArg: Schema = { type: 'string', minLength: 1, maxLength: 1024, pattern: '^/' };

/**
 * Canonicalise a path for authorization: the parent must exist and contain no
 * symlinks between the root and the leaf; the leaf itself must not be a symlink.
 * Returns the canonical path plus the identity of the parent directory.
 */
export function canonicalTarget(p: string, mustExist: boolean): { path: string; parent: string; parentId: string; exists: boolean } {
  if (!isAbsolute(p)) throw new TargetError('path must be absolute');
  if (p.includes('\0')) throw new TargetError('NUL in path');
  const norm = normalize(p);
  if (norm.split(sep).includes('..')) throw new TargetError('path traversal');
  const parent = dirname(norm);
  let realParent: string;
  try { realParent = realpathSync(parent); } catch { throw new TargetError(`parent does not exist: ${parent}`); }
  const leaf = basename(norm);
  const full = join(realParent, leaf);
  let exists = false;
  try {
    const st = lstatSync(full);
    if (st.isSymbolicLink()) throw new TargetError('target is a symlink');
    exists = true;
  } catch (e) {
    if (e instanceof TargetError) throw e;
  }
  if (mustExist && !exists) throw new TargetError(`target does not exist: ${full}`);
  const pst = statSync(realParent);
  return { path: full, parent: realParent, parentId: `${pst.dev}:${pst.ino}`, exists };
}

function rootIdentity(p: string): string {
  // Identity of the parent dir at dispatch time; detects mount swaps and dir replacement.
  try { const st = statSync(realpathSync(dirname(p))); return `${st.dev}:${st.ino}`; } catch { return 'missing'; }
}

function fileDigest(p: string): string | null {
  try {
    const st = lstatSync(p);
    if (!st.isFile() || st.size > MAX_WRITE_BYTES) return null;
    return sha256(readFileSync(p));
  } catch { return null; }
}

/**
 * Publish a fully written temporary file under `p` without clobbering, then prove the
 * new name refers to the very inode Billy wrote. link() follows a symlink, so code with
 * write access to the directory could swap the temporary name for a symlink to a file
 * outside the grant; the post-link inode and parent checks detect that and undo it.
 */
export function publishInode(tmp: string, ino: number, p: string, parentId: string, mode: 'create' | 'replace'): void {
  if (mode === 'create') linkSync(tmp, p); else renameSync(tmp, p);
  let st: ReturnType<typeof lstatSync> | null = null;
  try { st = lstatSync(p); } catch { /* vanished */ }
  if (!st || !st.isFile() || st.ino !== ino || rootIdentity(p) !== parentId) {
    if (st && (mode === 'create' || st.ino !== ino)) { try { unlinkSync(p); } catch { /* gone */ } }
    throw new Error('published file identity changed during write (possible symlink swap)');
  }
  if (mode === 'create') { try { unlinkSync(tmp); } catch { /* gone */ } }
}

/** Write bytes to a fresh temporary file in `dir` (O_EXCL|O_NOFOLLOW) and return its inode. */
function writeTemp(tmp: string, data: Buffer, mode: number): number {
  const fd = openSync(tmp, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
  try {
    writeSync(fd, data);
    fchmodSync(fd, mode);
    fsyncSync(fd);
    return fstatSync(fd).ino;
  } finally { closeSync(fd); }
}

/** Read a regular file through a no-follow descriptor (bounded). */
function readNoFollow(p: string): { data: Buffer; ino: number; mode: number } {
  const fd = openSync(p, C.O_RDONLY | C.O_NOFOLLOW);
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.size > MAX_WRITE_BYTES) throw new Error('source is not a bounded regular file');
    const data = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) { const n = readSync(fd, data, off, st.size - off, off); if (n <= 0) break; off += n; }
    return { data: data.subarray(0, off), ino: st.ino, mode: st.mode & 0o7777 };
  } finally { closeSync(fd); }
}

function fsyncDir(p: string): void {
  const dfd = openSync(dirname(p), C.O_RDONLY);
  try { fsyncSync(dfd); } finally { closeSync(dfd); }
}

function baseSpec(over: Partial<ToolSpec> & Pick<ToolSpec, 'tool_id' | 'description' | 'input_schema' | 'effect_class'>): ToolSpec {
  return {
    version: 1, output_schema: { type: 'object', additionalProperties: true }, tool_class: 'file',
    capabilities: [], target_kind: 'file', cancellation: 'none', timeout_ms: 10_000,
    idempotency: 'none', verification: 'file_digest', reconciliation: 'file_digest',
    compensation: 'none', lock_class: 'path', egress: 'none', executable_identity: 'core/src/tools/fs.ts',
    ...over,
  };
}

const ok: CheckResult = { ok: true };

function fileResolved(path: string, parentId: string, mode: 'shared' | 'exclusive'): ResolvedTarget {
  return { resource_id: `file:${path}`, account_id: null, facts: { file_path: path },
    claims: [{ resource_key: `path:${path.toLowerCase()}`, mode }], fingerprint: parentId };
}

// ---------------- read-only tools ----------------

export const fsRead: ToolAdapter = {
  spec: baseSpec({
    tool_id: 'fs.read', description: 'Read a bounded UTF-8 or base64 slice of a file inside a granted root',
    effect_class: 'READ_ONLY', idempotency: 'inherent', capabilities: ['fs.read'],
    input_schema: { type: 'object', required: ['path'], properties: { path: pathArg,
      max_bytes: { type: 'integer', minimum: 1, maximum: MAX_READ_BYTES }, encoding: { enum: ['utf8', 'base64'] } } },
  }),
  paths: (a) => [a.path],
  resolve(a) { const t = canonicalTarget(a.path, true); return fileResolved(t.path, t.parentId, 'shared'); },
  fingerprint: (r) => rootIdentity(r.facts.file_path!),
  preconditions: () => ok,
  postconditions: () => [],
  async dispatch(a, r) {
    const p = r.facts.file_path!;
    const st = lstatSync(p);
    if (!st.isFile()) return { outcome: 'failure', error: 'not a regular file' };
    const max = a.max_bytes ?? 256 * 1024;
    const fd = openSync(p, C.O_RDONLY | C.O_NOFOLLOW);
    try {
      const buf = Buffer.alloc(Math.min(max, st.size));
      let off = 0;
      while (off < buf.length) { const n = readSync(fd, buf, off, buf.length - off, off); if (!n) break; off += n; }
      const data = buf.subarray(0, off);
      return { outcome: 'success', receipt: { size: st.size, truncated: st.size > off, sha256_of_returned: sha256(data),
        content: a.encoding === 'base64' ? data.toString('base64') : data.toString('utf8') } };
    } finally { closeSync(fd); }
  },
  async verify() { return { verdict: 'verified', evidence: { read_only: true } }; },
  async reconcile() { return { status: 'not_applied', evidence: { read_only: true } }; },
};

export const fsList: ToolAdapter = {
  spec: baseSpec({
    tool_id: 'fs.list', description: 'List directory entries (bounded) inside a granted root',
    effect_class: 'READ_ONLY', idempotency: 'inherent', capabilities: ['fs.read'],
    input_schema: { type: 'object', required: ['path'], properties: { path: pathArg, limit: { type: 'integer', minimum: 1, maximum: 5000 } } },
  }),
  paths: (a) => [a.path],
  resolve(a) {
    let real: string;
    try { real = realpathSync(a.path); } catch { throw new TargetError('directory does not exist'); }
    if (real !== normalize(a.path).replace(/\/$/, '') && lstatSync(a.path).isSymbolicLink()) throw new TargetError('directory is a symlink');
    const st = statSync(real);
    if (!st.isDirectory()) throw new TargetError('not a directory');
    return { resource_id: `dir:${real}`, account_id: null, facts: { file_path: real }, claims: [], fingerprint: `${st.dev}:${st.ino}` };
  },
  fingerprint: (r) => { try { const s = statSync(r.facts.file_path!); return `${s.dev}:${s.ino}`; } catch { return 'missing'; } },
  preconditions: () => ok,
  postconditions: () => [],
  async dispatch(a, r) {
    const entries = readdirSync(r.facts.file_path!, { withFileTypes: true }).slice(0, a.limit ?? 500)
      .map((e) => ({ name: e.name, type: e.isDirectory() ? 'dir' : e.isSymbolicLink() ? 'symlink' : e.isFile() ? 'file' : 'other' }));
    return { outcome: 'success', receipt: { entries } };
  },
  async verify() { return { verdict: 'verified', evidence: { read_only: true } }; },
  async reconcile() { return { status: 'not_applied', evidence: { read_only: true } }; },
};

export const fsStat: ToolAdapter = {
  spec: baseSpec({
    tool_id: 'fs.stat', description: 'Metadata and sha256 of a file inside a granted root',
    effect_class: 'READ_ONLY', idempotency: 'inherent', capabilities: ['fs.read'],
    input_schema: { type: 'object', required: ['path'], properties: { path: pathArg } },
  }),
  paths: (a) => [a.path],
  resolve(a) { const t = canonicalTarget(a.path, false); return fileResolved(t.path, t.parentId, 'shared'); },
  fingerprint: (r) => rootIdentity(r.facts.file_path!),
  preconditions: () => ok,
  postconditions: () => [],
  async dispatch(_a, r) {
    const p = r.facts.file_path!;
    if (!existsSync(p)) return { outcome: 'success', receipt: { exists: false } };
    const st = lstatSync(p);
    return { outcome: 'success', receipt: { exists: true, type: st.isFile() ? 'file' : st.isDirectory() ? 'dir' : 'other',
      size: st.size, mtime: st.mtime.toISOString(), sha256: st.isFile() && st.size <= MAX_WRITE_BYTES ? fileDigest(p) : null } };
  },
  async verify() { return { verdict: 'verified', evidence: { read_only: true } }; },
  async reconcile() { return { status: 'not_applied', evidence: { read_only: true } }; },
};

// ---------------- mutating tools ----------------

/**
 * fs.write: atomic write of exact content.
 * mode "create": fails if the target exists (no clobber; atomic via link()).
 * mode "replace": requires expected_sha256 of current content (optimistic precondition).
 * Idempotent by content: reconciliation compares the resulting digest.
 */
export const fsWrite: ToolAdapter = {
  spec: baseSpec({
    tool_id: 'fs.write', description: 'Atomically write exact content to a file (no-clobber create or digest-guarded replace)',
    effect_class: 'IDEMPOTENT_WRITE', idempotency: 'inherent', capabilities: ['fs.write'],
    compensation: 'replace mode keeps no copy of prior bytes; use fs.trash first when preservation is required',
    input_schema: { type: 'object', required: ['path', 'content', 'mode'], properties: {
      path: pathArg, content: { type: 'string', maxLength: MAX_WRITE_BYTES }, encoding: { enum: ['utf8', 'base64'] },
      mode: { enum: ['create', 'replace'] }, expected_sha256: { type: 'string', format: 'sha256' } } },
  }),
  paths: (a) => [a.path],
  resolve(a) { const t = canonicalTarget(a.path, false); return fileResolved(t.path, t.parentId, 'exclusive'); },
  fingerprint: (r) => rootIdentity(r.facts.file_path!),
  preconditions(a, r) {
    const cur = fileDigest(r.facts.file_path!);
    const want = sha256(bytesOf(a));
    if (a.mode === 'create') {
      if (cur === null && existsSync(r.facts.file_path!)) return { ok: false, reason: 'target exists and is not a regular file' };
      if (cur !== null && cur !== want) return { ok: false, reason: 'target already exists (no clobber)' };
      return { ok: true, evidence: { current: cur } };
    }
    if (!a.expected_sha256) return { ok: false, reason: 'replace requires expected_sha256' };
    if (cur !== a.expected_sha256 && cur !== want) return { ok: false, reason: `current content ${cur} != expected ${a.expected_sha256}` };
    return { ok: true, evidence: { current: cur } };
  },
  postconditions(a, r) { return [{ kind: 'file_sha256', path: r.facts.file_path!, sha256: sha256(bytesOf(a)) }]; },
  async dispatch(a, r, ctx) {
    const p = r.facts.file_path!;
    const data = bytesOf(a);
    if (fileDigest(p) === sha256(data)) return { outcome: 'success', receipt: { already_present: true } };
    const tmp = join(dirname(p), `.billy-${ctx.attemptId}.tmp`);
    let mode = 0o644 & ~process.umask();
    try { mode = lstatSync(p).mode & 0o7777; } catch { /* new file */ }
    try {
      const ino = writeTemp(tmp, data, mode);
      if (rootIdentity(p) !== r.fingerprint) throw new Error('parent directory identity changed during write');
      if (a.mode === 'replace' && fileDigest(p) !== a.expected_sha256 && fileDigest(p) !== sha256(data)) throw new Error('target changed since the precondition check');
      publishInode(tmp, ino, p, r.fingerprint, a.mode); // create: atomic no-clobber (EEXIST if a file appeared meanwhile)
      fsyncDir(p);
    } catch (e) {
      try { unlinkSync(tmp); } catch { /* gone (unlink never follows a symlink) */ }
      const code = (e as NodeJS.ErrnoException).code;
      return { outcome: 'failure', error: `${code ?? ''} ${(e as Error).message}`.trim(), retryable: false };
    }
    return { outcome: 'success', receipt: { bytes: data.length } };
  },
  async verify(_a, _r, post) { return verifyFileConditions(post); },
  async reconcile(_a, r, post, ctx) {
    try { unlinkSync(join(dirname(r.facts.file_path!), `.billy-${ctx.attemptId}.tmp`)); } catch { /* none */ }
    const v = verifyFileConditions(post);
    return { status: v.verdict === 'verified' ? 'applied' : 'not_applied', evidence: v.evidence };
  },
};

function bytesOf(a: { content: string; encoding?: string }): Buffer {
  return a.encoding === 'base64' ? Buffer.from(a.content, 'base64') : Buffer.from(a.content, 'utf8');
}

export function verifyFileConditions(post: Condition[]): { verdict: 'verified' | 'failed'; evidence: unknown } {
  const results = post.map((c) => {
    if (c.kind === 'file_sha256') { const got = fileDigest(String(c.path)); return { c, ok: got === c.sha256, got }; }
    if (c.kind === 'file_absent') { const ok = !existsSync(String(c.path)); return { c, ok, got: ok ? 'absent' : 'present' }; }
    if (c.kind === 'file_contains') {
      try {
        const st = lstatSync(String(c.path));
        if (!st.isFile() || st.size > MAX_WRITE_BYTES) return { c, ok: false, got: 'not a bounded regular file' };
        const ok = readFileSync(String(c.path), 'utf8').includes(String(c.text)); return { c, ok, got: ok };
      } catch { return { c, ok: false, got: 'unreadable' }; }
    }
    return { c, ok: false, got: `unsupported condition ${c.kind}` };
  });
  return { verdict: results.every((r) => r.ok) ? 'verified' : 'failed', evidence: results };
}

/** fs.copy: no-clobber copy; verified by destination digest equal to source digest at prepare time. */
export const fsCopy: ToolAdapter = {
  spec: baseSpec({
    tool_id: 'fs.copy', description: 'Copy a file to a new path (no clobber)', effect_class: 'IDEMPOTENT_WRITE',
    idempotency: 'inherent', capabilities: ['fs.read', 'fs.write'],
    input_schema: { type: 'object', required: ['from', 'to'], properties: { from: pathArg, to: pathArg } },
  }),
  paths: (a) => [a.from, a.to],
  resolve(a) {
    const s = canonicalTarget(a.from, true);
    const d = canonicalTarget(a.to, false);
    const srcDigest = fileDigest(s.path);
    if (!srcDigest) throw new TargetError('source is not a regular file');
    return { resource_id: `file:${d.path}`, account_id: null, facts: { file_path: d.path, file_paths: [s.path, d.path], src: s.path, src_sha256: srcDigest } as any,
      claims: [{ resource_key: `path:${s.path.toLowerCase()}`, mode: 'shared' }, { resource_key: `path:${d.path.toLowerCase()}`, mode: 'exclusive' }],
      fingerprint: `${s.parentId}|${d.parentId}` };
  },
  fingerprint: (r) => `${rootIdentity((r.facts as any).src)}|${rootIdentity(r.facts.file_path!)}`,
  preconditions(_a, r) {
    const f = r.facts as any;
    if (fileDigest(f.src) !== f.src_sha256) return { ok: false, reason: 'source changed since resolution' };
    const cur = fileDigest(r.facts.file_path!);
    if (existsSync(r.facts.file_path!) && cur !== f.src_sha256) return { ok: false, reason: 'destination exists (no clobber)' };
    return ok;
  },
  postconditions(_a, r) { const f = r.facts as any; return [{ kind: 'file_sha256', path: f.file_path, sha256: f.src_sha256 }, { kind: 'file_sha256', path: f.src, sha256: f.src_sha256 }]; },
  async dispatch(_a, r, ctx) {
    const f = r.facts as any;
    if (fileDigest(f.file_path) === f.src_sha256) return { outcome: 'success', receipt: { already_present: true } };
    // Read through a no-follow descriptor: a source swapped for a symlink after resolution is refused.
    const tmp = join(dirname(f.file_path), `.billy-${ctx.attemptId}.tmp`);
    try {
      const src = readNoFollow(f.src);
      if (sha256(src.data) !== f.src_sha256) throw new Error('source changed since resolution');
      const ino = writeTemp(tmp, src.data, src.mode);
      publishInode(tmp, ino, f.file_path, (r.fingerprint ?? '').split('|')[1], 'create');
      fsyncDir(f.file_path);
    } catch (e) {
      try { unlinkSync(tmp); } catch { /* gone */ }
      return { outcome: 'failure', error: (e as Error).message };
    }
    return { outcome: 'success', receipt: {} };
  },
  async verify(_a, _r, post) { return verifyFileConditions(post); },
  async reconcile(_a, r, post) { return reconcileTransfer(post, r.facts); },
};

/** fs.move: rename within the same volume, no clobber. */
export const fsMove: ToolAdapter = {
  spec: baseSpec({
    tool_id: 'fs.move', description: 'Move/rename a file within one volume (no clobber)', effect_class: 'IDEMPOTENT_WRITE',
    idempotency: 'inherent', capabilities: ['fs.write'],
    input_schema: { type: 'object', required: ['from', 'to'], properties: { from: pathArg, to: pathArg } },
  }),
  paths: (a) => [a.from, a.to],
  resolve(a) {
    const d = canonicalTarget(a.to, false);
    let s: ReturnType<typeof canonicalTarget> | null = null;
    try { s = canonicalTarget(a.from, true); } catch (e) {
      // Reconciliation-friendly: if the source is gone but destination exists, keep resolving.
      if (!d.exists) throw e;
    }
    const srcPath = s?.path ?? join(realpathSync(dirname(a.from)), basename(a.from));
    const digestNow = fileDigest(s ? s.path : d.path);
    if (!digestNow) throw new TargetError('source is not a regular file');
    return { resource_id: `file:${srcPath}->${d.path}`, account_id: null,
      facts: { file_path: d.path, file_paths: [srcPath, d.path], src: srcPath, src_sha256: digestNow } as any,
      claims: [{ resource_key: `path:${srcPath.toLowerCase()}`, mode: 'exclusive' }, { resource_key: `path:${d.path.toLowerCase()}`, mode: 'exclusive' }],
      fingerprint: `${rootIdentity(srcPath)}|${d.parentId}` };
  },
  fingerprint: (r) => `${rootIdentity((r.facts as any).src)}|${rootIdentity(r.facts.file_path!)}`,
  preconditions(_a, r) {
    const f = r.facts as any;
    if (existsSync(f.file_path)) return fileDigest(f.file_path) === f.src_sha256 && !existsSync(f.src) ? ok : { ok: false, reason: 'destination exists (no clobber)' };
    if (fileDigest(f.src) !== f.src_sha256) return { ok: false, reason: 'source changed' };
    if (statSync(dirname(f.src)).dev !== statSync(dirname(f.file_path)).dev) return { ok: false, reason: 'cross-volume move not supported; use copy then trash' };
    return ok;
  },
  postconditions(_a, r): Condition[] { const f = r.facts as any; return [{ kind: 'file_sha256', path: f.file_path, sha256: f.src_sha256 }, { kind: 'file_absent', path: f.src } as Condition]; },
  async dispatch(_a, r) {
    const f = r.facts as any;
    if (!existsSync(f.src) && fileDigest(f.file_path) === f.src_sha256) return { outcome: 'success', receipt: { already_moved: true } };
    // link() follows a symlink: pin the source inode, link, then prove the new name is that inode.
    let ino: number;
    try {
      const st = lstatSync(f.src);
      if (!st.isFile()) return { outcome: 'failure', error: 'source is not a regular file' };
      ino = st.ino;
      linkSync(f.src, f.file_path);
    } catch (e) { return { outcome: 'failure', error: (e as Error).message }; }
    const dst = (() => { try { return lstatSync(f.file_path); } catch { return null; } })();
    if (!dst || dst.ino !== ino || rootIdentity(f.file_path) !== (r.fingerprint ?? '').split('|')[1]) {
      if (dst) { try { unlinkSync(f.file_path); } catch { /* gone */ } }
      return { outcome: 'failure', error: 'source identity changed during move (possible symlink swap)' };
    }
    try {
      if (lstatSync(f.src).ino !== ino) return { outcome: 'unknown', error: 'source replaced after link; destination kept, source left in place' };
      unlinkSync(f.src);
    } catch (e) {
      // The destination exists but the source may remain: a partial move, not a clean failure.
      return { outcome: 'unknown', error: `source not removed: ${(e as Error).message}` };
    }
    return { outcome: 'success', receipt: {} };
  },
  async verify(_a, _r, post) { return verifyFileConditions(post); },
  async reconcile(_a, r, post) { return reconcileTransfer(post, r.facts); },
};

/** fs.trash: reversible removal into the user's Trash on the same volume (never permanent deletion). */
export function trashDirFor(p: string): string {
  const home = homedir();
  if (statSync(dirname(p)).dev === statSync(home).dev) return join(home, '.Trash');
  throw new TargetError('trash on other volumes is not supported by Billy (no permanent deletion fallback)');
}

export const fsTrash: ToolAdapter = {
  spec: baseSpec({
    tool_id: 'fs.trash', description: 'Move a file to the user Trash (reversible; never permanent delete)',
    effect_class: 'IDEMPOTENT_WRITE', idempotency: 'inherent', capabilities: ['fs.write'],
    compensation: 'restore by moving the recorded trash path back',
    input_schema: { type: 'object', required: ['path'], properties: { path: pathArg } },
  }),
  paths: (a) => [a.path],
  resolve(a, ctx) {
    const t = canonicalTarget(a.path, false);
    const dg = fileDigest(t.path);
    return { resource_id: `file:${t.path}`, account_id: null, facts: { file_path: t.path, sha: dg, trash: (ctx.services.trashDir as string | undefined) ?? null } as any,
      claims: [{ resource_key: `path:${t.path.toLowerCase()}`, mode: 'exclusive' }], fingerprint: t.parentId };
  },
  fingerprint: (r) => rootIdentity(r.facts.file_path!),
  preconditions(_a, r) { return (r.facts as any).sha || !existsSync(r.facts.file_path!) ? ok : { ok: false, reason: 'not a regular file' }; },
  postconditions(_a, r) { return [{ kind: 'file_absent', path: r.facts.file_path! }]; },
  async dispatch(_a, r, ctx) {
    const f = r.facts as any;
    if (!existsSync(f.file_path)) return { outcome: 'success', receipt: { already_absent: true } };
    const dir = f.trash ?? trashDirFor(f.file_path);
    mkdirSync(dir, { recursive: true });
    const dest = join(dir, `${basename(f.file_path)}.billy-${ctx.attemptId.slice(0, 8)}`);
    try { renameSync(f.file_path, dest); } catch (e) { return { outcome: 'failure', error: (e as Error).message }; }
    return { outcome: 'success', receipt: { trashed_to: dest, sha256: f.sha } };
  },
  async verify(_a, _r, post) { return verifyFileConditions(post); },
  async reconcile(_a, _r, post) { const v = verifyFileConditions(post); return { status: v.verdict === 'verified' ? 'applied' : 'not_applied', evidence: v.evidence }; },
};

export const FILE_TOOLS = [fsRead, fsList, fsStat, fsWrite, fsCopy, fsMove, fsTrash];

/** Copy/move reconciliation: a partially applied effect is never reported as "not applied". */
function reconcileTransfer(post: Condition[], f: any): { status: 'applied' | 'not_applied' | 'unknown'; evidence: unknown } {
  const v = verifyFileConditions(post);
  if (v.verdict === 'verified') return { status: 'applied', evidence: v.evidence };
  const dstExists = existsSync(f.file_path);
  const srcOk = fileDigest(f.src) === f.src_sha256;
  if (!dstExists && srcOk) return { status: 'not_applied', evidence: v.evidence };
  return { status: 'unknown', evidence: { partial: true, destination_exists: dstExists, source_intact: srcOk, checks: v.evidence } };
}
