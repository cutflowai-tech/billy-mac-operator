// NATIVE_LIVE: real apps, real pinned Cua driver (private bounded daemon), real
// session arbiter, through Billy's broker. Skips (never passes) when the driver
// or its TCC permissions are unavailable.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, writeFileSync, readFileSync, mkdtempSync, realpathSync, appendFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { STAMP } from '../stamp.ts';
import { fixture, type Fx } from '../fixtures.ts';
import { DESKTOP_TOOLS, PANEL_SERVICE_BUNDLE, type DesktopServices } from '../../src/tools/desktop.ts';
import { SocketTransport, launchPrivateDaemon, stopPrivateDaemon, interpret, verifyPin } from '../../src/desktop/cua.ts';
import { DesktopArbiter, MacSessionProbe } from '../../src/desktop/session.ts';
import { defaultConfig } from '../../src/daemon/config.ts';

const ROOT = join(import.meta.dirname, '..', '..', '..');
const OCR = process.env.BILLY_OCR_PATH ?? join(ROOT, 'native/.build/debug/billy-ocr');
const MEAS = join(ROOT, 'artifacts/measurements'); mkdirSync(MEAS, { recursive: true });
const RUNS = Number(process.env.BILLY_NATIVE_RUNS ?? 3);
let unavailable: string | null = null;

before(async () => {
  // This suite drives the owner's real desktop. It runs only when asked for explicitly (qualify.ts sets this),
  // never because a bare `node --test` happened to discover it on a Mac where the driver has permissions.
  if (process.env.BILLY_NATIVE_LIVE !== '1') { unavailable = 'BILLY_NATIVE_LIVE=1 not set (this suite operates the real desktop)'; return; }
  const pin = verifyPin(defaultConfig().cua);
  if (!pin.ok) { unavailable = 'pinned CuaDriver not installed'; return; }
  if (!existsSync(OCR)) { unavailable = `OCR helper missing at ${OCR} (swift build --product billy-ocr)`; return; }
  const run = mkdtempSync('/tmp/billy-blive-');
  const h = launchPrivateDaemon(defaultConfig().cua, run, { apps: [], file_roots: [] } as any, 0);
  for (let i = 0; i < 100 && !existsSync(h.socketPath); i++) await new Promise((r) => setTimeout(r, 100));
  try {
    let r: any = null;
    for (let i = 0; i < 40; i++) {
      try { r = interpret('check_permissions', await new SocketTransport(h.socketPath).call('check_permissions', {}, 'probe', 10_000)); break; }
      catch (e: any) { if (e?.code !== 'permissions_pending' || i === 39) throw e; await new Promise((res) => setTimeout(res, 500)); }
    }
    if (!(r.accessibility === true && r.screen_recording === true)) unavailable = `CuaDriver TCC not granted (accessibility=${r.accessibility}, screen_recording=${r.screen_recording})`;
  } catch (e) { unavailable = `driver unavailable: ${(e as Error).message}`; }
  finally { stopPrivateDaemon(h.socketPath); }
});

interface Live { fx: Fx; desktop: DesktopServices; restart: () => void; cleanup: () => void }

function live(apps: string[], extra: object = {}): Live {
  const services: Record<string, unknown> = {};
  const fx = fixture({ extraTools: DESKTOP_TOOLS, services }, { tool_classes: ['file', 'desktop', 'app'], apps, foreground: 'when_idle', ...extra });
  const run = mkdtempSync('/tmp/billy-blv-');
  let gen = 1; let h = launchPrivateDaemon(defaultConfig().cua, run, fx.core.policy.current(fx.grantId)!.scope, gen);
  const arbiter = new DesktopArbiter(new MacSessionProbe());
  const desktop: DesktopServices = { transport: () => new SocketTransport(h.socketPath), generation: () => gen, arbiter, foreground: () => 'when_idle',
    observations: new Map(), sessionId: 'billy-live', ocrPath: OCR };
  services.desktop = desktop;
  return { fx, desktop,
    restart: () => { stopPrivateDaemon(h.socketPath); gen++; h = launchPrivateDaemon(defaultConfig().cua, run, fx.core.policy.current(fx.grantId)!.scope, gen); },
    cleanup: () => { stopPrivateDaemon(h.socketPath); arbiter.stop(); fx.cleanup(); } };
}

async function waitSocket(l: Live) { for (let i = 0; i < 100; i++) { try { await l.desktop.transport().call('get_screen_size', {}, 'x', 2000); return; } catch { await new Promise((r) => setTimeout(r, 100)); } } }

async function observe(l: Live, id: string, bundle: string, step: string, extra: object = {}) {
  await waitIdle(l);
  const r = await l.fx.core.broker.submit(l.fx.proposal(id, 'desktop.observe', { bundle_id: bundle, max_elements: 400, ...extra }, step));
  assert.equal(r.verdict, 'COMMITTED', `${step}: ${r.reason}`);
  return r.receipt as any;
}
/**
 * Like the product, a step that hits the human-coexistence gate waits for an idle
 * gap and then retries (with a FRESH observation supplied by the caller's retry).
 */
async function waitIdle(l: Live, minIdleMs = 3000, maxMs = 30 * 60_000) {
  const end = Date.now() + maxMs;
  while (Date.now() < end) { const f = l.desktop.arbiter.facts(); if (!f.locked && f.idle_ms >= minIdleMs) return; await new Promise((r) => setTimeout(r, 500)); }
  throw new Error('owner never idle long enough for live desktop input');
}
/**
 * Billy yielded to the owner: before dispatch (WAIT_SESSION/WAIT_RESOURCE, or a stale observation from owner
 * activity) or at the last moment before input (RETRY_ELIGIBLE "yielded to owner"). The harness then waits for the
 * owner to go idle and re-observes, exactly as the executor's wake would; it never re-sends a stale action.
 */
function ownerYield(r: { verdict: string; reason?: string }): boolean {
  return r.verdict !== 'COMMITTED' && /human coexistence|owner activity|stale observation: owner|yielded to owner/.test(r.reason ?? '');
}
async function act(l: Live, id: string, args: Record<string, unknown>, step: string, reobserve?: () => Promise<Record<string, unknown>>) {
  for (let i = 0; ; i++) {
    const r = await l.fx.core.broker.submit(l.fx.proposal(id, 'desktop.act', args, step));
    const human = ownerYield(r);
    if (!human || i > 50) return r;
    await waitIdle(l);
    if (reobserve) args = { ...args, ...(await reobserve()) };
    else return r;
  }
}
/** Observe -> build action from that fresh observation -> act; on owner activity wait and redo both. */
async function oa(l: Live, id: string, bundle: string, obsExtra: object, build: (o: any) => Record<string, unknown>, step: string) {
  for (let i = 0; i < 40; i++) {
    const o = await observe(l, id, bundle, `${step}-obs-${i}`, obsExtra);
    const r = await l.fx.core.broker.submit(l.fx.proposal(id, 'desktop.act', { observation_ref: o.observation_ref, ...build(o) }, step));
    if (!ownerYield(r)) return r;
    await waitIdle(l);
  }
  throw new Error(`${step}: owner never idle`);
}
function record(id: string, m: Record<string, number>, note: object = {}) {
  writeFileSync(join(MEAS, `${id}.json`), JSON.stringify({ test_id: id, measurements: m, at: new Date().toISOString(), ...STAMP, ...note }, null, 2));
}

