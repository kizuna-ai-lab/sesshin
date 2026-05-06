import type { ITheme } from '@xterm/xterm';

export const terminalThemes = {
  default: {
    name: 'Default',
    theme: { background: '#000000', foreground: '#cccccc' } satisfies ITheme,
  },
  solarizedDark: {
    name: 'Solarized Dark',
    theme: {
      background: '#002b36', foreground: '#93a1a1', black: '#073642', red: '#dc322f', green: '#859900',
      yellow: '#b58900', blue: '#268bd2', magenta: '#d33682', cyan: '#2aa198', white: '#eee8d5',
      brightBlack: '#586e75', brightRed: '#cb4b16', brightGreen: '#586e75', brightYellow: '#657b83',
      brightBlue: '#839496', brightMagenta: '#6c71c4', brightCyan: '#93a1a1', brightWhite: '#fdf6e3',
    } satisfies ITheme,
  },
  dracula: {
    name: 'Dracula',
    theme: {
      background: '#282a36', foreground: '#f8f8f2', black: '#21222c', red: '#ff5555', green: '#50fa7b',
      yellow: '#f1fa8c', blue: '#bd93f9', magenta: '#ff79c6', cyan: '#8be9fd', white: '#f8f8f2',
      brightBlack: '#6272a4', brightRed: '#ff6e6e', brightGreen: '#69ff94', brightYellow: '#ffffa5',
      brightBlue: '#d6acff', brightMagenta: '#ff92df', brightCyan: '#a4ffff', brightWhite: '#ffffff',
    } satisfies ITheme,
  },
  gruvboxDark: {
    name: 'Gruvbox Dark',
    theme: {
      background: '#282828', foreground: '#ebdbb2', black: '#282828', red: '#cc241d', green: '#98971a',
      yellow: '#d79921', blue: '#458588', magenta: '#b16286', cyan: '#689d6a', white: '#a89984',
      brightBlack: '#928374', brightRed: '#fb4934', brightGreen: '#b8bb26', brightYellow: '#fabd2f',
      brightBlue: '#83a598', brightMagenta: '#d3869b', brightCyan: '#8ec07c', brightWhite: '#fbf1c7',
    } satisfies ITheme,
  },
  light: {
    name: 'Light',
    theme: { background: '#ffffff', foreground: '#111111' } satisfies ITheme,
  },
} as const;

export type TerminalThemeKey = keyof typeof terminalThemes;

export const terminalThemeStorageKey = 'sesshin.terminalTheme';
export const terminalCustomThemeStorageKey = 'sesshin.terminalTheme.custom';

export function isTerminalThemeKey(value: string): value is TerminalThemeKey {
  return value in terminalThemes;
}

export function loadTerminalThemeKey(): TerminalThemeKey | 'custom' {
  if (typeof localStorage === 'undefined') return 'default';
  const raw = localStorage.getItem(terminalThemeStorageKey);
  if (raw === 'custom') return 'custom';
  return raw && isTerminalThemeKey(raw) ? raw : 'default';
}

export function saveTerminalThemeKey(value: TerminalThemeKey | 'custom'): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(terminalThemeStorageKey, value);
}

export function loadCustomTerminalThemeText(): string {
  if (typeof localStorage === 'undefined') return '{\n  "background": "#000000",\n  "foreground": "#cccccc"\n}';
  return localStorage.getItem(terminalCustomThemeStorageKey)
    ?? '{\n  "background": "#000000",\n  "foreground": "#cccccc"\n}';
}

export function saveCustomTerminalThemeText(value: string): void {
  if (typeof localStorage === 'undefined') return;
  localStorage.setItem(terminalCustomThemeStorageKey, value);
}

export function parseCustomTerminalTheme(text: string): ITheme | null {
  try {
    const value = JSON.parse(text) as ITheme;
    return typeof value === 'object' && value !== null ? value : null;
  } catch {
    return null;
  }
}
