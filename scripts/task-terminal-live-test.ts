import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TerminalHost } from "../src/main/terminal/TerminalHost";
import { TaskTerminalService } from "../src/main/terminal/TaskTerminalService";

async function main() {
  const root = mkdtempSync(join(tmpdir(), "mybuddy-pty-live-"));
  const fixture = join(root, "fixture.cjs");
  writeFileSync(fixture, `
process.stdin.setRawMode(true);
process.stdin.resume();
process.stdout.write('\\x1b[?1049h\\x1b[2J\\x1b[HSTALE\\r\\x1b[2KREADY\\r\\nPID=' + process.pid);
process.stdin.on('data', data => {
  const text = data.toString();
  if (text.includes('\\x03')) {
    process.stdout.write('\\r\\nINTERRUPTED\\r\\n');
    process.exit(0);
  }
  if (text.includes('s')) process.stdout.write('\\r\\nSIZE=' + process.stdout.columns + 'x' + process.stdout.rows);
  if (text.includes('g')) process.stdout.write('\\r\\nINPUT-OK');
});
`);
  const host = new TerminalHost({ resolveCwd: () => root });
  const service = new TaskTerminalService(host);
  try {
    const user = host.open({ taskId: "fixture", terminalId: "user", cols: 80, rows: 24 });
    assert.equal(user.alive, true);
    const terminal = await service.open("fixture");
    const args = ["fixture", terminal.terminalId, terminal.sessionId] as const;
    const command = process.platform === "win32" ? `node '${fixture.replaceAll("'", "''")}'\r` : `node '${fixture.replaceAll("'", "'\\''")}'\r`;
    await service.input(...args, command);
    const ready = await service.read(...args, { waitFor: "READY", timeoutMs: 15000 });
    assert.equal(ready.wait, "matched", ready.screen.join("\n"));
    assert.equal(ready.screen[0], "READY");
    assert.equal(ready.screen.join("\n").includes("STALE"), false);
    await service.input(...args, "g");
    assert.equal((await service.read(...args, { waitFor: "INPUT-OK" })).wait, "matched");
    await service.resize(...args, 100, 30);
    await service.input(...args, "s");
    const resized = await service.read(...args, { waitFor: "SIZE=100x30" });
    assert.equal(resized.wait, "matched", resized.screen.join("\n"));
    await service.input(...args, "\x03");
    const interrupted = await service.read(...args, { waitFor: "INTERRUPTED" });
    assert.equal(interrupted.wait, "matched", interrupted.screen.join("\n"));
    await service.input(...args, "exit\r");
    const exited = await service.read(...args, { waitFor: "never-match", timeoutMs: 10000 });
    assert.equal(exited.wait, "exited");
    assert.equal(exited.alive, false);
    const running = await service.open("fixture");
    const activeArgs = ["fixture", running.terminalId, running.sessionId] as const;
    await service.input(...activeArgs, command);
    const active = await service.read(...activeArgs, { waitFor: "PID=", timeoutMs: 15000 });
    assert.equal(active.wait, "matched");
    const pid = Number(/PID=(\d+)/.exec(active.screen.join("\n"))?.[1]);
    assert.ok(pid > 1);
    service.closeTask("fixture");
    const deadline = Date.now() + 8000;
    for (;;) {
      try { process.kill(pid, 0); } catch { break; }
      assert.ok(Date.now() < deadline, `task cleanup leaked TUI child ${pid}`);
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(host.getInfo({ kind: "task", id: "fixture", terminalId: "user" })?.alive, true);
    assert.equal(host.sessionCount(), 1);
    const report = { platform: process.platform, node: process.versions.node, backend: process.platform === "win32" ? "ConPTY" : "PTY", cwd: terminal.cwd, ready, resized, interrupted, exited, userTerminalPreserved: true, activeTuiProcessTerminated: pid };
    if (process.env.PSTACK_TERMINAL_REPORT) writeFileSync(process.env.PSTACK_TERMINAL_REPORT, JSON.stringify(report, null, 2));
    console.log(`PASS real ${report.backend}: TUI read/input/resize/Ctrl-C/exit; task-owned cleanup preserves user terminal`);
  } finally {
    host.dispose();
    await new Promise(resolve => setTimeout(resolve, 200));
    rmSync(root, { recursive: true, force: true });
  }
}
void main().catch(error => { console.error(error); process.exitCode = 1; });
