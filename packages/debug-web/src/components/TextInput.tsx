import { useRef } from 'preact/hooks';
import type { WsClient } from '../ws-client.js';
export function TextInput({ ws, sessionId }: { ws: WsClient; sessionId: string }) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  return (
    <div style={{ marginBottom: 12 }}>
      <textarea ref={inputRef} placeholder="message claude…" rows={3}
        style={{ width: '100%', background: '#111', color: '#eee', border: '1px solid #444', padding: 6 }} />
      <button data-testid="send-text"
        onClick={() => { const v = inputRef.current?.value ?? ''; if (v.trim()) { ws.sendText(sessionId, v + '\r'); if (inputRef.current) inputRef.current.value = ''; } }}
        style={{ padding: '4px 12px', background: '#246', color: '#fff', border: 0 }}>Send</button>
    </div>
  );
}