test('T-MAC-01 T-FOUND-03: Calculator 6 x 7 = 42 through Billy, verified on the actual display (x3 consecutive)', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const l = live(['com.apple.calculator']);
  let passes = 0; const runs: object[] = [];
  try {
    await waitSocket(l);
    for (let run = 0; run < RUNS; run++) {
      const id = l.fx.task(); l.fx.run(id);
      const press = async (labels: string[], expectOcr: string | null, step: string) => {
        const obs = await observe(l, id, 'com.apple.calculator', `obs-${step}`);
        const el = obs.elements.find((e: any) => e.role === 'AXButton' && labels.includes(e.label));
        assert.ok(el, `button ${labels} visible`);
        // The display strip: below the title bar, above the first row of buttons (from the AX layout, not a fixed box).
        const topRow = Math.min(...obs.elements.filter((e: any) => e.role === 'AXButton' && e.frame && e.frame.y > 40).map((e: any) => e.frame.y));
        const expect = expectOcr ? [{ ocr: { region: { x1: 0, y1: 30, x2: obs.window.bounds.width, y2: topRow - 4 }, line_equals: expectOcr } }] : [{ window: { exists: true } }];
        const reobs = async () => { const o = await observe(l, id, 'com.apple.calculator', `re-${step}-${Date.now()}`); const e = o.elements.find((x: any) => x.role === 'AXButton' && labels.includes(x.label)); return { observation_ref: o.observation_ref, element_token: e.element_token }; };
        const r = await act(l, id, { observation_ref: obs.observation_ref, action: 'click', element_token: el.element_token, expect }, step, reobs);
        return r;
      };
      // Clear, verified exactly through accessibility: Calculator labels its clear key "All Clear" only when the
      // entry is cleared ("Clear" otherwise). A lone "0" glyph is not reliably readable by OCR (Vision reads "o").
      let cleared = false;
      for (let i = 0; i < 3 && !cleared; i++) {
        const o = await observe(l, id, 'com.apple.calculator', `clr-obs-${run}-${i}`);
        const key = o.elements.find((e: any) => e.role === 'AXButton' && ['All Clear', 'Clear'].includes(e.label));
        const r = await act(l, id, { observation_ref: o.observation_ref, action: 'click', element_token: key.element_token,
          expect: [{ element: { selector: { role: 'AXButton', label_contains: 'All Clear' }, exists: true } }] }, `clear-${run}-${i}`);
        cleared = r.verdict === 'COMMITTED';
        if (!cleared) console.log('CLEAR', r.verdict, r.reason, JSON.stringify(r.evidence));
      }
      assert.ok(cleared, 'entry verified cleared (All Clear) before computing');
      for (const [labels, s] of [[['6'], 'six'], [['Multiply'], 'times'], [['7'], 'seven']] as const) assert.equal((await press([...labels], null, `${s}-${run}`)).verdict, 'COMMITTED');
      const eq = await press(['Equals'], '42', `equals-${run}`);
      assert.equal(eq.verdict, 'COMMITTED', `display shows 42: ${JSON.stringify(eq.evidence)}`);
      passes++; runs.push({ run, evidence: eq.evidence });
    }
    record('T-MAC-01', { consecutive_passes: passes }, { runs });
    record('T-FOUND-03', { live_probes: passes }, { driver: 'cua-driver 0.26.1 (pinned, private bounded daemon)' });
  } finally { l.cleanup(); }
});

// ---------------------------------------------------------------------------
// Shared helpers for document-style scenarios.
async function launch(l: Live, id: string, bundle: string, paths: string[] = [], step = 'launch') {
  const r = await l.fx.core.broker.submit(l.fx.proposal(id, 'app.launch', { bundle_id: bundle, ...(paths.length ? { open_paths: paths } : {}) }, step));
  assert.equal(r.verdict, 'COMMITTED', `${step}: ${r.reason}`);
  await new Promise((res) => setTimeout(res, 1200));
}
const menu = (l: Live, id: string, ref: string, path: string[], step: string, expect: object[] = [{ window: { exists: true } }]) =>
  act(l, id, { observation_ref: ref, action: 'invoke_menu', menu_path: path, expect }, step);
async function repeat(name: string, fn: (run: number) => Promise<object>) {
  const runs: object[] = []; let passes = 0;
  const hist = (row: object) => appendFileSync(join(ROOT, 'artifacts/live-history.jsonl'), JSON.stringify({ test_id: name, at: new Date().toISOString(), ...STAMP, ...row }) + '\n');
  for (let run = 0; run < RUNS; run++) {
    try { runs.push(await fn(run)); passes++; hist({ run, result: 'PASS' }); }
    catch (e) { hist({ run, result: 'FAIL', error: String((e as Error).message).slice(0, 300) }); throw e; }
  }
  record(name, { consecutive_passes: passes }, { runs, runs_requested: RUNS });
}
import { createHash as _h } from 'node:crypto';
const fileSha = (p: string) => _h('sha256').update(readFileSync(p)).digest('hex');

test('T-MAC-02: TextEdit edit + save; saved bytes exact; unrelated document untouched (x3)', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const l = live(['com.apple.TextEdit']);
  try {
    await waitSocket(l);
    const other = join(l.fx.root, 'unrelated.txt'); writeFileSync(other, 'do not touch ✓\n'); const otherSha = fileSha(other);
    await repeat('T-MAC-02', async (run) => {
      const file = join(l.fx.root, `note-${run}.txt`); writeFileSync(file, 'initial ✓\n');
      // The AX value as reported by the driver omits a trailing newline, so content ends without one;
      // the saved file bytes are still compared exactly.
      const want = `Hello Billy ${run}\nمرحبا يا بيلي`;
      const id = l.fx.task(); l.fx.run(id);
      await launch(l, id, 'com.apple.TextEdit', [file], `open-${run}`);
      const sel = { window_title_contains: `note-${run}` };
      const set = await oa(l, id, 'com.apple.TextEdit', sel, (o) => ({ action: 'set_value', element_token: o.elements.find((e: any) => e.role === 'AXTextArea').element_token, text: want,
        expect: [{ element: { selector: { role: 'AXTextArea' }, value_equals: want } }] }), `set-${run}`);
      if (set.verdict !== 'COMMITTED') { const ob = await observe(l, id, 'com.apple.TextEdit', `dbg-${run}`, sel); console.log('SETDBG', JSON.stringify(ob.elements.filter((e: any) => /Text/.test(e.role)).map((e: any) => [e.role, e.label, e.value]))); console.log('WANT', JSON.stringify(want)); }
      assert.equal(set.verdict, 'COMMITTED', set.reason);
      assert.equal((await oa(l, id, 'com.apple.TextEdit', sel, () => ({ action: 'invoke_menu', menu_path: ['File', 'Save'], expect: [{ window: { exists: true } }] }), `save-${run}`)).verdict, 'COMMITTED');
      for (let i = 0; i < 20 && readFileSync(file, 'utf8') !== want; i++) await new Promise((r) => setTimeout(r, 250));
      assert.equal(readFileSync(file, 'utf8'), want, 'saved bytes equal the requested content');
      await oa(l, id, 'com.apple.TextEdit', sel, () => ({ action: 'invoke_menu', menu_path: ['File', 'Close'], expect: [{ window: { exists: false } }] }), `close-${run}`);
      assert.equal(fileSha(other), otherSha, 'unrelated document untouched');
      return { run, sha: fileSha(file) };
    });
  } finally { l.cleanup(); }
});

