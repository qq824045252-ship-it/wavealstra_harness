import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const sandbox = mkdtempSync(join(tmpdir(), "mybuddy-memory-drain-"));
process.env.USERPROFILE = sandbox;
// POSIX：os.homedir() 读的是 HOME，只设 USERPROFILE 会让测试写进真实家目录
process.env.HOME = sandbox;
const { AppDatabase } = await import("../src/main/db/AppDatabase");
const { AgentService } = await import("../src/main/agent/AgentService");
const { MemoryService } = await import("../src/main/memory/MemoryService");
const { MemoryPipelineManager } = await import("../src/main/memory/MemoryPipelineManager");

// Real extraction, queue, repositories and SQLite; replace only process/model boundaries.
const db = new AppDatabase(":memory:");
const memory = new MemoryService(db, { semantic: false });
const pipeline = new MemoryPipelineManager(db);
const agent = Object.create(AgentService.prototype) as any;
let enabled = true;
let notifications = 0;
const requests: any[] = [];
let response: (payload: any) => Promise<any> = async () => ({ candidates: [] });
Object.assign(agent, {
  db, memoryService: memory, memoryPipeline: pipeline, memoryDisposed: false,
  memoryWriteQueue: Promise.resolve(), memoryCognitionQueue: Promise.resolve(), memorySourceEpoch: 0,
  settingsStore: { read: () => ({ memoryEnabled: enabled, defaultModelId: "test/model" }) },
  resolveTaskExecutionWorkspaceCwd: () => sandbox,
  resolveEnabledModel: async () => ({ id: "model", provider: "test" }),
  notifyMemoryChanged: () => { notifications++; },
  modelRuntime: { completeSimple: async (_model: unknown, request: any) => {
    const payload = JSON.parse(request.messages[0].content);
    requests.push(payload);
    return { content: [{ type: "text", text: JSON.stringify(await response(payload)) }], stopReason: "stop" };
  } },
});
let serial = 0;
const task = (id: string) => db.upsertTask({ id, title: `真实任务 ${id}`, updatedAt: Date.now(), status: "completed" });
const capture = (id: string, userText = "好的") => pipeline.capture({ taskId: id, userText, assistantText: "已确认。", assistantMessageId: `answer-${++serial}` }).turn;
const trash = (id: string) => db.upsertTaskExecutionWorkspaceState({ taskId: id, directoryName: id, state: "trashed", createdAt: 1, updatedAt: Date.now() });
try {
  task("short");
  const substantive = capture("short", "以后都用中文回复，并保留必要验证结果。");
  const short = capture("short");
  response = async () => ({ candidates: [{ kind: "preference", title: "中文回复", content: "以后用中文回复并保留验证结果", scopeType: "global", confidence: 0.99, explicit: true, importance: 1, operationHint: "create", userEvidence: substantive.userText }] });
  const shortResult = await agent.extractKernelPendingTurns();
  assert.equal(requests.length, 1, "short final acknowledgement cannot silently complete a substantive batch");
  assert.equal(shortResult.processedTurns, 2);
  assert.equal(requests[0].conversationTurns[0].user, substantive.userText);
  assert.equal(requests[0].conversationTurns[1].user, "好的");
  assert.equal(memory.list().length, 1, "earlier user evidence must actually reach durable memory");
  assert.equal(pipeline.turns.get(short.id)?.extractionState, "completed");
  assert.ok(notifications >= 2, "start and completion both notify the open UI");

  // 回归锁：同一毫秒捕获的 turn 必须按**插入顺序**排队。
  // memory_turns.id 是 `mturn_${randomUUID()}`，曾用 `captured_at ASC,id ASC` 排序——
  // 同毫秒时等于让随机 UUID 决定顺序，批量抽取拿到的话语顺序会随运行漂移（本用例曾 20 次红 2 次）。
  task("order");
  capture("order", "第一条");
  capture("order", "第二条");
  assert.deepEqual(
    pipeline.turns.listPending("order", 10).map((turn: any) => turn.userText),
    ["第一条", "第二条"],
    "同毫秒写入的 turn 按 rowid（插入顺序）排序，不依赖随机 id",
  );
  // 清掉这条回归锁自己的数据，别让它影响后面按全局计数做的断言。
  db.connection.prepare("DELETE FROM memory_turns WHERE task_id='order'").run();

  task("batch");
  for (let i = 0; i < 19; i++) capture("batch", `无长期内容的对话 ${i}`);
  response = async () => ({ candidates: [] });
  const callsBefore = requests.length;
  const eventsBefore = notifications;
  const results = await Promise.all([agent.extractKernelPendingTurns(), agent.extractKernelPendingTurns()]);
  assert.equal(results.reduce((sum: number, result: any) => sum + result.processedTurns, 0), 19);
  assert.deepEqual(requests.slice(callsBefore).map((p) => p.conversationTurns.length), [8, 8, 3]);
  const ids = requests.slice(callsBefore).flatMap((p) => p.conversationTurns.map((turn: any) => turn.id));
  assert.equal(new Set(ids).size, 19, "concurrent manual/automatic drains do not extract a turn twice");
  assert.ok(notifications >= eventsBefore + 6, "empty extraction still publishes every batch completion");

  task("automatic");
  const callsBeforeAuto = requests.length;
  for (let i = 0; i < 3; i++) {
    agent.queueMemoryExtraction({ taskId: "automatic", userText: "好", assistantText: "完成", assistantMessageId: `auto-${i}`, model: {} });
    await agent.memoryWriteQueue;
  }
  assert.equal(requests.length - callsBeforeAuto, 3, "third/final successful turn does not remain pending");
  agent.queueMemoryExtraction({ taskId: "automatic", userText: "好", assistantText: "完成", assistantMessageId: "auto-2", model: {} });
  await agent.memoryWriteQueue;
  assert.equal(requests.length - callsBeforeAuto, 3, "duplicate completion event does not repeat extraction");

  task("trash"); capture("trash"); trash("trash");
  task("archived"); capture("archived");
  db.connection.prepare("INSERT INTO projects (id,name,created_at,updated_at,archived,resource_budget_chars) VALUES ('archived-project','归档项目',1,1,1,128000)").run();
  db.connection.prepare("UPDATE tasks SET project_id='archived-project' WHERE id='archived'").run();
  const beforeSkipped = requests.length;
  const skipped = await agent.extractKernelPendingTurns();
  assert.equal(skipped.skippedTasks, 2);
  assert.equal(requests.length, beforeSkipped, "trash and archived project contents never reach the model");
  assert.equal(memory.listTurns({ taskId: "trash" })[0]?.taskTitle, "真实任务 trash");
  assert.equal(agent.kernelMemoryTurnTasks().find((t: any) => t.id === "trash")?.trashed, true);

  for (const boundary of ["disable", "trash", "move", "delete"] as const) {
    const id = `race-${boundary}`;
    task(id);
    const turn = capture(id, `以后始终记录边界 ${boundary}`);
    const before = memory.list().length;
    response = async () => {
      if (boundary === "disable") enabled = false;
      if (boundary === "trash") trash(id);
      if (boundary === "delete") db.deleteTask(id);
      if (boundary === "move") {
        db.createSpace({ id: "new-space", name: "新的空间" });
        db.connection.prepare("UPDATE tasks SET space_id='new-space' WHERE id=?").run(id);
      }
      return { candidates: [{ kind: "preference", title: `失效响应 ${boundary}`, content: turn.userText, scopeType: "global", confidence: 1, explicit: true, operationHint: "create", userEvidence: turn.userText }] };
    };
    const result = await agent.queuePendingMemoryExtraction([id]);
    assert.equal(result.processedTurns, 0, `${boundary}: stale result cannot complete the batch`);
    assert.equal(memory.list().length, before, `${boundary}: stale result cannot commit memory`);
    if (boundary !== "delete") assert.equal(pipeline.turns.get(turn.id)?.extractionState, "failed");
    enabled = true;
    if (boundary !== "delete") trash(id);
  }
  enabled = false;
  await assert.rejects(() => agent.extractKernelPendingTurns(), /开启记忆/);

  // Source deletion covers the database, not the renderer's 500-row list window.
  task("purge-many");
  for (let i = 0; i < 510; i++) capture("purge-many", `可删除来源 ${i}`);
  const retained = memory.create({ kind: "fact", title: "保留已确认记忆", content: "来源原文删除后，长期事实保留", scopeType: "global", sourceType: "manual", evidence: [{ evidenceKind: "conversation", refId: substantive.id }] });
  db.connection.prepare("UPDATE memory_evidence SET excerpt=NULL WHERE memory_id=?").run(retained.id);
  const l0Before = pipeline.turns.countByState();
  const l1Before = memory.stats().total;
  const eventsBeforeDelete = notifications;
  db.connection.exec("CREATE TRIGGER fail_source_delete BEFORE DELETE ON memory_turns BEGIN SELECT RAISE(ABORT, 'test deletion failure'); END");
  assert.throws(() => agent.deleteAllKernelMemoryTurns(), /test deletion failure/);
  assert.equal(pipeline.turns.countByState(), l0Before, "failed deletion rolls back sources");
  assert.equal(memory.get(retained.id)?.evidence[0]?.excerpt ?? null, null, "evidence snapshot and source deletion are atomic");
  db.connection.exec("DROP TRIGGER fail_source_delete");
  assert.equal(agent.deleteAllKernelMemoryTurns(), l0Before, "deletion works with memory disabled and includes hidden/trash/archive rows");
  assert.ok(l0Before > 500);
  assert.equal(pipeline.turns.countByState(), 0);
  assert.equal(memory.stats().l0Turns, 0);
  assert.equal(memory.stats().pendingTurns, 0);
  assert.equal(memory.stats().failedTurns, 0);
  assert.deepEqual(agent.kernelMemoryTurnTasks(), []);
  assert.equal(memory.stats().total, l1Before, "already generated memories are preserved");
  assert.match(memory.get(retained.id)?.evidence[0]?.excerpt ?? "", /以后都用中文回复/);
  assert.ok(db.getTask("purge-many"), "source cleanup must not delete tasks or their chat history");
  assert.equal(pipeline.turns.getPipelineState("purge-many").capturedTurns, 0);
  assert.ok(notifications > eventsBeforeDelete);
  assert.equal(agent.deleteAllKernelMemoryTurns(), 0, "empty delete is an idempotent no-op");

  // Delete immediately while one request is in flight and another is queued.
  enabled = true;
  task("purge-race");
  const oldTurn = capture("purge-race", "以后始终使用旧版提炼结果");
  let finishModel!: (value: any) => void;
  let modelStarted!: () => void;
  const started = new Promise<void>((resolve) => { modelStarted = resolve; });
  response = async () => { modelStarted(); return new Promise((resolve) => { finishModel = resolve; }); };
  const inFlight = agent.queuePendingMemoryExtraction(["purge-race"]);
  const queued = agent.queuePendingMemoryExtraction(["purge-race"]);
  await started;
  assert.equal(agent.deleteAllKernelMemoryTurns(), 1, "deletion does not wait for the model");
  const afterDelete = capture("purge-race", "删除之后的新对话");
  response = async () => ({ candidates: [] });
  const fresh = agent.queuePendingMemoryExtraction(["purge-race"]);
  const callsAtDelete = requests.length;
  finishModel({ candidates: [{ kind: "preference", title: "已删除来源的迟到结果", content: oldTurn.userText, scopeType: "global", confidence: 1, explicit: true, operationHint: "create", userEvidence: oldTurn.userText }] });
  const [inFlightResult, queuedResult, freshResult] = await Promise.all([inFlight, queued, fresh]);
  assert.equal(inFlightResult.interrupted, true);
  assert.equal(queuedResult.interrupted, true, "previously queued jobs cannot consume new sources after deletion");
  assert.equal(freshResult.processedTurns, 1, "new conversations continue to extract normally");
  assert.equal(requests.length, callsAtDelete + 1);
  assert.equal(memory.stats().total, l1Before, "late response cannot recreate memory from deleted source");
  assert.equal(pipeline.turns.get(oldTurn.id), undefined);
  assert.equal(pipeline.turns.get(afterDelete.id)?.extractionState, "completed");
  // Selection deletes exact IDs, including mixed states/tasks, with all-or-nothing rollback.
  task("select-partial"); task("select-whole");
  const selectedA = capture("select-partial", "删除选中 A 的原文");
  const unselected = capture("select-partial", "保留未选中 B 的原文");
  const selectedC = capture("select-whole", "删除选中 C 的原文");
  pipeline.turns.markFailed([selectedC.id], "test failed source");
  const selectionMemory = memory.create({ kind: "fact", title: "多选来源的证据", content: "保持已有记忆", scopeType: "global", sourceType: "manual", evidence: [
    { evidenceKind: "conversation", refId: selectedA.id }, { evidenceKind: "conversation", refId: unselected.id },
  ] });
  db.connection.prepare("UPDATE memory_evidence SET excerpt=NULL WHERE memory_id=?").run(selectionMemory.id);
  const partialBefore = pipeline.turns.getPipelineState("select-partial");
  const countBeforeSelection = pipeline.turns.countByState();
  const throwSelected = db.connection.prepare("CREATE TRIGGER fail_selected_delete BEFORE DELETE ON memory_turns WHEN OLD.id='" + selectedC.id + "' BEGIN SELECT RAISE(ABORT, 'test selected deletion failure'); END");
  throwSelected.run();
  assert.throws(() => agent.deleteKernelMemoryTurns([selectedA.id, selectedC.id]), /test selected deletion failure/);
  assert.equal(pipeline.turns.countByState(), countBeforeSelection);
  assert.deepEqual(pipeline.turns.getPipelineState("select-partial"), partialBefore);
  assert.ok(memory.get(selectionMemory.id)?.evidence.every((item) => !item.excerpt), "failed selection rolls back evidence writes too");
  db.connection.exec("DROP TRIGGER fail_selected_delete");
  enabled = false;
  assert.equal(agent.deleteKernelMemoryTurns([selectedA.id, selectedA.id, selectedC.id, "missing-source"]), 2);
  assert.equal(pipeline.turns.countByState(), countBeforeSelection - 2);
  assert.equal(pipeline.turns.get(selectedA.id), undefined);
  assert.equal(pipeline.turns.get(selectedC.id), undefined);
  assert.equal(pipeline.turns.get(unselected.id)?.userText, unselected.userText);
  assert.equal(pipeline.turns.getPipelineState("select-partial").capturedTurns, 1);
  assert.equal(pipeline.turns.getPipelineState("select-partial").turnsSinceL1, 1);
  assert.equal(pipeline.turns.getPipelineState("select-whole").capturedTurns, 0);
  const selectionEvidence = memory.get(selectionMemory.id)!.evidence;
  assert.match(selectionEvidence.find((item) => item.refId === selectedA.id)?.excerpt ?? "", /删除选中 A/);
  assert.equal(selectionEvidence.find((item) => item.refId === unselected.id)?.excerpt ?? null, null, "unselected evidence is untouched");
  assert.equal(agent.deleteKernelMemoryTurns([]), 0);
  assert.equal(agent.deleteKernelMemoryTurns([selectedA.id]), 0);
  assert.throws(() => agent.deleteKernelMemoryTurns(null), /有效的对话来源/);
  assert.throws(() => agent.deleteKernelMemoryTurns([42]), /有效的对话来源/);

  // A mixed in-flight batch restarts with survivors; unrelated queued work continues normally.
  enabled = true;
  for (const outcome of ["success", "failure"] as const) {
    const mixedId = `selected-race-${outcome}`;
    const otherId = `unrelated-${outcome}`;
    task(mixedId); task(otherId);
    const removed = capture(mixedId, `以后保留被删除来源 ${outcome}`);
    const survivor = capture(mixedId, `这一条没有被勾选 ${outcome}`);
    const unrelated = capture(otherId, `另一个任务继续提炼 ${outcome}`);
    let settleOld!: () => void;
    let signalStarted!: () => void;
    const extractionStarted = new Promise<void>((resolve) => { signalStarted = resolve; });
    response = async () => {
      signalStarted();
      return new Promise((resolve, reject) => { settleOld = () => outcome === "failure" ? reject(new Error("late model failure")) : resolve({ candidates: [{ kind: "preference", title: "删除后不能回写", content: removed.userText, scopeType: "global", confidence: 1, explicit: true, operationHint: "create", userEvidence: removed.userText }] }); });
    };
    const recordsBefore = memory.stats().total;
    const mixedRun = agent.queuePendingMemoryExtraction([mixedId]);
    const unrelatedRun = agent.queuePendingMemoryExtraction([otherId]);
    await extractionStarted;
    assert.equal(agent.deleteKernelMemoryTurns([removed.id]), 1);
    const callsBeforeRestart = requests.length;
    response = async () => ({ candidates: [] });
    settleOld();
    const [mixedResult, unrelatedResult] = await Promise.all([mixedRun, unrelatedRun]);
    assert.equal(mixedResult.processedTurns, 1);
    assert.equal(mixedResult.failedTurns, 0);
    assert.equal(unrelatedResult.processedTurns, 1);
    assert.deepEqual(requests.slice(callsBeforeRestart).map((payload) => payload.conversationTurns.map((turn: any) => turn.id)), [[survivor.id], [unrelated.id]]);
    assert.equal(memory.stats().total, recordsBefore, "discard the entire result contaminated by deleted context");
    assert.equal(pipeline.turns.get(removed.id), undefined);
    assert.equal(pipeline.turns.get(survivor.id)?.extractionState, "completed");
    assert.equal(pipeline.turns.get(survivor.id)?.attemptCount, 1, "deletion does not consume survivors' retry budget");
    assert.equal(pipeline.turns.countByState("processing"), 0);
  }
  // Queued manual generations belong to the deletion version captured before model resolution.
  let finishProjection!: (value: any) => void;
  let startProjection!: () => void;
  const projectionStarted = new Promise<void>((resolve) => { startProjection = resolve; });
  response = async () => { startProjection(); return new Promise((resolve) => { finishProjection = resolve; }); };
  const oldGeneration = agent.generateKernelL2Proposals();
  await projectionStarted;
  const queuedGeneration = agent.generateKernelL2Proposals();
  agent.deleteKernelProjectionRecords({ kind: "scenario", all: true });
  const generationCalls = requests.length;
  finishProjection({ scenarios: [{ scopeKey: "global:", title: "不能重新出现的场景", summary: "删除前的请求", sourceMemoryIds: [retained.id, selectionMemory.id] }] });
  const generationResults = await Promise.all([oldGeneration, queuedGeneration]);
  assert.ok(generationResults.every((result) => result.completed === false));
  assert.equal(requests.length, generationCalls, "queued pre-delete generation must not call the model");
  assert.equal(memory.listProjectionProposals().length, 0);
  response = async () => ({ scenarios: [{ scopeKey: "global:", title: "删除后主动生成的场景", summary: "等待批准的新提案", sourceMemoryIds: [retained.id, selectionMemory.id] }] });
  assert.equal((await agent.generateKernelL2Proposals()).outputs, 1);
  // A retired historical chat model must not strand otherwise eligible originals.
  task("retired-model");
  db.connection.prepare("UPDATE tasks SET model_id='retired/model' WHERE id='retired-model'").run();
  const retiredTurn = capture("retired-model");
  const resolvedIds: string[] = [];
  agent.resolveEnabledModel = async (id: string) => {
    resolvedIds.push(id);
    return id === "test/model" ? { id: "model", provider: "test" } : undefined;
  };
  response = async () => ({ candidates: [] });
  const recovered = await agent.queuePendingMemoryExtraction(["retired-model"]);
  assert.deepEqual(resolvedIds, ["retired/model", "test/model"]);
  assert.equal(recovered.processedTurns, 1);
  assert.equal(pipeline.turns.get(retiredTurn.id)?.extractionState, "completed");
  assert.equal(db.getTask("retired-model")?.modelId, "retired/model", "memory recovery cannot alter the original chat model");
  const unavailable = capture("retired-model", "没有可用模型的来源");
  agent.resolveEnabledModel = async () => undefined;
  const noFallback = await agent.queuePendingMemoryExtraction(["retired-model"]);
  assert.equal(noFallback.failedTurns, 1);
  assert.equal(pipeline.turns.get(unavailable.id)?.extractionState, "failed", "disabled defaults remain disabled and retryable");
  console.log("PASS retired-model recovery uses only the enabled current default and preserves chat selection");
  console.log("memory-extraction-lifecycle-test: PASS (bulk/selected deletion, atomic rollback, exact scope, preserved memories, and safe in-flight/queued extraction and projection generation)");
} finally {
  db.close();
  rmSync(sandbox, { recursive: true, force: true });
}
