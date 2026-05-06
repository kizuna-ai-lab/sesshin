import { useState } from 'preact/hooks';
import { selectedSession, summariesBySession, eventsBySession } from '../store.js';
import { StateBadge } from './StateBadge.js';
import { ModeBadge } from './ModeBadge.js';
import { SummaryCard } from './SummaryCard.js';
import { EventTimeline } from './EventTimeline.js';
import { ActionButtons } from './ActionButtons.js';
import { TextInput } from './TextInput.js';
import { InteractionPanel } from './InteractionPanel.js';
import { PauseControls } from './PauseControls.js';
import { CopyBtn } from './CopyBtn.js';
import { TerminalView } from './TerminalView.js';
import type { WsClient } from '../ws-client.js';

export function SessionDetail({ ws }: { ws: WsClient }) {
  const s = selectedSession.value;
  const [tab, setTab] = useState<'summary' | 'events' | 'terminal'>('summary');
  if (!s) return <div style={{ padding: 24, opacity: 0.5 }}>select a session</div>;
  const summaries = summariesBySession.value[s.id] ?? [];
  const events = eventsBySession.value[s.id] ?? [];
  const tabButton = (key: 'summary' | 'events' | 'terminal', label: string) => (
    <button
      onClick={() => setTab(key)}
      style={{
        background: tab === key ? '#2a2a2a' : '#111',
        color: '#eee',
        border: '1px solid #333',
        borderRadius: 6,
        padding: '6px 10px',
        cursor: 'pointer',
      }}
    >
      {label}
    </button>
  );

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
      <PauseControls ws={ws} sessionId={s.id} paused={s.substate.paused ?? false} />
      {/* InteractionPanel stays disabled during pause: claude can't answer
          its own pending prompts while suspended. The text input below stays
          live so the user can drive the inner shell. */}
      <InteractionPanel ws={ws} sessionId={s.id} disabled={s.substate.paused ?? false} />
      <ActionButtons ws={ws} sessionId={s.id} />
      <TextInput ws={ws} sessionId={s.id} paused={s.substate.paused ?? false} />

      <div style={{ display: 'flex', gap: 8, margin: '16px 0 12px 0' }}>
        {tabButton('summary', 'Summary')}
        {tabButton('events', 'Events')}
        {tabButton('terminal', 'Terminal')}
      </div>

      {tab === 'summary' && <SummaryCard summary={summaries[0] ?? null} />}
      {tab === 'events' && <EventTimeline events={events} />}
      {tab === 'terminal' && <TerminalView ws={ws} sessionId={s.id} />}
    </div>
  );
}
