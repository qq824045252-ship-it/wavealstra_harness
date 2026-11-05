import { Terminal } from "@xterm/headless";

export interface TerminalScreenResult {
  screen: string[];
  cursor: { x: number; y: number };
  cols: number;
  rows: number;
}

export class TerminalScreen {
  private readonly term: Terminal;
  private pending: Promise<void> = Promise.resolve();
  private readonly writes = new Set<() => void>();
  private disposed = false;

  constructor(cols: number, rows: number) {
    this.term = new Terminal({ cols, rows, scrollback: 0, allowProposedApi: true });
  }

  write(data: string): void {
    if (this.disposed) return;
    this.pending = new Promise<void>((resolve) => {
      const done = () => { this.writes.delete(done); resolve(); };
      this.writes.add(done);
      this.term.write(data, done);
    });
  }

  resize(cols: number, rows: number): void {
    this.term.resize(cols, rows);
  }

  async read(): Promise<TerminalScreenResult> {
    await this.pending;
    if (this.disposed) throw new Error("Terminal screen is closed");
    const buffer = this.term.buffer.active;
    const screen = Array.from({ length: this.term.rows }, (_, i) =>
      buffer.getLine(buffer.viewportY + i)?.translateToString(true) ?? "");
    return { screen, cursor: { x: buffer.cursorX, y: buffer.cursorY }, cols: this.term.cols, rows: this.term.rows };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.term.dispose();
    for (const done of this.writes) done();
  }
}
