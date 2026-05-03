import { describe, it, expect } from 'vitest';
import { ApprovalManager } from './approval-manager.js';

describe('ApprovalManager', () => {
  it('resolves the decision promise when a client decides', async () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 1000 });
    const { request, decision } = m.open({ sessionId: 's1', tool: 'Bash', toolInput: { command: 'ls' } });
    expect(m.pendingCount()).toBe(1);
    expect(m.decide(request.requestId, { decision: 'allow', reason: 'ok' })).toBe(true);
    await expect(decision).resolves.toEqual({ decision: 'allow', reason: 'ok' });
    expect(m.pendingCount()).toBe(0);
  });

  it('falls back to "ask" when no decision arrives before the timeout', async () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 30 });
    const { decision } = m.open({ sessionId: 's1', tool: 'Edit', toolInput: { path: 'a.md' } });
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
    const a = m.open({ sessionId: 's1', tool: 'A', toolInput: {} });
    const b = m.open({ sessionId: 's1', tool: 'B', toolInput: {} });
    const c = m.open({ sessionId: 's2', tool: 'C', toolInput: {} });
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
    const { decision } = m.open({ sessionId: 's1', tool: 'T', toolInput: {}, onExpire: (a) => seen.push(a.requestId) });
    await decision;
    expect(seen).toHaveLength(1);
  });

  it('cancelForSession does NOT invoke onExpire (only timeout does)', async () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 5000 });
    const seen: string[] = [];
    const { decision } = m.open({
      sessionId: 's1', tool: 'Bash', toolInput: { command: 'ls' },
      onExpire: (a) => seen.push(a.requestId),
    });
    m.cancelForSession('s1');
    // Resolves cleanly to 'ask' with the cancellation reason
    await expect(decision).resolves.toMatchObject({ decision: 'ask' });
    // onExpire was NOT called — that's reserved for the timeout path
    expect(seen).toEqual([]);
  });

  it('cancelOnLastClientGone resolves all pending for a session as ask', async () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 5000 });
    const a = m.open({ sessionId: 's1', tool: 'Bash', toolInput: {} });
    const b = m.open({ sessionId: 's2', tool: 'Edit', toolInput: {} });
    expect(m.cancelOnLastClientGone('s1')).toBe(1);
    await expect(a.decision).resolves.toMatchObject({ decision: 'ask' });
    expect(m.pendingForSession('s2')).toHaveLength(1);
    m.decide(b.request.requestId, { decision: 'allow' });
  });

  it('honors a custom timeoutDecision', async () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 30, timeoutDecision: 'deny', timeoutReason: 'no client' });
    const { decision } = m.open({ sessionId: 's1', tool: 'T', toolInput: {} });
    await expect(decision).resolves.toEqual({ decision: 'deny', reason: 'no client' });
  });
});

describe('ApprovalManager — resolveByToolUseId', () => {
  it('resolves matching entry, returns 1, fulfills decision Promise with the outcome', async () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    const { request, decision } = m.open({
      sessionId: 's', tool: 'Bash', toolInput: { command: 'ls' }, toolUseId: 'tu_1',
    });
    expect(request.toolUseId).toBe('tu_1');
    const n = m.resolveByToolUseId('s', 'tu_1', { decision: 'deny', reason: 'r' });
    expect(n).toBe(1);
    await expect(decision).resolves.toEqual({ decision: 'deny', reason: 'r' });
  });
  it('returns 0 when no entry matches', () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    expect(m.resolveByToolUseId('s', 'tu_missing', { decision: 'ask' })).toBe(0);
  });
  it('returns 0 when toolUseId differs from the open() entry', () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    m.open({ sessionId: 's', tool: 'Bash', toolInput: {}, toolUseId: 'tu_1' });
    expect(m.resolveByToolUseId('s', 'tu_2', { decision: 'ask' })).toBe(0);
  });
  it('returns 0 when sessionId differs', () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    m.open({ sessionId: 's1', tool: 'Bash', toolInput: {}, toolUseId: 'tu_1' });
    expect(m.resolveByToolUseId('s2', 'tu_1', { decision: 'ask' })).toBe(0);
  });
  it('after resolveByToolUseId, the entry is gone from pendingForSession', () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    m.open({ sessionId: 's', tool: 'Bash', toolInput: {}, toolUseId: 'tu_1' });
    expect(m.pendingForSession('s')).toHaveLength(1);
    m.resolveByToolUseId('s', 'tu_1', { decision: 'allow' });
    expect(m.pendingForSession('s')).toHaveLength(0);
  });
});

