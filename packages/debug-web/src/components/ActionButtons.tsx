import type { Action } from '@sesshin/shared';
import type { WsClient } from '../ws-client.js';

// TTY-shortcut buttons. Structured permission / question answers go through
// the InteractionPanel's prompt-response path; these only inject raw keys
// into Claude's PTY for fallback / interrupt scenarios.
const ACTIONS: Action[] = ['approve', 'reject', 'continue', 'stop'];

export function ActionButtons({ ws, sessionId }: { ws: WsClient; sessionId: string }) {
  return (
    <div style={{ marginBottom: 12 }} data-testid="action-buttons">
      {ACTIONS.map((a) => (
        <button key={a} onClick={() => ws.sendAction(sessionId, a)}
                title={a === 'stop' ? 'Send ESC — interrupt running tool' : `Send ${a} key to TTY`}
                style={{ marginRight: 6, padding: '4px 10px', background: '#222', color: '#eee', border: '1px solid #444' }}>
          {a}
        </button>
      ))}
    </div>
  );
}
