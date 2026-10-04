/**
 * node-pty 加载探针（Electron 运行时）：
 *   electron scripts/pty-load-probe.cjs
 * 验证：①Electron ABI 下 require("node-pty") 成功；②ConPTY spawn + 输出 + 退出闭环。
 * 退出码 0 = OK；非 0 = 失败（ABI / ConPTY / shell 问题）。
 */
const { app } = require("electron");

app.whenReady().then(() => {
  try {
    const pty = require("node-pty");
    const os = require("node:os");
    const { join } = require("node:path");
    const shell =
      process.platform === "win32"
        ? process.env.SystemRoot + "\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
        : process.env.SHELL || "/bin/bash";
    const args = process.platform === "win32" ? ["-NoProfile", "-Command", "Write-Output PTY_PROBE_OK"] : ["-c", "echo PTY_PROBE_OK"];
    const p = pty.spawn(shell, args, {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: os.homedir(),
      env: { ...process.env, TERM: "xterm-256color" },
    });
    let out = "";
    const timer = setTimeout(() => {
      console.error("PTY_PROBE_TIMEOUT");
      process.exit(2);
    }, 15000);
    p.onData((d) => {
      out += d;
    });
    p.onExit((e) => {
      clearTimeout(timer);
      const ok = e.exitCode === 0 && out.includes("PTY_PROBE_OK");
      console.log(`PTY_PROBE exit=${e.exitCode} signal=${e.signal} ok=${ok}`);
      console.log(`electron=${process.versions.electron} node=${process.versions.node} modules=${process.versions.modules}`);
      process.exit(ok ? 0 : 1);
    });
  } catch (err) {
    console.error("PTY_PROBE_FAIL", err);
    process.exit(3);
  }
});
