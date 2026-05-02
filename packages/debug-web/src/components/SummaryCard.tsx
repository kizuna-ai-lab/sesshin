import type { Summary } from '@sesshin/shared';
export function SummaryCard({ summary }: { summary: Summary | null }) {
  if (!summary) return <div data-testid="no-summary" style={{ padding: 12, opacity: 0.5 }}>no summary yet</div>;
  return (
    <div data-testid="summary-card" style={{ padding: 12, border: '1px solid #333', borderRadius: 6, marginBottom: 12 }}>
      <div style={{ fontSize: 16, marginBottom: 6 }}>{summary.oneLine}</div>
      {summary.bullets.length > 0 && (
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          {summary.bullets.map((b, i) => <li key={i}>{b}</li>)}
        </ul>
      )}
      {summary.suggestedNext && <div style={{ marginTop: 8, fontStyle: 'italic' }}>→ {summary.suggestedNext}</div>}
      {summary.needsDecision && <div data-testid="needs-decision" style={{ marginTop: 8, color: '#fc5' }}>(awaiting decision)</div>}
    </div>
  );
}
