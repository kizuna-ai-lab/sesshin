import { dirname } from 'node:path';
import type { ToolHandler, RenderOutput, HookDecision, HandlerCtx, PromptAnswer } from './types.js';

export const fileEditHandler: ToolHandler = {
  toolName: 'FileEdit',

  render(input: Record<string, unknown>): RenderOutput {
    const filePath = typeof input['file_path'] === 'string' ? input['file_path'] : '?';
    const preview = previewBody(input);
    return {
      origin: 'permission',
      body: `**path:** \`${filePath}\`\n\n${preview}`,
      questions: [{
        prompt: 'Apply this change?',
        header: 'File',
        multiSelect: false,
        allowFreeText: true,
        options: [
          { key: 'yes',               label: 'Yes' },
          { key: 'yes-session-scope', label: 'Yes, allow all edits in this directory this session', description: 'Sesshin-side allow rule for the session.' },
          { key: 'no',                label: 'No' },
        ],
      }],
    };
  },

  decide(answers: PromptAnswer[], input: Record<string, unknown>): HookDecision {
    const a = answers[0];
    const key = a?.selectedKeys[0];
    const filePath = typeof input['file_path'] === 'string' ? input['file_path'] : '';
    if (key === 'yes') {
      return a?.freeText ? { kind: 'allow', additionalContext: a.freeText } : { kind: 'allow' };
    }
    if (key === 'yes-session-scope') {
      const dir = filePath ? dirname(filePath) : '';
      return {
        kind: 'allow',
        updatedPermissions: [
          { type: 'addRules', behavior: 'allow', destination: 'session', rules: [`Edit(${dir}/*)`] },
        ],
      };
    }
    if (key === 'no') {
      return a?.freeText ? { kind: 'deny', additionalContext: a.freeText } : { kind: 'deny' };
    }
    return { kind: 'ask' };
  },
};

function previewBody(input: Record<string, unknown>): string {
  if (typeof input['content'] === 'string') {
    const c = input['content'];
    return '```\n' + (c.length > 800 ? c.slice(0, 800) + '\n…(truncated)' : c) + '\n```';
  }
  if (typeof input['old_string'] === 'string' && typeof input['new_string'] === 'string') {
    return '```diff\n- ' + input['old_string'] + '\n+ ' + input['new_string'] + '\n```';
  }
  return '```json\n' + JSON.stringify(input, null, 2) + '\n```';
}
