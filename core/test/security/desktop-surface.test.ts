// A-02/A-03 adversarial regression suite: desktop input is authorized against the
// SURFACE it reaches, for every input method, and stale or changed targets never get
// input. Fake NDJSON driver (this is the SECURITY lane, not NATIVE_LIVE).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:net';
import { join } from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { fixture } from '../fixtures.ts';
import { DESKTOP_TOOLS, PANEL_SERVICE_BUNDLE, type DesktopServices } from '../../src/tools/desktop.ts';
import { SocketTransport } from '../../src/desktop/cua.ts';
import { DesktopArbiter } from '../../src/desktop/session.ts';

const sockDir = mkdtempSync('/tmp/billy-bsurf-');
after(() => rmSync(sockDir, { recursive: true, force: true }));

const HOST = 4242, PANEL = 5151, APP = 'com.apple.TextEdit';
const INPUT_TOOLS = new Set(['click', 'double_click', 'type_text', 'set_value', 'press_key', 'hotkey', 'scroll', 'invoke_menu']);
interface Win { bounds: { x: number; y: number; width: number; height: number }; elements: any[]; markdown?: string; screenshot_width?: number; truncated?: boolean; omitCompleteness?: boolean }

/** Mutable desktop: tests change it between observation and dispatch. */
function world() {
  const host: Win = { bounds: { x: 100, y: 100, width: 600, height: 400 },
    elements: [{ element_token: 's:0', role: 'AXTextArea', label: 'body', value: '', frame: { x: 110, y: 140, w: 500, h: 300 } }] };
  return { host, panels: [] as { window_id: number; bounds: Win['bounds'] }[], walks: 0, sheetAfterWalk: 0, others: [] as (Win & { window_id: number })[] };
}
const SHEET = { x: 120, y: 132, w: 560, h: 300 };
const sheetEl = { element_token: 's:9', role: 'AXSheet', label: 'save', value: '', frame: SHEET };
const panelAt = (dx = 0) => ({ window_id: 901, bounds: { x: SHEET.x + dx, y: SHEET.y, width: SHEET.w, height: SHEET.h } });

function fakeDriver(path: string, w: ReturnType<typeof world>) {
  const inputs: { name: string; args: any }[] = [];
  let snapshot = 0; // like the real driver: every get_window_state of the host replaces the token map
  const srv: Server = createServer((s) => {
    let buf = '';
    s.on('data', (chunk) => {
      buf += chunk; const nl = buf.indexOf('\n'); if (nl < 0) return;
      const req = JSON.parse(buf.slice(0, nl)); buf = '';
      const ok = (sc: any) => s.end(JSON.stringify({ ok: true, result: { content: [], structuredContent: sc } }) + '\n');
      const a = req.args;
      if (INPUT_TOOLS.has(req.name)) {
        if (a.element_token && !String(a.element_token).startsWith(`s${snapshot}:`)) return ok({ status: 'refused', refusal: { code: 'stale_element_token' } });
        inputs.push({ name: req.name, args: a }); return ok({ effect: 'performed' });
      }
      switch (req.name) {
        case 'launch_app': return ok({ pid: HOST });
        case 'list_windows':
          if (a.pid === PANEL) return ok({ windows: w.panels.map((p) => ({ ...p, pid: PANEL, title: 'Save' })) });
          return ok({ windows: [{ window_id: 77, pid: HOST, title: 'Report.txt', bounds: w.host.bounds, is_on_screen: true },
            ...w.others.map((o) => ({ window_id: o.window_id, pid: HOST, title: `Other ${o.window_id}`, bounds: o.bounds, is_on_screen: true }))] });
        case 'get_window_state': {
          if (a.pid === PANEL) return ok({ elements: [], tree_markdown: '', window_bounds: w.panels[0]?.bounds, screenshot_width: w.panels[0]?.bounds.width });
          const other = w.others.find((o) => o.window_id === Number(a.window_id));
          if (other) return ok({ snapshot_id: 'other', elements: other.elements, elements_complete: !other.truncated, tree_markdown: other.elements.map((e: any) => `- ${e.role} (${e.label})`).join('\n'), window_bounds: other.bounds });
          snapshot++; w.walks++;
          // Race injection: a sheet attaches after the Nth walk of the host (e.g. between two reads of one observation).
          if (w.sheetAfterWalk && w.walks > w.sheetAfterWalk && !w.host.elements.some((e: any) => e.role === 'AXSheet')) w.host.elements = [...w.host.elements, { ...sheetEl, sheet_field: true }];
          const elements = w.host.elements.map((e: any, i: number) => ({ ...e, element_token: `s${snapshot}:${i}` }));
          const sc: any = { snapshot_id: `s${snapshot}`, elements, ...(w.host.omitCompleteness ? {} : { elements_complete: !w.host.truncated }), tree_markdown: w.host.markdown ?? w.host.elements.map((e: any) => `- ${e.role} (${e.label})`).join('\n') };
          if (a.include_screenshot) { sc.window_bounds = w.host.bounds; sc.screenshot_width = w.host.screenshot_width ?? w.host.bounds.width; }
          return ok(sc);
        }
        case 'verify_state': return ok({ status: 'satisfied' });
        default: return s.end(JSON.stringify({ ok: false, error: `unknown tool ${req.name}` }) + '\n');
      }
    });
  }).listen(path);
  return { inputs, close: () => srv.close() };
}

