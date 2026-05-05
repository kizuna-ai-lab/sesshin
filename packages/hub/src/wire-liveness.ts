import type { SessionRecord, SessionRegistry } from './registry/session-registry.js';
import { evaluateSessionLiveness, type SessionLivenessResult } from './session-liveness.js';

export interface ProcessLivenessProbe {
  pidExists?: (pid: number) => boolean;
  pidMatchesSesshinProcess?: (pid: number) => boolean;
  now?: () => number;
}

export function shouldRestoreSession(
  session: Pick<SessionRecord, 'pid' | 'lastHeartbeat'>,
  heartbeatTimeoutMs: number,
  probe: ProcessLivenessProbe = {},
): SessionLivenessResult {
  return evaluateSessionLiveness({
    pid: session.pid,
    lastHeartbeat: session.lastHeartbeat,
    heartbeatTimeoutMs,
    ...probe,
  });
}

export function reapStaleSessions(
  registry: SessionRegistry,
  heartbeatTimeoutMs: number,
  probe: ProcessLivenessProbe = {},
): Array<{ sessionId: string; reason: SessionLivenessResult['reason'] }> {
  const removed: Array<{ sessionId: string; reason: SessionLivenessResult['reason'] }> = [];
  for (const session of registry.list()) {
    const rec = registry.get(session.id);
    if (!rec) continue;
    const liveness = shouldRestoreSession(rec, heartbeatTimeoutMs, probe);
    if (liveness.shouldKeep) continue;
    registry.unregister(rec.id);
    removed.push({ sessionId: rec.id, reason: liveness.reason });
  }
  return removed;
}
