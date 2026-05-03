import { z } from 'zod';

/**
 * Subset of Claude Code's PermissionUpdate union — currently only the
 * `setMode` variant, which is what `allow` decisions use to drive the
 * post-approval permission mode (e.g. on ExitPlanMode approval, deciding
 * whether the session resumes in `default` or `acceptEdits`).
 *
 * Schema mirrors Claude Code's PermissionUpdateSchema (src/types/permissions.ts
 * in the CC source). Other variants (addRules, addDirectories, …) intentionally
 * not implemented until a sesshin handler needs them.
 */
export const PermissionUpdate = z.object({
  type: z.literal('setMode'),
  destination: z.enum(['session', 'userSettings', 'projectSettings', 'localSettings', 'cliArg']),
  mode: z.enum(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk']),
});
export type PermissionUpdate = z.infer<typeof PermissionUpdate>;

/**
 * Claude Code's PermissionRequest decision shape. Discriminated on `behavior`:
 * - `allow` may carry `updatedInput` (replaces tool_input on execution) and/or
 *   `updatedPermissions` (e.g. setMode to switch out of plan mode into
 *   default vs acceptEdits — the only way for a hook-approved ExitPlanMode
 *   to pin the post-exit mode; without it CC falls back to prePlanMode).
 * - `deny`  may carry `message` (surfaced to the user / model)
 *
 * The discriminated union forbids `message` on allow and `updatedInput` on
 * deny at the type level — cannot accidentally leak fields cross-shape.
 */
export const PermissionRequestDecision = z.discriminatedUnion('behavior', [
  z.object({
    behavior: z.literal('allow'),
    updatedInput: z.record(z.unknown()).optional(),
    updatedPermissions: z.array(PermissionUpdate).optional(),
  }),
  z.object({
    behavior: z.literal('deny'),
    message: z.string().optional(),
  }),
]);
export type PermissionRequestDecision = z.infer<typeof PermissionRequestDecision>;

/**
 * Full HTTP response body Claude Code expects from a PermissionRequest hook.
 * Distinct from PreToolUse's `permissionDecision` shape (which lives inline
 * in rest/server.ts and uses 'allow'|'deny'|'ask' strings, not objects).
 */
export const PermissionRequestResponse = z.object({
  hookSpecificOutput: z.object({
    hookEventName: z.literal('PermissionRequest'),
    decision: PermissionRequestDecision,
  }),
});
export type PermissionRequestResponse = z.infer<typeof PermissionRequestResponse>;

/**
 * Native Claude PermissionRequest HTTP-hook input body. Parsed in the route
 * handler before envelope construction.
 */
export const PermissionRequestBody = z.object({
  session_id:        z.string(),
  hook_event_name:   z.literal('PermissionRequest'),
  tool_name:         z.string(),
  tool_input:        z.record(z.unknown()),
  tool_use_id:       z.string().optional(),
  cwd:               z.string().optional(),
  transcript_path:   z.string().optional(),
  permission_mode:   z.string().optional(),
  model:             z.string().optional(),
});
export type PermissionRequestBody = z.infer<typeof PermissionRequestBody>;
