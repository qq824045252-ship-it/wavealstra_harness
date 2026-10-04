/**
 * TerminalHost 真实链路冒烟探针（Electron 运行时，~4s）：
 *   electron out/tests/pty-host-probe.cjs
 * 验证：真实 node-pty（Electron ABI）+ 真实 shell 经 TerminalHost 的
 * spawn → input → batching → ring buffer → tail 全链路。
 * 退出码 0 = OK。
 */
import { app } from "electron";
import { TerminalHost } from "../src/main/terminal/TerminalHost";

app.whenReady().then(() => {
  const host = new TerminalHost({
    resolveCwd: () => app.getPath("home"),
    getShellPath: () => undefined, // 平台默认（pwsh/powershell）
  });
  const events: string[] = [];
  host.setSend((channel, payload) => {
    events.push(`${channel}`);
  });
  const info = host.open({ taskId: "probe-task", cols: 90, rows: 30 });
  console.log(`spawned shell=${info.shell} alive=${info.alive}`);
  host.input({ taskId: "probe-task", sessionId: info.sessionId, data: "Write-Output HOST_PROBE_OK\r" });
  const timer = setTimeout(() => {
    const tail = host.tail({ taskId: "probe-task", maxBytes: 8192 });
    console.log(`data events=${events.filter((c) => c === "terminal:data").length} tail=${JSON.stringify(tail.text)}`);
    const ok = tail.text.includes("HOST_PROBE_OK") && events.length > 0;
    host.dispose();
    console.log(`PTY_HOST_PROBE ${ok ? "OK" : "FAIL"}`);
    process.exit(ok ? 0 : 1);
  }, 4000);
  timer.unref?.();
});
