import type { Action } from '@sesshin/shared';
import type { WsClient } from '../ws-client.js';
const ACTIONS: Action[] = ['approve','reject','continue','stop','retry','fix','summarize','details','ignore','snooze'];
export function ActionButtons({ ws, sessionId }: { ws: WsClient; sessionId: string }) {
  return (
    <div style={{ marginBottom: 12 }} data-testid="action-buttons">
      {ACTIONS.map((a) => (
        <button key={a} onClick={() => ws.sendAction(sessionId, a)}
                style={{ marginRight: 6, padding: '4px 10px', background: '#222', color: '#eee', border: '1px solid #444' }}>
          {a}
        </button>
      ))}
    </div>
  );
}
