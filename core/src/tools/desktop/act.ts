// desktop.act: exactly one input, bound to one observation. Authorization is
// target-aware (A-02): the observation's classified SURFACE decides the protected
// kind the policy engine checks, for every input method alike.
// Transitions: input addressed by element token is bound by the driver to one element of the
// observed snapshot (a stale token is refused, and an element of a surface that appeared later
// cannot be named), so re-probing is neither needed nor allowed: a re-probe would replace the
// driver snapshot and invalidate the token. Every input WITHOUT a token (pixel, focused, menu,
// keys) goes wherever the system routes it, so the surface probe is repeated immediately before
// dispatch; a changed surface or geometry refuses input. Keys are never token-addressed: they
// travel through whatever is focused.
import type { CheckResult, ToolAdapter } from '../../broker/types.ts';
import { TargetError } from '../../broker/types.ts';
import type { Schema } from '../../contracts/schema.ts';
import { protectedKindFor, type Bounds, type SurfaceKind } from '../../desktop/surface.ts';
import { sameRect } from '../../desktop/panels.ts';
import { call, mapErr, OBSERVATION_TTL_MS, probeSurface, svc, toolSpec, windowTarget, type DesktopServices, type Observation, type Predicate } from './common.ts';
import { verifyPredicates } from './verify.ts';

type ActionName = 'click' | 'double_click' | 'type_text' | 'set_value' | 'press_key' | 'hotkey' | 'scroll' | 'invoke_menu';

interface ActArgs {
  observation_ref: string; action: ActionName; element_token?: string; x?: number; y?: number; text?: string; key?: string; keys?: string[];
  direction?: 'up' | 'down' | 'left' | 'right'; menu_path?: string[]; expect: Predicate[]; needs_foreground?: boolean; focused?: boolean;
}

const nullableBool: Schema = { anyOf: [{ type: 'boolean' }, { type: 'null' }] };
/** Mirrors the pinned driver's verify_state predicate schema (strict). */
const PREDICATE: Schema = {
  type: 'object', additionalProperties: false, properties: {
    element: { type: 'object', additionalProperties: false, required: ['selector'], properties: {
      selector: { type: 'object', additionalProperties: false, properties: { role: { type: 'string', minLength: 1, maxLength: 64 }, label_contains: { type: 'string', minLength: 1, maxLength: 200 } } },
      value_equals: { anyOf: [{ type: 'string', maxLength: 20000 }, { type: 'null' }] }, exists: { const: true }, enabled: nullableBool, selected: nullableBool } },
    ocr: { type: 'object', additionalProperties: false, required: ['region'], properties: {
      region: { type: 'object', additionalProperties: false, required: ['x1', 'y1', 'x2', 'y2'], properties: { x1: { type: 'number', minimum: 0 }, y1: { type: 'number', minimum: 0 }, x2: { type: 'number', minimum: 1 }, y2: { type: 'number', minimum: 1 } } },
      line_equals: { type: 'string', minLength: 1, maxLength: 200 }, contains: { type: 'string', minLength: 1, maxLength: 200 } } },
    window: { type: 'object', additionalProperties: false, properties: { exists: nullableBool,
      bounds: { type: 'object', additionalProperties: false, required: ['x', 'y', 'width', 'height'], properties: { x: { type: 'number' }, y: { type: 'number' }, width: { type: 'number' }, height: { type: 'number' }, tolerance_px: { type: 'number', minimum: 0, maximum: 100 } } } } },
  },
};

