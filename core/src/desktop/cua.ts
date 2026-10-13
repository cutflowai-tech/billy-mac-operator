// Cua driver client and private-daemon launcher (ADR-0002).
// - Pinned binary (sha256 + team id) checked before every launch.
// - Private daemon on a Billy-owned socket, bounded mode, capability manifest
//   derived from the owner's grant; telemetry and update checks disabled.
// - NDJSON request/response over the Unix socket; results are parsed (exit codes
//   and isError are never trusted alone).
import { createConnection } from 'node:net';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, chmodSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
import type { GrantScope } from '../policy/policy.ts';
import { SYSTEM_SERVICE_EXECUTABLES } from './panels.ts';

export class CuaError extends Error {
  readonly code: 'not_running' | 'permissions_pending' | 'refused' | 'stale' | 'tool_error' | 'transport' | 'pin_mismatch';
  readonly detail: unknown;
  constructor(code: CuaError['code'], msg: string, detail?: unknown) { super(msg); this.code = code; this.detail = detail; }
}

export interface CuaTransport { call(name: string, args: Record<string, unknown>, sessionId: string, timeoutMs?: number): Promise<any> }

/** NDJSON client for one daemon socket. */
export class SocketTransport implements CuaTransport {
  readonly socketPath: string;
  constructor(socketPath: string) { this.socketPath = socketPath; }
  /**
   * A freshly started daemon answers `permissions_pending` (exit 75) until its own TCC
   * probe completes; no action is started in that state, so waiting is safe.
   */
  async call(name: string, args: Record<string, unknown>, sessionId: string, timeoutMs = 30_000): Promise<any> {
    const deadline = Date.now() + 20_000;
    let revived = false;
    for (;;) {
      const resp = await this.once(name, args, sessionId, timeoutMs);
      // The driver ends idle sessions (~5 min TTL); revive the same label once and retry.
      const ended = JSON.stringify(resp ?? {}).match(/session '[^']*' has ended/);
      if (ended && !revived && name !== 'start_session') {
        revived = true;
        await this.once('start_session', { session: sessionId }, sessionId, timeoutMs);
        continue;
      }
      const pending = resp?.ok === false && (resp.exit_code === 75 || /permissions_pending/.test(String(resp.error)));
      if (!pending || Date.now() > deadline) return resp;
      await new Promise((r) => setTimeout(r, 500));
    }
  }
  private once(name: string, args: Record<string, unknown>, sessionId: string, timeoutMs: number): Promise<any> {
    return new Promise((resolve, reject) => {
      const s = createConnection(this.socketPath);
      let buf = '';
      const timer = setTimeout(() => { s.destroy(); reject(new CuaError('transport', `cua call ${name} timed out`)); }, timeoutMs);
      s.on('error', (e: any) => { clearTimeout(timer); reject(new CuaError(e.code === 'ENOENT' || e.code === 'ECONNREFUSED' ? 'not_running' : 'transport', `cua socket: ${e.code}`)); });
      s.on('connect', () => s.write(JSON.stringify({ method: 'call', name, args, session_id: sessionId, client_kind: 'typescript_sdk' }) + '\n'));
      s.on('data', (d) => {
        buf += d.toString('utf8');
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        clearTimeout(timer);
        s.end();
        try { resolve(JSON.parse(buf.slice(0, nl))); } catch { reject(new CuaError('transport', 'invalid NDJSON from cua daemon')); }
      });
    });
  }
}

/** Interpret a daemon response: returns structuredContent or throws a typed error. */
export function interpret(name: string, resp: any): any {
  if (!resp || typeof resp !== 'object') throw new CuaError('transport', 'empty response');
  if (resp.ok === false) {
    const msg = String(resp.error ?? 'error');
    if (resp.exit_code === 75 || /permissions_pending/.test(msg)) throw new CuaError('permissions_pending', `cua permissions pending: ${msg}`);
    throw new CuaError('tool_error', `${name}: ${msg}`, resp);
  }
  const r = resp.result ?? {};
  const sc = r.structuredContent ?? {};
  if (sc.status === 'refused' || sc.refusal) throw new CuaError('refused', `${name} refused by driver: ${JSON.stringify(sc.refusal ?? sc).slice(0, 200)}`, sc);
  if (/stale_element_token|generation_mismatch|stale snapshot/i.test(JSON.stringify(sc).slice(0, 2000)) && (sc.status === 'error' || r.isError)) {
    throw new CuaError('stale', `${name}: stale observation`, sc);
  }
  if (r.isError) throw new CuaError('tool_error', `${name} failed: ${JSON.stringify(r.content ?? sc).slice(0, 300)}`, r);
  return sc;
}

export interface CuaPin { app_path: string; binary_sha256: string; team_id: string }

export function verifyPin(pin: CuaPin): { ok: boolean; sha256: string; team: string } {
  const bin = join(pin.app_path, 'Contents/MacOS/cua-driver');
  if (!existsSync(bin)) return { ok: false, sha256: 'missing', team: 'missing' };
  const sha = createHash('sha256').update(readFileSync(bin)).digest('hex');
  // The whole sealed bundle must verify: LaunchServices starts whatever Info.plist names and loads nested
  // frameworks, none of which the executable digest above covers.
  const sealed = spawnSync('/usr/bin/codesign', ['--verify', '--strict', '--deep', pin.app_path], { encoding: 'utf8', timeout: 30_000 }).status === 0;
  const sig = spawnSync('/usr/bin/codesign', ['-dv', pin.app_path], { encoding: 'utf8' });
  const team = sealed ? /TeamIdentifier=(\S+)/.exec(sig.stderr ?? '')?.[1] ?? 'unknown' : 'invalid-signature';
  return { ok: sealed && sha === pin.binary_sha256 && team === pin.team_id, sha256: sha, team };
}

