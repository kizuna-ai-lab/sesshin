import { describe, it, expect, beforeEach } from 'vitest';
import { wirePtyBannerTracker } from './pty-banner-tracker.js';
import { PtyTap } from './pty-tap.js';
import { SessionRegistry } from '../registry/session-registry.js';
import type { PermissionMode } from '@sesshin/shared';

function makeFixture() {
  const tap = new PtyTap({ ringBytes: 64 * 1024 });
  const registry = new SessionRegistry();
  registry.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
  const tracker = wirePtyBannerTracker({ tap, registry });
  const events: PermissionMode[] = [];
  registry.on('substate-changed', (s) => {
    if (s.id === 's1') events.push(s.substate.permissionMode);
  });
  // xterm-headless `write` is asynchronous and uses its own internal
  // scheduler (not microtask-only), so plain `setImmediate` doesn't reliably
  // wait for parsing. The tracker exposes `waitForNextDetection` which
  // resolves once xterm has parsed the chunk and detection has completed —
  // that's the only sound synchronization point.
  return {
    tap, registry, tracker, events,
    async feed(s: string): Promise<void> {
      const next = tracker.waitForNextDetection('s1');
      tap.append('s1', Buffer.from(s, 'utf-8'));
      await next;
    },
    async feedSession(id: string, s: string): Promise<void> {
      const next = tracker.waitForNextDetection(id);
      tap.append(id, Buffer.from(s, 'utf-8'));
      await next;
    },
    mode(): PermissionMode {
      return registry.get('s1')!.substate.permissionMode;
    },
  };
}

// Builds a banner string the way cc Ink renders it, positioned on a specific
// screen row via cursor-set-position. Defaults to row 23 (1-indexed in ANSI →
// last row of a 24-row terminal). cc uses ⏸ for plan, ⏵⏵ otherwise.
function bannerAt(row: number, title: string, symbol = '⏵⏵'): string {
  return `\x1b[${row};1H\x1b[K\x1b[33m${symbol} ${title} on \x1b[2m(shift+tab to cycle)\x1b[0m`;
}
function banner(title: string, symbol = '⏵⏵'): string {
  return bannerAt(23, title, symbol);
}

