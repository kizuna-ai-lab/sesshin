import { describe, it, expect } from 'vitest';
import { evaluateSessionLiveness } from './session-liveness.js';

describe('evaluateSessionLiveness', () => {
  it('reports missing pid as not alive', () => {
    const result = evaluateSessionLiveness({
      pid: 123,
      lastHeartbeat: Date.now(),
      heartbeatTimeoutMs: 120_000,
      pidExists: () => false,
      pidMatchesSesshinProcess: () => false,
      now: () => 1_000,
    });

    expect(result).toMatchObject({
      pidExists: false,
      pidMatchesSesshinProcess: false,
      heartbeatExpired: false,
      shouldKeep: false,
      reason: 'pid-missing',
    });
  });

  it('reports wrong process identity as stale immediately', () => {
    const result = evaluateSessionLiveness({
      pid: 123,
      lastHeartbeat: Date.now(),
      heartbeatTimeoutMs: 120_000,
      pidExists: () => true,
      pidMatchesSesshinProcess: () => false,
      now: () => 1_000,
    });

    expect(result).toMatchObject({
      pidExists: true,
      pidMatchesSesshinProcess: false,
      heartbeatExpired: false,
      shouldKeep: false,
      reason: 'pid-mismatch',
    });
  });

  it('expires matching process when heartbeat is too old', () => {
    const result = evaluateSessionLiveness({
      pid: 123,
      lastHeartbeat: 0,
      heartbeatTimeoutMs: 120_000,
      pidExists: () => true,
      pidMatchesSesshinProcess: () => true,
      now: () => 121_000,
    });

    expect(result).toMatchObject({
      pidExists: true,
      pidMatchesSesshinProcess: true,
      heartbeatExpired: true,
      shouldKeep: false,
      reason: 'heartbeat-expired',
    });
  });

  it('keeps matching process with fresh heartbeat', () => {
    const result = evaluateSessionLiveness({
      pid: 123,
      lastHeartbeat: 100_000,
      heartbeatTimeoutMs: 120_000,
      pidExists: () => true,
      pidMatchesSesshinProcess: () => true,
      now: () => 121_000,
    });

    expect(result).toMatchObject({
      pidExists: true,
      pidMatchesSesshinProcess: true,
      heartbeatExpired: false,
      shouldKeep: true,
      reason: 'healthy',
    });
    expect(result.lastHeartbeatAgeMs).toBe(21_000);
  });
});
