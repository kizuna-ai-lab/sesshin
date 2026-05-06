import { z } from 'zod';
import { SessionInfoSchema, SessionStateEnum, SubstateSchema } from './session.js';
import { SummarySchema } from './summary.js';
import { EventSchema } from './events.js';
import { ActionEnum } from './actions.js';

export const PROTOCOL_VERSION = 1 as const;

export const ClientKindEnum = z.enum(['debug-web','telegram-adapter','m5stick','watch','mobile','other']);
export const CapabilityEnum = z.enum(['summary','events','terminal','actions','voice','history','state','attention']);

// ---- Upstream (client → hub) ----
export const ClientIdentifySchema = z.object({
  type:     z.literal('client.identify'),
  protocol: z.literal(PROTOCOL_VERSION),
  client:   z.object({
    kind:         ClientKindEnum,
    version:      z.string(),
    capabilities: z.array(CapabilityEnum),
  }),
});
export const SubscribeSchema = z.object({
  type:     z.literal('subscribe'),
  sessions: z.union([z.array(z.string()), z.literal('all')]),
  since:    z.string().nullable(),
});
export const UnsubscribeSchema = z.object({
  type:     z.literal('unsubscribe'),
  sessions: z.array(z.string()),
});
export const TerminalSubscribeSchema = z.object({
  type:      z.literal('terminal.subscribe'),
  sessionId: z.string(),
});
export const TerminalUnsubscribeSchema = z.object({
  type:      z.literal('terminal.unsubscribe'),
  sessionId: z.string(),
});
export const InputTextSchema = z.object({
  type:      z.literal('input.text'),
  sessionId: z.string(),
  text:      z.string(),
});
export const InputActionSchema = z.object({
  type:      z.literal('input.action'),
  sessionId: z.string(),
  action:    ActionEnum,
});
export const ClientPongSchema = z.object({
  type:  z.literal('client.pong'),
  nonce: z.string(),
});

// ---- Prompt request / response (PromptRequest shape, mirrors claude internal) ----
export const PromptOptionSchema = z.object({
  key:         z.string(),
  label:       z.string(),
  description: z.string().optional(),
  preview:     z.string().optional(),
  recommended: z.boolean().optional(),
});

export const PromptQuestionSchema = z.object({
  prompt:        z.string(),
  header:        z.string().optional(),
  multiSelect:   z.boolean(),
  allowFreeText: z.boolean(),
  options:       z.array(PromptOptionSchema),
});

// Sent by a client in response to a session.prompt-request. Carries the
// user's answer(s) for a pending prompt the hub is holding open (the
// originating hook handler is blocked waiting for this response).
export const PromptResponseSchema = z.object({
  type:       z.literal('prompt-response'),
  sessionId:  z.string(),
  requestId:  z.string(),
  answers:    z.array(z.object({
    questionIndex:   z.number().int(),
    selectedKeys:    z.array(z.string()),
    freeText:        z.string().optional(),
    notes:           z.string().optional(),
  })),
});

export const UpstreamMessageSchema = z.discriminatedUnion('type', [
  ClientIdentifySchema, SubscribeSchema, UnsubscribeSchema,
  TerminalSubscribeSchema, TerminalUnsubscribeSchema,
  InputTextSchema, InputActionSchema, ClientPongSchema,
  PromptResponseSchema,
]);
export type UpstreamMessage = z.infer<typeof UpstreamMessageSchema>;

