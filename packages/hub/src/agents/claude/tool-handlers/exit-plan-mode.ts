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
          { key: 'yes-accept-edits', label: 'Approve in acceptEdits mode' },
          { key: 'no',               label: 'Reject' },
        ],
      }],
    };
  },
  decide(answers: PromptAnswer[], _input: Record<string, unknown>, _ctx: HandlerCtx): HookDecision {
    const a = answers[0];
    const key = a?.selectedKeys[0];
    // ExitPlanMode hook-allow path bypasses CC's TUI mode picker, so without
    // an explicit setMode update CC restores prePlanMode (which can land the
    // session in acceptEdits even when the user picked "approve and execute").
    // Pin the mode here so the two options actually behave differently.
    if (key === 'yes-default') {
      return {
        kind: 'allow',
        updatedPermissions: [{ type: 'setMode', destination: 'session', mode: 'default' }],
      };
    }
    if (key === 'yes-accept-edits') {
      return {
        kind: 'allow',
        updatedPermissions: [{ type: 'setMode', destination: 'session', mode: 'acceptEdits' }],
      };
    }
    if (key === 'no') return a?.freeText ? { kind: 'deny', additionalContext: a.freeText } : { kind: 'deny' };
    return { kind: 'ask' };
  },
};
