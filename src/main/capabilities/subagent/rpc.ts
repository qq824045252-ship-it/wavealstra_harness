/**
 * rpc.ts — pi `--mode rpc` 子进程封装（B/A）。
 *
 * 协议事实（已在真实 pi CLI 上实证）：
 * - 命令写 stdin（每行一个 JSON），事件/响应读 stdout（JSONL，LF 分隔，可含 \r）。
 * - prompt/steer/follow_up/abort/get_state/get_messages/get_session_stats 等。
 * - 事件：agent_start/agent_settled/message_end/tool_execution 系列/queue_update/
 *   extension_ui_request（对话框必须回 extension_ui_response，否则挂起）。
 * - --session-id <id> + --session-dir <dir>：会话持久化，重启后按 id 恢复。
 *
 * 安全：
 * - 所有 extension_ui_request 对话框一律自动拒绝（子代理内不允许交互审批）；
 *   fire-and-forget（setWidget 等）忽略。
 * - shell:false；kill 序列 SIGTERM → KILL_GRACE_MS → SIGKILL。
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";

export const RPC_KILL_GRACE_MS = 5_000;

export interface RpcChildOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** 子进程 stderr 行（诊断用；调用方可选择性记录） */
  onStderr?: (text: string) => void;
}

export interface RpcEvent {
  type: string;
  [key: string]: unknown;
}

/** 纯函数：按 RPC 协议解析一行（LF 分隔、容忍 \r）。 */
export function parseRpcLine(line: string): RpcEvent | null {
  const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
  if (!trimmed.trim()) return null;
  try {
    return JSON.parse(trimmed) as RpcEvent;
  } catch {
    return null;
  }
}

/** 拆分行缓冲（与 pi rpc 帧协议一致：只按 \n，不做 readline 的 Unicode 分隔）。 */
export class JsonlLineBuffer {
  private buffer = "";
  onLine: (line: string) => void = () => {};
  push(chunk: string): void {
    this.buffer += chunk;
    let idx: number;
    while ((idx = this.buffer.indexOf("\n")) >= 0) {
      const line = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      this.onLine(line);
    }
  }
  flush(): void {
    if (this.buffer.length > 0) {
      const rest = this.buffer;
      this.buffer = "";
      this.onLine(rest);
    }
  }
}

export interface RpcChild {
  readonly pid: number;
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  /** stderr 尾部（诊断用，最多 4KB） */
  readonly stderrTail: string;
  /** spawn 错误（ENOENT/EINVAL 等；无错误为 null） */
  readonly spawnError: Error | null;
  send(obj: Record<string, unknown>): boolean;
  /**
   * 等待匹配的「新」事件（快照语义：只匹配调用之后到达的事件，避免命中陈旧事件）。
   * 超时返回 null。timer 已 unref；race 结束后调用 cancelWaiters() 显式清理。
   */
  waitFor(pred: (ev: RpcEvent) => boolean, timeoutMs: number): Promise<RpcEvent | null>;
  /** 取消全部挂起 waiter（幂等）：clearTimeout + resolve(null) */
  cancelWaiters(): void;
  /** 当前挂起 waiter 数（测试/诊断） */
  pendingWaiterCount(): number;
  /** 在线切换思考强度（idle/安全边界使用）；返回 pi 是否接受 */
  setThinkingLevel(level: string): Promise<boolean>;
  /** 订阅全部后续事件（不含已自动应答的 UI 请求）；返回退订函数。 */
  addListener(fn: (ev: RpcEvent) => void): () => void;
  /** 优雅终止：先 SIGTERM，宽限后 SIGKILL */
  kill(): void;
  closeStdin(): void;
  readonly child: ChildProcess;
}

const DIALOG_METHODS = new Set(["select", "confirm", "input", "editor"]);

