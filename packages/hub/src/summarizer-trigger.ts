import type { EventBus, NormalizedEvent } from './event-bus.js';
import type { SessionRegistry } from './registry/session-registry.js';
import type { Summarizer } from './summarizer/index.js';

export interface TriggerDeps {
  bus: EventBus;
  registry: SessionRegistry;
  summarizer: Summarizer;
  broadcast: (msg: object) => void;
}

export function wireSummarizerTrigger(deps: TriggerDeps): void {
  const buffers = new Map<string, NormalizedEvent[]>();
  deps.bus.on(async (e) => {
    const arr = buffers.get(e.sessionId) ?? [];
    arr.push(e); buffers.set(e.sessionId, arr);
    if (e.kind !== 'agent-output' && e.kind !== 'error') return;
    const session = deps.registry.get(e.sessionId);
    if (!session) return;
    const events = arr.splice(0).map(toSummaryEvent).filter((x): x is { kind: 'user-prompt'|'tool-call'|'tool-result'|'agent-output'|'error'; text: string } => !!x);
    const summary = await deps.summarizer.summarize({
      sessionId: e.sessionId,
      previousSummary: session.lastSummaryId ? { oneLine: '(prev)', bullets: [] } : null,
      events,
    });
    deps.registry.setLastSummary(e.sessionId, summary.summaryId);
    if (summary.needsDecision) deps.registry.updateState(e.sessionId, 'awaiting-input');
    deps.broadcast({ type: 'session.summary', sessionId: e.sessionId, ...summary });
  });
}

function toSummaryEvent(e: NormalizedEvent): { kind: 'user-prompt'|'tool-call'|'tool-result'|'agent-output'|'error'; text: string } | null {
  switch (e.kind) {
    case 'user-prompt':   return { kind: 'user-prompt',  text: String(e.payload['prompt'] ?? '') };
    case 'tool-call':     return { kind: 'tool-call',    text: `${e.payload['tool']}(${JSON.stringify(e.payload['input'] ?? {})})` };
    case 'tool-result':   return { kind: 'tool-result',  text: String(e.payload['result'] ?? '') };
    case 'agent-output':  return { kind: 'agent-output', text: String(e.payload['stopReason'] ?? '') };
    case 'error':         return { kind: 'error',        text: String(e.payload['error'] ?? '') };
    default: return null;
  }
}
