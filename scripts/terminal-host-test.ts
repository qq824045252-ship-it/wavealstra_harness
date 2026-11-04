/**
 * TerminalHost 单元测试（P0）
 *
 * 覆盖：生命周期（open/restart/close/dispose）、按 taskId 保活与隔离、
 * ring buffer 有界性、大输出 batching、attach 回放、Chat Context tail、
 * cwd 权威解析/拒绝、shell 解析优先级、spawn-failed 降级。
 *
 * 全部使用 fake pty 注入，不依赖真实 shell / node-pty 原生模块。
 * 运行：pnpm run test:terminal
 */
import assert from "node:assert/strict";
import { delimiter, resolve } from "node:path";
import {
  TerminalHost,
  defaultShellForPlatform,
  resolveBoundWorkspaceCwd,
  WORKSPACE_FOLDER_UNBOUND,
  WORKSPACE_FOLDER_UNAVAILABLE,
  WORKSPACE_NOT_FOUND,
  type PtyLike,
} from "../src/main/terminal/TerminalHost";
import { ByteBoundedRingBuffer } from "../src/main/terminal/RingBuffer";
import { TerminalIpc, formatTerminalContextForPrompt } from "../src/shared/terminal-ipc";

/* ------------------------------------------------------------------ */
/* Fake pty                                                            */
/* ------------------------------------------------------------------ */

class FakePty implements PtyLike {
  readonly pid = 1;
  writes: string[] = [];
  resized: Array<[number, number]> = [];
  killed = false;
  private dataCb: ((data: string) => void) | null = null;
  private exitCb: ((e: { exitCode: number; signal?: number }) => void) | null = null;

  onData(cb: (data: string) => void): void {
    this.dataCb = cb;
  }
  onExit(cb: (e: { exitCode: number; signal?: number }) => void): void {
    this.exitCb = cb;
  }
  write(data: string): void {
    this.writes.push(data);
  }
  resize(cols: number, rows: number): void {
    this.resized.push([cols, rows]);
  }
  kill(): void {
    this.killed = true;
  }
  emitData(data: string): void {
    this.dataCb?.(data);
  }
  emitExit(exitCode: number): void {
    this.exitCb?.({ exitCode });
  }
}

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

interface Case {
  name: string;
  run(): Promise<void> | void;
}

const results: Array<{ name: string; ok: boolean; detail?: string }> = [];
const pending: Array<Promise<void>> = [];