let n = 0;
function rig(grantOver: Record<string, unknown> = {}) {
  const w = world();
  const sock = join(sockDir, `s${n++}.sock`);
  const driver = fakeDriver(sock, w);
  const arbiter = new DesktopArbiter({ read: () => ({ idle_ms: 60_000, locked: false, frontmost_bundle: APP, at: Date.now() }) });
  const desktop: DesktopServices = { transport: () => new SocketTransport(sock), generation: () => 1, arbiter, foreground: () => 'allowed',
    observations: new Map(), sessionId: 't', panelServicePids: () => [PANEL] };
  const fx = fixture({ extraTools: DESKTOP_TOOLS, services: { desktop } }, { tool_classes: ['desktop', 'app'], apps: [APP, PANEL_SERVICE_BUNDLE], foreground: 'allowed', ...grantOver });
  const id = fx.task(); fx.run(id);
  let step = 0;
  const observe = async (extra: object = {}) => {
    const r = await fx.core.broker.submit(fx.proposal(id, 'desktop.observe', { bundle_id: APP, ...extra }, `o${step++}`));
    return r;
  };
  const act = (ref: string, args: object) => fx.core.broker.submit(fx.proposal(id, 'desktop.act', { observation_ref: ref, expect: [{ window: { exists: true } }], ...args }, `a${step++}`));
  return { w, driver, fx, observe, act, cleanup: () => { driver.close(); fx.cleanup(); } };
}

/** Every input method, addressed every way it can be. */
const tok = (rc: any) => rc.elements.find((e: any) => e.role === 'AXTextArea')?.element_token;
const METHODS: Record<string, (rc: any) => object> = {
  'click/token': (rc) => ({ action: 'click', element_token: tok(rc) }),
  'click/pixel': () => ({ action: 'click', x: 200, y: 150 }),
  'double_click/token': (rc) => ({ action: 'double_click', element_token: tok(rc) }),
  'double_click/pixel': () => ({ action: 'double_click', x: 200, y: 150 }),
  'type_text/token': (rc) => ({ action: 'type_text', element_token: tok(rc), text: '/etc/x' }),
  'type_text/pixel': () => ({ action: 'type_text', x: 200, y: 150, text: '/etc/x' }),
  'type_text/focused': () => ({ action: 'type_text', focused: true, text: '/etc/x' }),
  'set_value/token': (rc) => ({ action: 'set_value', element_token: tok(rc), text: '/etc/x' }),
  'press_key': () => ({ action: 'press_key', key: 'return' }),
  'hotkey': () => ({ action: 'hotkey', keys: ['cmd', 'shift', 'g'] }),
  'scroll/token': (rc) => ({ action: 'scroll', element_token: tok(rc), direction: 'down' }),
  'scroll/pixel': () => ({ action: 'scroll', x: 200, y: 150, direction: 'down' }),
  'invoke_menu': () => ({ action: 'invoke_menu', menu_path: ['File', 'Save…'] }),
};

test('A-02: with a sheet attached, EVERY input method needs file_panel_input authority; none reaches the driver without it', async () => {
  for (const [name, args] of Object.entries(METHODS)) {
    const r = rig();
    try {
      r.w.host.elements = [...r.w.host.elements, sheetEl];
      const o = await r.observe();
      assert.equal(o.verdict, 'COMMITTED');
      assert.equal((o.receipt as any).surface.kind, 'file_panel', name);
      const res = await r.act((o.receipt as any).observation_ref, args(o.receipt));
      assert.equal(res.verdict, 'DENIED', `${name}: ${res.verdict} ${res.reason}`);
      assert.match(res.reason, /file_panel_input/);
      assert.equal(r.driver.inputs.length, 0, `${name}: no input delivered`);
    } finally { r.cleanup(); }
  }
});

