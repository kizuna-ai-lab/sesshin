import { describe, it, expect } from 'vitest';
import { ApprovalManager } from './approval-manager.js';
import type { PromptQuestion } from '@sesshin/shared';

describe('ApprovalManager', () => {
  it('resolves the decision promise when a client decides', async () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 1000 });
    const { request, decision } = m.open({ sessionId: 's1', tool: 'Bash', toolInput: { command: 'ls' }, origin: 'permission', questions: [] });
    expect(m.pendingCount()).toBe(1);
    expect(m.decide(request.requestId, { decision: 'allow', reason: 'ok' })).toBe(true);
    await expect(decision).resolves.toEqual({ decision: 'allow', reason: 'ok' });
    expect(m.pendingCount()).toBe(0);
  });

  it('falls back to "ask" when no decision arrives before the timeout', async () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 30 });
    const { decision } = m.open({ sessionId: 's1', tool: 'Edit', toolInput: { path: 'a.md' }, origin: 'permission', questions: [] });
    const out = await decision;
    expect(out.decision).toBe('ask');
    expect(out.reason).toContain('timed out');
    expect(m.pendingCount()).toBe(0);
  });

  it('decide() returns false for an unknown requestId', () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 1000 });
    expect(m.decide('does-not-exist', { decision: 'allow' })).toBe(false);
  });

  it('cancelForSession resolves all pending requests for a session', async () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 5000 });
    const a = m.open({ sessionId: 's1', tool: 'A', toolInput: {}, origin: 'permission', questions: [] });
    const b = m.open({ sessionId: 's1', tool: 'B', toolInput: {}, origin: 'permission', questions: [] });
    const c = m.open({ sessionId: 's2', tool: 'C', toolInput: {}, origin: 'permission', questions: [] });
    expect(m.cancelForSession('s1')).toBe(2);
    await expect(a.decision).resolves.toMatchObject({ decision: 'ask' });
    await expect(b.decision).resolves.toMatchObject({ decision: 'ask' });
    expect(m.pendingCount()).toBe(1);
    expect(m.pendingForSession('s2')).toHaveLength(1);
    m.decide(c.request.requestId, { decision: 'deny' });
    await expect(c.decision).resolves.toMatchObject({ decision: 'deny' });
  });

  it('invokes onExpire when timeout fires', async () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 30 });
    const seen: string[] = [];
    const { decision } = m.open({ sessionId: 's1', tool: 'T', toolInput: {}, onExpire: (a) => seen.push(a.requestId), origin: 'permission', questions: [] });
    await decision;
    expect(seen).toHaveLength(1);
  });

  it('cancelForSession does NOT invoke onExpire (only timeout does)', async () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 5000 });
    const seen: string[] = [];
    const { decision } = m.open({
      sessionId: 's1', tool: 'Bash', toolInput: { command: 'ls' },
      onExpire: (a) => seen.push(a.requestId),
      origin: 'permission', questions: [],
    });
    m.cancelForSession('s1');
    // Resolves cleanly to 'ask' with the cancellation reason
    await expect(decision).resolves.toMatchObject({ decision: 'ask' });
    // onExpire was NOT called — that's reserved for the timeout path
    expect(seen).toEqual([]);
  });

  it('cancelOnLastClientGone resolves all pending for a session as ask', async () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 5000 });
    const a = m.open({ sessionId: 's1', tool: 'Bash', toolInput: {}, origin: 'permission', questions: [] });
    const b = m.open({ sessionId: 's2', tool: 'Edit', toolInput: {}, origin: 'permission', questions: [] });
    expect(m.cancelOnLastClientGone('s1')).toBe(1);
    await expect(a.decision).resolves.toMatchObject({ decision: 'ask' });
    expect(m.pendingForSession('s2')).toHaveLength(1);
    m.decide(b.request.requestId, { decision: 'allow' });
  });

  it('honors a custom timeoutDecision', async () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 30, timeoutDecision: 'deny', timeoutReason: 'no client' });
    const { decision } = m.open({ sessionId: 's1', tool: 'T', toolInput: {}, origin: 'permission', questions: [] });
    await expect(decision).resolves.toEqual({ decision: 'deny', reason: 'no client' });
  });
});

