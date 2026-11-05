/**
 * conversation-branch-ui-test.ts — 对话分支 Renderer 契约测试（实施规划 §13.5）。
 *
 * 覆盖：flag 门控 / 双点击去重（单 requestId）/ 成功后插入并切换到 child /
 * 失败错误态 / 血缘刷新（来源 chip 数据）/ 错误不跨任务污染。
 *
 * 运行：pnpm test:conversation-branch-ui
 */
import assert from "node:assert/strict";
import { prepareTestEnv } from "./test-store-harness";
import { useAppStore } from "../src/renderer/src/store/appStore";
import type { ConversationBranchCreateOutcome } from "../src/shared/conversation-branch";

let passed = 0;
let failed = 0;
function assertOk(cond: boolean, label: string): void {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
}

/** fake conversationBranch IPC：可编程化响应，记录收到的请求 */
function installBranchApi(): {
  requests: Array<Record<string, unknown>>;
  resolveNext: (outcome: ConversationBranchCreateOutcome | undefined) => void;
} {
  const g = globalThis as unknown as { window: { api: Record<string, unknown> } };
  const api = g.window.api as Record<string, Record<string, unknown>>;
  const requests: Array<Record<string, unknown>> = [];
  let pendingResolve: ((o: ConversationBranchCreateOutcome | undefined) => void) | null = null;
  api.conversationBranch = {
    create: (req: Record<string, unknown>) => {
      requests.push(req);
      return new Promise<ConversationBranchCreateOutcome | undefined>((resolve) => {
        pendingResolve = resolve;
      });
    },
    preview: async () => ({ ok: true, strategy: "current_snapshot" }),
    getInfo: async () => undefined,
    listChildren: async () => [],
  };
  return {
    requests,
    resolveNext: (outcome) => {
      pendingResolve?.(outcome);
      pendingResolve = null;
    },
  };
}

function flush(): Promise<void> {
  return new Promise((r) => setImmediate(r));
}

function makeTask(id: string, title: string): ReturnType<typeof useAppStore.getState>["tasks"][number] {
  return {
    id,
    title,
    updatedAt: Date.now(),
    status: "completed",
    spaceId: undefined,
    projectId: undefined,
    messages: [
      { id: "u1", role: "user", createdAt: 1, blocks: [{ type: "text", text: "问" }], entryId: "entry-u1" },
      { id: "a1", role: "assistant", createdAt: 2, blocks: [], finalBlocks: [{ type: "text", text: "答" }], entryId: "entry-a1" },
    ],
  };
}

const CHILD_TASKDTO = {
  id: "task-child",
  title: "任务A（分支）",
  status: "completed",
  updatedAt: Date.now(),
  sessionFile: "/tmp/child.jsonl",
  cwd: "/tmp/child-work",
  welcomeMode: "coding" as const,
  permissionMode: "default" as const,
  expertId: undefined,
  modePresetId: undefined,
  startAt: undefined,
  dueAt: undefined,
  spaceSortOrder: 0,
  isFavorited: false,
} as const;

const okOutcome: ConversationBranchCreateOutcome = {
  ok: true,
  result: {
    task: { ...CHILD_TASKDTO },
    branch: {
      childTaskId: "task-child",
      parentTaskId: "task-a",
      rootTaskId: "task-a",
      parentTitle: "任务A",
      sourceUserMessageIndex: 0,
      sourcePosition: "after_user",
      workspaceStrategy: "current_snapshot",
      createdAt: Date.now(),
      parentExists: true,
    },
    warnings: ["已创建对话分支；独立文件目录复制自当前状态。"],
    inheritedArtifactCount: 0,
    skippedArtifactCount: 0,
  },
};

