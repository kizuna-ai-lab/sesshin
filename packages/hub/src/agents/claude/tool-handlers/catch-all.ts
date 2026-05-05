// Catch-all handler used when no tool-specific handler is registered.
// `LAST_TOOL_NAME` is a per-call tracker set by the registry just before
// delegation. This is acceptable for v1.5 (single-threaded JS event loop;
// each PreToolUse path runs to completion before the next call).
import type { ToolHandler, RenderOutput, HookDecision, HandlerCtx, PromptAnswer } from './types.js';

let LAST_TOOL_NAME = '';

export const catchAllHandler: ToolHandler = {
  toolName: 'CatchAll',

  render(input: Record<string, unknown>): RenderOutput {
    const tool = LAST_TOOL_NAME;
    return {
      origin: 'permission',
      body: '```json\n' + JSON.stringify(input, null, 2) + '\n```',
      questions: [{
        prompt: 'Allow this tool call?',
        header: tool.slice(0, 12),
        multiSelect: false,
        allowFreeText: true,
        options: [
          { key: 'allow',                          label: 'Allow' },
          { key: `allow-this-session:${tool}`,     label: 'Allow this exact call this session' },
          { key: 'deny',                           label: 'Deny' },
        ],
      }],
    };
  },

  decide(answers: PromptAnswer[], input: Record<string, unknown>, _ctx: HandlerCtx): HookDecision {
    const a = answers[0];
    const key = a?.selectedKeys[0];
    if (key === 'allow') return a?.freeText ? { kind: 'allow', additionalContext: a.freeText } : { kind: 'allow' };
    if (typeof key === 'string' && key.startsWith('allow-this-session:')) {
      const tool = key.slice('allow-this-session:'.length);
      return {
        kind: 'allow',
        updatedPermissions: [
          {
            type: 'addRules',
            behavior: 'allow',
            destination: 'session',
            rules: [`${tool}(${JSON.stringify(input)})`],
          },
        ],
      };
    }
    if (key === 'deny') return a?.freeText ? { kind: 'deny', additionalContext: a.freeText } : { kind: 'deny' };
    return { kind: 'ask' };
  },
};

export function setCatchAllToolName(name: string): void { LAST_TOOL_NAME = name; }
