import { z } from 'zod';

/**
 * Web-driven TTY shortcut. Maps to a raw string injected into Claude's PTY
 * (see `agents/claude/action-map.ts`).
 *
 *   - `stop` → `\x1b` (ESC — interrupt the running tool / agent)
 *
 * `stop` is the only remaining action because ESC isn't typeable through
 * `input.text` (TextInput trims and sends `<text>\r`). `approve`/`reject`/
 * `continue` were removed: y/n/Enter are equivalent to typing the literal
 * character into TextInput, and structured permission / question answers
 * go through `prompt-response` (PromptResponse schema). Earlier dead
 * names (`retry`/`fix`/`summarize`/`details`/`ignore`/`snooze`) were
 * removed in the prior cleanup.
 */
export const ActionEnum = z.enum(['stop']);
export type Action = z.infer<typeof ActionEnum>;
