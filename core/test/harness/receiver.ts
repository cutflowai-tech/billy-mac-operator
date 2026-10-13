// Controlled side-effect receiver (fixture service). Runs as its own process so
// it survives crashes of the system under test. It is the authoritative
// counter of real external effects.
//
// POST /messages            {account, to, body}; Idempotency-Key header
//   - same key + same payload -> original receipt (deduped)
//   - same key + changed payload -> 409 conflict
// GET  /ops/<key>           reconciliation lookup by operation identity
// GET  /stats               {effects, requests, by_key}
// POST /control             {mode: normal|drop_after_commit|fail_before_commit|delay_ms, n?}
import { createServer } from 'node:http';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// Not a test file: when a bare `node --test` discovers it (no arguments), refuse instead of listening forever,
// which would hang the runner (its default per-file timeout is infinite).
if (process.argv.length < 4) {
  process.stderr.write('receiver.ts is a harness process: node receiver.ts <ledgerPath|""> <port>\n');
  process.exit(2);
}
const ledgerPath = process.argv[2];
const port = Number(process.argv[3] ?? 0);
const ops = new Map<string, { digest: string; seq: number; at: string }>();
let effects = 0, requests = 0, mode = 'normal', modeCount = 0, delayMs = 0;
if (ledgerPath && existsSync(ledgerPath)) {
  for (const line of readFileSync(ledgerPath, 'utf8').split('\n').filter(Boolean)) {
    const e = JSON.parse(line); ops.set(e.key, e); effects++;
  }
}

function body(req: any): Promise<string> {
  return new Promise((res) => { let b = ''; req.on('data', (c: any) => (b += c)); req.on('end', () => res(b)); });
}

const srv = createServer(async (req, res) => {
  const url = new URL(req.url!, 'http://x');
  if (req.method === 'GET' && url.pathname === '/stats') {
    res.end(JSON.stringify({ effects, requests, by_key: Object.fromEntries([...ops].map(([k, v]) => [k, v.seq])) }));
    return;
  }
  if (req.method === 'GET' && url.pathname.startsWith('/ops/')) {
    const k = decodeURIComponent(url.pathname.slice(5));
    const o = ops.get(k);
    res.end(JSON.stringify(o ? { found: true, ...o } : { found: false }));
    return;
  }
  if (req.method === 'POST' && url.pathname === '/control') {
    const c = JSON.parse(await body(req));
    mode = c.mode; modeCount = c.n ?? Infinity; delayMs = c.delay_ms ?? 0;
    res.end('{}');
    return;
  }
  if (req.method === 'POST' && url.pathname === '/messages') {
    requests++;
    const raw = await body(req);
    const key = String(req.headers['idempotency-key'] ?? '');
    if (!key) { res.statusCode = 400; res.end('{"error":"missing key"}'); return; }
    const digest = createHash('sha256').update(raw).digest('hex');
    const prev = ops.get(key);
    if (prev) {
      if (prev.digest !== digest) { res.statusCode = 409; res.end(JSON.stringify({ error: 'idempotency key reused with different payload' })); return; }
      res.end(JSON.stringify({ ok: true, deduped: true, seq: prev.seq }));
      return;
    }
    const active = modeCount > 0 ? mode : 'normal';
    const useDelay = active === 'delay' ? delayMs : 0;
    if (active === 'delay') modeCount--;
    if (active === 'fail_before_commit') { modeCount--; res.statusCode = 503; res.end('{"error":"unavailable"}'); return; }
    if (useDelay) await new Promise((r) => setTimeout(r, useDelay));
    effects++;
    const rec = { key, digest, seq: effects, at: new Date().toISOString() };
    ops.set(key, rec);
    if (ledgerPath) appendFileSync(ledgerPath, JSON.stringify(rec) + '\n');
    if (active === 'drop_after_commit') { modeCount--; req.socket.destroy(); return; }
    res.end(JSON.stringify({ ok: true, seq: rec.seq }));
    return;
  }
  res.statusCode = 404; res.end('{}');
});
srv.listen(port, '127.0.0.1', () => {
  process.stdout.write(`LISTENING ${(srv.address() as any).port}\n`);
});
