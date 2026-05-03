import type { PtyTap } from './pty-tap.js';
import type { SessionRegistry } from '../registry/session-registry.js';

/**
 * pty-idle-watcher: detect "claude TUI is back at the prompt" by watching
 * the PTY byte rate. Used to recover state from `running` to `idle` when
 * claude doesn't fire any hook (e.g., user pressed Esc — claude's REPL
 * abort path returns directly without invoking handleStopHooks; see
 * claude/src/screens/REPL.tsx:2147 + claude/src/query.ts:1030).
 *
 * Approach: per-session sliding window of byte arrivals over WINDOW_MS
 * (10 buckets of BUCKET_MS each). State machine:
 *   active   — rate > HIGH_BYTES_PER_S → spinner is spinning, claude busy
 *   cooling  — rate dropped below LOW_BYTES_PER_S → candidate for idle,
 *              record the time we entered cooling
 *   confirm  — cooling persisted for CONFIRM_MS → if state===running,
 *              flip to idle
 *
 * Re-entry into 'active' resets the cooling clock.
 *
 * Rate evaluation runs both on each PTY chunk arrival AND on a setInterval
 * tick — the interval is what guarantees we still evaluate after Esc when
 * no more chunks arrive.
 */
export interface IdleWatcherConfig {
  windowMs:        number;
  bucketMs:        number;
  highBytesPerSec: number;
  lowBytesPerSec:  number;
  confirmMs:       number;
}

const DEFAULT_CONFIG: IdleWatcherConfig = {
  windowMs:        1000,
  bucketMs:        100,
  highBytesPerSec: 50,
  lowBytesPerSec:  5,
  confirmMs:       3000,
};

interface SessionWatch {
  buckets:        number[];   // length = windowMs/bucketMs, ring of byte counts
  bucketStart:    number;     // ts (ms) when current bucket began
  cursor:         number;     // index into buckets (current bucket)
  hasBeenActive:  boolean;    // have we ever seen rate > high in this turn?
  coolingSince:   number | null;
  unsubscribeTap: () => void;
}

export interface IdleWatcherDeps {
  tap:      PtyTap;
  registry: SessionRegistry;
  /** Inject for tests; defaults to Date.now. */
  now?:     () => number;
  config?:  Partial<IdleWatcherConfig>;
}

export interface IdleWatcherInstance {
  stop(): void;
  /** Visible-for-testing: drive the bucket-roll + state-machine evaluation
   *  without waiting on the real setInterval. */
  tick(): void;
}

export function wirePtyIdleWatcher(deps: IdleWatcherDeps): IdleWatcherInstance {
  const cfg: IdleWatcherConfig = { ...DEFAULT_CONFIG, ...(deps.config ?? {}) };
  const now = deps.now ?? Date.now;
  const numBuckets = Math.max(2, Math.round(cfg.windowMs / cfg.bucketMs));
  const watches = new Map<string, SessionWatch>();

  function rollBuckets(w: SessionWatch, currentTs: number): void {
    // Advance cursor through 0..N buckets, zeroing each one we cross.
    while (currentTs - w.bucketStart >= cfg.bucketMs) {
      w.cursor = (w.cursor + 1) % numBuckets;
      w.buckets[w.cursor] = 0;
      w.bucketStart += cfg.bucketMs;
    }
  }

  function rateBytesPerSec(w: SessionWatch): number {
    let total = 0;
    for (const b of w.buckets) total += b;
    return (total * 1000) / cfg.windowMs;
  }

  function evaluate(sessionId: string): void {
    const w = watches.get(sessionId);
    if (!w) return;
    rollBuckets(w, now());
    const session = deps.registry.get(sessionId);
    if (!session) return;
    if (session.state !== 'running') {
      // Not running: keep accumulating buckets but reset cooling so the
      // next time state goes running we have a clean start.
      w.coolingSince = null;
      w.hasBeenActive = false;
      return;
    }
    const rate = rateBytesPerSec(w);
    if (rate >= cfg.highBytesPerSec) {
      // Active: claude is busy. Reset cooling.
      w.coolingSince = null;
      w.hasBeenActive = true;
    } else if (rate < cfg.lowBytesPerSec) {
      // Below LOW: candidate idle. Only confirm if we ever saw active
      // (avoids flipping immediately on session-just-registered with no
      // bytes yet) and CONFIRM_MS has elapsed since we entered cooling.
      if (!w.hasBeenActive) return;
      if (w.coolingSince === null) {
        w.coolingSince = now();
        return;
      }
      if (now() - w.coolingSince >= cfg.confirmMs) {
        // Re-check session state right before mutating — registry is
        // single-threaded but the state may have changed since the top of
        // this function via re-entrant emit.
        const cur = deps.registry.get(sessionId);
        if (cur && cur.state === 'running') {
          deps.registry.updateState(sessionId, 'idle');
        }
        // Reset so we don't keep firing if state flips back to running later.
        w.coolingSince = null;
        w.hasBeenActive = false;
      }
    }
    // Between LOW and HIGH: hold (no transition), don't reset cooling either.
  }

  function attach(sessionId: string): void {
    if (watches.has(sessionId)) return;
    const w: SessionWatch = {
      buckets:       new Array<number>(numBuckets).fill(0),
      bucketStart:   now(),
      cursor:        0,
      hasBeenActive: false,
      coolingSince:  null,
      unsubscribeTap: () => undefined,
    };
    w.unsubscribeTap = deps.tap.subscribe(sessionId, (chunk: Buffer) => {
      rollBuckets(w, now());
      w.buckets[w.cursor] = (w.buckets[w.cursor] ?? 0) + chunk.length;
      // Drive evaluation on chunk too — lets us flip out of cooling fast
      // when activity resumes.
      evaluate(sessionId);
    });
    watches.set(sessionId, w);
  }

  function detach(sessionId: string): void {
    const w = watches.get(sessionId);
    if (!w) return;
    w.unsubscribeTap();
    watches.delete(sessionId);
  }

  // Initial subscription for any sessions already in the registry (restored
  // from checkpoint, etc.) plus future session-added.
  for (const s of deps.registry.list()) attach(s.id);
  const onAdded   = (info: { id: string }): void => attach(info.id);
  const onRemoved = (id: string): void => detach(id);
  deps.registry.on('session-added', onAdded);
  deps.registry.on('session-removed', onRemoved);

  // Tick interval — drives evaluation when no PTY bytes arrive (the Esc
  // fallback case). Skipped under fake-time tests; tests call .tick() directly.
  let intervalHandle: ReturnType<typeof setInterval> | null = null;
  if (!deps.now) {
    intervalHandle = setInterval(() => {
      for (const sid of watches.keys()) evaluate(sid);
    }, cfg.bucketMs);
  }

  return {
    stop(): void {
      if (intervalHandle) clearInterval(intervalHandle);
      deps.registry.off('session-added', onAdded);
      deps.registry.off('session-removed', onRemoved);
      for (const sid of Array.from(watches.keys())) detach(sid);
    },
    tick(): void {
      for (const sid of watches.keys()) evaluate(sid);
    },
  };
}
