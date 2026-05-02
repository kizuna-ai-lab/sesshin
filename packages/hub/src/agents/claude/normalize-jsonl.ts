import { randomUUID } from 'node:crypto';
import type { NormalizedEvent } from '../../event-bus.js';

export function jsonlLineToEvent(sessionId: string, line: string): NormalizedEvent | null {
  let parsed: any;
  try { parsed = JSON.parse(line); } catch { return null; }
  if (!parsed || typeof parsed !== 'object') return null;

  const ts = parseTs(parsed.timestamp);
  const eventId = randomUUID();

  if (parsed.type === 'user') {
    // user lines may be plain prompts or tool_result responses (see gate 2 §12.2)
    const content = parsed.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'tool_result') {
          return {
            eventId, sessionId, ts, kind: 'tool-result',
            payload: { tool: block.name, result: block.content },
            source: 'observer:session-file-tail',
          };
        }
      }
    }
    return {
      eventId, sessionId, ts, kind: 'user-prompt',
      payload: { prompt: extractContent(content) },
      source: 'observer:session-file-tail',
    };
  }
  if (parsed.type === 'assistant') {
    const content = parsed.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block?.type === 'tool_use') {
          return {
            eventId, sessionId, ts, kind: 'tool-call',
            payload: { tool: block.name, input: block.input },
            source: 'observer:session-file-tail',
          };
        }
      }
    }
    return {
      eventId, sessionId, ts, kind: 'agent-output',
      payload: { content: extractContent(content) },
      source: 'observer:session-file-tail',
    };
  }
  return { eventId, sessionId, ts, kind: 'agent-internal', payload: parsed, source: 'observer:session-file-tail' };
}

function parseTs(s: unknown): number {
  if (typeof s === 'string') { const t = Date.parse(s); if (!Number.isNaN(t)) return t; }
  return Date.now();
}

function extractContent(c: unknown): string {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((b: any) => (b?.text ?? '')).join('');
  return '';
}
