import { describe, it, expect } from 'vitest';
import { transitionFor } from './machine.js';

describe('transitionFor', () => {
  it('SessionStart from starting → idle', () => {
    expect(transitionFor('starting', { kind: 'agent-internal', nativeEvent: 'SessionStart' })).toBe('idle');
  });
  it('user-prompt from idle → running', () => {
    expect(transitionFor('idle', { kind: 'user-prompt' })).toBe('running');
  });
  it('user-prompt from awaiting-input → running', () => {
    expect(transitionFor('awaiting-input', { kind: 'user-prompt' })).toBe('running');
  });
  it('agent-output (Stop) from running → idle (heuristic deferred)', () => {
    expect(transitionFor('running', { kind: 'agent-output' })).toBe('idle');
  });
  it('error event from running → error', () => {
    expect(transitionFor('running', { kind: 'error' })).toBe('error');
  });
  it('SessionEnd from any → done', () => {
    expect(transitionFor('idle', { kind: 'agent-internal', nativeEvent: 'SessionEnd' })).toBe('done');
    expect(transitionFor('running', { kind: 'agent-internal', nativeEvent: 'SessionEnd' })).toBe('done');
  });
  it('returns null when no transition applies (state stays put)', () => {
    expect(transitionFor('idle', { kind: 'tool-call' })).toBeNull();
  });
});
