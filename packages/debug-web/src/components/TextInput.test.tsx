import { describe, it, expect } from 'vitest';
import { render } from 'preact';
import { TextInput } from './TextInput.js';
import type { WsClient } from '../ws-client.js';

const stub: WsClient = {
  sendAction: () => {}, sendText: () => {},
  sendPromptResponse: () => {},
  subscribeTerminal: () => () => {},
  close: () => {},
};

describe('TextInput', () => {
  it('button and textarea are enabled by default', () => {
    const div = document.createElement('div');
    render(<TextInput ws={stub} sessionId="s1" />, div);
    const btn = div.querySelector('[data-testid="send-text"]') as HTMLButtonElement;
    const ta  = div.querySelector('textarea') as HTMLTextAreaElement;
    expect(btn.disabled).toBe(false);
    expect(ta.disabled).toBe(false);
  });
  it('button and textarea are disabled when paused', () => {
    const div = document.createElement('div');
    render(<TextInput ws={stub} sessionId="s1" disabled={true} />, div);
    const btn = div.querySelector('[data-testid="send-text"]') as HTMLButtonElement;
    const ta  = div.querySelector('textarea') as HTMLTextAreaElement;
    expect(btn.disabled).toBe(true);
    expect(ta.disabled).toBe(true);
    expect(ta.placeholder).toBe('session paused');
  });
  it('clicking Send while disabled does not call sendText', async () => {
    const calls: string[] = [];
    const ws: WsClient = { ...stub, sendText: (_sid, t) => calls.push(t) };
    const div = document.createElement('div');
    render(<TextInput ws={ws} sessionId="s1" disabled={true} />, div);
    const ta = div.querySelector('textarea') as HTMLTextAreaElement;
    ta.value = 'hello';
    (div.querySelector('[data-testid="send-text"]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([]);
  });
  it('clicking Send while enabled calls sendText with trailing CR', async () => {
    const calls: string[] = [];
    const ws: WsClient = { ...stub, sendText: (_sid, t) => calls.push(t) };
    const div = document.createElement('div');
    render(<TextInput ws={ws} sessionId="s1" />, div);
    const ta = div.querySelector('textarea') as HTMLTextAreaElement;
    ta.value = 'hello';
    (div.querySelector('[data-testid="send-text"]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual(['hello\r']);
  });
});