describe('ApprovalManager — resolveByToolUseId', () => {
  it('resolves matching entry, returns the resolved requestId, fulfills decision Promise', async () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    const { request, decision } = m.open({
      sessionId: 's', tool: 'Bash', toolInput: { command: 'ls' }, toolUseId: 'tu_1',
      origin: 'permission', questions: [],
    });
    expect(request.toolUseId).toBe('tu_1');
    const n = m.resolveByToolUseId('s', 'tu_1', { decision: 'deny', reason: 'r' });
    expect(n).toBe(request.requestId);
    await expect(decision).resolves.toEqual({ decision: 'deny', reason: 'r' });
  });
  it('returns null when no entry matches', () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    expect(m.resolveByToolUseId('s', 'tu_missing', { decision: 'ask' })).toBe(null);
  });
  it('returns null when toolUseId differs from the open() entry', () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    m.open({ sessionId: 's', tool: 'Bash', toolInput: {}, toolUseId: 'tu_1', origin: 'permission', questions: [] });
    expect(m.resolveByToolUseId('s', 'tu_2', { decision: 'ask' })).toBe(null);
  });
  it('returns null when sessionId differs', () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    m.open({ sessionId: 's1', tool: 'Bash', toolInput: {}, toolUseId: 'tu_1', origin: 'permission', questions: [] });
    expect(m.resolveByToolUseId('s2', 'tu_1', { decision: 'ask' })).toBe(null);
  });
  it('after resolveByToolUseId, the entry is gone from pendingForSession', () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    m.open({ sessionId: 's', tool: 'Bash', toolInput: {}, toolUseId: 'tu_1', origin: 'permission', questions: [] });
    expect(m.pendingForSession('s')).toHaveLength(1);
    m.resolveByToolUseId('s', 'tu_1', { decision: 'allow' });
    expect(m.pendingForSession('s')).toHaveLength(0);
  });
});

describe('ApprovalManager — resolveByFingerprint', () => {
  it('resolves single match without toolUseId, returns the resolved requestId', async () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    const { request, decision } = m.open({
      sessionId: 's', tool: 'Bash', toolInput: { command: 'ls' },
      origin: 'permission', questions: [],
    });
    const fp = request.toolInputFingerprint;
    expect(m.resolveByFingerprint('s', 'Bash', fp, { decision: 'deny', reason: 'x' })).toBe(request.requestId);
    await expect(decision).resolves.toEqual({ decision: 'deny', reason: 'x' });
  });
  it('returns null when set has 2+ entries with same fingerprint (ambiguous)', () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    const a = m.open({ sessionId: 's', tool: 'Bash', toolInput: { command: 'ls' }, origin: 'permission', questions: [] }).request;
    m.open({ sessionId: 's', tool: 'Bash', toolInput: { command: 'ls' }, origin: 'permission', questions: [] });
    expect(m.resolveByFingerprint('s', 'Bash', a.toolInputFingerprint, { decision: 'ask' })).toBe(null);
  });
  it('returns null when matching entry has toolUseId (canonical match should have caught it)', () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    const { request } = m.open({
      sessionId: 's', tool: 'Bash', toolInput: { command: 'ls' }, toolUseId: 'tu_1',
      origin: 'permission', questions: [],
    });
    expect(m.resolveByFingerprint('s', 'Bash', request.toolInputFingerprint, { decision: 'ask' })).toBe(null);
  });
  it('returns null when no fingerprint match', () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    expect(m.resolveByFingerprint('s', 'Bash', 'a'.repeat(64), { decision: 'ask' })).toBe(null);
  });
  it('returns null when toolName differs', () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    const { request } = m.open({ sessionId: 's', tool: 'Bash', toolInput: { command: 'ls' }, origin: 'permission', questions: [] });
    expect(m.resolveByFingerprint('s', 'Edit', request.toolInputFingerprint, { decision: 'ask' })).toBe(null);
  });
  it('returns null when sessionId differs', () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    const { request } = m.open({ sessionId: 's1', tool: 'Bash', toolInput: { command: 'ls' }, origin: 'permission', questions: [] });
    expect(m.resolveByFingerprint('s2', 'Bash', request.toolInputFingerprint, { decision: 'ask' })).toBe(null);
  });
});

describe('ApprovalManager — resolveSingletonForSession', () => {
  it('resolves the only pending entry for a session, returns the resolved requestId', async () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    const { request, decision } = m.open({ sessionId: 's', tool: 'Bash', toolInput: {}, origin: 'permission', questions: [] });
    expect(m.resolveSingletonForSession('s', { decision: 'deny', reason: 'r' })).toBe(request.requestId);
    await expect(decision).resolves.toEqual({ decision: 'deny', reason: 'r' });
  });
  it('returns null when 0 pending entries', () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    expect(m.resolveSingletonForSession('s', { decision: 'ask' })).toBe(null);
  });
  it('returns null when 2+ pending entries (ambiguous)', () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    m.open({ sessionId: 's', tool: 'Bash', toolInput: {}, origin: 'permission', questions: [] });
    m.open({ sessionId: 's', tool: 'Edit', toolInput: {}, origin: 'permission', questions: [] });
    expect(m.resolveSingletonForSession('s', { decision: 'ask' })).toBe(null);
  });
  it('only counts entries for the given session', () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    const a = m.open({ sessionId: 's1', tool: 'Bash', toolInput: {}, origin: 'permission', questions: [] });
    m.open({ sessionId: 's2', tool: 'Bash', toolInput: {}, origin: 'permission', questions: [] });
    expect(m.resolveSingletonForSession('s1', { decision: 'allow' })).toBe(a.request.requestId);
  });
});

