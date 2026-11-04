import assert from "node:assert/strict";
import { createStore } from "zustand/vanilla";
import type {
  AgentUiPatch,
  SpaceDto,
  TaskDto,
  TaskHistoryDto,
} from "../src/shared/agent-ipc";
import type {
  ArtifactCreatedEvent,
  ArtifactRemovedEvent,
  ArtifactUpdatedEvent,
} from "../src/shared/artifact-types";
import type { ExternalAgentUiEvent } from "../src/shared/external-agent";
import {
  EMPTY_SELECTION,
  type SelectionAttachEvent,
  type SelectionChangedEvent,
  type SelectionState,
} from "../src/shared/selection";
import type { Task } from "../src/renderer/src/types";
import type { AppContext } from "../src/renderer/src/store/app/context";
import type { AppState } from "../src/renderer/src/store/app/types";
import { createInitRuntimeActions } from "../src/renderer/src/store/app/runtime/initRuntime";
import { createAppRuntimeState } from "../src/renderer/src/store/app/runtime/state";
import { hydrateExternalAgentHistory } from "../src/renderer/src/store/app/runtime/taskHydration";
import {
  createAgentDeltaBuffer,
  type AgentDeltaBuffer,
  type AgentDeltaPatch,
  type AgentDeltaScheduler,
} from "../src/renderer/src/store/app/runtime/deltaBuffer";

class ManualScheduler implements AgentDeltaScheduler {
  private nextHandle = 1;
  readonly frames = new Map<number, () => void>();
  readonly timers = new Map<
    number,
    { callback: () => void; delayMs: number }
  >();

  requestFrame(callback: () => void): number {
    const handle = this.nextHandle++;
    this.frames.set(handle, callback);
    return handle;
  }

  cancelFrame(handle: number): void {
    this.frames.delete(handle);
  }

  setTimer(callback: () => void, delayMs: number): number {
    const handle = this.nextHandle++;
    this.timers.set(handle, { callback, delayMs });
    return handle;
  }

  clearTimer(handle: number): void {
    this.timers.delete(handle);
  }

  runFrame(): void {
    const entry = this.frames.entries().next().value;
    assert.ok(entry, "a frame must be scheduled");
    this.frames.delete(entry[0]);
    entry[1]();
  }

  runTimer(): void {
    const entry = this.timers.entries().next().value;
    assert.ok(entry, "a fallback timer must be scheduled");
    this.timers.delete(entry[0]);
    entry[1].callback();
  }

  assertIdle(): void {
    assert.equal(this.frames.size, 0, "no RAF may remain scheduled");
    assert.equal(this.timers.size, 0, "no fallback timer may remain scheduled");
  }
}

function text(
  delta: string,
  options: {
    taskId?: string;
    messageId?: string;
    final?: boolean;
  } = {},
): AgentDeltaPatch {
  return {
    type: "text_delta",
    taskId: options.taskId ?? "task-a",
    messageId: options.messageId ?? "message-a",
    delta,
    ...(options.final === undefined ? {} : { final: options.final }),
  };
}

function thinking(delta: string): AgentDeltaPatch {
  return {
    type: "thinking_delta",
    taskId: "task-a",
    messageId: "message-a",
    delta,
  };
}

function testAdjacentDeltaBoundaries(): void {
  const scheduler = new ManualScheduler();
  const batches: AgentDeltaPatch[][] = [];
  const buffer = createAgentDeltaBuffer({
    scheduler,
    applyBatch: (patches) => batches.push(patches),
  });
  buffer.push(text("a"));
  buffer.push(text("b"));
  buffer.push(thinking("c"));
  buffer.push(thinking("d"));
  buffer.push(text("e", { final: true }));
  buffer.push(text("f", { final: true }));
  buffer.push(text("g", { final: false }));
  buffer.push(text("h"));
  buffer.push(text("i", { messageId: "message-b" }));
  buffer.push(text("j", { taskId: "task-b", messageId: "message-b" }));

  assert.equal(batches.length, 0, "deltas are deferred into a batch");
  assert.equal(scheduler.frames.size, 1, "one frame per batch");
  assert.deepEqual(
    [...scheduler.timers.values()].map((timer) => timer.delayMs),
    [40],
  );
  scheduler.runFrame();
  assert.deepEqual(
    batches,
    [
      [
        text("ab"),
        thinking("cd"),
        text("ef", { final: true }),
        text("g", { final: false }),
        text("h"),
        text("i", { messageId: "message-b" }),
        text("j", { taskId: "task-b", messageId: "message-b" }),
      ],
    ],
    "coalesce only adjacent deltas with identical type, task, message, and final flag",
  );
  scheduler.assertIdle();
  buffer.dispose();
}

