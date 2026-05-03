import { selectedSession, summariesBySession, eventsBySession, rawBySession } from '../store.js';
import { StateBadge } from './StateBadge.js';
import { ModeBadge } from './ModeBadge.js';
import { SummaryCard } from './SummaryCard.js';
import { EventTimeline } from './EventTimeline.js';
import { ActionButtons } from './ActionButtons.js';
import { TextInput } from './TextInput.js';
import { InteractionPanel } from './InteractionPanel.js';
import { CopyBtn } from './CopyBtn.js';
import type { WsClient } from '../ws-client.js';

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '');
}

export function SessionDetail({ ws }: { ws: WsClient }) {
  const s = selectedSession.value;
  if (!s) return <div style={{ padding: 24, opacity: 0.5 }}>select a session</div>;
  const summaries = summariesBySession.value[s.id] ?? [];
  const events = eventsBySession.value[s.id] ?? [];
  const raw = rawBySession.value[s.id] ?? '';
  return (
    <div style={{ padding: 16, color: '#eee' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 6 }}>
        <h2 style={{ margin: 0 }}>{s.name}</h2>
        <StateBadge state={s.state} />
        <ModeBadge mode={s.substate.permissionMode} />
      </div>
      <div data-testid="session-id-row"
           style={{ display: 'flex', alignItems: 'center', marginBottom: 4, fontSize: 12, opacity: 0.75 }}>
        <span style={{ opacity: 0.55, marginRight: 6 }}>id:</span>
        <code style={{ fontFamily: 'monospace' }}>{s.id}</code>
        <CopyBtn text={s.id} label="copy" />
      </div>
      {s.sessionFilePath && (
        <div data-testid="session-log-row"
             style={{ display: 'flex', alignItems: 'center', marginBottom: 12, fontSize: 12, opacity: 0.75 }}>
          <span style={{ opacity: 0.55, marginRight: 6 }}>log:</span>
          <code style={{ fontFamily: 'monospace', wordBreak: 'break-all' }}>{s.sessionFilePath}</code>
          <CopyBtn text={s.sessionFilePath} label="copy path" />
        </div>
      )}
      <SummaryCard summary={summaries[0] ?? null} />
      <InteractionPanel ws={ws} sessionId={s.id} />
      <ActionButtons ws={ws} sessionId={s.id} />
      <TextInput ws={ws} sessionId={s.id} />
      <h3>Event timeline</h3>
      <EventTimeline events={events} />
      <h3>Terminal output (last 16 KiB)</h3>
      <pre style={{
        background: '#000', color: '#ccc', padding: 8, borderRadius: 4,
        maxHeight: 200, overflowY: 'auto', fontFamily: 'monospace', fontSize: 12,
        whiteSpace: 'pre-wrap', wordBreak: 'break-all',
      }}>{stripAnsi(raw)}</pre>
    </div>
  );
}
