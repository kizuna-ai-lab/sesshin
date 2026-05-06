import XtermHeadless from '@xterm/headless';
import SerializeAddonPkg from '@xterm/addon-serialize';

const { Terminal } = XtermHeadless as unknown as { Terminal: typeof import('@xterm/headless')['Terminal'] };
const { SerializeAddon } = SerializeAddonPkg as unknown as { SerializeAddon: typeof import('@xterm/addon-serialize')['SerializeAddon'] };

export interface HeadlessSnapshot {
  cols: number;
  rows: number;
  data: string;
}

export class HeadlessTerm {
  private readonly term: Terminal;
  private readonly serializeAddon: SerializeAddon;

  constructor(cols: number, rows: number) {
    this.term = new Terminal({
      cols,
      rows,
      allowProposedApi: true,
      scrollback: 10_000,
      convertEol: false,
    });
    this.serializeAddon = new SerializeAddon();
    this.term.loadAddon(this.serializeAddon);
  }

  write(chunk: Buffer): void {
    this.term.write(chunk);
  }

  resize(cols: number, rows: number): void {
    if (cols <= 0 || rows <= 0) return;
    if (this.term.cols === cols && this.term.rows === rows) return;
    this.term.resize(cols, rows);
  }

  snapshot(): HeadlessSnapshot {
    return {
      cols: this.term.cols,
      rows: this.term.rows,
      data: this.serializeAddon.serialize(),
    };
  }

  dispose(): void {
    this.term.dispose();
  }
}
