/**
 * external-write-ui-test — 外部写入授权 renderer store 层闭环测试（纯 node，mock window.api）。
 *
 * 覆盖（收尾需求 #5）：
 *   U1  listTaskWriteGrants：有激活任务时返回主进程行
 *   U2  listTaskWriteGrants：无激活任务 → []
 *   U3  revoke 成功：返回 true，随后 list 不再含该路径（撤销成功 → 列表刷新语义）
 *   U4  revoke 失败（主进程 false）：返回 false，列表保持原样（失败状态可见）
 *   U5  审批 deny 终态：toolCall → denied + output「用户已拒绝」+ 消息结束 + 无 externalWrite 载荷
 *   U6  审批 allow-once 终态：toolCall → running，approveTool 载荷 { scope: "once" }
 *   U7  审批 allow-task-dir 终态：toolCall → running，approveTool 载荷 { scope: "task-dir", path }
 *   U8  已结束授权的工具卡不再处于 pending_approval（终态覆盖，不残留转圈）
 *
 * 运行：pnpm test:external-write-ui
 */
import assert from "node:assert/strict";
import { useAppStore } from "../src/renderer/src/store/appStore";
import type { Task, ToolCall, ChatMessage } from "../src/renderer/src/types";
import type { TaskWriteGrantRow } from "../src/shared/external-write";
import type { AgentApproveToolRequest } from "../src/shared/agent-ipc";

let passed = 0;
function ok(cond: unknown, label: string): void {
  assert.ok(cond, label);
  passed += 1;
}

// ---------- mock window.api（db 授权行 + agent.approveTool 捕获） ----------
let grantRows: TaskWriteGrantRow[] = [];
let revokeShouldFail = false;
let approveCalls: AgentApproveToolRequest[] = [];

(globalThis as unknown as { window: unknown }).window = {
  api: {
    db: {
      listTaskWriteGrants: async (): Promise<TaskWriteGrantRow[]> => grantRows,
      deleteTaskWriteGrant: async (_taskId: string, path: string): Promise<boolean> => {
        if (revokeShouldFail) return false;
        grantRows = grantRows.filter((g) => g.path !== path);
        return true;
      },
    },
    agent: {
      approveTool: async (req: AgentApproveToolRequest): Promise<boolean> => {
        approveCalls.push(req);
        return true;
      },
    },
  },
};

const TASK_ID = "task-ui-1";
const MSG_ID = "msg-1";
const TC_ID = "tc-1";

function makeExternalToolCall(): ToolCall {
  return {
    id: TC_ID,
    tool: "write",
    summary: "写入：C:\\outside\\out.md",
    status: "pending_approval",
    dangerous: true,
    approvalKind: "external-write",
    targetPath: "C:\\outside\\out.md",
    taskRoot: "C:\\task-root",
    canonicalDir: "C:\\outside",
  };
}

function makeTask(): Task {
  const msg: ChatMessage = {
    id: MSG_ID,
    role: "assistant",
    createdAt: 0,
    blocks: [{ type: "tool", toolCall: makeExternalToolCall() }],
    finalBlocks: [],
    streaming: true,
  };
  return { id: TASK_ID, title: "t", updatedAt: 0, messages: [msg] } as Task;
}

function resetStore(): void {
  approveCalls = [];
  useAppStore.setState({ tasks: [makeTask()], activeTaskId: TASK_ID });
}

function currentToolCall(): ToolCall {
  const task = useAppStore.getState().tasks.find((t) => t.id === TASK_ID)!;
  const msg = task.messages.find((m) => m.id === MSG_ID)!;
  const block = msg.blocks.find((b) => b.type === "tool")!;
  return (block as { toolCall: ToolCall }).toolCall;
}

function currentMessage(): ChatMessage {
  return useAppStore.getState().tasks.find((t) => t.id === TASK_ID)!.messages.find(
    (m) => m.id === MSG_ID,
  )!;
}

