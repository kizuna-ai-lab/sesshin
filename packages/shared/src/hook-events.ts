import { z } from 'zod';

/** Sesshin's normalized event vocabulary, agent-agnostic. */
export const NormalizedHookEventEnum = z.enum([
  'SessionStart', 'UserPromptSubmit',
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'PermissionRequest',
  'Stop', 'StopFailure', 'SessionEnd',
  'agent-internal',
]);
export type NormalizedHookEvent = z.infer<typeof NormalizedHookEventEnum>;

/** Per-agent native → normalized mapping. */
export const ClaudeHookMap: Record<string, NormalizedHookEvent> = {
  SessionStart: 'SessionStart',
  UserPromptSubmit: 'UserPromptSubmit',
  PreToolUse: 'PreToolUse',
  PostToolUse: 'PostToolUse',
  PostToolUseFailure: 'PostToolUseFailure',
  PermissionRequest: 'PermissionRequest',
  Stop: 'Stop',
  StopFailure: 'StopFailure',
  SessionEnd: 'SessionEnd',
};

export function normalizeClaudeEvent(native: string): NormalizedHookEvent {
  const mapped = ClaudeHookMap[native];
  return mapped ?? 'agent-internal';
}
