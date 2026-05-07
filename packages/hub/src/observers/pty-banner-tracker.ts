import XtermHeadless from '@xterm/headless';
import type { PtyTap } from './pty-tap.js';
import type { SessionRegistry } from '../registry/session-registry.js';
import type { PermissionMode } from '@sesshin/shared';

type XtermTerminal = InstanceType<typeof import('@xterm/headless').Terminal>;
const { Terminal } = XtermHeadless as unknown as {
  Terminal: typeof import('@xterm/headless').Terminal;
};

// Mode banner anchors. cc renders the bottom-of-prompt mode banner as
// `<symbol> <permissionModeTitle(mode).toLowerCase()> on [(<shortcut> to cycle)]`
// (PromptInputFooterLeftSide.tsx:348-355 in cc 2.1.132). Each anchor includes
// the leading mode symbol so user-typed text like "plan mode on Saturday" can
// never false-match — the symbols are non-keyboard Unicode glyphs.
//
// Symbols (cc 2.1.132): plan = "⏸"; acceptEdits / auto / bypassPermissions /
// dontAsk = "⏵⏵". Source: $_q[mode].symbol dictionary in the bundle.
//
// `default` has no banner — the renderer is gated by `!isDefaultMode(mode)`,
// so absence of any anchor on the rendered viewport implies default (after we
// have positively observed at least one anchor; see `everSawAnchor`).
const SYM_DOUBLE_TRIANGLE = '⏵⏵';
const SYM_PAUSE           = '⏸';

const MODE_ANCHORS: ReadonlyArray<readonly [string, PermissionMode]> = [
  [`${SYM_DOUBLE_TRIANGLE} accept edits on`,       'acceptEdits'],
  [`${SYM_PAUSE} plan mode on`,                    'plan'],
  [`${SYM_DOUBLE_TRIANGLE} auto mode on`,          'auto'],
  [`${SYM_DOUBLE_TRIANGLE} bypass permissions on`, 'bypassPermissions'],
  [`${SYM_DOUBLE_TRIANGLE} don't ask on`,          'dontAsk'],
];

export interface BannerTrackerConfig {
  /**
   * Width of the headless terminal we use for screen reconstruction. Falls
   * back to the registered session's `cols` if available, else 80.
   */
  defaultCols?:        number;
  /** Default rows for the headless terminal. Falls back to session rows else 24. */
  defaultRows?:        number;
}

const DEFAULT_CONFIG: Required<BannerTrackerConfig> = {
  defaultCols:      80,
  defaultRows:      24,
};

// Set SESSHIN_BANNER_DEBUG=1 to dump per-detection diagnostics to stderr.
// Useful when investigating "tracker isn't picking up the mode change" bugs
// without spinning up the web debug panel — pair with `tail -f` on hub logs.
const DEBUG = process.env['SESSHIN_BANNER_DEBUG'] === '1';

function debugDump(
  sessionId: string,
  w: { term: XtermTerminal; everSawAnchor: boolean },
  anchored: PermissionMode | null,
): void {
  const buf = w.term.buffer.active;
  const viewportStart = Math.max(0, buf.length - w.term.rows);
  const lines: string[] = [];
  for (let i = viewportStart; i < buf.length; i++) {
    const line = buf.getLine(i);
    lines.push(`[${i.toString().padStart(4, ' ')}] ${line ? line.translateToString(true) : ''}`);
  }
  const head = `[banner-debug ${sessionId}] anchored=${anchored ?? 'null'} everSawAnchor=${w.everSawAnchor} cursor=(${buf.cursorY},${buf.cursorX}) bufLen=${buf.length} rows=${w.term.rows}`;
  process.stderr.write(head + '\n' + lines.join('\n') + '\n');
}

/** Diagnostic snapshot of one session's banner-detection state. */
export interface BannerDiagnostic {
  sessionId:      string;
  cols:           number;
  rows:           number;
  bufferLength:   number;
  cursorRow:      number;
  cursorCol:      number;
  viewportStart:  number;
  /** Each visible row's plain text (ANSI stripped, trailing whitespace trimmed). */
  viewportRows:   Array<{ index: number; text: string }>;
  /** What `detectAnchorMode` returns right now. null if no anchor on viewport. */
  detectedMode:   PermissionMode | null;
  everSawAnchor:  boolean;
  /** Per-anchor lastIndexOf result in the joined viewport text. -1 if absent. */
  anchorMatches:  Array<{ anchor: string; mode: PermissionMode; index: number }>;
}

