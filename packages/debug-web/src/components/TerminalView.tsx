import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';
import type { ITheme } from '@xterm/xterm';
import type { WsClient } from '../ws-client.js';
import {
  terminalThemes,
  type TerminalThemeKey,
  loadTerminalThemeKey,
  saveTerminalThemeKey,
  loadCustomTerminalThemeText,
  saveCustomTerminalThemeText,
  parseCustomTerminalTheme,
} from '../terminal-themes.js';

function decodeBase64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function themeFromSelection(selection: TerminalThemeKey | 'custom', customText: string): ITheme {
  if (selection === 'custom') return parseCustomTerminalTheme(customText) ?? terminalThemes.default.theme;
  return terminalThemes[selection].theme;
}

export function TerminalView({ ws, sessionId }: { ws: WsClient; sessionId: string }) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const readyRef = useRef(false);
  const queueRef = useRef<Uint8Array[]>([]);
  const seqRef = useRef(0);

  const [themeSelection, setThemeSelection] = useState<TerminalThemeKey | 'custom'>(() => loadTerminalThemeKey());
  const [customThemeText, setCustomThemeText] = useState<string>(() => loadCustomTerminalThemeText());
  const [customThemeError, setCustomThemeError] = useState<string | null>(null);

  const theme = useMemo(() => themeFromSelection(themeSelection, customThemeText), [themeSelection, customThemeText]);

  useEffect(() => {
    const term = new Terminal({
      theme,
      scrollback: 10_000,
      disableStdin: true,
      cursorBlink: false,
      fontFamily: 'Menlo, Monaco, Consolas, "Liberation Mono", monospace',
      fontSize: 12,
      convertEol: false,
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(containerRef.current!);
    fit.fit();
    terminalRef.current = term;
    fitRef.current = fit;

    const observer = new ResizeObserver(() => {
      try { fit.fit(); } catch { /* ignore */ }
    });
    observer.observe(containerRef.current!);

    const unsubscribe = ws.subscribeTerminal(sessionId, (message) => {
      if (message.type === 'terminal.snapshot') {
        readyRef.current = false;
        queueRef.current = [];
        seqRef.current = message.seq;
        term.reset();
        term.resize(message.cols, message.rows);
        if (message.data) term.write(message.data);
        readyRef.current = true;
        for (const chunk of queueRef.current) term.write(chunk);
        queueRef.current = [];
        return;
      }
      if (message.type === 'terminal.delta') {
        if (message.seq <= seqRef.current) return;
        const bytes = decodeBase64ToBytes(message.data);
        seqRef.current = message.seq;
        if (!readyRef.current) {
          queueRef.current.push(bytes);
          return;
        }
        term.write(bytes);
        return;
      }
      if (message.type === 'terminal.resize') {
        term.resize(message.cols, message.rows);
        return;
      }
      if (message.type === 'terminal.ended') {
        term.write(`\r\n\x1b[90m[terminal ended${message.reason ? `: ${message.reason}` : ''}]\x1b[0m\r\n`);
      }
    });

    return () => {
      unsubscribe();
      observer.disconnect();
      fitRef.current = null;
      terminalRef.current = null;
      term.dispose();
    };
  }, [sessionId, ws]);

  useEffect(() => {
    saveTerminalThemeKey(themeSelection);
    const term = terminalRef.current;
    if (term) term.options.theme = theme;
  }, [theme, themeSelection]);

  useEffect(() => {
    saveCustomTerminalThemeText(customThemeText);
    setCustomThemeError(themeSelection === 'custom' && !parseCustomTerminalTheme(customThemeText)
      ? 'Custom theme JSON must parse to an object.'
      : null);
  }, [customThemeText, themeSelection]);

  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        <label style={{ fontSize: 12, opacity: 0.8 }}>
          theme{' '}
          <select
            value={themeSelection}
            onChange={(e) => setThemeSelection((e.currentTarget.value as TerminalThemeKey | 'custom'))}
            style={{ background: '#111', color: '#eee', border: '1px solid #333', borderRadius: 4, padding: '4px 6px' }}
          >
            {Object.entries(terminalThemes).map(([key, value]) => (
              <option key={key} value={key}>{value.name}</option>
            ))}
            <option value="custom">Custom JSON</option>
          </select>
        </label>
      </div>
      {themeSelection === 'custom' && (
        <div style={{ display: 'grid', gap: 6 }}>
          <textarea
            value={customThemeText}
            onInput={(e) => setCustomThemeText(e.currentTarget.value)}
            rows={8}
            style={{ background: '#111', color: '#ddd', border: '1px solid #333', borderRadius: 4, padding: 8, fontFamily: 'monospace', fontSize: 12 }}
          />
          {customThemeError && <div style={{ color: '#f88', fontSize: 12 }}>{customThemeError}</div>}
        </div>
      )}
      <div
        ref={containerRef}
        style={{
          background: '#000',
          border: '1px solid #222',
          borderRadius: 6,
          minHeight: 260,
          height: 420,
          overflow: 'hidden',
        }}
      />
    </div>
  );
}
