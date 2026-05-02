import { normalize } from './normalize.js';

// Most hooks are fire-and-forget; we POST and exit. PreToolUse, however, is
// the remote-approval gate (Path B): the hub holds the HTTP response open
// until a client decides (or its internal timeout fires), and the JSON body
// is the permission decision claude expects on stdout. We give the hub
// generous headroom — its own timeout (default 60s) will fire long before
// this one — and fall back to a non-blocking "ask" output if anything below
// goes wrong, so claude's TUI prompt always remains a safe escape hatch.
const FAST_TIMEOUT_MS    = 250;
const APPROVAL_TIMEOUT_MS = 120_000;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf-8');
}

interface HookOutput { hookSpecificOutput?: { hookEventName: string; permissionDecision: 'allow' | 'deny' | 'ask'; permissionDecisionReason?: string } }

async function main(): Promise<void> {
  const agent = process.env['SESSHIN_AGENT'] ?? 'claude-code';
  const sessionId = process.env['SESSHIN_SESSION_ID'] ?? '';
  const hubUrl = process.env['SESSHIN_HUB_URL'] ?? 'http://127.0.0.1:9663';
  const nativeEvent = process.argv[2] ?? 'unknown';

  const raw = await readStdin();
  let parsed: unknown = null;
  try { parsed = raw.length > 0 ? JSON.parse(raw) : null; } catch { /* keep null */ }

  const body = {
    agent,
    sessionId,
    ts: Date.now(),
    event: normalize(agent, nativeEvent),
    raw: { nativeEvent, ...(parsed && typeof parsed === 'object' ? parsed : {}) },
  };

  const isApproval = nativeEvent === 'PreToolUse';
  const timeoutMs  = isApproval ? APPROVAL_TIMEOUT_MS : FAST_TIMEOUT_MS;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${hubUrl}/hooks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
    if (isApproval && r.status === 200) {
      // The hub returns the literal hookSpecificOutput JSON to forward to
      // claude. We re-serialise (rather than streaming) so a malformed body
      // can't crash claude's parser — fall back to "ask" if anything fails.
      let json: HookOutput | null = null;
      try { json = (await r.json()) as HookOutput; } catch { json = null; }
      const decision = json?.hookSpecificOutput?.permissionDecision;
      if (decision === 'allow' || decision === 'deny' || decision === 'ask') {
        process.stdout.write(JSON.stringify(json));
      } else {
        emitAsk('sesshin: hub returned no decision');
      }
    }
    // Non-approval responses (and approval 204/4xx/5xx paths) are silent.
  } catch {
    if (isApproval) emitAsk('sesshin: hub unreachable');
    // Non-approval: stay silent, claude continues normally.
  } finally {
    clearTimeout(timer);
  }
}

function emitAsk(reason: string): void {
  const fallback: HookOutput = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: reason,
    },
  };
  process.stdout.write(JSON.stringify(fallback));
}

// ALWAYS exit 0. A non-zero exit could abort the user's claude turn.
main()
  .then(() => process.exit(0))
  .catch(() => process.exit(0));