function testBackgroundFallbackAndFlushOrder(): void {
  const scheduler = new ManualScheduler();
  const events: string[] = [];
  const buffer = createAgentDeltaBuffer({
    scheduler,
    applyBatch: (patches) =>
      events.push(patches.map((patch) => patch.delta).join("")),
  });
  buffer.push(text("background"));
  const staleFrame = [...scheduler.frames.values()][0];
  scheduler.runTimer();
  staleFrame();
  assert.deepEqual(
    events,
    ["background"],
    "RAF and timer must never deliver the same batch twice",
  );
  scheduler.assertIdle();

  buffer.push(text("before-tool"));
  buffer.flush();
  events.push("tool_start");
  buffer.push(text("after-tool"));
  buffer.flush();
  events.push("assistant_end");
  assert.deepEqual(events, [
    "background",
    "before-tool",
    "tool_start",
    "after-tool",
    "assistant_end",
  ]);
  scheduler.assertIdle();
  buffer.dispose();
}

function testDisposeDrainsOnceAndRejectsLateEvents(): void {
  const scheduler = new ManualScheduler();
  const batches: AgentDeltaPatch[][] = [];
  let buffer: AgentDeltaBuffer;
  buffer = createAgentDeltaBuffer({
    scheduler,
    applyBatch: (patches) => {
      batches.push(patches);
      buffer.push(text("reentrant-late-event"));
    },
  });
  buffer.push(text("last-visible-text"));
  const queuedFrame = [...scheduler.frames.values()][0];
  const queuedTimer = [...scheduler.timers.values()][0].callback;
  buffer.dispose();
  buffer.dispose();
  buffer.push(text("late-ipc-event"));
  queuedFrame();
  queuedTimer();
  buffer.flush();
  assert.deepEqual(
    batches,
    [[text("last-visible-text")]],
    "cleanup drains existing text once and closes the buffer",
  );
  scheduler.assertIdle();
}

function testBufferInstancesOwnTheirScheduling(): void {
  const scheduler = new ManualScheduler();
  const batches: string[] = [];
  const oldBuffer = createAgentDeltaBuffer({
    scheduler,
    applyBatch: (patches) => batches.push(`old:${patches[0].delta}`),
  });
  const nextBuffer = createAgentDeltaBuffer({
    scheduler,
    applyBatch: (patches) => batches.push(`next:${patches[0].delta}`),
  });
  oldBuffer.push(text("old"));
  nextBuffer.push(text("new"));
  oldBuffer.dispose();
  assert.equal(
    scheduler.frames.size,
    1,
    "disposing an old instance must leave the new frame alive",
  );
  assert.equal(
    scheduler.timers.size,
    1,
    "disposing an old instance must leave the new timer alive",
  );
  scheduler.runFrame();
  assert.deepEqual(batches, ["old:old", "next:new"]);
  nextBuffer.dispose();
  scheduler.assertIdle();
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((complete) => {
    resolve = complete;
  });
  return { promise, resolve };
}

class EventChannel<T> {
  readonly registrations: Array<{
    listener: (event: T) => void;
    active: boolean;
    disposeCount: number;
  }> = [];

  readonly subscribe = (listener: (event: T) => void): (() => void) => {
    const registration = { listener, active: true, disposeCount: 0 };
    this.registrations.push(registration);
    return () => {
      registration.active = false;
      registration.disposeCount += 1;
    };
  };

  emit(event: T): void {
    for (const registration of this.registrations) {
      if (registration.active) registration.listener(event);
    }
  }

  get activeCount(): number {
    return this.registrations.filter((registration) => registration.active)
      .length;
  }
}

function taskFixture(id = "task-a"): Task {
  return {
    id,
    title: "Existing task",
    updatedAt: 1,
    messages: [
      {
        id: "message-a",
        role: "assistant",
        createdAt: 1,
        blocks: [],
        artifactIds: ["artifact-a"],
      },
    ],
  };
}

