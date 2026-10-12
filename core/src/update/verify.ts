// Update/component artifact admission (handoff T-SEC-10). An artifact is admitted
// only if its bytes match the pinned SHA-256 (and, when required, its code-signing
// Team ID). Admission stages outside the install directory and verifies the staged
// bytes themselves, so a mismatch — or a candidate swapped mid-copy — leaves the
// existing installation untouched.
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  closeSync, existsSync, fsyncSync, mkdirSync, openSync, readSync, renameSync, rmSync, statSync, writeSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

export type ArtifactCheck =
  | { ok: true; sha256: string; team_id: string | null }
  | { ok: false; reason: 'missing' | 'mismatch' | 'team_mismatch'; expected: string; actual: string | null; detail: string };

export type TeamIdReader = (path: string) => string | null;

/** Reads TeamIdentifier from `codesign -dv`; null when unsigned/ad-hoc. */
export const codesignTeamId: TeamIdReader = (path) => {
  const r = spawnSync('/usr/bin/codesign', ['-dv', '--verbose=4', path], { encoding: 'utf8', timeout: 30_000 });
  const m = /TeamIdentifier=(\S+)/.exec(`${r.stdout}\n${r.stderr}`);
  return m && m[1] !== 'not' ? m[1] : null;
};

/** Streaming SHA-256 of a file; optionally copies the exact hashed bytes to `copyTo`. */
function hashFile(path: string, copyTo?: string): string {
  const h = createHash('sha256');
  const buf = Buffer.allocUnsafe(1 << 20);
  const fd = openSync(path, 'r');
  const out = copyTo ? openSync(copyTo, 'wx', statSync(path).mode & 0o777) : null;
  try {
    for (;;) {
      const n = readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      h.update(buf.subarray(0, n));
      if (out !== null) writeSync(out, buf, 0, n);
    }
    if (out !== null) fsyncSync(out);
  } finally {
    closeSync(fd);
    if (out !== null) closeSync(out);
  }
  return h.digest('hex');
}

export function verifyArtifact(path: string, expectedSha256: string,
  opts: { teamId?: string; readTeamId?: TeamIdReader } = {}): ArtifactCheck {
  const expected = expectedSha256.toLowerCase();
  if (!existsSync(path) || !statSync(path).isFile()) {
    return { ok: false, reason: 'missing', expected, actual: null, detail: `artifact not found: ${path}` };
  }
  const actual = hashFile(path);
  if (actual !== expected) return { ok: false, reason: 'mismatch', expected, actual, detail: `sha256 ${actual} != pinned ${expected}` };
  let team: string | null = null;
  if (opts.teamId) {
    team = (opts.readTeamId ?? codesignTeamId)(path);
    if (team !== opts.teamId) {
      return { ok: false, reason: 'team_mismatch', expected: opts.teamId, actual: team, detail: `team ${team ?? 'none'} != ${opts.teamId}` };
    }
  }
  return { ok: true, sha256: actual, team_id: team };
}

export interface UpdateManifest { name?: string; version: string; sha256: string; teamId?: string }

export type AdmitResult =
  | { admitted: true; installed_path: string; sha256: string; version: string }
  | { admitted: false; report: ArtifactCheck & { ok: false }; install_dir_untouched: true };

/**
 * Admit `candidatePath` into `installDir` as `manifest.name` (default: candidate basename).
 * The pre-check rejects mismatches before anything is written; the staged copy is then
 * re-hashed so the bytes installed are exactly the bytes verified.
 */
export function admitUpdate(candidatePath: string, manifest: UpdateManifest, installDir: string,
  opts: { readTeamId?: TeamIdReader } = {}): AdmitResult {
  const pre = verifyArtifact(candidatePath, manifest.sha256, { teamId: manifest.teamId, readTeamId: opts.readTeamId });
  if (!pre.ok) return { admitted: false, report: pre, install_dir_untouched: true };
  const name = manifest.name ?? basename(candidatePath);
  if (name.includes('/') || name.startsWith('.')) throw new Error(`bad artifact name ${name}`);
  // Staging lives beside (not inside) installDir so the install dir changes only by the final rename.
  const stageDir = join(dirname(installDir), `.billy-update-staging-${randomBytes(6).toString('hex')}`);
  mkdirSync(stageDir, { mode: 0o700 });
  try {
    const staged = join(stageDir, name);
    const got = hashFile(candidatePath, staged);
    if (got !== manifest.sha256.toLowerCase()) {
      return { admitted: false, install_dir_untouched: true,
        report: { ok: false, reason: 'mismatch', expected: manifest.sha256.toLowerCase(), actual: got, detail: 'artifact changed during staging' } };
    }
    mkdirSync(installDir, { recursive: true });
    const dest = join(installDir, name);
    renameSync(staged, dest);
    return { admitted: true, installed_path: dest, sha256: got, version: manifest.version };
  } finally {
    rmSync(stageDir, { recursive: true, force: true });
  }
}
