// desktop.observe: capture one window's elements and classify its input surface.
// Two paths: an ordinary window of a granted app, or the system file panel attached
// to one (A-02/A-03: ownership is proven, never guessed from geometry alone).
import type { ToolAdapter } from '../../broker/types.ts';
import { redact } from '../../util/redact.ts';
import { centreInside, PANEL_SERVICE_REASON, type Bounds } from '../../desktop/surface.ts';
import { matchPanelToSheet, PANEL_SERVICE_BUNDLE, panelServicePids, type PanelWindow } from '../../desktop/panels.ts';
import { bundleArg, call, mapErr, newObservation, pidFor, probeSurface, svc, toolSpec, type DesktopServices, type ObservedElement } from './common.ts';

interface ObserveArgs {
  bundle_id: string; window_title_contains?: string; window_id?: number; list_windows?: boolean;
  attached_panel?: boolean; query?: string; max_depth?: number; max_elements?: number;
}

const READ_ONLY_ROLES = new Set(['AXStaticText', 'AXCell', 'AXHeading', 'AXTextArea', 'AXValueIndicator']);

/** Window of `pid` selected by exact id (preferred) or title, frontmost by z-index; never array order. */
function selectWindow(windows: any[], a: ObserveArgs, pid: number): any | null {
  let list = windows;
  if (a.window_title_contains) list = list.filter((w) => String(w.title ?? '').toLowerCase().includes(String(a.window_title_contains).toLowerCase()));
  if (a.window_id !== undefined) list = list.filter((w) => Number(w.window_id ?? w.id) === a.window_id && Number(w.pid ?? pid) === pid);
  list = [...list].sort((x, y) => Number(y.z_index ?? -1) - Number(x.z_index ?? -1));
  return list.find((x) => x.is_on_screen ?? x.on_screen ?? true) ?? list[0] ?? null;
}

/**
 * The caller's query and depth limit narrow what is RETURNED, never what is walked: the surface is classified
 * from the full walk, and the tokens handed out must come from that same walk (one driver snapshot).
 */
function selectRows(rows: any[], a: ObserveArgs): any[] {
  const q = a.query?.toLowerCase();
  return rows.filter((e) => (a.max_depth === undefined || Number(e.depth ?? 0) <= a.max_depth)
    && (!q || [e.role, e.label, e.title, e.value].some((x) => String(x ?? '').toLowerCase().includes(q))));
}

function toObserved(e: any, origin: Bounds | null, keepToken: boolean): ObservedElement {
  return {
    element_token: keepToken ? e.element_token : undefined, role: e.role, label: redact(String(e.label ?? e.title ?? e.description ?? '')).slice(0, 120),
    value: redact(String(e.value ?? '')).slice(0, 200), actions: e.actions,
    // Window-local frame (the coordinate space desktop.act x,y uses); null if unknown.
    frame: e.frame && origin ? { x: e.frame.x - origin.x, y: e.frame.y - origin.y, w: e.frame.w, h: e.frame.h } : null,
  };
}

/**
 * The driver's structured list holds only ACTIONABLE elements; visible text (status labels, plain cells)
 * is only in its markdown. Those rows are added read-only (no token, no frame) so observations can be read.
 */
function readOnlyRows(markdown: string, existing: ObservedElement[], limit: number): ObservedElement[] {
  const seen = new Set(existing.map((e) => `${e.role}|${e.label}|${e.value}`));
  const rows: ObservedElement[] = [];
  for (const line of markdown.split('\n')) {
    const m = /^\s*- (AX\w+)(?: "((?:[^"\\]|\\.)*)")?(?: = "((?:[^"\\]|\\.)*)")?(?: \(([^)]*)\))?/.exec(line);
    if (!m || /^\s*- \[\d+\]/.test(line)) continue;
    const [, role, title, value, label] = m;
    if (!READ_ONLY_ROLES.has(role) || (!value && !title)) continue;
    const row: ObservedElement = { role, label: redact(String(label ?? title ?? '')).slice(0, 120), value: redact(String(value ?? title ?? '')).slice(0, 200), frame: null, read_only: true };
    const key = `${row.role}|${row.label}|${row.value}`;
    if (seen.has(key) || existing.length + rows.length >= limit) continue;
    seen.add(key); rows.push(row);
  }
  return rows;
}

/** Panel-service windows of the exact canonical executable (pid-scoped listings only). */
async function panelWindows(d: DesktopServices, exceptPid: number): Promise<PanelWindow[]> {
  const out: PanelWindow[] = [];
  for (const pid of (d.panelServicePids ?? panelServicePids)()) {
    if (pid === exceptPid) continue;
    let windows: any[] = [];
    try { windows = (await call(d, 'list_windows', { pid })).windows ?? []; } catch { continue; } // not granted: invisible, never guessed
    for (const w of windows) if (w.bounds) out.push({ pid, window_id: Number(w.window_id ?? w.id), title: w.title ?? null, bounds: w.bounds });
  }
  return out;
}

