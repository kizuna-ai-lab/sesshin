import type { EventBus } from '../event-bus.js';
import type { SessionRegistry } from '../registry/session-registry.js';
import { hookEnvelopeToEvent, type HookEnvelope } from '../agents/claude/normalize-hook.js';
import { isPermissionMode } from '@sesshin/shared';

export interface HookIngestDeps { bus: EventBus; registry: SessionRegistry }

export function wireHookIngest(deps: HookIngestDeps): (env: HookEnvelope) => void {
  return (env) => {
    if (!deps.registry.get(env.sessionId)) return;
    // Mode fallback: cc's createBaseHookInput stamps permission_mode into the
    // input JSON of every tool/turn-boundary hook (PreToolUse, PostToolUse,
    // Stop, UserPromptSubmit, etc.). The PTY banner tracker is the primary
    // real-time source — but a hook value at a tool boundary is authoritative
    // for that moment, so we trust it as a corroborating fallback.
    // setPermissionMode dedups, so this is a no-op when PTY already saw it.
    const m = env.raw['permission_mode'];
    if (typeof m === 'string' && isPermissionMode(m)) {
      deps.registry.setPermissionMode(env.sessionId, m);
    }
    const event = hookEnvelopeToEvent(env);
    deps.bus.emit(event);
  };
}