test('T-MAC-05: two fixture applications with the same window title are routed by app and window identity (token, pixel and focused input) (x3)', async (t) => {
  if (unavailable) return t.skip(unavailable);
  if (!existsSync(FIXTURE_APP) || !existsSync(FIXTURE_B_APP)) return t.skip('fixture apps not built (tests/fixtures/BillyFixture/build.sh)');
  const l = live([FIXTURE, FIXTURE_B]);
  try {
    await waitSocket(l);
    await repeat('T-MAC-05', async (run) => {
      const id = l.fx.task(); l.fx.run(id);
      // Two different apps, both showing a window titled exactly "Report.txt".
      await fixtureApp(l, id, { title: 'Report.txt', content: `A ${run}` }, `openA-${run}`, FIXTURE);
      await fixtureApp(l, id, { title: 'Report.txt', content: `B ${run}` }, `openB-${run}`, FIXTURE_B);
      const win = async (bundle: string) => until(async () => { try { return (await observe(l, id, bundle, `w-${bundle}-${Date.now()}`, { window_title_contains: 'Report.txt' })).window.window_id as number; } catch { return null; } }, `${bundle} window`);
      const winA = await win(FIXTURE), winB = await win(FIXTURE_B);
      const field = (o: any) => o.elements.find((e: any) => e.role === 'AXTextField' && /Report content/.test(e.label) && e.element_token);
      const textOf = async (bundle: string, w: number) => field(await observe(l, id, bundle, `rd-${bundle}-${Date.now()}`, { window_id: w, max_elements: 60 }))?.value;
      // 1. Token input into A.
      let r = await oa(l, id, FIXTURE, { window_id: winA, max_elements: 60 }, (o) => ({ action: 'set_value', element_token: field(o).element_token, text: `token A ${run}`, expect: [{ window: { exists: true } }] }), `tokA-${run}`);
      assert.equal(r.verdict, 'COMMITTED', r.reason);
      assert.equal(await textOf(FIXTURE, winA), `token A ${run}`);
      assert.equal(await textOf(FIXTURE_B, winB), `B ${run}`, 'B untouched by A input');
      // 2. Pixel input into B (click its field), then focused input: lands in B only.
      r = await oa(l, id, FIXTURE_B, { window_id: winB, max_elements: 60 }, (o) => { const f = field(o); return { action: 'click', x: f.frame.x + f.frame.w - 6, y: f.frame.y + f.frame.h / 2, expect: [{ window: { exists: true } }] }; }, `pxB-${run}`);
      assert.equal(r.verdict, 'COMMITTED', r.reason);
      r = await oa(l, id, FIXTURE_B, { window_id: winB, max_elements: 60 }, () => ({ action: 'type_text', focused: true, text: ` +focused`, expect: [{ window: { exists: true } }] }), `focB-${run}`);
      assert.equal(r.verdict, 'COMMITTED', r.reason);
      assert.match(String(await textOf(FIXTURE_B, winB)), /\+focused$/, 'focused text reached B');
      assert.equal(await textOf(FIXTURE, winA), `token A ${run}`, 'A untouched by B input');
      // 3. Back to A by token: switching targets again never crosses apps.
      r = await oa(l, id, FIXTURE, { window_id: winA, max_elements: 60 }, (o) => ({ action: 'set_value', element_token: field(o).element_token, text: `again A ${run}`, expect: [{ window: { exists: true } }] }), `tokA2-${run}`);
      assert.equal(r.verdict, 'COMMITTED', r.reason);
      assert.equal(await textOf(FIXTURE, winA), `again A ${run}`);
      assert.match(String(await textOf(FIXTURE_B, winB)), /\+focused$/, 'B unchanged by the switch back');
      await quitFixture();
      return { run, windows: { fixture_a: winA, fixture_b: winB }, methods: ['token', 'pixel', 'focused'] };
    });
  } finally { await quitFixture(); l.cleanup(); }
});

test('T-MAC-12: driver restart invalidates old observations; no replay creates a duplicate effect', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const l = live(['com.apple.TextEdit']);
  try {
    await waitSocket(l);
    const file = join(l.fx.root, 'gen.txt'); writeFileSync(file, 'gen ✓\n');
    const id = l.fx.task(); l.fx.run(id);
    await launch(l, id, 'com.apple.TextEdit', [file]);
    const o = await observe(l, id, 'com.apple.TextEdit', 'obs', { window_title_contains: 'gen' });
    const area = o.elements.find((e: any) => e.role === 'AXTextArea');
    l.restart(); await waitSocket(l);
    const stale = await act(l, id, { observation_ref: o.observation_ref, action: 'set_value', element_token: area.element_token, text: 'SHOULD NOT APPEAR',
      expect: [{ element: { selector: { role: 'AXTextArea' }, value_equals: 'SHOULD NOT APPEAR' } }] }, 'stale');
    assert.equal(stale.verdict, 'REJECTED');
    assert.match(stale.reason, /driver generation changed/);
    const o2 = await observe(l, id, 'com.apple.TextEdit', 'obs2', { window_title_contains: 'gen' });
    assert.ok(!o2.elements.some((e: any) => String(e.value).includes('SHOULD NOT APPEAR')));
    const o3 = await observe(l, id, 'com.apple.TextEdit', 'obs3', { window_title_contains: 'gen' });
    await menu(l, id, o3.observation_ref, ['File', 'Close'], 'close', [{ window: { exists: false } }]);
    record('T-MAC-12', { stale_rejected: 1, duplicate_effects: 0 });
  } finally { l.cleanup(); }
});

test('T-MAC-12: an element token is bound to one driver snapshot — the real driver refuses a superseded token, with no effect', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const l = live(['com.apple.TextEdit']);
  try {
    await waitSocket(l);
    const tag = Math.random().toString(16).slice(2, 6);
    const file = join(l.fx.root, `bind-${tag}.txt`); writeFileSync(file, 'bound ✓');
    const id = l.fx.task(); l.fx.run(id);
    await launch(l, id, 'com.apple.TextEdit', [file], 'bind-open');
    const sel = { window_title_contains: `bind-${tag}` };
    await until(async () => { try { await observe(l, id, 'com.apple.TextEdit', `bw-${Date.now()}`, sel); return true; } catch { return false; } }, 'window');
    // The surface classifier relies on the pinned driver walking the window subtree BEFORE the app menu bar
    // (reaching the menu bar proves the window was covered). Check that order on the real driver.
    { const o0 = await observe(l, id, 'com.apple.TextEdit', 'bind-order', sel);
      const ob = l.desktop.observations.get(o0.observation_ref) as any;
      const raw = await l.desktop.transport().call('get_window_state', { pid: ob.pid, window_id: ob.window_id, include_screenshot: false, max_elements: 2000 }, 'billy-live');
      const rows: any[] = raw?.result?.structuredContent?.elements ?? [];
      // Roots (depth 0) carry no parent_index; every other row names its parent.
      const bad = rows.filter((e) => !(e.depth === 0 ? e.parent_index == null : Number.isInteger(e.parent_index)));
      assert.deepEqual(bad.map((e) => e.role), [], 'the driver reports ancestry for every non-root row');
      // The window's rows form a contiguous prefix: once the walk leaves the window it never returns.
      const root = rows.findIndex((e) => e.role === 'AXWindow' && e.parent_index == null);
      const inWindow = (i: number) => { for (let k = i, n = 0; n <= rows.length; n++) { if (k === root) return true; const p = rows[k].parent_index; if (p == null) return false; k = p; } return false; };
      const firstOutside = rows.findIndex((_, i) => i > root && !inWindow(i));
      assert.ok(root === 0 && firstOutside > 0, 'the window is walked first, then other roots');
      assert.deepEqual(rows.slice(firstOutside).filter((_, k) => inWindow(firstOutside + k)).map((e) => e.role), [], 'no window row after the walk left the window');
      assert.ok(rows.slice(0, firstOutside).some((e) => e.role === 'AXTextArea'), 'the window content is in the prefix'); }
    const first = await observe(l, id, 'com.apple.TextEdit', 'bind-obs1', sel);
    const oldToken = first.elements.find((e: any) => e.role === 'AXTextArea' && e.element_token).element_token;
    // A second observation of the same window replaces the driver snapshot (and its token map).
    const second = await observe(l, id, 'com.apple.TextEdit', 'bind-obs2', sel);
    await waitIdle(l);
    const r = await l.fx.core.broker.submit(l.fx.proposal(id, 'desktop.act', { observation_ref: first.observation_ref, action: 'set_value', element_token: oldToken, text: 'MUST NOT LAND',
      expect: [{ window: { exists: true } }] }, 'bind-stale'));
    assert.notEqual(r.verdict, 'COMMITTED', 'a superseded token is refused');
    assert.match(String(r.reason), /stale/i, String(r.reason));
    const now = await observe(l, id, 'com.apple.TextEdit', 'bind-check', sel);
    assert.equal(now.elements.find((e: any) => e.role === 'AXTextArea')?.value, 'bound ✓', 'no effect from the stale token');
    void second;
    await oa(l, id, 'com.apple.TextEdit', sel, () => ({ action: 'invoke_menu', menu_path: ['File', 'Close'], expect: [{ window: { exists: false } }] }), 'bind-close');
    record('T-MAC-12-token-binding', { stale_token_refused: 1, effects: 0 });
  } finally { l.cleanup(); }
});

