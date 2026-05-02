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
