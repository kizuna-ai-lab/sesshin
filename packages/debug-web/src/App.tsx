import { connect } from './ws-client.js';
import { connected } from './store.js';
import { SessionList } from './components/SessionList.js';
import { SessionDetail } from './components/SessionDetail.js';
import type { WsClient } from './ws-client.js';

let _ws: WsClient | null = null;

export function App() {
  if (!_ws) _ws = connect();
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '300px 1fr', height: '100vh', background: '#0a0a0a', color: '#eee' }}>
      <aside style={{ borderRight: '1px solid #222', overflowY: 'auto' }}>
        <header style={{ padding: 12, borderBottom: '1px solid #222' }}>
          <b>sesshin</b>{' '}
          <span style={{ marginLeft: 8, color: connected.value ? '#5a5' : '#a55' }}>{connected.value ? '●' : '○'}</span>
        </header>
        <SessionList />
      </aside>
      <main style={{ overflowY: 'auto' }}>
        <SessionDetail ws={_ws} />
      </main>
    </div>
  );
}
