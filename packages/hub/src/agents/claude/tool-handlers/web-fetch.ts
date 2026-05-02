import type { ToolHandler, RenderOutput, HookDecision, HandlerCtx, PromptAnswer } from './types.js';

export const webFetchHandler: ToolHandler = {
  toolName: 'WebFetch',
  render(input: Record<string, unknown>): RenderOutput {
    const url = typeof input['url'] === 'string' ? input['url'] : '?';
    return {
      origin: 'permission',
      body: `**url:** ${url}`,
      questions: [{
        prompt: 'Fetch this URL?',
        header: 'WebFetch',
        multiSelect: false, allowFreeText: true,
        options: [
          { key: 'yes',       label: 'Yes' },
          { key: 'yes-host',  label: 'Yes, allow all fetches to this host this session' },
          { key: 'no',        label: 'No' },
        ],
      }],
    };
  },
  decide(answers: PromptAnswer[], input: Record<string, unknown>, _ctx: HandlerCtx): HookDecision {
    const a = answers[0];
    const key = a?.selectedKeys[0];
    const url = typeof input['url'] === 'string' ? input['url'] : '';
    if (key === 'yes')  return a?.freeText ? { kind: 'allow', additionalContext: a.freeText } : { kind: 'allow' };
    if (key === 'yes-host') {
      try {
        const u = new URL(url);
        return { kind: 'allow', sessionAllowAdd: `WebFetch(${u.protocol}//${u.host}/*)` };
      } catch {
        return { kind: 'allow' };
      }
    }
    if (key === 'no')   return a?.freeText ? { kind: 'deny', additionalContext: a.freeText } : { kind: 'deny' };
    return { kind: 'ask' };
  },
};
