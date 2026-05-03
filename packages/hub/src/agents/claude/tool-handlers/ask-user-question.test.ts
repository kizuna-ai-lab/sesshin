import { describe, it, expect } from 'vitest';
import { askUserQuestionHandler } from './ask-user-question.js';

const ctx = { permissionMode: 'default' as const, cwd: '/x', sessionAllowList: [] };

describe('askUserQuestionHandler', () => {
  const input = {
    questions: [{
      question: 'Which library?',
      header: 'Library',
      multiSelect: false,
      options: [
        { label: 'date-fns', description: 'Modular' },
        { label: 'moment',   description: 'Mature, deprecated' },
      ],
    }],
  };

  it('forwards the question shape with origin=ask-user-question', () => {
    const out = askUserQuestionHandler.render(input, ctx);
    expect(out.origin).toBe('ask-user-question');
    expect(out.questions[0]!.prompt).toBe('Which library?');
    expect(out.questions[0]!.allowFreeText).toBe(true);
    expect(out.questions[0]!.options.map(o => o.label)).toEqual(['date-fns', 'moment']);
  });

  it('strips "(Recommended)" suffix and sets recommended flag', () => {
    const out = askUserQuestionHandler.render({
      questions: [{
        question: 'Q', header: 'H', multiSelect: false,
        options: [{ label: 'opt1 (Recommended)', description: 'd' }, { label: 'opt2', description: 'd' }],
      }],
    }, ctx);
    expect(out.questions[0]!.options[0]).toMatchObject({ label: 'opt1', recommended: true });
    expect(out.questions[0]!.options[1]!.recommended).toBeUndefined();
  });

  it('decide produces updatedInput.answers keyed by question text', () => {
    const out = askUserQuestionHandler.render(input, ctx);
    const dateFnsKey = out.questions[0]!.options[0]!.key;
    const d = askUserQuestionHandler.decide(
      [{ questionIndex: 0, selectedKeys: [dateFnsKey] }], input, ctx,
    );
    expect(d).toMatchObject({
      kind: 'allow',
      updatedInput: { questions: input.questions, answers: { 'Which library?': 'date-fns' } },
    });
  });

  it('decide handles free-text Other', () => {
    const d = askUserQuestionHandler.decide(
      [{ questionIndex: 0, selectedKeys: [], freeText: 'something else' }], input, ctx,
    );
    expect(d).toMatchObject({
      kind: 'allow',
      updatedInput: { answers: { 'Which library?': 'something else' } },
    });
  });

  it('decide handles multiSelect comma-joining', () => {
    const ms = {
      questions: [{
        question: 'Tags?', header: 'T', multiSelect: true,
        options: [{ label: 'a', description: '' }, { label: 'b', description: '' }, { label: 'c', description: '' }],
      }],
    };
    const out = askUserQuestionHandler.render(ms, ctx);
    const ka = out.questions[0]!.options[0]!.key;
    const kc = out.questions[0]!.options[2]!.key;
    const d = askUserQuestionHandler.decide(
      [{ questionIndex: 0, selectedKeys: [ka, kc] }], ms, ctx,
    );
    expect(d.kind).toBe('allow');
    if (d.kind === 'allow') expect(d.updatedInput!['answers']).toEqual({ 'Tags?': 'a, c' });
  });
});

describe('askUserQuestionHandler — PermissionRequest shape', () => {
  // The wire.ts onPermissionRequestApproval adapter (T15) reads
  // pendingUpdatedInput[requestId] to populate decision.updatedInput on the
  // wire response. Here we verify the handler always produces kind:allow
  // and never kind:deny — its only outcome is "allow with updated input".
  const c = { permissionMode: 'default' as const, cwd: '/', sessionAllowList: [] };
  it('produces kind:allow with updatedInput.answers; adapter maps to behavior:allow + updatedInput', () => {
    const input = {
      questions: [{
        question: 'Pick one', header: 'H', multiSelect: false,
        options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }],
      }],
    };
    const rendered = askUserQuestionHandler.render(input, c);
    const optAKey = rendered.questions[0]!.options[0]!.key;
    const decision = askUserQuestionHandler.decide(
      [{ questionIndex: 0, selectedKeys: [optAKey] }], input, c,
    );
    expect(decision.kind).toBe('allow');
    if (decision.kind === 'allow') {
      expect(decision.updatedInput).toBeDefined();
      expect((decision.updatedInput as { answers: Record<string, string> }).answers)
        .toEqual({ 'Pick one': 'A' });
    }
  });
  it('never produces kind:deny — its only outcome is allow with updated input', () => {
    const input = {
      questions: [{
        question: 'Q', header: 'H', multiSelect: false,
        options: [{ label: 'X', description: '' }],
      }],
    };
    const decision = askUserQuestionHandler.decide([], input, c);
    expect(decision.kind).toBe('allow');
  });
});
