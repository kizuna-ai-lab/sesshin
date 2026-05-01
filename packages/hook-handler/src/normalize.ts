import { normalizeClaudeEvent, type NormalizedHookEvent } from '@sesshin/shared';

export function normalize(agent: string, nativeEvent: string): NormalizedHookEvent {
  if (agent === 'claude-code') return normalizeClaudeEvent(nativeEvent);
  return 'agent-internal';
}