test('A-02: the same inputs are allowed once the owner grants file_panel_input (control)', async () => {
  for (const [name, args] of Object.entries(METHODS)) {
    const r = rig({ protected_actions: ['file_panel_input'] });
    try {
      r.w.host.elements = [...r.w.host.elements, sheetEl];
      const o = await r.observe();
      const res = await r.act((o.receipt as any).observation_ref, args(o.receipt));
      assert.equal(res.verdict, 'COMMITTED', `${name}: ${res.reason}`);
      assert.equal(r.driver.inputs.length, 1, name);
    } finally { r.cleanup(); }
  }
});

test('A-02: an in-process or standalone file dialog (any standard structure, any view mode) is a file-panel surface too', async () => {
  const dialogs: object[][] = [
    [{ role: 'AXPopUpButton', label: 'Where:', value: 'Documents' }],                 // save panel location chooser
    [{ role: 'AXBrowser', label: 'column view', value: '' }],                          // column view
    [{ role: 'AXOutline', label: 'sidebar', value: '' }],                              // list/icon view still has the sidebar
    [{ role: 'AXButton', label: 'Cancel', value: '' }, { role: 'AXButton', label: 'Open', value: '' }],   // standalone Open panel, any view
    [{ role: 'AXButton', label: 'Cancel', value: '' }, { role: 'AXButton', label: 'Choose', value: '' }],
  ];
  for (const markers of dialogs) {
    const r = rig();
    try {
      r.w.host.elements = [...r.w.host.elements, ...markers.map((m, i) => ({ ...m, frame: { x: 200, y: 200 + i * 30, w: 100, h: 20 } }))];
      const o = await r.observe();
      assert.equal((o.receipt as any).surface.kind, 'file_panel', JSON.stringify(markers));
      const res = await r.act((o.receipt as any).observation_ref, { action: 'click', x: 150, y: 120 });
      assert.equal(res.verdict, 'DENIED', JSON.stringify(markers));
      assert.equal(r.driver.inputs.length, 0);
    } finally { r.cleanup(); }
  }
});

test('a walk cut short after leaving the window (menu bar, status item) still classifies the window', async () => {
  const r = rig();
  try {
    r.w.host.truncated = true;
    r.w.host.elements = [{ role: 'AXWindow', label: 'Report.txt', value: '' }, ...r.w.host.elements.map((e) => ({ ...e, parent_index: 0 }))];
    const n = r.w.host.elements.length;
    r.w.host.elements.push({ role: 'AXMenuBar', label: '', value: '' }, { role: 'AXMenuBarItem', label: 'Help', value: '', parent_index: n },
      { role: 'AXTextField', label: 'Search', value: '', parent_index: n + 1 }, { role: 'AXMenuBarItem', label: 'status item', value: '' });
    const o = await r.observe();
    assert.equal((o.receipt as any).surface.kind, 'app_window');
  } finally { r.cleanup(); }
});

test('fail closed: window rows after the walk left the window (not a contiguous prefix) are not trusted', async () => {
  const r = rig();
  try {
    r.w.host.truncated = true;
    r.w.host.elements = [{ role: 'AXWindow', label: 'Report.txt', value: '' }, { role: 'AXMenuBar', label: '', value: '' },
      ...r.w.host.elements.map((e) => ({ ...e, parent_index: 0 }))];
    const o = await r.observe();
    assert.equal((o.receipt as any).surface.kind, 'unverified');
  } finally { r.cleanup(); }
});

test('A-18 localization: a file panel in another language is recognised by AppKit identifiers, not English titles', async () => {
  const r = rig();
  try {
    // A German Open panel: no English label anywhere (Abbrechen/Öffnen/Seitenleiste), identifiers as AppKit sets them.
    r.w.host.elements = [...r.w.host.elements, { role: 'AXButton', label: 'Abbrechen', value: '' }, { role: 'AXButton', label: 'Öffnen', value: '' }, { role: 'AXOutline', label: 'Seitenleiste', value: '' }];
    r.w.host.markdown = '- [0] AXWindow "Öffnen" [id=open-panel]\n  - [1] AXButton "Abbrechen" [id=CancelButton]\n  - [2] AXButton "Öffnen" [id=OKButton]\n  - [3] AXDisclosureTriangle [id=NS_OPEN_SAVE_DISCLOSURE_TRIANGLE]';
    const o = await r.observe();
    assert.equal((o.receipt as any).surface.kind, 'file_panel');
    assert.ok((o.receipt as any).surface.reasons.includes('AppKit file-panel identifiers'));
    assert.equal((await r.act((o.receipt as any).observation_ref, { action: 'click', x: 150, y: 120 })).verdict, 'DENIED');
  } finally { r.cleanup(); }
});

