import type { EventBus } from '../event-bus.js';
import type { SessionRegistry } from '../registry/session-registry.js';
import { hookEnvelopeToEvent, type HookEnvelope } from '../agents/claude/normalize-hook.js';

export interface HookIngestDeps { bus: EventBus; registry: SessionRegistry }

export function wireHookIngest(deps: HookIngestDeps): (env: HookEnvelope) => void {
  return (env) => {
    if (!deps.registry.get(env.sessionId)) return;
    const event = hookEnvelopeToEvent(env);
    deps.bus.emit(event);
  };
}
