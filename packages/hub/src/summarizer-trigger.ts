import type { EventBus, NormalizedEvent } from './event-bus.js';
import type { SessionRegistry } from './registry/session-registry.js';
import type { Summarizer } from './summarizer/index.js';

export interface TriggerDeps {
  bus: EventBus;
  registry: SessionRegistry;
  summarizer: Summarizer;
  broadcast: (msg: object) => void;
  /**
   * How long to wait after the last agent-output / error event before firing
   * the summary. JSONL session-file-tail polls every 200ms, so a short
   * debounce lets the JSONL assistant block (which carries the real response
   * text) catch up with the Stop hook (which only carries `stopReason`).
   * Tests can lower this. Default 400ms.
   */
  debounceMs?: number;
}

type SummaryEvent = { kind: 'user-prompt'|'tool-call'|'tool-result'|'agent-output'|'error'; text: string };

export function wireSummarizerTrigger(deps: TriggerDeps): void {
  const debounceMs = deps.debounceMs ?? 400;
  const buffers = new Map<string, NormalizedEvent[]>();
  const timers  = new Map<string, ReturnType<typeof setTimeout>>();

  const fire = async (sessionId: string): Promise<void> => {
    timers.delete(sessionId);
    const arr = buffers.get(sessionId);
    if (!arr || arr.length === 0) return;
    // Session may have been unregistered between the debounce timer being
    // set and this fire() running (e.g., the CLI exited and DELETE'd while
    // the timer was still pending). In that case we still want to flush
    // the buffered summary to clients, but skip the registry write-backs.
    const session = deps.registry.get(sessionId);
    const events = arr.splice(0).map(toSummaryEvent).filter((x): x is SummaryEvent => !!x);
    // If the only thing in the window was an empty Stop-hook agent-output
    // (no content from JSONL yet), there's nothing useful to summarise.
    if (events.length === 0) return;
    const summary = await deps.summarizer.summarize({
      sessionId,
      previousSummary: session?.lastSummaryId ? { oneLine: '(prev)', bullets: [] } : null,
      events,
    });
    if (session) {
      deps.registry.setLastSummary(sessionId, summary.summaryId);
      if (summary.needsDecision) deps.registry.updateState(sessionId, 'awaiting-input');
    }
    deps.broadcast({ type: 'session.summary', sessionId, ...summary });
  };

  deps.bus.on((e) => {
    const arr = buffers.get(e.sessionId) ?? [];
    arr.push(e);
    buffers.set(e.sessionId, arr);
    if (e.kind !== 'agent-output' && e.kind !== 'error') return;
    const existing = timers.get(e.sessionId);
    if (existing) clearTimeout(existing);
    timers.set(e.sessionId, setTimeout(() => { void fire(e.sessionId); }, debounceMs));
  });
}

function toSummaryEvent(e: NormalizedEvent): SummaryEvent | null {
  switch (e.kind) {
    case 'user-prompt':   return { kind: 'user-prompt',  text: String(e.payload['prompt'] ?? '') };
    case 'tool-call':     return { kind: 'tool-call',    text: `${e.payload['tool']}(${JSON.stringify(e.payload['input'] ?? {})})` };
    case 'tool-result':   return { kind: 'tool-result',  text: String(e.payload['result'] ?? '') };
    case 'agent-output': {
      // JSONL assistant blocks carry `content` (the real response text). The
      // Stop hook only carries `stopReason` ('end_turn' etc.) — that's
      // metadata, not text the user wants summarised. Drop empty entries so
      // the summary prompt is not polluted with bare `[agent-output]` lines.
      const content = e.payload['content'];
      const text = typeof content === 'string' ? content : '';
      return text.length > 0 ? { kind: 'agent-output', text } : null;
    }
    case 'error':         return { kind: 'error',        text: String(e.payload['error'] ?? '') };
    default: return null;
  }
}