function createRuntimeHarness() {
  const channels = {
    agent: new EventChannel<AgentUiPatch>(),
    externalAgent: new EventChannel<ExternalAgentUiEvent>(),
    cron: new EventChannel<unknown>(),
    artifactCreated: new EventChannel<ArtifactCreatedEvent>(),
    artifactUpdated: new EventChannel<ArtifactUpdatedEvent>(),
    artifactRemoved: new EventChannel<ArtifactRemovedEvent>(),
    selectionChanged: new EventChannel<SelectionChangedEvent>(),
    selectionAttach: new EventChannel<SelectionAttachEvent>(),
  };
  const bootstraps: Array<ReturnType<typeof deferred<SpaceDto[]>>> = [];
  const selectionReads: Array<
    ReturnType<typeof deferred<SelectionState | null>>
  > = [];
  const historyLoads: string[] = [];
  const calls: string[] = [];
  let listTasks: () => Promise<TaskDto[]> = () => Promise.resolve([]);
  let loadHistory: (taskId: string) => Promise<TaskHistoryDto> = () =>
    Promise.resolve({ messages: [] });
  const api = {
    db: {
      listSpaces: () => {
        const request = deferred<SpaceDto[]>();
        bootstraps.push(request);
        return request.promise;
      },
      listTasks: () => listTasks(),
      listProjects: async () => [],
      getSoul: async () => null,
    },
    agent: {
      onEvent: channels.agent.subscribe,
      listModels: async () => [],
      listSkills: async () => [],
      listMarketSkills: async () => [],
      getAppSettings: async () => null,
      listExperts: async () => [],
      listMarketExperts: async () => [],
      listConnectors: async () => [],
      loadTaskHistory: (taskId: string) => {
        historyLoads.push(taskId);
        return loadHistory(taskId);
      },
    },
    externalAgent: { onEvent: channels.externalAgent.subscribe },
    cron: { onEvent: channels.cron.subscribe },
    artifactDomain: {
      onCreated: channels.artifactCreated.subscribe,
      onUpdated: channels.artifactUpdated.subscribe,
      onRemoved: channels.artifactRemoved.subscribe,
    },
    selection: {
      get: () => {
        const request = deferred<SelectionState | null>();
        selectionReads.push(request);
        return request.promise;
      },
      onChanged: channels.selectionChanged.subscribe,
      onAttach: channels.selectionAttach.subscribe,
    },
  } as unknown as NonNullable<ReturnType<AppContext["getApi"]>>;
  const store = createStore<AppState>(
    () =>
      ({
        tasks: [taskFixture()],
        activeTaskId: "task-a",
        activeModelId: "existing-model",
        selection: EMPTY_SELECTION,
        chatSelections: [],
        applyAgentDeltaBatch: (patches: AgentDeltaPatch[]) =>
          calls.push(`batch:${patches.map((patch) => patch.delta).join("")}`),
        applyAgentPatch: (patch: AgentUiPatch) => calls.push(patch.type),
        applyArtifactCreated: () => calls.push("artifact_created"),
        applyArtifactUpdated: () => calls.push("artifact_updated"),
        applyArtifactRemoved: () => calls.push("artifact_removed"),
        attachSelectionToChat: () => calls.push("selection_attach"),
      }) as unknown as AppState,
  );
  const context: AppContext = {
    get: store.getState,
    set: store.setState,
    getApi: () => api,
    runtime: createAppRuntimeState(),
  };
  const scheduler = new ManualScheduler();
  const actions = createInitRuntimeActions(context, { scheduler });
  return {
    context,
    store,
    scheduler,
    actions,
    channels,
    bootstraps,
    selectionReads,
    historyLoads,
    calls,
    setTaskLoader: (loader: typeof listTasks) => {
      listTasks = loader;
    },
    setHistoryLoader: (loader: typeof loadHistory) => {
      loadHistory = loader;
    },
  };
}

function startRuntime(
  harness: ReturnType<typeof createRuntimeHarness>,
): () => void {
  const dispose = harness.actions.initRuntime();
  assert.ok(
    typeof dispose === "function",
    "runtime initialization returns its own cleanup",
  );
  return dispose;
}

async function settleAsyncReads(): Promise<void> {
  // Resolve nested Promise.all / history continuations without wall-clock timers.
  for (let index = 0; index < 5; index += 1) await Promise.resolve();
}