test('T-MAC-07: moved/resized window rejects stale pixel input; fresh geometry places input in the intended target (x3)', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const l = live(['com.apple.TextEdit']);
  try {
    await waitSocket(l);
    const size = interpret('get_screen_size', await l.desktop.transport().call('get_screen_size', {}, 'billy-live')) as any;
    await repeat('T-MAC-07', async (run) => {
      const file = join(l.fx.root, `geo-${run}.txt`); writeFileSync(file, 'geometry ✓');
      const id = l.fx.task(); l.fx.run(id);
      await launch(l, id, 'com.apple.TextEdit', [file], `open-${run}`);
      const sel = { window_title_contains: `geo-${run}` };
      const o = await observe(l, id, 'com.apple.TextEdit', `obs-${run}`, sel);
      const pid = (l.desktop.observations.get(o.observation_ref) as any).pid;
      // Move AND resize the window (driver verifies the readback), invalidating old pixel coordinates.
      const nx = 260 + run * 60, ny = 180 + run * 40, nw = 640 + run * 40, nh = 420 + run * 30;
      interpret('set_window_frame', await l.desktop.transport().call('set_window_frame', { pid, window_id: o.window.window_id, x: nx, y: ny, width: nw, height: nh }, 'billy-live'));
      const area0 = o.elements.find((e: any) => e.role === 'AXTextArea');
      const stale = await l.fx.core.broker.submit(l.fx.proposal(id, 'desktop.act', { observation_ref: o.observation_ref, action: 'click',
        x: area0.frame.x + 20, y: area0.frame.y + 20, expect: [{ window: { exists: true } }] }, `stale-${run}`));
      assert.notEqual(stale.verdict, 'COMMITTED', `stale pixel input refused (${stale.reason})`);
      // Fresh geometry: a pixel click inside the text area, then text typed at that insertion point.
      const marker = `PIXEL-${run}`;
      const clk = await oa(l, id, 'com.apple.TextEdit', sel, (f) => { const a = f.elements.find((e: any) => e.role === 'AXTextArea'); return { action: 'click', x: a.frame.x + a.frame.w - 10, y: a.frame.y + a.frame.h - 10, expect: [{ window: { exists: true } }] }; }, `click-${run}`);
      assert.equal(clk.verdict, 'COMMITTED', clk.reason);
      const typed = await oa(l, id, 'com.apple.TextEdit', sel, (f) => ({ action: 'type_text', element_token: f.elements.find((e: any) => e.role === 'AXTextArea').element_token, text: ` ${marker}`,
        expect: [{ element: { selector: { role: 'AXTextArea' }, value_equals: `geometry ✓ ${marker}` } }] }), `type-${run}`);
      if (typed.verdict !== 'COMMITTED') { const dbg = await observe(l, id, 'com.apple.TextEdit', `dbg-${run}`, sel); console.log('TYPEDBG', run, JSON.stringify(dbg.elements.find((e: any) => e.role === 'AXTextArea')?.value)); }
      assert.equal(typed.verdict, 'COMMITTED', JSON.stringify(typed.evidence));
      const now = (await observe(l, id, 'com.apple.TextEdit', `chk-${run}`, sel)).window.bounds;
      // Apps may snap sizes by a few points (the driver itself verifies the readback within tolerance).
      for (const [got, want] of [[now.x, nx], [now.y, ny], [now.width, nw], [now.height, nh]]) assert.ok(Math.abs(got - want) <= 8, `geometry ${got} vs requested ${want}`);
      await oa(l, id, 'com.apple.TextEdit', sel, () => ({ action: 'invoke_menu', menu_path: ['File', 'Close'], expect: [{ window: { exists: false } }] }), `close-${run}`);
      return { run, frame: [nx, ny, nw, nh], display: { width: size.width, height: size.height, scale: size.scale_factor, tested_configuration: 'single display, scale 1 only' } };
    });
  } finally { l.cleanup(); }
});

test('T-BOOT-03: actual host qualification from direct probes (no inference)', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const { spawnSync } = await import('node:child_process');
  const l = live([]);
  try {
    await waitSocket(l);
    const perms = interpret('check_permissions', await l.desktop.transport().call('check_permissions', {}, 'x')) as any;
    const size = interpret('get_screen_size', await l.desktop.transport().call('get_screen_size', {}, 'billy-live')) as any;
    const report = {
      os: spawnSync('sw_vers', ['-productVersion'], { encoding: 'utf8' }).stdout.trim(), arch: process.arch,
      swift: spawnSync('swift', ['--version'], { encoding: 'utf8' }).stdout.split('\n')[0], xcode: spawnSync('xcodebuild', ['-version'], { encoding: 'utf8' }).status === 0 ? 'present' : 'absent (CLT only)',
      driver: verifyPin(defaultConfig().cua), permissions: { accessibility: perms.accessibility, screen_recording: perms.screen_recording, attribution: perms.source?.attribution },
      display: size, session: new MacSessionProbe().read(),
    };
    assert.equal(report.arch, 'arm64'); assert.equal(report.driver.ok, true);
    writeFileSync(join(MEAS, 'T-BOOT-03-host.json'), JSON.stringify(report, null, 2));
    record('T-BOOT-03', { probes: 6 }, { report });
  } finally { l.cleanup(); }
});

async function until<T>(f: () => Promise<T | null | false>, what: string, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) { const v = await f(); if (v) return v as T; if (Date.now() > end) throw new Error(`timed out: ${what}`); await new Promise((r) => setTimeout(r, 700)); }
}
/** Visible text: macOS wraps RTL names in bidi isolation marks in AX labels and menu titles. */
const visibleText = (x: unknown) => String(x ?? '').replace(/[\u200E\u200F\u202A-\u202E\u2066-\u2069]/g, '').normalize('NFC');
const dump = (o: any) => o.elements.filter((e: any) => /AXTextField|AXButton|AXSheet|AXPopUpButton|AXComboBox/.test(e.role)).map((e: any) => `${e.role}|${e.label ?? e.title ?? ''}|${String(e.value ?? '').slice(0, 60)}`).join('\n');

const FIXTURE = 'com.billy.fixture', FIXTURE_B = 'com.billy.fixture.b';
const FIXTURE_APP = join(ROOT, 'artifacts/fixtures/BillyFixture.app'), FIXTURE_B_APP = join(ROOT, 'artifacts/fixtures/BillyFixtureB.app');
const FIXTURE_PROCESS: Record<string, string> = { [FIXTURE]: 'BillyFixture', [FIXTURE_B]: 'BillyFixtureB' };
/** Fresh fixture instance with the given settings (each fixture app reads its own config at launch). */
async function fixtureApp(l: Live, id: string, cfg: Record<string, string | number>, step: string, bundle = FIXTURE) {
  const { spawnSync } = await import('node:child_process');
  spawnSync('/usr/bin/pkill', ['-x', FIXTURE_PROCESS[bundle]]);
  const dir = join(process.env.HOME!, 'Library/Caches', bundle); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'config.json'), JSON.stringify(cfg));
  // The fixture's own preference domain: always start with a collapsed (compact) save panel.
  spawnSync('/usr/bin/defaults', ['write', bundle, 'NSNavPanelExpandedStateForSaveMode', '-bool', 'false']);
  spawnSync('/usr/bin/defaults', ['write', bundle, 'NSNavPanelExpandedStateForSaveMode2', '-bool', 'false']);
  // ...and when expanded, wide enough that the column browser shows the current folder's contents.
  spawnSync('/usr/bin/defaults', ['write', bundle, 'NSNavPanelExpandedSizeForSaveMode', '-string', '{1700, 520}']);
  await new Promise((r) => setTimeout(r, 500));
  await launch(l, id, bundle, [], step);
}
const cleanupDirs: string[] = [];
const quitFixture = async () => { const { spawnSync } = await import('node:child_process'); for (const p of Object.values(FIXTURE_PROCESS)) spawnSync('/usr/bin/pkill', ['-x', p]); };

