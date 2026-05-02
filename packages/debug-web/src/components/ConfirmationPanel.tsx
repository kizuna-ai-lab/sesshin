import { confirmationsBySession, type PendingConfirmation } from '../store.js';
import type { WsClient } from '../ws-client.js';

function fmtRemaining(expiresAt: number): string {
  const ms = expiresAt - Date.now();
  if (ms <= 0) return 'expiring…';
  const s = Math.ceil(ms / 1000);
  return `${s}s`;
}

function Row({ ws, c }: { ws: WsClient; c: PendingConfirmation }) {
  return (
    <div data-testid="confirmation-row" style={{
      border: '1px solid #b58900', background: '#1c1a0e', color: '#eee',
      padding: 10, borderRadius: 4, marginBottom: 8, fontFamily: 'monospace', fontSize: 13,
    }}>
      <div style={{ marginBottom: 6 }}>
        <span style={{ color: '#f0c674', fontWeight: 600 }}>permission requested</span>{' '}
        <span style={{ opacity: 0.7 }}>tool:</span> <b>{c.tool}</b>
        <span style={{ float: 'right', opacity: 0.6 }}>fallback in {fmtRemaining(c.expiresAt)}</span>
      </div>
      <pre style={{
        margin: '0 0 8px 0', padding: 6, background: '#000', color: '#ddd',
        borderRadius: 3, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all', maxHeight: 200, overflowY: 'auto',
      }}>{JSON.stringify(c.toolInput, null, 2)}</pre>
      <div style={{ display: 'flex', gap: 6 }}>
        <button data-testid="confirmation-allow" onClick={() => ws.sendConfirmation(c.sessionId, c.requestId, 'allow', 'remote-web approved')}
                style={{ padding: '4px 12px', background: '#1f5f2e', color: '#eee', border: '1px solid #2f7a3f' }}>Allow</button>
        <button data-testid="confirmation-deny" onClick={() => ws.sendConfirmation(c.sessionId, c.requestId, 'deny', 'remote-web denied')}
                style={{ padding: '4px 12px', background: '#5f1f1f', color: '#eee', border: '1px solid #7a2f2f' }}>Deny</button>
        <button data-testid="confirmation-ask"  onClick={() => ws.sendConfirmation(c.sessionId, c.requestId, 'ask', 'remote-web deferred to laptop')}
                title="Don't decide here. Claude will fall back to its own TUI permission menu on the laptop, where you (or whoever is at the keyboard) can answer."
                style={{ padding: '4px 12px', background: '#222', color: '#aaa', border: '1px solid #444' }}>Ask on laptop</button>
      </div>
    </div>
  );
}

export function ConfirmationPanel({ ws, sessionId }: { ws: WsClient; sessionId: string }) {
  const list = confirmationsBySession.value[sessionId] ?? [];
  if (list.length === 0) return null;
  return (
    <div data-testid="confirmation-panel" style={{ marginBottom: 12 }}>
      {list.map((c) => <Row key={c.requestId} ws={ws} c={c} />)}
    </div>
  );
}
