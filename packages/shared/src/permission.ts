import { z } from 'zod';

/**
 * Subset of Claude Code's PermissionUpdate union, covering the variants
 * sesshin currently emits from `allow` decisions:
 *  - `setMode`  — pin the post-approval permission mode (e.g. on ExitPlanMode
 *                 approval, choosing `default` vs `acceptEdits`).
 *  - `addRules` — attach a session-scope allow/deny/ask rule so future matching
 *                 tool calls bypass the PermissionRequest hook entirely (used by
 *                 the "Yes, don't ask again for…" prefix flow on Bash/Edit/etc.).
 *
 * Schema mirrors Claude Code's PermissionUpdateSchema (coreSchemas.ts:263-294
 * in the CC source). Other variants (replaceRules, removeRules, addDirectories,
 * removeDirectories) are intentionally not implemented until a sesshin handler
 * needs them.
 */
export const PermissionUpdate = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('setMode'),
    destination: z.enum(['session', 'userSettings', 'projectSettings', 'localSettings', 'cliArg']),
    mode: z.enum(['default', 'acceptEdits', 'bypassPermissions', 'plan', 'dontAsk']),
  }),
  z.object({
    type: z.literal('addRules'),
    destination: z.enum(['session', 'userSettings', 'projectSettings', 'localSettings', 'cliArg']),
    rules: z.array(z.string()),
    behavior: z.enum(['allow', 'deny', 'ask']),
  }),
]);
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
  agent_id:          z.string().optional(),
  agent_type:        z.string().optional(),
});
export type PermissionRequestBody = z.infer<typeof PermissionRequestBody>;
