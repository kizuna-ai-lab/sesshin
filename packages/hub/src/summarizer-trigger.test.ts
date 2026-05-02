import { describe, it, expect } from 'vitest';
import { wireSummarizerTrigger } from './summarizer-trigger.js';
import { EventBus } from './event-bus.js';
import { SessionRegistry } from './registry/session-registry.js';
import { Summarizer } from './summarizer/index.js';

function fakeSummarizer(label = 'ok'): Summarizer {
  return new Summarizer({
    modeBPrime: async () => ({ text: `{"oneLine":"${label}","bullets":[],"needsDecision":false,"suggestedNext":null}`, inputTokens: 1, outputTokens: 1, model: 'claude-haiku-4-5' }),
    modeB:      async () => { throw new Error('not used'); },
    heuristicTail: () => '',
  });
}

describe('summarizer trigger', () => {
  it('fires on agent-output for a known session and broadcasts session.summary', async () => {
    const reg = new SessionRegistry(); reg.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    const bus = new EventBus();
    const broadcasts: any[] = [];
    wireSummarizerTrigger({ bus, registry: reg, summarizer: fakeSummarizer('hi'), broadcast: (m) => broadcasts.push(m) });
    bus.emit({ eventId: 'e1', sessionId: 's1', kind: 'user-prompt', payload: { prompt: 'do' }, source: 'observer:hook-ingest', ts: 1 });
    bus.emit({ eventId: 'e2', sessionId: 's1', kind: 'agent-output', payload: { stopReason: 'end_turn' }, source: 'observer:hook-ingest', ts: 2 });
    await new Promise((r) => setTimeout(r, 20));
    const summary = broadcasts.find((b) => b.type === 'session.summary');
    expect(summary).toBeTruthy();
    expect(summary.oneLine).toBe('hi');
    expect(reg.get('s1')!.lastSummaryId).toBeTruthy();
  });
});
