/**
 * Decide whether a PreToolUse hook should engage sesshin's remote-approval
 * long poll, or pass through silently so claude follows its normal
 * mode-based prompting logic.
 *
 * The trap to avoid: returning any permissionDecision (including "ask")
 * forces claude to honor it. In particular returning "ask" makes claude
 * show its TUI permission prompt even in auto/acceptEdits/bypassPermissions
 * mode where it normally would not. So when we don't want to gate, the
 * hub must respond with HTTP 204 (no decision) — *not* 200 with "ask".
 */
import type { PermissionMode } from '@sesshin/shared';

export type ApprovalGatePolicy = 'disabled' | 'auto' | 'always';

// Modes where claude auto-executes without prompting. We must never gate
// these; doing so produces a regression vs. running claude without sesshin.
const AUTO_EXECUTE_MODES = new Set(['acceptEdits', 'bypassPermissions', 'auto', 'dontAsk']);

// Tools that typically trigger claude's permission prompt in default mode
// for a fresh session. Read-only tools (Read/Glob/Grep/LS/Task) are
// auto-allowed and shouldn't surface a remote approval card.
const GATED_TOOLS = new Set(['Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit']);

export function parsePolicy(raw: string | undefined): ApprovalGatePolicy {
  const v = (raw ?? 'auto').toLowerCase();
  if (v === 'disabled' || v === 'off' || v === 'never') return 'disabled';
  if (v === 'always')                                    return 'always';
  return 'auto';
}

export function shouldGatePreToolUse(
  raw: Record<string, unknown>,
  knownMode: PermissionMode | undefined,
  policy: ApprovalGatePolicy,
): boolean {
  if (policy === 'disabled') return false;
  if (policy === 'always')   return true;
  // policy === 'auto'
  const mode: string =
    knownMode ??
    (typeof raw['permission_mode'] === 'string' ? raw['permission_mode'] : 'default');
  if (AUTO_EXECUTE_MODES.has(mode)) return false;
  if (mode === 'plan')              return false;
  const tool = typeof raw['tool_name'] === 'string' ? raw['tool_name'] : '';
  return GATED_TOOLS.has(tool);
}