// ---- Downstream (hub → client) ----
export const ServerHelloSchema = z.object({
  type:      z.literal('server.hello'),
  protocol:  z.literal(PROTOCOL_VERSION),
  machine:   z.string(),
  supported: z.array(CapabilityEnum),
});
export const SessionListSchema = z.object({
  type:     z.literal('session.list'),
  sessions: z.array(SessionInfoSchema),
});
export const SessionAddedSchema = z.object({
  type:    z.literal('session.added'),
  session: SessionInfoSchema,
});
export const SessionRemovedSchema = z.object({
  type:      z.literal('session.removed'),
  sessionId: z.string(),
});
export const SessionStateMsgSchema = z.object({
  type:      z.literal('session.state'),
  sessionId: z.string(),
  state:     SessionStateEnum,
  substate:  SubstateSchema,
});
export const SessionEventMsgSchema = EventSchema; // type: "session.event"
// NOTE: zod's discriminatedUnion requires a flat ZodObject (it reads the
// `type` literal at the top level), so we cannot use `.and(SummarySchema)`
// here — that returns a ZodIntersection and breaks the union. Instead we
// merge SummarySchema's shape into a flat object via `.extend(...)` so the
// resulting schema is a ZodObject with `type` as a literal at the top.
export const SessionSummaryMsgSchema = SummarySchema.extend({
  type:      z.literal('session.summary'),
  sessionId: z.string(),
});
export const SessionAttentionSchema = z.object({
  type:       z.literal('session.attention'),
  sessionId:  z.string(),
  severity:   z.enum(['info','warning','error']),
  reason:     z.string(),
  summaryId:  z.string().optional(),
});
export const TerminalSnapshotSchema = z.object({
  type:      z.literal('terminal.snapshot'),
  sessionId: z.string(),
  seq:       z.number().int(),
  cols:      z.number().int().positive(),
  rows:      z.number().int().positive(),
  data:      z.string(),
});
export const TerminalDeltaSchema = z.object({
  type:      z.literal('terminal.delta'),
  sessionId: z.string(),
  seq:       z.number().int(),
  data:      z.string(),
});
export const TerminalResizeSchema = z.object({
  type:      z.literal('terminal.resize'),
  sessionId: z.string(),
  cols:      z.number().int().positive(),
  rows:      z.number().int().positive(),
});
export const TerminalEndedSchema = z.object({
  type:      z.literal('terminal.ended'),
  sessionId: z.string(),
  reason:    z.string().nullable().optional(),
});
export const ServerErrorSchema = z.object({
  type:    z.literal('server.error'),
  code:    z.string(),
  message: z.string().optional(),
});
export const ServerPingSchema = z.object({
  type:  z.literal('server.ping'),
  nonce: z.string(),
});
// Server-side announcement that the hub is holding a hook open pending a
// prompt response. The hook handler will block on the hub's response until
// either a client posts PromptResponseSchema for the matching requestId,
// or the hub's internal timeout elapses (in which case the hub falls back
// to its origin-specific default — for permission prompts, "ask" so
// claude's TUI takes over).
export const SessionPromptRequestSchema = z.object({
  type:       z.literal('session.prompt-request'),
  sessionId:  z.string(),
  requestId:  z.string(),
  origin:     z.enum(['permission','ask-user-question','exit-plan-mode','enter-plan-mode']),
  toolName:   z.string(),
  toolUseId:  z.string().optional(),
  expiresAt:  z.number().int(),
  body:       z.string().optional(),
  questions:  z.array(PromptQuestionSchema),
});
// Server tells clients a previously announced prompt-request has been
// resolved (by another client, by timeout, or by the originating session
// ending). Clients use this to dismiss any pending prompt UI for requestId.
export const SessionPromptRequestResolvedSchema = z.object({
  type:       z.literal('session.prompt-request.resolved'),
  sessionId:  z.string(),
  requestId:  z.string(),
  reason:     z.enum([
    'decided',
    'timeout',
    'cancelled-no-clients',
    'cancelled-tool-completed',
    'session-ended',
    // child-session-changed: the underlying Claude conversation crossed a
    // session boundary (raw.session_id changed via /clear, --resume, or
    // fresh startup) while this approval was still pending. The outgoing
    // child can no longer answer it, so we resolve it as a system-initiated
    // cancellation (resolvedBy: null). Emitted from wire.ts boundary
    // detection alongside session.child-changed.
    'child-session-changed',
  ]),
  // Identifies who caused the resolution. Lets clients render UX
  // distinguishing "approved by another client" from system-initiated
  // events (timeout, session-end). 'remote-adapter:<kind>' for client
  // decisions; 'hub-stale-cleanup' for hub-driven cleanup; null/missing
  // for system actions with no actor.
  resolvedBy: z.string().nullable().optional(),
});

// Server tells subscribers a session's user-set sticky configuration
// changed (pin / quietUntil / sessionGateOverride). Carries the full
// snapshot of all three rather than a delta — keeps client merge logic
// trivial. Gated on `state` capability.
export const SessionConfigChangedSchema = z.object({
  type:                z.literal('session.config-changed'),
  sessionId:           z.string(),
  pin:                 z.string().nullable(),
  quietUntil:          z.number().int().nullable(),
  sessionGateOverride: z.enum(['disabled','auto','always']).nullable(),
});

// Server tells subscribers that the Claude child process bound to this
// sesshin session crossed a session boundary — i.e. raw.session_id changed
// (SessionStart for /clear, --resume, fresh startup) or the child's
// session was cleared on SessionEnd. Lets clients drop child-scoped
// state (pending approvals tied to old toolUseIds, transcript-position
// hints, etc.) when the underlying Claude session identity changes.
//
// `claudeSessionId` is nullable to cover the SessionEnd case where the
// current child returns to null. `previousClaudeSessionId` is similarly
// nullable for the first SessionStart of a fresh sesshin session.
//
// `reason` is best-effort, derived from Claude's SessionStart `source`
// field (`'startup' | 'clear' | 'resume' | 'compact'` per the hook
// contract). `'compact'` is intentionally NOT a valid value here:
// compact reuses the same session_id, so no boundary event fires.
// `'session-end'` is the value used on the SessionEnd-driven clear.
// `'unknown'` is the fallback when source is missing or unrecognized.
//
// Gated on `state` capability (mirrors session.config-changed).
export const SessionChildChangedSchema = z.object({
  type:                    z.literal('session.child-changed'),
  sessionId:               z.string(),
  previousClaudeSessionId: z.string().nullable(),
  claudeSessionId:         z.string().nullable(),
  reason:                  z.enum(['startup','clear','resume','session-end','unknown']),
});

export const DownstreamMessageSchema = z.discriminatedUnion('type', [
  ServerHelloSchema, SessionListSchema, SessionAddedSchema, SessionRemovedSchema,
  SessionStateMsgSchema, SessionEventMsgSchema, SessionSummaryMsgSchema,
  SessionAttentionSchema, TerminalSnapshotSchema, TerminalDeltaSchema,
  TerminalResizeSchema, TerminalEndedSchema, ServerErrorSchema, ServerPingSchema,
  SessionPromptRequestSchema, SessionPromptRequestResolvedSchema,
  SessionConfigChangedSchema, SessionChildChangedSchema,
]);
export type DownstreamMessage = z.infer<typeof DownstreamMessageSchema>;

export type SessionPromptRequest         = z.infer<typeof SessionPromptRequestSchema>;
export type SessionPromptRequestResolved = z.infer<typeof SessionPromptRequestResolvedSchema>;
export type SessionConfigChanged         = z.infer<typeof SessionConfigChangedSchema>;
export type SessionChildChanged          = z.infer<typeof SessionChildChangedSchema>;
export type PromptResponse               = z.infer<typeof PromptResponseSchema>;
export type PromptResponseAnswer         = z.infer<typeof PromptResponseSchema>['answers'][number];
export type PromptQuestion               = z.infer<typeof PromptQuestionSchema>;
export type PromptOption                 = z.infer<typeof PromptOptionSchema>;
