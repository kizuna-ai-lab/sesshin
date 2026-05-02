import { randomUUID } from 'node:crypto';
import { assemblePrompt } from './prompt-assembler.js';
import { heuristicSummary } from './heuristic.js';
import type { Summary } from '@sesshin/shared';

export interface SummarizeInput {
  sessionId: string;
  previousSummary: { oneLine: string; bullets: string[] } | null;
  events: { kind: 'user-prompt' | 'tool-call' | 'tool-result' | 'agent-output' | 'error'; text: string }[];
}

export interface ModeFn {
  (req: { prompt: string; instructions: string; model: string; maxOutputTokens: number }): Promise<{ text: string; inputTokens: number; outputTokens: number; model: string }>;
}

export interface SummarizerDeps {
  modeBPrime: ModeFn;
  modeB:      ModeFn;
  heuristicTail: (sessionId: string) => string;
  instructions?: string;
  model?: string;
  maxOutputTokens?: number;
}

const SYSTEM_INSTRUCTIONS = `You are a terse summarizer for an ambient awareness system.
Output ONLY a JSON object with the schema:
{"oneLine":"...","bullets":["..."],"needsDecision":bool,"suggestedNext":string|null}
oneLine ≤ 100 chars; bullets ≤ 5 items × 80 chars. No prose.`;

export class Summarizer {
  private bPrimeDisabled = new Set<string>();
  constructor(private deps: SummarizerDeps) {}

  async summarize(input: SummarizeInput): Promise<Summary> {
    const prompt = assemblePrompt({ previousSummary: input.previousSummary, events: input.events, maxChars: 8000 });
    const req = {
      prompt,
      instructions: this.deps.instructions ?? SYSTEM_INSTRUCTIONS,
      model: this.deps.model ?? 'claude-haiku-4-5',
      maxOutputTokens: this.deps.maxOutputTokens ?? 250,
    };

    // Mode B prime (unless disabled for this session)
    if (!this.bPrimeDisabled.has(input.sessionId)) {
      try {
        const r = await this.deps.modeBPrime(req);
        return parseSummary(r.text, r.model, input.previousSummary);
      } catch (e: any) {
        if (e?.kind === 'auth') this.bPrimeDisabled.add(input.sessionId);
        // fall through to Mode B
      }
    }

    // Mode B subprocess
    try {
      const r = await this.deps.modeB(req);
      return parseSummary(r.text, r.model, input.previousSummary);
    } catch { /* fall through */ }

    // Heuristic last resort
    const tail = this.deps.heuristicTail(input.sessionId);
    const h = heuristicSummary(tail);
    return {
      summaryId: 'sum-' + randomUUID().slice(0, 8),
      oneLine: h.oneLine,
      bullets: h.bullets,
      needsDecision: false,
      suggestedNext: null,
      since: input.previousSummary ? 'prev' : null,
      generatedAt: Date.now(),
      generatorModel: 'heuristic',
    };
  }
}

function parseSummary(text: string, model: string, previousSummary: SummarizeInput['previousSummary']): Summary {
  let parsed: any;
  try { parsed = JSON.parse(text); } catch {
    // The model emitted prose around JSON; attempt to extract the JSON object.
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { parsed = JSON.parse(text.slice(start, end + 1)); }
      catch { parsed = { oneLine: text.slice(0, 100), bullets: [], needsDecision: false, suggestedNext: null }; }
    } else {
      parsed = { oneLine: text.slice(0, 100), bullets: [], needsDecision: false, suggestedNext: null };
    }
  }
  return {
    summaryId: 'sum-' + randomUUID().slice(0, 8),
    oneLine: String(parsed.oneLine ?? '').slice(0, 100),
    bullets: Array.isArray(parsed.bullets) ? parsed.bullets.slice(0, 5).map((b: unknown) => String(b).slice(0, 80)) : [],
    needsDecision: Boolean(parsed.needsDecision),
    suggestedNext: parsed.suggestedNext ?? null,
    since: previousSummary ? 'prev' : null,
    generatedAt: Date.now(),
    generatorModel: model,
  };
}