describe('wirePtyBannerTracker', () => {
  let f: ReturnType<typeof makeFixture>;
  beforeEach(() => { f = makeFixture(); });

  it('starts in default mode (registry default)', () => {
    expect(f.mode()).toBe('default');
  });

  it("'accept edits on' banner -> mode = acceptEdits", async () => {
    await f.feed(banner('accept edits'));
    expect(f.mode()).toBe('acceptEdits');
  });

  it("'plan mode on' banner -> mode = plan (uses ⏸ symbol)", async () => {
    await f.feed(banner('plan mode', '⏸'));
    expect(f.mode()).toBe('plan');
  });

  it("'auto mode on' banner -> mode = auto", async () => {
    await f.feed(banner('auto mode'));
    expect(f.mode()).toBe('auto');
  });

  it("'bypass permissions on' banner -> mode = bypassPermissions", async () => {
    await f.feed(banner('bypass permissions'));
    expect(f.mode()).toBe('bypassPermissions');
  });

  it("'don't ask on' banner -> mode = dontAsk", async () => {
    await f.feed(banner("don't ask"));
    expect(f.mode()).toBe('dontAsk');
  });

  it('switching from one active mode to another updates promptly (acceptEdits -> plan)', async () => {
    await f.feed(banner('accept edits'));
    expect(f.mode()).toBe('acceptEdits');
    // Real cc rewrites the same row with the new banner. The terminal emulator
    // overwrites the row in place, so the old banner is gone from the buffer.
    await f.feed(banner('plan mode', '⏸'));
    expect(f.mode()).toBe('plan');
  });

  it('substate-changed fires only when mode actually changes (dedup)', async () => {
    await f.feed(banner('plan mode', '⏸'));
    await f.feed(banner('plan mode', '⏸'));
    await f.feed(banner('plan mode', '⏸'));
    const planEvents = f.events.filter((m) => m === 'plan').length;
    expect(planEvents).toBe(1);
  });

  it('embedded ANSI between symbol and title still matches', async () => {
    await f.feed('\x1b[2J\x1b[H\x1b[23;1H\x1b[33m⏸\x1b[0m \x1b[36mplan mode on\x1b[0m \x1b[2m(shift+tab to cycle)\x1b[0m');
    expect(f.mode()).toBe('plan');
  });

  it('OSC sequence (e.g. window-title) in stream does not pollute matching', async () => {
    await f.feed('\x1b]0;some title\x07' + banner('auto mode'));
    expect(f.mode()).toBe('auto');
  });

  it('user typing "plan mode on" without ⏸ symbol is NOT a false positive', async () => {
    // Echo of user input in the prompt area: "> plan mode on" with no symbol.
    await f.feed('\x1b[2;1H> plan mode on');
    expect(f.mode()).toBe('default');
  });

  it('chat text "auto mode on weekends" is NOT a false positive (no ⏵⏵ symbol)', async () => {
    await f.feed('I want auto mode on weekends.\n');
    expect(f.mode()).toBe('default');
  });

  it('user input with the wrong symbol (⏵⏵ for plan) does not match plan', async () => {
    await f.feed('Note: "⏵⏵ plan mode on" is wrong; the real plan banner uses ⏸.\n');
    expect(f.mode()).toBe('default');
  });

  it('paste of an exact banner literal is a known false-positive edge case', async () => {
    // Pasting "⏸ plan mode on" into the prompt currently false-matches; the
    // tracker has no way to distinguish a real footer banner from echoed
    // input without additional layout-aware heuristics. Documented as a
    // known limitation and asserted for regression visibility.
    await f.feed('Paste: "⏸ plan mode on" — see the docs.\n');
    expect(f.mode()).toBe('plan');
  });

  it('cc clearing the banner row -> mode flips to default (auto -> default)', async () => {
    await f.feed(banner('auto mode'));
    expect(f.mode()).toBe('auto');
    // cc Ink redraws the footer row without a banner. Realistic ANSI: cursor
    // to that row, erase the line.
    await f.feed('\x1b[23;1H\x1b[K');
    expect(f.mode()).toBe('default');
  });

  it('default -> acceptEdits transitions promptly', async () => {
    await f.feed(banner('accept edits'));
    expect(f.mode()).toBe('acceptEdits');
  });

  it('full mode round-trip: default -> auto -> default -> acceptEdits -> plan -> default', async () => {
    expect(f.mode()).toBe('default');
    await f.feed(banner('auto mode'));               expect(f.mode()).toBe('auto');
    await f.feed('\x1b[23;1H\x1b[K');                expect(f.mode()).toBe('default');
    await f.feed(banner('accept edits'));            expect(f.mode()).toBe('acceptEdits');
    await f.feed(banner('plan mode', '⏸'));          expect(f.mode()).toBe('plan');
    await f.feed('\x1b[23;1H\x1b[K');                expect(f.mode()).toBe('default');
  });

  it('chunk split across symbol-title boundary still matches once both arrive', async () => {
    await f.feed('\x1b[23;1H\x1b[33m⏵⏵ accept edi');
    expect(f.mode()).toBe('default');
    await f.feed('ts on \x1b[0m');
    expect(f.mode()).toBe('acceptEdits');
  });

  it('multiple sessions are tracked independently', async () => {
    f.registry.register({ id: 's2', name: 'n2', agent: 'claude-code', cwd: '/', pid: 2, sessionFilePath: '/y' });
    await f.feedSession('s2', banner('plan mode', '⏸'));
    await f.feed(banner('auto mode'));
    expect(f.registry.get('s1')!.substate.permissionMode).toBe('auto');
    expect(f.registry.get('s2')!.substate.permissionMode).toBe('plan');
  });

  it('stop() detaches subscriptions; new chunks are ignored', async () => {
    f.tracker.stop();
    await f.feed(banner('plan mode', '⏸'));
    expect(f.mode()).toBe('default');
  });

  it('sessions registered after wireup are auto-attached', async () => {
    f.registry.register({ id: 's3', name: 'n3', agent: 'claude-code', cwd: '/', pid: 3, sessionFilePath: '/z' });
    await f.feedSession('s3', banner('bypass permissions'));
    expect(f.registry.get('s3')!.substate.permissionMode).toBe('bypassPermissions');
  });

  it('preserves an initial non-default mode while cc has not yet drawn the banner (startup race)', async () => {
    // Reproduces the regression where the tracker would clobber the
    // REST-registered initialPermissionMode with `default` on the first
    // pre-banner chunk (cc start-up logo, init messages, blank screen).
    f.registry.setPermissionMode('s1', 'auto');
    expect(f.mode()).toBe('auto');

    // Simulate a few rounds of cc startup output before any banner is drawn.
    await f.feed('\x1b[2J\x1b[H');
    await f.feed('Welcome to Claude Code 2.1.132\n');
    await f.feed('Loading workspace...\n');
    await f.feed('\x1b[2;1Hready');

    // Initial mode must be preserved — tracker has no anchor evidence, so it
    // must NOT volunteer `default`.
    expect(f.mode()).toBe('auto');
  });

  it('never volunteers default until at least one anchor has been observed', async () => {
    f.registry.setPermissionMode('s1', 'plan');
    for (let i = 0; i < 50; i++) await f.feed('arbitrary noise without any banner\n');
    expect(f.mode()).toBe('plan');
  });

  it('after observing an anchor, transitions to default once the banner is erased', async () => {
    await f.feed(banner('accept edits'));
    expect(f.mode()).toBe('acceptEdits');
    // cc redraws footer with banner gone (cursor + erase line).
    await f.feed('\x1b[23;1H\x1b[K');
    expect(f.mode()).toBe('default');
  });

  it('banner that scrolled off-screen does not false-match', async () => {
    // Put the banner on row 23, then push out-of-viewport content so the
    // banner scrolls into scrollback. The tracker scans only the visible
    // viewport, so a scrollback-only anchor must not register.
    await f.feed(banner('accept edits'));
    expect(f.mode()).toBe('acceptEdits');
    // 30 newlines forces ≥6 rows of scroll on a 24-row terminal, scrolling
    // row 23's content into scrollback.
    await f.feed('\n'.repeat(30));
    expect(f.mode()).toBe('default');
  });

  it('config-changed event resizes the internal terminal', async () => {
    await f.feed(banner('auto mode'));
    expect(f.mode()).toBe('auto');
    // Trigger a resize via registry; tracker should keep working.
    f.registry.setSessionWinsize('s1', 100, 30);
    await f.feed(bannerAt(29, 'plan mode', '⏸'));
    expect(f.mode()).toBe('plan');
  });

  it('inspectSession returns viewport dump + per-anchor matches', async () => {
    await f.feed(banner('plan mode', '⏸'));
    const diag = f.tracker.inspectSession('s1');
    expect(diag).not.toBeNull();
    expect(diag!.cols).toBe(80);
    expect(diag!.rows).toBe(24);
    expect(diag!.detectedMode).toBe('plan');
    expect(diag!.everSawAnchor).toBe(true);
    expect(diag!.viewportRows.length).toBe(24);
    const planMatch = diag!.anchorMatches.find((m) => m.mode === 'plan');
    expect(planMatch).toBeDefined();
    expect(planMatch!.index).toBeGreaterThanOrEqual(0);
    const autoMatch = diag!.anchorMatches.find((m) => m.mode === 'auto');
    expect(autoMatch!.index).toBe(-1);
  });

  it('inspectSession returns null for unknown session', () => {
    expect(f.tracker.inspectSession('nope')).toBeNull();
  });
});
