import { z } from 'zod';

export const SessionStateEnum = z.enum([
  'starting', 'idle', 'running',
  'awaiting-input', 'awaiting-confirmation',
  'error', 'paused', 'done', 'interrupted', 'killed'
]);
export type SessionState = z.infer<typeof SessionStateEnum>;

export const ConnectivityEnum = z.enum(['ok', 'degraded', 'offline']);

export const PermissionModeEnum = z.enum([
  'default','auto','acceptEdits','bypassPermissions','dontAsk','plan',
]);
export type PermissionMode = z.infer<typeof PermissionModeEnum>;

/** Type guard: is `s` a valid PermissionMode? Single source of truth for the enum. */
export function isPermissionMode(s: string): s is PermissionMode {
  return (PermissionModeEnum.options as readonly string[]).includes(s);
}

export const SubstateSchema = z.object({
  currentTool:           z.string().nullable(),
  lastTool:              z.string().nullable(),
  lastFileTouched:       z.string().nullable(),
  lastCommandRun:        z.string().nullable(),
  elapsedSinceProgressMs: z.number().int().nonnegative(),
  tokensUsedTurn:        z.number().int().nullable(),
  connectivity:          ConnectivityEnum,
  stalled:               z.boolean(),
  permissionMode:        PermissionModeEnum.default('default'),
  // True between PreCompact and PostCompact hooks (claude is rewriting history).
  compacting:            z.boolean().default(false),
  // Updated when claude fires CwdChanged. Distinct from SessionInfo.cwd which
  // captures the cwd at register time and never changes after.
  cwd:                   z.string().nullable().default(null),
  // True when the agent (claude) is suspended inside the inner shell that
  // sesshin-cli spawned — i.e. the foreground process group of the PTY is
  // the shell, not a job. Detected by polling /proc/<shellPid>/stat tpgid;
  // reported by cli to hub via POST /api/sessions/:id/paused-state.
  paused:                z.boolean().default(false),
});
export type Substate = z.infer<typeof SubstateSchema>;

export const AgentEnum = z.enum(['claude-code', 'codex', 'gemini', 'other']);

export const SessionInfoSchema = z.object({
  id:              z.string(),
  name:            z.string(),
  /**
   * Claude Code's own session_id for the *current* conversation in this
   * sesshin process. Changes on /clear, --resume, fresh startup. Stable
   * across /compact. null while no Claude session is active.
   */
  claudeSessionId: z.string().nullable(),
  agent:           AgentEnum,
  cwd:             z.string(),
  pid:             z.number().int(),
  startedAt:       z.number().int(),
  state:           SessionStateEnum,
  substate:        SubstateSchema,
  lastSummaryId:   z.string().nullable(),
  /**
   * Absolute path to the Claude Code JSONL transcript for this session, when
   * known. Optional because (a) older registered sessions might not have it
   * set yet, (b) non-Claude agents don't have an equivalent. Surfaced so
   * UIs can offer "open log" / "copy log path" affordances.
   */
  sessionFilePath: z.string().optional(),
  cols:             z.number().int().positive().optional(),
  rows:             z.number().int().positive().optional(),
  // Sticky user-set session config. All three are nullable+optional:
  // - missing: schema-level backwards compatibility for old payloads
  // - null:    explicitly unset (default after register())
  // - value:   user has set this via `sesshin pin/quiet/gate` etc.
  pin:                 z.string().nullable().optional(),
  quietUntil:          z.number().int().nullable().optional(),
  sessionGateOverride: z.enum(['disabled','auto','always']).nullable().optional(),
});
export type SessionInfo = z.infer<typeof SessionInfoSchema>;
