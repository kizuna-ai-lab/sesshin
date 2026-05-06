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
  it('button and textarea are enabled by default with default placeholder', () => {
    const div = document.createElement('div');
    render(<TextInput ws={stub} sessionId="s1" />, div);
    const btn = div.querySelector('[data-testid="send-text"]') as HTMLButtonElement;
    const ta  = div.querySelector('textarea') as HTMLTextAreaElement;
    expect(btn.disabled).toBe(false);
    expect(ta.disabled).toBe(false);
    expect(ta.placeholder).toBe('message claude…');
  });

  it('paused=true keeps the textarea live but swaps the placeholder to a shell hint', () => {
    const div = document.createElement('div');
    render(<TextInput ws={stub} sessionId="s1" paused={true} />, div);
    const btn = div.querySelector('[data-testid="send-text"]') as HTMLButtonElement;
    const ta  = div.querySelector('textarea') as HTMLTextAreaElement;
    // CRITICAL: pause must NOT disable the input — the inner shell is live
    // and the user should be able to drive it from web.
    expect(btn.disabled).toBe(false);
    expect(ta.disabled).toBe(false);
    expect(ta.placeholder).toBe('shell command (claude paused)…');
  });

  it('disabled=true greys out and uses the unavailable placeholder', () => {
    const div = document.createElement('div');
    render(<TextInput ws={stub} sessionId="s1" disabled={true} />, div);
    const btn = div.querySelector('[data-testid="send-text"]') as HTMLButtonElement;
    const ta  = div.querySelector('textarea') as HTMLTextAreaElement;
    expect(btn.disabled).toBe(true);
    expect(ta.disabled).toBe(true);
    expect(ta.placeholder).toBe('session unavailable');
  });

  it('clicking Send while paused calls sendText (input goes to inner shell)', async () => {
    const calls: string[] = [];
    const ws: WsClient = { ...stub, sendText: (_sid, t) => calls.push(t) };
    const div = document.createElement('div');
    render(<TextInput ws={ws} sessionId="s1" paused={true} />, div);
    const ta = div.querySelector('textarea') as HTMLTextAreaElement;
    ta.value = 'ls';
    (div.querySelector('[data-testid="send-text"]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual(['ls\r']);
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

  it('clicking Send while enabled sends with trailing CR', async () => {
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
