import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import { createWsServer, type WsServerInstance } from './server.js';
import { SessionRegistry } from '../registry/session-registry.js';
import { EventBus } from '../event-bus.js';
import { PtyTap } from '../observers/pty-tap.js';

let svr: WsServerInstance; let port: number; let registry: SessionRegistry; let bus: EventBus; let tap: PtyTap;
beforeEach(async () => {
  registry = new SessionRegistry();
  bus = new EventBus();
  tap = new PtyTap({ ringBytes: 1024 });
  svr = createWsServer({ registry, bus, tap, staticDir: null });
  await svr.listen(0, '127.0.0.1'); port = svr.address().port;
});
afterEach(async () => { await svr.close(); });

async function connect(caps: string[]): Promise<{ ws: WebSocket; recv: () => Promise<any[]> }> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/v1/ws`);
  await new Promise<void>((res, rej) => { ws.on('open', () => res()); ws.on('error', rej); });
  const messages: any[] = [];
  ws.on('message', (m) => messages.push(JSON.parse(m.toString())));
  ws.send(JSON.stringify({ type: 'client.identify', protocol: 1, client: { kind: 'debug-web', version: '0', capabilities: caps } }));
  await new Promise<void>((res) => setTimeout(res, 50));
  return { ws, recv: async () => { await new Promise<void>((res) => setTimeout(res, 50)); return messages.slice(); } };
}

describe('subscribe + broadcast', () => {
  it('returns session.list snapshot on subscribe', async () => {
    registry.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    const { ws, recv } = await connect(['state','events']);
    ws.send(JSON.stringify({ type: 'subscribe', sessions: 'all', since: null }));
    const messages = await recv();
    const list = messages.find((m) => m.type === 'session.list');
    expect(list).toBeTruthy();
    expect(list.sessions).toHaveLength(1);
    ws.close();
  });
  it('drops session.summary if client did not declare summary capability', async () => {
    registry.register({ id: 's1', name: 'n', agent: 'claude-code', cwd: '/', pid: 1, sessionFilePath: '/x' });
    const { ws, recv } = await connect(['state']);  // no `summary`
    ws.send(JSON.stringify({ type: 'subscribe', sessions: 'all', since: null }));
    svr.broadcast({ type: 'session.summary', sessionId: 's1', summaryId: 'sum-1', oneLine: 'x', bullets: [], needsDecision: false, suggestedNext: null, since: null, generatedAt: 1, generatorModel: 'claude-haiku' });
    const messages = await recv();
    expect(messages.find((m) => m.type === 'session.summary')).toBeUndefined();
    ws.close();
  });
});
