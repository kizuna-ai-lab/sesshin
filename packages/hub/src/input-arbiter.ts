import type { SessionState } from '@sesshin/shared';

export type InputSource = 'laptop' | `remote-adapter:${string}`;
export type AcceptResult = { ok: true } | { ok: false; reason: string };

export function canAcceptInput(state: SessionState, source: InputSource): AcceptResult {
  if (source === 'laptop') return { ok: true };
  if (state === 'idle' || state === 'awaiting-input' || state === 'awaiting-confirmation') return { ok: true };
  if (state === 'running') return { ok: false, reason: 'running' };
  if (state === 'starting' || state === 'error') return { ok: true };
  return { ok: false, reason: 'session-offline' };  // done, interrupted
}
