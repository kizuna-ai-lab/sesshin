import { randomUUID } from 'node:crypto';
import type { EventKind } from '@sesshin/shared';
import type { NormalizedEvent } from '../../event-bus.js';

export interface HookEnvelope {
  agent: string;
  sessionId: string;
  ts: number;
  event: string;
  raw: Record<string, unknown>;
}

export function hookEnvelopeToEvent(env: HookEnvelope): NormalizedEvent {
  const { kind, payload } = mapEvent(env.event, env.raw);
  return {
    eventId: randomUUID(),
    sessionId: env.sessionId,
    kind,
    payload,
    source: 'observer:hook-ingest',
    ts: env.ts,
    nativeEvent: typeof env.raw['nativeEvent'] === 'string' ? env.raw['nativeEvent'] : env.event,
  };
}

function mapEvent(event: string, raw: Record<string, unknown>): { kind: EventKind; payload: Record<string, unknown> } {
  switch (event) {
    case 'SessionStart':
      return { kind: 'agent-internal', payload: { phase: 'session-start' } };
    case 'UserPromptSubmit':
      return { kind: 'user-prompt', payload: { prompt: pick(raw, 'prompt') } };
    case 'PreToolUse':
      return { kind: 'tool-call', payload: { tool: pick(raw, 'tool_name'), input: raw['tool_input'] } };
    case 'PostToolUse':
      return { kind: 'tool-result', payload: { tool: pick(raw, 'tool_name'), result: raw['tool_response'] } };
    case 'Stop':
      return { kind: 'agent-output', payload: { stopReason: pick(raw, 'stop_reason') } };
    case 'StopFailure':
      return { kind: 'error', payload: { error: pick(raw, 'error') ?? 'unknown' } };
    case 'SessionEnd':
      return { kind: 'agent-internal', payload: { phase: 'session-end' } };
    default:
      return { kind: 'agent-internal', payload: { ...raw } };
  }
}

function pick<T extends Record<string, unknown>>(o: T, key: string): unknown {
  return o[key];
}
