import { describe, it, expect } from 'vitest';
import { render } from 'preact';
import { PauseControls } from './PauseControls.js';
import type { WsClient } from '../ws-client.js';

const stub: WsClient = {
  sendAction: () => {}, sendText: () => {},
  sendPromptResponse: () => {},
  subscribeTerminal: () => () => {},
  close: () => {},
};

describe('PauseControls', () => {
  it('shows Pause button and no banner when not paused', () => {
    const div = document.createElement('div');
    render(<PauseControls ws={stub} sessionId="s1" paused={false} />, div);
    expect(div.querySelector('[data-testid="pause-banner"]')).toBeNull();
    expect(div.querySelector('[data-testid="pause-btn"]')).toBeTruthy();
    expect(div.querySelector('[data-testid="resume-btn"]')).toBeNull();
  });

  it('shows banner and Resume button when paused', () => {
    const div = document.createElement('div');
    render(<PauseControls ws={stub} sessionId="s1" paused={true} />, div);
    expect(div.querySelector('[data-testid="pause-banner"]')).toBeTruthy();
    expect(div.querySelector('[data-testid="resume-btn"]')).toBeTruthy();
    expect(div.querySelector('[data-testid="pause-btn"]')).toBeNull();
  });

  it('clicking Pause sendText injects \\x1a (Ctrl+Z byte)', async () => {
    const calls: { sid: string; text: string }[] = [];
    const ws: WsClient = { ...stub, sendText: (sid, text) => calls.push({ sid, text }) };
    const div = document.createElement('div');
    render(<PauseControls ws={ws} sessionId="abc" paused={false} />, div);
    (div.querySelector('[data-testid="pause-btn"]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([{ sid: 'abc', text: '\x1a' }]);
  });

  it('clicking Resume sendText injects "fg\\r"', async () => {
    const calls: { sid: string; text: string }[] = [];
    const ws: WsClient = { ...stub, sendText: (sid, text) => calls.push({ sid, text }) };
    const div = document.createElement('div');
    render(<PauseControls ws={ws} sessionId="abc" paused={true} />, div);
    (div.querySelector('[data-testid="resume-btn"]') as HTMLButtonElement).click();
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toEqual([{ sid: 'abc', text: 'fg\r' }]);
  });
});
