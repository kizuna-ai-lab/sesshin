import type { ToolHandler, RenderOutput, HookDecision, HandlerCtx, PromptAnswer } from './types.js';

export const exitPlanModeHandler: ToolHandler = {
  toolName: 'ExitPlanMode',
  render(input: Record<string, unknown>): RenderOutput {
    const plan = typeof input['plan'] === 'string' ? input['plan'] : '(empty)';
    return {
      origin: 'exit-plan-mode',
      body: plan,
      questions: [{
        prompt: 'Approve and execute this plan?',
        header: 'Plan',
        multiSelect: false,
        allowFreeText: true,
        options: [
          { key: 'yes-default',      label: 'Approve and execute' },
          { key: 'yes-accept-edits', label: 'Approve in acceptEdits mode',
            description: 'Sesshin remembers the preference; runtime mode unchanged' },
          { key: 'no',               label: 'Reject' },
        ],
      }],
    };
  },
  decide(answers: PromptAnswer[], _input: Record<string, unknown>, _ctx: HandlerCtx): HookDecision {
    const a = answers[0];
    const key = a?.selectedKeys[0];
    if (key === 'yes-default' || key === 'yes-accept-edits') return { kind: 'allow' };
    if (key === 'no') return a?.freeText ? { kind: 'deny', additionalContext: a.freeText } : { kind: 'deny' };
    return { kind: 'ask' };
  },
};
