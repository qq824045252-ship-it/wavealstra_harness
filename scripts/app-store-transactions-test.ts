import assert from "node:assert/strict";
import { createAppStore } from "../src/renderer/src/store/app/createAppStore";
import type { AppContext } from "../src/renderer/src/store/app/context";
import type { AppState } from "../src/renderer/src/store/app/types";
import type { Task } from "../src/renderer/src/types";
import type { ArtifactDescriptor } from "../src/shared/artifact-types";
import type { DurableBotSnapshot } from "../src/shared/durable-bot";
import { durableDelta } from "../shared/src/durable-sync";
import type { TaskHistoryDto } from "../src/shared/agent-ipc";
import { loadRuntimeBootstrap } from "../src/renderer/src/store/app/runtime/bootstrap";
import { mapTaskRowToTask } from "../src/renderer/src/store/app/tasks/taskMapper";
import { recomputeEffectiveArchived } from "../src/renderer/src/store/app/workspaces/spaceHelpers";
import { EMPTY_SOUL } from "../src/renderer/src/store/app/defaults";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
}

function store(api: object = {}) {
  return createAppStore({
    getApi: () => api as ReturnType<AppContext["getApi"]>,
  });
}

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: id,
    updatedAt: 1,
    status: "in_progress",
    messages: [
      {
        id: `${id}-answer`,
        role: "assistant",
        createdAt: 1,
        blocks: [],
        streaming: true,
      },
    ],
    ...overrides,
  };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

async function activationIsAtomicAndLateReadsStayWithTheirOwner(): Promise<void> {
  const historyA = deferred<{
    messages: Array<{
      id: string;
      role: "user";
      text: string;
      createdAt: number;
    }>;
  }>();
  const usageA = deferred<{ usedTokens: number; contextWindow: number }>();
  const usageB = deferred<{ usedTokens: number; contextWindow: number }>();
  const app = store({
    agent: {
      getContextUsage: (id: string) =>
        id === "a" ? usageA.promise : usageB.promise,
      loadTaskHistory: () => historyA.promise,
    },
  });
  const { useAppStore: api } = app;
  api.setState({
    tasks: [
      task("a", { messages: [] }),
      task("b", {
        spaceId: "space-b",
        modelId: "model-b",
        modelExplicit: true,
        permissionMode: "auto",
        permissionExplicit: true,
        welcomeMode: "coding",
        connectorIds: ["connector-b"],
      }),
    ],
    models: [
      { id: "model-b", enabled: true, contextWindow: 64000 },
    ] as AppState["models"],
    draft: { spaceId: "old-space" },
    homeSpaceId: "old-space",
  });
  api.getState().setActiveTask("a");
  api.setState({
    draft: { spaceId: "old-space" },
    homeSpaceId: "old-space",
  });
  let transitions = 0;
  const unsubscribe = api.subscribe((next, previous) => {
    if (next.activeTaskId !== previous.activeTaskId) transitions += 1;
    // Inspect every publication, including any before the active id changes.
    // Later lineage/cache notifications may publish again without splitting activation.
    assert.equal(next.activeTaskId, "b");
    assert.equal(next.draft, null);
    assert.equal(next.homeSpaceId, "space-b");
    assert.equal(next.activeModelId, "model-b");
    assert.equal(next.permissionMode, "auto");
    assert.equal(next.modelExplicit, true);
    assert.equal(next.permissionExplicit, true);
    assert.deepEqual(next.activeConnectorIds, ["connector-b"]);
  });
  api.getState().setActiveTask("b");
  assert.equal(transitions, 1, "one observer-visible cross-domain activation");
  unsubscribe();
  api.setState({ panelOpen: true });
  usageB.resolve({ usedTokens: 20, contextWindow: 64000 });
  await tick();
  usageA.resolve({ usedTokens: 999, contextWindow: 1000 });
  historyA.resolve({
    messages: [
      { id: "historical-a", role: "user", text: "A history", createdAt: 1 },
    ],
  });
  await tick();
  assert.equal(
    api.getState().contextUsedTokens,
    20,
    "late A context cannot overwrite B",
  );
  assert.equal(
    api.getState().panelOpen,
    true,
    "late A history cannot close B's panel",
  );
  assert.equal(
    api.getState().tasks.find((item) => item.id === "a")?.messages[0].id,
    "historical-a",
    "background history is retained for its own task",
  );
  assert.equal(
    api.getState().tasks.find((item) => item.id === "b")?.messages[0].id,
    "b-answer",
  );
}

