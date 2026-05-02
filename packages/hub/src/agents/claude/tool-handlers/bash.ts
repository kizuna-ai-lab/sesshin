import type { ToolHandler, RenderOutput, HookDecision, HandlerCtx, PromptAnswer } from './types.js';

function heuristicPrefix(command: string): string {
  const tokens = command.trim().split(/\s+/);
  const prefix = tokens.slice(0, Math.min(2, tokens.length)).join(' ');
  return `${prefix}:*`;
}

export const bashHandler: ToolHandler = {
  toolName: 'Bash',

  render(input: Record<string, unknown>): RenderOutput {
    const command = typeof input['command'] === 'string' ? input['command'] : '';
    return {
      origin: 'permission',
      body: '```bash\n' + command + '\n```',
      questions: [{
        prompt: 'Run this command?',
        header: 'Bash',
        multiSelect: false,
        allowFreeText: true,
        options: [
          { key: 'yes',        label: 'Yes' },
          { key: 'yes-prefix', label: 'Yes, don’t ask again for', description: 'Pattern; sesshin remembers for this session.' },
          { key: 'no',         label: 'No' },
        ],
      }],
    };
  },

  decide(answers: PromptAnswer[], input: Record<string, unknown>, _ctx: HandlerCtx): HookDecision {
    const a = answers[0];
    const key = a?.selectedKeys[0];
    if (key === 'yes') {
      return a?.freeText
        ? { kind: 'allow', additionalContext: a.freeText }
        : { kind: 'allow' };
    }
    if (key === 'yes-prefix') {
      const command = typeof input['command'] === 'string' ? input['command'] : '';
      const prefix = (a?.freeText && a.freeText.length > 0) ? a.freeText : heuristicPrefix(command);
      return { kind: 'allow', sessionAllowAdd: `Bash(${prefix})` };
    }
    if (key === 'no') {
      return a?.freeText
        ? { kind: 'deny', additionalContext: a.freeText }
        : { kind: 'deny' };
    }
    return { kind: 'ask' };
  },
};
