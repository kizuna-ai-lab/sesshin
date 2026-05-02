import { describe, it, expect } from 'vitest';
import { wireSummarizerTrigger } from './summarizer-trigger.js';
import { EventBus } from './event-bus.js';
import { SessionRegistry } from './registry/session-registry.js';
import { Summarizer } from './summarizer/index.js';

interface CapturedReq { prompt: string; instructions: string; model: string; maxOutputTokens: number }

function fakeSummarizer(label = 'ok', captured?: CapturedReq[]): Summarizer {
  return new Summarizer({
    modeBPrime: async (req) => {
      captured?.push(req);
      return { text: `{"oneLine":"${label}","bullets":[],"needsDecision":false,"suggestedNext":null}`, inputTokens: 1, outputTokens: 1, model: 'claude-haiku-4-5' };
    },
    modeB:      async () => { throw new Error('not used'); },
    heuristicTail: () => '',
  });
}

describe('summarizer trigger', () => {
  it('fires on agent-output for a known session and broadcasts session.summary (with content)', async () => {
    const reg = new SessionRegistry();
    reg.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    const bus = new EventBus();
    const broadcasts: any[] = [];
    wireSummarizerTrigger({ bus, registry: reg, summarizer: fakeSummarizer('hi'), broadcast: (m) => broadcasts.push(m), debounceMs: 10 });
    bus.emit({ eventId: 'e1', sessionId: 's1', kind: 'user-prompt',  payload: { prompt: 'do' },                source: 'observer:hook-ingest', ts: 1 });
    bus.emit({ eventId: 'e2', sessionId: 's1', kind: 'agent-output', payload: { content: 'here is my reply' }, source: 'observer:session-file-tail', ts: 2 });
    await new Promise((r) => setTimeout(r, 60));
    const summary = broadcasts.find((b) => b.type === 'session.summary');
    expect(summary).toBeTruthy();
    expect(summary.oneLine).toBe('hi');
    expect(reg.get('s1')!.lastSummaryId).toBeTruthy();
  });

  it('feeds the JSONL assistant content (not the Stop hook stopReason) into the summary prompt', async () => {
    // This is the bug from live testing: Stop hook reaches the bus first
    // with payload.stopReason="end_turn"; JSONL assistant follows ~200ms
    // later with payload.content="actual text". The model must see the
    // actual text, not a bare/empty agent-output line.
    const reg = new SessionRegistry();
    reg.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    const bus = new EventBus();
    const captured: CapturedReq[] = [];
    wireSummarizerTrigger({ bus, registry: reg, summarizer: fakeSummarizer('ok', captured), broadcast: () => {}, debounceMs: 30 });
    bus.emit({ eventId: 'e1', sessionId: 's1', kind: 'user-prompt',  payload: { prompt: 'hello' },                                       source: 'observer:hook-ingest',         ts: 1 });
    bus.emit({ eventId: 'e2', sessionId: 's1', kind: 'agent-output', payload: { stopReason: 'end_turn' },                                source: 'observer:hook-ingest',         ts: 2 });
    bus.emit({ eventId: 'e3', sessionId: 's1', kind: 'agent-output', payload: { content: 'Hello! What would you like to work on?' },    source: 'observer:session-file-tail',   ts: 3 });
    await new Promise((r) => setTimeout(r, 80));
    expect(captured).toHaveLength(1);
    expect(captured[0]!.prompt).toContain('hello');
    expect(captured[0]!.prompt).toContain('Hello! What would you like to work on?');
    // The bare `[agent-output] end_turn` polluted the prompt before the fix.
    expect(captured[0]!.prompt).not.toContain('end_turn');
  });

  it('debounces multiple agent-output events into a single summary', async () => {
    const reg = new SessionRegistry();
    reg.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    const bus = new EventBus();
    const captured: CapturedReq[] = [];
    wireSummarizerTrigger({ bus, registry: reg, summarizer: fakeSummarizer('ok', captured), broadcast: () => {}, debounceMs: 30 });
    bus.emit({ eventId: 'e1', sessionId: 's1', kind: 'agent-output', payload: { stopReason: 'end_turn' }, source: 'observer:hook-ingest',         ts: 1 });
    bus.emit({ eventId: 'e2', sessionId: 's1', kind: 'agent-output', payload: { content: 'reply text' }, source: 'observer:session-file-tail',   ts: 2 });
    await new Promise((r) => setTimeout(r, 80));
    expect(captured).toHaveLength(1);
  });
});