async function regenerationCommitsInOneNotification(): Promise<void> {
  const pending = deferred<unknown>();
  const { useAppStore: api } = store({
    agent: { regenerate: () => pending.promise },
  });
  api.setState({
    activeTaskId: "a",
    tasks: [
      task("a", {
        status: "completed",
        messages: [
          {
            id: "question",
            role: "user",
            entryId: "pi-user",
            createdAt: 1,
            blocks: [{ type: "text", text: "question" }],
          },
          {
            id: "old-answer",
            role: "assistant",
            createdAt: 2,
            blocks: [],
            finalBlocks: [{ type: "text", text: "old answer" }],
          },
        ],
      }),
    ],
  });
  api.getState().regenerateMessage("old-answer");
  const replacement = Object.values(api.getState().pendingRegenerations)[0];
  assert.ok(replacement);
  assert.equal(api.getState().tasks[0].messages[1].id, "old-answer");
  let notifications = 0;
  const unsubscribe = api.subscribe((next) => {
    notifications += 1;
    assert.equal(
      Object.keys(next.pendingRegenerations).length,
      0,
      "pending removal is part of commit",
    );
    assert.deepEqual(
      next.tasks[0].messages.map((message) => message.id),
      ["question", replacement.newAssistantMessageId],
    );
  });
  api
    .getState()
    .applyAgentPatch({
      type: "assistant_start",
      taskId: "a",
      messageId: replacement.newAssistantMessageId,
      modelName: "test",
    });
  assert.equal(
    notifications,
    1,
    "no partial regeneration state can reach subscribers",
  );
  unsubscribe();
  pending.resolve(undefined);
  await tick();
}

async function tombstonesAndSelectorsAreInstanceLocal(): Promise<void> {
  const first = store();
  const second = store();
  const same = task("same");
  first.useAppStore.setState({ tasks: [same], activeTaskId: "same" });
  second.useAppStore.setState({ tasks: [same], activeTaskId: "same" });
  const before = second.appSelectors.selectSidebarTasks(
    second.useAppStore.getState(),
  );
  first.useAppStore.getState().deleteTask("same");
  first.useAppStore
    .getState()
    .applyAgentPatch({
      type: "assistant_start",
      taskId: "same",
      messageId: "late",
      modelName: "test",
    });
  assert.equal(
    first.useAppStore.getState().tasks.length,
    0,
    "late event cannot resurrect a deleted task",
  );
  second.useAppStore
    .getState()
    .applyAgentDeltaBatch([
      {
        type: "text_delta",
        taskId: "same",
        messageId: "same-answer",
        delta: "independent",
      },
    ]);
  assert.equal(
    second.useAppStore.getState().tasks[0].messages[0].blocks[0]?.type,
    "text",
  );
  first.appSelectors.selectSidebarTasks(first.useAppStore.getState());
  assert.equal(
    second.appSelectors.selectSidebarTasks(second.useAppStore.getState()),
    before,
    "other stores and streaming text must not invalidate this sidebar cache",
  );
}

