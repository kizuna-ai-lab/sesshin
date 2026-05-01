import { normalize } from './normalize.js';

const TIMEOUT_MS = 250;

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks).toString('utf-8');
}

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

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    await fetch(`${hubUrl}/hooks`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch {
    // Hub unreachable / timeout / network error — drop silently.
  } finally {
    clearTimeout(timer);
  }
}

// ALWAYS exit 0. A non-zero exit could abort the user's claude turn.
main()
  .then(() => process.exit(0))
  .catch(() => process.exit(0));
