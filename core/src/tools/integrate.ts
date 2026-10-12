// code.integrate: the single serialized integration owner for multi-agent code
// work (handoff §13.2, T-AGENT-02). Merges child branches into the integration
// branch inside the Seatbelt sandbox, refuses conflicted merges (no
// last-write-wins), then re-runs the real test command on the integrated tree.
// If requalification fails the integration branch is reset to its base commit.
import { realpathSync } from 'node:fs';
import type { ToolAdapter } from '../broker/types.ts';
import { TargetError } from '../broker/types.ts';
import { runSandboxed, PROFILE_SHA256 } from '../sandbox/seatbelt.ts';
import { allowedExecutables } from './proc.ts';

export function codeIntegrate(runtimeDir: string): ToolAdapter {
  const git = (ws: string, args: string[], timeoutMs = 60_000) => runSandboxed({ argv: ['/usr/bin/git', '-c', 'user.name=Billy Integration', '-c', 'user.email=billy@localhost', ...args], workspace: ws, runtimeDir, timeoutMs });
  return {
    spec: { tool_id: 'code.integrate', version: 1, description: 'Serially merge child branches into the integration branch and requalify with the real test command (sandboxed). Conflicts are reported, never auto-resolved.',
      input_schema: { type: 'object', required: ['repo', 'branches', 'test_argv'], properties: {
        repo: { type: 'string', pattern: '^/', maxLength: 1024 },
        branches: { type: 'array', minItems: 1, maxItems: 16, items: { type: 'string', pattern: '^[A-Za-z0-9._/-]{1,100}$' } },
        test_argv: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'string', maxLength: 2048 } } } },
      output_schema: { type: 'object', additionalProperties: true }, effect_class: 'IDEMPOTENT_WRITE', tool_class: 'process', capabilities: ['proc.sandboxed', 'vcs.merge'],
      target_kind: 'process', cancellation: 'kill_owned_process', timeout_ms: 30 * 60_000, idempotency: 'inherent', verification: 'git_head_and_tests',
      reconciliation: 'git_head', compensation: 'integration branch reset to base on failed requalification', lock_class: 'path', egress: 'none',
      executable_identity: `git in sandbox profile ${PROFILE_SHA256}` },
    paths: (a) => [a.repo],
    resolve(a) {
      if (!allowedExecutables(runtimeDir).includes(a.test_argv[0])) throw new TargetError(`test executable not in sandbox allowlist: ${a.test_argv[0]}`);
      let ws: string; try { ws = realpathSync(a.repo); } catch { throw new TargetError('repo does not exist'); }
      return { resource_id: `integration:${ws}`, account_id: null, facts: { file_path: ws, file_paths: [ws] },
        claims: [{ resource_key: `integration:${ws.toLowerCase()}`, mode: 'exclusive' }, { resource_key: `workspace:${ws}`, mode: 'exclusive' }] };
    },
    preconditions: () => ({ ok: true }),
    postconditions: () => [{ kind: 'integration_requalified' }],
    async dispatch(a, r) {
      const ws = r.facts.file_path!;
      const base = (await git(ws, ['rev-parse', 'HEAD'])).stdout.trim();
      if (!/^[0-9a-f]{40}$/.test(base)) return { outcome: 'failure', error: 'not a git repository', retryable: false };
      const merged: string[] = [];
      for (const b of a.branches) {
        const already = await git(ws, ['merge-base', '--is-ancestor', b, 'HEAD']);
        if (already.exit_code === 0) { merged.push(`${b} (already integrated)`); continue; }
        const m = await git(ws, ['merge', '--no-ff', '--no-edit', b]);
        if (m.exit_code !== 0) {
          const conflicts = (await git(ws, ['diff', '--name-only', '--diff-filter=U'])).stdout.trim().split('\n').filter(Boolean);
          await git(ws, ['merge', '--abort']);
          await git(ws, ['reset', '--hard', base]);
          return { outcome: 'failure', error: `merge conflict integrating ${b}: ${conflicts.join(', ') || m.stderr.slice(0, 200)}`, retryable: false,
            receipt: { conflict_branch: b, conflicts, base, merged } } as any;
        }
        merged.push(b);
      }
      const t = await runSandboxed({ argv: a.test_argv, workspace: ws, runtimeDir, timeoutMs: 20 * 60_000 });
      const head = (await git(ws, ['rev-parse', 'HEAD'])).stdout.trim();
      if (t.exit_code !== 0) {
        await git(ws, ['reset', '--hard', base]);
        return { outcome: 'failure', error: `integrated tests failed (exit ${t.exit_code}); reset to ${base.slice(0, 12)}`, retryable: false,
          receipt: { base, attempted_head: head, test_exit: t.exit_code, test_tail: t.stdout.slice(-2000) + t.stderr.slice(-1000) } } as any;
      }
      return { outcome: 'success', receipt: { base, head, merged, test_exit: 0, test_tail: t.stdout.slice(-2000) } };
    },
    async verify(a, r, _p, receipt: any) {
      const ws = r.facts.file_path!;
      const head = (await git(ws, ['rev-parse', 'HEAD'])).stdout.trim();
      const contains = await Promise.all(a.branches.map((b: string) => git(ws, ['merge-base', '--is-ancestor', b, 'HEAD']).then((x) => x.exit_code === 0)));
      const t = await runSandboxed({ argv: a.test_argv, workspace: ws, runtimeDir, timeoutMs: 20 * 60_000 });
      const ok = head === receipt?.head && contains.every(Boolean) && t.exit_code === 0;
      return { verdict: ok ? 'verified' : 'failed', evidence: { head, all_branches_integrated: contains.every(Boolean), independent_test_exit: t.exit_code } };
    },
    async reconcile(a, r) {
      const ws = r.facts.file_path!;
      const contains = await Promise.all(a.branches.map((b: string) => git(ws, ['merge-base', '--is-ancestor', b, 'HEAD']).then((x) => x.exit_code === 0)));
      return { status: contains.every(Boolean) ? 'applied' : contains.some(Boolean) ? 'unknown' : 'not_applied', evidence: { contains } };
    },
  };
}
