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
import { ruleMatchesAny } from './permission-rules.js';

export type ApprovalGatePolicy = 'disabled' | 'auto' | 'always';

export interface AllowContext {
  sessionAllowList: readonly string[];
  claudeAllowRules: readonly string[];
}

// Modes where claude auto-executes without prompting. We must never gate
// these; doing so produces a regression vs. running claude without sesshin.
const AUTO_EXECUTE_MODES = new Set(['acceptEdits', 'bypassPermissions', 'auto', 'dontAsk']);

// Tools that typically trigger claude's permission prompt in default mode
// for a fresh session. Read-only tools (Read/Glob/Grep/LS/Task) are
// auto-allowed and shouldn't surface a remote approval card. mcp__* tools
// are matched separately via prefix (see shouldGatePreToolUse).
const GATED_TOOLS = new Set([
  'Bash', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit',
  'PowerShell', 'WebFetch', 'AskUserQuestion', 'ExitPlanMode', 'EnterPlanMode',
  'Skill',
]);

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
  allow: AllowContext = { sessionAllowList: [], claudeAllowRules: [] },
  /**
   * Whether ≥1 client currently subscribed to this session has the `actions`
   * capability. When false the hub MUST stay transparent: there's no one to
   * answer the prompt-request, so blocking would just stall claude until the
   * approval timeout fires. Defaults to `true` so existing tests keep their
   * current contract.
   */
  hasSubscribedClient: boolean = true,
  /**
   * When true, the session has been observed using the PermissionRequest
   * HTTP hook as its real approval gate. PreToolUse should pass through
   * (return false) so we don't double-gate.
   */
  usesPermissionRequest: boolean = false,
): boolean {
  if (usesPermissionRequest)  return false;
  if (policy === 'disabled') return false;
  if (policy === 'always')   return true;
  // policy === 'auto'
  const mode: string =
    knownMode ??
    (typeof raw['permission_mode'] === 'string' ? raw['permission_mode'] : 'default');
  if (AUTO_EXECUTE_MODES.has(mode)) return false;
  if (mode === 'plan')              return false;
  if (!hasSubscribedClient)         return false;
  const tool = typeof raw['tool_name'] === 'string' ? raw['tool_name'] : '';
  const rawInput = raw['tool_input'];
  const toolInput: Record<string, unknown> =
    rawInput !== null && typeof rawInput === 'object'
      ? (rawInput as Record<string, unknown>)
      : {};
  if (ruleMatchesAny(tool, toolInput, allow.sessionAllowList)) return false;
  if (ruleMatchesAny(tool, toolInput, allow.claudeAllowRules))  return false;
  if (GATED_TOOLS.has(tool)) return true;
  if (tool.startsWith('mcp__')) return true;
  return false;
}
