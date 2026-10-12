// billyctl: operator command surface (runbooks). Talks to billyd over its
// owner socket; offline operations (restore, data removal) refuse to run while
// the daemon owns the data directory. Exit codes: 0 ok, 1 check/command failed,
// 2 usage, 3 daemon not running, 4 refused for safety.
import { existsSync, readFileSync, renameSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { apiCall } from '../daemon/api.ts';
import { defaultDataDir, instanceLocked } from '../store/db.ts';
import { BackupManager, KeychainKeyProvider, StaticKeyProvider } from '../store/backup.ts';
import { realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';

const args = process.argv.slice(2);
const flag = (n: string) => { const i = args.indexOf(n); if (i < 0) return undefined; const v = args[i + 1]; args.splice(i, 2); return v; };
const dataDir = flag('--data-dir') ?? process.env.BILLY_DATA_DIR ?? defaultDataDir();
const json = args.includes('--json'); if (json) args.splice(args.indexOf('--json'), 1);
const [cmd, ...rest] = args;
const sock = join(dataDir, 'run', 'billyd.sock');
const out = (o: unknown, text?: string) => process.stdout.write((json || text === undefined ? JSON.stringify(o, null, 2) : text) + '\n');

async function api(method: string, path: string, body?: unknown) {
  if (!existsSync(sock)) { process.stderr.write(`billyd is not running (no socket at ${sock})\n`); process.exit(3); }
  const token = readFileSync(join(dataDir, 'run', 'api.token'), 'utf8').trim();
  try { return await apiCall(sock, token, method, path, body); }
  catch (e) { process.stderr.write(`cannot reach billyd: ${(e as Error).message}\n`); process.exit(3); }
}

function daemonOwnsData(): boolean { return instanceLocked(dataDir); }

const HELP = `billyctl <command> [--data-dir DIR] [--json]
  status                     service, stop latch and task counts
  doctor                     read-only diagnostics (exit 1 if any check fails)
  tasks                      recent tasks
  task-add "<goal>"          submit a goal (same admission path as the app)
  stop ["reason"]            emergency stop (persistent latch)
  resume                     clear the stop latch and resume paused tasks
  backup-create [label]      encrypted consistent backup
  backup-list | backup-verify <id>
  restore <id> --to <dir>    restore into a NEW directory (daemon must be stopped)
  diagnostics-export <file>  privacy-filtered diagnostics bundle
  uninstall-plan             show exactly what uninstall removes and keeps (no changes)
  data-trash --confirm       move Billy's data directory to the Trash (daemon must be stopped)`;

async function main() {
  switch (cmd) {
    case 'status': { const r = await api('GET', '/v1/status'); out(r.body, `billyd pid ${r.body.pid} · ${r.body.stop.stopped ? 'STOPPED' : 'running'} · tasks ${JSON.stringify(r.body.tasks)}`); return; }
    case 'doctor': {
      const r = await api('GET', '/v1/doctor');
      out(r.body, r.body.checks.map((c: any) => `${c.status.toUpperCase().padEnd(7)} ${c.id.padEnd(22)} ${c.detail}${c.fix ? `\n        fix: ${c.fix}` : ''}`).join('\n'));
      process.exit(r.body.ok ? 0 : 1);
    }
    case 'tasks': { const r = await api('GET', '/v1/tasks?limit=20'); out(r.body, r.body.map((t: any) => `${t.status.padEnd(18)} ${t.task_id.slice(0, 8)} ${t.goal.slice(0, 70)}`).join('\n') || 'no tasks'); return; }
    case 'task-add': {
      if (!rest[0]) { process.stderr.write('usage: billyctl task-add "<goal>"\n'); process.exit(2); }
      const r = await api('POST', '/v1/tasks', { goal: rest.join(' '), client_message_id: `cli-${crypto.randomUUID()}`, source: 'cli' });
      out(r.body, r.status < 300 ? `admitted ${r.body.task_id}` : `refused: ${r.body.error}`); process.exit(r.status < 300 ? 0 : 1);
    }
    case 'stop': { const r = await api('POST', '/v1/stop', { reason: rest.join(' ') || 'billyctl stop' }); out(r.body, `stopped (generation ${r.body.generation}, ack ${r.body.ack_ms.toFixed(1)}ms, ${r.body.in_flight.length} in flight)`); return; }
    case 'resume': { await api('POST', '/v1/stop/clear'); const r = await api('POST', '/v1/tasks/resume-all'); out(r.body, `resumed ${r.body.resumed.length} task(s)`); return; }
    case 'backup-create': { const r = await api('POST', '/v1/backups', { label: rest[0] ?? 'manual' }); out(r.body, `backup ${r.body.id} (schema v${r.body.schema_version})`); process.exit(r.status < 300 ? 0 : 1); }
    case 'backup-list': { const r = await api('GET', '/v1/backups'); out(r.body, r.body.map((b: any) => `${b.id}  ${b.created_at}  tasks=${b.counts?.tasks}`).join('\n') || 'no backups'); return; }
    case 'backup-verify': { const r = await api('POST', `/v1/backups/${rest[0]}/verify`); out(r.body, r.body.ok ? `verified ${rest[0]}` : `FAILED: ${r.body.reason}`); process.exit(r.body.ok ? 0 : 1); }
    case 'restore': {
      const to = flag('--to') ?? rest[1];
      if (!rest[0] || !to) { process.stderr.write('usage: billyctl restore <id> --to <new-dir>\n'); process.exit(2); }
      const hex = process.env.BILLY_TEST_BACKUP_KEY_HEX;
      const inTmp = [realpathSync(tmpdir()), '/private/tmp/'].some((t) => realpathSync(dataDir).startsWith(t));
      const mgr = new BackupManager({ dataDir, keys: hex && inTmp ? new StaticKeyProvider(Buffer.from(hex, 'hex')) : new KeychainKeyProvider({ allowCreate: false }) });
      const r = mgr.restore(rest[0], to);
      out(r, `restored ${rest[0]} into ${to}. Point Billy at it or move it into place while the service is stopped, then start Billy: recovery reconciles post-backup effects.`); return;
    }
    case 'diagnostics-export': {
      const file = rest[0]; if (!file) { process.stderr.write('usage: billyctl diagnostics-export <file>\n'); process.exit(2); }
      const r = await api('GET', '/v1/diagnostics/export'); writeFileSync(file, JSON.stringify(r.body, null, 2) + '\n', { mode: 0o600 }); out({ file }, `wrote ${file}`); return;
    }
    case 'uninstall-plan': {
      const plan = { removes: ['Billy.app (drag to Trash after unregistering)', 'LaunchAgent registration com.billy.core (Billy → Settings → Stop background service)'],
        keeps_unless_you_choose: [dataDir + ' (tasks, memory, backups, evidence)', join(homedir(), 'Library/Logs/Billy'), 'Keychain items com.billy.* (remove in Keychain Access)'],
        never_touched: ['your files in granted roots', '/Applications/CuaDriver.app (separately installed)'] };
      out(plan, `Uninstall removes:\n  - ${plan.removes.join('\n  - ')}\nKept unless you choose:\n  - ${plan.keeps_unless_you_choose.join('\n  - ')}\nNever touched:\n  - ${plan.never_touched.join('\n  - ')}`); return;
    }
    case 'data-trash': {
      if (!rest.includes('--confirm')) { process.stderr.write('refusing without --confirm (moves your Billy data to the Trash)\n'); process.exit(4); }
      if (daemonOwnsData()) { process.stderr.write('refusing: billyd is running; stop the background service first\n'); process.exit(4); }
      const trash = join(homedir(), '.Trash'); mkdirSync(trash, { recursive: true });
      const dest = join(trash, `Billy-data-${new Date().toISOString().replace(/[:.]/g, '-')}`);
      renameSync(dataDir, dest); out({ moved_to: dest }, `moved to ${dest} (restore by moving it back)`); return;
    }
    default: process.stdout.write(HELP + '\n'); process.exit(cmd ? 2 : 0);
  }
}
main();