/** What each action is; every rule below reads these traits instead of re-listing action names. */
const ACTION_TRAITS: Record<ActionName, { keys: boolean; focusable: boolean; foreground: boolean; needsToken: boolean; pointer: boolean }> = {
  click: { keys: false, focusable: false, foreground: false, needsToken: false, pointer: true },
  double_click: { keys: false, focusable: false, foreground: false, needsToken: false, pointer: true },
  type_text: { keys: false, focusable: true, foreground: false, needsToken: false, pointer: false },
  set_value: { keys: false, focusable: false, foreground: false, needsToken: true, pointer: false },
  press_key: { keys: true, focusable: true, foreground: true, needsToken: false, pointer: false },
  hotkey: { keys: true, focusable: true, foreground: true, needsToken: false, pointer: false },
  scroll: { keys: false, focusable: false, foreground: false, needsToken: false, pointer: false },
  invoke_menu: { keys: false, focusable: false, foreground: true, needsToken: false, pointer: false },
};
const actionsWith = (trait: 'keys' | 'focusable') => (Object.keys(ACTION_TRAITS) as ActionName[]).filter((n) => ACTION_TRAITS[n][trait]).join(', ');

const isPixel = (a: ActArgs) => !a.element_token && !a.focused && a.x !== undefined;
/** Input not bound to an observed element: routed by the system at delivery time, so the surface is re-verified first. */
const routedAtDelivery = (a: ActArgs) => !a.element_token;
/** Menus, hotkeys and key presses need the app key/frontmost: they are foreground input. */
const needsForeground = (a: ActArgs) => !!a.needs_foreground || ACTION_TRAITS[a.action].foreground;

/** Argument-shape rules; null when the request is well formed. */
function shapeError(a: ActArgs, o: Observation): string | null {
  const t = ACTION_TRAITS[a.action];
  if (a.focused && !t.focusable) return `focused applies only to ${actionsWith('focusable')}`;
  if (t.keys && a.element_token) return `keys travel through the focused element; ${actionsWith('keys')} take no element_token`;
  if (a.focused && (a.element_token || a.x !== undefined)) return 'focused excludes element_token and x,y';
  if (t.needsToken && !a.element_token) return `${a.action} requires element_token`;
  if (a.action === 'type_text' && !a.element_token && !a.focused && a.x === undefined) return 'type_text requires element_token, focused: true, or window-local x,y';
  if (a.x !== undefined || a.y !== undefined) {
    const b = o.bounds;
    if (!b || a.x === undefined || a.y === undefined || a.x > b.width || a.y > b.height) return 'pixel input must lie inside the observed window';
  }
  if (t.pointer && !a.element_token && (a.x === undefined || a.y === undefined)) return `${a.action} requires element_token or window-local x,y`;
  return null;
}

/** Staleness of the observation itself (no driver call). */
function staleError(d: DesktopServices, o: Observation): string | null {
  if (o.generation !== d.generation()) return 'stale observation: driver generation changed';
  if (o.epoch !== d.arbiter.epoch) return 'stale observation: owner activity or focus change since capture';
  if (Date.now() - o.captured_at > OBSERVATION_TTL_MS) return 'stale observation: older than 30s';
  return null;
}

interface LiveTarget { kind: SurfaceKind; bounds: Bounds | null; screenshot_width: number | null }

/**
 * Re-establish, immediately before input, what the observation claimed: same surface kind, same
 * window, and for a file panel the same host sheet and panel window. Null means it cannot be
 * established, which fails closed.
 */
async function liveTarget(d: DesktopServices, o: Observation, pixel: boolean): Promise<LiveTarget | null> {
  if (!o.host) {
    const p = await probeSurface(d, o.pid, o.window_id, o.bundle_id, pixel);
    return { kind: p.surface.kind, bounds: p.window_bounds, screenshot_width: p.screenshot_width };
  }
  const hostNow = await probeSurface(d, o.host.pid, o.host.window_id, o.host.bundle_id);
  const sheets = hostNow.surface.sheet_frames;
  if (sheets.length !== 1 || !sameRect(sheets[0], o.host.sheet_frame)) return null;
  const panelNow = ((await call(d, 'list_windows', { pid: o.pid })).windows ?? []).find((w: any) => Number(w.window_id) === o.window_id);
  if (!panelNow?.bounds || !o.bounds || !sameRect(panelNow.bounds, o.bounds)) return null;
  // A panel-service window is a file panel by identity; what can change is ownership, re-established above
  // (the host still shows exactly this sheet, and this panel window still has its frame). The probe below only
  // supplies the screenshot geometry for pixel input.
  const p = pixel ? await probeSurface(d, o.pid, o.window_id, o.bundle_id, true) : null;
  return { kind: 'file_panel', bounds: panelNow.bounds, screenshot_width: p?.screenshot_width ?? null };
}

