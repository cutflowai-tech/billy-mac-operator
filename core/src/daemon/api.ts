// Local owner control API (HTTP/1.1 over a Unix domain socket).
// - No TCP listener: browsers and other hosts cannot reach it (T-SEC-08).
// - Socket 0600 inside a 0700 directory, plus a per-install bearer token file
//   (0600) checked in constant time. Untrusted workers are sandboxed away from
//   both paths (see sandbox profile).
// - Every mutating request is an owner command and goes through the same
//   inbox / control / broker paths as remote and voice commands.
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { join } from 'node:path';
import type { Core } from '../core.ts';
import { redactDeep } from '../util/redact.ts';

export type Handler = (req: { method: string; path: string; query: URLSearchParams; body: any; params: string[] }) => Promise<{ status?: number; body: unknown }> | { status?: number; body: unknown };

export interface Route { method: string; pattern: RegExp; handler: Handler }

export class ApiError extends Error {
  status: number;
  constructor(status: number, msg: string) { super(msg); this.status = status; }
}

/** Shortest token accepted from disk; anything shorter (an empty or truncated file) is replaced. */
export const MIN_TOKEN_CHARS = 32;

export function ensureToken(runDir: string): string {
  const p = join(runDir, 'api.token');
  if (existsSync(p)) {
    const existing = readFileSync(p, 'utf8').trim();
    // An empty token would match an empty or absent bearer header: never accept a weak one.
    if (existing.length >= MIN_TOKEN_CHARS) return existing;
    unlinkSync(p);
  }
  const t = randomBytes(32).toString('base64url');
  writeFileSync(p, t + '\n', { mode: 0o600, flag: 'wx' });
  return t;
}

export class LocalApi {
  private server: Server | null = null;
  private routes: Route[] = [];
  readonly socketPath: string;
  private token: string;
  private core: Core;

  constructor(core: Core, runDir: string) {
    this.core = core;
    mkdirSync(runDir, { recursive: true, mode: 0o700 });
    chmodSync(runDir, 0o700);
    this.socketPath = join(runDir, 'billyd.sock');
    if (Buffer.byteLength(this.socketPath) > 103) throw new Error(`socket path too long for macOS (${Buffer.byteLength(this.socketPath)} > 103 bytes): ${this.socketPath}`);
    this.token = ensureToken(runDir);
  }

  route(method: string, pattern: RegExp, handler: Handler): void { this.routes.push({ method, pattern, handler }); }

  private authorized(req: IncomingMessage): boolean {
    const h = String(req.headers.authorization ?? '');
    const got = Buffer.from(h.startsWith('Bearer ') ? h.slice(7) : '');
    const want = Buffer.from(this.token);
    if (req.headers.origin || req.headers['sec-fetch-site']) return false; // never a browser
    return want.length >= MIN_TOKEN_CHARS && got.length === want.length && timingSafeEqual(got, want);
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const send = (status: number, body: unknown) => {
      const text = JSON.stringify(redactDeep(body));
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(text);
    };
    if (!this.authorized(req)) return send(401, { error: 'unauthorized' });
    const url = new URL(req.url ?? '/', 'http://billyd');
    let raw = '';
    for await (const c of req) { raw += c; if (raw.length > 1_000_000) return send(413, { error: 'body too large' }); }
    let body: any = null;
    if (raw) { try { body = JSON.parse(raw); } catch { return send(400, { error: 'invalid JSON' }); } }
    for (const r of this.routes) {
      if (r.method !== req.method) continue;
      const m = r.pattern.exec(url.pathname);
      if (!m) continue;
      try {
        const out = await r.handler({ method: req.method!, path: url.pathname, query: url.searchParams, body, params: m.slice(1) });
        return send(out.status ?? 200, out.body);
      } catch (e) {
        const status = e instanceof ApiError ? e.status : 500;
        this.core.store.tx(() => this.core.store.event('api', url.pathname, 'error', { status, error: String((e as Error).message).slice(0, 300) }));
        return send(status, { error: (e as Error).message });
      }
    }
    send(404, { error: 'not found' });
  }

  listen(): Promise<void> {
    if (existsSync(this.socketPath)) unlinkSync(this.socketPath); // single instance already guaranteed by the store lock
    this.server = createServer((q, s) => { this.handle(q, s).catch(() => { try { s.writeHead(500); s.end(); } catch { /* closed */ } }); });
    return new Promise((res) => this.server!.listen(this.socketPath, () => { chmodSync(this.socketPath, 0o600); res(); }));
  }

  close(): Promise<void> {
    return new Promise((res) => { if (!this.server) return res(); this.server.close(() => res()); });
  }
}

/** Minimal client used by the CLI, tests and runbook checks. */
export async function apiCall(socketPath: string, token: string, method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> {
  const { request } = await import('node:http');
  return new Promise((resolve, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const r = request({ socketPath, path, method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...(data ? { 'content-length': Buffer.byteLength(data) } : {}) } }, (res) => {
      let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => { try { resolve({ status: res.statusCode ?? 0, body: t ? JSON.parse(t) : null }); } catch (e) { reject(e); } });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}