describe('ApprovalManager — resolveByFingerprint', () => {
  it('resolves single match without toolUseId, returns 1', async () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    const { request, decision } = m.open({
      sessionId: 's', tool: 'Bash', toolInput: { command: 'ls' },
    });
    const fp = request.toolInputFingerprint;
    expect(m.resolveByFingerprint('s', 'Bash', fp, { decision: 'deny', reason: 'x' })).toBe(1);
    await expect(decision).resolves.toEqual({ decision: 'deny', reason: 'x' });
  });
  it('returns 0 when set has 2+ entries with same fingerprint (ambiguous)', () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    const a = m.open({ sessionId: 's', tool: 'Bash', toolInput: { command: 'ls' } }).request;
    m.open({ sessionId: 's', tool: 'Bash', toolInput: { command: 'ls' } });
    expect(m.resolveByFingerprint('s', 'Bash', a.toolInputFingerprint, { decision: 'ask' })).toBe(0);
  });
  it('returns 0 when matching entry has toolUseId (canonical match should have caught it)', () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    const { request } = m.open({
      sessionId: 's', tool: 'Bash', toolInput: { command: 'ls' }, toolUseId: 'tu_1',
    });
    expect(m.resolveByFingerprint('s', 'Bash', request.toolInputFingerprint, { decision: 'ask' })).toBe(0);
  });
  it('returns 0 when no fingerprint match', () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    expect(m.resolveByFingerprint('s', 'Bash', 'a'.repeat(40), { decision: 'ask' })).toBe(0);
  });
  it('returns 0 when toolName differs', () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    const { request } = m.open({ sessionId: 's', tool: 'Bash', toolInput: { command: 'ls' } });
    expect(m.resolveByFingerprint('s', 'Edit', request.toolInputFingerprint, { decision: 'ask' })).toBe(0);
  });
  it('returns 0 when sessionId differs', () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    const { request } = m.open({ sessionId: 's1', tool: 'Bash', toolInput: { command: 'ls' } });
    expect(m.resolveByFingerprint('s2', 'Bash', request.toolInputFingerprint, { decision: 'ask' })).toBe(0);
  });
});

describe('ApprovalManager — toolInputFingerprint', () => {
  it('open() populates toolInputFingerprint on the public PendingApproval', () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    const { request } = m.open({ sessionId: 's', tool: 'Bash', toolInput: { command: 'ls' } });
    expect(request.toolInputFingerprint).toMatch(/^[0-9a-f]{40}$/);
  });
  it('two open() calls with identical toolInput produce identical fingerprints', () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    const a = m.open({ sessionId: 's', tool: 'Bash', toolInput: { command: 'ls' } }).request;
    const b = m.open({ sessionId: 's', tool: 'Bash', toolInput: { command: 'ls' } }).request;
    expect(a.toolInputFingerprint).toBe(b.toolInputFingerprint);
  });
  it('different toolInput → different fingerprint', () => {
    const m = new ApprovalManager({ defaultTimeoutMs: 60_000 });
    const a = m.open({ sessionId: 's', tool: 'Bash', toolInput: { command: 'ls' } }).request;
    const b = m.open({ sessionId: 's', tool: 'Bash', toolInput: { command: 'pwd' } }).request;
    expect(a.toolInputFingerprint).not.toBe(b.toolInputFingerprint);
  });
});