test('fail closed: a walk whose completeness the driver does not report, and that never leaves the window, is not trusted', async () => {
  const r = rig();
  try {
    r.w.host.omitCompleteness = true;
    const o = await r.observe();
    assert.equal((o.receipt as any).surface.kind, 'unverified');
  } finally { r.cleanup(); }
});

test('fail closed: a walk truncated inside the window cannot be classified as an ordinary window', async () => {
  const r = rig();
  try {
    r.w.host.truncated = true;
    const o = await r.observe();
    assert.equal((o.receipt as any).surface.kind, 'unverified');
    const res = await r.act((o.receipt as any).observation_ref, { action: 'click', x: 50, y: 50 });
    assert.equal(res.verdict, 'DENIED');
    assert.match(res.reason, /unverified_surface_input/);
    assert.equal(r.driver.inputs.length, 0);
  } finally { r.cleanup(); }
});

test('fail closed: a window with no accessibility surface needs unverified_surface_input for pixel input', async () => {
  const r = rig();
  try {
    r.w.host.elements = []; r.w.host.markdown = '';
    const o = await r.observe();
    assert.equal((o.receipt as any).surface.kind, 'unverified');
    const res = await r.act((o.receipt as any).observation_ref, { action: 'click', x: 50, y: 50 });
    assert.equal(res.verdict, 'DENIED');
    assert.match(res.reason, /unverified_surface_input/);
    assert.equal(r.driver.inputs.length, 0);
  } finally { r.cleanup(); }
});

test('target transition: a sheet that appears after observation never receives input (token-free inputs refused; token inputs stay bound to the observed element)', async () => {
  for (const [name, args] of Object.entries(METHODS)) {
    const r = rig();
    try {
      const o = await r.observe();
      assert.equal((o.receipt as any).surface.kind, 'app_window');
      const observedToken = tok(o.receipt);
      r.w.host.elements = [...r.w.host.elements, sheetEl]; // e.g. a Save panel opened in between
      const a = args(o.receipt) as any;
      const res = await r.act((o.receipt as any).observation_ref, a);
      if (a.element_token) {
        // The driver binds the token to the observed element; no element of the new sheet can be named.
        assert.equal(res.verdict, 'COMMITTED', `${name}: ${res.reason}`);
        assert.equal(r.driver.inputs.length, 1, name);
        assert.equal(r.driver.inputs[0].args.element_token, observedToken, `${name}: only the observed element is addressed`);
        assert.equal(r.driver.inputs[0].args.window_id, 77, `${name}: delivered to the observed window`);
      } else {
        assert.notEqual(res.verdict, 'COMMITTED', name);
        assert.equal(r.driver.inputs.length, 0, `${name}: no input after the surface changed`);
      }
    } finally { r.cleanup(); }
  }
});

test('A-02 race: an observation classifies and issues tokens from ONE walk, so a sheet attaching mid-observation can never receive token input', async () => {
  const sheetField = { role: 'AXTextField', label: 'Save As:', value: 'report.txt', frame: { x: 200, y: 160, w: 200, h: 22 } };
  for (const after of [0, 1]) {
    const r = rig();
    try {
      r.w.sheetAfterWalk = after + 1; // the sheet (with a name field) appears right after the first host walk
      const walksBefore = r.w.walks;
      const o = await r.observe();
      assert.equal(r.w.walks - walksBefore, 1, 'one AX walk per observation');
      const rc = o.receipt as any;
      r.w.host.elements.push(sheetField);
      const fieldToken = rc.elements.find((e: any) => e.role === 'AXTextField')?.element_token;
      if (fieldToken) {
        // A token from the walk can only exist if that same walk saw the sheet, and then the surface is a file panel.
        assert.equal(rc.surface.kind, 'file_panel');
        const res = await r.act(rc.observation_ref, { action: 'set_value', element_token: fieldToken, text: '/etc/evil' });
        assert.equal(res.verdict, 'DENIED');
      }
      assert.ok(!r.driver.inputs.some((x) => x.name === 'set_value'), 'no path typed into a sheet without file_panel_input');
    } finally { r.cleanup(); }
  }
});

