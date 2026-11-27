import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Document, Packer, Paragraph } from "docx";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { LibraryService } from "../src/main/library/LibraryService";
import { AgentLoadoutObservationService } from "../src/main/agent/AgentLoadoutObservationService";
import { DurableSkillProjection } from "../src/main/agent/durable/DurableSkillProjection";
import { MemorySkillEffectivenessService } from "../src/main/memory/MemorySkillEffectivenessService";
import { RuntimeContextSnapshotRepository } from "../src/main/agent/RuntimeContextSnapshotRepository";
import { TaskDiagnosticsRepository } from "../src/main/agent/TaskDiagnosticsRepository";
import { CodeReviewService } from "../src/main/agent/CodeReviewService";
import { ConversationGoalActivity } from "../src/main/agent/ConversationGoalActivity";
import { projectConversationRuntime, type RuntimeConversationGoalCreateReply } from "../src/main/agent/ConversationRuntimeData";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, minimumAuthorization } from "../src/shared/bot-work";
import { CoreBusinessClient, type CoreDomainEvent } from "../src/main/platform/core-business-client";
import { shutdownCoreWorker } from "../src/main/platform/core-client";
import { locateRuntimeAudit, RuntimeAuditReader, RuntimeAuditUnknownOperationError } from "../src/main/platform/runtime-audit";
import type { RuntimeMaterialUseDto } from "../src/shared/agent-ipc";
import type { ConversationGoalUpdateRequest } from "../src/shared/conversation-goal";
import type { ToolDiagnosticEvent } from "../src/shared/task-diagnostics";

const executable = process.env.RUNTIME_AUDIT_BINARY ?? locateRuntimeAudit(process.cwd());
assert(executable && existsSync(executable), "This test requires the supervised Core worker");
const root = realpathSync(mkdtempSync(join(tmpdir(), "mybuddy-core-observability-")));
const database = join(root, "app.duckdb");
const options = { runtimeAuditExecutable: executable, runtimeAuditSupervised: true };
const worker = new RuntimeAuditReader(executable, database, { coreDataDirectory: root, coreRole: "background-service" });
let application: AppDatabase | undefined;
const at = Date.now();
const input = (taskId: string, executionId: string) => ({
  taskId, executionId, assistantMessageId: `${executionId}-assistant`, userMessageId: "user", status: "running" as const,
  startedAt: at, mode: "coding" as const, assemblyHash: "assembly", workingDirectory: root,
  resolvedInstructions: [{ id: "instructions", title: "Instructions", source: "seed" as const, chars: 9, content: "same body" }],
  resolvedCapabilities: [], warnings: [],
});

async function verifyIndependentLibraryRecovery(app: AppDatabase) {
  const reader = app.runtimeAuditReader!;
  const libraryRoot = join(root, "index-concurrency-library");
  const library = new LibraryService(app, { libraryRoot });
  const first = { id: "concurrent-library-a", spaceId: "independent-library-a", text: "calibration apple original" };
  const second = { id: "concurrent-library-b", spaceId: "independent-library-b", text: "bandwidth banana original" };
  const mime = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
  const seedFile = async ({ id, spaceId, itemKind, filename, mimeType, content }: {
    id: string; spaceId: string; itemKind: "office" | "markdown"; filename: string; mimeType: string; content: Buffer;
  }) => {
    assert.deepEqual(await reader.batch3Write({ kind: "libraryInsertItem", id, spaceId, itemKind, title: id,
      filename, mimeType, sizeBytes: content.length, owner: "fixture", favorite: 0,
      sourceType: "import", contentHash: createHash("sha256").update(content).digest("hex"),
      extractStatus: itemKind === "office" ? "pending" : undefined,
      createdAt: at, updatedAt: at }), { ok: true });
    const [item] = (await library.readSnapshot({ itemId: id })).items;
    assert(item);
    mkdirSync(join(libraryRoot, spaceId), { recursive: true });
    writeFileSync(library.absolutePath(item), content);
  };
  for (const { id, spaceId, text } of [first, second]) {
    assert.deepEqual(await reader.batch3Write({ kind: "libraryInsertSpace", id: spaceId, name: spaceId,
      spaceKind: "personal", createdAt: at, updatedAt: at }), { ok: true });
    const content = await Packer.toBuffer(new Document({ sections: [{ children: [new Paragraph(text)] }] }));
    await seedFile({ id, spaceId, itemKind: "office", filename: `${id}.docx`, mimeType: mime, content });
  }
  const aWaiting = Promise.withResolvers<void>();
  const releaseA = Promise.withResolvers<void>();
  const bPublished = Promise.withResolvers<void>();
  const publish = reader.publishLibraryDocument.bind(reader);
  reader.publishLibraryDocument = async request => {
    if (request.item.id === first.id) {
      assert(request.content.kind === "extracted" && request.content.text?.includes(first.text));
      aWaiting.resolve();
      await releaseA.promise;
    }
    const result = await publish(request);
    if (request.item.id === second.id) {
      assert(request.content.kind === "extracted" && request.content.text?.includes(second.text));
      assert.equal(result, "indexed");
      bPublished.resolve();
    }
    return result;
  };
  const deadline = new AbortController();
  const recovery = Promise.all([aWaiting.promise, bPublished.promise]);
  try {
    const scheduled = library.recoverPendingExtractions();
    await Promise.race([Promise.all([scheduled, recovery]), delay(8000, undefined, { signal: deadline.signal })
      .then(() => { throw new Error("independent document recovery did not progress"); })]);
    assert.equal(await scheduled, 2);
    assert.equal((await library.readSnapshot({ itemId: first.id })).items[0]?.extractStatus, "pending");
    assert.equal((await library.readSnapshot({ itemId: second.id })).items[0]?.extractStatus, "extracted");
  } finally {
    deadline.abort();
    releaseA.resolve();
    await library.flushPendingIndexes();
    reader.publishLibraryDocument = publish;
  }
  assert.equal((await library.readSnapshot({ itemId: first.id })).items[0]?.extractStatus, "extracted");
  assert.equal(await library.recoverPendingExtractions(), 0);
  console.log("PASS Core library recovers two real DOCX sources concurrently across independent spaces");

  await seedFile({ id: "concurrent-library-text", spaceId: first.spaceId, itemKind: "markdown", filename: "recovery.md",
    mimeType: "text/markdown", content: Buffer.from("# Independently repaired document\n\nA persisted heading and body.") });
  assert.deepEqual(await library.backfillMissingChunks(), { processed: 1, succeeded: 1, failed: 0, skipped: 0 });
  assert.deepEqual(await library.recoverTextFtsCoverageV2(), { processed: 1, failed: 0 });
  assert.equal((await library.backfillMissingChunks()).processed, 0);
  assert.deepEqual(await library.recoverTextFtsCoverageV2(), { processed: 0, failed: 0 });
  console.log("PASS Core library repairs missing text and chunk indexes once");
}

