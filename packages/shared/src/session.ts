import { z } from 'zod';

export const SessionStateEnum = z.enum([
  'starting', 'idle', 'running',
  'awaiting-input', 'awaiting-confirmation',
  'error', 'done', 'interrupted'
]);
export type SessionState = z.infer<typeof SessionStateEnum>;

export const ConnectivityEnum = z.enum(['ok', 'degraded', 'offline']);

export const SubstateSchema = z.object({
  currentTool:           z.string().nullable(),
  lastTool:              z.string().nullable(),
  lastFileTouched:       z.string().nullable(),
  lastCommandRun:        z.string().nullable(),
  elapsedSinceProgressMs: z.number().int().nonnegative(),
  tokensUsedTurn:        z.number().int().nullable(),
  connectivity:          ConnectivityEnum,
  stalled:               z.boolean(),
});
export type Substate = z.infer<typeof SubstateSchema>;

export const AgentEnum = z.enum(['claude-code', 'codex', 'gemini', 'other']);

export const SessionInfoSchema = z.object({
  id:             z.string(),
  name:           z.string(),
  agent:          AgentEnum,
  cwd:            z.string(),
  pid:            z.number().int(),
  startedAt:      z.number().int(),
  state:          SessionStateEnum,
  substate:       SubstateSchema,
  lastSummaryId:  z.string().nullable(),
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;
