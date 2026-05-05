import { describe, it, expect } from 'vitest';
import { SessionRegistry } from './registry/session-registry.js';
import { reapStaleSessions, shouldRestoreSession, type ProcessLivenessProbe } from './wire-liveness.js';

function probe(overrides: Partial<ProcessLivenessProbe> = {}): ProcessLivenessProbe {
  return {
    pidExists: () => true,
    pidMatchesSesshinProcess: () => true,
    now: () => 200_000,
    ...overrides,
  };
}

describe('shouldRestoreSession', () => {
  it('skips restore when pid is missing', () => {
    const ok = shouldRestoreSession({ pid: 10, lastHeartbeat: 199_000 } as any, 120_000, probe({ pidExists: () => false }));
    expect(ok.shouldKeep).toBe(false);
    expect(ok.reason).toBe('pid-missing');
  });

  it('skips restore when process identity mismatches', () => {
    const ok = shouldRestoreSession({ pid: 10, lastHeartbeat: 199_000 } as any, 120_000, probe({ pidMatchesSesshinProcess: () => false }));
    expect(ok.shouldKeep).toBe(false);
    expect(ok.reason).toBe('pid-mismatch');
  });

  it('skips restore when heartbeat is expired', () => {
    const ok = shouldRestoreSession({ pid: 10, lastHeartbeat: 0 } as any, 120_000, probe());
    expect(ok.shouldKeep).toBe(false);
    expect(ok.reason).toBe('heartbeat-expired');
  });
});

describe('reapStaleSessions', () => {
  it('removes sessions with missing pid', () => {
    const registry = new SessionRegistry();
    registry.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 10, sessionFilePath: '/x' });

    const removed = reapStaleSessions(registry, 120_000, probe({ pidExists: () => false }));

    expect(removed).toEqual([{ sessionId: 's1', reason: 'pid-missing' }]);
    expect(registry.get('s1')).toBeUndefined();
  });

  it('removes sessions with wrong process identity', () => {
    const registry = new SessionRegistry();
    registry.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 10, sessionFilePath: '/x' });

    const removed = reapStaleSessions(registry, 120_000, probe({ pidMatchesSesshinProcess: () => false }));

    expect(removed).toEqual([{ sessionId: 's1', reason: 'pid-mismatch' }]);
    expect(registry.get('s1')).toBeUndefined();
  });

  it('removes sessions with expired heartbeat', () => {
    const registry = new SessionRegistry();
    registry.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 10, sessionFilePath: '/x' });
    registry.get('s1')!.lastHeartbeat = 0;

    const removed = reapStaleSessions(registry, 120_000, probe());

    expect(removed).toEqual([{ sessionId: 's1', reason: 'heartbeat-expired' }]);
    expect(registry.get('s1')).toBeUndefined();
  });
});
