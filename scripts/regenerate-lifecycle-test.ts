/**
 * regenerate-lifecycle-test.ts — Problem Three：对话「重新生成」必须两阶段提交。
 *
 * 目标语义（方案 5.3/5.8）：
 * Phase A（点击）：旧消息完整保留，不插空壳，只登记 pending + 源 footer 标 pending。
 * Phase B（assistant_start 到达）：按要求原子截断（源用户消息之后）并插入新回复。
 * IPC 失败：pending 清除、旧回复保留、源消息显示用户可见错误。
 *
 * 运行：pnpm test:regenerate-lifecycle
 */
import assert from "node:assert/strict";
import { prepareTestEnv, minimalTask } from "./test-store-harness";
import { useAppStore } from "../src/renderer/src/store/appStore";
import type { AgentRegenerateResult } from "../src/shared/agent-ipc";

type RegenerateResolver = (r: AgentRegenerateResult | undefined) => void;
let resolveRegenerate: RegenerateResolver | null = null;
let lastRegenerateRequest: { sourceUserEntryId?: string } | undefined;

function setupRegenerateMock(): void {
  const g = globalThis as unknown as { window: { api: Record<string, unknown> } };
  const api = g.window.api as Record<string, Record<string, unknown>>;
  api.agent.regenerate = (request: { sourceUserEntryId?: string }) => {
    lastRegenerateRequest = request;
    return new Promise<AgentRegenerateResult | undefined>((resolve) => {
      resolveRegenerate = resolve;
    });
  };
}

function makeTask(): ReturnType<typeof minimalTask> {
  const t = minimalTask("task-r");
  t.messages = [
    { id: "u1", role: "user", createdAt: 1, blocks: [{ type: "text", text: "问" }], entryId: "old-pi-user" },
    {
      id: "a1",
      role: "assistant",
      createdAt: 2,
      blocks: [],
      finalBlocks: [{ type: "text", text: "答" }],
      streaming: false,
    },
  ];
  return t;
}

/** 提交时模拟主进程 assistant_start 事件。 */
function emitAssistantStart(taskId: string, messageId: string): void {
  useAppStore.getState().applyAgentPatch({
    type: "assistant_start",
    taskId,
    messageId,
    modelName: "mock-model",
  });
}

