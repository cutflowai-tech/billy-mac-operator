// The one definition of "which commit, and is the source tree clean" used by every
// evidence producer (qualify, live-test stamps, review reproduction) and by the
// evaluator. Generated evidence (release/results, release/reviews, artifacts) is not
// source and never makes the tree dirty.
import { spawnSync } from 'node:child_process';

export const GENERATED_EVIDENCE_PATHS = ['release/results', 'release/reviews', 'artifacts'] as const;

export interface TreeState { commit: string; dirty_tree: boolean; dirty_files: string[] }

/** The single git invocation every helper below goes through. */
function git(root: string, args: string[]): { ok: boolean; out: Buffer } {
  const r = spawnSync('git', args, { cwd: root });
  return { ok: r.status === 0, out: r.stdout as Buffer };
}
const text = (root: string, args: string[]) => { const r = git(root, args); return r.ok ? r.out.toString('utf8').trim() : null; };

export function treeState(root: string): TreeState {
  // release/reviews.json is a review output too (the ':!release/reviews' pathspec does not cover it).
  const dirty = text(root, ['status', '--porcelain', '--', '.', ...GENERATED_EVIDENCE_PATHS.map((p) => `:!${p}`), ':!release/reviews.json']) ?? '';
  return { commit: text(root, ['rev-parse', 'HEAD']) ?? '', dirty_tree: dirty.length > 0, dirty_files: dirty ? dirty.split('\n') : [] };
}

/** Tree hash of a commit, or null if unknown. */
export function treeOf(root: string, commit: string): string | null { return text(root, ['rev-parse', `${commit}^{tree}`]); }

/**
 * Repo-relative files that differ between two commits, or null if history is unknown. `from` must be an ancestor
 * of `to`: a review of a sibling or later commit says nothing about how the candidate was reached (fails closed).
 */
export function changedFiles(root: string, from: string, to: string): string[] | null {
  if (!git(root, ['merge-base', '--is-ancestor', from, to]).ok) return null;
  const out = text(root, ['diff', '--name-only', from, to]);
  return out === null ? null : out.split('\n').filter(Boolean);
}

/** A file's bytes at a commit, or null if it is not in that commit. */
export function fileAt(root: string, commit: string, path: string): Buffer | null {
  const r = git(root, ['show', `${commit}:${path}`]);
  return r.ok ? r.out : null;
}
