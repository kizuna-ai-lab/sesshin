import XtermHeadless from '@xterm/headless';
import SerializeAddonPkg from '@xterm/addon-serialize';

type XtermTerminal = InstanceType<typeof import('@xterm/headless').Terminal>;
type XtermSerializeAddon = InstanceType<typeof import('@xterm/addon-serialize').SerializeAddon>;

const { Terminal } = XtermHeadless as unknown as {
  Terminal: typeof import('@xterm/headless').Terminal;
};
const { SerializeAddon } = SerializeAddonPkg as unknown as {
  SerializeAddon: typeof import('@xterm/addon-serialize').SerializeAddon;
};

export interface HeadlessSnapshot {
  cols: number;
  rows: number;
  data: string;
  // seq corresponds to the last PtyTap chunk applied to this terminal. Captured
  // alongside the serialize() result so callers don't poll currentSeq() and
  // race against bytes that landed between snapshot serialization and the seq
  // read.
  seq: number;
}

export class HeadlessTerm {
  private readonly term: XtermTerminal;
  private readonly serializeAddon: XtermSerializeAddon;
  private lastSeq = 0;

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

  write(chunk: Buffer, seq: number): void {
    this.term.write(chunk);
    this.lastSeq = seq;
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
      seq: this.lastSeq,
    };
  }

  dispose(): void {
    this.term.dispose();
  }
}