export interface BannerTrackerInstance {
  stop(): void;
  /** Test hook: force a re-evaluation of `sessionId`'s screen state. */
  evaluate(sessionId: string): void;
  /**
   * Test hook: returns a promise that resolves the next time detection runs
   * for `sessionId` (xterm-headless parses the chunk and calls our callback).
   * Useful in tests where `await` on a setTimeout/setImmediate isn't reliable
   * because xterm's internal write queue uses its own scheduling.
   */
  waitForNextDetection(sessionId: string): Promise<void>;
  /**
   * Diagnostic: dump the headless terminal's current viewport content for
   * `sessionId`. Returns null if the session isn't being tracked. Used by
   * the REST `/banner-debug` endpoint and the web debug panel to inspect
   * what the detector sees vs. what the user observes on the real TUI.
   */
  inspectSession(sessionId: string): BannerDiagnostic | null;
}

interface SessionWatch {
  term:           XtermTerminal;
  /** Resolvers waiting for the next detection callback. Drained in FIFO order. */
  pendingWaiters: Array<() => void>;
  /**
   * True once we have positively detected an active-mode anchor on this
   * session's screen. Until then, "no anchor visible" means "no observation"
   * — NOT "mode is default" — so we leave registry.permissionMode alone (it
   * may have been set by REST register with initialPermissionMode, which we
   * must not clobber while cc is still booting and hasn't drawn the footer
   * banner yet).
   *
   * Once we have seen at least one anchor, the tracker takes ownership: a
   * subsequent absence of any anchor on the viewport is interpreted as a
   * transition to default (cc draws no banner for default mode).
   */
  everSawAnchor:  boolean;
  unsub:          () => void;
}

export interface BannerTrackerDeps {
  tap:      PtyTap;
  registry: SessionRegistry;
  config?:  BannerTrackerConfig;
}

