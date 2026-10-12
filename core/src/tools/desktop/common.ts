// Shared plumbing for the desktop tools: services, the driver call, tool-spec
// defaults, error mapping and the surface probe (see ../../desktop/surface.ts).
import type { ToolSpec } from '../../contracts/action.ts';
import { TargetError } from '../../broker/types.ts';
import { CuaError, interpret, type CuaTransport } from '../../desktop/cua.ts';
import type { DesktopArbiter } from '../../desktop/session.ts';
import { classifySurface, SURFACE_PROBE_LIMITS, type Bounds, type Frame, type RawElement, type Surface } from '../../desktop/surface.ts';
import { newId } from '../../util/canon.ts';

/** The host window a system file panel is attached to (panel observations only). */
export interface PanelHost { pid: number; window_id: number; bundle_id: string; sheet_frame: Bounds }

export interface Observation {
  observation_id: string; generation: number; epoch: number; pid: number; window_id: number; bundle_id: string;
  snapshot_id: string | null; captured_at: number; title: string | null; bounds: Bounds | null;
  /** The input surface this observation was classified as when captured; re-verified before every input. */
  surface: Surface;
  host?: PanelHost;
}

/** An element as returned to the planner. Read-only rows (from the driver's markdown) carry no token and no frame. */
export interface ObservedElement {
  element_token?: string; role: string; label: string; value: string; actions?: string[];
  frame: Frame | null; read_only?: true;
}

export const OBSERVATION_TTL_MS = 30_000;

/** A verify_state predicate (driver schema) or an on-device OCR check of a window region. */
export type Predicate = { ocr?: { region: { x1: number; y1: number; x2: number; y2: number }; line_equals?: string; contains?: string }; [k: string]: unknown };

/** The broker resource id of an input target, and its exact inverse (null when malformed: callers fail closed). */
export const windowTarget = (o: Pick<Observation, 'bundle_id' | 'pid' | 'window_id'>) => `window:${o.bundle_id}:${o.pid}:${o.window_id}`;
export function parseWindowTarget(id: string): { pid: number; window_id: number } | null {
  const m = /^window:[^:]+:(\d+):(\d+)$/.exec(id);
  return m ? { pid: Number(m[1]), window_id: Number(m[2]) } : null;
}

export interface DesktopServices {
  transport: () => CuaTransport;     // current daemon transport
  generation: () => number;          // current daemon generation (restart/switch invalidates)
  arbiter: DesktopArbiter;
  foreground: (taskId?: string) => 'never' | 'when_idle' | 'allowed';
  observations: Map<string, Observation>;
  sessionId: string;
  /** Path to the bundled on-device OCR helper (Vision). */
  ocrPath?: string;
  /** Pids of the exact panel-service executable (defaults to the local process table; tests substitute it). */
  panelServicePids?: () => number[];
}

export const svc = (ctx: { services: Record<string, unknown> }) => {
  const d = ctx.services.desktop as DesktopServices | undefined;
  if (!d) throw new TargetError('desktop control is not configured (Cua driver unavailable)');
  return d;
};

export async function call(d: DesktopServices, name: string, args: Record<string, unknown>) {
  return interpret(name, await d.transport().call(name, args, d.sessionId));
}

export const toolSpec = (o: Partial<ToolSpec> & Pick<ToolSpec, 'tool_id' | 'description' | 'input_schema' | 'effect_class'>): ToolSpec => ({
  version: 1, output_schema: { type: 'object', additionalProperties: true }, tool_class: 'desktop', capabilities: ['desktop'],
  target_kind: 'app', cancellation: 'none', timeout_ms: 30_000, idempotency: 'none', verification: 'cua_verify_state',
  reconciliation: 'cua_verify_state', compensation: 'none: UI input cannot be recalled', lock_class: 'desktop', egress: 'local',
  executable_identity: 'pinned cua-driver 0.26.1', ...o,
});

export const bundleArg = { type: 'string', pattern: '^[A-Za-z0-9.-]{3,200}$' } as const;

/** A new observation stamped with the current driver generation and arbiter epoch. */
export function newObservation(d: DesktopServices, o: Omit<Observation, 'observation_id' | 'generation' | 'epoch' | 'captured_at'>): Observation {
  return { observation_id: newId(), generation: d.generation(), epoch: d.arbiter.epoch, captured_at: Date.now(), ...o };
}

/** Resolve the pid of a GRANTED app via launch_app (idempotent; never enumerates running apps). */
export async function pidFor(d: DesktopServices, bundle: string): Promise<number | null> {
  const r = await call(d, 'launch_app', { bundle_id: bundle });
  return r.pid ? Number(r.pid) : null;
}

export interface ProbeResult {
  surface: Surface; window_bounds: Bounds | null; screenshot_width: number | null;
  /** The rows and snapshot the classification was made from: tokens handed out must come from exactly this walk. */
  rows: any[]; markdown: string; snapshot_id: string | null;
}

/**
 * The surface probe: one bounded, AX-only walk of exactly one window, classified. Used when an
 * observation is captured and again immediately before any input, so both decisions read the same evidence.
 * `withScreenshot` also returns the driver's screenshot width (its pixel space for x,y input).
 */
export async function probeSurface(d: DesktopServices, pid: number, windowId: number, bundleId: string, withScreenshot = false): Promise<ProbeResult> {
  const st = await call(d, 'get_window_state', { pid, window_id: windowId, include_screenshot: withScreenshot, ...SURFACE_PROBE_LIMITS });
  const surface = classifySurface({ bundle_id: bundleId, elements: (st.elements ?? []) as RawElement[], markdown: String(st.tree_markdown ?? ''),
    // Complete only when the driver says so: an absent flag is not evidence (fail closed).
    complete: st.elements_complete === true });
  const wb = st.window_bounds;
  return { surface, window_bounds: wb ? { x: Number(wb.x), y: Number(wb.y), width: Number(wb.width), height: Number(wb.height) } : null,
    screenshot_width: Number(st.screenshot_width) > 0 ? Number(st.screenshot_width) : null,
    rows: st.elements ?? [], markdown: String(st.tree_markdown ?? ''), snapshot_id: st.snapshot_id ?? null };
}

/**
 * The driver reports "window not yet key" (e.g. just launched) only as a generic menu_path_unavailable refusal;
 * its message is the sole distinguishing evidence, so the match is confined to this one named predicate.
 */
const isFocusContention = (e: CuaError) => e.code === 'refused' && /did not become stably key/.test(e.message);

export function mapErr(e: unknown): { outcome: 'failure' | 'unknown'; error: string; retryable?: boolean } {
  if (e instanceof CuaError) {
    // Refusals, permission gates, stale targets and a stopped daemon are definite: no input was delivered.
    // Stale targets and focus contention are transient; the executor owns any retry (ADR-0004).
    if (['refused', 'permissions_pending', 'stale', 'not_running', 'pin_mismatch'].includes(e.code)) {
      return { outcome: 'failure', error: e.message, retryable: e.code === 'stale' || isFocusContention(e) };
    }
    if (e.code === 'tool_error') return { outcome: 'failure', error: e.message, retryable: false };
  }
  return { outcome: 'unknown', error: (e as Error).message };
}