test('T-MAC-08: native save dialog -> exact Unicode target directory/name, exact bytes, no unrelated overwrite (x3)', async (t) => {
  if (unavailable) return t.skip(unavailable);
  if (!existsSync(FIXTURE_APP)) return t.skip('fixture app not built (tests/fixtures/BillyFixture/build.sh)');
  // The fixture's save panel is a file-panel surface: input there needs the owner's explicit file_panel_input authority.
  const l = live([FIXTURE], { protected_actions: ['file_panel_input'] });
  try {
    await waitSocket(l);
    // A shallow, small parent keeps the panel's column browser small (the default temp dir holds thousands of entries).
    const shallow = mkdtempSync('/private/tmp/bnl-'); cleanupDirs.push(shallow);
    const dir = join(shallow, 'مجلد التقارير ✓'); mkdirSync(dir);
    await repeat('T-MAC-08', async (run) => {
      const tag = Math.random().toString(16).slice(2, 6);
      const title = `Fixture ${run}-${tag}`;
      const body = `حفظ ${run} — save ✓ ${tag}`;
      const decoy = join(dir, `تقرير-${run}.txt`); writeFileSync(decoy, 'decoy — must not change'); const decoySha = fileSha(decoy);
      const base = `تقرير-${run} ✓`; const target = join(dir, `${base}.txt`);
      const id = l.fx.task(); l.fx.run(id);
      // The panel deliberately opens in a DIFFERENT folder (the target's parent), so the target folder must be chosen.
      await fixtureApp(l, id, { 'save-dir': shallow, content: body, title }, `open-${run}`);
      const main = { window_title_contains: title };
      let r = await oa(l, id, FIXTURE, main, () => ({ action: 'invoke_menu', menu_path: ['File', 'Save Report…'], expect: [{ window: { exists: true } }] }), `save-${run}`);
      assert.equal(r.verdict, 'COMMITTED', r.reason);
      const P = { window_title_contains: 'Save Report' };
      const isName = (e: any) => e.role === 'AXTextField' && e.label !== 'tag editor';
      await until(async () => { try { const o = await observe(l, id, FIXTURE, `p-${run}-${Date.now()}`, { ...P, max_elements: 200 }); return o.elements.some((e: any) => isName(e) && /^report(\.txt)?$/.test(e.value)) ? o : null; } catch { return null; } }, 'save panel')
        .catch(async (e) => { console.log('SAVE wins', JSON.stringify(((await l.fx.core.broker.submit(l.fx.proposal(id, 'desktop.observe', { bundle_id: FIXTURE, list_windows: true, max_elements: 10 }, `wl-${run}`))).receipt as any)?.windows?.map((w: any) => w.title)));
          try { console.log('SAVE pd', JSON.stringify((await observe(l, id, FIXTURE, `pdx-${run}`, { ...P, max_elements: 200 })).elements.map((x: any) => [x.role, x.label, x.value]))); } catch (e2) { console.log('SAVE pd err', (e2 as Error).message); }
          throw e; });
      // 1. Exact Unicode file name (AX value write on the name field).
      r = await oa(l, id, FIXTURE, { ...P, max_elements: 200 }, (o) => ({ action: 'set_value', element_token: o.elements.find(isName).element_token, text: `${base}.txt`,
        expect: [{ window: { exists: true } }] }), `name-${run}`);
      assert.equal(r.verdict, 'COMMITTED', `name: ${r.reason}`);
      await until(async () => (await observe(l, id, FIXTURE, `nv-${run}-${Date.now()}`, { ...P, max_elements: 200 })).elements.some((e: any) => isName(e) && String(e.value).normalize('NFC') === `${base}.txt`.normalize('NFC')), 'name field holds the exact name');
      // 2. Exact folder: expand the panel, widen it so the folder's column is inside the window, and open the folder
      //    row with a double-click at the element (foreground delivery under the owner-idle rule). Keyboard chords are
      //    avoided on purpose: synthetic keys follow the OWNER's active layout (e.g. Arabic), which Billy never changes.
      const folderName = 'مجلد التقارير ✓';
      const visible = (x: unknown) => String(x).replace(/[‎‏‪-‮⁦-⁩]/g, '').normalize('NFC');
      const whereIs = async () => { const o = await observe(l, id, FIXTURE, `wh-${run}-${Date.now()}`, { ...P, query: 'Where', max_elements: 50 }); const w = o.elements.find((e: any) => e.role === 'AXPopUpButton'); return w ? visible(w.value) : null; };
      r = await oa(l, id, FIXTURE, { ...P, max_elements: 200 }, (o) => ({ action: 'click', element_token: o.elements.find((e: any) => e.role === 'AXDisclosureTriangle').element_token, expect: [{ window: { exists: true } }] }), `expand-${run}`);
      assert.equal(r.verdict, 'COMMITTED', `expand: ${r.reason}`);
      const row = (o: any) => o.elements.find((e: any) => e.role === 'AXTextField' && visible(e.label || e.value) === visible(folderName));
      let cur = await until(async () => { const o = await observe(l, id, FIXTURE, `rows-${run}-${Date.now()}`, { ...P, max_elements: 400 }); return row(o) ? o : null; }, 'target folder row');
      const inView = (o: any) => { const t = row(o); return t?.frame && t.frame.x >= 0 && t.frame.x + t.frame.w <= o.window.bounds.width; };
      if (!inView(cur)) {
        const ob = l.desktop.observations.get(cur.observation_ref) as any; const bb = cur.window.bounds;
        await l.desktop.transport().call('set_window_frame', { pid: ob.pid, window_id: ob.window_id, x: Math.max(0, bb.x - 500), y: bb.y, width: 1700, height: bb.height }, 'billy-live');
        cur = await until(async () => { const o = await observe(l, id, FIXTURE, `rows-r-${run}-${Date.now()}`, { ...P, max_elements: 400 }); return inView(o) ? o : null; }, 'folder row inside the panel');
      }
      r = await act(l, id, { observation_ref: cur.observation_ref, action: 'double_click', element_token: row(cur).element_token, needs_foreground: true, expect: [{ window: { exists: true } }] }, `open-folder-${run}`);
      console.log('SAVE dbl', r.verdict, r.reason ?? '', JSON.stringify(r.evidence ?? null).slice(0, 400));
      console.log('SAVE where-after', await whereIs().catch((e) => String(e).slice(0, 80)));
      console.log('SAVE wins3', JSON.stringify(((await l.fx.core.broker.submit(l.fx.proposal(id, 'desktop.observe', { bundle_id: FIXTURE, list_windows: true, max_elements: 10 }, `wl3-${run}`))).receipt as any)?.windows?.map((w: any) => [w.title, w.bounds])));
      { const { spawnSync: sp } = await import('node:child_process'); console.log('SAVE tree', sp('/usr/bin/find', [shallow], { encoding: 'utf8' }).stdout.replace(/\n/g, ' | '));
        const st = await observe(l, id, FIXTURE, `st0-${run}`, { ...main, query: 'Save', max_elements: 20 }); console.log('SAVE status', JSON.stringify(st.elements.map((e: any) => [e.role, e.value]))); }
      assert.equal(r.verdict, 'COMMITTED', `open folder: ${r.reason}`);
      await until(async () => (await whereIs()) === visible(folderName), 'panel now in the target folder');
      // 3. Save (the default button), verified by the panel closing.
      r = await oa(l, id, FIXTURE, { ...P, query: 'Save', max_elements: 50 }, (o) => ({ action: 'click', element_token: o.elements.find((e: any) => e.role === 'AXButton' && e.label === 'Save').element_token,
        expect: [{ window: { exists: false } }] }), `commit-${run}`);
      assert.equal(r.verdict, 'COMMITTED', `save: ${r.reason}`);
      await until(async () => existsSync(target), `saved file at ${target}`);
      assert.equal(realpathSync(target), join(realpathSync(dir), `${base}.txt`));
      assert.equal(readFileSync(target, 'utf8'), body, 'exact bytes');
      assert.equal(fileSha(decoy), decoySha, 'decoy untouched');
      const status = (await observe(l, id, FIXTURE, `st-${run}`, { ...main, query: 'Saved', max_elements: 20 })).elements.find((e: any) => /Saved:/.test(String(e.value)));
      assert.ok(status && String(status.value).normalize('NFC').endsWith(`${base}.txt`.normalize('NFC')), `app reports ${status?.value}`);
      return { run, target, bytes: Buffer.byteLength(body), decoy_unchanged: true };
    });
  } finally { await quitFixture(); l.cleanup(); for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true }); }
});

