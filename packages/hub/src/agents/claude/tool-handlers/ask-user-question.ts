import { createHash } from 'node:crypto';
import type { ToolHandler, RenderOutput, HookDecision, HandlerCtx, PromptAnswer } from './types.js';

interface ClaudeQuestion {
  question: string;
  header?: string;
  multiSelect?: boolean;
  options: Array<{ label: string; description: string; preview?: string }>;
}

function keyOf(label: string): string {
  return 'opt-' + createHash('sha256').update(label).digest('hex').slice(0, 8);
}

const RECOMMENDED_RE = /\s+\(Recommended\)$/;

export const askUserQuestionHandler: ToolHandler = {
  toolName: 'AskUserQuestion',

  render(input: Record<string, unknown>): RenderOutput {
    const questions = (input['questions'] as ClaudeQuestion[]) ?? [];
    return {
      origin: 'ask-user-question',
      questions: questions.map(q => ({
        prompt: q.question,
        ...(q.header !== undefined ? { header: q.header } : {}),
        multiSelect: !!q.multiSelect,
        allowFreeText: true,
        options: q.options.map(o => {
          const recommended = RECOMMENDED_RE.test(o.label);
          return {
            key: keyOf(o.label),
            label: recommended ? o.label.replace(RECOMMENDED_RE, '') : o.label,
            ...(o.description ? { description: o.description } : {}),
            ...(o.preview     ? { preview: o.preview }         : {}),
            ...(recommended   ? { recommended: true }          : {}),
          };
        }),
      })),
    };
  },

  decide(answers: PromptAnswer[], input: Record<string, unknown>, _ctx: HandlerCtx): HookDecision {
    const questions = (input['questions'] as ClaudeQuestion[]) ?? [];
    const answersOut: Record<string, string> = {};
    const annotations: Record<string, { preview?: string; notes?: string }> = {};

    for (let i = 0; i < questions.length; i += 1) {
      const q = questions[i]!;
      const a = answers.find(x => x.questionIndex === i);
      if (!a) continue;
      const labelByKey = new Map<string, string>();
      const previewByLabel = new Map<string, string | undefined>();
      for (const o of q.options) {
        labelByKey.set(keyOf(o.label), o.label.replace(RECOMMENDED_RE, ''));
        previewByLabel.set(o.label.replace(RECOMMENDED_RE, ''), o.preview);
      }
      const labels: string[] = [];
      for (const k of a.selectedKeys) {
        const l = labelByKey.get(k);
        if (l) labels.push(l);
      }
      if (a.freeText) labels.push(a.freeText);
      const value = labels.join(', ');
      if (value) answersOut[q.question] = value;

      if (!q.multiSelect && labels[0]) {
        const p = previewByLabel.get(labels[0]);
        if (p) annotations[q.question] = { ...(annotations[q.question] ?? {}), preview: p };
      }
      if (a.notes) annotations[q.question] = { ...(annotations[q.question] ?? {}), notes: a.notes };
    }

    const updatedInput: Record<string, unknown> = { ...input, answers: answersOut };
    if (Object.keys(annotations).length > 0) updatedInput['annotations'] = annotations;
    return { kind: 'allow', updatedInput };
  },
};
