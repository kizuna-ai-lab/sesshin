import { z } from 'zod';

/**
 * Web-driven TTY shortcuts. Each maps to a small string injected into the
 * Claude PTY (see `agents/claude/action-map.ts`):
 *   - `approve` / `reject` → `y\r` / `n\r` (fallback when sesshin's
 *     PermissionRequest path is not engaged and Claude shows its native
 *     TUI permission prompt)
 *   - `continue` → `\r` (general Enter, e.g. dismiss "press any key")
 *   - `stop`     → `\x1b` (ESC — interrupt the running tool / agent)
 *
 * Structured permission / question flows go through `prompt-response`
 * (PromptResponse schema), not these. The earlier set included
 * `retry`/`fix`/`summarize`/`details`/`ignore`/`snooze`; removed because
 * the slash commands they injected don't exist in Claude Code (and the
 * `ignore`/`snooze` mappings were no-op empty strings).
 */
export const ActionEnum = z.enum(['approve', 'reject', 'continue', 'stop']);
export type Action = z.infer<typeof ActionEnum>;
