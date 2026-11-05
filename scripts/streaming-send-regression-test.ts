import assert from "node:assert/strict";
import {
  activateNextAssistantTurn,
  acquirePromptSubmission,
  invalidatePendingPromptQueue,
  queueAssistantTurn,
  type SessionEntry,
} from "../src/main/agent/SessionRegistry";
import { taskHasActiveExecution } from "../src/renderer/src/utils/taskFilters";
import {
  resolveStreamingSendPlan,
  type StreamingSendIntent,
} from "../src/renderer/src/utils/streamingSend";
import type { Task } from "../src/renderer/src/types";

/**
 * 意图真值表（方案 4.3 单一决策 `resolveStreamingSendPlan`）：
 * 引导（steer）必须「不 abort、直接入队」；只有「打断执行」（interrupt）才 abort。
 */
function assertPlan(
  executing: boolean,
  intent: StreamingSendIntent,
  expected: { abortBeforeSend: boolean; behavior?: "steer" | "followUp" },
): void {
  const actual = resolveStreamingSendPlan(executing, intent);
  assert.deepEqual(
    { abortBeforeSend: actual.abortBeforeSend, behavior: actual.behavior ?? undefined },
    { abortBeforeSend: expected.abortBeforeSend, behavior: expected.behavior },
    `intent=${intent} executing=${executing}`,
  );
}

async function main(): Promise<void> {
  // 意图真值表：idle（含草稿态）一律不 abort、无 behavior。
  assertPlan(false, "continue", { abortBeforeSend: false });
  assertPlan(false, "steer", { abortBeforeSend: false });
  assertPlan(false, "interrupt", { abortBeforeSend: false });
  // 运行中：continue→followUp 排队；steer→不 abort、入队 steer；interrupt→仅 abort。
  assertPlan(true, "continue", { abortBeforeSend: false, behavior: "followUp" });
  assertPlan(true, "steer", { abortBeforeSend: false, behavior: "steer" });
  assertPlan(true, "interrupt", { abortBeforeSend: true });

// 旧主进程在热更新期间可能暂时返回 undefined；有 streamingBehavior 时必须按入队处理，
// 不能把 undefined 当普通 prompt 完成并提前结束 UI。
function wasQueued(result: { queued: boolean } | undefined, streamingBehavior: string): boolean {
  return result?.queued ?? Boolean(streamingBehavior);
}
assert.equal(wasQueued(undefined, "steer"), true);

const routing = {
  assistantMessageId: "assistant-current",
  executionId: "execution-current",
  startedAt: 100,
  pendingAssistantTurns: [],
} as Pick<SessionEntry, "assistantMessageId" | "executionId" | "startedAt" | "pendingAssistantTurns">;
queueAssistantTurn(routing, "assistant-steer-old", 140, "steer", "execution-steer-old");
queueAssistantTurn(routing, "assistant-follow-up", 145, "followUp", "execution-follow-up");
queueAssistantTurn(routing, "assistant-steer", 150, "steer", "execution-steer");
assert.equal(routing.assistantMessageId, "assistant-current", "入队不能覆盖当前事件目标");
assert.equal(activateNextAssistantTurn(routing, 175)?.messageId, "assistant-steer-old", "native queue preserves older steer input");
assert.deepEqual(activateNextAssistantTurn(routing, 200), {
  previousMessageId: "assistant-steer-old",
  previousExecutionId: "execution-steer-old",
  previousStartedAt: 175,
  messageId: "assistant-steer",
  executionId: "execution-steer",
});
assert.equal(routing.assistantMessageId, "assistant-steer", "queued user 真正开始后才切换目标");
assert.equal(routing.executionId, "execution-steer", "queued user 激活时必须同步切换 execution scope");
assert.deepEqual(
  activateNextAssistantTurn(routing, 250)?.messageId,
  "assistant-follow-up",
  "steer 应在已排队的 follow-up 之前执行",
);

const submissionState = { promptSubmissionTail: Promise.resolve() };
const releaseFirst = await acquirePromptSubmission(submissionState);
let secondAcquired = false;
const second = acquirePromptSubmission(submissionState).then((release) => {
  secondAcquired = true;
  release();
});
await Promise.resolve();
assert.equal(secondAcquired, false, "并发 steer 不能同时进入 SDK 入队阶段");
releaseFirst();
await second;
assert.equal(secondAcquired, true);

const invalidationState = {
  promptQueueEpoch: 3,
  pendingAssistantTurns: [
    { messageId: "stale-follow-up", executionId: "stale-execution", queuedAt: 1, behavior: "followUp" as const },
  ],
};
invalidatePendingPromptQueue(invalidationState);
assert.equal(invalidationState.promptQueueEpoch, 4);
assert.deepEqual(invalidationState.pendingAssistantTurns, []);

const staleCompletedTask = {
  id: "task-1",
  title: "竞态回归",
  updatedAt: Date.now(),
  status: "completed",
  messages: [
    {
      id: "assistant-steer",
      role: "assistant",
      createdAt: Date.now(),
      blocks: [],
      streaming: true,
    },
  ],
} satisfies Task;
assert.equal(
  taskHasActiveExecution(staleCompletedTask),
  true,
  "消息仍 streaming 时，陈旧 completed 状态不能隐藏停止按钮",
);

console.log("streaming send regression: ok");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
