import { z } from 'zod';

export const ActionEnum = z.enum([
  'continue', 'stop', 'retry', 'fix', 'summarize',
  'details', 'ignore', 'snooze', 'approve', 'reject'
]);
export type Action = z.infer<typeof ActionEnum>;