/** The driver reads pixel x,y in its SCREENSHOT space, which it downscales for large windows. */
function toScreenshotPixels(a: ActArgs, live: LiveTarget): { x: number; y: number } | string {
  if (!live.bounds || !live.screenshot_width) return 'cannot establish the window\'s screenshot geometry for pixel input';
  const scale = live.screenshot_width / live.bounds.width;
  const x = a.x! * scale, y = a.y! * scale;
  if (x > live.screenshot_width || y > live.bounds.height * scale) return 'pixel input outside the window after coordinate translation';
  return { x, y };
}

function driverCall(a: ActArgs, o: Observation, at: { x: number; y: number } | null): [string, Record<string, unknown>] {
  const delivery_mode = a.needs_foreground ? 'foreground' : 'background';
  const target: Record<string, unknown> = a.focused ? {} : a.element_token ? { element_token: a.element_token } : at ?? {};
  const common = { pid: o.pid, window_id: o.window_id, ...target, delivery_mode };
  switch (a.action) {
    case 'click': return ['click', common];
    case 'double_click': return ['double_click', common]; // AX path performs AXOpen on openable rows
    case 'type_text': return ['type_text', { ...common, text: a.text ?? '' }];
    case 'set_value': return ['set_value', { pid: o.pid, window_id: o.window_id, element_token: a.element_token, value: a.text ?? '' }];
    case 'press_key': return ['press_key', { ...common, key: a.key }];
    case 'hotkey': return ['hotkey', { ...common, keys: a.keys }];
    case 'scroll': return ['scroll', { ...common, direction: a.direction ?? 'down' }];
    case 'invoke_menu': return ['invoke_menu', { pid: o.pid, window_id: o.window_id, path: a.menu_path }];
  }
}