async function main(): Promise<void> {
  // U1/U2 列表加载
  resetStore();
  grantRows = [
    { taskId: TASK_ID, path: "C:\\outside", createdAt: 1_700_000_000_000 },
    { taskId: TASK_ID, path: "C:\\other", createdAt: 1_700_000_100_000 },
  ];
  const rows = await useAppStore.getState().listTaskWriteGrants();
  ok(rows.length === 2 && rows[0]!.path === "C:\\outside", "U1 有激活任务时返回已授权目录行");
  useAppStore.setState({ activeTaskId: null });
  const noRows = await useAppStore.getState().listTaskWriteGrants();
  ok(noRows.length === 0, "U2 无激活任务 → 空列表");

  // U3 撤销成功 → 列表立即不含该路径
  useAppStore.setState({ activeTaskId: TASK_ID });
  const revoked = await useAppStore.getState().revokeTaskWriteGrant("C:\\outside");
  ok(revoked === true, "U3a 撤销成功返回 true");
  const afterRevoke = await useAppStore.getState().listTaskWriteGrants();
  ok(afterRevoke.length === 1 && afterRevoke[0]!.path === "C:\\other", "U3b 撤销后列表刷新（不再含已撤销路径）");

  // U4 撤销失败 → false，列表保持原样
  revokeShouldFail = true;
  const failed = await useAppStore.getState().revokeTaskWriteGrant("C:\\other");
  ok(failed === false, "U4a 主进程撤销失败返回 false（UI 显示可理解错误）");
  const afterFail = await useAppStore.getState().listTaskWriteGrants();
  ok(afterFail.length === 1 && afterFail[0]!.path === "C:\\other", "U4b 失败后列表保持原样");
  revokeShouldFail = false;
  grantRows = [];

  // U5 deny 终态
  resetStore();
  useAppStore.getState().resolveToolApproval(MSG_ID, TC_ID, false);
  let tc = currentToolCall();
  let msg = currentMessage();
  ok(tc.status === "denied", "U5a 拒绝 → 终态 denied");
  ok(tc.output === "用户已拒绝", "U5b 拒绝原因写入卡片");
  ok(msg.streaming === false, "U5c 拒绝后消息结束（不残留转圈）");
  ok(
    msg.finalBlocks?.some((b) => b.type === "text" && b.text === "好的，已取消该操作。"),
    "U5d 拒绝后追加可理解收尾文本",
  );
  ok(
    approveCalls.length === 1 && approveCalls[0]!.approved === false && !approveCalls[0]!.externalWrite,
    "U5e 拒绝载荷无 externalWrite 决策",
  );

  // U6 allow-once 终态
  resetStore();
  useAppStore.getState().resolveToolApproval(MSG_ID, TC_ID, true, { scope: "once" });
  tc = currentToolCall();
  ok(tc.status === "running", "U6a 允许一次 → running（随后工具真实执行并结束）");
  ok(
    approveCalls.length === 1 &&
      approveCalls[0]!.approved === true &&
      approveCalls[0]!.externalWrite?.scope === "once",
    "U6b 载荷携带 once 决策",
  );

  // U7 allow-task-dir 终态
  resetStore();
  useAppStore.getState().resolveToolApproval(MSG_ID, TC_ID, true, {
    scope: "task-dir",
    path: "C:\\outside",
  });
  tc = currentToolCall();
  ok(tc.status === "running", "U7a 始终允许此文件夹 → running");
  ok(
    approveCalls.length === 1 &&
      approveCalls[0]!.externalWrite?.scope === "task-dir" &&
      approveCalls[0]!.externalWrite?.path === "C:\\outside",
    "U7b 载荷携带 task-dir + canonical 路径（主进程 canonicalize 后持久化）",
  );

  // U8 三态后均不再是 pending_approval（刷新/重载不把已结束授权显示为 pending）
  resetStore();
  useAppStore.getState().resolveToolApproval(MSG_ID, TC_ID, false);
  ok(currentToolCall().status !== "pending_approval", "U8a deny 后不再 pending");
  resetStore();
  useAppStore.getState().resolveToolApproval(MSG_ID, TC_ID, true, { scope: "once" });
  ok(currentToolCall().status !== "pending_approval", "U8b allow-once 后不再 pending");
  resetStore();
  useAppStore.getState().resolveToolApproval(MSG_ID, TC_ID, true, {
    scope: "task-dir",
    path: "C:\\outside",
  });
  ok(currentToolCall().status !== "pending_approval", "U8c allow-task-dir 后不再 pending");

  console.log(`[external-write-ui-test] passed=${passed} failed=0`);
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
