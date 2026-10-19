/**
 * 桌面端「看得见手机发起的 ACP 轮次」回归测试。
 *
 * 背景（真机复现的问题）：手机上发起 ACP 委托时，桌面端如果没打开过该任务，
 * 它没有这一轮的 user/assistant 消息；而 ACP 事件只有增量 patch，渲染层
 * （applyAgentPatch / applyAgentDeltaBatch）只更新「已存在」的消息，于是所有事件被静默丢弃，
 * 用户看到「手机上已经回复，电脑上什么都没有」。
 *
 * 本用例验证修复行为：
 *  1. 任务里没有 ACP 消息时，hydrateExternalAgentHistory 会把 user + assistant 补进 store
 *  2. 补齐后 assistant 带 externalAgent 归属、正文/工具块正确、按 createdAt 排序
 *  3. 已有的消息不会被覆盖或重复（增量补历史只补缺失项）
 *  4. 2 秒内的事件风暴只触发一次 loadTaskHistory（去抖）
 *  5. 拿不到 history 时不抛错、不产生假消息
 */
import assert from "node:assert/strict";
import { minimalTask, prepareTestEnv } from "./test-store-harness";
import { historyMessageToChatMessage, hydrateExternalAgentHistory, useAppStore } from "../src/renderer/src/store/appStore";

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async (): Promise<void> => { for (let i = 0; i < 5; i += 1) await tick(); };

let passed = 0;
function ok(label: string): void { passed += 1; console.log(`  ✓ ${label}`); }

async function main(): Promise<void> {
  prepareTestEnv();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const api = (globalThis as any).window.api;

  let historyCalls = 0;
  let historyPayload: unknown = null;
  api.agent.loadTaskHistory = async (taskId: string) => {
    historyCalls += 1;
    return historyPayload ?? { taskId, messages: [] };
  };

  const seed = (taskId: string, messages: unknown[] = []): void => {
    useAppStore.setState((state) => ({
      tasks: [{ ...minimalTask(taskId, "手机 ACP 任务"), messages } as never, ...state.tasks.filter((t) => t.id !== taskId)],
    }));
  };
  const taskOf = (taskId: string) => useAppStore.getState().tasks.find((task) => task.id === taskId);

  // ---------- 1/2. 未知 ACP 轮次 → 补历史，消息与投影正确 ----------
  historyPayload = {
    taskId: "t-acp",
    messages: [
      { id: "acp-u1", role: "user", text: "在手机上发起的指令", createdAt: 100, attachments: [{ name: "shot.png" }] },
      {
        id: "acp-a1", role: "assistant", text: "手机上看到的回复", createdAt: 101,
        thinking: "先看看工作目录", tools: [{ id: "tc-1", tool: "execute", summary: "echo hi", status: "success" }],
        externalAgent: {
          id: "opencode", name: "OpenCode", protocol: "acp", runId: "run-1",
          sessionReady: true, resumeSupported: true, recoveryState: "none",
          verificationStatus: "workspace_observed", outputCursor: 42,
        },
      },
    ],
  };
  seed("t-acp");
  historyCalls = 0;
  hydrateExternalAgentHistory("t-acp");
  await settle();
  const task = taskOf("t-acp")!;
  assert.equal(historyCalls, 1, "未知 ACP 轮次必须补一次 history");
  assert.deepEqual(task.messages.map((m) => m.id), ["acp-u1", "acp-a1"], "user 与 assistant 都要落进 store");
  const assistant = task.messages[1]!;
  assert.equal(assistant.externalAgent?.name, "OpenCode", "必须保留 ACP 归属，避免 UI 把外部 Agent 标成 MyBuddy");
  assert.equal(assistant.externalAgent?.verificationStatus, "workspace_observed");
  assert.deepEqual(assistant.finalBlocks?.map((b) => (b.type === "text" ? b.text : "")), ["手机上看到的回复"]);
  assert.ok(assistant.blocks.some((b) => b.type === "thinking"), "thinking 段必须保留");
  assert.ok(assistant.blocks.some((b) => b.type === "tool" && b.toolCall.id === "tc-1"), "工具段必须保留");
  assert.equal(task.messages[0]!.blocks[0]?.type, "text");
  ok("补历史把手机发起的 ACP 轮次完整投影进桌面端");

  // ---------- 3. 只补缺失项，不覆盖已有消息 ----------
  historyPayload = {
    taskId: "t-acp",
    messages: [
      { id: "acp-u1", role: "user", text: "在手机上发起的指令", createdAt: 100 },
      { id: "acp-a1", role: "assistant", text: "手机上看到的回复", createdAt: 101 },
      { id: "acp-u2", role: "user", text: "第二轮", createdAt: 200 },
      { id: "acp-a2", role: "assistant", text: "第二轮回复", createdAt: 201 },
    ],
  };
  useAppStore.setState((state) => ({
    tasks: state.tasks.map((t) => t.id === "t-acp"
      ? { ...t, messages: t.messages.map((m) => m.id === "acp-a1" ? { ...m, blocks: [{ type: "text" as const, text: "本地已渲染的更完整内容" }] } : m) }
      : t),
  }));
  await new Promise((resolve) => setTimeout(resolve, 2100));
  hydrateExternalAgentHistory("t-acp");
  await settle();
  const merged = taskOf("t-acp")!;
  assert.deepEqual(merged.messages.map((m) => m.id), ["acp-u1", "acp-a1", "acp-u2", "acp-a2"], "只追加缺失消息，不重复");
  assert.equal(
    merged.messages.find((m) => m.id === "acp-a1")!.blocks[0]?.type === "text"
      ? (merged.messages.find((m) => m.id === "acp-a1")!.blocks[0] as { text: string }).text
      : "",
    "本地已渲染的更完整内容",
    "已存在的消息不得被历史快照覆盖",
  );
  ok("补历史只追加缺失项（不覆盖、不重复）");

  // ---------- 4. 去抖：事件风暴只拉一次 ----------
  seed("t-storm");
  historyPayload = { taskId: "t-storm", messages: [] };
  historyCalls = 0;
  for (let i = 0; i < 12; i += 1) hydrateExternalAgentHistory("t-storm");
  await settle();
  assert.equal(historyCalls, 1, "同一任务的连续事件必须去抖成一次 loadTaskHistory");
  ok("事件风暴去抖");

  // ---------- 5. 失败不抛错、不造假消息 ----------
  seed("t-fail");
  api.agent.loadTaskHistory = async () => { throw new Error("ipc down"); };
  await new Promise((resolve) => setTimeout(resolve, 2100));
  hydrateExternalAgentHistory("t-fail");
  await settle();
  assert.deepEqual(taskOf("t-fail")!.messages, [], "历史拉取失败时不得塞入假消息");
  ok("历史拉取失败安全降级");

  // ---------- 6. 纯映射函数：assistant 无正文时不产生空 finalBlocks ----------
  const empty = historyMessageToChatMessage({ id: "x", role: "assistant", text: "", createdAt: 1 } as never);
  assert.equal(empty.finalBlocks, undefined, "空正文不得生成空白 finalBlocks（否则气泡会空占位）");
  assert.equal(empty.streaming, false);
  ok("historyMessageToChatMessage 边界正确");

  console.log(`\ndesktop ACP hydration: PASS (${passed} checks)`);
}

main().catch((error) => { console.error(error); process.exit(1); });