function externalEvent(patch: AgentUiPatch): ExternalAgentUiEvent {
  return {
    runId: "run-a",
    taskId: "task-a",
    agentId: "codex",
    agentName: "Codex",
    protocol: "acp",
    assistantMessageId: "message-a",
    sessionId: "session-a",
    continuationMode: "resume",
    resumeSupported: true,
    recoveryState: "none",
    verificationStatus: "workspace_observed",
    outputCursor: 4,
    artifactRefs: ["artifact-a", "artifact-b"],
    patch,
  };
}

function testRuntimeReplacementOwnsAllSubscriptions(): void {
  const harness = createRuntimeHarness();
  const disposeOld = startRuntime(harness);
  harness.channels.agent.emit(text("before-restart"));
  const disposeNew = startRuntime(harness);
  assert.deepEqual(
    harness.calls,
    ["batch:before-restart"],
    "replacement drains accepted old deltas",
  );
  assert.equal(harness.context.runtime.activeRuntimeDispose, disposeNew);

  disposeOld();
  for (const channel of Object.values(harness.channels)) {
    assert.equal(
      channel.activeCount,
      1,
      "old cleanup cannot unsubscribe the replacement runtime",
    );
    assert.equal(
      channel.registrations[0].disposeCount,
      1,
      "each old subscription is disposed once",
    );
    assert.equal(channel.registrations[1].disposeCount, 0);
  }
  const beforeLateCallbacks = harness.store.getState();
  harness.channels.agent.registrations[0].listener(text("stale"));
  harness.channels.artifactRemoved.registrations[0].listener({
    artifactId: "artifact-old",
    taskId: "task-a",
    revision: 1,
  });
  harness.channels.selectionChanged.registrations[0].listener({
    state: { ...EMPTY_SELECTION, updatedAt: 50 },
  });
  assert.equal(
    harness.store.getState(),
    beforeLateCallbacks,
    "already queued callbacks from the old runtime are inert",
  );
  harness.scheduler.assertIdle();

  harness.channels.agent.emit(text("pi"));
  harness.channels.agent.emit({
    type: "assistant_end",
    taskId: "task-a",
    messageId: "message-a",
  });
  harness.channels.externalAgent.emit(
    externalEvent(text("acp", { final: true })),
  );
  harness.channels.externalAgent.emit(
    externalEvent({
      type: "assistant_end",
      taskId: "task-a",
      messageId: "message-a",
    }),
  );
  assert.deepEqual(
    harness.calls,
    [
      "batch:before-restart",
      "batch:pi",
      "assistant_end",
      "batch:acp",
      "assistant_end",
    ],
    "both IPC channels flush their text before a structural event",
  );
  const message = harness.store.getState().tasks[0].messages[0];
  assert.equal(message.externalAgent?.id, "codex");
  assert.equal(message.externalAgent?.sessionReady, true);
  assert.deepEqual(
    message.artifactIds,
    ["artifact-a", "artifact-b"],
    "ACP provenance and artifact references survive extraction",
  );

  harness.channels.artifactRemoved.emit({
    artifactId: "artifact-new",
    taskId: "task-a",
    revision: 2,
  });
  harness.channels.selectionChanged.emit({
    state: { ...EMPTY_SELECTION, updatedAt: 100 },
  });
  assert.equal(
    harness.calls.at(-1),
    "artifact_removed",
    "replacement artifact subscription remains live",
  );
  assert.equal(
    harness.store.getState().selection.updatedAt,
    100,
    "replacement selection subscription remains live",
  );
  disposeNew();
  disposeNew();
  for (const channel of Object.values(harness.channels)) {
    assert.equal(channel.activeCount, 0);
    assert.ok(
      channel.registrations.every(
        (registration) => registration.disposeCount === 1,
      ),
    );
  }
  assert.equal(harness.context.runtime.activeRuntimeDispose, undefined);
  harness.scheduler.assertIdle();
}

async function testReplacedBootstrapAndSelectionReadsAreIgnored(): Promise<void> {
  const harness = createRuntimeHarness();
  const disposeOld = startRuntime(harness);
  const disposeNew = startRuntime(harness);
  harness.bootstraps[1].resolve([]);
  harness.selectionReads[1].resolve({ ...EMPTY_SELECTION, updatedAt: 2 });
  await settleAsyncReads();
  assert.equal(
    harness.store.getState().activeTaskId,
    null,
    "the current bootstrap still applies its initial state",
  );
  assert.equal(harness.store.getState().selection.updatedAt, 2);
  harness.store.setState({
    activeTaskId: "latest-task",
    tasks: [taskFixture("latest-task")],
  });
  const latestState = harness.store.getState();

  harness.bootstraps[0].resolve([{ id: "stale-space", name: "Old bootstrap" }]);
  harness.selectionReads[0].resolve({ ...EMPTY_SELECTION, updatedAt: 1 });
  await settleAsyncReads();
  assert.equal(
    harness.store.getState(),
    latestState,
    "old bootstrap and selection promises cannot overwrite the new state",
  );
  disposeOld();
  assert.equal(harness.context.runtime.activeRuntimeDispose, disposeNew);
  disposeNew();
}