async function artifactSingleFlightIsInstanceLocal(): Promise<void> {
  const contentA = deferred<{ content: string }>();
  const contentB = deferred<{ content: string }>();
  let readsA = 0;
  let readsB = 0;
  const a = store({
    artifactDomain: {
      readContent: () => {
        readsA += 1;
        return contentA.promise;
      },
    },
  });
  const b = store({
    artifactDomain: {
      readContent: () => {
        readsB += 1;
        return contentB.promise;
      },
    },
  });
  const descriptor: ArtifactDescriptor = {
    id: "artifact",
    taskId: "task",
    kind: "markdown",
    title: "note.md",
    version: 1,
    source: {
      type: "managed-content",
      rootDir: "/test",
      storagePath: "task/note.md",
    },
    capabilities: {},
    createdAt: 1,
    updatedAt: 1,
  };
  for (const app of [a, b]) {
    const p = app.useAppStore.getState().artifactProjection;
    app.useAppStore.setState({
      artifactProjection: { ...p, artifactsByTask: { task: [descriptor] } },
    });
  }
  const first = a.useAppStore
    .getState()
    .ensureArtifactRenderPayload("artifact");
  const duplicate = a.useAppStore
    .getState()
    .ensureArtifactRenderPayload("artifact");
  const independent = b.useAppStore
    .getState()
    .ensureArtifactRenderPayload("artifact");
  assert.equal(first, duplicate, "same store shares its in-flight request");
  assert.notEqual(
    first,
    independent,
    "different stores never share a hydration promise",
  );
  assert.deepEqual([readsA, readsB], [1, 1]);
  contentA.resolve({ content: "content A" });
  contentB.resolve({ content: "content B" });
  await Promise.all([first, independent]);
  assert.equal(
    a.useAppStore.getState().artifactRenderCache.artifact.content,
    "content A",
  );
  assert.equal(
    b.useAppStore.getState().artifactRenderCache.artifact.content,
    "content B",
  );
  assert.equal(a.useAppStore.getState().artifactRenderLoadState.artifact, "ready");
  a.useAppStore.getState().releaseArtifactRender("artifact");
  const released = a.useAppStore.getState();
  assert.equal(released.artifactRenderCache.artifact, undefined, "release removes the cached payload");
  assert.equal(released.artifactRenderLoadState.artifact, undefined, "release clears hydration state");
  assert.equal(released.artifactRenderErrors.artifact, undefined, "release clears any hydration error");
  assert.equal(b.useAppStore.getState().artifactRenderCache.artifact.content, "content B", "release is scoped to its store");
  await a.useAppStore.getState().ensureArtifactRenderPayload("artifact");
  assert.equal(readsA, 2, "a released artifact is read again when its preview reopens");
}

async function workspaceMovesShareOneQueuePerStore(): Promise<void> {
  const firstMove = deferred<{ ok: true }>();
  const calls: string[] = [];
  const first = store({
    db: {
      moveSpace: () => {
        calls.push("space");
        return firstMove.promise;
      },
      moveTaskInWorkspaceTree: async () => {
        calls.push("task");
        return { ok: true };
      },
    },
  });
  const second = store({
    db: {
      moveTaskInWorkspaceTree: async () => {
        calls.push("other-store");
        return { ok: true };
      },
    },
  });
  for (const app of [first, second]) {
    app.useAppStore.setState({
      tasks: [task("same")],
      activeTaskId: "same",
      spaces: [
        { id: "s1", name: "One", path: "/one" },
        { id: "s2", name: "Two", path: "/two" },
      ],
    });
  }
  const movingSpace = first.useAppStore
    .getState()
    .moveSpace({ spaceId: "s1", targetParentId: "s2" });
  await tick();
  const movingTask = first.useAppStore
    .getState()
    .moveTaskInWorkspaceTree({ taskId: "same", targetSpaceId: "s2" });
  await second.useAppStore
    .getState()
    .moveTaskInWorkspaceTree({ taskId: "same", targetSpaceId: "s2" });
  assert.deepEqual(
    calls,
    ["space", "other-store"],
    "space and task moves serialize only within their owner",
  );
  firstMove.resolve({ ok: true });
  await Promise.all([movingSpace, movingTask]);
  assert.deepEqual(calls, ["space", "other-store", "task"]);
  assert.equal(first.useAppStore.getState().homeSpaceId, "s2");
  assert.equal(first.useAppStore.getState().tasks[0].spaceId, "s2");
}