async function verifyLoadoutProjection(app: AppDatabase) {
  const peer = await AppDatabase.open(database, options);
  const first = new AgentLoadoutObservationService(app);
  const second = new AgentLoadoutObservationService(peer);
  const firstEffectiveness = new MemorySkillEffectivenessService(app);
  const secondEffectiveness = new MemorySkillEffectivenessService(peer);
  const original = new DurableSkillProjection(first, firstEffectiveness);
  const replay = new DurableSkillProjection(second, secondEffectiveness);
  type Entry = Parameters<DurableSkillProjection["entries"]>[2][number];
  const entry = (kind: Entry["kind"], data: object) => ({ kind, data } as Entry);
  const audit = { userMessageId: "loadout-user", assistantMessageId: "loadout-assistant", cwd: root,
    skills: [{ id: "reference-skill", name: "Reference", path: join(root, "reference.md") }],
    recommendation: { query: "Find the reference", mode: "working", context: { memoryIds: [], scenarioIds: [], profileIds: [] },
      capabilities: [{ kind: "skill", id: "reference-skill", label: "Reference", score: 10, recommended: true, actual: true, blocked: false,
        evidence: [{ source: "query", label: "Reference matched the user request" }] }] } };
  const user = entry("mybuddy.user", { mybuddyInput: { audit } });
  const learned = entry("mybuddy.user", { mybuddyInput: { audit: { ...audit, skills: audit.skills.map(skill => ({
    ...skill, learned: { skillId: skill.id, sourceMemoryIds: ["reference-memory"] },
  })) } } });
  try {
    assert.equal(peer.fixtureConnection, undefined);
    original.entries("task-a", "first", [learned]);
    original.started("task-a", "first");
    replay.entries("task-a", "first", [user]);
    replay.started("task-a", "first");
    await Promise.all([first.flush(), second.flush()]);
    const [pending] = await second.readList("task-a");
    assert.equal(pending.outcome, "pending");
    assert.deepEqual(pending.recommended[0]?.evidence, [{ source: "query", label: "Reference matched the user request" }]);

    original.entries("task-a", "first", [
      entry("mybuddy.skill-read", { callId: "read-reference", path: join(root, "reference.md"), userMessageIds: [audit.userMessageId], at }),
      entry("mybuddy.input-outcome", { userMessageId: audit.userMessageId, assistantMessageId: audit.assistantMessageId, outcome: "completed", at }),
    ]);
    await first.flush();
    replay.started("task-a", "first");
    const complete = await second.readList("task-a");
    assert.equal(complete.length, 1);
    assert.equal(complete[0].id, pending.id);
    assert.equal(complete[0].outcome, "completed");
    assert.deepEqual(complete[0].usedSkillIds, ["reference-skill"]);

    original.entries("task-b", "second", [user]);
    original.started("task-b", "second");
    first.abortPendingForTask("task-b");
    await first.flush();
    assert.equal(await second.clearSaved("task-a"), 1);
    assert.equal(await second.clearSaved("task-a"), 0);
    assert.deepEqual(await first.readList("task-a"), []);
    assert.deepEqual((await second.readList("task-b")).map(row => [row.assistantMessageId, row.outcome]), [[audit.assistantMessageId, "aborted"]]);
    console.log("PASS Core replays one durable loadout without erasing skill evidence, and scoped clear preserves another task");
    await app.writeTaskRecord({ id: "retired-loadout-task", title: "Retired loadout task", updatedAt: at });
    original.entries("retired-loadout-task", "retired", [user]);
    original.started("retired-loadout-task", "retired");
    await first.flush();
    assert.equal((await second.readList("retired-loadout-task")).length, 1);
    assert.deepEqual(await app.runtimeAuditReader!.batch2Write({ kind: "deleteTask", id: "retired-loadout-task" }), { ok: true });
    assert.deepEqual(await second.readList("retired-loadout-task"), [], "task deletion removes its saved Loadout observations");
    replay.entries("retired-loadout-task", "retired", [user]);
    replay.started("retired-loadout-task", "retired");
    await second.flush();
    await app.writeTaskRecord({ id: "retired-loadout-task", title: "Recreated task", updatedAt: at });
    assert.deepEqual(await first.readList("retired-loadout-task"), []);
    console.log("PASS Core removes loadout observations with the task and refuses late observations for the deleted task");
  } finally {
    await Promise.all([first.flush(), second.flush(), firstEffectiveness.flush(), secondEffectiveness.flush()]);
    await peer.runtimeAuditReader?.close();
    peer.close();
  }
}