/** Tools Billy uses; everything else stays denied by the bounded manifest. */
export const CUA_TOOLS = ['list_windows', 'zoom', 'get_window_state', 'click', 'type_text', 'set_value', 'press_key', 'hotkey',
  'scroll', 'double_click', 'launch_app', 'verify_state', 'get_screen_size', 'set_window_frame', 'invoke_menu', 'bring_to_front', 'start_session', 'end_session', 'health_report', 'check_permissions'];

/** Capability manifest (YAML v3) generated from the owner's grant (narrow-only ceiling). */
export function manifestYaml(scope: GrantScope): string {
  // XPC services have no app bundle identity at runtime, so a granted system panel service is pinned by its canonical executable.
  const apps = scope.apps.map((b) => SYSTEM_SERVICE_EXECUTABLES[b]
    ? `    - { executable: ${JSON.stringify(SYSTEM_SERVICE_EXECUTABLES[b])}, launch: false, windows: all, terminate: deny }`
    : `    - { bundle_id: ${JSON.stringify(b)}, launch: true, windows: all, terminate: deny }`).join('\n');
  const roots = scope.file_roots.map((r) => `{ dir: ${JSON.stringify(r)}, recursive: true }`).join(', ');
  return `version: 3
expires_after: 8h
idle_timeout: 30m
allow: { tools: [${CUA_TOOLS.join(', ')}] }
deny: { tools: [kill_app, list_apps, clipboard_read, clipboard_write, get_desktop_state, set_config, replay_trajectory, install_ffmpeg, browser_set_input_files] }
resources:
  apps:
${apps || '    []'}
  files:
    read: [${roots}]
    write: [${roots}]
`;
}

export interface DaemonHandle { socketPath: string; generation: number; manifestSha256: string }

/** Launch (or relaunch) Billy's private bounded daemon via LaunchServices so TCC attributes to CuaDriver. */
export function launchPrivateDaemon(pin: CuaPin, runDir: string, scope: GrantScope, generation: number): DaemonHandle {
  const v = verifyPin(pin);
  if (!v.ok) throw new CuaError('pin_mismatch', `cua-driver does not match the pinned build (sha ${v.sha256.slice(0, 12)} team ${v.team})`);
  mkdirSync(runDir, { recursive: true, mode: 0o700 });
  // One socket per generation AND per launch: a retiring daemon removing its socket can never clobber its
  // successor's, and after a Billy restart (generation numbering starts again) a surviving driver from the
  // previous run, still enforcing an older grant's manifest, can never be mistaken for the new one.
  const nonce = randomBytes(6).toString('hex');
  const socketPath = join(runDir, `cua-${generation}-${nonce}.sock`);
  const manifestPath = join(runDir, `cua-manifest-${generation}-${nonce}.yaml`);
  const yaml = manifestYaml(scope);
  writeFileSync(manifestPath, yaml, { mode: 0o600 });
  chmodSync(manifestPath, 0o600);
  const r = spawnSync('/usr/bin/open', ['-n', '-g', '-a', pin.app_path,
    '--env', 'CUA_DRIVER_RS_TELEMETRY_ENABLED=0', '--env', 'CUA_DRIVER_RS_UPDATE_CHECK=false',
    '--args', 'serve', '--socket', socketPath, '--permission-mode', 'bounded', '--capability-manifest', manifestPath, '--approve-capability-manifest'], { encoding: 'utf8' });
  if (r.status !== 0) throw new CuaError('transport', `failed to launch CuaDriver: ${r.stderr}`);
  return { socketPath, generation, manifestSha256: createHash('sha256').update(yaml).digest('hex') };
}

/** Ask a private daemon to shut down; resolves once it has closed the connection, failed, or `timeoutMs` passed. */
export function stopPrivateDaemon(socketPath: string, timeoutMs = 3000): Promise<void> {
  return new Promise((resolve) => {
    let timer: NodeJS.Timeout | undefined;
    const done = () => { clearTimeout(timer); resolve(); };
    try {
      const s = createConnection(socketPath);
      timer = setTimeout(() => { s.destroy(); done(); }, timeoutMs);
      s.on('connect', () => { s.write(JSON.stringify({ method: 'shutdown' }) + '\n'); s.end(); });
      s.on('close', done);
      s.on('error', done);
    } catch { done(); }
  });
}

/** Startup: retire drivers left by an earlier Billy process (crash or unclean exit) and remove their files. */
export async function retireStaleDaemons(runDir: string): Promise<string[]> {
  let names: string[] = [];
  try { names = readdirSync(runDir); } catch { return []; }
  const sockets = names.filter((n) => /^cua-.*\.sock$/.test(n));
  await Promise.all(sockets.map((n) => stopPrivateDaemon(join(runDir, n))));
  for (const n of names.filter((x) => /^cua-.*\.(sock|yaml)$/.test(x))) rmSync(join(runDir, n), { force: true });
  return sockets;
}