test('keys are never token-addressed (they travel through whatever is focused)', async () => {
  const r = rig();
  try {
    const o = await r.observe();
    for (const a of [{ action: 'press_key', key: 'return' }, { action: 'hotkey', keys: ['cmd', 'v'] }]) {
      const res = await r.act((o.receipt as any).observation_ref, { ...a, element_token: tok(o.receipt) });
      assert.notEqual(res.verdict, 'COMMITTED'); assert.match(res.reason, /take no element_token/);
    }
    assert.equal(r.driver.inputs.length, 0);
  } finally { r.cleanup(); }
});

test('a token input is delivered with the observation token intact (no pre-dispatch re-snapshot invalidates it)', async () => {
  const r = rig();
  try {
    const o = await r.observe();
    const res = await r.act((o.receipt as any).observation_ref, { action: 'click', element_token: tok(o.receipt) });
    assert.equal(res.verdict, 'COMMITTED', res.reason);
  } finally { r.cleanup(); }
});

test('stale geometry and coordinate translation: moved windows refuse pixel input; downscaled screenshots get scaled, in-bounds coordinates', async () => {
  const r = rig();
  try {
    const o1 = await r.observe();
    r.w.host.bounds = { ...r.w.host.bounds, x: 300 }; // moved after observation
    assert.notEqual((await r.act((o1.receipt as any).observation_ref, { action: 'click', x: 200, y: 150 })).verdict, 'COMMITTED');
    assert.equal(r.driver.inputs.length, 0);
    r.w.host.bounds = { x: 0, y: 0, width: 1700, height: 500 }; r.w.host.screenshot_width = 1568;
    const o2 = await r.observe();
    assert.equal((await r.act((o2.receipt as any).observation_ref, { action: 'click', x: 1700, y: 500 })).verdict, 'COMMITTED');
    const sent = r.driver.inputs[0].args;
    assert.ok(Math.abs(sent.x - 1568) < 0.01 && Math.abs(sent.y - 500 * 1568 / 1700) < 0.01, JSON.stringify(sent));
    const o3 = await r.observe();
    assert.notEqual((await r.act((o3.receipt as any).observation_ref, { action: 'click', x: 1701, y: 10 })).verdict, 'COMMITTED', 'outside the window');
  } finally { r.cleanup(); }
});

test('A-03: attached-panel ownership needs one host sheet AND exactly one panel-service window with the same frame; acting on it needs both grants', async () => {
  const r = rig();
  try {
    // No sheet on the host: no panel, whatever windows the service has.
    r.w.panels = [panelAt()];
    assert.notEqual((await r.observe({ attached_panel: true })).verdict, 'COMMITTED');
    // Sheet present but the only panel window is elsewhere (another app's panel): refused.
    r.w.host.elements = [...r.w.host.elements, sheetEl]; r.w.panels = [panelAt(400)];
    assert.notEqual((await r.observe({ attached_panel: true })).verdict, 'COMMITTED');
    // Two identical candidates: ambiguous, refused.
    r.w.panels = [panelAt(), { ...panelAt(), window_id: 902 }];
    assert.notEqual((await r.observe({ attached_panel: true })).verdict, 'COMMITTED');
    // Exactly one matching window: observed as the panel service, tokens withheld.
    r.w.panels = [panelAt()];
    const o = await r.observe({ attached_panel: true });
    assert.equal(o.verdict, 'COMMITTED', o.reason);
    assert.equal((o.receipt as any).surface.kind, 'file_panel');
    assert.ok((o.receipt as any).elements.every((e: any) => !e.element_token));
    const res = await r.act((o.receipt as any).observation_ref, { action: 'click', x: 10, y: 10 });
    assert.equal(res.verdict, 'DENIED');
    assert.equal(r.driver.inputs.length, 0);
  } finally { r.cleanup(); }
});

