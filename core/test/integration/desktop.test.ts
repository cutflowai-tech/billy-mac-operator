// Desktop adapter CONTRACT/INTEGRATION tests against a fake NDJSON Cua daemon.
// NATIVE_LIVE scenarios are NOT satisfied here (no real app is controlled).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { fixture } from '../fixtures.ts';
import { DESKTOP_TOOLS, type DesktopServices } from '../../src/tools/desktop.ts';
import { SocketTransport, manifestYaml } from '../../src/desktop/cua.ts';
import { DesktopArbiter, type SessionProbe, type SessionFacts } from '../../src/desktop/session.ts';
import { scope } from '../fixtures.ts';

const sockDir = mkdtempSync('/tmp/billy-bcua-');
after(() => rmSync(sockDir, { recursive: true, force: true }));

function fakeDaemon(path: string, behaviour: { verify?: string; refuseClick?: boolean } = {}) {
  const calls: { name: string; args: any }[] = [];
  const srv: Server = createServer((s) => {
    let buf = '';
    s.on('data', (d) => {
      buf += d; const nl = buf.indexOf('\n'); if (nl < 0) return;
      const req = JSON.parse(buf.slice(0, nl)); buf = '';
      calls.push({ name: req.name, args: req.args });
      const ok = (sc: any) => s.end(JSON.stringify({ ok: true, result: { content: [], structuredContent: sc } }) + '\n');
      switch (req.name) {
        case 'launch_app': return ok({ bundle_id: req.args.bundle_id, pid: 4242, windows: [] });
        case 'list_windows': return ok({ windows: [{ window_id: 77, pid: 4242, title: 'Untitled', is_on_screen: true }] });
        case 'get_window_state': return ok({ snapshot_id: 's1', elements_complete: true, elements: [{ element_token: 's1:0', role: 'AXTextArea', label: 'body', value: '' }] });
        case 'press_key': case 'hotkey': return ok({ effect: 'performed' });
        case 'click': if (behaviour.refuseClick) return ok({ status: 'refused', refusal: { reason: 'outside manifest' } }); return ok({ effect: 'performed' });
        case 'type_text': return ok({ effect: 'performed' });
        case 'verify_state': return ok({ status: behaviour.verify ?? 'satisfied' });
        default: return s.end(JSON.stringify({ ok: false, error: 'unknown tool' }) + '\n');
      }
    });
  }).listen(path);
  return { calls, close: () => srv.close() };
}

class FakeProbe implements SessionProbe {
  f: SessionFacts = { idle_ms: 60_000, locked: false, frontmost_bundle: 'com.apple.TextEdit', at: Date.now() };
  read() { return { ...this.f, at: Date.now() }; }
}

function desktopFixture(name: string, behaviour = {}) {
  const sock = join(sockDir, `${name}.sock`);
  const daemon = fakeDaemon(sock, behaviour);
  const probe = new FakeProbe();
  const arbiter = new DesktopArbiter(probe, { activeWindowMs: 1500, resumeIdleMs: 5000, selfEchoMs: 250, pollMs: 50 });
  let gen = 1;
  const desktop: DesktopServices = { transport: () => new SocketTransport(sock), generation: () => gen, arbiter, foreground: () => 'when_idle', observations: new Map(), sessionId: 'billy-test' };
  const fx = fixture({ extraTools: DESKTOP_TOOLS, services: { desktop } }, { tool_classes: ['file', 'desktop', 'app'], apps: ['com.apple.TextEdit'] });
  return { fx, daemon, probe, arbiter, desktop, bumpGeneration: () => { gen++; }, cleanup: () => { arbiter.stop(); daemon.close(); fx.cleanup(); } };
}

const expectBody = [{ element: { selector: { role: 'AXTextArea' }, value_equals: 'hello' } }];

async function observe(d: ReturnType<typeof desktopFixture>, id: string, step = 'obs') {
  const r = await d.fx.core.broker.submit(d.fx.proposal(id, 'desktop.observe', { bundle_id: 'com.apple.TextEdit' }, step));
  assert.equal(r.verdict, 'COMMITTED', r.reason);
  return (r.receipt as any).observation_ref as string;
}