function flushMicrotasks(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

async function main(): Promise<void> {
  prepareTestEnv();
  setupRegenerateMock();

  // ===== 场景 A：两阶段提交成功 =====
  useAppStore.setState({ tasks: [makeTask()], activeTaskId: "task-r", pendingRegenerations: {} });

  // Phase A 点击：旧回复必须仍在，且不插入空的新消息壳
  useAppStore.getState().regenerateMessage("a1");
  assert.equal(lastRegenerateRequest?.sourceUserEntryId, "old-pi-user", "actual regenerate IPC carries the source Pi entry, not just local pending state");
  const pendingAfterClick = Object.values(useAppStore.getState().pendingRegenerations);
  assert.equal(pendingAfterClick.length, 1, "点击后应登记一条 pending 记录");
  const newMsgId = pendingAfterClick[0].newAssistantMessageId;

  const during = useAppStore.getState().tasks.find((x) => x.id === "task-r")!;
  assert.equal(
    during.messages.some((m) => m.id === "a1"),
    true,
    "Phase A：旧助手回复必须保留到 assistant_start 到达",
  );
  assert.equal(
    during.messages.some((m) => m.id === newMsgId),
    false,
    "Phase A：在 assistant_start 前不得插入空的新回复壳",
  );
  assert.equal(during.messages.length, 2, "Phase A：消息数不变（仍为 user+assistant）");

  // 去重：pending 期间再次点击同一源，不产生第二个请求/记录
  useAppStore.getState().regenerateMessage("a1");
  assert.equal(
    Object.keys(useAppStore.getState().pendingRegenerations).length,
    1,
    "pending 期间再次点击必须去重（仍只有一条 pending）",
  );

  // Phase B：主进程 assistant_start → 原子替换
  emitAssistantStart("task-r", newMsgId);
  await flushMicrotasks();
  const afterCommit = useAppStore.getState().tasks.find((x) => x.id === "task-r")!;
  assert.equal(
    useAppStore.getState().pendingRegenerations[newMsgId] === undefined,
    true,
    "commit 后应删除 pending 记录",
  );
  assert.equal(
    afterCommit.messages.some((m) => m.id === "a1"),
    false,
    "Phase B：commit 后旧回复已被替换",
  );
  const committed = afterCommit.messages.find((m) => m.id === newMsgId);
  assert.ok(committed, "Phase B：新回复壳已插入");
  assert.equal(committed!.streaming, true, "Phase B：新回复处于 streaming 态");
  assert.deepEqual(
    afterCommit.messages.map((m) => m.id),
    ["u1", newMsgId],
    "Phase B：只保留源用户消息 + 新回复（原子截断）",
  );

  // 结算 ok:true（应为 no-op，不破坏已提交状态）
  resolveRegenerate?.({
    ok: true,
    requestId: pendingAfterClick[0].requestId,
    assistantMessageId: newMsgId,
    userEntryId: "new-pi-user",
  });
  await flushMicrotasks();
  assert.equal(useAppStore.getState().tasks.find(t => t.id === "task-r")?.messages[0].entryId, "new-pi-user", "regenerate success refreshes the retained user bubble to the new Pi entry");
  const afterOk = useAppStore.getState().tasks.find((x) => x.id === "task-r")!;
  assert.deepEqual(
    afterOk.messages.map((m) => m.id),
    ["u1", newMsgId],
    "ok:true 后不应再次改消息（两阶段只由 assistant_start 驱动替换）",
  );

  // ===== 场景 B：IPC 明确失败 → 旧消息保留 + 源消息显示错误 =====
  useAppStore.setState({ tasks: [makeTask()], activeTaskId: "task-r", pendingRegenerations: {} });
  useAppStore.getState().regenerateMessage("a1");
  const p2 = Object.values(useAppStore.getState().pendingRegenerations)[0];
  resolveRegenerate?.({
    ok: false,
    requestId: p2.requestId,
    code: "NAVIGATION_CANCELLED",
    message: "重新生成被取消，原回复已保留。",
  });
  await flushMicrotasks();

  const afterFail = useAppStore.getState().tasks.find((x) => x.id === "task-r")!;
  const failedSrc = afterFail.messages.find((m) => m.id === "a1");
  assert.ok(failedSrc, "IPC 失败后旧回复必须完整保留");
  assert.equal(
    failedSrc!.generateError,
    "[NAVIGATION_CANCELLED] 重新生成被取消，原回复已保留。",
    "IPC 失败要把用户可见错误挂到源助手消息上",
  );
  assert.equal(
    afterFail.messages.some((m) => m.id === p2.newAssistantMessageId),
    false,
    "IPC 失败不插入空的新回复壳（不伪造 assistant）",
  );
  assert.equal(
    Object.keys(useAppStore.getState().pendingRegenerations).length,
    0,
    "IPC 失败后 pending 记录应清除",
  );

  // IPC 结束却没有 assistant_start：每次均释放 pending，允许再次尝试。
  for (let attempt = 0; attempt < 3; attempt += 1) {
    useAppStore.getState().regenerateMessage("a1");
    const pending = Object.values(useAppStore.getState().pendingRegenerations);
    assert.equal(pending.length, 1, `第 ${attempt + 1} 次重试必须发起请求`);
    resolveRegenerate?.({
      ok: true,
      requestId: pending[0].requestId,
      assistantMessageId: pending[0].newAssistantMessageId,
    });
    await flushMicrotasks();
    assert.equal(Object.keys(useAppStore.getState().pendingRegenerations).length, 0,
      "没有启动回复的已结束请求不能永久阻止重试");
    const source = useAppStore.getState().tasks[0].messages.find((m) => m.id === "a1");
    assert.deepEqual(source?.finalBlocks, [{ type: "text", text: "答" }]);
    assert.match(source?.generateError ?? "", /未启动/);
  }

  // ===== 场景 C：assistant_start 但源消息已不存在 → 只清 pending，不创建空壳 =====
  useAppStore.setState({ tasks: [makeTask()], activeTaskId: "task-r", pendingRegenerations: {} });
  useAppStore.getState().regenerateMessage("a1");
  const p3 = Object.values(useAppStore.getState().pendingRegenerations)[0];
  // 模拟源消息被外部删除
  useAppStore.setState((s) => ({
    tasks: s.tasks.map((t) =>
      t.id === "task-r" ? { ...t, messages: t.messages.filter((m) => m.id !== "a1") } : t,
    ),
  }));
  emitAssistantStart("task-r", p3.newAssistantMessageId);
  await flushMicrotasks();
  assert.equal(
    Object.keys(useAppStore.getState().pendingRegenerations).length,
    0,
    "assistant_start 时源消息不存在 → 清 pending，不残留空壳",
  );

  console.log("regenerate lifecycle: ok");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
