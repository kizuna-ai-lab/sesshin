import { selectedSession, summariesBySession, eventsBySession } from '../store.js';
import { StateBadge } from './StateBadge.js';
import { SummaryCard } from './SummaryCard.js';
import { EventTimeline } from './EventTimeline.js';
import { ActionButtons } from './ActionButtons.js';
import { TextInput } from './TextInput.js';
import type { WsClient } from '../ws-client.js';

export function SessionDetail({ ws }: { ws: WsClient }) {
  const s = selectedSession.value;
  if (!s) return <div style={{ padding: 24, opacity: 0.5 }}>select a session</div>;
  const summaries = summariesBySession.value[s.id] ?? [];
  const events = eventsBySession.value[s.id] ?? [];
  return (
    <div style={{ padding: 16, color: '#eee' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <h2 style={{ margin: 0 }}>{s.name}</h2>
        <StateBadge state={s.state} />
      </div>
      <SummaryCard summary={summaries[0] ?? null} />
      <ActionButtons ws={ws} sessionId={s.id} />
      <TextInput ws={ws} sessionId={s.id} />
      <h3>Event timeline</h3>
      <EventTimeline events={events} />
    </div>
  );
}