test('A-03: panel input re-establishes the host sheet and panel window; a closed or moved sheet refuses input', async () => {
  const r = rig({ protected_actions: ['file_panel_input'] });
  try {
    r.w.host.elements = [...r.w.host.elements, sheetEl]; r.w.panels = [panelAt()];
    const o1 = await r.observe({ attached_panel: true });
    r.w.host.elements = r.w.host.elements.filter((e) => e.role !== 'AXSheet'); // sheet closed
    assert.notEqual((await r.act((o1.receipt as any).observation_ref, { action: 'click', x: 10, y: 10 })).verdict, 'COMMITTED');
    r.w.host.elements = [...r.w.host.elements, sheetEl];
    const o2 = await r.observe({ attached_panel: true });
    r.w.panels = [panelAt(30)]; // panel window replaced/moved
    assert.notEqual((await r.act((o2.receipt as any).observation_ref, { action: 'click', x: 10, y: 10 })).verdict, 'COMMITTED');
    assert.equal(r.driver.inputs.length, 0);
    r.w.panels = [panelAt()];
    const o3 = await r.observe({ attached_panel: true });
    assert.equal((await r.act((o3.receipt as any).observation_ref, { action: 'click', x: 10, y: 10 })).verdict, 'COMMITTED', 'control');
  } finally { r.cleanup(); }
});

test('A-03: panel input also requires the HOST app grant (no laundering through the panel service)', async () => {
  const r = rig({ protected_actions: ['file_panel_input'] });
  try {
    r.w.host.elements = [...r.w.host.elements, sheetEl]; r.w.panels = [panelAt()];
    const o = await r.observe({ attached_panel: true });
    // The owner narrows the grant to the panel service alone: input must now be refused.
    r.fx.core.policy.putGrant({ ...r.fx.core.policy.current(r.fx.grantId)!, scope: { ...r.fx.core.policy.current(r.fx.grantId)!.scope, apps: [PANEL_SERVICE_BUNDLE] } } as any);
    const res = await r.act((o.receipt as any).observation_ref, { action: 'click', x: 10, y: 10 });
    assert.equal(res.verdict, 'DENIED');
    assert.match(res.reason, /app com\.apple\.TextEdit not granted/);
    assert.equal(r.driver.inputs.length, 0);
  } finally { r.cleanup(); }
});

test('A-02: focus-routed input is refused while ANOTHER window of the same app shows a file panel', async () => {
  const routed = ['type_text/focused', 'press_key', 'hotkey', 'invoke_menu'];
  for (const name of Object.keys(METHODS)) {
    const r = rig();
    try {
      r.w.others = [{ window_id: 78, bounds: { x: 800, y: 100, width: 600, height: 400 }, elements: [{ role: 'AXTextArea', label: 'b', frame: { x: 810, y: 140, w: 10, h: 10 } }, sheetEl] }];
      const o = await r.observe({ window_id: 77 });
      assert.equal(o.verdict, 'COMMITTED', o.reason);
      assert.equal((o.receipt as any).surface.kind, 'app_window');
      const res = await r.act((o.receipt as any).observation_ref, METHODS[name](o.receipt));
      if (routed.includes(name)) {
        assert.notEqual(res.verdict, 'COMMITTED', `${name} must not reach another window's panel`);
        assert.match(String(res.reason), /another window of this app \(78\) is a file_panel surface/, name);
        assert.equal(r.driver.inputs.length, 0, `${name}: no input delivered`);
      } else {
        assert.equal(res.verdict, 'COMMITTED', `${name}: element- or point-addressed input stays in the observed window (${res.reason})`);
      }
    } finally { r.cleanup(); }
  }
});

test('A-02: focus-routed input proceeds when the other windows are ordinary', async () => {
  const r = rig();
  try {
    r.w.others = [{ window_id: 78, bounds: { x: 800, y: 100, width: 600, height: 400 }, elements: [{ role: 'AXTextArea', label: 'b', frame: { x: 810, y: 140, w: 10, h: 10 } }] }];
    const o = await r.observe({ window_id: 77 });
    const res = await r.act((o.receipt as any).observation_ref, { action: 'press_key', key: 'return' });
    assert.equal(res.verdict, 'COMMITTED', res.reason);
    assert.equal(r.driver.inputs.length, 1);
  } finally { r.cleanup(); }
});

test('A-02: every Finder window is a file-panel surface, whatever its view', async () => {
  const { classifySurface } = await import('../../src/desktop/surface.ts');
  const plainList = { bundle_id: 'com.apple.finder', complete: true, markdown: '- AXOutline (list)',
    elements: [{ role: 'AXWindow', parent_index: null }, { role: 'AXOutline', label: 'list view', parent_index: 0 }, { role: 'AXMenuBar', parent_index: null }] };
  assert.equal(classifySurface(plainList).kind, 'file_panel');
  assert.equal(classifySurface({ ...plainList, bundle_id: 'com.apple.TextEdit' }).kind, 'app_window', 'the same structure elsewhere stays ordinary');
});