function test(name: string, run: () => Promise<void> | void): void {
  results.push({ name, ok: true });
  const idx = results.length - 1;
  pending.push(
    Promise.resolve()
      .then(run)
      .then(
        () => {},
        (err: unknown) => {
          results[idx].ok = false;
          results[idx].detail = err instanceof Error ? err.message : String(err);
        },
      ),
  );
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

interface Harness {
  host: TerminalHost;
  ptys: FakePty[];
  events: Array<{ channel: string; payload: unknown }>;
}

function makeHost(opts?: {
  resolveCwd?: (taskId: string) => string;
  resolveWorkspaceCwd?: (workspaceId: string) => string;
  getShellPath?: (cwd: string) => string | undefined;
  getPathEntries?: () => string[];
  ptyFactory?: (o: unknown) => PtyLike;
  ringMaxBytes?: number;
  flushIntervalMs?: number;
  flushMaxBytes?: number;
}): Harness {
  const ptys: FakePty[] = [];
  const events: Array<{ channel: string; payload: unknown }> = [];
  const host = new TerminalHost({
    resolveCwd: opts?.resolveCwd ?? ((taskId: string) => `C:\\work\\${taskId}`),
    resolveWorkspaceCwd: opts?.resolveWorkspaceCwd ?? ((workspaceId: string) => `C:\\ws\\${workspaceId}`),
    getShellPath: opts?.getShellPath,
    getPathEntries: opts?.getPathEntries,
    ptyFactory:
      opts?.ptyFactory ??
      (() => {
        const p = new FakePty();
        ptys.push(p);
        return p;
      }),
    ringMaxBytes: opts?.ringMaxBytes ?? 64 * 1024,
    flushIntervalMs: opts?.flushIntervalMs ?? 10,
    flushMaxBytes: opts?.flushMaxBytes ?? 32 * 1024,
  });
  host.setSend((channel, payload) => events.push({ channel, payload }));
  return { host, ptys, events };
}

const dataEvents = (h: Harness): Array<{ taskId: string; sessionId: string; data: string }> =>
  h.events
    .filter((e) => e.channel === TerminalIpc.data)
    .map((e) => e.payload as { taskId: string; sessionId: string; data: string });

const exitEvents = (h: Harness): Array<{ taskId: string; sessionId: string; exitCode: number | null; reason: string }> =>
  h.events
    .filter((e) => e.channel === TerminalIpc.exit)
    .map((e) => e.payload as { taskId: string; sessionId: string; exitCode: number | null; reason: string });

/* ------------------------------------------------------------------ */
/* 用例                                                               */
/* ------------------------------------------------------------------ */

test("open: spawn 使用权威 cwd + 平台默认 shell + 隔离 env", () => {
  const h = makeHost();
  const info = h.host.open({ taskId: "t1", cols: 80, rows: 24 });
  assert.equal(h.ptys.length, 1);
  assert.equal(info.alive, true);
  assert.equal(info.cwd, "C:\\work\\t1");
  assert.equal(info.shell, defaultShellForPlatform());
  assert.ok(h.ptys[0]);
});

test("open: getShellPath 优先级高于平台默认", () => {
  const h = makeHost({ getShellPath: () => "C:\\custom\\shell.exe" });
  const info = h.host.open({ taskId: "t1", cols: 80, rows: 24 });
  assert.equal(info.shell, "C:\\custom\\shell.exe");
});


test("open: MyBuddy CLI bin is prepended to PATH exactly once", () => {
  const captured: NodeJS.ProcessEnv[] = [];
  const toolBin = process.platform === "win32" ? "C:\\Users\\tester\\.mybuddy\\bin" : "/home/tester/.mybuddy/bin";
  const h = makeHost({
    getPathEntries: () => [toolBin, toolBin],
    ptyFactory: ((o: { env?: NodeJS.ProcessEnv }) => {
      captured.push(o.env ?? {});
      return new FakePty();
    }) as (o: unknown) => PtyLike,
  });
  h.host.open({ taskId: "t1", cols: 80, rows: 24 });
  const env = captured[0];
  const pathKey = Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "PATH";
  const entries = String(env[pathKey] ?? "").split(delimiter).filter(Boolean);
  assert.equal(resolve(entries[0]), resolve(toolBin));
  assert.equal(entries.filter((entry) => resolve(entry) === resolve(toolBin)).length, 1);
});

test("open: env 注入 MYBUDDY_TASK_ROOT 且 PWD 指向任务根", () => {
  const h = makeHost();
  h.host.open({ taskId: "t1", cols: 80, rows: 24 });
  // 通过 ptyFactory 捕获 env 验证
  const captured: unknown[] = [];
  const h2 = makeHost({
    ptyFactory: ((o: { env?: NodeJS.ProcessEnv }) => {
      captured.push(o.env);
      return new FakePty();
    }) as (o: unknown) => PtyLike,
  });
  h2.host.open({ taskId: "t1", cols: 80, rows: 24 });
  const env = captured[0] as NodeJS.ProcessEnv;
  assert.equal(env.MYBUDDY_TASK_ROOT, "C:\\work\\t1");
  assert.equal(env.MYBUDDY_SHELL_ISOLATION, "cwd-only");
  assert.equal(env.TERM, "xterm-256color");
});

test("open: 死亡/不存在会话 → 重新 spawn；存活 → attach 不回放为空", async () => {
  const h = makeHost({ flushIntervalMs: 10 });
  const first = h.host.open({ taskId: "t1", cols: 80, rows: 24 });
  h.ptys[0].emitData("hello ");
  h.ptys[0].emitData("world");
  await sleep(30); // flush
  assert.equal(dataEvents(h).length, 1);
  assert.equal(dataEvents(h)[0].data, "hello world");

  // 再次 open = attach：回放 ring 尾部
  const before = dataEvents(h).length;
  const second = h.host.open({ taskId: "t1", cols: 80, rows: 24 });
  assert.equal(second.sessionId, first.sessionId);
  const replay = dataEvents(h).slice(before);
  assert.equal(replay.length, 1);
  assert.equal(replay[0].data, "hello world");

  // 自然退出后 open → 新会话
  h.ptys[0].emitExit(0);
  const third = h.host.open({ taskId: "t1", cols: 80, rows: 24 });
  assert.notEqual(third.sessionId, first.sessionId);
  assert.equal(third.alive, true);
});

test("input: 写入正确 pty；旧 sessionId 输入被丢弃", () => {
  const h = makeHost();
  const info = h.host.open({ taskId: "t1", cols: 80, rows: 24 });
  h.host.input({ taskId: "t1", sessionId: info.sessionId, data: "ls\r" });
  assert.deepEqual(h.ptys[0].writes, ["ls\r"]);
  h.host.input({ taskId: "t1", sessionId: "stale-session", data: "rm -rf /\r" });
  assert.deepEqual(h.ptys[0].writes, ["ls\r"]);
});

test("同任务下不同 terminalId 分立独立 PTY 会话", () => {
  const h = makeHost();
  const info1 = h.host.open({ taskId: "t1", terminalId: "term-1", cols: 80, rows: 24 });
  const info2 = h.host.open({ taskId: "t1", terminalId: "term-2", cols: 80, rows: 24 });
  assert.notEqual(info1.sessionId, info2.sessionId);
  assert.equal(h.ptys.length, 2);

  h.host.input({ taskId: "t1", terminalId: "term-1", sessionId: info1.sessionId, data: "echo 1\r" });
  h.host.input({ taskId: "t1", terminalId: "term-2", sessionId: info2.sessionId, data: "echo 2\r" });

  assert.deepEqual(h.ptys[0].writes, ["echo 1\r"]);
  assert.deepEqual(h.ptys[1].writes, ["echo 2\r"]);

  h.host.close({ taskId: "t1", terminalId: "term-1" });
  assert.equal(h.ptys[0].killed, true);
  assert.equal(h.ptys[1].killed, false);
});

test("resize: 尺寸变化调用 pty.resize；非法值钳制", () => {
  const h = makeHost();
  const info = h.host.open({ taskId: "t1", cols: 80, rows: 24 });
  h.host.resize({ taskId: "t1", sessionId: info.sessionId, cols: 120, rows: 30 });
  assert.deepEqual(h.ptys[0].resized, [[120, 30]]);
  h.host.resize({ taskId: "t1", sessionId: info.sessionId, cols: 0, rows: 0 }); // 非法 → 保持
  assert.deepEqual(h.ptys[0].resized, [[120, 30]]);
  h.host.resize({ taskId: "t1", sessionId: "wrong-session", cols: 200, rows: 50 }); // 旧会话忽略
  assert.deepEqual(h.ptys[0].resized, [[120, 30]]);
});

test("batching: 小碎块合并为单条 data 事件（25ms 内不逐块打 IPC）", async () => {
  const h = makeHost({ flushIntervalMs: 10 });
  h.host.open({ taskId: "t1", cols: 80, rows: 24 });
  h.ptys[0].emitData("a");
  h.ptys[0].emitData("b");
  h.ptys[0].emitData("c");
  assert.equal(dataEvents(h).length, 0); // 未到 flush 周期
  await sleep(25);
  const events = dataEvents(h);
  assert.equal(events.length, 1);
  assert.equal(events[0].data, "abc");
});

test("batching: 超过 flushMaxBytes 提前 flush", () => {
  const h = makeHost({ flushMaxBytes: 16 });
  h.host.open({ taskId: "t1", cols: 80, rows: 24 });
  h.ptys[0].emitData("0123456789ABCDEF"); // 16 字节 = 阈值
  const events = dataEvents(h);
  assert.equal(events.length, 1);
  assert.equal(events[0].data, "0123456789ABCDEF");
});

test("ring buffer: 字节有界，超限丢弃最旧，tail 可限长", () => {
  const ring = new ByteBoundedRingBuffer(32);
  ring.push("aaaa"); // 4
  ring.push("bbbb"); // 8
  ring.push("cccc"); // 12
  ring.push("dddd"); // 16
  ring.push("eeee"); // 20
  ring.push("ffff"); // 24
  ring.push("gggg"); // 28
  ring.push("hhhh"); // 32 — 全部保留
  assert.equal(ring.size, 32);
  assert.equal(ring.tail(), "aaaabbbbccccddddeeeeffffgggghhhh");
  ring.push("iiii"); // 36 > 32 → 丢最旧 aaaa
  assert.equal(ring.size, 32);
  assert.equal(ring.tail(), "bbbbccccddddeeeeffffgggghhhhiiii");
  assert.ok(ring.dropped >= 4);
  assert.equal(ring.tailBounded(8), "hhhhiiii");
  assert.equal(ring.tailBounded(100), "bbbbccccddddeeeeffffgggghhhhiiii");
  ring.clear();
  assert.equal(ring.size, 0);
  assert.equal(ring.tail(), "");
});

test("ring buffer: 单块超上限清空旧块并正确累计 dropped", () => {
  const ring = new ByteBoundedRingBuffer(100);
  ring.push("a".repeat(40));
  ring.push("b".repeat(40));
  assert.equal(ring.size, 80);
  assert.equal(ring.dropped, 0);
  ring.push("c".repeat(200)); // 单块 > max：旧 80 字节全部丢弃并计入 dropped
  assert.equal(ring.size, 200); // 大块整体保留（不拆散 ANSI/多字节字符）
  assert.equal(ring.dropped, 80);
  assert.equal(ring.tail(), "c".repeat(200));
  // 之后再 push 小块：整块淘汰（大块整体被丢，不拆块）
  ring.push("d");
  assert.equal(ring.size, 1);
  assert.equal(ring.tail(), "d");
  assert.equal(ring.dropped, 280);
});

test("ring buffer: tailBounded 对 CJK 按 UTF-8 字节预算安全截取", () => {
  const ring = new ByteBoundedRingBuffer(1024);
  const text = "你好世界".repeat(50); // 每字 3 字节 UTF-8
  ring.push(text);
  // 预算 10 字节：最多容纳 3 个汉字（9 字节），不超预算、不拆字符
  const t = ring.tailBounded(10);
  assert.ok(Buffer.byteLength(t, "utf8") <= 10);
  assert.equal(t, "好世界"); // 尾部 3 字
  // 预算 7 字节 → 2 字
  assert.equal(ring.tailBounded(7), "世界");
  assert.ok(Buffer.byteLength(ring.tailBounded(7), "utf8") <= 7);
});

test("ring buffer: tailBounded 不拆散代理对（emoji）", () => {
  const ring = new ByteBoundedRingBuffer(1024);
  ring.push("a😀b😀c"); // 😀 = 4 字节（2 code unit）
  // 预算 5：1+4 → "😀c" 完整代理对
  const t = ring.tailBounded(5);
  assert.equal(t, "😀c");
  assert.ok(Buffer.byteLength(t, "utf8") <= 5);
  // 预算 4：容不下代理对 → 只留 "c"，不产生孤立代理
  const t2 = ring.tailBounded(4);
  assert.equal(t2, "c");
  assert.ok(!/\uD800-\uDFFF/.test(t2));
  // 预算 1 → "c"
  assert.equal(ring.tailBounded(1), "c");
});

test("tail: Chat Context 取最近输出，无会话返回空", async () => {
  const h = makeHost({ flushIntervalMs: 10 });
  const info = h.host.open({ taskId: "t1", cols: 80, rows: 24 });
  h.ptys[0].emitData("line1\r\n");
  h.ptys[0].emitData("line2\r\n");
  await sleep(30);
  const t = h.host.tail({ taskId: "t1", maxBytes: 1024 });
  assert.equal(t.sessionId, info.sessionId);
  assert.equal(t.text, "line1\r\nline2\r\n");
  assert.equal(t.truncated, false);
  const empty = h.host.tail({ taskId: "nope", maxBytes: 1024 });
  assert.equal(empty.sessionId, null);
  assert.equal(empty.text, "");
});

test("restart: 杀旧会话、新 sessionId、ring 清空", () => {
  const h = makeHost();
  const first = h.host.open({ taskId: "t1", cols: 80, rows: 24 });
  h.ptys[0].emitData("old output");
  const second = h.host.restart({ taskId: "t1", cols: 100, rows: 30 });
  assert.notEqual(second.sessionId, first.sessionId);
  assert.equal(h.ptys[0].killed, true);
  assert.equal(h.ptys.length, 2);
  assert.equal(h.host.tail({ taskId: "t1", maxBytes: 1024 }).text, "");
});

test("close: kill + exit 事件 reason=killed", () => {
  const h = makeHost();
  const info = h.host.open({ taskId: "t1", cols: 80, rows: 24 });
  h.host.close({ taskId: "t1" });
  assert.equal(h.ptys[0].killed, true);
  h.ptys[0].emitExit(1);
  const exits = exitEvents(h);
  assert.equal(exits.length, 1);
  assert.equal(exits[0].sessionId, info.sessionId);
  assert.equal(exits[0].exitCode, 1);
  assert.equal(exits[0].reason, "killed");
  // 退出后 open → 新会话
  const again = h.host.open({ taskId: "t1", cols: 80, rows: 24 });
  assert.notEqual(again.sessionId, info.sessionId);
});

test("自然退出: exit 事件 reason=exit，退出码透传", () => {
  const h = makeHost();
  const info = h.host.open({ taskId: "t1", cols: 80, rows: 24 });
  h.ptys[0].emitExit(0);
  const exits = exitEvents(h);
  assert.equal(exits[0].sessionId, info.sessionId);
  assert.equal(exits[0].exitCode, 0);
  assert.equal(exits[0].reason, "exit");
});

test("exit: 退出前冲刷待发输出，最后 <=25ms 不丢且不重复", () => {
  const h = makeHost({ flushIntervalMs: 1000 }); // 长周期：确保 exit 时仍在 pending
  const info = h.host.open({ taskId: "t1", cols: 80, rows: 24 });
  h.ptys[0].emitData("final line");
  assert.equal(dataEvents(h).length, 0); // 尚未到 flush 周期
  h.ptys[0].emitExit(0);
  // data 先于 exit 到达（同栈有序），内容完整
  assert.equal(h.events[0].channel, TerminalIpc.data);
  assert.equal((h.events[0].payload as { data: string }).data, "final line");
  const exits = exitEvents(h);
  assert.equal(exits.length, 1);
  assert.equal(exits[0].sessionId, info.sessionId);
  assert.equal(exits[0].reason, "exit");
  // 不重复发送
  assert.equal(dataEvents(h).length, 1);
});

test("exit: 无待发输出时 exit 不产生多余 data 事件", () => {
  const h = makeHost();
  h.host.open({ taskId: "t1", cols: 80, rows: 24 });
  h.ptys[0].emitExit(1);
  assert.equal(dataEvents(h).length, 0);
  assert.equal(exitEvents(h).length, 1);
});

test("任务隔离: 两个 taskId 互不干扰", async () => {
  const h = makeHost({ flushIntervalMs: 10 });
  const a = h.host.open({ taskId: "tA", cols: 80, rows: 24 });
  const b = h.host.open({ taskId: "tB", cols: 80, rows: 24 });
  assert.equal(h.ptys.length, 2);
  h.ptys[0].emitData("from-A");
  h.ptys[1].emitData("from-B");
  await sleep(25);
  const da = dataEvents(h).filter((e) => e.taskId === "tA");
  const db = dataEvents(h).filter((e) => e.taskId === "tB");
  assert.equal(da.length, 1);
  assert.equal(da[0].data, "from-A");
  assert.equal(db.length, 1);
  assert.equal(db[0].data, "from-B");
  h.host.close({ taskId: "tA" });
  assert.equal(h.ptys[0].killed, true);
  assert.equal(h.ptys[1].killed, false);
  assert.equal(a.taskId, "tA");
  assert.equal(b.taskId, "tB");
});

test("dispose: 杀全部 PTY 并清空", () => {
  const h = makeHost();
  h.host.open({ taskId: "t1", cols: 80, rows: 24 });
  h.host.open({ taskId: "t2", cols: 80, rows: 24 });
  h.host.dispose();
  assert.equal(h.ptys[0].killed, true);
  assert.equal(h.ptys[1].killed, true);
  assert.equal(h.host.sessionCount(), 0);
});

test("spawn-failed: shell 不可执行 → alive=false + exit 事件 reason=spawn-failed", () => {
  const h = makeHost({
    ptyFactory: () => {
      throw new Error("spawn ENOENT");
    },
  });
  const info = h.host.open({ taskId: "t1", cols: 80, rows: 24 });
  assert.equal(info.alive, false);
  assert.equal(info.exitReason, "spawn-failed");
  const exits = exitEvents(h);
  assert.equal(exits.length, 1);
  assert.equal(exits[0].reason, "spawn-failed");
});

test("resolveCwd 抛错 → open 抛错（不降级、不 spawn）", () => {
  const h = makeHost({
    resolveCwd: () => {
      throw new Error("任务目录不存在");
    },
  });
  assert.throws(() => h.host.open({ taskId: "gone", cols: 80, rows: 24 }), /任务目录不存在/);
  assert.equal(h.ptys.length, 0);
});

test("workspace open: spawn cwd = 空间绑定文件夹，不走任务 resolveCwd", () => {
  const captured: string[] = [];
  const h = makeHost({
    resolveCwd: () => {
      throw new Error("task cwd 不应被空间终端调用");
    },
    resolveWorkspaceCwd: (id) => `C:\\Users\\servi\\Desktop\\${id}`,
    ptyFactory: ((o: { cwd?: string }) => {
      captured.push(o.cwd ?? "");
      return new FakePty();
    }) as (o: unknown) => PtyLike,
  });
  const info = h.host.open({ workspaceId: "mybuddy", cols: 80, rows: 24 });
  assert.equal(info.workspaceId, "mybuddy");
  assert.equal(info.taskId, undefined);
  assert.equal(info.cwd, "C:\\Users\\servi\\Desktop\\mybuddy");
  assert.deepEqual(captured, ["C:\\Users\\servi\\Desktop\\mybuddy"]);
});

test("workspace open: 同 workspace 重新绑定目录后不复用旧 PTY", () => {
  let cwd = "C:\\project-a";
  const h = makeHost({ resolveWorkspaceCwd: () => cwd });
  const first = h.host.open({ workspaceId: "w-rebind", cols: 80, rows: 24 });
  assert.equal(first.cwd, "C:\\project-a");
  cwd = "C:\\project-b";
  const second = h.host.open({ workspaceId: "w-rebind", cols: 80, rows: 24 });
  assert.equal(h.ptys[0].killed, true);
  assert.equal(h.ptys.length, 2);
  assert.notEqual(second.sessionId, first.sessionId);
  assert.equal(second.cwd, "C:\\project-b");
});

test("workspace open: 未绑定文件夹 → 抛错且不 spawn", () => {
  const h = makeHost({
    resolveWorkspaceCwd: () => {
      throw new Error(WORKSPACE_FOLDER_UNBOUND);
    },
  });
  assert.throws(() => h.host.open({ workspaceId: "ws-empty", cols: 80, rows: 24 }), /尚未绑定文件夹/);
  assert.equal(h.ptys.length, 0);
});

test("workspace vs task: 同 id 字符串也不串会话 / cwd", async () => {
  const h = makeHost({
    resolveCwd: (id) => `C:\\task\\${id}`,
    resolveWorkspaceCwd: (id) => `C:\\ws\\${id}`,
    flushIntervalMs: 10,
  });
  const task = h.host.open({ taskId: "same", cols: 80, rows: 24 });
  const ws = h.host.open({ workspaceId: "same", cols: 80, rows: 24 });
  assert.equal(h.ptys.length, 2);
  assert.equal(task.cwd, "C:\\task\\same");
  assert.equal(ws.cwd, "C:\\ws\\same");
  h.ptys[0].emitData("from-task");
  h.ptys[1].emitData("from-ws");
  await sleep(25);
  const taskData = dataEvents(h).filter((e) => e.taskId === "same");
  const wsData = dataEvents(h).filter((e) => (e as { workspaceId?: string }).workspaceId === "same");
  assert.equal(taskData.length, 1);
  assert.equal(taskData[0].data, "from-task");
  assert.equal(wsData.length, 1);
  assert.equal(wsData[0].data, "from-ws");
});

test("workspace input/resize/tail/close 走 workspace owner", () => {
  const h = makeHost();
  const info = h.host.open({ workspaceId: "w1", cols: 80, rows: 24 });
  h.host.input({ workspaceId: "w1", sessionId: info.sessionId, data: "herdr\r" });
  assert.deepEqual(h.ptys[0].writes, ["herdr\r"]);
  h.host.input({ taskId: "w1", sessionId: info.sessionId, data: "should-not-write\r" });
  assert.deepEqual(h.ptys[0].writes, ["herdr\r"]);
  h.host.resize({ workspaceId: "w1", sessionId: info.sessionId, cols: 100, rows: 40 });
  assert.deepEqual(h.ptys[0].resized, [[100, 40]]);
  const tail = h.host.tail({ workspaceId: "w1", maxBytes: 64 });
  assert.equal(tail.sessionId, info.sessionId);
  h.host.close({ workspaceId: "w1" });
  assert.equal(h.ptys[0].killed, true);
});

test("open 缺少 owner → 抛错", () => {
  const h = makeHost();
  assert.throws(() => h.host.open({ cols: 80, rows: 24 }), /必须提供/);
  assert.equal(h.ptys.length, 0);
});

test("resolveBoundWorkspaceCwd: 绑定路径可用则返回原路径", () => {
  const cwd = resolveBoundWorkspaceCwd({ path: "C:\\Users\\servi\\Desktop\\mybuddy" }, () => true);
  assert.equal(cwd, "C:\\Users\\servi\\Desktop\\mybuddy");
});

test("resolveBoundWorkspaceCwd: 未绑定 / 丢失 / 不存在均抛错，不回退", () => {
  assert.throws(() => resolveBoundWorkspaceCwd(undefined, () => true), new RegExp(WORKSPACE_NOT_FOUND));
  assert.throws(() => resolveBoundWorkspaceCwd({ path: "" }, () => true), new RegExp(WORKSPACE_FOLDER_UNBOUND));
  assert.throws(
    () => resolveBoundWorkspaceCwd({ path: "C:\\gone", pathMissing: true }, () => true),
    new RegExp(WORKSPACE_FOLDER_UNAVAILABLE),
  );
  assert.throws(
    () => resolveBoundWorkspaceCwd({ path: "C:\\gone" }, () => false),
    new RegExp(WORKSPACE_FOLDER_UNAVAILABLE),
  );
});

test("formatTerminalContextForPrompt: untrusted 标注 + 限长", () => {
  const text = "npm run build\r\n✓ done".repeat(2000); // 远超 8KB
  const ctx = {
    taskId: "t1",
    sessionId: "s1",
    cwd: "C:\\work\\t1",
    shell: "pwsh",
    source: "recent-output" as const,
    text,
    capturedAt: Date.now(),
  };
  const out = formatTerminalContextForPrompt(ctx);
  assert.ok(out.includes("untrusted"));
  assert.ok(out.includes("C:\\work\\t1"));
  assert.ok(out.includes("pwsh"));
  assert.ok(out.includes("```text"));
  // 限长：8KB 字符上限（+ 尾部换行）
  const codeBlock = out.split("```text")[1].split("```")[0];
  assert.ok(codeBlock.length <= 8 * 1024 + 2);
  assert.ok(codeBlock.length > 8 * 1024 - 200); // 确实截断了
});

/* ------------------------------------------------------------------ */
/* 运行                                                               */
/* ------------------------------------------------------------------ */

void (async () => {
  await Promise.all(pending);
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${"-".repeat(72)}`);
  console.log(`terminal-host: ${results.length - failed.length}/${results.length} PASS`);
  if (failed.length > 0) {
    for (const f of failed) console.error(`FAILED: ${f.name} — ${f.detail}`);
    process.exitCode = 1;
  }
})();
