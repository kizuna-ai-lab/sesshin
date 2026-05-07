import { describe, it, expect } from 'vitest';
import type { RateLimitsState } from '@sesshin/shared';
import { SessionRegistry } from './session-registry.js';

function makeReg() { return new SessionRegistry(); }

describe('SessionRegistry', () => {
  it('register assigns a stable id and stores the session', () => {
    const r = makeReg();
    const s = r.register({
      id: 's1', name: 'claude (myproj)', agent: 'claude-code',
      cwd: '/home/me', pid: 1234, sessionFilePath: '/x/s1.jsonl'
    });
    expect(s.id).toBe('s1');
    expect(r.get('s1')).toMatchObject({ id: 's1', state: 'starting' });
  });
  it('register initializes lifecycle fields (endedAt/endReason/hidden)', () => {
    const r = makeReg();
    r.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    const rec = r.get('s1')!;
    expect(rec.endedAt).toBeNull();
    expect(rec.endReason).toBeNull();
    expect(rec.hidden).toBe(false);
  });
  it('unregister returns true on existing id, false on missing', () => {
    const r = makeReg();
    r.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    expect(r.unregister('s1')).toBe(true);
    expect(r.unregister('s1')).toBe(false);
  });
  it('updateState mutates and emits an event', () => {
    const r = makeReg();
    r.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    const events: string[] = [];
    r.on('state-changed', (s) => events.push(s.state));
    r.updateState('s1', 'running');
    expect(r.get('s1')?.state).toBe('running');
    expect(events).toEqual(['running']);
  });
  it('list returns a snapshot (mutations to it do not affect the registry)', () => {
    const r = makeReg();
    r.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    const snap = r.list();
    snap.length = 0;
    expect(r.list()).toHaveLength(1);
  });
  it('setSessionFilePath updates the path and resets the cursor; returns false when unchanged', () => {
    const r = makeReg();
    r.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x.jsonl' });
    r.setFileCursor('s1', 42);
    expect(r.setSessionFilePath('s1', '/y.jsonl')).toBe(true);
    expect(r.get('s1')?.sessionFilePath).toBe('/y.jsonl');
    expect(r.get('s1')?.fileTailCursor).toBe(0);
    expect(r.setSessionFilePath('s1', '/y.jsonl')).toBe(false);
    expect(r.setSessionFilePath('missing', '/z.jsonl')).toBe(false);
  });
  it('setPermissionMode updates substate, emits substate-changed, idempotent on no-op', () => {
    const r = makeReg();
    r.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    const events: string[] = [];
    r.on('substate-changed', (s) => events.push(s.substate.permissionMode));
    expect(r.setPermissionMode('s1', 'auto')).toBe(true);
    expect(r.get('s1')?.substate.permissionMode).toBe('auto');
    expect(r.setPermissionMode('s1', 'auto')).toBe(false); // no-op
    expect(events).toEqual(['auto']);
    expect(r.setPermissionMode('missing', 'plan')).toBe(false);
  });
});

describe('SessionRegistry — publicView surfaces sessionFilePath', () => {
  it('list() includes sessionFilePath when non-empty', () => {
    const r = makeReg();
    r.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/path/to/transcript.jsonl' });
    expect(r.list()[0]!.sessionFilePath).toBe('/path/to/transcript.jsonl');
  });
  it('list() omits sessionFilePath when empty (placeholder not yet replaced by SessionStart)', () => {
    const r = makeReg();
    r.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '' });
    expect(r.list()[0]!.sessionFilePath).toBeUndefined();
  });
  it('emitted session-added view also surfaces it', () => {
    const r = makeReg();
    let captured: { sessionFilePath?: string | undefined; claudeSessionId: string | null } = { claudeSessionId: null };
    r.on('session-added', (s) => { captured = s; });
    r.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/p.jsonl' });
    expect(captured.sessionFilePath).toBe('/p.jsonl');
  });
  it('publicView does NOT leak hub-private fields', () => {
    const r = makeReg();
    r.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/p.jsonl' });
    const view = r.list()[0] as Record<string, unknown>;
    expect('lastHeartbeat' in view).toBe(false);
    expect('fileTailCursor' in view).toBe(false);
    expect('rateLimits' in view).toBe(false);
    // dropped sticky-config fields no longer exist anywhere on the record:
    expect('claudeAllowRules' in view).toBe(false);
    expect('pin' in view).toBe(false);
    expect('quietUntil' in view).toBe(false);
    expect('sessionGateOverride' in view).toBe(false);
  });
});

