import type { SessionState, EventKind, NormalizedHookEvent } from '@sesshin/shared';

export interface EventLite {
  kind: EventKind;
  nativeEvent?: NormalizedHookEvent;
}

export function transitionFor(state: SessionState, e: EventLite): SessionState | null {
  if (e.kind === 'agent-internal') {
    if (e.nativeEvent === 'SessionStart' && state === 'starting') return 'idle';
    if (e.nativeEvent === 'SessionEnd') return 'done';
    return null;
  }
  if (e.kind === 'user-prompt' && (state === 'idle' || state === 'awaiting-input' || state === 'error')) return 'running';
  if (e.kind === 'tool-call'  && state === 'running') return null;  // substate update only
  if (e.kind === 'tool-result' && (state === 'running' || state === 'awaiting-confirmation')) return 'running';
  if (e.kind === 'agent-output' && state === 'running') return 'idle';   // heuristic: idle for now; awaiting-input set by summarizer in T39
  if (e.kind === 'error' && state === 'running') return 'error';
  return null;
}