test('T-MAC-06: off-screen list item found by scrolling and reacquired from a fresh observation; stale coordinates refused (x3)', async (t) => {
  if (unavailable) return t.skip(unavailable);
  if (!existsSync(FIXTURE_APP)) return t.skip('fixture app not built (tests/fixtures/BillyFixture/build.sh)');
  const l = live([FIXTURE]);
  try {
    await waitSocket(l);
    await repeat('T-MAC-06', async (run) => {
      const tag = Math.random().toString(16).slice(2, 6);
      const title = `List ${run}-${tag}`;
      const want = `Item ${String(60 + run * 13).padStart(3, '0')}`;
      const id = l.fx.task(); l.fx.run(id);
      await fixtureApp(l, id, { title, rows: 100 }, `open-${run}`);
      const sel = { window_title_contains: title, max_elements: 400 };
      const visibleRow = (o: any) => o.elements.find((e: any) => e.role === 'AXButton' && e.label === want && e.element_token && e.frame && e.frame.h > 4 && e.frame.y >= 160 && e.frame.y + e.frame.h <= o.window.bounds.height - 40);
      let o = await observe(l, id, FIXTURE, `obs0-${run}`, sel);
      const first = o;
      assert.equal(visibleRow(o), undefined, `${want} starts off-screen`);
      let scrolls = 0;
      while (!visibleRow(o)) {
        assert.ok(scrolls < 40, 'item never came into view');
        // Scroll on a row that is currently visible (an off-screen row is not a valid scroll anchor).
        const shown = o.elements.filter((e: any) => e.role === 'AXButton' && /^Item \d{3}$/.test(e.label) && e.element_token && e.frame && e.frame.y >= 160 && e.frame.y + e.frame.h <= o.window.bounds.height - 40);
        const area = shown.sort((x: any, y: any) => y.frame.y - x.frame.y)[0];
        const r = await act(l, id, { observation_ref: o.observation_ref, action: 'scroll', x: area.frame.x + area.frame.w / 2, y: area.frame.y - 100, direction: 'down', expect: [{ window: { exists: true } }] }, `scroll-${run}-${scrolls}`);
        // Billy yields while the owner uses the Mac: wait for idle, then re-observe (stale geometry is never reused).
        if (ownerYield(r)) { await waitIdle(l); o = await observe(l, id, FIXTURE, `obs-y-${run}-${scrolls}-${Date.now()}`, sel); continue; }
        assert.equal(r.verdict, 'COMMITTED', r.reason);
        scrolls++;
        o = await observe(l, id, FIXTURE, `obs-${run}-${scrolls}`, sel);
      }
      // The pre-scroll observation cannot be reused: one action per observation, and it is consumed/expired.
      const stale = await l.fx.core.broker.submit(l.fx.proposal(id, 'desktop.act', { observation_ref: first.observation_ref, action: 'click', x: 40, y: 200, expect: [{ window: { exists: true } }] }, `stale-${run}`));
      assert.notEqual(stale.verdict, 'COMMITTED', 'stale pre-scroll observation refused');
      const item = visibleRow(o);
      const r = await oa(l, id, FIXTURE, sel, (f) => ({ action: 'click', element_token: visibleRow(f)?.element_token ?? item.element_token, expect: [{ window: { exists: true } }] }), `select-${run}`);
      assert.equal(r.verdict, 'COMMITTED', r.reason);
      const status = await until(async () => { const s2 = await observe(l, id, FIXTURE, `st-${run}-${Date.now()}`, { window_title_contains: title, query: 'Selected', max_elements: 20 }); return s2.elements.find((e: any) => /^Selected: /.test(String(e.value))) ?? null; }, 'selection status');
      assert.equal(status.value, `Selected: ${want}`);
      return { run, item: want, scrolls, stale_refused: stale.verdict };
    });
  } finally { await quitFixture(); l.cleanup(); }
});