async function verifyConversationRuntime(app: AppDatabase, ui: RuntimeAuditReader, host: RuntimeAuditReader) {
  const active = "conversation-goal", closed = "completed-goal", privateWork = "other-user-goal";
  const question = { kind: "interactionInsert", id: "runtime-question", taskId: "task-a", executionId: "question-execution",
    assistantMessageId: "question-message", kindName: "short_text", title: "Choose a scope", optionsJson: "[]", allowCustom: 1,
    status: "pending", version: 1, createdAt: at };
  await app.writeTaskRecord({ id: "historical-execution", title: "Prior execution", updatedAt: at });
  const bots = new BotRegistry(undefined, host);
  await bots.ensureDefaultBotSaved(LOCAL_USER_ID);
  await bots.registerSaved({ botId: "other-user-bot", userId: "other-user", displayName: "Other" });
  const work = (workId: string, userId: string, done = false) => ({ op: "workInsert", workId, userId, title: workId,
    ownerBotId: userId === LOCAL_USER_ID ? DEFAULT_BOT_ID : "other-user-bot", ownerEpoch: 1, intentRevision: 2, sourceVersion: 1,
    mode: "once", lifecycle: done ? "closed" : "active", constraintsJson: "[]", authorizationJson: JSON.stringify(minimumAuthorization()),
    criteriaJson: JSON.stringify([{ id: "criterion", text: "Inspect the source", status: "satisfied", evidenceRefs: ["proof"] }]),
    activeIntentSnapshotId: `${workId}-intent`, inputSnapshotId: `${workId}-input`, goalSourcesJson: "[]",
    sourceMessageId: "source-message", acceptedDeliverableIdsJson: "[]", activeExecutionIdsJson: "[]", causalPolicyJson: "{}",
    deadlineRevision: 1, stateVersion: 3, createdBy: "user", createdAt: at + Number(!done), updatedAt: at + 3,
    ...(done ? { closedAt: at + 3, closureConclusion: "succeeded", closureSummary: "Verified" } : {}),
  });
  const source = { taskId: "task-a", conversationId: "source-conversation", messageId: "source-message", role: "user", text: "Check this" };
  const linked = [active, closed, privateWork].map(workId => ({ op: "workConversationLink", workId, conversationId: "task-a",
    channelType: "desktop", lastReferencedAt: at }));
  const seeded = await host.batch4bWrite<{ ok: boolean }>({ op: "batch", ops: [
    work(active, LOCAL_USER_ID), work(closed, LOCAL_USER_ID, true), work(privateWork, "other-user"), ...linked,
    { op: "workGoalSourceInsert", workId: active, sourceJson: JSON.stringify(source) },
    { op: "workBlockerInsert", blockerId: "work-blocker", workId: active, reason: "Waiting for the source document",
      kind: "operational", detailsJson: "{}", waitingForUserInput: 1, status: "open", createdAt: at },
    { op: "goalContinuationUpsert", workId: active, taskId: "task-a", intentRevision: 2, attempts: 1, attemptSerial: 1,
      tokensUsed: 31, tokensBudget: 60, timeUsedSeconds: 0, usageCursor: 31, progressStalls: 1, runCursor: 0,
      state: "deferred", deferReason: "no_progress", deferredAt: at + 6, updatedAt: at + 6 },
    { op: "goalCheckUpsert", workId: active, taskId: "task-a", intentRevision: 1, trigger: "settled", reason: "obsolete check", at: at },
    { op: "goalWakeUpsert", workId: active, taskId: "task-a", intentRevision: 2, trigger: "resumed", at: at + 5 },
    { op: "workBindingInsert", bindingId: "old-execution", workId: active, operationId: "admission", botId: DEFAULT_BOT_ID,
      taskId: "historical-execution", durableStoreKey: "old-store", conversationId: "old-conversation", intentRevision: 1,
      ownerEpoch: 1, inputSnapshotId: "old-input", expertSnapshotJson: "{}", delegatedScopeJson: "[]", workspaceBinding: root,
      admittedAt: at, invalidatedAt: at + 3, status: "invalidated" },
  ] });
  assert.equal(seeded?.ok, true);
  const insert = await ui.batch1Write<{ row: unknown }>(question);
  assert(insert?.row);
  const snapshot = await host.readConversationRuntime("task-a", LOCAL_USER_ID);
  assert(snapshot);
  const dto = projectConversationRuntime("task-a", snapshot, { enabled: true, maxAttempts: 5, tokenBudget: 200 });
  assert.deepEqual(dto.goals?.map(goal => [goal.id, goal.status]), [[active, "blocked"], [closed, "achieved"]]);
  assert.equal(dto.activeGoal?.waitingReason, "Waiting for the source document");
  assert.deepEqual(dto.activeGoal?.source, source);
  assert.deepEqual(dto.activeGoal?.criteria, [{ id: "criterion", text: "Inspect the source", status: "met", evidence: "1 项证据" }]);
  assert.deepEqual(dto.activeGoal?.continuation?.lastWake, { trigger: "resumed", at: at + 5 });
  assert.equal(dto.activeGoal?.continuation?.lastCheck, undefined);
  assert.equal(dto.activeGoal?.continuation?.tokenBudget, 60);
  assert.deepEqual(dto.interactions.map(row => [row.id, row.status]), [[question.id, "pending"]]);
  assert.deepEqual(await host.readWorkTaskAccess("task-a"), { taskExists: true, hasWorkBinding: false });
  assert.deepEqual(await ui.readWorkTaskAccess("historical-execution"), { taskExists: true, hasWorkBinding: true });
  assert.equal((await ui.readConversationRuntime("historical-execution", LOCAL_USER_ID))?.goals[0]?.live, true);
  assert.deepEqual((await ui.readConversationRuntime("historical-execution", "other-user"))?.goals, []);
  assert.equal(await ui.readConversationRuntime("removed-task", LOCAL_USER_ID), null);
  assert.deepEqual(await host.batch1Write({ ...question, id: "duplicate-execution", taskId: "task-b" }), { row: null });
  assert.deepEqual(await host.batch1Write({ ...question, id: "no-task", taskId: "removed-task" }), { row: null });
  console.log("PASS Core reads questions, scoped Work, evidence and current continuation status; historical bindings remain identifiable");
}

