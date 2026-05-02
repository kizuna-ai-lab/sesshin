import type { PermissionMode, PromptQuestion } from '@sesshin/shared';

export interface HandlerCtx {
  permissionMode: PermissionMode;
  cwd: string;
  sessionAllowList: string[];
}

export interface PromptAnswer {
  questionIndex: number;
  selectedKeys: string[];
  freeText?: string | undefined;
  notes?: string | undefined;
}

export interface RenderOutput {
  body?: string;
  questions: PromptQuestion[];
  origin?: 'permission' | 'ask-user-question' | 'exit-plan-mode' | 'enter-plan-mode';
}

export type HookDecision =
  | { kind: 'passthrough' }
  | { kind: 'allow';  updatedInput?: Record<string, unknown>; additionalContext?: string;
      sessionAllowAdd?: string }
  | { kind: 'deny';   reason?: string;     additionalContext?: string }
  | { kind: 'ask';    reason?: string };

export interface ToolHandler {
  toolName: string;
  render(input: Record<string, unknown>, ctx: HandlerCtx): RenderOutput;
  decide(answers: PromptAnswer[], input: Record<string, unknown>, ctx: HandlerCtx): HookDecision;
}
