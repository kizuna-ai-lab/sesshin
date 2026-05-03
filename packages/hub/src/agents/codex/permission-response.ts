import type { PermissionRequestDecision } from '@sesshin/shared';

/**
 * Codex-safe variant of a PermissionRequest decision.
 *
 * Codex's PermissionRequest hook today fails-closed if the response carries
 * `updatedInput`, `updatedPermissions`, or `interrupt`. Codex also doesn't
 * accept `message` on `allow` responses. This sanitizer strips those fields
 * before serialization.
 *
 * Scaffold only — not yet wired into a real Codex agent path. Lives behind a
 * future `agent === 'codex'` branch.
 */
export function sanitizeCodexPermissionDecision(
  d: PermissionRequestDecision,
): PermissionRequestDecision {
  if (d.behavior === 'allow') return { behavior: 'allow' };
  // Use `!== undefined` rather than a truthy check so an explicitly empty
  // string is preserved (the schema allows `message: ''` and the contract
  // is "deny may carry message", not "deny may carry non-empty message").
  return d.message !== undefined
    ? { behavior: 'deny', message: d.message }
    : { behavior: 'deny' };
}

/**
 * Build the full HTTP response body Codex's PermissionRequest hook expects.
 * Always returns valid JSON — the shape mirrors Claude Code's response, but
 * with Codex-safe sanitizing applied to the decision.
 */
export function buildCodexPermissionResponseBody(d: PermissionRequestDecision): string {
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PermissionRequest',
      decision: sanitizeCodexPermissionDecision(d),
    },
  });
}