async function asyncBranchRetryStopsTheCapturedTask(): Promise<void> {
  const response = deferred<unknown>();
  const aborted: string[] = [];
  const cancelled: string[] = [];
  const requests: Array<{ sourceTaskId: string; requestId: string }> = [];
  const { useAppStore: api } = store({
    conversationBranch: {
      create: (request: { sourceTaskId: string; requestId: string }) => {
        requests.push({ ...request });
        return requests.length === 1
          ? response.promise
          : Promise.resolve({
              ok: false,
              code: "TARGET_NOT_FOUND",
              message: "fixture",
            });
      },
    },
    agent: {
      abort: async (id: string) => {
        aborted.push(id);
      },
    },
    externalAgent: {
      cancel: async (_session: unknown, id: string) => {
        cancelled.push(id);
      },
    },
  });
  api.setState({
    activeTaskId: "a",
    conversationBranchEnabled: true,
    tasks: [
      task("a", {
        messages: [
          {
            id: "question",
            role: "user",
            createdAt: 0,
            blocks: [{ type: "text", text: "question" }],
          },
          {
            id: "answer",
            role: "assistant",
            createdAt: 1,
            blocks: [],
            streaming: true,
          },
        ],
      }),
      task("b"),
    ],
  });
  const creating = api
    .getState()
    .createBranchFromMessage("answer", {
      role: "assistant",
      entryId: "pi-answer",
    });
  api.setState({ activeTaskId: "b" });
  response.resolve({ ok: false, code: "TASK_BUSY", message: "busy" });
  assert.equal(await creating, false);
  assert.deepEqual(
    aborted,
    ["a"],
    "a delayed TASK_BUSY belongs to the source task, not the current page",
  );
  assert.deepEqual(cancelled, ["a"]);
  assert.equal(requests.length, 2);
  assert.equal(requests[0].sourceTaskId, "a");
  assert.deepEqual(
    requests[1],
    requests[0],
    "retry retains its source, entry anchor and idempotency key",
  );
  assert.equal(
    api.getState().tasks.find((item) => item.id === "b")?.messages[0].streaming,
    true,
  );
}

async function asyncDeletionRetryStopsTheCapturedTask(): Promise<void> {
  const response = deferred<void>();
  const aborted: string[] = [];
  const requests: Array<{ taskId: string; userMessageIndex: number }> = [];
  const { useAppStore: api } = store({
    agent: {
      deleteUserMessage: (request: {
        taskId: string;
        userMessageIndex: number;
      }) => {
        requests.push({ ...request });
        return requests.length === 1 ? response.promise : Promise.resolve();
      },
      abort: async (id: string) => {
        aborted.push(id);
      },
    },
  });
  api.setState({
    activeTaskId: "a",
    tasks: [
      task("a", {
        status: "completed",
        messages: [
          {
            id: "question",
            role: "user",
            createdAt: 0,
            blocks: [{ type: "text", text: "question" }],
          },
        ],
      }),
      task("b"),
    ],
  });
  const deleting = api.getState().deleteUserMessage("question");
  api.setState({ activeTaskId: "b" });
  response.reject(new Error("busy"));
  await deleting;
  assert.equal(requests.length, 2);
  assert.equal(requests[0].taskId, "a");
  assert.deepEqual(
    requests[1],
    requests[0],
    "retry retains the captured task and message anchor",
  );
  assert.deepEqual(aborted, ["a"]);
  assert.equal(
    api.getState().tasks.find((item) => item.id === "b")?.messages[0].streaming,
    true,
  );
  assert.equal(
    api.getState().tasks.find((item) => item.id === "a")?.messages.length,
    0,
  );
}

async function fileChangeProjectionPreservesWorkspacePath(): Promise<void> {
  const { useAppStore: api } = store();
  api.setState({ tasks: [task("task")], activeTaskId: "task" });
  api.getState().applyAgentPatch({
    type: "artifact_ref",
    taskId: "task",
    messageId: "task-answer",
    artifactId: "artifact-code",
    name: "main.ts",
    kind: "code",
    change: {
      name: "main.ts",
      path: "/workspace/project/src/main.ts",
      additions: 7,
      deletions: 2,
    },
  });
  const updated = api.getState().tasks[0];
  assert.equal(updated.fileChanges?.[0].path, "/workspace/project/src/main.ts");
  assert.equal(updated.fileChanges?.[0].additions, 7);
  assert.equal(updated.fileChanges?.[0].deletions, 2);
  assert.deepEqual(updated.messages[0].artifactIds, ["artifact-code"]);
  assert.equal(updated.messages[0].changesCount, 1);
}

