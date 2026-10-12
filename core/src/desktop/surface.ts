// Input-surface classification for desktop authorization (A-02). Every desktop
// input is authorized against the SURFACE it will reach, not just the app:
//   - app_window:  an ordinary window of a granted app;
//   - file_panel:  a system Open/Save panel, an attached sheet, or a window with the structure of
//                  a file dialog or file browser. Input there can name any path, which file-root
//                  policy cannot see, so it needs the owner's explicit `file_panel_input` authority;
//   - unverified:  the surface cannot be established: no AX surface, or an AX walk that was cut
//                  short before every file-panel marker could be ruled out. Fail closed: input needs
//                  explicit `unverified_surface_input` authority.
// Recognition errs towards file_panel: a false positive costs an authority prompt, a false
// negative would let a typed path escape file-root policy.
import { PANEL_SERVICE_BUNDLE } from './panels.ts';

/** Screen rectangle in points (window bounds). */
export interface Bounds { x: number; y: number; width: number; height: number }
/** Element frame as the driver reports it (screen points). */
export interface Frame { x: number; y: number; w: number; h: number }
export const boundsOf = (f: Frame): Bounds => ({ x: f.x, y: f.y, width: f.w, height: f.h });
export const centreInside = (f: Frame, b: Bounds) =>
  f.x + f.w / 2 >= b.x && f.x + f.w / 2 <= b.x + b.width && f.y + f.h / 2 >= b.y && f.y + f.h / 2 <= b.y + b.height;

export type SurfaceKind = 'app_window' | 'file_panel' | 'unverified';

/** Protected action kinds produced by desktop input; a grant must list them in `protected_actions`. */
export type DesktopProtectedKind = 'file_panel_input' | 'unverified_surface_input';

export interface Surface {
  kind: SurfaceKind;
  /** Human-readable evidence for the classification (recorded with the attempt). */
  reasons: string[];
  /** Screen frames of attached sheets seen in the host's AX tree (ownership evidence for panels). */
  sheet_frames: Bounds[];
}

/** One raw element row as the driver reports it (structured list). */
export interface RawElement { role?: string; label?: string; title?: string; value?: unknown; frame?: Frame | null; /** index of the parent row in the same walk; absent (or null) for a root such as the window or the menu bar */ parent_index?: number | null }

/** The probe the classifier reads: a bounded, screenshot-free AX walk of exactly one window. */
export interface SurfaceProbe { bundle_id: string; elements: RawElement[]; markdown: string; /** false when the driver cut the walk short */ complete: boolean }

// The driver's own default walk budget; larger windows fail closed as unverified rather than being guessed.
/** Classification reason for any window of the system panel service (also used by panel observations). */
export const PANEL_SERVICE_REASON = 'system file-panel service window';

// The driver's own default walk budget and no depth limit (a depth cut would hide deep markers without being
// reported as truncation); larger windows fail closed as unverified rather than being guessed.
export const SURFACE_PROBE_LIMITS = { max_elements: 2000 } as const;

const label = (e: RawElement) => String(e.label ?? e.title ?? '').trim();
/**
 * AX identifiers AppKit assigns to Open/Save panel controls (checked on the real panel). They are not
 * localized, unlike button titles, so they identify a file panel in any system language.
 */
const FILE_PANEL_IDENTIFIERS = /\[id=(?:save-panel|open-panel|where popup|saveAsNameTextField|NS_OPEN_SAVE_[A-Z_]+)\b/;
const FILE_VERBS = /^(Open|Save|Choose|Select|Export|Import|Move|Copy|Attach|Insert|Upload)\b/i;

/** Single-element markers of a file panel or file browser. */
const ELEMENT_MARKERS: { test: (e: RawElement) => boolean; reason: string }[] = [
  { test: (e) => e.role === 'AXSheet', reason: 'attached sheet' },
  { test: (e) => e.role === 'AXPopUpButton' && /^Where:?$/i.test(label(e)), reason: 'save-panel location chooser' },
  { test: (e) => e.role === 'AXBrowser' && /column view/i.test(label(e)), reason: 'column file browser' },
  { test: (e) => e.role === 'AXOutline' && /^sidebar$/i.test(label(e)), reason: 'file sidebar' },
];

export function classifySurface(p: SurfaceProbe): Surface {
  const reasons: string[] = [];
  const sheet_frames: Bounds[] = [];
  if (p.bundle_id === PANEL_SERVICE_BUNDLE) reasons.push(PANEL_SERVICE_REASON);
  for (const e of p.elements) {
    for (const m of ELEMENT_MARKERS) if (m.test(e) && !reasons.includes(m.reason)) reasons.push(m.reason);
    if (e.role === 'AXSheet' && e.frame) sheet_frames.push(boundsOf(e.frame));
  }
  // Dialog structure: Cancel alongside a file verb (Open, Save, Choose, …), as in every standard file dialog.
  const buttons = p.elements.filter((e) => e.role === 'AXButton').map(label);
  if (buttons.some((b) => /^Cancel$/i.test(b)) && buttons.some((b) => FILE_VERBS.test(b))) reasons.push('file dialog buttons');
  // Rows absent from the structured list (non-actionable) still appear in the markdown.
  if (/\bAXSheet\b/.test(p.markdown) && !reasons.includes('attached sheet')) reasons.push('attached sheet');
  // Primary, language-independent evidence: AppKit's own AX identifiers on Open/Save panels (never localized).
  if (FILE_PANEL_IDENTIFIERS.test(p.markdown)) reasons.push('AppKit file-panel identifiers');
  if (reasons.length) return { kind: 'file_panel', reasons, sheet_frames };
  if (!p.elements.length && !p.markdown.trim()) return { kind: 'unverified', reasons: ['no accessibility surface'], sheet_frames };
  const windowCovered = p.complete || walkLeftTheWindow(p.elements);
  if (!windowCovered) return { kind: 'unverified', reasons: ['accessibility walk truncated inside the window before file-panel markers could be ruled out'], sheet_frames };
  return { kind: 'app_window', reasons: ['ordinary app window'], sheet_frames };
}

/**
 * True when the walk provably finished the window before it was cut short. The driver walks depth-first,
 * the window first, so the window's rows must form a contiguous prefix: proof is a row OUTSIDE the window
 * (menu bar, status item, …) with no window row after it. Ancestry comes from parent_index, per walk.
 */
function walkLeftTheWindow(rows: RawElement[]): boolean {
  const root = rows.findIndex((e) => e.role === 'AXWindow' && e.parent_index == null);
  if (root < 0) return false;
  const inWindow = (i: number): boolean => {
    for (let k = i, hops = 0; hops <= rows.length; hops++) {
      if (k === root) return true;
      const parent = rows[k]?.parent_index;
      if (parent == null || parent < 0) return false; // reached another root
      k = parent;
    }
    return false;
  };
  const firstOutside = rows.findIndex((_, i) => i > root && !inWindow(i));
  if (firstOutside < 0) return false;
  for (let i = firstOutside + 1; i < rows.length; i++) if (inWindow(i)) return false; // not a contiguous prefix
  return true;
}

export function protectedKindFor(kind: SurfaceKind): DesktopProtectedKind | null {
  return kind === 'file_panel' ? 'file_panel_input' : kind === 'unverified' ? 'unverified_surface_input' : null;
}
