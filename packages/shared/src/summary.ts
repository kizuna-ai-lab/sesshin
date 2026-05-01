import { z } from 'zod';
export const SummarySchema = z.object({
  summaryId:      z.string(),
  oneLine:        z.string().max(100),
  bullets:        z.array(z.string().max(80)).max(5),
  needsDecision:  z.boolean(),
  suggestedNext:  z.string().nullable(),
  since:          z.string().nullable(),
  generatedAt:    z.number().int(),
  generatorModel: z.string(),
});
export type Summary = z.infer<typeof SummarySchema>;