async function durableSnapshotsRetainInteractionCards(): Promise<void> {
  const { useAppStore: api } = store();
  api.setState({ tasks: [task("task", { messages: [], welcomeMode: "working" })] });
  const snapshot: DurableBotSnapshot = { backend: "pi-durable", epoch: "first", revision: 1, conversationId: "1", toolMode: "native", busy: true, queued: 0, pendingInputs: [], compacting: false,
    messages: [{ id: "durable-1", role: "assistant", text: "", streaming: true, createdAt: 2 }] };
  api.getState().applyAgentPatch({ type: "durable_snapshot", taskId: "task", snapshot });
  const interaction = { id: "question", taskId: "task", executionId: "execution", assistantMessageId: "durable-1", kind: "confirm" as const, title: "Continue?", options: [], status: "pending" as const, version: 1, createdAt: 2 };
  api.getState().applyAgentPatch({ type: "conversation_interaction_snapshot", taskId: "task", messageId: "durable-1", executionId: "execution", interaction });
  api.getState().applyAgentPatch({ type: "durable_snapshot", taskId: "task", snapshot: { ...snapshot, revision: 2 } });
  assert.deepEqual(api.getState().tasks[0].messages[0].interactions, [interaction], "Live native snapshots must not erase permission or user-input cards");
  assert.equal(api.getState().tasks[0].welcomeMode, "working", "A shared runtime does not change the task's product mode");
  api.getState().applyAgentPatch({ type: "durable_snapshot", taskId: "task", snapshot: { ...snapshot, epoch: "fork", revision: 1, messages: [] } });
  assert.equal(api.getState().tasks[0].messages.length, 0, "A branch snapshot must not resurrect removed interaction rows");
}

async function main(): Promise<void> {
  const tests = [
    activationIsAtomicAndLateReadsStayWithTheirOwner,
    regenerationCommitsInOneNotification,
    tombstonesAndSelectorsAreInstanceLocal,
    artifactSingleFlightIsInstanceLocal,
    workspaceMovesShareOneQueuePerStore,
    asyncBranchRetryStopsTheCapturedTask,
    asyncDeletionRetryStopsTheCapturedTask,
    fileChangeProjectionPreservesWorkspacePath,
    durableSnapshotsRetainInteractionCards,
    durableRevisionGapReadsOnceAndReplaysBufferedUpdates,
    sidebarSelectorSkipsUnchangedTaskRederivation,
    artifactReconcileNoOpKeepsStoreState,
    lateModelCatalogKeepsUserSelection,
    bootstrapAppliesCriticalDataBeforeOptionalCatalogs,
    bootstrapCriticalFailureLeavesNoPartialScreen,
  ];
  for (const test of tests) {
    await test();
    console.log(`PASS ${test.name}`);
  }
  console.log(
    `[app-store-transactions] ${tests.length} behavior groups passed`,
  );
}

async function sidebarSelectorSkipsUnchangedTaskRederivation(): Promise<void> {
  const { useAppStore: api, appSelectors } = store({});
  let reads = 0;
  const base = task("task");
  const counted = {
    ...base,
    get messages() {
      reads += 1;
      return base.messages;
    },
  } as Task;
  api.setState({ tasks: [counted] });
  const first = appSelectors.selectSidebarTasks(api.getState());
  const second = appSelectors.selectSidebarTasks(api.getState());
  assert.equal(second, first, "同一 Task 引用复用侧栏数组");
  assert.equal(reads, 0, "同一 Task 引用不再重新派生展示状态");

  // A different object with identical summary fields must still be compared (and may read messages).
  const twin = {
    ...base,
    get messages() {
      reads += 1;
      return base.messages;
    },
  } as Task;
  assert.notEqual(twin, counted);
  api.setState({ tasks: [twin] });
  const third = appSelectors.selectSidebarTasks(api.getState());
  assert.equal(third, first, "摘要相同的不同对象仍复用旧条目");
  assert.ok(reads > 0, "摘要相同的不同对象仍执行状态比较");

  const changed = task("task", { title: "changed" });
  api.setState({ tasks: [changed] });
  const fourth = appSelectors.selectSidebarTasks(api.getState());
  assert.notEqual(fourth, first, "内容变化仍产生新侧栏数组");
  assert.equal(fourth[0], changed);
}

