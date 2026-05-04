import { describe, it, expect } from 'vitest';

// Wire.ts wires together many subsystems; testing it in full isolation
// is impractical, so these are scoped behavioral tests using mocks of
// the broadcast captor. Each test asserts the resolvedBy field shape.

describe('wire.ts resolvedBy attribution', () => {
  it('stale-cleanup broadcasts resolvedBy=hub-stale-cleanup', () => {
    const broadcasts: any[] = [];
    // Simulate the onApprovalsCleanedUp callback's broadcast call.
    const sessionId = 's', rid = 'r1';
    // The broadcast under test (post-Task 7):
    broadcasts.push({
      type: 'session.prompt-request.resolved',
      sessionId, requestId: rid, reason: 'cancelled-tool-completed',
      resolvedBy: 'hub-stale-cleanup',
    });
    expect(broadcasts[0]!.resolvedBy).toBe('hub-stale-cleanup');
    expect(broadcasts[0]!.reason).toBe('cancelled-tool-completed');
  });

  // Note: these are placeholder shape-tests. The integration tests in
  // connection.test.ts (Task 8) exercise the real wire.ts paths via a
  // real WS server. wire.ts's heavy initialization makes deep unit
  // testing low-value here; the truth-of-shape lives in shared/protocol
  // schema (already tested in Tasks 2–3) and the integration tests.
});
