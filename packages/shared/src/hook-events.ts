import { z } from 'zod';

/** Sesshin's normalized event vocabulary, agent-agnostic. */
export const NormalizedHookEventEnum = z.enum([
  'SessionStart', 'UserPromptSubmit',
  'PreToolUse', 'PostToolUse', 'PostToolUseFailure',
  'PermissionRequest', 'PermissionDenied',
  'Notification',
  'SubagentStart', 'SubagentStop',
  'PreCompact', 'PostCompact',
  'CwdChanged',
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
  PermissionDenied: 'PermissionDenied',
  Notification: 'Notification',
  SubagentStart: 'SubagentStart',
  SubagentStop: 'SubagentStop',
  PreCompact: 'PreCompact',
  PostCompact: 'PostCompact',
  CwdChanged: 'CwdChanged',
  Stop: 'Stop',
  StopFailure: 'StopFailure',
  SessionEnd: 'SessionEnd',
};

export function normalizeClaudeEvent(native: string): NormalizedHookEvent {
  const mapped = ClaudeHookMap[native];
  return mapped ?? 'agent-internal';
}