async function observeWindow(d: DesktopServices, a: ObserveArgs, pid: number, w: any) {
  const windowId = Number(w.window_id ?? w.id);
  // ONE walk: the classification and every token returned describe the same driver snapshot (no race window).
  const walk = await probeSurface(d, pid, windowId, a.bundle_id);
  const limit = a.max_elements ?? 200;
  const elements = selectRows(walk.rows, a).slice(0, limit).map((e: any) => toObserved(e, w.bounds ?? null, true));
  const q = a.query?.toLowerCase();
  elements.push(...readOnlyRows(walk.markdown, elements, limit).filter((e) => !q || `${e.role} ${e.label} ${e.value}`.toLowerCase().includes(q)));
  const obs = newObservation(d, { pid, window_id: windowId, bundle_id: a.bundle_id, snapshot_id: walk.snapshot_id, title: w.title ?? null, bounds: w.bounds ?? null, surface: walk.surface });
  return { obs, elements };
}

async function observeAttachedPanel(d: DesktopServices, a: ObserveArgs, hostPid: number, host: any) {
  const hostWindowId = Number(host.window_id ?? host.id);
  const hostProbe = await probeSurface(d, hostPid, hostWindowId, a.bundle_id);
  if (hostProbe.surface.sheet_frames.length !== 1) return { error: `expected exactly one sheet attached to the window (found ${hostProbe.surface.sheet_frames.length})` };
  const sheet = hostProbe.surface.sheet_frames[0];
  const panel = matchPanelToSheet(sheet, await panelWindows(d, hostPid));
  if (!panel) return { error: 'no single file-panel service window matches the attached sheet' };
  // The remote panel's own window has no AX surface; its view is mirrored in the HOST's AX tree.
  // Read geometry there, but never return host tokens (they would address the host, not the panel).
  // Geometry only (tokens withheld): read from the same host walk that proved the sheet.
  const elements = selectRows(hostProbe.rows, a).filter((e: any) => e.frame && centreInside(e.frame, panel.bounds)).slice(0, a.max_elements ?? 200)
    .map((e: any) => toObserved(e, panel.bounds, false));
  const surface = { kind: 'file_panel' as const, reasons: [PANEL_SERVICE_REASON, ...hostProbe.surface.reasons], sheet_frames: [sheet] };
  const obs = newObservation(d, { pid: panel.pid, window_id: panel.window_id, bundle_id: PANEL_SERVICE_BUNDLE, snapshot_id: null, title: panel.title, bounds: panel.bounds, surface,
    host: { pid: hostPid, window_id: hostWindowId, bundle_id: a.bundle_id, sheet_frame: sheet } });
  return { obs, elements };
}

export const desktopObserve: ToolAdapter = {
  spec: toolSpec({ tool_id: 'desktop.observe', description: 'Observe a granted app window: returns an observation_ref, its input surface classification, and elements (element_token, role, label, value). Screenshots are not stored by default.',
    effect_class: 'READ_ONLY', idempotency: 'inherent', lock_class: 'none',
    input_schema: { type: 'object', required: ['bundle_id'], properties: { bundle_id: bundleArg, window_title_contains: { type: 'string', maxLength: 200 },
      window_id: { type: 'integer', minimum: 1 }, list_windows: { type: 'boolean' },
      attached_panel: { type: 'boolean', description: 'observe the system Open/Save panel attached to the selected window (requires the panel service in the grant)' },
      query: { type: 'string', maxLength: 200 }, max_depth: { type: 'integer', minimum: 1, maximum: 25 }, max_elements: { type: 'integer', minimum: 10, maximum: 400 } } } }),
  resolve(a) { return { resource_id: `app:${a.bundle_id}`, account_id: null, facts: { app: a.bundle_id, ...(a.attached_panel ? { apps: [PANEL_SERVICE_BUNDLE] } : {}) }, claims: [] }; },
  preconditions: () => ({ ok: true }),
  postconditions: () => [],
  async dispatch(a: ObserveArgs, _r, ctx) {
    const d = svc(ctx);
    try {
      const pid = await pidFor(d, a.bundle_id);
      if (!pid) return { outcome: 'failure', error: `${a.bundle_id} is not running`, retryable: false };
      const wins = await call(d, 'list_windows', { pid });
      const w = selectWindow(wins.windows ?? [], a, pid);
      if (!w) return { outcome: 'failure', error: 'no matching window', retryable: true };
      const r = a.attached_panel ? await observeAttachedPanel(d, a, pid, w) : await observeWindow(d, a, pid, w);
      if ('error' in r) return { outcome: 'failure', error: r.error as string, retryable: true };
      d.observations.set(r.obs.observation_id, r.obs);
      const windows = a.list_windows ? (wins.windows ?? []).map((x: any) => ({ window_id: x.window_id, title: x.title, bounds: x.bounds })) : undefined;
      return { outcome: 'success', receipt: { observation_ref: r.obs.observation_id, window: { title: r.obs.title, window_id: r.obs.window_id, bounds: r.obs.bounds },
        surface: { kind: r.obs.surface.kind, reasons: r.obs.surface.reasons }, elements: r.elements, ...(windows ? { windows } : {}) } };
    } catch (e) { return mapErr(e); }
  },
  async verify() { return { verdict: 'verified', evidence: { read_only: true } }; },
  async reconcile() { return { status: 'not_applied', evidence: { read_only: true } }; },
};