async function verifyGoalCreation(app: AppDatabase, ui: RuntimeAuditReader, host: RuntimeAuditReader, stream: CoreBusinessClient) {
  const draft = { userId: LOCAL_USER_ID, taskId: "goal-retry", defaultBotId: DEFAULT_BOT_ID, title: " Verify receipts ",
    description: "Cover concurrent creation", criteria: ["Inspect the result", " "] };
  const operation = "create-concurrent-goal";
  for (const id of [draft.taskId, "goal-race", "goal-source", "goal-queue-anchor"]) {
    await app.writeTaskRecord({ id, title: id, updatedAt: at });
  }
  const anchor = await ui.createConversationGoal("goal-projection-anchor", { ...draft, taskId: "goal-queue-anchor" });
  assert(anchor?.ok);
  const anchorDeadline = Date.now() + 8_000;
  let queue = await ui.readWorkQueue({ userId: LOCAL_USER_ID, includeClosed: false });
  while ((queue?.kind !== "snapshot" || !queue.workIds.includes(anchor.goal.work_id) || queue.cursor.sequence < 1)
    && Date.now() < anchorDeadline) {
    await delay(25);
    queue = await ui.readWorkQueue({ userId: LOCAL_USER_ID, includeClosed: false });
  }
  assert(queue?.kind === "snapshot" && queue.workIds.includes(anchor.goal.work_id) && queue.cursor.sequence >= 1);
  const head = await stream.eventsSnapshot();
  const received: CoreDomainEvent[] = [];
  stream.onCoreEvent(event => { if (event.kind === "work.created") received.push(event); });
  assert((await stream.subscribeCursor(head.coreGeneration, head.headSeq)).subscribed);
  const replies = await Promise.all([ui.createConversationGoal(operation, draft), host.createConversationGoal(operation, draft)]);
  const [a, b] = replies;
  assert(a?.ok && b?.ok);
  assert.deepEqual([a.replayed, b.replayed].sort(), [false, true]);
  assert.deepEqual(a.goal, b.goal);
  assert.equal(a.goal.title, "Verify receipts");
  assert.equal(a.goal.continuation_task_id, draft.taskId);
  assert.equal(a.goal.continuation_state, "idle");
  assert.equal(a.goal.tokens_used, 0);
  assert.deepEqual(JSON.parse(a.goal.criteria_json).map((item: { text: string }) => item.text), ["Inspect the result"]);
  assert.deepEqual((await host.readConversationRuntime(draft.taskId, LOCAL_USER_ID))?.goals, [a.goal]);
  const changed = await host.createConversationGoal(operation, { ...draft, taskId: "goal-race" });
  assert(changed && !changed.ok);
  assert.equal(changed.code, "conflict");

  const race = await Promise.all([ui.createConversationGoal("goal-race-first", { ...draft, taskId: "goal-race" }),
    host.createConversationGoal("goal-race-second", { ...draft, taskId: "goal-race", title: "Another candidate" })]);
  const winning = race.find(reply => reply?.ok);
  const losing = race.find(reply => reply?.ok === false);
  assert(winning?.ok && losing && !losing.ok);
  assert.equal(losing.code, "conflict");
  assert.deepEqual((await host.readConversationRuntime("goal-race", LOCAL_USER_ID))?.goals, [winning.goal]);

  const source = { taskId: "goal-source", messageId: "user-message", conversationId: "history-conversation", entryId: "42",
    role: "user" as const, text: "Use this exact request as the goal" };
  const fromSource = await ui.createConversationGoal("goal-source-first", { ...draft, taskId: source.taskId, source });
  const sourceReplay = await host.createConversationGoal("goal-source-second", { ...draft, taskId: source.taskId, source });
  assert(fromSource?.ok && sourceReplay?.ok && sourceReplay.replayed);
  assert.equal(fromSource.goal.work_id, sourceReplay.goal.work_id);
  assert.deepEqual(JSON.parse(fromSource.goal.source_json!), source);
  const historical = await host.createConversationGoal("goal-foreign", { ...draft, taskId: "historical-execution" });
  assert(historical && !historical.ok);
  assert.equal(historical.code, "not_found");
  const otherUser = await host.createConversationGoal("goal-other-user", { ...draft, userId: "other-user" });
  assert(otherUser && !otherUser.ok);
  assert.deepEqual((await host.readConversationRuntime(draft.taskId, "other-user"))?.goals, []);

  const ids = [a.goal.work_id, winning.goal.work_id, fromSource.goal.work_id].sort();
  const deadline = Date.now() + 8_000;
  let cursor = queue.cursor;
  while (true) {
    const delta = await host.readWorkQueue({ userId: LOCAL_USER_ID, includeClosed: false, cursor: queue.cursor });
    assert(delta?.kind === "delta");
    const published = delta.events.filter(event => ids.includes(event.workId));
    if (published.length >= ids.length || Date.now() >= deadline) {
      assert.deepEqual(published.filter(event => event.kind === "upsert").map(event => event.workId).sort(), ids);
      cursor = delta.cursor;
      break;
    }
    await delay(25);
  }
  while (received.length < ids.length && Date.now() < deadline) await delay(25);
  const replay = await stream.eventsReplay(head.headSeq, head.coreGeneration);
  assert.equal(replay.gap, false);
  const eventIds = (events: CoreDomainEvent[]) => events.filter(event => event.kind === "work.created").map(event => event.entityId).sort();
  assert.deepEqual(eventIds(received), ids);
  assert.deepEqual(eventIds(replay.events), ids);
  console.log("PASS Core creates one Goal under duplicate retries, serializes same-task competitors and publishes one Work event per Goal");
  return { operation, draft, goal: a.goal, cursor };
}