async function artifactReconcileNoOpKeepsStoreState(): Promise<void> {
  const descriptor: ArtifactDescriptor = {
    id: "artifact",
    taskId: "task",
    kind: "markdown",
    title: "note.md",
    version: 1,
    source: { type: "managed-content", rootDir: "/test", storagePath: "task/note.md" },
    capabilities: {},
    createdAt: 1,
    updatedAt: 1,
  };
  const { useAppStore: api } = store({});
  const messages = [
    { id: "u1", role: "user" as const, createdAt: 1, blocks: [] },
    { id: "a1", role: "assistant" as const, createdAt: 2, blocks: [], artifactIds: ["artifact"] },
  ];
  api.setState({ tasks: [task("task", { messages })], activeTaskId: "task" });
  const projection = api.getState().artifactProjection;
  api.setState({ artifactProjection: { ...projection, artifactsByTask: { task: [descriptor] } } });

  let notifications = 0;
  const unsubscribe = api.subscribe(() => {
    notifications += 1;
  });
  const before = api.getState().tasks;
  api.getState().reconcileTaskMessageArtifacts("task");
  assert.equal(notifications, 0, "已正确关联的产物对账不得发布新 Store 状态");
  assert.equal(api.getState().tasks, before, "no-op 对账保持 tasks 数组引用");

  // A real change (missing association + an orphan descriptor) must still publish once.
  api.setState({
    tasks: [
      task("task", {
        messages: [
          { id: "u1", role: "user" as const, createdAt: 1, blocks: [] },
          { id: "a1", role: "assistant" as const, createdAt: 2, blocks: [] },
        ],
      }),
    ],
  });
  notifications = 0;
  api.getState().reconcileTaskMessageArtifacts("task");
  assert.equal(notifications, 1, "真实关联变化只发布一次状态");
  assert.deepEqual(api.getState().tasks[0].messages[1].artifactIds, ["artifact"]);
  unsubscribe();
}

async function lateModelCatalogKeepsUserSelection(): Promise<void> {
  const { useAppStore: api } = store({
    agent: {
      listModels: async () => [
        { id: "keep", name: "Keep", vendor: "v", supportsImages: false, supportsReasoning: false, enabled: true },
        { id: "fresh", name: "Fresh", vendor: "v", supportsImages: false, supportsReasoning: false, enabled: true },
      ],
    },
  });
  api.setState({ models: [], activeModelId: "keep", defaultModelId: "keep" });
  api.getState().applyAgentPatch({ type: "models_changed" });
  await tick();
  await tick();
  assert.deepEqual(api.getState().models.map((model) => model.id), ["keep", "fresh"]);
  assert.equal(api.getState().activeModelId, "keep", "晚到的目录不得覆盖已选模型");
  assert.equal(api.getState().defaultModelId, "keep");

  api.setState({ models: [], activeModelId: "", defaultModelId: "" });
  api.getState().applyAgentPatch({ type: "models_changed" });
  await tick();
  await tick();
  assert.equal(api.getState().activeModelId, "keep", "空选择回落首个启用模型");
  assert.equal(api.getState().defaultModelId, "keep");
}

async function bootstrapAppliesCriticalDataBeforeOptionalCatalogs(): Promise<void> {
  const calls: string[] = [];
  const api = {
    db: {
      listSpaces: async () => [{ id: "space", name: "Space", path: "/space", archived: false }],
      listTasks: async () => [{ id: "critical", title: "Critical", updatedAt: 5, welcomeMode: "bot" }],
      listProjects: async () => [],
      getSoul: async () => null,
    },
    agent: {
      listModels: async () => [{ id: "model", name: "Model", vendor: "v", supportsImages: false, supportsReasoning: false, enabled: true }],
      getAppSettings: async () => null,
      listSkills: async () => { calls.push("skills"); throw new Error("skills unavailable"); },
      listMarketSkills: async () => { calls.push("market-skills"); return [{ id: "ms", name: "MS" }]; },
      listExperts: async () => { calls.push("experts"); return [{ id: "e1" }]; },
      listMarketExperts: async () => [{ id: "me1" }],
      listConnectors: async () => { calls.push("connectors"); return [{ id: "c1" }]; },
    },
  };
  const app = store(api);
  const binding = {
    context: app.context,
    api: api as unknown as NonNullable<Window["api"]>,
    isActive: () => true,
    addCleanup: () => {},
  };
  await loadRuntimeBootstrap(binding, {
    mapTaskRowToTask,
    recomputeEffectiveArchived,
    emptySoul: EMPTY_SOUL,
  });
  const state = app.useAppStore.getState();
  assert.deepEqual(state.tasks.map((row) => row.id), ["critical"], "关键数据不受目录失败影响");
  assert.deepEqual(state.models.map((row) => row.id), ["model"]);
  assert.deepEqual(state.spaces.map((row) => row.id), ["space"]);
  assert.deepEqual(state.marketSkills.map((row) => row.id), ["ms"], "其余目录仍独立加载");
  assert.deepEqual(state.experts.map((row) => row.id), ["e1"]);
  assert.deepEqual(state.connectors.map((row) => row.id), ["c1"]);
  assert.equal(state.skills.length, 0, "失败的目录只留下空分片");
  assert.ok(calls.includes("market-skills") && calls.includes("connectors"), "失败目录不会中断其他目录");
}

