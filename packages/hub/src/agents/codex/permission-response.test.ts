import { describe, it, expect } from 'vitest';
import {
  sanitizeCodexPermissionDecision,
  buildCodexPermissionResponseBody,
} from './permission-response.js';

describe('sanitizeCodexPermissionDecision', () => {
  it('allow strips updatedInput', () => {
    expect(sanitizeCodexPermissionDecision({
      behavior: 'allow', updatedInput: { command: 'ls' },
    })).toEqual({ behavior: 'allow' });
  });
  it('allow with no fields stays {behavior:"allow"}', () => {
    expect(sanitizeCodexPermissionDecision({ behavior: 'allow' }))
      .toEqual({ behavior: 'allow' });
  });
  it('deny preserves message', () => {
    expect(sanitizeCodexPermissionDecision({ behavior: 'deny', message: 'no' }))
      .toEqual({ behavior: 'deny', message: 'no' });
  });
  it('deny with no message stays {behavior:"deny"}', () => {
    expect(sanitizeCodexPermissionDecision({ behavior: 'deny' }))
      .toEqual({ behavior: 'deny' });
  });
  it('deny preserves explicitly empty message (not dropped as falsy)', () => {
    expect(sanitizeCodexPermissionDecision({ behavior: 'deny', message: '' }))
      .toEqual({ behavior: 'deny', message: '' });
  });
});

describe('buildCodexPermissionResponseBody', () => {
  it('produces full hookSpecificOutput envelope for allow', () => {
    const body = buildCodexPermissionResponseBody({ behavior: 'allow', updatedInput: { x: 1 } });
    expect(JSON.parse(body)).toEqual({
      hookSpecificOutput: { hookEventName: 'PermissionRequest', decision: { behavior: 'allow' } },
    });
  });
  it('produces full envelope for deny with message', () => {
    const body = buildCodexPermissionResponseBody({ behavior: 'deny', message: 'no' });
    expect(JSON.parse(body)).toEqual({
      hookSpecificOutput: {
        hookEventName: 'PermissionRequest',
        decision: { behavior: 'deny', message: 'no' },
      },
    });
  });
});