async function verifyGoalMutations(app: AppDatabase, ui: RuntimeAuditReader, host: RuntimeAuditReader, coreExecutable: string) {
  const taskId = "goal-mutation-task";
  await app.writeTaskRecord({ id: taskId, title: "Goal mutation task", updatedAt: at });
  const created = await ui.createConversationGoal("goal-mutation-seed", { userId: LOCAL_USER_ID, taskId,
    defaultBotId: DEFAULT_BOT_ID, title: "Original Goal", criteria: ["Inspect the result"] });
  assert(created?.ok);
  const goalId = created.goal.work_id;
  const connectUi = (clientId: string) => CoreBusinessClient.connect(coreExecutable, database, { dataDirectory: root, role: "ui", clientId });
  const clients: CoreBusinessClient[] = [];
  const settings = { enabled: true, maxAttempts: 4, tokenBudget: 900 };
  const requestFor = (goal: typeof created.goal) => ({ userId: LOCAL_USER_ID, taskId, goalId,
    expectedStateVersion: goal.state_version, expectedIntentRevision: goal.intent_revision, expectedOwnerEpoch: goal.owner_epoch,
    defaultTokenBudget: settings.tokenBudget });
  type Mutation = ReturnType<typeof requestFor> & Pick<ConversationGoalUpdateRequest, "status" | "title" | "tokenBudget">;
  const mutate = (client: CoreBusinessClient, operationId: string, mutation: Mutation) =>
    client.request<RuntimeConversationGoalCreateReply>({ operation: "mutateConversationGoal", operationId, mutation });
  const readGoal = async (client: RuntimeAuditReader) => {
    const snapshot = await client.readConversationRuntime(taskId, LOCAL_USER_ID);
    assert(snapshot);
    const view = projectConversationRuntime(taskId, snapshot, settings);
    assert(view.goals && view.goals.length === 1);
    return { goal: view.goals[0], activeGoal: view.activeGoal };
  };
  try {
    for (const clientId of ["goal-mutation-ui-a", "goal-mutation-ui-b"]) clients.push(await connectUi(clientId));
    const [firstClient, secondClient] = clients;
    const initial = (await readGoal(ui)).goal;
    assert.deepEqual([initial.title, initial.status, initial.version, initial.continuation?.tokenBudget],
      ["Original Goal", "active", created.goal.state_version, 900]);
    const edits = [
      { client: firstClient, operation: "goal-mutation-edit-a", title: "Edited by the first client", budget: 1100 },
      { client: secondClient, operation: "goal-mutation-edit-b", title: "Edited by the second client", budget: 2200 },
    ].map(edit => ({ ...edit, mutation: { ...requestFor(created.goal), title: edit.title, tokenBudget: edit.budget } }));
    const replies = await Promise.all(edits.map(({ client, operation, mutation }) => mutate(client, operation, mutation)));
    assert.equal(replies.filter(reply => reply?.ok).length, 1);
    const winnerIndex = replies.findIndex(reply => reply?.ok);
    const winner = edits[winnerIndex];
    const edited = replies[winnerIndex];
    const stale = replies[1 - winnerIndex];
    assert(edited?.ok && !edited.replayed && stale && !stale.ok);
    assert.equal(stale.code, "conflict");
    assert.equal(edited.goal.intent_revision, created.goal.intent_revision + 1);
    const editedView = (await readGoal(ui)).goal;
    assert.deepEqual([editedView.title, editedView.status, editedView.version, editedView.continuation?.tokenBudget],
      [winner.title, "active", created.goal.state_version + 1, winner.budget]);
    assert.deepEqual(editedView.criteria.map(criterion => [criterion.text, criterion.status]), [["Inspect the result", "pending"]]);

    const retry = async (client: CoreBusinessClient) => {
      assert.deepEqual(await mutate(client, winner.operation, winner.mutation), { ...edited, replayed: true });
    };
    await retry(edits[1 - winnerIndex].client);
    const reused = await mutate(secondClient, winner.operation, { ...winner.mutation, title: "Different payload on retry" });
    assert(reused && !reused.ok);
    assert.equal(reused.code, "conflict");
    const wrongTask = await mutate(secondClient, "goal-mutation-wrong-task", { ...requestFor(edited.goal), taskId: "task-b", status: "cancelled" });
    assert(wrongTask && !wrongTask.ok);
    assert.equal(wrongTask.code, "not_found");
    assert.deepEqual((await readGoal(ui)).goal, editedView);

    assert.deepEqual(await host.batch4bWrite({ op: "goalContinuationUpsert", workId: goalId, taskId,
      intentRevision: edited.goal.intent_revision, attempts: 2, attemptSerial: 3, tokensUsed: 150, tokensBudget: winner.budget,
      timeUsedSeconds: 12, usageCursor: 150, progressStalls: 0, runCursor: 0, state: "idle", updatedAt: Date.now() }), { ok: true });
    const budgeted = await mutate(firstClient, "goal-mutation-default-budget", { ...requestFor(edited.goal), tokenBudget: null });
    assert(budgeted?.ok && !budgeted.replayed);
    assert.equal(budgeted.goal.intent_revision, edited.goal.intent_revision);
    const budgetView = (await readGoal(ui)).goal;
    assert.deepEqual([budgetView.version, budgetView.continuation?.tokenBudget, budgetView.continuation?.tokensUsed,
      budgetView.continuation?.attempts], [editedView.version + 1, 900, 150, 2]);
    const stalePause = await mutate(secondClient, "goal-mutation-stale-pause", { ...requestFor(edited.goal), status: "paused" });
    assert(stalePause && !stalePause.ok);
    assert.equal(stalePause.code, "conflict");
    assert.deepEqual((await readGoal(ui)).goal, budgetView);

    const paused = await mutate(secondClient, "goal-mutation-pause", { ...requestFor(budgeted.goal), status: "paused" });
    assert(paused?.ok && !paused.replayed);
    const pausedView = (await readGoal(ui)).goal;
    assert.deepEqual([pausedView.status, pausedView.version, pausedView.continuation?.state, pausedView.continuation?.deferReason,
      pausedView.continuation?.tokenBudget, pausedView.continuation?.tokensUsed],
      ["paused", budgetView.version + 1, "deferred", "manual_stop", 900, 150]);
    const cancelled = await mutate(firstClient, "goal-mutation-cancel", { ...requestFor(paused.goal), status: "cancelled" });
    assert(cancelled?.ok && !cancelled.replayed);
    const cancelledView = await readGoal(ui);
    assert.deepEqual([cancelledView.goal.title, cancelledView.goal.status, cancelledView.goal.version,
      cancelledView.goal.closureConclusion, cancelledView.activeGoal],
      [winner.title, "cancelled", pausedView.version + 1, "cancelled", undefined]);
    await retry(secondClient);
    assert.deepEqual(await readGoal(ui), cancelledView);
    return async (reopened: RuntimeAuditReader) => {
      const reconnected = await connectUi("goal-mutation-ui-reopened");
      await retry(reconnected).finally(() => reconnected.close());
      const persisted = await readGoal(reopened);
      assert.deepEqual([persisted.goal.title, persisted.goal.status, persisted.goal.version, persisted.activeGoal],
        [winner.title, "cancelled", cancelledView.goal.version, undefined]);
      console.log("PASS two Core UI clients race on Goal edits, preserve usage when changing budget, reject wrong tasks, and replay the edit across pause, cancellation and restart");
    };
  } finally {
    await Promise.all(clients.map(client => client.close()));
  }
}

