import type { ServerResponse } from 'node:http';
import type { SessionRegistry } from '../registry/session-registry.js';
import type { ApprovalManager } from '../approval-manager.js';

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
    sessionAllowList: string[];
    claudeAllowRules: string[];
    pendingApprovals: number;
    hasSubscribedActionsClient: boolean;
    usesPermissionRequest: boolean;
  }>;
} {
  return {
    sessions: deps.registry.list().map((info) => {
      const rec = deps.registry.get(info.id)!;
      return {
        id: info.id,
        name: info.name,
        state: info.state,
        permissionMode: info.substate.permissionMode,
        sessionAllowList: rec.sessionAllowList,
        claudeAllowRules: rec.claudeAllowRules,
        pendingApprovals: deps.approvals.pendingForSession(info.id).length,
        hasSubscribedActionsClient: deps.hasSubscribedActionsClient(info.id),
        usesPermissionRequest: rec.usesPermissionRequest,
      };
    }),
  };
}

export function writeDiagnostics(res: ServerResponse, deps: DiagnosticsDeps): void {
  res.writeHead(200, { 'content-type': 'application/json' })
     .end(JSON.stringify(diagnosticsSnapshot(deps)));
}