async function testDisposedCronReadsDoNotWrite(): Promise<void> {
  const metadataHarness = createRuntimeHarness();
  const disposeMetadata = startRuntime(metadataHarness);
  const rows = deferred<TaskDto[]>();
  metadataHarness.setTaskLoader(() => rows.promise);
  metadataHarness.channels.cron.emit({
    type: "run",
    run: { taskId: "cron-task", status: "success" },
  });
  disposeMetadata();
  const beforeRows = metadataHarness.store.getState();
  rows.resolve([{ id: "cron-task", title: "Late cron task", updatedAt: 10 }]);
  await settleAsyncReads();
  assert.equal(
    metadataHarness.store.getState(),
    beforeRows,
    "late cron metadata must not recreate a task after disposal",
  );

  const historyHarness = createRuntimeHarness();
  const disposeHistory = startRuntime(historyHarness);
  const history = deferred<TaskHistoryDto>();
  historyHarness.setTaskLoader(async () => [
    { id: "task-a", title: "Cron result", updatedAt: 10 },
  ]);
  historyHarness.setHistoryLoader(() => history.promise);
  historyHarness.channels.cron.emit({
    type: "run",
    run: { taskId: "task-a", status: "success" },
  });
  await settleAsyncReads();
  assert.deepEqual(historyHarness.historyLoads, ["task-a"]);
  disposeHistory();
  const beforeHistory = historyHarness.store.getState();
  history.resolve({
    messages: [
      { id: "restored", role: "assistant", createdAt: 10, text: "late result" },
    ],
  });
  await settleAsyncReads();
  assert.equal(
    historyHarness.store.getState(),
    beforeHistory,
    "late cron history cannot replace messages after disposal",
  );
}

async function testCurrentCronHistoryStillRestoresMessages(): Promise<void> {
  const harness = createRuntimeHarness();
  const dispose = startRuntime(harness);
  harness.setTaskLoader(async () => [
    { id: "task-a", title: "Cron result", updatedAt: 10 },
  ]);
  harness.setHistoryLoader(async () => ({
    messages: [
      {
        id: "restored",
        role: "assistant",
        createdAt: 10,
        text: "finished",
        thinking: "reasoning",
      },
    ],
  }));
  harness.channels.cron.emit({
    type: "run",
    run: { taskId: "task-a", status: "success" },
  });
  await settleAsyncReads();
  const task = harness.store.getState().tasks[0];
  assert.equal(task.title, "Cron result");
  assert.deepEqual(task.messages[0].blocks, [
    { type: "thinking", text: "reasoning" },
  ]);
  assert.deepEqual(task.messages[0].finalBlocks, [
    { type: "text", text: "finished" },
  ]);
  assert.equal(task.messages[0].streaming, false);
  dispose();
}

