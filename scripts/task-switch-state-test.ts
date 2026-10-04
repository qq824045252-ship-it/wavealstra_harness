import assert from "node:assert/strict";
import {
  clearAllTaskComposerDrafts,
  composerDraftScope,
  emptyTaskComposerDraft,
  loadTaskComposerDraft,
  saveTaskComposerDraft,
} from "../src/renderer/src/lib/taskComposerDraft";
import { minimalTask, prepareTestEnv } from "./test-store-harness";
import { useAppStore } from "../src/renderer/src/store/appStore";

const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

async function main(): Promise<void> {
  prepareTestEnv();

  clearAllTaskComposerDrafts();
  const scopeA = composerDraftScope("chat", "task-a");
  const scopeB = composerDraftScope("chat", "task-b");
  saveTaskComposerDraft(scopeA, {
    ...emptyTaskComposerDraft(),
    text: "A 未发送内容",
    attachments: [{ name: "a.txt", path: "C:\\tmp\\a.txt" }],
  });
  saveTaskComposerDraft(scopeB, {
    ...emptyTaskComposerDraft(),
    text: "B 未发送内容",
  });
  assert.equal(loadTaskComposerDraft(scopeA).text, "A 未发送内容");
  assert.equal(loadTaskComposerDraft(scopeA).attachments[0]?.name, "a.txt");
  assert.equal(loadTaskComposerDraft(scopeB).text, "B 未发送内容");

  const historyResolvers = new Map<string, (value: unknown) => void>();
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const api = (globalThis as any).window.api;
  api.agent.loadTaskHistory = (taskId: string) =>
    new Promise((resolve) => historyResolvers.set(taskId, resolve));
  api.agent.getContextUsage = async () => undefined;
  api.conversationRuntime = {
    snapshot: async () => ({ todos: [], interactions: [], activeGoal: null }),
  };
  api.artifactDomain = {
    snapshot: async ({ taskId }: { taskId: string }) => ({
      taskId,
      artifacts: [
        {
          id: `artifact-${taskId}`,
          taskId,
          title: `${taskId}.txt`,
          kind: "code",
          version: 1,
          createdAt: 1,
          updatedAt: 1,
          source: { type: "managed-content" },
        },
      ],
      revision: 1,
      state: "ready",
    }),
  };

  useAppStore.setState({
    tasks: [
      { ...minimalTask("task-a"), sessionFile: "a.jsonl" },
      { ...minimalTask("task-b"), sessionFile: "b.jsonl" },
    ],
    activeTaskId: null,
    artifactProjection: {
      artifactsByTask: {},
      artifactRevisions: {},
      artifactLoadState: {},
    },
    artifactTabs: [],
    activeArtifactId: null,
  });

  useAppStore.getState().setActiveTask("task-a");
  useAppStore.getState().setActiveTask("task-b");
  await tick();
  assert.deepEqual(useAppStore.getState().artifactTabs, ["artifact-task-b"]);

  historyResolvers.get("task-a")?.({
    sessionFile: "a.jsonl",
    messages: [{ id: "a-user", role: "user", text: "A 历史", createdAt: 1 }],
  });
  await tick();
  assert.equal(
    useAppStore.getState().tasks.find((task) => task.id === "task-a")?.messages[0]?.id,
    "a-user",
    "切到 B 后，A 已返回的历史仍应按 taskId 写回 A",
  );
  assert.equal(useAppStore.getState().activeTaskId, "task-b");
  assert.deepEqual(
    useAppStore.getState().artifactTabs,
    ["artifact-task-b"],
    "A 的异步恢复不得覆盖 B 的文件页签",
  );

  historyResolvers.get("task-b")?.({
    sessionFile: "b.jsonl",
    messages: [{ id: "b-user", role: "user", text: "B 历史", createdAt: 2 }],
  });
  await tick();
  useAppStore.getState().setActiveTask("task-a");
  assert.equal(useAppStore.getState().tasks.find((task) => task.id === "task-a")?.messages.length, 1);
  assert.deepEqual(useAppStore.getState().artifactTabs, ["artifact-task-a"]);

  console.log("task-switch-state-test: all assertions passed");
}

void main();
