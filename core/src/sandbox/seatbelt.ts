// Seatbelt (sandbox-exec) containment for untrusted/generated execution
// (handoff §11.3, REQ-10, T-SEC-03/07/11).
//
// Demonstrated boundary (see test/security/sandbox.test.ts): deny-by-default;
// read/write only the task workspace and a private temp dir; read-only system
// toolchains; no network (TCP, UDP or UNIX sockets — so no Cua socket, no Billy
// API socket, no localhost services); no Keychain (securityd mach service not
// reachable); no Apple Events / LaunchServices / pasteboard; signals only within
// the sandbox. Residual: shares the user's uid and kernel; CPU/memory are
// bounded by timeouts and process-group kill, not by quotas.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { createHash } from 'node:crypto';

export const PROFILE = `(version 1)
(deny default)
(allow process-exec* process-fork)
(allow signal (target same-sandbox))
(allow file-map-executable)
(allow sysctl-read)
(allow file-read-metadata)
(allow file-read*
  (literal "/") (literal "/private") (literal "/private/var")
  (subpath "/usr") (subpath "/bin") (subpath "/sbin") (subpath "/System")
  (subpath "/Library/Developer/CommandLineTools") (subpath "/Library/Apple")
  (subpath "/private/etc") (subpath "/private/var/db/timezone") (subpath "/private/var/select")
  (subpath "/private/var/db/dyld") (subpath "/System/Volumes/Preboot/Cryptexes")
  (subpath "/dev")
  (subpath (param "RUNTIME_DIR"))
  (subpath (param "WS")) (subpath (param "TMP")))
(allow file-read* file-write*
  (subpath (param "WS")) (subpath (param "TMP"))
  (literal "/dev/null") (literal "/dev/tty") (literal "/dev/zero") (literal "/dev/random") (literal "/dev/urandom")
  (regex #"^/dev/fd/"))
(allow mach-lookup
  (global-name "com.apple.system.logger")
  (global-name "com.apple.system.notification_center")
  (global-name "com.apple.system.opendirectoryd.libinfo"))
(allow ipc-posix-shm-read-data ipc-posix-shm-read-metadata)
`;

export const PROFILE_SHA256 = createHash('sha256').update(PROFILE).digest('hex');

export interface SandboxRun {
  argv: string[];               // absolute executable + args
  workspace: string;            // canonical directory; only writable location
  runtimeDir: string;           // read-only runtime (e.g. bundled node) directory
  timeoutMs: number;
  maxOutputBytes?: number;
  env?: Record<string, string>; // merged over a minimal clean environment
  onSpawn?: (pid: number, pgid: number, pidStart: string) => void;
}

export interface SandboxResult { exit_code: number | null; signal: string | null; stdout: string; stderr: string; timed_out: boolean; truncated: boolean; duration_ms: number }

/** Process start time (lstart) used with the pid as a PID-reuse-safe identity. */
export function processStart(pid: number): string | null {
  const r = spawnSync('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' });
  const s = r.stdout.trim();
  return r.status === 0 && s ? s : null;
}

export function runSandboxed(o: SandboxRun): Promise<SandboxResult> {
  const ws = realpathSync(o.workspace);
  // Profile and per-run temp live OUTSIDE the workspace: sandboxed code can never edit its own profile,
  // and user repositories are not polluted.
  const profilePath = profileFile();
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'billy-run-')));
  const runtime = realpathSync(o.runtimeDir);
  // Clean environment: nothing inherited from the daemon (no tokens, no API keys, no sockets).
  const env: Record<string, string> = {
    PATH: `${runtime}/bin:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: ws, TMPDIR: tmp, LANG: 'en_US.UTF-8',
    GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', ...(o.env ?? {}),
  };
  const max = o.maxOutputBytes ?? 256 * 1024;
  const t0 = Date.now();
  return new Promise((resolve) => {
    const child = spawn('/usr/bin/sandbox-exec', ['-f', profilePath, '-D', `WS=${ws}`, '-D', `TMP=${tmp}`, '-D', `RUNTIME_DIR=${runtime}`, ...o.argv],
      { cwd: ws, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '', truncated = false, timedOut = false;
    const cap = (cur: string, d: Buffer) => { if (cur.length >= max) { truncated = true; return cur; } return cur + d.toString('utf8').slice(0, max - cur.length); };
    child.stdout!.on('data', (d) => { out = cap(out, d); });
    child.stderr!.on('data', (d) => { err = cap(err, d); });
    if (child.pid) o.onSpawn?.(child.pid, child.pid, processStart(child.pid) ?? 'unknown');
    const timer = setTimeout(() => { timedOut = true; killGroup(child.pid!); }, o.timeoutMs);
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
      resolve({ exit_code: code, signal: sig, stdout: out, stderr: err, timed_out: timedOut, truncated, duration_ms: Date.now() - t0 });
    });
  });
}

/** Content-addressed, read-only profile file in a Billy-owned directory. */
export function profileFile(): string {
  const dir = join(tmpdir(), 'billy-sandbox');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const p = join(dir, `${PROFILE_SHA256}.sb`);
  if (!existsSync(p) || readFileSync(p, 'utf8') !== PROFILE) { rmSync(p, { force: true }); writeFileSync(p, PROFILE, { mode: 0o400 }); }
  return p;
}

/** Kill an owned process group. Callers must verify identity (pid + start time) first. */
export function killGroup(pgid: number, sig: NodeJS.Signals = 'SIGKILL'): boolean {
  try { process.kill(-pgid, sig); return true; } catch { return false; }
}

export function sandboxAvailable(): boolean {
  const r = spawnSync('/usr/bin/sandbox-exec', ['-p', '(version 1)(allow default)', '/usr/bin/true']);
  return r.status === 0;
}

export function dirOf(p: string): string { return dirname(p); }