export const desktopAct: ToolAdapter = {
  spec: toolSpec({ tool_id: 'desktop.act', description: 'Perform ONE input on an observed window element (click/double_click/type/set_value/key/hotkey/scroll/menu). Requires observation_ref from desktop.observe and expect predicates for verification. Input to a file-panel surface needs file_panel_input authority; to an unverifiable surface, unverified_surface_input.',
    effect_class: 'NON_IDEMPOTENT_EFFECT',
    input_schema: { type: 'object', required: ['observation_ref', 'action', 'expect'], properties: {
      observation_ref: { type: 'string', format: 'uuid' },
      action: { enum: ['click', 'double_click', 'type_text', 'set_value', 'press_key', 'hotkey', 'scroll', 'invoke_menu'] },
      element_token: { type: 'string', maxLength: 64 },
      x: { type: 'number', minimum: 0, description: 'window-local x (same space as observe frames)' }, y: { type: 'number', minimum: 0, description: 'window-local y' },
      text: { type: 'string', maxLength: 20000 },
      key: { type: 'string', maxLength: 32 },
      keys: { type: 'array', maxItems: 5, items: { type: 'string', maxLength: 16 } },
      direction: { enum: ['up', 'down', 'left', 'right'] },
      menu_path: { type: 'array', maxItems: 6, items: { type: 'string', maxLength: 80 } },
      expect: { type: 'array', minItems: 1, maxItems: 8, items: PREDICATE },
      needs_foreground: { type: 'boolean' },
      focused: { type: 'boolean', description: 'type_text/press_key/hotkey into the app\'s currently focused element; verified by expect' } } } }),
  resolve(a: ActArgs, ctx) {
    const d = svc(ctx);
    const o = d.observations.get(a.observation_ref);
    if (!o) throw new TargetError('unknown observation_ref (observe first)');
    // The surface decides authority for every input method alike (pixel, element, keyboard, menu).
    const protected_kind = protectedKindFor(o.surface.kind);
    return { resource_id: windowTarget(o), account_id: null,
      facts: { app: o.bundle_id, ...(o.host ? { apps: [o.host.bundle_id] } : {}), ...(protected_kind ? { protected_kind } : {}) },
      claims: [{ resource_key: `desktop:${d.sessionId}`, mode: 'exclusive' }], fingerprint: `${o.generation}:${o.epoch}:${o.surface.kind}:${o.pid}:${o.window_id}` };
  },
  fingerprint: (r) => r.fingerprint,
  preconditions(a: ActArgs, _r, ctx): CheckResult {
    const d = svc(ctx);
    const o = d.observations.get(a.observation_ref)!;
    const stale = staleError(d, o);
    if (stale) return { ok: false, reason: stale };
    const gate = d.arbiter.mayInput(d.foreground(ctx.taskId), needsForeground(a));
    if (!gate.ok) return { ok: false, reason: `human coexistence: ${gate.reason}`, wait: gate.wait };
    const shape = shapeError(a, o);
    if (shape) return { ok: false, reason: shape };
    return { ok: true, evidence: { observation: o.observation_id, epoch: o.epoch, surface: o.surface } };
  },
  postconditions: (a: ActArgs) => a.expect.map((p) => ({ kind: 'cua_predicate', json: JSON.stringify(p).slice(0, 2000) })),
  async dispatch(a: ActArgs, _r, ctx) {
    const d = svc(ctx);
    const o = d.observations.get(a.observation_ref)!;
    // Re-check the gate at the last moment (owner may have started typing).
    const gate = d.arbiter.mayInput(d.foreground(ctx.taskId), needsForeground(a));
    if (!gate.ok) return { outcome: 'failure', error: `yielded to owner: ${gate.reason}`, retryable: true };
    try {
      const pixel = isPixel(a);
      let at: { x: number; y: number } | null = null;
      if (routedAtDelivery(a)) {
        const live = await liveTarget(d, o, pixel);
        if (!live) return { outcome: 'failure', error: 'cannot re-establish the observed panel and its host sheet; re-observe', retryable: true };
        if (live.kind !== o.surface.kind) return { outcome: 'failure', error: `input surface changed since observation (${o.surface.kind} -> ${live.kind}); re-observe`, retryable: true };
        if (pixel) {
          // Pixel input is only valid in the exact geometry it was observed in (T-MAC-07).
          if (!live.bounds || !o.bounds || !sameRect(live.bounds, o.bounds, 0)) return { outcome: 'failure', error: 'window moved, resized or closed since observation; re-observe before pixel input', retryable: true };
          const t = toScreenshotPixels(a, live);
          if (typeof t === 'string') return { outcome: 'failure', error: t, retryable: false };
          at = t;
        }
      }
      const [name, args] = driverCall(a, o, at);
      d.arbiter.noteSelfInput();
      const sc = await call(d, name, args);
      d.observations.delete(a.observation_ref); // one action per observation: re-observe after acting
      return { outcome: 'success', receipt: { effect: sc.effect ?? sc.status ?? 'ok' } };
    } catch (e) { return mapErr(e); }
  },
  async verify(a: ActArgs, r, _post, _receipt, ctx) { return verifyPredicates(ctx, a, r); },
  async reconcile(a: ActArgs, r, _post, ctx) {
    const v = await verifyPredicates(ctx, a, r);
    // UI input cannot be proven "not applied"; unmet predicates stay unknown.
    return { status: v.verdict === 'verified' ? 'applied' : 'unknown', evidence: v.evidence };
  },
};