const BILLY_APP = join(ROOT, 'artifacts/release/0.1.0/Billy.app');
test('T-UX-05: Billy.app critical controls are labelled, reachable without a pointer and work with no model', async (t) => {
  if (unavailable) return t.skip(unavailable);
  if (!existsSync(BILLY_APP)) return t.skip('packaged Billy.app not built (tools/package.sh)');
  const { spawn, spawnSync } = await import('node:child_process');
  const { apiCall } = await import('../../src/daemon/api.ts');
  const base = realpathSync(mkdtempSync('/tmp/billy-bux-')); const data = join(base, 'd'); const ws = join(base, 'ws'); mkdirSync(ws);
  // A throwaway core for the app (BILLY_DATA_DIR): no provider configured, so nothing here can depend on a model.
  const core = spawn(process.execPath, [join(import.meta.dirname, '..', '..', 'src', 'daemon', 'main.ts'), '--data-dir', data, '--allow-unsafe-location'], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = ''; core.stdout!.on('data', (b) => { out += b; });
  const l = live(['com.billy.app']);
  try {
    const sock = await until(async () => /listening on (\S+)/.exec(out)?.[1] ?? null, 'core start');
    const token = readFileSync(join(data, 'run', 'api.token'), 'utf8').trim();
    const call = (m: string, p: string, b?: unknown) => apiCall(sock, token, m, p, b);
    const scope = { apps: [], file_roots: [ws], browser_profiles: [], domains: [], account_ids: [], tool_classes: ['file'], allowed_effects: ['READ_ONLY', 'IDEMPOTENT_WRITE', 'NON_IDEMPOTENT_EFFECT'],
      secret_references: [], network_destinations: [], foreground: 'never', spend_scopes: [], protected_actions: [], delegation: { allowed: false, max_depth: 0 }, model_egress: [], recipients: [] };
    assert.equal((await call('PUT', '/v1/policy', { scope, expires_at: new Date(Date.now() + 86400000).toISOString() })).status, 200);
    const task = await call('POST', '/v1/tasks', { goal: 'Write the UX fixture note', client_message_id: `ux-${Date.now()}`, plan: { steps: [{ step_key: 'w', tool_id: 'fs.write', arguments: { path: join(ws, 'ux.txt'), content: 'ux', mode: 'create' } }] } });
    assert.equal(task.status, 201, JSON.stringify(task.body));
    spawnSync('/usr/bin/open', ['-n', '--env', `BILLY_DATA_DIR=${data}`, BILLY_APP]);
    await waitSocket(l);
    const id = l.fx.task(); l.fx.run(id);
    const W = 'com.billy.app';
    const main = await until(async () => { try { const o = await observe(l, id, W, `ux-${Date.now()}`, { max_elements: 400 }); return o.elements.some((e: any) => /Core status: Connected/.test(`${e.label} ${e.value}`)) ? o : null; } catch { return null; } }, 'Billy window connected to the core', 60_000)
      .catch(async (e) => { try { const o = await observe(l, id, W, 'ux-dbg', { max_elements: 400 }); console.log('UX els', JSON.stringify(o.window), JSON.stringify(o.elements.map((x: any) => [x.role, x.label, x.value])).slice(0, 2500));
        const ob = l.desktop.observations.get(o.observation_ref) as any; const raw = await l.desktop.transport().call('get_window_state', { pid: ob.pid, window_id: ob.window_id, include_screenshot: false }, 'billy-live'); console.log('UX md', String(raw?.result?.structuredContent?.tree_markdown ?? '').slice(0, 2500)); } catch (e2) { console.log('UX err', (e2 as Error).message); } throw e; });
    // 0. Billy's own window is an ordinary, fully observed app window (no protected authority needed to operate it).
    assert.equal(main.surface.kind, 'app_window', `surface: ${JSON.stringify(main.surface)}`);
    // 1. Every actionable control has an accessible name; the critical ones are present.
    // The system title-bar buttons (close/minimise/zoom, top-left 16 pt squares) are named by macOS, not by Billy.
    const titleBarButton = (e: any) => e.role === 'AXButton' && e.frame && e.frame.y < 30 && e.frame.w <= 20 && e.frame.h <= 20;
    const unlabeled = main.elements.filter((e: any) => e.element_token && /AXButton|AXPopUpButton|AXCheckBox|AXTextField|AXMenuButton/.test(e.role) && !String(e.label).trim() && !titleBarButton(e));
    assert.deepEqual(unlabeled.map((e: any) => e.role), [], 'unlabelled actionable controls');
    assert.ok(main.elements.some((e: any) => e.role === 'AXButton' && e.element_token && /^Stop Billy/.test(e.label)), 'Stop control discoverable by name');
    assert.ok(main.elements.some((e: any) => /Write the UX fixture note, status \w+/.test(`${e.label} ${e.value}`)), 'task listed with goal and spoken status');
    // 2. Stop without a pointer: the Control menu command (also bound to Cmd-Shift-.), invoked through accessibility.
    const r = await oa(l, id, W, { max_elements: 50 }, () => ({ action: 'invoke_menu', menu_path: ['Control', 'Stop Billy (emergency)'], expect: [{ window: { exists: true } }] }), 'ux-stop');
    assert.equal(r.verdict, 'COMMITTED', r.reason);
    await until(async () => (await call('GET', '/v1/status')).body.stop.stopped === true, 'core stop latch set');
    const shown = await until(async () => { const o = await observe(l, id, W, `ux-st-${Date.now()}`, { max_elements: 400 }); return o.elements.some((e: any) => /Core status: Stopped/.test(`${e.label} ${e.value}`)) ? o : null; }, 'app shows Stopped');
    // 3. Clear the stop by AX press on its labelled button (no pointer, no model).
    const clear = shown.elements.find((e: any) => e.role === 'AXButton' && /Clear the emergency stop/.test(e.label));
    assert.ok(clear, 'Clear Stop control present and labelled');
    const c = await act(l, id, { observation_ref: shown.observation_ref, action: 'click', element_token: clear.element_token, expect: [{ window: { exists: true } }] }, 'ux-clear');
    assert.equal(c.verdict, 'COMMITTED', c.reason);
    await until(async () => (await call('GET', '/v1/status')).body.stop.stopped === false, 'core stop latch cleared');
    record('T-UX-05', { labelled_controls: main.elements.filter((e: any) => e.element_token).length, unlabelled: 0, stop_via_menu: 1, clear_via_ax: 1 });
  } finally {
    spawnSync('/usr/bin/pkill', ['-f', `${BILLY_APP}/Contents/MacOS/Billy`]);
    core.kill('SIGTERM'); l.cleanup(); rmSync(base, { recursive: true, force: true });
  }
});

async function closeFinderFixtures(l: Live): Promise<number> {
  const F = 'com.apple.finder'; const id = l.fx.task(); l.fx.run(id); let n = 0;
  for (let k = 0; k < 30; k++) {
    const r = await l.fx.core.broker.submit(l.fx.proposal(id, 'desktop.observe', { bundle_id: F, list_windows: true, max_elements: 10 }, `fc-${k}-${Date.now()}`));
    const w = ((r.receipt as any)?.windows ?? []).find((x: any) => /^billy-(src|dst)-\d+-[0-9a-f]{4}$/.test(String(x.title)));
    if (!w) return n;
    const c = await oa(l, id, F, { window_id: w.window_id, max_elements: 10 }, () => ({ action: 'invoke_menu', menu_path: ['File', 'Close Window'], expect: [{ window: { exists: false } }] }), `fclose-${k}`);
    console.log('FINDER close', w.title, c.verdict, c.reason ?? ''); n++;
  }
  return n;
}

test('LIVE-CLEANUP-FINDER: close leftover fixture Finder windows', { skip: !process.env.BILLY_CLEANUP }, async () => {
  const l = live(['com.apple.finder']);
  try { await waitSocket(l); console.log('FINDER closed', await closeFinderFixtures(l)); } finally { l.cleanup(); }
});

test('T-MAC-03: Finder copies the selected fixture item to the intended folder without clobbering (x3)', async (t) => {
  if (unavailable) return t.skip(unavailable);
  const F = 'com.apple.finder';
  // A shallow parent keeps Finder's column view small (the default temp dir holds thousands of entries); it is the granted root.
  const shallow = realpathSync(mkdtempSync('/private/tmp/bnl-')); cleanupDirs.push(shallow);
  // Finder's column view is a file browser (a file-panel surface): copying files through it needs file_panel_input.
  const l = live([F], { file_roots: [shallow], protected_actions: ['file_panel_input'] });
  try {
    await waitSocket(l);
    await repeat('T-MAC-03', async (run) => {
      const tag = Math.random().toString(16).slice(2, 6);
      // Uniquely named folders: Billy only ever addresses Finder windows titled with these names.
      const src = join(shallow, `billy-src-${run}-${tag}`); const dst = join(shallow, `billy-dst-${run}-${tag}`); mkdirSync(src); mkdirSync(dst);
      const pick = `تقرير-${run}-${tag}.txt`; writeFileSync(join(src, pick), `pick ${tag}`);
      writeFileSync(join(src, `other-${tag}.txt`), 'other'); writeFileSync(join(dst, `other-${tag}.txt`), 'dst keeps this');
      const keep = fileSha(join(dst, `other-${tag}.txt`));
      const id = l.fx.task(); l.fx.run(id);
      await launch(l, id, F, [src], `open-src-${run}`);
      const sSel = { window_title_contains: `billy-src-${run}-${tag}`, max_elements: 200 };
      const item = (o: any) => o.elements.find((e: any) => e.element_token && e.role === 'AXTextField' && visibleText(e.label || e.value) === visibleText(pick));
      // Finder opens fixture windows in column view, where the item's column can lie outside the window; show this
      // (temporary, fixture-only) folder as a list instead. Finder keeps that view setting per folder.
      await until(async () => { try { await observe(l, id, F, `w-${run}-${Date.now()}`, sSel); return true; } catch { return false; } }, 'source window', 60_000);
      let vr = await oa(l, id, F, sSel, () => ({ action: 'invoke_menu', menu_path: ['View', 'as List'], expect: [{ window: { exists: true } }] }), `list-${run}`);
      assert.equal(vr.verdict, 'COMMITTED', `as List: ${vr.reason}`);
      const so = await until(async () => { try { const o = await observe(l, id, F, `src-${run}-${Date.now()}`, { ...sSel, query: `-${run}-${tag}` }); return item(o) ? o : null; } catch { return null; } }, 'source window with the fixture item', 60_000)
        .catch(async (e) => {
          const w = await l.fx.core.broker.submit(l.fx.proposal(id, 'desktop.observe', { bundle_id: F, list_windows: true, max_elements: 10 }, `fw-${run}`));
          console.log('FINDER wins', w.verdict, w.reason ?? '', JSON.stringify((w.receipt as any)?.windows?.map((x: any) => x.title)));
          try { const o = await observe(l, id, F, `fd-${run}`, { ...sSel, query: tag }); console.log('FINDER els', JSON.stringify(o.elements.map((x: any) => [x.role, x.label, x.value, !!x.element_token])).slice(0, 1500)); } catch (e2) { console.log('FINDER obs err', (e2 as Error).message.slice(0, 300)); }
          throw e; });
      console.log('FINDER item', JSON.stringify(item(so)));
      let r = await act(l, id, { observation_ref: so.observation_ref, action: 'click', element_token: item(so).element_token, expect: [{ window: { exists: true } }] }, `select-${run}`);
      assert.equal(r.verdict, 'COMMITTED', `select: ${r.reason}`);
      // The Copy item names the selection exactly as Finder labels it (incl. bidi marks). invoke_menu matches the live
      // title exactly and fails closed otherwise, so a wrong selection can never copy something else.
      const raw = String(item(so).label); const vis = visibleText(pick);
      const variants = [...new Set([`Copy “${raw}”`, `Copy “${vis}”`, `Copy “\u2068${vis}\u2069”`, `Copy “\u200E\u2068${vis}\u2069”`, `Copy “${raw.replace(/^\u200E/, '')}”`, 'Copy'])];
      for (const title of variants) {
        r = await oa(l, id, F, sSel, () => ({ action: 'invoke_menu', menu_path: ['Edit', title], expect: [{ window: { exists: true } }] }), `copy-${run}-${variants.indexOf(title)}`);
        console.log('FINDER copy', JSON.stringify(title), r.verdict, (r.reason ?? '').slice(0, 120));
        if (r.verdict === 'COMMITTED') break;
      }
      assert.equal(r.verdict, 'COMMITTED', `copy: ${r.reason}`);
      await launch(l, id, F, [dst], `open-dst-${run}`);
      const dSel = { window_title_contains: `billy-dst-${run}-${tag}`, max_elements: 200 };
      await until(async () => { try { await observe(l, id, F, `dst-${run}-${Date.now()}`, dSel); return true; } catch { return false; } }, 'destination window', 60_000);
      vr = await oa(l, id, F, dSel, () => ({ action: 'invoke_menu', menu_path: ['View', 'as List'], expect: [{ window: { exists: true } }] }), `list-d-${run}`);
      assert.equal(vr.verdict, 'COMMITTED', `as List (dst): ${vr.reason}`);
      r = await oa(l, id, F, dSel, () => ({ action: 'invoke_menu', menu_path: ['Edit', 'Paste Item'], expect: [{ window: { exists: true } }] }), `paste-${run}`);
      assert.equal(r.verdict, 'COMMITTED', `paste: ${r.reason}`);
      await until(async () => existsSync(join(dst, pick)), 'copied item at the destination');
      assert.equal(readFileSync(join(dst, pick), 'utf8'), `pick ${tag}`);
      assert.equal(readFileSync(join(src, pick), 'utf8'), `pick ${tag}`, 'source intact (copy, not move)');
      assert.equal(fileSha(join(dst, `other-${tag}.txt`)), keep, 'no clobber of the existing destination file');
      for (const sel of [dSel, sSel]) await oa(l, id, F, sel, () => ({ action: 'invoke_menu', menu_path: ['File', 'Close Window'], expect: [{ window: { exists: false } }] }), `close-${run}-${sel.window_title_contains}`);
      return { run, item: pick, destination: dst };
    });
  } finally {
    // Never leave fixture windows in the owner's Finder: close every window titled with our fixture prefix.
    try { await closeFinderFixtures(l); } catch (e) { console.log('FINDER cleanup', (e as Error).message); }
    l.cleanup(); for (const d of cleanupDirs.splice(0)) rmSync(d, { recursive: true, force: true });
  }
});

/**
 * Close fixture windows left by aborted runs, through Billy (owner-idle gated): cancel an attached
 * save panel by pixel, close the document, and discard it. Only windows whose titles match fixture names.
 */
const FIXTURE_TITLE = /^(Untitled \()?(seed-\d+-[0-9a-f]{4}( copy)?|geo-\d+|note-\d+|gen)(\.txt)?\)?$/;
async function closeFixtureWindows(l: Live, id: string): Promise<number> {
  const T = 'com.apple.TextEdit';
  let closed = 0;
  for (let pass = 0; pass < 40; pass++) {
    const r = await l.fx.core.broker.submit(l.fx.proposal(id, 'desktop.observe', { bundle_id: T, list_windows: true, max_elements: 10 }, `cl-list-${pass}-${Date.now()}`));
    const wins = ((r.receipt as any)?.windows ?? []).filter((w: any) => FIXTURE_TITLE.test(String(w.title ?? '')));
    if (!wins.length) return closed;
    const w = wins[0];
    const sel = { window_id: w.window_id };
    // 1. Cancel an attached save panel (pixel on the panel window; geometry from the host AX tree).
    const pr = await l.fx.core.broker.submit(l.fx.proposal(id, 'desktop.observe', { bundle_id: T, ...sel, attached_panel: true, query: 'Cancel', max_depth: 6 }, `cl-p-${pass}-${Date.now()}`));
    const cancel = pr.verdict === 'COMMITTED' ? (pr.receipt as any).elements.find((e: any) => e.role === 'AXButton' && /cancel/i.test(e.label)) : null;
    if (cancel) {
      const c = await act(l, id, { observation_ref: (pr.receipt as any).observation_ref, action: 'click', x: cancel.frame.x + cancel.frame.w / 2, y: cancel.frame.y + cancel.frame.h / 2, needs_foreground: true, expect: [{ window: { exists: false } }] }, `cl-cancel-${pass}`);
      console.log('CLEANUP cancel', w.title, c.verdict, c.reason ?? '');
      await new Promise((res) => setTimeout(res, 800));
    }
    // 2. Close the document window.
    const c2 = await oa(l, id, T, { ...sel, max_depth: 2 }, () => ({ action: 'invoke_menu', menu_path: ['File', 'Close'], expect: [{ window: { exists: true } }] }), `cl-close-${pass}`);
    console.log('CLEANUP close', w.title, c2.verdict, c2.reason ?? '');
    await new Promise((res) => setTimeout(res, 800));
    // 3. Discard if TextEdit asks to keep/save the document.
    const o = await l.fx.core.broker.submit(l.fx.proposal(id, 'desktop.observe', { bundle_id: T, ...sel, max_depth: 6, max_elements: 60 }, `cl-ask-${pass}-${Date.now()}`));
    if (o.verdict === 'COMMITTED') {
      const els = (o.receipt as any).elements;
      console.log('CLEANUP ask', JSON.stringify(els.filter((e: any) => e.role === 'AXButton' && e.label).map((e: any) => e.label)));
      const del = els.find((e: any) => e.role === 'AXButton' && /^(Delete|Don.t Save)$/i.test(e.label));
      if (del) {
        const d1 = await act(l, id, { observation_ref: (o.receipt as any).observation_ref, action: 'click', element_token: del.element_token, expect: [{ window: { exists: false } }] }, `cl-del-${pass}`);
        console.log('CLEANUP delete', d1.verdict, d1.reason ?? '');
      }
    }
    closed++;
  }
  return closed;
}

test('LIVE-CLEANUP: close leftover fixture windows', { skip: !process.env.BILLY_CLEANUP }, async () => {
  const l = live(['com.apple.TextEdit', PANEL_SERVICE_BUNDLE]);
  try { await waitSocket(l); const id = l.fx.task(); l.fx.run(id); console.log('CLEANUP closed', await closeFixtureWindows(l, id)); }
  finally { l.cleanup(); }
});

test('PROBE windows', { skip: !process.env.BILLY_PROBE }, async () => {
  const l = live([FIXTURE], { protected_actions: ['file_panel_input'] });
  try {
    await waitSocket(l);
    const id = l.fx.task(); l.fx.run(id);
    await fixtureApp(l, id, { title: 'probe', 'save-dir': l.fx.root }, 'probe-launch');
    await oa(l, id, FIXTURE, { window_title_contains: 'probe' }, () => ({ action: 'invoke_menu', menu_path: ['File', 'Save Report…'], expect: [{ window: { exists: true } }] }), 'probe-save');
    await new Promise((r) => setTimeout(r, 2000));
    const o = await observe(l, id, FIXTURE, 'probe-panel', { window_title_contains: 'Save Report', max_elements: 60 });
    const ob = l.desktop.observations.get(o.observation_ref) as any;
    const sc = (await l.desktop.transport().call('get_window_state', { pid: ob.pid, window_id: ob.window_id, include_screenshot: false, max_elements: 300 }, 'billy-live'))?.result?.structuredContent ?? {};
    console.log('PROBE md', String(sc.tree_markdown ?? '').split('\n').filter((x: string) => /id=|AXWindow|subrole/.test(x)).slice(0, 40).join('\n'));
    console.log('PROBE keys', JSON.stringify(Object.keys((sc.elements ?? [])[0] ?? {})), JSON.stringify((sc.elements ?? []).slice(0, 3)));
  } finally { await quitFixture(); l.cleanup(); }
});
