import type { IncomingMessage, ServerResponse } from 'node:http';
import { PermissionRequestBody, type PermissionRequestDecision } from '@sesshin/shared';
import type { RestServerDeps } from './server.js';

const MAX_BODY_BYTES = 524_288;       // 512 KB

/**
 * Handle Claude Code's PermissionRequest HTTP hook. The body is Claude's
 * native PermissionRequest payload (NOT the sesshin envelope used by /hooks).
 * The sessionId in the URL path is sesshin's id (baked into settings.json
 * by the CLI); Claude's native session_id rides along inside the body.
 *
 * Response shape (200): the PermissionRequest decision shape — distinct from
 * PreToolUse's `permissionDecision` shape. 204 means passthrough — Claude
 * falls through to its built-in TUI prompt.
 */
export async function handlePermissionRoute(
  req: IncomingMessage,
  res: ServerResponse,
  sessionId: string,
  deps: RestServerDeps,
): Promise<void> {
  // Read body with size cap.
  const chunks: Buffer[] = [];
  let total = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    if (tooLarge) continue;
    total += (chunk as Buffer).length;
    if (total > MAX_BODY_BYTES) { tooLarge = true; continue; }
    chunks.push(chunk as Buffer);
  }
  if (tooLarge) {
    sendDecision(res, { behavior: 'deny', message: 'Permission request too large' });
    return;
  }

  // Session must be registered.
  if (!deps.registry.get(sessionId)) {
    sendDecision(res, { behavior: 'deny', message: 'sesshin: session not registered' });
    return;
  }

  // Parse + validate.
  let raw: unknown;
  try { raw = JSON.parse(Buffer.concat(chunks).toString('utf-8')); }
  catch { res.writeHead(400).end('bad json'); return; }
  const parsed = PermissionRequestBody.safeParse(raw);
  if (!parsed.success) { res.writeHead(400).end(); return; }

  // Sticky opt-in flag — fires before dispatch so the next PreToolUse on
  // this session short-circuits even if dispatch throws.
  deps.registry.markUsesPermissionRequest(sessionId);

  // Build normalized envelope; emit onto the bus.
  const envelope = {
    agent: 'claude-code' as const,
    sessionId,
    ts: Date.now(),
    event: 'PermissionRequest' as const,
    raw: parsed.data as unknown as Record<string, unknown>,
  };
  deps.onHookEvent?.(envelope);

  // Dispatch — null means passthrough (204), otherwise emit the decision shape.
  if (!deps.onPermissionRequestApproval) {
    res.writeHead(204).end();
    return;
  }

  let decision: PermissionRequestDecision | null;
  try {
    decision = await deps.onPermissionRequestApproval(envelope);
  } catch {
    // Throw → fall through to Claude TUI rather than fail-closed.
    res.writeHead(204).end();
    return;
  }
  if (decision === null) { res.writeHead(204).end(); return; }
  sendDecision(res, decision);
}

function sendDecision(res: ServerResponse, decision: PermissionRequestDecision): void {
  // Discriminated-union narrowing: each branch can only access fields valid
  // for its `behavior`. The shared schema (PermissionRequestDecision)
  // forbids `message` on allow and `updatedInput` on deny at the type level,
  // so accidental cross-shape leakage is a compile error.
  const body = decision.behavior === 'allow'
    ? {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest' as const,
          decision: {
            behavior: 'allow' as const,
            ...(decision.updatedInput !== undefined ? { updatedInput: decision.updatedInput } : {}),
          },
        },
      }
    : {
        hookSpecificOutput: {
          hookEventName: 'PermissionRequest' as const,
          decision: {
            behavior: 'deny' as const,
            ...(decision.message !== undefined ? { message: decision.message } : {}),
          },
        },
      };
  res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body));
}