test('observe -> act -> driver-side verification, one input call per action', async () => {
  const d = desktopFixture('happy');
  try {
    const id = d.fx.task(); d.fx.run(id);
    const ref = await observe(d, id);
    const r = await d.fx.core.broker.submit(d.fx.proposal(id, 'desktop.act', { observation_ref: ref, action: 'type_text', element_token: 's1:0', text: 'hello', expect: expectBody }, 'type'));
    assert.equal(r.verdict, 'COMMITTED', r.reason);
    assert.equal(d.daemon.calls.filter((c) => c.name === 'type_text').length, 1);
    assert.deepEqual(d.daemon.calls.find((c) => c.name === 'verify_state')!.args.expect, expectBody);
    // One action per observation: reuse is refused.
    const again = await d.fx.core.broker.submit(d.fx.proposal(id, 'desktop.act', { observation_ref: ref, action: 'click', element_token: 's1:0', expect: expectBody }, 'type2'));
    assert.equal(again.verdict, 'DENIED');
  } finally { d.cleanup(); }
});

test('T-MAC-12 (contract): driver generation change invalidates observations; no replay through another provider', async () => {
  const d = desktopFixture('gen');
  try {
    const id = d.fx.task(); d.fx.run(id);
    const ref = await observe(d, id);
    d.bumpGeneration();
    const r = await d.fx.core.broker.submit(d.fx.proposal(id, 'desktop.act', { observation_ref: ref, action: 'click', element_token: 's1:0', expect: expectBody }, 'c'));
    assert.equal(r.verdict, 'REJECTED');
    assert.match(r.reason, /driver generation changed/);
    assert.equal(d.daemon.calls.filter((c) => c.name === 'click').length, 0);
  } finally { d.cleanup(); }
});

test('T-MAC-09 (contract): owner input is detected within one poll; Billy yields and the old observation is unusable', async () => {
  const d = desktopFixture('takeover');
  try {
    const id = d.fx.task(); d.fx.run(id);
    const ref = await observe(d, id);
    let detectedAt = 0;
    d.arbiter.onTakeover.push(() => { if (!detectedAt) detectedAt = Date.now(); });
    d.arbiter.start();
    const t0 = Date.now();
    d.probe.f = { ...d.probe.f, idle_ms: 10 }; // owner starts typing
    while (!detectedAt && Date.now() - t0 < 2000) await new Promise((r) => setTimeout(r, 5));
    assert.ok(detectedAt && detectedAt - t0 <= 500, `suppression within 500ms (took ${detectedAt - t0}ms)`);
    const r = await d.fx.core.broker.submit(d.fx.proposal(id, 'desktop.act', { observation_ref: ref, action: 'type_text', element_token: 's1:0', text: 'x', expect: expectBody }, 't'));
    assert.ok(['REJECTED', 'WAIT_RESOURCE'].includes(r.verdict), r.verdict);
    assert.equal(d.daemon.calls.filter((c) => c.name === 'type_text').length, 0, 'never typed during owner activity');
    // Owner becomes idle: a FRESH observation is required before resuming.
    d.arbiter.stop();
    d.probe.f = { ...d.probe.f, idle_ms: 60_000 };
    const ref2 = await observe(d, id, 'obs2');
    const ok = await d.fx.core.broker.submit(d.fx.proposal(id, 'desktop.act', { observation_ref: ref2, action: 'type_text', element_token: 's1:0', text: 'hello', expect: expectBody }, 't2'));
    assert.equal(ok.verdict, 'COMMITTED', ok.reason);
  } finally { d.cleanup(); }
});

test('T-MAC-10 (contract): locked session -> no input, reported as waiting for the session', async () => {
  const d = desktopFixture('locked');
  try {
    const id = d.fx.task(); d.fx.run(id);
    const ref = await observe(d, id);
    d.probe.f = { ...d.probe.f, locked: true };
    const r = await d.fx.core.broker.submit(d.fx.proposal(id, 'desktop.act', { observation_ref: ref, action: 'click', element_token: 's1:0', expect: expectBody }, 'c'));
    assert.equal(r.verdict, 'WAIT_SESSION');
    assert.match(r.reason, /screen is locked/);
    assert.equal(d.daemon.calls.filter((c) => c.name === 'click').length, 0);
  } finally { d.cleanup(); }
});

