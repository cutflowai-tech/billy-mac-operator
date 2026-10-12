// Out-of-process Telegram poller over a file-backed fake Bot API (honours offsets
// like the real one: unconfirmed updates are redelivered).
//   node telegram-proc.ts <dataDir> <updates.json> <ownerUserId>
import { readFileSync } from 'node:fs';
import { Core } from '../../src/core.ts';
import { TelegramRemote, type TelegramTransport } from '../../src/remote/telegram.ts';

const [dataDir, updatesFile, owner] = process.argv.slice(2);
const core = new Core({ dir: dataDir, allowUnsafeLocation: true });
let polls = 0;
const transport: TelegramTransport = {
  async getUpdates(offset) {
    if (++polls > 1) { remote.stop(); core.close(); process.exit(0); }
    return (JSON.parse(readFileSync(updatesFile, 'utf8')) as any[]).filter((u) => u.update_id >= offset);
  },
  async sendMessage() { return { message_id: 1 }; },
};
const remote = new TelegramRemote(core, transport, 'owner', (mid, sender, goal) => core.inbox.admit('telegram', mid, sender, 'ADMITTED', () => {
  const id = core.tasks.create({ owner_id: 'owner', goal, project_scope: 'fx', grant_id: null, budget_scope: null, source_command_id: `telegram:${mid}`, success_criteria: { description: goal, postconditions: [] } });
  return { task_id: id, revision: 1 };
}));
if (!remote.devices().length) core.store.tx(() => core.store.db.prepare(`INSERT INTO devices VALUES (?,?,?,?,?,?,NULL)`).run(crypto.randomUUID(), 'owner', 'telegram', owner, 'Telegram', core.store.now()));
remote.run(1);
