import { sessions, selectedSessionId } from '../store.js';

export function SessionList() {
  return (
    <ul data-testid="session-list" style={{ listStyle: 'none', padding: 0 }}>
      {sessions.value.map((s) => (
        <li key={s.id}
            data-testid="session-row"
            onClick={() => (selectedSessionId.value = s.id)}
            style={{
              padding: '8px',
              cursor: 'pointer',
              background: selectedSessionId.value === s.id ? '#222' : '#111',
              color: '#fff', borderBottom: '1px solid #333',
            }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span><b>{s.name}</b></span>
            <span data-testid="state-badge">{s.state}</span>
          </div>
          <div style={{ fontSize: '12px', opacity: 0.7 }}>{s.cwd}</div>
          <div style={{ fontSize: '12px', opacity: 0.8 }}>claude session: {s.claudeSessionId ?? '(none)'}</div>
          {s.substate.currentTool && <div style={{ fontSize: '12px' }}>tool: {s.substate.currentTool}</div>}
        </li>
      ))}
    </ul>
  );
}