test('foreground input resumes after the quiet period without a resource release', async () => {
  const d = desktopFixture('quiet-resume');
  try {
    const id = d.fx.task(); d.fx.run(id);
    const ref = await observe(d, id);
    d.fx.core.executor.seedPlan(id, 1, 'scripted', { steps: [{
      kind: 'action', step_key: 'key', tool_id: 'desktop.act',
      arguments: { observation_ref: ref, action: 'press_key', key: 'Return', expect: [{ window: { exists: true } }] },
    }] });
    // Owner is past the activity window, but not yet past the foreground quiet period.
    d.probe.f = { ...d.probe.f, idle_ms: 2000 };
    await d.fx.core.executor.runTask(id);
    assert.equal(d.fx.core.tasks.get(id).status, 'WAITING_USER_SESSION');
    assert.equal(d.fx.core.tasks.get(id).wait_condition, 'session_available');
    assert.equal(d.daemon.calls.filter((c) => c.name === 'press_key').length, 0);
    assert.equal(d.fx.core.store.db.prepare('SELECT count(*) c FROM resource_claims').get()!.c, 0);

    // The daemon's session timer uses this wake; no unrelated task or claim is needed.
    d.probe.f = { ...d.probe.f, idle_ms: 60_000 };
    assert.equal(d.fx.core.executor.wake('session_available'), 1);
    d.fx.core.store.transitionTask(id, 'RUNNING');
    await d.fx.core.executor.runTask(id);
    assert.equal(d.fx.core.tasks.get(id).status, 'COMPLETED');
    assert.equal(d.daemon.calls.filter((c) => c.name === 'press_key').length, 1);
  } finally { d.cleanup(); }
});

test('foreground authority waits for a grant change instead of an unrelated resource release', async () => {
  const d = desktopFixture('foreground-authority');
  try {
    const id = d.fx.task(); d.fx.run(id);
    const ref = await observe(d, id);
    d.desktop.foreground = () => 'never';
    d.fx.core.executor.seedPlan(id, 1, 'scripted', { steps: [{
      kind: 'action', step_key: 'key', tool_id: 'desktop.act',
      arguments: { observation_ref: ref, action: 'press_key', key: 'Return', expect: [{ window: { exists: true } }] },
    }] });
    await d.fx.core.executor.runTask(id);
    assert.equal(d.fx.core.tasks.get(id).status, 'WAITING_PERMISSION');
    assert.equal(d.fx.core.tasks.get(id).wait_condition, 'grant_changed');
    assert.equal(d.fx.core.executor.wake('session_available'), 0);
    assert.equal(d.fx.core.executor.wake('resource_released'), 0);
    assert.equal(d.daemon.calls.filter((c) => c.name === 'press_key').length, 0);

    d.desktop.foreground = () => 'when_idle';
    assert.equal(d.fx.core.executor.wake('grant_changed'), 1);
    d.fx.core.store.transitionTask(id, 'RUNNING');
    await d.fx.core.executor.runTask(id);
    assert.equal(d.fx.core.tasks.get(id).status, 'COMPLETED');
    assert.equal(d.daemon.calls.filter((c) => c.name === 'press_key').length, 1);
  } finally { d.cleanup(); }
});

test('driver refusal is a definite failure; verify_state "unknown" never counts as success', async () => {
  const d1 = desktopFixture('refuse', { refuseClick: true });
  try {
    const id = d1.fx.task(); d1.fx.run(id);
    const r = await d1.fx.core.broker.submit(d1.fx.proposal(id, 'desktop.act', { observation_ref: await observe(d1, id), action: 'click', element_token: 's1:0', expect: expectBody }, 'c'));
    assert.equal(r.verdict, 'FAILED');
  } finally { d1.cleanup(); }
  const d2 = desktopFixture('unknown', { verify: 'unknown' });
  try {
    const id = d2.fx.task(); d2.fx.run(id);
    const r = await d2.fx.core.broker.submit(d2.fx.proposal(id, 'desktop.act', { observation_ref: await observe(d2, id), action: 'click', element_token: 's1:0', expect: expectBody }, 'c'));
    assert.equal(r.verdict, 'UNRESOLVED');
  } finally { d2.cleanup(); }
});

test('desktop.act rejects non-schema predicates and ungranted apps', async () => {
  const d = desktopFixture('schema');
  try {
    const id = d.fx.task(); d.fx.run(id);
    const ref = await observe(d, id);
    const bad = await d.fx.core.broker.submit(d.fx.proposal(id, 'desktop.act', { observation_ref: ref, action: 'click', element_token: 's1:0', expect: [{ anything: 1 }] }, 'c'));
    assert.equal(bad.verdict, 'REJECTED');
    const other = await d.fx.core.broker.submit(d.fx.proposal(id, 'desktop.observe', { bundle_id: 'com.apple.Terminal' }, 'o'));
    assert.equal(other.verdict, 'DENIED');
  } finally { d.cleanup(); }
});

