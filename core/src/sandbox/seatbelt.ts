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
  (subpath (param "DEVELOPER_DIR"))
  (subpath (param "DEVELOPER_SUPPORT"))
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

let developerDirCache: string | undefined;

export function verifyAppleCode(path: string, identifier: string, ignoreResources = false): boolean {
  const signature = spawnSync('/usr/bin/codesign', ['--verify', '--strict', ...(ignoreResources ? ['--ignore-resources'] : []), '--test-requirement', `=anchor apple and identifier ${JSON.stringify(identifier)}`, path], {
    timeout: 10_000, maxBuffer: 8192, env: { PATH: '/usr/bin:/bin' },
  });
  return signature.status === 0;
}

/** The OS-selected toolchain is trusted host configuration, never a task argument. */
export function selectedDeveloperDirectory(): string {
  if (developerDirCache !== undefined) return developerDirCache;
  // DEVELOPER_DIR belongs to the daemon's trusted launch configuration. Task
  // environments never participate in selection and are overwritten below.
  let selection = process.env.DEVELOPER_DIR;
  if (!selection) {
    const selected = spawnSync('/usr/bin/xcode-select', ['-p'], {
      encoding: 'utf8', timeout: 2000, maxBuffer: 8192, env: { PATH: '/usr/bin:/bin' },
    });
    if (selected.status === 0) selection = selected.stdout.trim();
  }
  let dir = '';
  try { if (selection) dir = realpathSync(selection); } catch { /* fail closed */ }
  if (dir === '/Library/Developer/CommandLineTools') return developerDirCache = dir;
  if (/^\/Applications\/Xcode[^/]*\.app\/Contents\/Developer$/.test(dir)) {
    const app = dirname(dirname(dir));
    // Authenticate the selected host installation's executable, not the full
    // SDK resource seal (over 100,000 files). codesign finds the enclosing
    // bundle even from its Mach-O path, so explicitly omit resource validation.
    // Code signatures and the exact Apple identifier remain enforced. This
    // admission grants read access to the toolchain and its bundled support
    // frameworks, as with the system CLT installation.
    if (verifyAppleCode(join(app, 'Contents/MacOS/Xcode'), 'com.apple.dt.Xcode', true)) return developerDirCache = dir;
  }
  // An absent or untrusted selection grants no additional filesystem access.
  return developerDirCache = '/__billy_unavailable_developer_toolchain__';
}

/** Full Xcode's executable support frameworks are siblings of Developer. */
export function selectedDeveloperReadRoot(): string {
  const dir = selectedDeveloperDirectory();
  return dir.endsWith('.app/Contents/Developer') ? dirname(dir) : dir;
}

export interface SandboxRun {
  argv: string[];               // absolute executable + args
  workspace: string;            // canonical directory; only writable location
  runtimeDir: string;           // read-only runtime (e.g. bundled node) directory
  timeoutMs: number;
  maxOutputBytes?: number;
  env?: Record<string, string>; // merged over a minimal clean environment
  signal?: AbortSignal;
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
  if (o.signal?.aborted) return Promise.reject(new Error('sandboxed process cancelled before spawn'));
  const ws = realpathSync(o.workspace);
  // Profile and per-run temp live OUTSIDE the workspace: sandboxed code can never edit its own profile,
  // and user repositories are not polluted.
  const profilePath = profileFile();
  const tmp = realpathSync(mkdtempSync(join(tmpdir(), 'billy-run-')));
  const runtime = realpathSync(o.runtimeDir);
  const developerDir = selectedDeveloperDirectory();
  // Clean environment: nothing inherited from the daemon (no tokens, no API keys, no sockets).
  const env: Record<string, string> = {
    PATH: `${runtime}/bin:/usr/bin:/bin:/usr/sbin:/sbin`, HOME: ws, TMPDIR: tmp, LANG: 'en_US.UTF-8',
    GIT_CONFIG_NOSYSTEM: '1', GIT_TERMINAL_PROMPT: '0', ...(o.env ?? {}),
    // Pin xcrun's selection to the exact trusted root admitted by this profile.
    DEVELOPER_DIR: developerDir,
  };
  const max = o.maxOutputBytes ?? 256 * 1024;
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn('/usr/bin/sandbox-exec', ['-f', profilePath, '-D', `WS=${ws}`, '-D', `TMP=${tmp}`, '-D', `RUNTIME_DIR=${runtime}`, '-D', `DEVELOPER_DIR=${developerDir}`, '-D', `DEVELOPER_SUPPORT=${selectedDeveloperReadRoot()}`, ...o.argv],
      { cwd: ws, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const onAbort = () => { if (child.pid) killGroup(child.pid); };
    o.signal?.addEventListener('abort', onAbort, { once: true });
    let out = '', err = '', truncated = false, timedOut = false;
    const cap = (cur: string, d: Buffer) => { if (cur.length >= max) { truncated = true; return cur; } return cur + d.toString('utf8').slice(0, max - cur.length); };
    child.stdout!.on('data', (d) => { out = cap(out, d); });
    child.stderr!.on('data', (d) => { err = cap(err, d); });
    let ownershipError: unknown;
    const timer = setTimeout(() => { timedOut = true; killGroup(child.pid!); }, o.timeoutMs);
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      o.signal?.removeEventListener('abort', onAbort);
      try { rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
      if (ownershipError) reject(ownershipError);
      else resolve({ exit_code: code, signal: sig, stdout: out, stderr: err, timed_out: timedOut, truncated, duration_ms: Date.now() - t0 });
    });
    child.on('error', (e) => { err = cap(err, Buffer.from(e.message)); });
    // If recording ownership fails, do not leave an untracked child running.
    // Wait for exit and cleanup before reporting the journal failure.
    try { if (child.pid) o.onSpawn?.(child.pid, child.pid, processStart(child.pid) ?? 'unknown'); }
    catch (e) { ownershipError = e; onAbort(); }
    if (o.signal?.aborted) onAbort();
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
