// Per-session state machine that folds raw EventBus events into chat-style
// MessageRows. Each emitted message is persisted via db.messages.append and
// broadcast via the supplied callback (T18 wires that into the WS server).
//
// Event matching: dispatches on both `kind` (the literal event kind from the
// plan's vocabulary, e.g. 'user-prompt') and `nativeEvent` (the hook-level
// name, e.g. 'Stop', 'PreCompact', 'PermissionRequest', 'SessionEnd'). This
// keeps the synthesizer aligned with how observers normalize events:
//   - `UserPromptSubmit` → kind='user-prompt' (matched via `kind`)
//   - `Stop`             → kind='agent-output' + nativeEvent='Stop'
//   - `PreCompact`       → kind='agent-internal' + nativeEvent='PreCompact'
//   - `PostCompact`      → kind='agent-internal' + nativeEvent='PostCompact'
//   - `PermissionRequest`→ kind='agent-internal' + nativeEvent='PermissionRequest'
//   - `SessionEnd`       → kind='agent-internal' + nativeEvent='SessionEnd'
//
// Production hook payloads carry `last_assistant_message` only when the cc
// hook layer chooses to surface it; the synthesizer is conservative and skips
// `Stop` events without it.

import { ulid } from '@sesshin/shared';
import type { Db, MessageRow } from '../storage/db.js';
import type { EventBus, NormalizedEvent } from '../event-bus.js';

export interface SessionMessageBroadcast {
  type: 'session.message';
  sessionId: string;
  message: {
    id: string;
    senderType: 'user' | 'agent' | 'system';
    content: string;
    format: 'text' | 'markdown';
    requiresUserInput: boolean;
    createdAt: number;
  };
}

interface TurnState {
  open: boolean;
  awaitingPermission: boolean;
}

export interface SynthesizerOpts {
  db: Db;
  bus: EventBus;
  broadcast: (msg: SessionMessageBroadcast) => void;
}

type StopPayload = { last_assistant_message?: unknown; stop_hook_active?: unknown };
type UserPromptPayload = { prompt?: unknown };

/** What kind of folded event this is, after normalising both `kind` and `nativeEvent`. */
type Folded =
  | { tag: 'user-prompt'; prompt: string }
  | { tag: 'permission-request' }
  | { tag: 'stop'; lastAssistantMessage: string | null; stopHookActive: boolean }
  | { tag: 'pre-compact' }
  | { tag: 'post-compact' }
  | { tag: 'session-end' }
  | { tag: 'ignore' };

function fold(e: NormalizedEvent): Folded {
  // Allow loose envelopes from tests (they cast through `as never`); read what
  // we can without trusting the schema discriminator.
  const native = e.nativeEvent;
  const payload = (e.payload ?? {}) as Record<string, unknown>;

  // user-prompt
  if (e.kind === 'user-prompt' || native === 'UserPromptSubmit') {
    const p = (payload as UserPromptPayload).prompt;
    if (typeof p === 'string') return { tag: 'user-prompt', prompt: p };
    return { tag: 'ignore' };
  }

  // stop  — match either the literal 'stop' kind (used in tests) or the
  // production `nativeEvent: 'Stop'`.
  if ((e.kind as string) === 'stop' || native === 'Stop') {
    const sp = payload as StopPayload;
    const last = typeof sp.last_assistant_message === 'string' ? sp.last_assistant_message : null;
    const active = sp.stop_hook_active === true;
    return { tag: 'stop', lastAssistantMessage: last, stopHookActive: active };
  }

  // permission-request — sets awaitingPermission flag on the open turn.
  if ((e.kind as string) === 'permission-request' || native === 'PermissionRequest') {
    return { tag: 'permission-request' };
  }

  // compaction dividers
  if ((e.kind as string) === 'pre-compact' || native === 'PreCompact') return { tag: 'pre-compact' };
  if ((e.kind as string) === 'post-compact' || native === 'PostCompact') return { tag: 'post-compact' };

  // session-end clears any open turn so a session that ended mid-turn doesn't
  // leak state into a future re-registered session id.
  if ((e.kind as string) === 'session-end' || native === 'SessionEnd') return { tag: 'session-end' };

  return { tag: 'ignore' };
}

export class Synthesizer {
  private turns = new Map<string, TurnState>();
  private listener = (e: NormalizedEvent): void => this.onEvent(e);
  private started = false;

  constructor(private readonly opts: SynthesizerOpts) {}

  start(): void {
    if (this.started) return;
    this.opts.bus.on(this.listener);
    this.started = true;
  }

  stop(): void {
    if (!this.started) return;
    this.opts.bus.off(this.listener);
    this.turns.clear();
    this.started = false;
  }

  private onEvent(e: NormalizedEvent): void {
    const f = fold(e);
    const evtId = (e as { eventId?: string; id?: string }).eventId ?? (e as { id?: string }).id ?? '';
    switch (f.tag) {
      case 'user-prompt': {
        this.emitMessage(e.sessionId, 'user', f.prompt, false, [evtId]);
        this.turns.set(e.sessionId, { open: true, awaitingPermission: false });
        return;
      }
      case 'permission-request': {
        const t = this.turns.get(e.sessionId);
        if (t?.open) t.awaitingPermission = true;
        return;
      }
      case 'stop': {
        const t = this.turns.get(e.sessionId);
        if (!t?.open) return;
        if (f.lastAssistantMessage === null) {
          // No assistant message to surface; just close the turn.
          this.turns.delete(e.sessionId);
          return;
        }
        const requiresUserInput = f.stopHookActive || t.awaitingPermission;
        this.emitMessage(e.sessionId, 'agent', f.lastAssistantMessage, requiresUserInput, [evtId]);
        this.turns.delete(e.sessionId);
        return;
      }
      case 'pre-compact':
      case 'post-compact': {
        const content = f.tag === 'pre-compact' ? 'Conversation compacted' : 'Compaction complete';
        this.emitMessage(e.sessionId, 'system', content, false, [evtId]);
        return;
      }
      case 'session-end': {
        this.turns.delete(e.sessionId);
        return;
      }
      case 'ignore':
      default:
        return;
    }
  }

  private emitMessage(
    sessionId: string,
    sender: 'user' | 'agent' | 'system',
    content: string,
    requiresUserInput: boolean,
    sourceEventIds: string[],
  ): void {
    const row: MessageRow = {
      id: ulid(),
      sessionId,
      senderType: sender,
      content,
      format: 'text',
      requiresUserInput,
      createdAt: Date.now(),
      sourceEventIds,
    };
    this.opts.db.messages.append(row);
    this.opts.broadcast({
      type: 'session.message',
      sessionId,
      message: {
        id: row.id,
        senderType: row.senderType,
        content: row.content,
        format: row.format,
        requiresUserInput: row.requiresUserInput,
        createdAt: row.createdAt,
      },
    });
  }
}
