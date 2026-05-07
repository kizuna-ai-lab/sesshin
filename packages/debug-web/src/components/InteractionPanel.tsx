import { useEffect, useState } from 'preact/hooks';
import { promptRequestsBySession, type PendingPromptRequest } from '../store.js';
import type { WsClient } from '../ws-client.js';

function fmtRemaining(expiresAt: number): string {
  const ms = expiresAt - Date.now();
  if (ms <= 0) return 'expiring…';
  return `${Math.ceil(ms / 1000)}s`;
}

function Card({ ws, c, disabled }: { ws: WsClient; c: PendingPromptRequest; disabled: boolean }) {
  const [selected, setSelected] = useState<Record<number, Set<string>>>({});
  const [freeText, setFreeText] = useState<Record<number, string>>({});
  // 1Hz tick to keep `fallback in Ns` live. Bumping this state triggers a
  // re-render that recomputes fmtRemaining(); without it the displayed seconds
  // are frozen at the value sampled when the card first mounted.
  const [, setNow] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const submit = () => {
    const answers = c.questions.map((q, idx) => ({
      questionIndex: idx,
      selectedKeys: Array.from(selected[idx] ?? []),
      ...(freeText[idx] ? { freeText: freeText[idx] } : {}),
    }));
    ws.sendPromptResponse(c.sessionId, c.requestId, answers);
  };

  function canSubmit(): boolean {
    if (disabled) return false;
    for (let i = 0; i < c.questions.length; i += 1) {
      const q = c.questions[i]!;
      const hasSelection = (selected[i]?.size ?? 0) > 0;
      const hasFreeText = (freeText[i]?.length ?? 0) > 0;
      if (!q.allowFreeText && !hasSelection) return false;
      if (q.allowFreeText && !hasSelection && !hasFreeText) return false;
    }
    return true;
  }

  // Single-select shortcut: clicking an option picks it AND submits immediately
  const clickOption = (qIdx: number, key: string, multiSelect: boolean) => {
    if (disabled) return;
    if (multiSelect) {
      const cur = new Set(selected[qIdx] ?? []);
      if (cur.has(key)) cur.delete(key); else cur.add(key);
      setSelected({ ...selected, [qIdx]: cur });
    } else {
      // Auto-submit for single-select questions when there's only one question
      const next = { ...selected, [qIdx]: new Set([key]) };
      setSelected(next);
      if (c.questions.length === 1) {
        ws.sendPromptResponse(c.sessionId, c.requestId, [{
          questionIndex: qIdx, selectedKeys: [key],
          ...(freeText[qIdx] ? { freeText: freeText[qIdx] } : {}),
        }]);
      }
    }
  };

  return (
    <div data-testid="prompt-card" style={{
      border: '1px solid #b58900', background: '#1c1a0e', color: '#eee',
      padding: 10, borderRadius: 4, marginBottom: 8, fontFamily: 'monospace', fontSize: 13,
    }}>
      <div style={{ marginBottom: 6 }}>
        <span style={{ color: '#f0c674', fontWeight: 600 }}>{c.origin}</span>{' '}
        <span style={{ opacity: 0.7 }}>tool:</span> <b>{c.toolName}</b>
        <span style={{ float: 'right', opacity: 0.6 }}>fallback in {fmtRemaining(c.expiresAt)}</span>
      </div>
      {c.body && <pre style={{
        margin: '0 0 8px 0', padding: 6, background: '#000', color: '#ddd',
        borderRadius: 3, fontSize: 12, whiteSpace: 'pre-wrap', wordBreak: 'break-all',
        maxHeight: 240, overflowY: 'auto',
      }}>{c.body}</pre>}
      {c.questions.map((q, qIdx) => (
        <div key={qIdx} style={{ marginBottom: 6 }}>
          {c.questions.length > 1 && <div style={{ marginBottom: 4 }}><b>{q.prompt}</b></div>}
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            {q.options.map((o) => (
              <button key={o.key} data-testid={`opt-${o.key}`}
                      disabled={disabled}
                      onClick={() => clickOption(qIdx, o.key, q.multiSelect)}
                      title={o.description}
                      style={{
                        padding: '4px 12px',
                        background: (selected[qIdx]?.has(o.key)) ? '#2f5f2f' : '#222',
                        color: disabled ? '#666' : '#eee', border: '1px solid #444',
                        fontWeight: o.recommended ? 600 : 400,
                        cursor: disabled ? 'not-allowed' : 'pointer',
                      }}>
                {o.label}{o.recommended ? ' ★' : ''}
              </button>
            ))}
          </div>
          {q.allowFreeText && (
            <div style={{ marginTop: 4 }}>
              <input
                type="text" placeholder="Other / feedback…"
                value={freeText[qIdx] ?? ''}
                onInput={(e) => setFreeText({ ...freeText, [qIdx]: (e.currentTarget as HTMLInputElement).value })}
                style={{ width: '100%', padding: '3px 6px', background: '#000', color: '#ddd', border: '1px solid #444' }}
              />
            </div>
          )}
        </div>
      ))}
      {(c.questions.length > 1 || c.questions.some(q => q.multiSelect)) && (
        <button
          onClick={submit}
          disabled={!canSubmit()}
          style={{
            marginTop: 6, padding: '4px 12px',
            background: canSubmit() ? '#1f5f2e' : '#444',
            color: canSubmit() ? '#eee' : '#888',
            cursor: canSubmit() ? 'pointer' : 'not-allowed',
          }}
        >Submit</button>
      )}
    </div>
  );
}

export interface InteractionPanelProps {
  ws: WsClient;
  sessionId: string;
  disabled?: boolean;
}

export function InteractionPanel({ ws, sessionId, disabled = false }: InteractionPanelProps) {
  const list = promptRequestsBySession.value[sessionId] ?? [];
  if (list.length === 0) return null;
  return (
    <div data-testid="interaction-panel" style={{ marginBottom: 12 }}>
      {list.map(c => <Card key={c.requestId} ws={ws} c={c} disabled={disabled} />)}
    </div>
  );
}
