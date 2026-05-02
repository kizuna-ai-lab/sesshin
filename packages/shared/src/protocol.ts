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
  reason:     z.enum(['decided','timeout','cancelled-no-clients','session-ended']),
});

export const DownstreamMessageSchema = z.discriminatedUnion('type', [
  ServerHelloSchema, SessionListSchema, SessionAddedSchema, SessionRemovedSchema,
  SessionStateMsgSchema, SessionEventMsgSchema, SessionSummaryMsgSchema,
  SessionAttentionSchema, SessionRawSchema, ServerErrorSchema, ServerPingSchema,
  SessionPromptRequestSchema, SessionPromptRequestResolvedSchema,
]);
export type DownstreamMessage = z.infer<typeof DownstreamMessageSchema>;

export type SessionPromptRequest         = z.infer<typeof SessionPromptRequestSchema>;
export type SessionPromptRequestResolved = z.infer<typeof SessionPromptRequestResolvedSchema>;
export type PromptResponse               = z.infer<typeof PromptResponseSchema>;
export type PromptQuestion               = z.infer<typeof PromptQuestionSchema>;
export type PromptOption                 = z.infer<typeof PromptOptionSchema>;
