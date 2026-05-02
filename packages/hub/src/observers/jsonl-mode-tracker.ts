import type { EventBus } from '../event-bus.js';
import type { SessionRegistry } from '../registry/session-registry.js';
import { PermissionModeEnum, type PermissionMode } from '@sesshin/shared';

const VALID_MODES = new Set<PermissionMode>(PermissionModeEnum.options);

export function wireJsonlModeTracker(deps: { bus: EventBus; registry: SessionRegistry }): void {
  deps.bus.on((e) => {
    if (e.kind !== 'agent-internal') return;
    if (e.payload['phase'] !== 'mode-change') return;
    const m = e.payload['mode'];
    if (typeof m !== 'string' || !VALID_MODES.has(m as PermissionMode)) return;
    deps.registry.setPermissionMode(e.sessionId, m as PermissionMode);
  });
}
