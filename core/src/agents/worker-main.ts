// Billy worker process: holds a lease (heartbeats) and drives one child task by
// requesting steps from the core over the private worker socket. It has no
// database access, no secrets and no tools of its own.
import { request } from 'node:http';

const sock = process.env.BILLY_WORKER_SOCK!;
const id = process.env.BILLY_WORKER_ID!;
const token = process.env.BILLY_WORKER_TOKEN!;
const hb = Number(process.env.BILLY_WORKER_HEARTBEAT_MS ?? 1000);

function post(path: string, body: object = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const r = request({ socketPath: sock, path, method: 'POST', headers: { 'x-billy-worker': id, authorization: `Bearer ${token}`, 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } }, (res) => {
      let t = ''; res.on('data', (c) => (t += c)); res.on('end', () => resolve({ status: res.statusCode ?? 0, body: t ? JSON.parse(t) : null }));
    });
    r.on('error', reject); r.end(data);
  });
}

async function main() {
  let fenced = false;
  const beat = async () => { try { const r = await post('/w/heartbeat'); if (r.status !== 200) fenced = true; } catch { fenced = true; } };
  await beat();
  const timer = setInterval(beat, hb);
  while (!fenced) {
    const r = await post('/w/step').catch(() => ({ status: 0, body: { done: true } }));
    if (r.status !== 200 || r.body?.done) break;
  }
  clearInterval(timer);
  process.exit(0);
}
main();
