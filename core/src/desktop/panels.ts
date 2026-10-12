// System Open/Save panel service identity (A-02, A-03). Sandboxed apps' file
// panels are hosted out-of-process by this XPC service, so a panel window
// belongs to the service pid, not the app. This module is the single source of
// that identity: the driver manifest pins the service by its canonical
// executable, and the desktop tools verify both ends before addressing a panel.
import { spawnSync } from 'node:child_process';
import type { Bounds } from './surface.ts';

export const PANEL_SERVICE_BUNDLE = 'com.apple.appkit.xpc.openAndSavePanelService';
export const PANEL_SERVICE_EXECUTABLE =
  '/System/Library/Frameworks/AppKit.framework/Versions/C/XPCServices/com.apple.appkit.xpc.openAndSavePanelService.xpc/Contents/MacOS/com.apple.appkit.xpc.openAndSavePanelService';

/** Grantable identifiers that are XPC services, pinned by executable in the driver manifest. */
export const SYSTEM_SERVICE_EXECUTABLES: Readonly<Record<string, string>> = { [PANEL_SERVICE_BUNDLE]: PANEL_SERVICE_EXECUTABLE };

/** Executable path of a pid from the local process table (never display-wide window observation). */
export function executableOf(pid: number): string | null {
  const r = spawnSync('/bin/ps', ['-o', 'comm=', '-p', String(pid)], { encoding: 'utf8' });
  const exe = (r.stdout ?? '').trim();
  return r.status === 0 && exe ? exe : null;
}

/** Pids whose executable is EXACTLY the canonical panel service (no command-line pattern matching). */
export function panelServicePids(): number[] {
  // An XPC service's process name is its bundle identifier.
  const r = spawnSync('/usr/bin/pgrep', ['-x', PANEL_SERVICE_BUNDLE], { encoding: 'utf8' });
  return (r.stdout ?? '').split('\n').map(Number).filter((pid) => pid > 0 && executableOf(pid) === PANEL_SERVICE_EXECUTABLE);
}

export interface PanelWindow { pid: number; window_id: number; title: string | null; bounds: Bounds }

/** Two rectangles describe the same window when every edge agrees within `tolerance` points. */
export function sameRect(a: Bounds, b: Bounds, tolerance = 2): boolean {
  return Math.abs(a.x - b.x) <= tolerance && Math.abs(a.y - b.y) <= tolerance
    && Math.abs(a.width - b.width) <= tolerance && Math.abs(a.height - b.height) <= tolerance;
}

/**
 * The panel-service window that IS the given host sheet. Ownership evidence, all required:
 * the host's own AX tree exposes the sheet (`sheetFrame`), the candidate process is the exact
 * canonical panel-service executable, and the candidate window's frame equals that sheet's frame.
 * Zero or several matches fail closed (null).
 */
export function matchPanelToSheet(sheetFrame: Bounds, candidates: PanelWindow[]): PanelWindow | null {
  const matches = candidates.filter((w) => sameRect(w.bounds, sheetFrame));
  return matches.length === 1 ? matches[0] : null;
}