describe('winsize-changed event', () => {
  it('setSessionWinsize emits winsize-changed only on actual change', () => {
    const r = new SessionRegistry();
    r.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x', cols: 80, rows: 24 });
    const events: any[] = [];
    r.on('winsize-changed', (info) => events.push(info));
    expect(r.setSessionWinsize('s1', 100, 30)).toBe(true);
    expect(events).toHaveLength(1);
    expect(events[0]!.cols).toBe(100);
    expect(events[0]!.rows).toBe(30);
    // No-op (same size) should not emit.
    expect(r.setSessionWinsize('s1', 100, 30)).toBe(true);
    expect(events).toHaveLength(1);
  });

  it('setSessionWinsize rejects invalid sizes', () => {
    const r = new SessionRegistry();
    r.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    expect(r.setSessionWinsize('s1', 0, 24)).toBe(false);
    expect(r.setSessionWinsize('s1', 80, -1)).toBe(false);
    expect(r.setSessionWinsize('missing', 80, 24)).toBe(false);
  });
});

describe('claudeSessionId tracking', () => {
  it('starts null', () => {
    const r = new SessionRegistry();
    r.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '' });
    expect(r.get('s1')?.claudeSessionId).toBeNull();
  });

  it('setClaudeSessionId returns true on change, false on no-op or unknown', () => {
    const r = new SessionRegistry();
    r.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '' });
    expect(r.setClaudeSessionId('s1', 'cc-1')).toBe(true);
    expect(r.setClaudeSessionId('s1', 'cc-1')).toBe(false);
    expect(r.setClaudeSessionId('s1', 'cc-2')).toBe(true);
    expect(r.get('s1')?.claudeSessionId).toBe('cc-2');
    expect(r.setClaudeSessionId('unknown', 'cc-x')).toBe(false);
  });

  it('clearClaudeSessionId returns true only when going non-null → null', () => {
    const r = new SessionRegistry();
    r.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '' });
    // No-op when already null
    expect(r.clearClaudeSessionId('s1')).toBe(false);
    r.setClaudeSessionId('s1', 'cc-1');
    expect(r.clearClaudeSessionId('s1')).toBe(true);
    expect(r.get('s1')?.claudeSessionId).toBeNull();
    // No-op on unknown session
    expect(r.clearClaudeSessionId('unknown')).toBe(false);
  });

  it('publicView surfaces claudeSessionId after setClaudeSessionId', () => {
    const r = new SessionRegistry();
    r.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    r.setClaudeSessionId('s1', 'cc-1');
    const view = r.list().find((s) => s.id === 's1')!;
    expect(view.claudeSessionId).toBe('cc-1');
  });
});

describe('resetChildScopedState', () => {
  it('clears fileTailCursor and lastSummaryId', () => {
    const r = new SessionRegistry();
    r.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    r.setFileCursor('s1', 999);
    r.setLastSummary('s1', 'sum-1');
    r.resetChildScopedState('s1');
    const rec = r.get('s1');
    expect(rec?.fileTailCursor).toBe(0);
    expect(rec?.lastSummaryId).toBeNull();
  });

  it('does not touch sessionFilePath', () => {
    const r = new SessionRegistry();
    r.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/some/transcript.jsonl' });
    r.resetChildScopedState('s1');
    expect(r.get('s1')?.sessionFilePath).toBe('/some/transcript.jsonl');
  });

  it('no-op on unknown session', () => {
    const r = new SessionRegistry();
    expect(() => r.resetChildScopedState('unknown')).not.toThrow();
  });
});

describe('rateLimits', () => {
  it('returns null before any setRateLimits call', () => {
    const reg = new SessionRegistry();
    reg.register({ id: 's1', name: 'a', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    expect(reg.getRateLimits('s1')).toBeNull();
  });

  it('round-trips a state via setRateLimits / getRateLimits', () => {
    const reg = new SessionRegistry();
    reg.register({ id: 's1', name: 'a', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    const state: RateLimitsState = {
      five_hour: { used_percentage: 45, resets_at: 100 },
      seven_day: null,
      observed_at: 999,
    };
    reg.setRateLimits('s1', state);
    expect(reg.getRateLimits('s1')).toEqual(state);
  });

  it('setRateLimits on unknown session is a no-op (returns false)', () => {
    const reg = new SessionRegistry();
    expect(reg.setRateLimits('missing', { five_hour: null, seven_day: null, observed_at: 1 })).toBe(false);
  });
});
