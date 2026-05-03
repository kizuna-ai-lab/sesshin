import type { EventBus, NormalizedEvent } from '../event-bus.js';
import type { SessionRegistry } from '../registry/session-registry.js';
import { transitionFor } from './machine.js';

export interface ApplierDeps { bus: EventBus; registry: SessionRegistry }

export function wireStateMachine(deps: ApplierDeps): void {
  deps.bus.on((e) => apply(e, deps.registry));
}

function apply(e: NormalizedEvent, registry: SessionRegistry): void {
  const session = registry.get(e.sessionId);
  if (!session) return;

  const next = transitionFor(session.state, e);
  if (next) registry.updateState(e.sessionId, next);

  // Substate updates per kind:
  if (e.kind === 'user-prompt') {
    registry.patchSubstate(e.sessionId, { elapsedSinceProgressMs: 0 });
  } else if (e.kind === 'tool-call') {
    const tool = (e.payload['tool'] as string | undefined) ?? null;
    registry.patchSubstate(e.sessionId, { currentTool: tool });
  } else if (e.kind === 'tool-result') {
    const tool = (e.payload['tool'] as string | undefined) ?? null;
    registry.patchSubstate(e.sessionId, { currentTool: null, lastTool: tool });
  } else if (e.kind === 'agent-internal') {
    // claude >= 2.1 hooks. Dispatch on nativeEvent (auto-filled from env.event
    // by hookEnvelopeToEvent). state stays where transitionFor put it; only
    // substate is updated here.
    switch (e.nativeEvent) {
      case 'SubagentStart':
        registry.patchSubstate(e.sessionId, { currentTool: 'Task' });
        break;
      case 'SubagentStop':
        registry.patchSubstate(e.sessionId, { currentTool: null, lastTool: 'Task' });
        break;
      case 'PreCompact':
        registry.patchSubstate(e.sessionId, { compacting: true });
        break;
      case 'PostCompact':
        registry.patchSubstate(e.sessionId, { compacting: false });
        break;
      case 'CwdChanged': {
        const cwd = e.payload['cwd'];
        if (typeof cwd === 'string') {
          registry.patchSubstate(e.sessionId, { cwd });
        }
        break;
      }
      // Notification / PermissionDenied: pure event-stream, no substate impact
      // (clients consume via session.event broadcast).
    }
  }
}
