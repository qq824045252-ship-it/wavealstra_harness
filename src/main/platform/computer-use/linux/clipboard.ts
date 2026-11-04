import { spawn } from "node:child_process";
import { ComputerUseError } from "../protocol";
import { throwIfCancelled } from "./nativeHelpers";

/** Copies exact UTF-8 in one transfer; never chunks/replays a partially submitted paste. */
export function writeWaylandClipboard(text: string, signal?: AbortSignal): Promise<void> {
  throwIfCancelled(signal);
  return new Promise((resolve, reject) => {
    const child = spawn("wl-copy", ["--type", "text/plain;charset=utf-8"], { stdio: ["pipe", "ignore", "pipe"] });
    let stderr = ""; let settled = false;
    const finish = (error?: Error) => {
      if (settled) return; settled = true; clearTimeout(timer); signal?.removeEventListener("abort", abort);
      child.stderr?.destroy();
      if (error) { child.kill(); reject(error); } else resolve();
    };
    const abort = () => finish(new ComputerUseError("REQUEST_CANCELLED", "剪贴板传输已取消；选区可能已经改变", { clipboardChanged: "unknown", executed: false }));
    const timer = setTimeout(() => finish(new ComputerUseError("REQUEST_TIMEOUT", "wl-copy 传输超时；选区状态未知", { clipboardChanged: "unknown", executed: false })), 3_000);
    signal?.addEventListener("abort", abort, { once: true });
    child.stderr?.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-2_000); });
    child.on("error", error => finish(new ComputerUseError("HOST_UNAVAILABLE", `wl-copy 启动失败：${error.message}`)));
    // wl-copy's selection owner inherits stdio: await the initial process exit, not stream close.
    child.on("exit", code => finish(code === 0 ? undefined : new ComputerUseError("HOST_UNAVAILABLE", `wl-copy 退出 ${code}：${stderr}`)));
    child.stdin?.on("error", () => undefined);
    child.stdin?.end(text, "utf8");
  });
}
