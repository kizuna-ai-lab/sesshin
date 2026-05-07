import { useState } from 'preact/hooks';

interface AnchorMatch {
  anchor:  string;
  mode:    string;
  index:   number;     // -1 = absent
}

interface BannerDiagnostic {
  sessionId:      string;
  cols:           number;
  rows:           number;
  bufferLength:   number;
  cursorRow:      number;
  cursorCol:      number;
  viewportStart:  number;
  viewportRows:   Array<{ index: number; text: string }>;
  detectedMode:   string | null;
  everSawAnchor:  boolean;
  anchorMatches:  AnchorMatch[];
}

interface Props { sessionId: string; }

/**
 * Diagnostic panel for the PTY banner tracker. Fetches the headless
 * terminal's current viewport content (via REST) and shows it row-by-row,
 * with per-anchor lastIndexOf positions and the detector's verdict. Useful
 * for figuring out WHY detection picks (or doesn't pick) a given mode when
 * the real cc TUI shows something different.
 */
export function BannerDebugPanel({ sessionId }: Props) {
  const [diag,    setDiag]    = useState<BannerDiagnostic | null>(null);
  const [error,   setError]   = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [open,    setOpen]    = useState(false);

  async function fetchDiag(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/banner-debug`);
      if (!res.ok) {
        let detail = `HTTP ${res.status}`;
        try {
          const body = await res.json() as { error?: string };
          if (body?.error) detail = `HTTP ${res.status}: ${body.error}`;
        } catch { /* body not JSON */ }
        setError(detail);
        setDiag(null);
        return;
      }
      const json = await res.json() as BannerDiagnostic;
      setDiag(json);
      setOpen(true);
    } catch (e) {
      setError(String(e instanceof Error ? e.message : e));
      setDiag(null);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={{ marginTop: 12 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <button
          type="button"
          data-testid="banner-debug-button"
          onClick={fetchDiag}
          disabled={loading}
          style={{
            background: '#222', color: '#ddd', border: '1px solid #444',
            borderRadius: 4, padding: '4px 10px', cursor: 'pointer', fontSize: 12,
          }}
        >
          {loading ? 'Loading…' : 'Banner Debug Dump'}
        </button>
        {diag && (
          <button
            type="button"
            onClick={() => setOpen(!open)}
            style={{
              background: 'transparent', color: '#888', border: 'none',
              cursor: 'pointer', fontSize: 12,
            }}
          >
            {open ? 'collapse' : 'expand'}
          </button>
        )}
        {error && <span style={{ color: '#f88', fontSize: 12 }}>error: {error}</span>}
      </div>

      {diag && open && <DiagView diag={diag} />}
    </div>
  );
}

function DiagView({ diag }: { diag: BannerDiagnostic }) {
  return (
    <div
      data-testid="banner-debug-output"
      style={{
        marginTop: 8, padding: 12, background: '#0f0f0f', border: '1px solid #333',
        borderRadius: 4, fontFamily: 'monospace', fontSize: 11, color: '#ddd',
        overflow: 'auto', maxHeight: 500,
      }}
    >
      <div style={{ marginBottom: 8, color: '#aaa' }}>
        <strong>Detected mode:</strong> {diag.detectedMode ?? '(none — would default-or-skip)'}
        {' · '}
        <strong>everSawAnchor:</strong> {String(diag.everSawAnchor)}
      </div>
      <div style={{ marginBottom: 8, color: '#888' }}>
        cols={diag.cols} rows={diag.rows} bufLen={diag.bufferLength}
        {' · '}
        cursor=({diag.cursorRow},{diag.cursorCol})
        {' · '}
        viewportStart={diag.viewportStart}
      </div>
      <div style={{ marginBottom: 12 }}>
        <strong style={{ color: '#aaa' }}>Anchor matches (lastIndexOf in joined viewport text):</strong>
        <ul style={{ margin: '4px 0 0 16px', padding: 0 }}>
          {diag.anchorMatches.map((m) => (
            <li
              key={m.anchor}
              style={{ color: m.index >= 0 ? '#9f9' : '#666' }}
            >
              <code>{m.anchor}</code> → {m.mode} (idx={m.index})
            </li>
          ))}
        </ul>
      </div>
      <div>
        <strong style={{ color: '#aaa' }}>Viewport rows ({diag.viewportRows.length}):</strong>
        <pre style={{
          margin: '4px 0 0 0', padding: '6px 8px',
          background: '#000', border: '1px solid #222', borderRadius: 3,
          whiteSpace: 'pre', fontSize: 11,
        }}>
{diag.viewportRows.map((r) => `[${r.index.toString().padStart(4, ' ')}] ${r.text}`).join('\n')}
        </pre>
      </div>
    </div>
  );
}
