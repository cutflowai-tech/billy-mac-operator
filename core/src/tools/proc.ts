// proc.run: the only process-execution route in Billy's tool surface. Every
// command runs inside the Seatbelt sandbox, confined to a workspace inside a
// granted file root, with an owned process group recorded by (pid, start time).
// There is deliberately no unsandboxed shell tool.
import { realpathSync, statSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import type { ToolAdapter, AdapterContext } from '../broker/types.ts';
import { TargetError } from '../broker/types.ts';
import { runSandboxed, processStart, killGroup, PROFILE_SHA256, type SandboxRun } from '../sandbox/seatbelt.ts';
import { redact } from '../util/redact.ts';
import type { Store } from '../store/db.ts';

/** Executables that may be launched (absolute paths, resolved inside the sandbox). */
export function allowedExecutables(runtimeDir: string): string[] {
  return [`${runtimeDir}/bin/node`, '/usr/bin/git', '/usr/bin/python3', '/bin/sh', '/usr/bin/make', '/usr/bin/swift', '/usr/bin/env',
    '/bin/ls', '/bin/cat', '/usr/bin/grep', '/usr/bin/diff', '/usr/bin/wc', '/bin/echo', '/usr/bin/true', '/usr/bin/false'];
}

/** Shared process ownership for all sandboxed tool children, including integration substeps. */
export async function runOwnedSandboxed(options: Omit<SandboxRun, 'onSpawn' | 'signal'>, ctx: AdapterContext) {
  const task = ctx.store.db.prepare('SELECT status,cancellation_generation FROM tasks WHERE task_id=?').get(ctx.taskId) as any;
  const attempt = ctx.store.db.prepare('SELECT cancellation_generation FROM attempts WHERE attempt_id=?').get(ctx.attemptId) as any;
  if (ctx.signal.aborted || ctx.store.stopLatch().stopped || task.cancellation_generation !== attempt.cancellation_generation
    || ['PAUSED_BY_OWNER', 'CANCEL_REQUESTED', 'CANCELLED'].includes(task.status)) throw new Error('sandboxed process refused after owner interruption');
  let processId: string | null = null;
  const result = await runSandboxed({ ...options, signal: ctx.signal,
    onSpawn(pid, pgid, start) {
      processId = `${pid}:${start}`;
      ctx.store.tx(() => ctx.store.db.prepare(`INSERT INTO processes VALUES (?,?,?,?,?,?,?,?,NULL,NULL)`)
        .run(processId, ctx.taskId, ctx.attemptId, pid, start, pgid, options.argv[0], ctx.store.now()));
    },
  });
  if (processId) ctx.store.tx(() => ctx.store.db.prepare('UPDATE processes SET ended_at=?, exit_code=? WHERE process_key=?')
    .run(ctx.store.now(), result.exit_code ?? -1, processId));
  return result;
}

export function procRun(runtimeDir: string): ToolAdapter {
  const allowed = allowedExecutables(runtimeDir);
  return {
    spec: {
      tool_id: 'proc.run', version: 1,
      description: 'Run a command inside the Billy sandbox (workspace-only filesystem, no network, no Keychain, no GUI). Returns exit code and bounded output.',
      input_schema: { type: 'object', required: ['workspace', 'argv'], properties: {
        workspace: { type: 'string', pattern: '^/', maxLength: 1024 },
        argv: { type: 'array', minItems: 1, maxItems: 64, items: { type: 'string', maxLength: 4096 } },
        timeout_ms: { type: 'integer', minimum: 100, maximum: 30 * 60_000 },
        env: { type: 'object', additionalProperties: { type: 'string', maxLength: 4096 } } } },
      output_schema: { type: 'object', additionalProperties: true },
      effect_class: 'NON_IDEMPOTENT_EFFECT', tool_class: 'process', capabilities: ['proc.sandboxed'],
      target_kind: 'process', cancellation: 'kill_owned_process', timeout_ms: 30 * 60_000, idempotency: 'none',
      verification: 'exit_code', reconciliation: 'process_record', compensation: 'none: workspace changes persist',
      lock_class: 'path', egress: 'none', executable_identity: `sandbox profile sha256 ${PROFILE_SHA256}`,
    },
    paths: (a) => [a.workspace],
    resolve(a) {
      if (!isAbsolute(a.argv[0])) throw new TargetError('argv[0] must be an absolute path');
      if (!allowed.includes(a.argv[0])) throw new TargetError(`executable not in sandbox allowlist: ${a.argv[0]}`);
      let ws: string;
      try { ws = realpathSync(a.workspace); } catch { throw new TargetError('workspace does not exist'); }
      if (!statSync(ws).isDirectory()) throw new TargetError('workspace is not a directory');
      for (const k of Object.keys(a.env ?? {})) if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(k) || /^(DYLD_|LD_|NODE_OPTIONS$)/.test(k)) throw new TargetError(`env var not allowed: ${k}`);
      const st = statSync(ws);
      return { resource_id: `proc:${ws}:${a.argv[0]}`, account_id: null, facts: { file_path: ws, file_paths: [ws] },
        claims: [{ resource_key: `workspace:${ws}`, mode: 'exclusive' }], fingerprint: `${st.dev}:${st.ino}` };
    },
    fingerprint: (r) => { try { const s = statSync(r.facts.file_path!); return `${s.dev}:${s.ino}`; } catch { return 'missing'; } },
    preconditions: () => ({ ok: true }),
    postconditions: () => [{ kind: 'process_exited' }],
    async dispatch(a, r, ctx) {
      const res = await runOwnedSandboxed({ argv: a.argv, workspace: r.facts.file_path!, runtimeDir, timeoutMs: a.timeout_ms ?? 120_000, env: a.env }, ctx);
      const receipt = { exit_code: res.exit_code, signal: res.signal, timed_out: res.timed_out, truncated: res.truncated, duration_ms: res.duration_ms,
        stdout: redact(res.stdout.slice(-16_000)), stderr: redact(res.stderr.slice(-8_000)) };
      // A non-zero exit is a definite, observed result (not an unknown outcome).
      return { outcome: 'success', receipt };
    },
    async verify(_a, _r, _post, receipt: any) {
      const exited = receipt && (typeof receipt.exit_code === 'number' || typeof receipt.signal === 'string');
      return { verdict: exited ? 'verified' : 'failed', evidence: { exit_code: receipt?.exit_code ?? null, signal: receipt?.signal ?? null } };
    },
    async reconcile(_a, _r, _post, ctx) {
      const store = ctx.store as Store;
      const p = store.db.prepare('SELECT * FROM processes WHERE attempt_id=?').get(ctx.attemptId) as any;
      if (!p) return { status: 'not_applied', evidence: { reason: 'no process was spawned for this attempt' } };
      // The process existed; whether its workspace effects completed is unknown. Never re-run blindly.
      const alive = processStart(p.pid) === p.pid_start;
      if (alive) killGroup(p.pgid);
      return { status: 'unknown', evidence: { pid: p.pid, was_alive: alive, exit_code: p.exit_code } };
    },
  };
}

/** Cancel every still-running owned process for a task, verifying identity to avoid PID reuse. */
export function killOwnedProcesses(store: Store, taskIds: string[]): { killed: number; skipped_reused: number } {
  let killed = 0, skipped = 0;
  for (const t of taskIds) {
    const rows = store.db.prepare('SELECT * FROM processes WHERE task_id=? AND ended_at IS NULL').all(t) as any[];
    for (const p of rows) {
      if (processStart(p.pid) !== p.pid_start) { skipped++; continue; } // pid reused or gone: not ours
      if (killGroup(p.pgid)) killed++;
    }
  }
  return { killed, skipped_reused: skipped };
}
