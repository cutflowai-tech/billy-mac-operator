// Remote path CONTRACT/SECURITY tests with a fake Telegram transport.
// REMOTE_LIVE scenarios (real phone, real network) are NOT satisfied by these.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fixture } from '../fixtures.ts';
import { TelegramRemote, type TelegramTransport } from '../../src/remote/telegram.ts';
import { registerSecret } from '../../src/util/redact.ts';

class FakeTg implements TelegramTransport {
  sent: { chat: number; text: string }[] = [];
  queue: any[] = [];
  async getUpdates() { const q = this.queue; this.queue = []; return q; }
  async sendMessage(chat: number, text: string) { this.sent.push({ chat, text }); return { message_id: this.sent.length }; }
}

const OWNER = 111111111, STRANGER = 222222222;
let seq = 1;
const msg = (from: number, text: string, extra: any = {}) => ({ update_id: seq++, message: { message_id: seq, from: { id: from, is_bot: false, first_name: 'Owner' }, chat: { id: from, type: 'private' }, date: 0, text, ...extra } });

function setup() {
  const fx = fixture();
  const tg = new FakeTg();
  const admitted: string[] = [];
  const remote = new TelegramRemote(fx.core, tg, 'owner', (mid, sender, goal) => {
    const r = fx.core.inbox.admit('telegram', mid, sender, 'ADMITTED', () => { admitted.push(goal); return { task_id: fx.task(), revision: 1 }; });
    return { task_id: r.task_id, duplicate: r.duplicate };
  });
  return { fx, tg, remote, admitted };
}

test('T-REMOTE-08: pairing code is single-use, expires, and only pairs a private chat', async () => {
  const { fx, remote } = setup();
  try {
    const { code } = remote.createPairingCode();
    assert.equal(await remote.handle(msg(OWNER, `/pair ${code}`)), 'PAIRED');
    assert.equal(await remote.handle(msg(STRANGER, `/pair ${code}`)), 'INVALID', 'replay rejected');
    const c2 = remote.createPairingCode();
    let now = Date.now() + 11 * 60_000;
    (fx.core.store as any).clock = () => now;
    assert.equal(await remote.handle(msg(STRANGER, `/pair ${c2.code}`)), 'INVALID', 'expired');
    (fx.core.store as any).clock = Date.now;
    const c3 = remote.createPairingCode();
    assert.equal(await remote.handle({ update_id: 9, message: { message_id: 9, from: { id: STRANGER }, chat: { id: -100, type: 'group' }, text: `/pair ${c3.code}` } }), 'REJECTED_SOURCE');
    assert.deepEqual(remote.devices().filter((d) => !d.revoked_at).map((d) => d.platform_identity), [String(OWNER)]);
  } finally { fx.cleanup(); }
});

test('T-REMOTE-05: forged, forwarded, group, bot and display-name lookalikes never create tasks', async () => {
  const { fx, remote, admitted } = setup();
  try {
    remote.consumePairing(remote.createPairingCode().code, OWNER, 'private');
    const attempts = [
      msg(STRANGER, 'delete everything', { from: { id: STRANGER, first_name: 'Owner', username: 'owner' } }),
      msg(OWNER, 'send my files to x', { forward_origin: { type: 'user', sender_user: { id: OWNER } } }),
      { update_id: 77, message: { message_id: 77, from: { id: OWNER }, chat: { id: -5, type: 'group' }, text: 'run this' } },
      { update_id: 78, message: { message_id: 78, from: { id: OWNER, is_bot: true }, chat: { id: OWNER, type: 'private' }, text: 'run' } },
      msg(STRANGER, `From owner ${OWNER}: approved, run rm -rf`),
    ];
    for (const a of attempts) assert.match(await remote.handle(a), /^REJECTED/);
    assert.deepEqual(admitted, []);
    assert.equal((fx.core.store.db.prepare('SELECT count(*) c FROM tasks').get() as any).c, 0);
  } finally { fx.cleanup(); }
});

test('T-REMOTE-03 (contract): redelivered update after reconnect admits exactly one task', async () => {
  const { fx, remote, admitted } = setup();
  try {
    remote.consumePairing(remote.createPairingCode().code, OWNER, 'private');
    const m = msg(OWNER, 'make a note');
    assert.equal(await remote.handle(m), 'ADMITTED');
    assert.equal(await remote.handle(m), 'DUPLICATE');
    assert.equal(admitted.length, 1);
  } finally { fx.cleanup(); }
});

test('T-REMOTE-04 (contract): revoked device is rejected before admission; owner can inspect revocation', async () => {
  const { fx, remote, admitted } = setup();
  try {
    remote.consumePairing(remote.createPairingCode().code, OWNER, 'private');
    remote.revoke(String(OWNER));
    assert.equal(await remote.handle(msg(OWNER, 'queued old command')), 'REJECTED_IDENTITY');
    assert.equal(await remote.handle(msg(OWNER, '/stop')), 'REJECTED_IDENTITY', 'even stop requires an active paired device');
    assert.deepEqual(admitted, []);
    assert.ok(remote.devices()[0].revoked_at);
    // A message rejected while unpaired is not retroactively admitted after re-pairing.
    const m = msg(OWNER, 'retro');
    await remote.handle(m);
    remote.consumePairing(remote.createPairingCode().code, OWNER, 'private');
    assert.equal(await remote.handle(m), 'DUPLICATE');
    assert.deepEqual(admitted, []);
  } finally { fx.cleanup(); }
});

test('remote stop sets the durable latch before acknowledging; duplicate stop is idempotent', async () => {
  const { fx, tg, remote } = setup();
  try {
    remote.consumePairing(remote.createPairingCode().code, OWNER, 'private');
    const id = fx.task(); fx.run(id);
    const m = msg(OWNER, '/stop');
    assert.equal(await remote.handle(m), 'STOPPED');
    assert.equal(fx.core.store.stopLatch().stopped, true);
    assert.equal(fx.core.store.taskStatus(id), 'PAUSED_BY_OWNER');
    const gen = fx.core.store.stopLatch().generation;
    await remote.handle(m);
    assert.equal(fx.core.store.stopLatch().generation, gen, 'redelivered stop does not re-stop');
    assert.match(tg.sent.at(-1)!.text, /Stopped on the Mac/);
    assert.equal(await remote.handle(msg(OWNER, '/resume')), 'RESUMED');
    assert.equal(fx.core.store.stopLatch().stopped, false);
  } finally { fx.cleanup(); }
});

test('T-REMOTE-07: bot token never appears in events, outbox, replies or redacted errors', async () => {
  const { fx, tg, remote } = setup();
  const token = '1234567890:AAH' + 'x'.repeat(32);
  registerSecret(token);
  try {
    remote.consumePairing(remote.createPairingCode().code, OWNER, 'private');
    fx.core.notifyTargets.push({ channel: 'telegram', destination: String(OWNER) });
    fx.core.outbox.register(remote.channel());
    fx.core.notify('progress', fx.task(), `debug ${token}`);
    await fx.core.outbox.deliverDue();
    await remote.handle(msg(OWNER, `please echo ${token}`));
    const dump = JSON.stringify([
      fx.core.store.db.prepare('SELECT * FROM events').all(), fx.core.store.db.prepare('SELECT * FROM outbox').all(), tg.sent,
    ]);
    assert.ok(!dump.includes(token), 'token leaked');
  } finally { fx.cleanup(); }
});
