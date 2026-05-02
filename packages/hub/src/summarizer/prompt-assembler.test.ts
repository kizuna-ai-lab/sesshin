import { describe, it, expect } from 'vitest';
import { assemblePrompt } from './prompt-assembler.js';

describe('assemblePrompt', () => {
  it('always retains user prompt and final assistant output even when budget tight', () => {
    const input = assemblePrompt({
      previousSummary: { oneLine: 'x', bullets: [] },
      events: [
        { kind: 'user-prompt', text: 'fix the test' },
        ...Array.from({ length: 30 }, () => ({ kind: 'tool-call' as const, text: 'long ' + 'x'.repeat(800) })),
        { kind: 'agent-output', text: 'all done' },
      ],
      maxChars: 2000,
    });
    expect(input).toContain('fix the test');
    expect(input).toContain('all done');
  });
  it('drops middle items first when over budget', () => {
    const input = assemblePrompt({
      previousSummary: null,
      events: [
        { kind: 'user-prompt', text: 'A' },
        { kind: 'tool-call', text: 'B' + 'x'.repeat(2000) },
        { kind: 'tool-result', text: 'C' + 'x'.repeat(2000) },
        { kind: 'agent-output', text: 'Z' },
      ],
      maxChars: 200,
    });
    expect(input).toContain('A');
    expect(input).toContain('Z');
  });
});
