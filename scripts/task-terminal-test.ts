import { withShellTerminalGuidance } from "../src/main/agent/durable/DurableShellTerminal";
import assert from "node:assert/strict";
import { TerminalHost, type PtyLike, type PtyExitEvent } from "../src/main/terminal/TerminalHost";
import { TaskTerminalService } from "../src/main/terminal/TaskTerminalService";

class FakePty implements PtyLike {
  data = (_text: string) => {};
  exit = (_event: PtyExitEvent) => {};
  writes: string[] = [];
  size = [80, 24];
  killed = false;
  failWrite = false;
  onData(callback: (data: string) => void) { this.data = callback; }
  onExit(callback: (event: PtyExitEvent) => void) { this.exit = callback; }
  write(data: string) { if (this.failWrite) throw new Error("closed"); this.writes.push(data); }
  resize(cols: number, rows: number) { this.size = [cols, rows]; }
  kill() { this.killed = true; this.exit({ exitCode: 0 }); }
}

async function main() {
  for (const name of ["bash", "powershell"]) {
    for (const text of ["[SKILLS_PROMPT_REQUIRES_TTY] Interactive prompt required but stdin is not a TTY", "the input device is not a TTY", "requires an interactive terminal"]) {
      let calls = 0;
      const streamed: string[] = [];
      const result = { structuredOutput: { output: text, exitCode: 1, truncated: false }, isError: true };
      const tool: any = { name, description: "shell", execute: async () => { calls++; return result; } };
      const wrapped = withShellTerminalGuidance(tool);
      assert.match(wrapped.description, /terminal_exec/);
      assert.equal(await wrapped.execute({}, { output: (text: string) => streamed.push(text) } as any, {} as any), result);
      assert.equal(calls, 1, "no automatic replay of possibly mutating commands");
      assert.match(streamed.join(""), /inspect partial effects/);
      assert.match(streamed.join(""), /does not establish/);
    }
    const printed = { output: [{ type: "text", text: "child says stdin is not a TTY" }], structuredOutput: { output: "child says stdin is not a TTY", exitCode: 0 } };
    const printing = withShellTerminalGuidance({ name, description: "shell", execute: async () => printed } as any);
    const recovered = await printing.execute({}, { output: () => assert.fail("explicit output is retained") } as any, {} as any);
    assert.equal(recovered.structuredOutput, printed.structuredOutput);
    assert.equal(recovered.output?.[0], printed.output[0]);
    assert.equal(recovered.output?.length, 2);
    const ok = { structuredOutput: { output: "installed successfully", exitCode: 0, truncated: false } };
    const wrapped = withShellTerminalGuidance({ name, description: "shell", execute: async () => ok } as any);
    assert.equal(await wrapped.execute({}, { output: () => assert.fail("unrelated output") } as any, {} as any), ok);
    const error = new Error("aborted");
    const throwing = withShellTerminalGuidance({ name, execute: async () => { throw error; } } as any);
    await assert.rejects(throwing.execute({}, {} as any, {} as any), e => e === error);
  }
  const read: any = { name: "read" }; assert.equal(withShellTerminalGuidance(read), read);

  const ptys: FakePty[] = [];
  const host = new TerminalHost({ resolveCwd: () => process.cwd(), ptyFactory: () => {
    const pty = new FakePty(); ptys.push(pty); return pty;
  } });
  const service = new TaskTerminalService(host);
  try {
    host.open({ taskId: "one", cols: 80, rows: 24 });
    const term = await service.open("one");
    const args = ["one", term.terminalId, term.sessionId] as const;
    ptys[1].data("normal\x1b[?1049h\x1b[2J\x1b[HHello\r\x1b[2KWorld");
    const state = await service.read(...args);
    assert.equal(state.screen[0], "World");
    assert.deepEqual(state.cursor, { x: 5, y: 0 });
    ptys[1].data("\x1b[?1049l");
    assert.equal((await service.read(...args)).screen[0], "normal");
    await assert.rejects(service.read("two", term.terminalId, term.sessionId), /ownership/);
    await assert.rejects(service.input("one", term.terminalId, "stale", "BAD"), /stale/);
    assert.deepEqual(ptys[1].writes, []);
    await service.input(...args, "\x03");
    assert.deepEqual(ptys[1].writes, ["\x03"]);
    ptys[1].failWrite = true;
    await assert.rejects(service.input(...args, "BAD"), /input failed/);
    const resized = await service.resize(...args, 100, 30);
    assert.deepEqual(ptys[1].size, [100, 30]);
    assert.equal(resized.cols, 100);
    assert.equal(resized.screen.length, 30);
    assert.equal((await service.read(...args, { waitFor: "missing", timeoutMs: 1 })).wait, "timeout");
    assert.equal((await service.read(...args, { waitFor: "normal" })).wait, "matched");
    await assert.rejects(service.read(...args, { waitFor: "missing", signal: AbortSignal.abort() }), /abort/i);
    await assert.rejects(service.open("one", Infinity, 24), /dimensions/);
    for (let i = 0; i < 3; i++) await service.open("one");
    await assert.rejects(service.open("one"), /four/);
    service.closeTask("one");
    assert.equal(ptys[0].killed, false);
    assert.equal(ptys.slice(1).every(pty => pty.killed), true);
    assert.equal(host.sessionCount(), 1);
    await assert.rejects(service.read(...args), /ownership/);
    console.log("PASS task terminal: ANSI/alternate screen, scope, stale input, resize, wait, cancellation, limits, cleanup");
  } finally { host.dispose(); }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