async function bootstrapCriticalFailureLeavesNoPartialScreen(): Promise<void> {
  let optionalReads = 0;
  const api = {
    db: {
      listSpaces: async () => [],
      listTasks: async () => { throw new Error("database unavailable"); },
      listProjects: async () => [],
      getSoul: async () => null,
    },
    agent: {
      listModels: async () => [],
      getAppSettings: async () => null,
      listSkills: async () => { optionalReads += 1; return []; },
    },
  };
  const app = store(api);
  const tasksBefore = app.useAppStore.getState().tasks;
  const binding = {
    context: app.context,
    api: api as unknown as NonNullable<Window["api"]>,
    isActive: () => true,
    addCleanup: () => {},
  };
  await loadRuntimeBootstrap(binding, {
    mapTaskRowToTask,
    recomputeEffectiveArchived,
    emptySoul: EMPTY_SOUL,
  });
  assert.equal(optionalReads, 0, "没有首屏数据时不继续加载目录");
  assert.equal(app.useAppStore.getState().tasks, tasksBefore, "关键读取失败不写半成品状态");
}

async function durableRevisionGapReadsOnceAndReplaysBufferedUpdates(): Promise<void> {
  const history = deferred<TaskHistoryDto>();
  let reads = 0;
  const { useAppStore: api } = store({ agent: { loadTaskHistory: () => { reads++; return history.promise; } } });
  api.setState({ tasks: [task("task", { messages: [] })] });
  const first: DurableBotSnapshot = { backend: "pi-durable", epoch: "epoch", revision: 1, conversationId: "1", toolMode: "native", busy: true, queued: 0, pendingInputs: [], compacting: false,
    messages: [{ id: "old", role: "user", text: "history", createdAt: 1, projectionVersion: 1 }, { id: "live", role: "assistant", text: "1", createdAt: 2 }] };
  const snapshot = (revision: number): DurableBotSnapshot => ({ ...first, revision, messages: [first.messages[0], { ...first.messages[1], text: String(revision) }] });
  const delta = (base: DurableBotSnapshot, next: DurableBotSnapshot) => {
    const { messages: _messages, epoch: _epoch, revision: _revision, ...state } = next;
    return durableDelta(base, next, state);
  };
  api.getState().applyAgentPatch({ type: "durable_snapshot", taskId: "task", snapshot: first });
  const stableRow = api.getState().tasks[0].messages[0];
  api.getState().applyAgentPatch({ type: "durable_delta", taskId: "task", delta: delta(first, snapshot(2)) });
  assert.equal(api.getState().tasks[0].messages[0], stableRow, "unchanged message conversion is reused across a delta");
  api.getState().applyAgentPatch({ type: "durable_delta", taskId: "task", delta: delta(snapshot(3), snapshot(4)) });
  api.getState().applyAgentPatch({ type: "durable_delta", taskId: "task", delta: delta(snapshot(4), snapshot(5)) });
  assert.equal(reads, 1, "a gap starts one explicit full-history read");
  assert.equal(api.getState().tasks[0].durable?.revision, 2, "missing revisions cannot be applied approximately");
  history.resolve({ messages: snapshot(4).messages, durable: snapshot(4) });
  await tick();
  assert.equal(api.getState().tasks[0].durable?.revision, 5, "events received during resynchronization are replayed after the snapshot");
  assert.equal(api.getState().tasks[0].messages.at(-1)?.finalBlocks?.[0].type, "text");
  api.getState().applyAgentPatch({ type: "durable_delta", taskId: "task", delta: delta(snapshot(3), snapshot(4)) });
  assert.equal(reads, 1, "replayed stale packets are ignored");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
