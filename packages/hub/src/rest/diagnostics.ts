import type { ServerResponse } from 'node:http';
import type { SessionRegistry } from '../registry/session-registry.js';
import type { ApprovalManager } from '../approval-manager.js';
import { evaluateSessionLiveness } from '../session-liveness.js';

const HEARTBEAT_TIMEOUT_MS = 120_000;

export interface DiagnosticsDeps {
  registry: SessionRegistry;
  approvals: ApprovalManager;
  hasSubscribedActionsClient: (sessionId: string) => boolean;
  listClients: (sessionId: string | null) => ClientInfo[];
  historyForSession: (sessionId: string, n: number) => HistoryEntry[];
}

export interface ClientInfo {
  kind: string;
  capabilities: string[];
  subscribedTo: string[] | 'all';
}

export interface HistoryEntry {
  requestId: string;
  tool: string;
  resolvedAt: number;
  decision: 'allow' | 'deny' | 'ask';
  reason?: string;
}

export function diagnosticsSnapshot(deps: DiagnosticsDeps): {
  sessions: Array<{
    id: string;
    name: string;
    state: string;
    permissionMode: string;
    claudeSessionId: string | null;
    claudeAllowRules: string[];
    pendingApprovals: number;
    hasSubscribedActionsClient: boolean;
    lastHeartbeatAgeMs: number;
    heartbeatExpired: boolean;
    pidExists: boolean;
    pidMatchesSesshinProcess: boolean;
    sessionFilePath?: string;
  }>;
} {
  return {
    sessions: deps.registry.list().map((info) => {
      const rec = deps.registry.get(info.id)!;
      const liveness = evaluateSessionLiveness({
        pid: rec.pid,
        lastHeartbeat: rec.lastHeartbeat,
        heartbeatTimeoutMs: HEARTBEAT_TIMEOUT_MS,
      });
      return {
        id: info.id,
        name: info.name,
        state: info.state,
        permissionMode: info.substate.permissionMode,
        claudeSessionId: info.claudeSessionId,
        claudeAllowRules: rec.claudeAllowRules,
        pendingApprovals: deps.approvals.pendingForSession(info.id).length,
        hasSubscribedActionsClient: deps.hasSubscribedActionsClient(info.id),
        lastHeartbeatAgeMs: liveness.lastHeartbeatAgeMs,
        heartbeatExpired: liveness.heartbeatExpired,
        pidExists: liveness.pidExists,
        pidMatchesSesshinProcess: liveness.pidMatchesSesshinProcess,
        ...(rec.sessionFilePath ? { sessionFilePath: rec.sessionFilePath } : {}),
      };
    }),
  };
}

export function writeDiagnostics(res: ServerResponse, deps: DiagnosticsDeps): void {
  res.writeHead(200, { 'content-type': 'application/json' })
     .end(JSON.stringify(diagnosticsSnapshot(deps)));
}