export function wirePtyBannerTracker(deps: BannerTrackerDeps): BannerTrackerInstance {
  const cfg: Required<BannerTrackerConfig> = { ...DEFAULT_CONFIG, ...(deps.config ?? {}) };
  const watches = new Map<string, SessionWatch>();

  /**
   * Reads the visible viewport (last `term.rows` rows of the active buffer)
   * as plain text and scans for the most recently visible mode anchor. Returns
   * null if no anchor is on screen.
   *
   * Key property: this reflects what's CURRENTLY VISIBLE. cc's in-place
   * cursor-position-overwrite + erase-line semantics are honored by xterm —
   * an erased banner is GONE from the buffer, so we don't false-detect it.
   *
   * We scan only the visible viewport (NOT scrollback) so an old banner that
   * scrolled off-screen never false-matches. Within the viewport, banner
   * symbols (⏵⏵, ⏸) are non-keyboard glyphs that user-typed text effectively
   * never contains, so anchor lookup is safe even if the banner row index
   * varies between cc renders.
   */
  function detectAnchorMode(term: XtermTerminal): PermissionMode | null {
    const buf = term.buffer.active;
    const viewportStart = Math.max(0, buf.length - term.rows);
    let text = '';
    for (let i = viewportStart; i < buf.length; i++) {
      const line = buf.getLine(i);
      if (line) text += line.translateToString(true) + '\n';
    }
    let bestIdx = -1;
    let bestMode: PermissionMode | null = null;
    for (const [anchor, mode] of MODE_ANCHORS) {
      const idx = text.lastIndexOf(anchor);
      if (idx > bestIdx) {
        bestIdx = idx;
        bestMode = mode;
      }
    }
    return bestMode;
  }

  function applyDetection(sessionId: string, w: SessionWatch): void {
    const anchored = detectAnchorMode(w.term);
    if (anchored !== null) {
      w.everSawAnchor = true;
      deps.registry.setPermissionMode(sessionId, anchored);
    } else if (w.everSawAnchor) {
      // We previously locked onto an anchor but it has since vanished from
      // the rendered viewport — cc redrew the footer without a banner, i.e.
      // mode is now default.
      deps.registry.setPermissionMode(sessionId, 'default');
    }
    // else: never observed an anchor for this session — treat current chunks
    // as pre-banner startup output and leave the registry mode (set by REST
    // initialPermissionMode) untouched.
    if (DEBUG) debugDump(sessionId, w, anchored);
    // Drain any test-side waiters now that detection has completed.
    if (w.pendingWaiters.length > 0) {
      const drained = w.pendingWaiters;
      w.pendingWaiters = [];
      for (const r of drained) r();
    }
  }

  function evaluate(sessionId: string): void {
    const w = watches.get(sessionId);
    if (!w) return;
    applyDetection(sessionId, w);
  }

  function attach(sessionId: string): void {
    if (watches.has(sessionId)) return;
    const session = deps.registry.get(sessionId);
    const cols = session?.cols && session.cols > 0 ? session.cols : cfg.defaultCols;
    const rows = session?.rows && session.rows > 0 ? session.rows : cfg.defaultRows;
    // We maintain our own headless terminal — independent of the WS-facing
    // `terminals` map in wire.ts — so the banner tracker has no ordering
    // dependency on the WS HeadlessTerm subscription. xterm-headless is
    // light enough (~tens of KB per terminal) that the duplication is fine.
    const term = new Terminal({
      cols,
      rows,
      scrollback: 1_000,
      allowProposedApi: true,
      convertEol: false,
    });
    const w: SessionWatch = {
      term,
      everSawAnchor:  false,
      pendingWaiters: [],
      unsub:          () => undefined,
    };
    w.unsub = deps.tap.subscribe(sessionId, (chunk) => {
      // xterm-headless `write` is asynchronous: it queues the chunk and
      // parses it on a microtask. The buffer state isn't valid for read
      // until the callback fires, so detection MUST run in the callback.
      term.write(chunk, () => applyDetection(sessionId, w));
    });
    watches.set(sessionId, w);
  }

  function detach(sessionId: string): void {
    const w = watches.get(sessionId);
    if (!w) return;
    w.unsub();
    w.term.dispose();
    watches.delete(sessionId);
  }

  function resize(sessionId: string, cols: number, rows: number): void {
    if (cols <= 0 || rows <= 0) return;
    const w = watches.get(sessionId);
    if (!w) return;
    if (w.term.cols === cols && w.term.rows === rows) return;
    w.term.resize(cols, rows);
  }

  for (const s of deps.registry.list()) attach(s.id);
  const onAdded   = (info: { id: string }): void => attach(info.id);
  const onRemoved = (id: string): void => detach(id);
  const onResize  = (info: { id: string; cols?: number; rows?: number }): void => {
    if (info.cols && info.rows) resize(info.id, info.cols, info.rows);
  };
  deps.registry.on('session-added', onAdded);
  deps.registry.on('session-removed', onRemoved);
  deps.registry.on('winsize-changed', onResize);

  return {
    stop(): void {
      deps.registry.off('session-added', onAdded);
      deps.registry.off('session-removed', onRemoved);
      deps.registry.off('winsize-changed', onResize);
      for (const id of Array.from(watches.keys())) detach(id);
    },
    evaluate,
    waitForNextDetection(sessionId: string): Promise<void> {
      const w = watches.get(sessionId);
      if (!w) return Promise.resolve();
      return new Promise<void>((resolve) => {
        w.pendingWaiters.push(resolve);
      });
    },
    inspectSession(sessionId: string): BannerDiagnostic | null {
      const w = watches.get(sessionId);
      if (!w) return null;
      const buf = w.term.buffer.active;
      const viewportStart = Math.max(0, buf.length - w.term.rows);
      const viewportRows: Array<{ index: number; text: string }> = [];
      let viewportText = '';
      for (let i = viewportStart; i < buf.length; i++) {
        const line = buf.getLine(i);
        const text = line ? line.translateToString(true) : '';
        viewportRows.push({ index: i, text });
        viewportText += text + '\n';
      }
      const anchorMatches = MODE_ANCHORS.map(([anchor, mode]) => ({
        anchor,
        mode,
        index: viewportText.lastIndexOf(anchor),
      }));
      return {
        sessionId,
        cols:          w.term.cols,
        rows:          w.term.rows,
        bufferLength:  buf.length,
        cursorRow:     buf.cursorY,
        cursorCol:     buf.cursorX,
        viewportStart,
        viewportRows,
        detectedMode:  detectAnchorMode(w.term),
        everSawAnchor: w.everSawAnchor,
        anchorMatches,
      };
    },
  };
}
