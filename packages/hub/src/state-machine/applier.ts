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
  }
}
