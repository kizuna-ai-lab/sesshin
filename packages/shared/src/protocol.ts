import { z } from 'zod';
import { SessionInfoSchema, SessionStateEnum, SubstateSchema } from './session.js';
import { SummarySchema } from './summary.js';
import { EventSchema } from './events.js';
import { ActionEnum } from './actions.js';

export const PROTOCOL_VERSION = 1 as const;

export const ClientKindEnum = z.enum(['debug-web','telegram-adapter','m5stick','watch','mobile','other']);
export const CapabilityEnum = z.enum(['summary','events','raw','actions','voice','history','state','attention']);

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
// Sent by a client in response to a server.confirmation. Carries the user's
// permission decision for a PreToolUse approval that the hub is holding open
// (the originating hook handler is blocked waiting for this answer).
export const ConfirmationDecisionEnum = z.enum(['allow','deny','ask']);
export const ConfirmationDecisionSchema = z.object({
  type:      z.literal('confirmation.decision'),
  sessionId: z.string(),
  requestId: z.string(),
  decision:  ConfirmationDecisionEnum,
  reason:    z.string().optional(),
});

export const UpstreamMessageSchema = z.discriminatedUnion('type', [
  ClientIdentifySchema, SubscribeSchema, UnsubscribeSchema,
  InputTextSchema, InputActionSchema, ClientPongSchema,
  ConfirmationDecisionSchema,
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
export const SessionRawSchema = z.object({
  type:      z.literal('session.raw'),
  sessionId: z.string(),
  seq:       z.number().int(),
  data:      z.string(),
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
// Server-side announcement that the hub is holding a PreToolUse hook open
// pending a permission decision. The hook handler will block on the hub's
// response until either a client posts ConfirmationDecisionSchema for the
// matching requestId, or the hub's internal timeout elapses (in which case
// the hub falls back to "ask" so claude's TUI takes over).
export const SessionConfirmationSchema = z.object({
  type:       z.literal('session.confirmation'),
  sessionId:  z.string(),
  requestId:  z.string(),
  tool:       z.string(),
  toolInput:  z.unknown(),
  toolUseId:  z.string().optional(),
  expiresAt:  z.number().int(),
});
// Server tells clients a previously announced confirmation has been resolved
// (by another client, by timeout, or by the originating session ending).
// Clients use this to dismiss any pending confirmation UI for requestId.
export const SessionConfirmationResolvedSchema = z.object({
  type:       z.literal('session.confirmation.resolved'),
  sessionId:  z.string(),
  requestId:  z.string(),
  decision:   ConfirmationDecisionEnum,
  reason:     z.string().optional(),
});

export const DownstreamMessageSchema = z.discriminatedUnion('type', [
  ServerHelloSchema, SessionListSchema, SessionAddedSchema, SessionRemovedSchema,
  SessionStateMsgSchema, SessionEventMsgSchema, SessionSummaryMsgSchema,
  SessionAttentionSchema, SessionRawSchema, ServerErrorSchema, ServerPingSchema,
  SessionConfirmationSchema, SessionConfirmationResolvedSchema,
]);
export type DownstreamMessage = z.infer<typeof DownstreamMessageSchema>;
