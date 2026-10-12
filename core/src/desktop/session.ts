// Interactive-session monitor for human coexistence (handoff §12.4, §12.6,
// REQ-12). Reads only OS-provided session facts: HID idle time, console lock
// state and the frontmost application. Billy's own background AX actions do
// not generate HID events, so HID activity is attributed to the owner unless it
// falls inside a short window after an input Billy itself injected.
import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { dirname, join } from 'node:path';

export interface SessionFacts { idle_ms: number; locked: boolean; frontmost_bundle: string | null; at: number }

export interface SessionProbe { read(): SessionFacts; start?(): void; stop?(): void }

export class MacSessionProbe implements SessionProbe {
  private child: ChildProcess | null = null;
  private latest: SessionFacts | null = null;
  private receivedAt = -Infinity;
  private retry: NodeJS.Timeout | null = null;
  private watching = false;
  private helperPath: string;

  constructor(helperPath?: string) {
    const packaged = join(dirname(dirname(dirname(realpathSync(process.execPath)))), 'bin', 'billy-session');
    const native = join(import.meta.dirname, '../../../native/.build');
    this.helperPath = helperPath ?? [packaged, join(native, 'release/billy-session'), join(native, 'debug/billy-session')].find(existsSync) ?? packaged;
  }

  private unknown(): SessionFacts { return { idle_ms: 0, locked: true, frontmost_bundle: null, at: Date.now() }; }

  private parse(line: string): SessionFacts | null {
    try {
      const f = JSON.parse(line);
      if (!Number.isFinite(f.idle_ms) || f.idle_ms < 0 || !Number.isFinite(f.at) || typeof f.locked !== 'boolean'
        || (f.frontmost_bundle !== null && typeof f.frontmost_bundle !== 'string')) return null;
      return f as SessionFacts;
    } catch { return null; }
  }

  read(): SessionFacts {
    if (this.watching) return this.latest && performance.now() - this.receivedAt <= 250 ? this.latest : this.unknown();
    // Direct probes are bounded; continuous monitoring always uses the stream.
    const res = spawnSync(this.helperPath, [], { encoding: 'utf8', timeout: 1000, maxBuffer: 8192 });
    return res.status === 0 ? this.parse(res.stdout.trim()) ?? this.unknown() : this.unknown();
  }

  start(): void {
    if (this.watching) return;
    this.watching = true;
    const launch = () => {
      if (!this.watching) return;
      const child = spawn(this.helperPath, ['--watch'], { stdio: ['ignore', 'pipe', 'ignore'] });
      this.child = child;
      let buffer = '';
      child.stdout!.setEncoding('utf8');
      child.stdout!.on('data', (chunk: string) => {
        buffer += chunk;
        if (buffer.length > 8192) { buffer = ''; this.latest = null; child.kill(); return; }
        let nl;
        while ((nl = buffer.indexOf('\n')) >= 0) {
          const facts = this.parse(buffer.slice(0, nl)); buffer = buffer.slice(nl + 1);
          this.latest = facts; this.receivedAt = performance.now();
        }
      });
      child.on('error', () => { this.latest = null; });
      child.on('close', () => {
        this.latest = null; this.child = null;
        if (this.watching) this.retry = setTimeout(launch, 1000);
      });
    };
    launch();
  }

  stop(): void {
    this.watching = false;
    if (this.retry) clearTimeout(this.retry);
    this.retry = null; this.latest = null;
    this.child?.kill(); this.child = null;
  }
}

export type OwnerState = 'idle' | 'active' | 'locked';

export interface ArbiterConfig {
  /** Owner input newer than this (ms) means the owner is using the Mac. */
  activeWindowMs: number;
  /** Required quiet period before Billy may (re)take foreground input under 'when_idle'. */
  resumeIdleMs: number;
  /** Self-input attribution window after an injected event. */
  selfEchoMs: number;
  pollMs: number;
}

export const DEFAULT_ARBITER: ArbiterConfig = { activeWindowMs: 1500, resumeIdleMs: 5000, selfEchoMs: 250, pollMs: 100 };

/**
 * Desktop arbiter: decides whether Billy may inject input right now and emits
 * takeover events within one poll interval of detected owner activity.
 */
export class DesktopArbiter {
  private probe: SessionProbe;
  readonly cfg: ArbiterConfig;
  private lastSelfInput = 0;
  private timer: NodeJS.Timeout | null = null;
  private lastFacts: SessionFacts | null = null;
  private lastFront: string | null = null;
  /** Monotonic counter: every takeover/focus change invalidates outstanding observations. */
  epoch = 0;
  onTakeover: ((reason: string, facts: SessionFacts) => void)[] = [];
  takeovers: { at: number; reason: string; detected_after_ms: number | null }[] = [];

  constructor(probe: SessionProbe, cfg: ArbiterConfig = DEFAULT_ARBITER) { this.probe = probe; this.cfg = cfg; }

  noteSelfInput(): void { this.lastSelfInput = Date.now(); }

  facts(): SessionFacts { this.lastFacts = this.probe.read(); return this.lastFacts; }

  state(f = this.facts()): OwnerState {
    if (f.locked) return 'locked';
    const sinceSelf = f.at - this.lastSelfInput;
    const ownerInput = f.idle_ms < this.cfg.activeWindowMs && !(sinceSelf >= 0 && Math.abs(sinceSelf - f.idle_ms) <= this.cfg.selfEchoMs);
    return ownerInput ? 'active' : 'idle';
  }

  /** Gate for an input action under the grant's foreground rule. */
  mayInput(foreground: 'never' | 'when_idle' | 'allowed', needsForeground: boolean): { ok: boolean; reason?: string; wait?: 'WAITING_USER_SESSION' | 'WAITING_RESOURCE' | 'WAITING_PERMISSION' } {
    const f = this.facts();
    const st = this.state(f);
    if (st === 'locked') return { ok: false, reason: 'screen is locked', wait: 'WAITING_USER_SESSION' };
    if (st === 'active') return { ok: false, reason: 'owner is using the Mac', wait: 'WAITING_USER_SESSION' };
    if (needsForeground) {
      if (foreground === 'never') return { ok: false, reason: 'foreground input not permitted by policy', wait: 'WAITING_PERMISSION' };
      if (foreground === 'when_idle' && f.idle_ms < this.cfg.resumeIdleMs) return { ok: false, reason: `waiting for ${this.cfg.resumeIdleMs}ms of owner idle`, wait: 'WAITING_USER_SESSION' };
    }
    return { ok: true };
  }

  start(): void {
    if (this.timer) return;
    this.probe.start?.();
    const tick = () => {
      try {
        const f = this.facts();
        const st = this.state(f);
        const frontChanged = this.lastFront !== null && f.frontmost_bundle !== this.lastFront;
        this.lastFront = f.frontmost_bundle;
        if (st !== 'idle' || frontChanged) {
          this.epoch++;
          const reason = st === 'locked' ? 'locked' : st === 'active' ? 'owner_input' : 'focus_changed';
          this.takeovers.push({ at: f.at, reason, detected_after_ms: st === 'active' ? f.idle_ms : null });
          if (this.takeovers.length > 100) this.takeovers.splice(0, this.takeovers.length - 100);
          for (const h of this.onTakeover) { try { h(reason, f); } catch { /* best effort */ } }
        }
      } catch { /* probe failure: treat as unknown, next tick retries */ }
      this.timer = setTimeout(tick, this.cfg.pollMs);
    };
    tick();
  }

  stop(): void { if (this.timer) clearTimeout(this.timer); this.timer = null; this.probe.stop?.(); }
}
