import { z } from 'zod';
import { NormalizedHookEventEnum } from './hook-events.js';

export const EventKindEnum = z.enum([
  'user-prompt', 'tool-call', 'tool-result',
  'agent-output', 'error', 'stall', 'agent-internal',
]);
export type EventKind = z.infer<typeof EventKindEnum>;

export const EventSourceSchema = z.union([
  z.literal('laptop'),
  z.string().regex(/^remote-adapter:[a-z0-9-]+$/i),
  z.string().regex(/^observer:(hook-ingest|session-file-tail|pty-tap)$/),
]);

export const EventSchema = z.object({
  type:      z.literal('session.event'),
  sessionId: z.string(),
  eventId:   z.string(),
  kind:      EventKindEnum,
  nativeEvent: NormalizedHookEventEnum.optional(),
  payload:   z.record(z.string(), z.unknown()),
  source:    EventSourceSchema,
  ts:        z.number().int(),
});
export type Event = z.infer<typeof EventSchema>;