export function spawnRpcChild(opts: RpcChildOptions): RpcChild {
  const child = spawn(opts.command, opts.args, {
    cwd: opts.cwd,
    env: opts.env,
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
  });

  const events: RpcEvent[] = [];
  const listeners = new Set<(ev: RpcEvent) => void>();
  const waiters: Array<{ pred: (e: RpcEvent) => boolean; start: number; resolve: (e: RpcEvent | null) => void; timer: NodeJS.Timeout }> = [];
  let settled = false;
  let killed = false;
  let stderrTail = "";
  let spawnError: Error | null = null;

  const lineBuffer = new JsonlLineBuffer();
  lineBuffer.onLine = (line) => {
    const ev = parseRpcLine(line);
    if (!ev) return;
    handleEvent(ev);
  };
  child.stdout?.on("data", (d) => lineBuffer.push(d.toString()));

  function handleEvent(ev: RpcEvent): void {
    events.push(ev);
    // 自动应答对话框：子代理内所有交互审批 → 拒绝（防挂起）
    if (ev.type === "extension_ui_request") {
      const method = String((ev as any).method ?? "");
      if (DIALOG_METHODS.has(method)) {
        send({ type: "extension_ui_response", id: ev.id, cancelled: true });
      }
      return; // 不广播给监听者
    }
    for (const fn of listeners) {
      try {
        fn(ev);
      } catch {
        /* 监听器异常不影响协议循环 */
      }
    }
    for (let i = waiters.length - 1; i >= 0; i--) {
      const w = waiters[i];
      if (w.pred(ev)) {
        clearTimeout(w.timer);
        waiters.splice(i, 1);
        w.resolve(ev);
      }
    }
  }

  function send(obj: Record<string, unknown>): boolean {
    if (child.stdin?.writable && !child.stdin.destroyed) {
      try {
        child.stdin.write(JSON.stringify(obj) + "\n");
        return true;
      } catch {
        return false;
      }
    }
    return false;
  }

  function waitFor(pred: (e: RpcEvent) => boolean, timeoutMs: number): Promise<RpcEvent | null> {
    const start = events.length; // 快照：忽略在此之前的事件
    const existing = events.slice(start).find((e) => pred(e));
    if (existing) return Promise.resolve(existing);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        const i = waiters.findIndex((w) => w.resolve === resolve);
        if (i >= 0) waiters.splice(i, 1);
        resolve(null);
      }, timeoutMs);
      // 未 unref 的 timer 会阻止进程退出/在 race 后残留 → 一律 unref；
      // 显式取消由 cancelWaiters() 负责（runPrompt race 结束后调用）。
      timer.unref?.();
      waiters.push({ pred, start, resolve, timer });
    });
  }

  /** 取消全部挂起 waiter（race 已结束/进程终止时调用；幂等） */
  function cancelWaiters(): void {
    for (const w of waiters.splice(0)) {
      clearTimeout(w.timer);
      w.resolve(null);
    }
  }

  function pendingWaiterCount(): number {
    return waiters.length;
  }

  function addListener(fn: (ev: RpcEvent) => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  }

  /** 在线切换思考强度（idle/安全边界使用）；pi 接受返回 true。 */
  async function setThinkingLevel(level: string): Promise<boolean> {
    const sent = send({ type: "set_thinking_level", level });
    if (!sent) return false;
    const ack = await waitFor(
      (ev) => ev.type === "response" && (ev as any).command === "set_thinking_level",
      3_000,
    );
    return Boolean(ack && (ack as any).success !== false);
  }

  const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) => {
    let done = false;
    const finish = (code: number | null, signal: NodeJS.Signals | null): void => {
      if (done) return;
      done = true;
      settled = true;
      resolve({ code, signal });
    };
    // 必须挂 error 监听：ENOENT 等 spawn 错误若无监听器会以未处理异常崩掉宿主进程
    child.on("close", (code, signal) => finish(code, signal));
    child.on("error", (err) => {
      spawnError = err;
      finish(null, null);
    });
  });

  function kill(): void {
    if (settled || killed) return;
    killed = true;
    try {
      child.kill("SIGTERM");
    } catch {
      /* ignore */
    }
    const hardKill = setTimeout(() => {
      try {
        if (child.exitCode == null) child.kill("SIGKILL");
      } catch {
        /* ignore */
      }
    }, RPC_KILL_GRACE_MS);
    hardKill.unref?.();
  }

  function closeStdin(): void {
    try {
      child.stdin?.end();
    } catch {
      /* ignore */
    }
  }

  child.stderr?.on("data", (d: Buffer) => {
    const text = d.toString().trim();
    if (text) {
      stderrTail = (stderrTail + text + "\n").slice(-4000);
      opts.onStderr?.(text);
    }
  });

  return {
    pid: child.pid ?? -1,
    exited,
    send,
    waitFor,
    addListener,
    cancelWaiters,
    pendingWaiterCount,
    setThinkingLevel,
    kill,
    closeStdin,
    child,
    get stderrTail() {
      return stderrTail;
    },
    get spawnError() {
      return spawnError;
    },
  };
}

/** 读取一个文件的 JSONL（共享给 transcript 读取等场景）。 */
export function readJsonlFile(file: string): RpcEvent[] {
  const raw = fs.readFileSync(file, "utf-8");
  const out: RpcEvent[] = [];
  for (const line of raw.split("\n")) {
    const ev = parseRpcLine(line);
    if (ev) out.push(ev);
  }
  return out;
}