describe('ApprovalManager — same (sessionId, toolUseId) opened twice', () => {
  it('first entry timing out does NOT poison the index for the second entry', async () => {
    // The "same key opened twice" edge case (Claude retry, etc.). The first
    // open()'s cleanup must NOT remove the byToolUseId index pointer that
    // now points at the second entry — otherwise resolveByToolUseId can't
    // find it.
    const m = new ApprovalManager({ defaultTimeoutMs: 30 });   // short timeout to fire fast
    const a = m.open({ sessionId: 's', tool: 'Bash', toolInput: { command: 'ls' }, toolUseId: 'tu_1', origin: 'permission', questions: [] });
    const b = m.open({ sessionId: 's', tool: 'Bash', toolInput: { command: 'ls' }, toolUseId: 'tu_1', origin: 'permission', questions: [] });
    // Wait for the first entry to time out.
    await a.decision;
    // Resolve second entry by toolUseId. With the guard in place, this finds
    // entry B; without the guard, the index was already deleted by A's cleanup
    // and this returns 0.
    const resolved = m.resolveByToolUseId('s', 'tu_1', { decision: 'deny', reason: 'r' });
    expect(resolved).toBe(b.request.requestId);
    await expect(b.decision).resolves.toEqual({ decision: 'deny', reason: 'r' });
  });

  it('second entry resolving via toolUseId leaves no stale index entries', () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    m.open({ sessionId: 's', tool: 'Bash', toolInput: {}, toolUseId: 'tu_1', origin: 'permission', questions: [] });
    const second = m.open({ sessionId: 's', tool: 'Bash', toolInput: {}, toolUseId: 'tu_1', origin: 'permission', questions: [] });   // overwrites pointer
    // resolveByToolUseId picks the second (newest pointed-at) entry. Its
    // cleanup removes the index. The first entry, when it eventually times
    // out, will see the index is already gone (or no longer points at it).
    expect(m.resolveByToolUseId('s', 'tu_1', { decision: 'allow' })).toBe(second.request.requestId);
    // A subsequent lookup must miss — neither entry should still be indexed.
    expect(m.resolveByToolUseId('s', 'tu_1', { decision: 'allow' })).toBe(null);
  });
});

describe('ApprovalManager — toolInputFingerprint', () => {
  it('open() populates toolInputFingerprint on the public PendingApproval', () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    const { request } = m.open({ sessionId: 's', tool: 'Bash', toolInput: { command: 'ls' }, origin: 'permission', questions: [] });
    expect(request.toolInputFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });
  it('two open() calls with identical toolInput produce identical fingerprints', () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    const a = m.open({ sessionId: 's', tool: 'Bash', toolInput: { command: 'ls' }, origin: 'permission', questions: [] }).request;
    const b = m.open({ sessionId: 's', tool: 'Bash', toolInput: { command: 'ls' }, origin: 'permission', questions: [] }).request;
    expect(a.toolInputFingerprint).toBe(b.toolInputFingerprint);
  });
  it('different toolInput → different fingerprint', () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    const a = m.open({ sessionId: 's', tool: 'Bash', toolInput: { command: 'ls' }, origin: 'permission', questions: [] }).request;
    const b = m.open({ sessionId: 's', tool: 'Bash', toolInput: { command: 'pwd' }, origin: 'permission', questions: [] }).request;
    expect(a.toolInputFingerprint).not.toBe(b.toolInputFingerprint);
  });
});

describe('ApprovalManager origin/body/questions storage', () => {
  it('open() requires origin and questions; pendingForSession returns them', () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    const questions: PromptQuestion[] = [
      { kind: 'options', id: 'q1', prompt: 'Allow?',
        options: [{ id: 'yes', label: 'Yes' }, { id: 'no', label: 'No' }] },
    ];
    m.open({
      sessionId: 's', tool: 'Bash', toolInput: { command: 'ls' },
      origin: 'permission', questions, body: 'cmd: ls',
    });
    const pending = m.pendingForSession('s');
    expect(pending).toHaveLength(1);
    expect(pending[0]!.origin).toBe('permission');
    expect(pending[0]!.body).toBe('cmd: ls');
    expect(pending[0]!.questions).toEqual(questions);
  });

  it('pendingForSession omits body (not undefined) when not provided', () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    m.open({
      sessionId: 's', tool: 'Read', toolInput: { file_path: '/x' },
      origin: 'permission', questions: [],
      // body intentionally omitted
    });
    const pending = m.pendingForSession('s');
    expect(pending).toHaveLength(1);
    expect('body' in pending[0]!).toBe(false);
  });

  it('pendingForSession returns copies, not aliases to internal Entry', () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    m.open({
      sessionId: 's', tool: 'Bash', toolInput: {},
      origin: 'permission', questions: [],
    });
    const a = m.pendingForSession('s')[0]!;
    a.origin = 'ask-user-question';
    const b = m.pendingForSession('s')[0]!;
    expect(b.origin).toBe('permission');  // mutation didn't leak
  });
});
