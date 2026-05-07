import { describe, it, expect } from 'vitest';
import { render } from 'preact';
import { CycleModeButton } from './CycleModeButton.js';
import type { WsClient } from '../ws-client.js';

const stub: WsClient = {
  sendAction:         () => {},
  sendText:           () => {},
  sendPromptResponse: () => {},
  subscribeTerminal:  () => () => {},
  close:              () => {},
};

describe('CycleModeButton', () => {
  it('renders an enabled button by default', () => {
    const div = document.createElement('div');
    render(<CycleModeButton ws={stub} sessionId="s1" />, div);
    const btn = div.querySelector('[data-testid="cycle-mode-button"]') as HTMLButtonElement;
    expect(btn).toBeTruthy();
    expect(btn.disabled).toBe(false);
  });

  it('clicking sends Shift+Tab (\\x1b[Z) via sendText', async () => {
    const calls: { sid: string; text: string }[] = [];
    const ws: WsClient = { ...stub, sendText: (sid, text) => calls.push({ sid, text }) };
    const div = document.createElement('div');
    render(<CycleModeButton ws={ws} sessionId="abc" />, div);
    (div.querySelector('[data-testid="cycle-mode-button"]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([{ sid: 'abc', text: '\x1b[Z' }]);
  });

  it('disabled prop disables the button and prevents sending', async () => {
    const calls: { sid: string; text: string }[] = [];
    const ws: WsClient = { ...stub, sendText: (sid, text) => calls.push({ sid, text }) };
    const div = document.createElement('div');
    render(<CycleModeButton ws={ws} sessionId="abc" disabled />, div);
    const btn = div.querySelector('[data-testid="cycle-mode-button"]') as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
    btn.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([]);
  });

  it('multiple clicks send multiple Shift+Tab keystrokes (one per click)', async () => {
    const calls: { sid: string; text: string }[] = [];
    const ws: WsClient = { ...stub, sendText: (sid, text) => calls.push({ sid, text }) };
    const div = document.createElement('div');
    render(<CycleModeButton ws={ws} sessionId="s1" />, div);
    const btn = div.querySelector('[data-testid="cycle-mode-button"]') as HTMLButtonElement;
    btn.click(); btn.click(); btn.click();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls.length).toBe(3);
    expect(calls.every((c) => c.text === '\x1b[Z')).toBe(true);
  });
});
