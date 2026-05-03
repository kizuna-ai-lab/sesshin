import { describe, it, expect } from 'vitest';
import { exitPlanModeHandler } from './exit-plan-mode.js';

const ctx = { permissionMode: 'plan' as const, cwd: '/x', sessionAllowList: [] };

describe('exitPlanModeHandler', () => {
  it('renders plan body + 3 options', () => {
    const out = exitPlanModeHandler.render({ plan: '# Plan\n\nDo X then Y' }, ctx);
    expect(out.origin).toBe('exit-plan-mode');
    expect(out.body).toBe('# Plan\n\nDo X then Y');
    const keys = out.questions[0]!.options.map(o => o.key);
    expect(keys).toEqual(['yes-default', 'yes-accept-edits', 'no']);
  });
  it('yes-default → allow', () => {
    expect(exitPlanModeHandler.decide([{ questionIndex: 0, selectedKeys: ['yes-default'] }], {}, ctx))
      .toEqual({ kind: 'allow' });
  });
  it('no with feedback → deny + additionalContext', () => {
    const d = exitPlanModeHandler.decide(
      [{ questionIndex: 0, selectedKeys: ['no'], freeText: 'change Y to Z first' }], {}, ctx);
    expect(d).toEqual({ kind: 'deny', additionalContext: 'change Y to Z first' });
  });
});

describe('exitPlanModeHandler — PermissionRequest decision-shape mapping invariants', () => {
  // The wire.ts onPermissionRequestApproval adapter (T15) maps HookDecision
  // to PermissionRequest-shape JSON. Here we verify the kinds and fields
  // the handler produces are exactly what that adapter expects.
  const c = { permissionMode: 'default' as const, cwd: '/', sessionAllowList: [] };
  it('yes-default → kind:allow (adapter → behavior:"allow")', () => {
    expect(exitPlanModeHandler.decide(
      [{ questionIndex: 0, selectedKeys: ['yes-default'] }], { plan: 'p' }, c,
    )).toEqual({ kind: 'allow' });
  });
  it('yes-accept-edits → kind:allow (adapter → behavior:"allow")', () => {
    expect(exitPlanModeHandler.decide(
      [{ questionIndex: 0, selectedKeys: ['yes-accept-edits'] }], { plan: 'p' }, c,
    )).toEqual({ kind: 'allow' });
  });
  it('no with freeText → kind:deny + additionalContext (adapter → behavior:"deny" + message)', () => {
    expect(exitPlanModeHandler.decide(
      [{ questionIndex: 0, selectedKeys: ['no'], freeText: 'try X' }], { plan: 'p' }, c,
    )).toEqual({ kind: 'deny', additionalContext: 'try X' });
  });
  it('no without freeText → plain kind:deny (adapter → behavior:"deny" w/o message)', () => {
    expect(exitPlanModeHandler.decide(
      [{ questionIndex: 0, selectedKeys: ['no'] }], { plan: 'p' }, c,
    )).toEqual({ kind: 'deny' });
  });
  it('unrecognized selectedKey → kind:ask (adapter → null passthrough)', () => {
    expect(exitPlanModeHandler.decide(
      [{ questionIndex: 0, selectedKeys: ['bogus'] }], { plan: 'p' }, c,
    )).toEqual({ kind: 'ask' });
  });
});
