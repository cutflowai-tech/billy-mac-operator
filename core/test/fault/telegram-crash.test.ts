// T-REL-08 boundary telegram.after_handle; T-REMOTE-03 (contract): SIGKILL after a
// phone command is admitted but before the poll offset is confirmed. The Bot API
// redelivers the update; the inbox recognises it and exactly one task exists.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { tempDir } from '../helpers.ts';

const HERE = import.meta.dirname;
const PROC = join(HERE, '..', 'harness', 'telegram-proc.ts');
const RESULTS = join(HERE, '..', '..', '..', 'artifacts', 'fault');
const N = Number(process.env.BILLY_FAULT_INJECTIONS ?? 10);
const OWNER = 424242;

test('T-REMOTE-03 (contract) T-REL-08: crash between admission and offset confirmation -> redelivery is deduplicated (xN)', () => {
  mkdirSync(RESULTS, { recursive: true });
  for (let i = 0; i < N; i++) {
    const t = tempDir('billy-tgc-');
    try {
      const data = join(t.dir, 'data'); const upd = join(t.dir, 'updates.json');
      writeFileSync(upd, JSON.stringify([{ update_id: 100 + i, message: { message_id: 7 + i, text: `fixture goal ${i}`, from: { id: OWNER, is_bot: false }, chat: { id: OWNER, type: 'private' } } }]));
      const run = (faults: string) => spawnSync(process.execPath, [PROC, data, upd, String(OWNER)], { encoding: 'utf8', timeout: 60_000, env: { ...process.env, BILLY_FAULT_POINTS: faults } });
      const crashed = run('telegram.after_handle:1');
      assert.equal(crashed.signal, 'SIGKILL', crashed.stderr);
      const ok = run('');
      assert.equal(ok.status, 0, ok.stderr);
      const db = new DatabaseSync(join(data, 'billy.db'), { readOnly: true });
      try {
        const tasks = (db.prepare(`SELECT count(DISTINCT task_id) c FROM task_revisions WHERE source_command_id=?`).get(`telegram:${OWNER}:${7 + i}`) as any).c;
        const dup = (db.prepare(`SELECT count(*) c FROM events WHERE domain='inbox' AND kind='duplicate'`).get() as any).c;
        const offset = (db.prepare(`SELECT value FROM meta WHERE key='telegram_offset'`).get() as any)?.value;
        assert.equal(tasks, 1, 'exactly one task'); assert.equal(dup, 1, 'redelivery recognised'); assert.equal(Number(offset), 101 + i, 'offset confirmed after recovery');
      } finally { db.close(); }
      appendFileSync(join(RESULTS, 'broker-boundaries.jsonl'), JSON.stringify({ at: new Date().toISOString(), boundary: 'telegram.after_handle', injection: i, result: 'PASS' }) + '\n');
    } finally { t.cleanup(); }
  }
});