test('T-AGENT-04: two tasks want the desktop; at most one writer, background file work proceeds', async () => {
  const d = desktopFixture('lease');
  try {
    const a = d.fx.task(); d.fx.run(a);
    const b = d.fx.task(); d.fx.run(b);
    const refA = await observe(d, a, 'oa'); const refB = await observe(d, b, 'ob');
    // Hold the desktop claim as task A would during a long action.
    d.fx.core.claims.acquireAll([{ resource_key: 'desktop:billy-test', mode: 'exclusive' }], 'holder-a', 'task:' + a);
    const rb = await d.fx.core.broker.submit(d.fx.proposal(b, 'desktop.act', { observation_ref: refB, action: 'click', element_token: 's1:0', expect: expectBody }, 'cb'));
    assert.equal(rb.verdict, 'WAIT_RESOURCE');
    const bg = await d.fx.core.broker.submit(d.fx.proposal(b, 'fs.write', { path: join(d.fx.root, 'bg.txt'), content: 'x', mode: 'create' }, 'bg'));
    assert.equal(bg.verdict, 'COMMITTED', 'background work is not blocked by the desktop lease');
    d.fx.core.claims.releaseAll('holder-a');
    const ra = await d.fx.core.broker.submit(d.fx.proposal(a, 'desktop.act', { observation_ref: refA, action: 'click', element_token: 's1:0', expect: expectBody }, 'ca'));
    // Fairness: B queued first, so A must wait its turn.
    assert.equal(ra.verdict, 'WAIT_RESOURCE');
    const rb2 = await d.fx.core.broker.submit(d.fx.proposal(b, 'desktop.act', { observation_ref: refB, action: 'click', element_token: 's1:0', expect: expectBody }, 'cb'));
    assert.equal(rb2.verdict, 'COMMITTED', rb2.reason);
    const clicks = d.daemon.calls.filter((c) => c.name === 'click').length;
    assert.equal(clicks, 1, 'exactly one desktop input occurred');
  } finally { d.cleanup(); }
});

test('generated Cua capability manifest is a narrow ceiling derived from the grant', () => {
  const y = manifestYaml(scope({ apps: ['com.apple.TextEdit', 'com.apple.calculator'], file_roots: ['/Users/x/Billy Workspace'] }));
  assert.match(y, /version: 3/);
  assert.match(y, /expires_after: 8h/);
  assert.match(y, /bundle_id: "com.apple.TextEdit".*terminate: deny/);
  assert.match(y, /deny: \{ tools: \[kill_app, list_apps, clipboard_read, clipboard_write/);
  assert.ok(!/allow: \{ tools: \[[^\]]*list_apps/.test(y), 'no display-wide app enumeration');
  assert.ok(!/com\.apple\.Terminal/.test(y));
});

test('attached save panel needs the panel service in the grant; manifest pins it by executable path', async () => {
  const d = desktopFixture('panel');
  try {
    const id = d.fx.task(); d.fx.run(id);
    const r = await d.fx.core.broker.submit(d.fx.proposal(id, 'desktop.observe', { bundle_id: 'com.apple.TextEdit', attached_panel: true }, 'panel'));
    assert.notEqual(r.verdict, 'COMMITTED');
    assert.match(r.reason, /com\.apple\.appkit\.xpc\.openAndSavePanelService not granted/);
    assert.ok(!d.daemon.calls.some((c) => c.name === 'get_window_state'), 'denied before any observation');
    const y = manifestYaml(scope({ apps: ['com.apple.TextEdit', 'com.apple.appkit.xpc.openAndSavePanelService'] }));
    assert.match(y, /- \{ bundle_id: "com\.apple\.TextEdit"/);
    assert.match(y, /- \{ executable: "\/System\/Library\/Frameworks\/AppKit\.framework\/Versions\/C\/XPCServices\/com\.apple\.appkit\.xpc\.openAndSavePanelService\.xpc\/Contents\/MacOS\/com\.apple\.appkit\.xpc\.openAndSavePanelService", launch: false/);
  } finally { d.cleanup(); }
});

test('focused input and pixel/token rules are enforced before dispatch', async () => {
  const d = desktopFixture('focused');
  try {
    const id = d.fx.task(); d.fx.run(id);
    const o = await observe(d, id);
    const bad = [
      { action: 'set_value', focused: true, text: 'x' },                                  // focused only for type/key/hotkey
      { action: 'type_text', focused: true, element_token: 's1:0', text: 'x' },          // focused excludes a token
      { action: 'type_text', text: 'x' },                                                 // needs a token, focus, or x,y
    ];
    for (const [i, b] of bad.entries()) {
      const r = await d.fx.core.broker.submit(d.fx.proposal(id, 'desktop.act', { observation_ref: o, expect: [{ window: { exists: true } }], ...b }, `bad-${i}`));
      assert.notEqual(r.verdict, 'COMMITTED', JSON.stringify(b));
    }
    assert.ok(!d.daemon.calls.some((c) => ['type_text', 'set_value'].includes(c.name)), 'nothing dispatched');
  } finally { d.cleanup(); }
});