async function main(): Promise<void> {
  prepareTestEnv();
  const { requests, resolveNext } = installBranchApi();

  // ===== 1. flag 关闭：create 直接拒绝（菜单隐藏由组件层负责） =====
  useAppStore.setState({
    tasks: [makeTask("task-a", "任务A")],
    activeTaskId: "task-a",
    conversationBranchEnabled: false,
  });
  const flagOff = await useAppStore.getState().createBranchFromMessage("u1", {
    role: "user",
    entryId: "entry-u1",
  });
  assertOk(flagOff === false, "1. flag 关闭时 createBranchFromMessage 直接返回 false");
  assertOk(requests.length === 0, "1. flag 关闭时不发 IPC 请求");

  // ===== 2. flag 开启 + 成功：插入 child 并切换 =====
  useAppStore.setState({ conversationBranchEnabled: true });
  const p1 = useAppStore.getState().createBranchFromMessage("u1", {
    role: "user",
    entryId: "entry-u1",
  });
  await flush();
  assertOk(requests.length === 1, "2. 发起一次 create 请求");
  assertOk(requests[0].sourceTaskId === "task-a", "2. 请求携带 sourceTaskId");
  assertOk(requests[0].entryId === "entry-u1", "2. 请求携带主锚点 entryId");
  assertOk(requests[0].position === "after_user", "2. 用户消息 → after_user");
  assertOk(requests[0].userMessageIndex === 0, "2. 过滤后 userMessageIndex = 0");
  assertOk(typeof requests[0].requestId === "string" && requests[0].requestId.length > 0, "2. 请求携带 requestId");

  // ===== 3. 双点击去重：pending 期间第二次调用不发第二个请求 =====
  assertOk(useAppStore.getState().branchCreatingTaskId === "task-a", "3. 请求期间 branchCreatingTaskId 置位");
  const second = await useAppStore.getState().createBranchFromMessage("a1", {
    role: "assistant",
    entryId: "entry-a1",
  });
  assertOk(second === false, "3. pending 期间第二次点击直接返回 false");
  assertOk(requests.length === 1, "3. 未产生第二个 IPC 请求");

  // ===== 4. 成功后：插入 child、切换 activeTaskId =====
  resolveNext(okOutcome);
  const ok4 = await p1;
  assertOk(ok4 === true, "4. 创建成功返回 true");
  const s4 = useAppStore.getState();
  assertOk(s4.activeTaskId === "task-child", "4. 切换到 child");
  assertOk(
    s4.tasks.some((t) => t.id === "task-child" && t.title === "任务A（分支）"),
    "4. child 已插入任务列表",
  );
  assertOk(s4.branchCreatingTaskId === null, "4. loading 状态清除");
  const child = s4.tasks.find((t) => t.id === "task-child");
  assertOk(child?.sessionFile === "/tmp/child.jsonl" && child?.cwd === "/tmp/child-work", "4. session/cwd 存入 task 行");
  assertOk(s4.branchSource === null || s4.branchSource === undefined, "4. 无来源任务时不显示来源 chip");

  // The real child hydrates asynchronously from Pi; model that history before clicking.
  useAppStore.setState((s) => ({ tasks: s.tasks.map((t) => t.id === "task-child" ? { ...t, messages: makeTask(t.id, t.title).messages } : t) }));

  // ===== 5. 失败：branchError 显示且不切换任务 =====
  const p5 = useAppStore.getState().createBranchFromMessage("u1", {
    role: "user",
    entryId: "entry-u1",
  });
  await flush();
  assertOk(requests.length === 2, "5. 再次发起请求");
  resolveNext({ ok: false, code: "ANCHOR_NOT_FOUND", message: "所选消息已不存在，请刷新后重试。" });
  const ok5 = await p5;
  assertOk(ok5 === false, "5. 失败返回 false");
  const s5 = useAppStore.getState();
  assertOk(s5.activeTaskId === "task-child", "5. 失败不切换任务");
  assertOk(
    s5.branchError?.taskId === "task-child" && s5.branchError.message.includes("所选消息"),
    "5. 错误信息可读且归属当前任务",
  );
  assertOk(s5.branchCreatingTaskId === null, "5. 失败后 loading 清除");

  // ===== 6. 错误可清除；不跨任务展示由 ChatView 按 taskId 过滤 =====
  useAppStore.getState().clearBranchError();
  assertOk(useAppStore.getState().branchError === null, "6. clearBranchError 清除");

  // ===== 7. 血缘刷新：getInfo/listChildren 落 store =====
  const g = globalThis as unknown as { window: { api: Record<string, unknown> } };
  const api = g.window.api as Record<string, Record<string, unknown>>;
  api.conversationBranch.getInfo = async (taskId: string) =>
    taskId === "task-child"
      ? {
          childTaskId: "task-child",
          parentTaskId: "task-a",
          rootTaskId: "task-a",
          parentTitle: "任务A",
          sourceUserMessageIndex: 0,
          sourcePosition: "after_reply",
          workspaceStrategy: "current_snapshot",
          createdAt: Date.now(),
          parentExists: true,
        }
      : undefined;
  api.conversationBranch.listChildren = async (taskId: string) =>
    taskId === "task-a"
      ? [{ childTaskId: "task-child", parentTaskId: "task-a", rootTaskId: "task-a", parentTitle: "任务A", sourceUserMessageIndex: 0, sourcePosition: "after_user", workspaceStrategy: "current_snapshot", createdAt: Date.now(), parentExists: true }]
      : [];
  useAppStore.getState().refreshBranchLineage("task-child");
  await flush();
  const s7 = useAppStore.getState();
  assertOk(s7.branchSource?.parentTitle === "任务A" && s7.branchSource.parentExists === true, "7. 来源信息已刷新");
  assertOk(Array.isArray(s7.branchChildren), "7. 子分支列表已刷新");
  // 父存在时 chip 可切回 parent：验证 setActiveTask 目标可用（task-a 已在 tasks）
  useAppStore.getState().setActiveTask("task-a");
  assertOk(useAppStore.getState().activeTaskId === "task-a", "7. 来源 chip 可回到 parent");

  // ===== 8. 删除分支任务后，父任务「查看分支（N）」刷新（主进程 CASCADE 后列表为空） =====
  api.conversationBranch.listChildren = async () => []; // 模拟 DB 级联删除后的主进程返回
  api.db.deleteTask = async () => undefined;
  useAppStore.getState().deleteTask("task-child");
  await flush();
  const s8 = useAppStore.getState();
  assertOk(
    !s8.tasks.some((t) => t.id === "task-child"),
    "8. child 已从任务列表删除",
  );
  assertOk(
    s8.branchChildren.length === 0,
    `8. 删除 child 后父任务分支列表已刷新（实际 ${s8.branchChildren.length}）`,
  );

  // Live assistant bubbles may not yet carry a persisted entryId.
  useAppStore.setState({ tasks: [makeTask("task-live", "Live")], activeTaskId: "task-live", conversationBranchEnabled: true });
  const beforeCount = requests.length;
  const p9 = useAppStore.getState().createBranchFromMessage("a1", { role: "assistant" });
  await flush();
  assertOk(requests.length === beforeCount + 1, "9. live assistant fallback sends one request");
  assertOk(requests.at(-1)?.userMessageIndex === 0, "9. assistant fallback refers to its own user, not the next turn");
  assertOk(requests.at(-1)?.position === "after_reply", "9. assistant fallback retains after_reply semantics");
  resolveNext({ ok: false, code: "INVALID_REQUEST", message: "分支位置无效。" });
  await p9;
  const bad = await useAppStore.getState().createBranchFromMessage("missing-message", { role: "user" });
  assertOk(!bad && requests.length === beforeCount + 1, "9. missing UI message never becomes a last-turn branch");

  // ===== 10. 任务执行中（TASK_BUSY）：自动停止当前运行并重试，不再变成死胡同 =====
  useAppStore.setState({
    tasks: [makeTask("task-busy", "忙碌任务")],
    activeTaskId: "task-busy",
    conversationBranchEnabled: true,
    branchError: null,
  });
  const busyStart = requests.length;
  const p10 = useAppStore.getState().createBranchFromMessage("u1", { role: "user", entryId: "entry-u1" });
  await flush();
  assertOk(requests.length === busyStart + 1, "10. 先发一次 create");
  resolveNext({ ok: false, code: "TASK_BUSY", message: "当前任务仍在运行，请先停止生成后再创建分支。" });
  // abort + 700ms 退避后自动重试
  await new Promise((r) => setTimeout(r, 900));
  assertOk(requests.length === busyStart + 2, "10. TASK_BUSY 后自动重试（不直接失败）");
  assertOk(requests.at(-1)?.requestId === requests.at(-2)?.requestId, "10. 重试沿用同一 requestId（主进程幂等）");
  resolveNext(okOutcome);
  assertOk((await p10) === true, "10. 停止后重试成功创建分支");
  assertOk(useAppStore.getState().branchError === null, "10. 成功路径不残留 branchError");

  console.log(`\nconversation-branch-ui: passed=${passed} failed=${failed}`);
  if (failed > 0) process.exit(1);
}

void main();