/**
 * Terminal store 镜像测试（renderer 侧状态机）
 *
 * 回归点：
 * - applyTerminalExit 必须更新**任意** taskId 的会话镜像（非活跃任务退出也要记录），
 *   且按 sessionId 丢弃旧会话事件（restart 后的旧 exit 不覆盖新会话状态）。
 * - attachTerminalContext 需要会话镜像存在、文本非空、双侧限长（8KB 字符）。
 *
 * 运行：pnpm run test:terminal（与 host/bridge 测试串联；纯 node，window.api 为 mock）
 */
import { useAppStore } from "../src/renderer/src/store/appStore";
import { TERMINAL_CONTEXT_MAX_CHARS, type TerminalExitEvent } from "../src/shared/terminal-ipc";

const results: Array<[string, boolean, string]> = [];
const check = (name: string, pass: boolean, detail = ""): void => {
  results.push([name, pass, detail]);
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
};

function resetStore(): void {
  useAppStore.setState({
    activeTaskId: null,
    terminalSessions: {},
    terminalContext: null,
  });
}

function makeExit(taskId: string, sessionId: string, exitCode: number, reason: TerminalExitEvent["reason"]): TerminalExitEvent {
  return { taskId, sessionId, exitCode, reason };
}

async function main(): Promise<void> {
  // 与 chat-selection-test 同款：import appStore 之后再挂 window（theme 初始值依赖 typeof window）
  (globalThis as unknown as { window: unknown }).window = {
    api: {},
  };

  {
    resetStore();
    // 活跃任务 A 的会话退出
    useAppStore.setState({
      activeTaskId: "A",
      terminalSessions: {
        A: { taskId: "A", sessionId: "sA", cwd: "C:\\work\\A", shell: "pwsh", alive: true, exitCode: null, exitReason: null, startedAt: 1 },
      },
    });
    useAppStore.getState().applyTerminalExit(makeExit("A", "sA", 0, "exit"));
    const m = useAppStore.getState().terminalSessions["A"];
    check("T1 活跃任务退出 → 镜像 alive=false + exitCode/reason", m?.alive === false && m?.exitCode === 0 && m?.exitReason === "exit");
  }
  {
    resetStore();
    // 非活跃任务 B 的会话退出（当前看 A）
    useAppStore.setState({
      activeTaskId: "A",
      terminalSessions: {
        A: { taskId: "A", sessionId: "sA", cwd: "C:\\work\\A", shell: "pwsh", alive: true, exitCode: null, exitReason: null, startedAt: 1 },
        B: { taskId: "B", sessionId: "sB", cwd: "C:\\work\\B", shell: "pwsh", alive: true, exitCode: null, exitReason: null, startedAt: 2 },
      },
    });
    useAppStore.getState().applyTerminalExit(makeExit("B", "sB", 1, "exit"));
    const b = useAppStore.getState().terminalSessions["B"];
    const a = useAppStore.getState().terminalSessions["A"];
    check("T2 非活跃任务退出 → 其镜像也更新，活跃任务不受影响", b?.alive === false && b?.exitCode === 1 && a?.alive === true);
  }
  {
    resetStore();
    // restart 后旧会话的 exit 事件（sessionId 不匹配）→ 丢弃
    useAppStore.setState({
      activeTaskId: "A",
      terminalSessions: {
        A: { taskId: "A", sessionId: "sA2", cwd: "C:\\work\\A", shell: "pwsh", alive: true, exitCode: null, exitReason: null, startedAt: 3 },
      },
    });
    useAppStore.getState().applyTerminalExit(makeExit("A", "sA-old", 137, "killed"));
    const a = useAppStore.getState().terminalSessions["A"];
    check("T3 旧 sessionId exit → 丢弃，不覆盖新会话状态", a?.alive === true && a?.sessionId === "sA2");
  }
  {
    resetStore();
    // attachTerminalContext：会话不存在 → false
    useAppStore.setState({ activeTaskId: "A", terminalSessions: {} });
    const ok = useAppStore.getState().attachTerminalContext({ taskId: "A", source: "selection", text: "hello" });
    check("T4 attach 无会话镜像 → false", ok === false && useAppStore.getState().terminalContext === null);
  }
  {
    resetStore();
    // attachTerminalContext：成功 → pending + 8KB 字符限长
    useAppStore.setState({
      activeTaskId: "A",
      terminalSessions: {
        A: { taskId: "A", sessionId: "sA", cwd: "C:\\work\\A", shell: "pwsh", alive: true, exitCode: null, exitReason: null, startedAt: 1 },
      },
    });
    const big = "x".repeat(TERMINAL_CONTEXT_MAX_CHARS + 5000);
    const ok = useAppStore.getState().attachTerminalContext({ taskId: "A", source: "recent-output", text: big });
    const ctx = useAppStore.getState().terminalContext;
    check(
      "T5 attach 成功 + 限长到 8KB + 镜像字段补齐",
      ok === true &&
        ctx?.source === "recent-output" &&
        ctx.text.length === TERMINAL_CONTEXT_MAX_CHARS &&
        ctx.sessionId === "sA" &&
        ctx.cwd === "C:\\work\\A" &&
        ctx.shell === "pwsh" &&
        ctx.capturedAt > 0,
    );
  }
  {
    resetStore();
    // 切任务 → terminalContext 清理（不跨任务复用）
    useAppStore.setState({
      activeTaskId: "A",
      terminalSessions: {
        A: { taskId: "A", sessionId: "sA", cwd: "C:\\work\\A", shell: "pwsh", alive: true, exitCode: null, exitReason: null, startedAt: 1 },
      },
    });
    useAppStore.getState().attachTerminalContext({ taskId: "A", source: "selection", text: "hi" });
    useAppStore.getState().setActiveTask("B");
    check("T6 切任务 → terminalContext 清空", useAppStore.getState().terminalContext === null);
  }
  {
    resetStore();
    useAppStore.getState().setTerminalSession({
      workspaceId: "ws1",
      sessionId: "sW",
      cwd: "C:\\Users\\servi\\Desktop\\mybuddy",
      shell: "pwsh",
      alive: true,
      exitCode: null,
      exitReason: null,
      startedAt: 1,
    });
    const key = useAppStore.getState().terminalSessions["ws1"];
    check("T7 空间终端会话按 workspaceId 镜像", key?.sessionId === "sW" && key?.cwd.includes("mybuddy"));
    useAppStore.getState().applyTerminalExit({
      workspaceId: "ws1",
      sessionId: "sW",
      exitCode: 0,
      reason: "exit",
    });
    const after = useAppStore.getState().terminalSessions["ws1"];
    check("T8 空间终端 exit 更新 workspace 镜像", after?.alive === false && after?.exitCode === 0);
    const ok = useAppStore.getState().attachTerminalContext({
      taskId: "t-chat",
      workspaceId: "ws1",
      source: "selection",
      text: "pwd",
    });
    const ctx = useAppStore.getState().terminalContext;
    check(
      "T9 空间终端加入对话：按 workspaceId 取会话，taskId 写入上下文",
      ok === true && ctx?.taskId === "t-chat" && ctx.sessionId === "sW" && ctx.cwd.includes("mybuddy"),
    );
  }

  const failed = results.filter(([, pass]) => !pass);
  console.log(`\n${"-".repeat(72)}`);
  console.log(`terminal-store: ${results.length - failed.length}/${results.length} PASS`);
  if (failed.length > 0) {
    for (const [name, , detail] of failed) console.error(`FAILED: ${name} — ${detail}`);
    process.exitCode = 1;
  }
}

void main();
