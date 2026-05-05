import type { PermissionMode, PermissionUpdate, PromptQuestion } from '@sesshin/shared';

export interface HandlerCtx {
  permissionMode: PermissionMode;
  cwd: string;
}

export interface PromptAnswer {
  questionIndex: number;
  selectedKeys: string[];
  freeText?: string | undefined;
  notes?: string | undefined;
}

export type PromptOrigin =
  | 'permission'
  | 'ask-user-question'
  | 'exit-plan-mode'
  | 'enter-plan-mode';

export interface RenderOutput {
  body?: string;
  questions: PromptQuestion[];
  origin?: PromptOrigin;
}

export type HookDecision =
  | { kind: 'passthrough' }
  | { kind: 'allow';  updatedInput?: Record<string, unknown>; additionalContext?: string;
      // Permission updates threaded into PermissionRequest's allow.updatedPermissions.
      // Used today by ExitPlanMode to pin the post-exit mode (default vs acceptEdits)
      // since CC's prePlanMode fallback otherwise picks the mode for us.
      updatedPermissions?: PermissionUpdate[] }
  | { kind: 'deny';   reason?: string;     additionalContext?: string }
  | { kind: 'ask';    reason?: string };

export interface ToolHandler {
  toolName: string;
  render(input: Record<string, unknown>, ctx: HandlerCtx): RenderOutput;
  decide(answers: PromptAnswer[], input: Record<string, unknown>, ctx: HandlerCtx): HookDecision;
}
