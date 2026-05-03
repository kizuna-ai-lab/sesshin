import { z } from 'zod';

/**
 * Claude Code's PermissionRequest decision shape. Discriminated on `behavior`:
 * - `allow` may carry `updatedInput` (replaces tool_input on execution)
 * - `deny`  may carry `message` (surfaced to the user / model)
 *
 * The discriminated union forbids `message` on allow and `updatedInput` on
 * deny at the type level — cannot accidentally leak fields cross-shape.
 */
export const PermissionRequestDecision = z.discriminatedUnion('behavior', [
  z.object({
    behavior: z.literal('allow'),
    updatedInput: z.record(z.unknown()).optional(),
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