try {
  application = await AppDatabase.open(database, options);
  const ui = application.runtimeAuditReader!;
  for (const id of ["task-a", "task-b"]) await application.writeTaskRecord({ id, title: id, updatedAt: at });
  await verifyConversationRuntime(application, ui, worker);
  const stream = await CoreBusinessClient.connect(executable, database, { dataDirectory: root, role: "ui" });
  const created = await verifyGoalCreation(application, ui, worker, stream).finally(() => stream.close());
  const verifyDurableGoalMutation = await verifyGoalMutations(application, ui, worker, executable);
  const activity = new ConversationGoalActivity(undefined, worker);
  const owner = { goalId: created.goal.work_id, intentRevision: created.goal.intent_revision, ownerEpoch: created.goal.owner_epoch };
  const generation = { taskId: created.draft.taskId, conversationId: "goal-generation", generationTaskId: 12 };
  const child = { taskId: generation.taskId, conversationId: "goal-child", generationTaskId: 13 };
  const settled = new Map<string, unknown>();
  const foreignEntered = Promise.withResolvers<void>();
  const releaseForeign = Promise.withResolvers<void>();
  const writeActivity: RuntimeAuditReader["batch1Write"] = worker.batch1Write.bind(worker);
  worker.batch1Write = async <T = unknown>(request: Record<string, unknown>): Promise<T | undefined> => {
    if (request.kind === "goalActivitySettle" && request.taskId === "task-b") {
      foreignEntered.resolve();
      await releaseForeign.promise;
    }
    const reply = await writeActivity<T>(request);
    if (request.kind === "goalActivitySettle") settled.set(String(request.messageId), reply);
    return reply;
  };
  try {
    activity.settle({ ...generation, taskId: "task-b" }, "completed", "other-assistant");
    await foreignEntered.promise;
    activity.admit(generation.taskId, { ...generation, inputs: [{ owner, assistantMessageId: "pending-assistant" }] });
    activity.admit(child.taskId, { ...child, parent: generation,
      child: { id: "worker", displayName: "Worker", role: "review", model: "fixture" } });
    activity.admit("task-b", { ...child, parent: generation });
    activity.admit(generation.taskId, { ...generation, generationTaskId: 14,
      inputs: [{ owner: { ...owner, ownerEpoch: owner.ownerEpoch + 1 }, assistantMessageId: "wrong-epoch" }] });
    activity.settle(generation, "completed", "final-assistant");
    activity.settle(child, "failed", "child-assistant");
    assert.equal(await Promise.race([activity.flush(generation.taskId).then(() => "settled"), delay(5_000, "blocked", { ref: false })]), "settled");
    assert.equal(settled.has("other-assistant"), false);
    releaseForeign.resolve();
    await activity.flush();
  } finally {
    releaseForeign.resolve();
    worker.batch1Write = writeActivity;
  }
  assert.deepEqual(settled, new Map<string, unknown>([["final-assistant", { owner }], ["child-assistant", { owner }], ["other-assistant", { owner: null }]]));
  const inherited = await activity.readGeneration(child);
  assert.equal(inherited?.goalId, owner.goalId);
  assert.equal(inherited?.intentRevision, owner.intentRevision);
  assert.equal(inherited?.ownerEpoch, owner.ownerEpoch);
  assert.equal(inherited?.status, "failed");
  assert.deepEqual(inherited?.parent, { conversationId: generation.conversationId, generationTaskId: generation.generationTaskId });
  assert.equal(await activity.readGeneration({ ...child, taskId: "task-b" }), undefined);
  assert.equal(await activity.readGeneration({ ...generation, generationTaskId: 14 }), undefined);
  assert.deepEqual(await worker.readConversationGoalActivityOwner(generation.taskId, LOCAL_USER_ID, generation.conversationId, "final-assistant"), owner);
  assert.equal(await ui.readConversationGoalActivityOwner(generation.taskId, "other-user", generation.conversationId, "final-assistant"), null);
  assert.equal((await ui.readConversationRuntime(generation.taskId, LOCAL_USER_ID))?.goals[0]?.lifecycle, "active");
  console.log("PASS the Core worker admits child lineage, settles only the matching task and owner epoch, and leaves the Goal open");
  const a = new RuntimeContextSnapshotRepository(undefined, ui);
  const first = input("task-a", "first");
  a.capture(first);
  await a.flush();
  const b = new RuntimeContextSnapshotRepository(undefined, worker);
  b.capture(input("task-b", "second"));
  const material: RuntimeMaterialUseDto = { toolCallId: "tool", toolName: "read", at, kind: "file-content", target: "source.md",
    title: "Source", outputHash: "hash", returnedChars: 6, images: 0, partial: false };
  a.appendMaterials(first, [material, material]);
  await Promise.all([a.flush(), b.flush()]);
  assert.deepEqual((await b.readList("task-a"))[0]?.materialUsage, { items: [material], omitted: 0 });
  assert.equal(await worker.mutateSnapshot("wrong-task", { kind: "finish", taskId: "task-b", executionId: first.executionId,
    status: "completed", at }), 0);
  assert.equal((await b.readList("task-a"))[0]?.status, "running");
  const original: RuntimeAuditReader["mutateSnapshot"] = ui.mutateSnapshot.bind(ui);
  const pausedFinish = Promise.withResolvers<void>();
  const enteredFinish = Promise.withResolvers<void>();
  ui.mutateSnapshot = async (id, mutation) => {
    if (mutation.kind === "finish" && mutation.taskId === "task-a") {
      enteredFinish.resolve();
      await pausedFinish.promise;
    }
    return original(id, mutation);
  };
  try {
    a.finish("task-a", first.executionId, "completed");
    a.appendMaterials(first, [{ ...material, toolCallId: "late" }]);
    await enteredFinish.promise;
    a.capture(input("task-b", "second-from-ui"));
    const otherTask = await Promise.race([
      a.readList("task-b"),
      delay(3_000, undefined, { ref: false }).then(() => null),
    ]);
    assert(otherTask?.some(row => row.executionId === "second-from-ui"));
  } finally {
    pausedFinish.resolve();
    ui.mutateSnapshot = original;
    await a.flush();
  }
  assert.equal((await a.readList("task-a"))[0]?.status, "completed");
  assert.deepEqual((await b.readList("task-a"))[0]?.materialUsage?.items, [material]);
  assert.equal((await a.readList("task-b"))[0]?.resolvedInstructions[0]?.content, "same body");
  assert.equal(await ui.compactSnapshots(), 3);
  console.log("PASS each producer keeps writing across host attachment and a blocked task; late and wrong-task mutations cannot change a snapshot");

  let cleared!: Parameters<typeof original>;
  ui.mutateSnapshot = async (...args) => {
    const result = await original(...args);
    if (args[1].kind !== "clear" || cleared) return result;
    cleared = args;
    assert.equal(result, 1);
    b.capture(input("task-a", "after-clear"));
    await b.flush();
    throw new RuntimeAuditUnknownOperationError("lost-reply", "mutateSnapshot");
  };
  assert.equal(await a.clearSaved("task-a"), 1);
  ui.mutateSnapshot = original;
  assert.equal(await worker.mutateSnapshot(...cleared), 1);
  await assert.rejects(worker.mutateSnapshot(cleared[0], { kind: "clear", taskId: "task-b" }));
  assert.deepEqual((await a.readList("task-a")).map(row => row.executionId), ["after-clear"]);
  assert.equal(await ui.compactSnapshots(), 1);
  assert.equal((await b.readList("task-b"))[0]?.resolvedInstructions[0]?.content, "same body");
  console.log("PASS lost snapshot deletion replies recover the original count without deleting newer snapshots or shared payloads");

  const firstDiagnostics = new TaskDiagnosticsRepository(undefined, ui);
  const providerModel = { provider: "fixture", id: "diagnostic-model", api: "fixture" };
  const usageIdentity = { request: "provider-core-usage", at, taskId: "task-a", executionScope: "task-a", conversationId: "9",
    generationTaskId: 7, sourceKind: "main" };
  const reportedUsage = { input: 24, output: 5, cacheRead: 0, cacheWrite: null };
  firstDiagnostics.observeTrace({ ...usageIdentity, event: "execution" }, providerModel);
  firstDiagnostics.observeTrace({ ...usageIdentity, event: "result", reportedUsage, outcome: "completed",
    nativeCostTotal: 0.125, nativeCostSource: "provider-reported", nativeCostComplete: true }, providerModel);
  const measured = { ...reportedUsage, costTotal: 0.125 };
  assert.deepEqual(firstDiagnostics.usageForGeneration("task-a", "9", 7), measured);
  await firstDiagnostics.flush();
  assert.deepEqual(firstDiagnostics.usageForGeneration("task-a", "9", 7), measured);
  assert.equal(firstDiagnostics.usageForGeneration("task-b", "9", 7).input, null);
  assert.deepEqual((await worker.diagnostics("task-a"))?.requests.find(row => row.id === usageIdentity.request)?.usage, reportedUsage);
  console.log("PASS live Core usage stays associated with the reporting generation before and after the diagnostics write drains");
  const tool = (taskId: string, phase: ToolDiagnosticEvent["phase"], timestamp: number): ToolDiagnosticEvent => ({
    phase, taskId, conversationId: "9", toolTaskId: 1, generationTaskId: 7, callId: `tool-${taskId}`,
    name: "read", sourceKind: "main", at: timestamp,
  });
  firstDiagnostics.observeTool(tool("task-a", "start", at));
  await firstDiagnostics.flush();
  const secondDiagnostics = new TaskDiagnosticsRepository(undefined, worker);
  const send: RuntimeAuditReader["writeDiagnostics"] = worker.writeDiagnostics.bind(worker);
  let committed!: Parameters<typeof send>;
  worker.writeDiagnostics = async (...args) => {
    const saved = await send(...args);
    if (!committed) {
      assert.equal(saved, true);
      committed = args;
      throw new RuntimeAuditUnknownOperationError("lost-batch-reply", "writeDiagnostics");
    }
    return saved;
  };
  secondDiagnostics.observeTool(tool("task-b", "start", at));
  secondDiagnostics.observeTool(tool("task-b", "finish", at + 200));
  firstDiagnostics.observeTool(tool("task-a", "finish", at + 100));
  await Promise.all([firstDiagnostics.flush(), secondDiagnostics.flush()]);
  worker.writeDiagnostics = send;
  assert.equal(await send(committed[0], committed[1], [{ kind: "tool", event: tool("task-b", "finish", at + 9999) }]), true);
  const beforeRestartA = await secondDiagnostics.readForTask("task-a");
  const beforeRestartB = await firstDiagnostics.readForTask("task-b");
  assert.deepEqual(beforeRestartA.tools.map(row => [row.status, row.observedMs]), [["completed", 100]]);
  assert.deepEqual(beforeRestartB.tools.map(row => [row.status, row.observedMs]), [["completed", 200]]);
  console.log("PASS both diagnostic streams retain their tool durations; losing and replaying a batch reply does not extend an interval");

  const reviewA = new CodeReviewService(undefined, undefined, ui);
  const reviewB = new CodeReviewService(undefined, undefined, worker);
  const file = join(root, "review.txt");
  writeFileSync(file, "before\n");
  const capture = reviewA.capture("task-a", root, file);
  assert(capture);
  writeFileSync(file, "after\n");
  await capture();
  const rows = await reviewB.readList("task-a");
  assert.deepEqual(rows.map(row => [row.name, row.status]), [["review.txt", "pending"]]);
  const changed = await reviewB.decide({ taskId: "task-a", ids: [rows[0].id], action: "reject" }, () => root,
    async (_path, operation) => operation());
  assert.deepEqual(changed.results.map(result => result.status), ["rejected"]);
  assert.equal(readFileSync(file, "utf8"), "before\n");
  assert.equal(await reviewA.readPendingCount("task-a"), 0);
  console.log("PASS the second client reads and reverses a file review through Core");

  const captureAgain = reviewA.capture("task-a", root, file);
  assert(captureAgain);
  writeFileSync(file, "new capture\n");
  const submitReview: RuntimeAuditReader["batch2Write"] = ui.batch2Write.bind(ui);
  let staleCaptureRejected = false;
  ui.batch2Write = async <T>(request: Record<string, unknown>) => {
    if (request.kind === "codeReviewUpsert") {
      const staleResult = await worker.batch2Write({ ...request, expectedId: "stale-review" });
      assert.deepEqual(staleResult, { ok: false });
      staleCaptureRejected = true;
    }
    return submitReview<T>(request);
  };
  try {
    await captureAgain();
  } finally {
    ui.batch2Write = submitReview;
  }
  assert(staleCaptureRejected);
  const [pending] = await reviewB.readList("task-a");
  assert.equal(pending.status, "pending");
  writeFileSync(file, "external edit\n");
  const decide = (action: "reject" | "accept") => reviewB.decide(
    { taskId: "task-a", ids: [pending.id], action }, () => root, async (_path, operation) => operation(),
  );
  assert.deepEqual((await decide("reject")).results.map(result => result.status), ["conflict"]);
  assert.deepEqual((await decide("accept")).results.map(result => result.status), ["accepted"]);
  assert.deepEqual((await decide("accept")).results.map(result => result.status), ["accepted"]);
  assert.equal(readFileSync(file, "utf8"), "external edit\n");
  console.log("PASS review capture rejects stale versions, rejection preserves external edits, and acceptance replays safely");

  await Promise.all([ui.close(), worker.close()]);
  application.close();
  await shutdownCoreWorker(root, database);
  application = await AppDatabase.open(database, options);
  const reopened = application.runtimeAuditReader!;
  await verifyDurableGoalMutation(reopened);
  const replay = await reopened.createConversationGoal(created.operation, created.draft);
  assert.deepEqual(replay, { ok: true, replayed: true, goal: created.goal });
  const saved = (await reopened.readConversationRuntime(created.draft.taskId, LOCAL_USER_ID))?.goals;
  assert(saved && saved.length === 1);
  assert(saved[0].owner_epoch > created.goal.owner_epoch);
  assert(saved[0].updated_at >= created.goal.updated_at);
  assert.deepEqual({ ...saved[0], updated_at: created.goal.updated_at, owner_epoch: created.goal.owner_epoch }, created.goal);
  assert.deepEqual(await reopened.batch1Write({ kind: "goalActivitySettle", userId: LOCAL_USER_ID, taskId: generation.taskId,
    conversationId: generation.conversationId, generationId: generation.generationTaskId,
    outcome: "aborted", messageId: "stale-after-restart" }), { owner: null });
  assert.equal(await reopened.readConversationGoalActivityOwner(generation.taskId, LOCAL_USER_ID,
    generation.conversationId, "stale-after-restart"), null);
  assert.deepEqual(await reopened.readConversationGoalActivityOwner(generation.taskId, LOCAL_USER_ID,
    generation.conversationId, "final-assistant"), owner);
  const afterReplay = await reopened.readWorkQueue({ userId: LOCAL_USER_ID, includeClosed: false, cursor: created.cursor });
  assert(afterReplay?.kind === "delta");
  assert.equal(afterReplay.events.some(event => event.workId === created.goal.work_id), false);
  assert.equal(await reopened.snapshotReceipt(cleared[0]), 1);
  assert.equal((await reopened.diagnostics("task-a"))?.tools[0]?.status, "completed");
  assert.deepEqual(await reopened.batch2Write({ kind: "deleteTask", id: "task-a" }), { ok: true });
  await application.writeTaskRecord({ id: "task-a", title: "New task", updatedAt: at });
  assert.deepEqual((await reopened.readConversationRuntime("task-a", LOCAL_USER_ID))?.interactions, []);
  assert.equal(await reopened.snapshotReceipt(cleared[0]), null);
  assert.deepEqual((await new RuntimeContextSnapshotRepository(undefined, reopened).readList("task-a")), []);
  assert.equal((await reopened.diagnostics("task-b"))?.tools[0]?.status, "completed");
  console.log("PASS native observability survives restart and task deletion removes only the deleted task's snapshots and diagnostics");
  await verifyLoadoutProjection(application);
  await verifyIndependentLibraryRecovery(application);
} finally {
  await Promise.allSettled([application?.runtimeAuditReader?.close(), worker.close()]);
  application?.close();
  await shutdownCoreWorker(root, database);
  rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