async function testExternalHistoryFollowsItsRuntimeLifetime(): Promise<void> {
  const harness = createRuntimeHarness();
  const oldHistory = deferred<TaskHistoryDto>();
  const newHistory = deferred<TaskHistoryDto>();
  let requestCount = 0;
  harness.setHistoryLoader(() =>
    requestCount++ === 0 ? oldHistory.promise : newHistory.promise,
  );
  const missingAssistantEvent: ExternalAgentUiEvent = {
    ...externalEvent({
      type: "assistant_start",
      taskId: "task-a",
      messageId: "missing-assistant",
    }),
    assistantMessageId: "missing-assistant",
  };

  const disposeOld = startRuntime(harness);
  harness.channels.externalAgent.emit(missingAssistantEvent);
  assert.deepEqual(harness.historyLoads, ["task-a"]);
  const disposeNew = startRuntime(harness);
  harness.channels.externalAgent.emit(missingAssistantEvent);
  assert.deepEqual(
    harness.historyLoads,
    ["task-a", "task-a"],
    "a disposed ACP read must not throttle the new runtime for two seconds",
  );
  const currentRequest =
    harness.context.runtime.externalHistoryHydrationRequests.get("task-a");
  const beforeOldResult = harness.store.getState();
  oldHistory.resolve({
    messages: [
      {
        id: "obsolete",
        role: "assistant",
        createdAt: 2,
        text: "old runtime result",
      },
    ],
  });
  await settleAsyncReads();
  assert.equal(
    harness.store.getState(),
    beforeOldResult,
    "an ACP history read accepted by a retired runtime cannot commit",
  );
  assert.equal(
    harness.context.runtime.externalHistoryHydrationRequests.get("task-a"),
    currentRequest,
    "the old read cannot release the replacement read's ownership",
  );
  assert.ok(harness.context.runtime.externalHistoryHydrations.has("task-a"));

  newHistory.resolve({
    messages: [
      {
        id: "missing-assistant",
        role: "assistant",
        createdAt: 3,
        text: "current runtime result",
      },
    ],
  });
  await settleAsyncReads();
  const messages = harness.store.getState().tasks[0].messages;
  assert.equal(
    messages.some((message) => message.id === "obsolete"),
    false,
  );
  assert.deepEqual(
    messages.find((message) => message.id === "missing-assistant")?.finalBlocks,
    [{ type: "text", text: "current runtime result" }],
  );
  assert.equal(
    harness.context.runtime.externalHistoryHydrationRequests.size,
    0,
  );
  disposeOld();
  disposeNew();

  const direct = createRuntimeHarness();
  direct.setHistoryLoader(async () => ({
    messages: [
      {
        id: "direct",
        role: "assistant",
        createdAt: 4,
        text: "public compatibility call",
      },
    ],
  }));
  hydrateExternalAgentHistory(direct.context, "task-a");
  await settleAsyncReads();
  assert.ok(
    direct.store
      .getState()
      .tasks[0].messages.some((message) => message.id === "direct"),
    "direct compatibility calls remain usable outside an initRuntime lifetime",
  );
}

function testStoreResourcesOutliveRuntimeDisposal(): void {
  const harness = createRuntimeHarness();
  const runtime = harness.context.runtime;
  runtime.deletedTaskRuntimeTombstones.add("deleted-task");
  runtime.pendingPinTaskIds.add("pin-task");
  runtime.pendingMoveSpaceIds.add("moving-space");
  runtime.pendingMoveTaskIds.add("moving-task");
  runtime.pendingTaskMetadataHydrations.add("hydrating-task");
  runtime.externalHistoryHydrations.set("acp-task", 123);
  runtime.idCounter = 42;
  const moveChain = runtime.moveChain;
  const disposeOld = startRuntime(harness);
  const disposeNew = startRuntime(harness);
  disposeOld();
  disposeNew();
  assert.deepEqual([...runtime.deletedTaskRuntimeTombstones], ["deleted-task"]);
  assert.deepEqual([...runtime.pendingPinTaskIds], ["pin-task"]);
  assert.deepEqual([...runtime.pendingMoveSpaceIds], ["moving-space"]);
  assert.deepEqual([...runtime.pendingMoveTaskIds], ["moving-task"]);
  assert.deepEqual(
    [...runtime.pendingTaskMetadataHydrations],
    ["hydrating-task"],
  );
  assert.equal(runtime.externalHistoryHydrations.get("acp-task"), 123);
  assert.equal(runtime.idCounter, 42);
  assert.equal(
    runtime.moveChain,
    moveChain,
    "space/task moves retain the same shared serialization chain",
  );
}

async function main(): Promise<void> {
  testAdjacentDeltaBoundaries();
  testBackgroundFallbackAndFlushOrder();
  testDisposeDrainsOnceAndRejectsLateEvents();
  testBufferInstancesOwnTheirScheduling();
  testRuntimeReplacementOwnsAllSubscriptions();
  await testReplacedBootstrapAndSelectionReadsAreIgnored();
  await testDisposedCronReadsDoNotWrite();
  await testCurrentCronHistoryStillRestoresMessages();
  await testExternalHistoryFollowsItsRuntimeLifetime();
  testStoreResourcesOutliveRuntimeDisposal();
  console.log(
    "app store runtime: ok (stream ordering, lifecycle ownership, stale async reads, store resource lifetime)",
  );
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
