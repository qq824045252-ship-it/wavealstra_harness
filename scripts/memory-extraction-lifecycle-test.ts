import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyModePolicy } from "../src/shared/mode-profile";
import { LOCAL_USER_ID } from "../src/shared/bot-work";
import { DOTS_TASK_ID } from "../src/shared/dots";
import { locateRuntimeAudit } from "../src/main/platform/runtime-audit";

const sandbox = mkdtempSync(join(tmpdir(), "mybuddy-memory-drain-"));
process.env.USERPROFILE = sandbox;
// POSIX：os.homedir() 读的是 HOME，只设 USERPROFILE 会让测试写进真实家目录
process.env.HOME = sandbox;
const { AppDatabase } = await import("../src/main/db/AppDatabase");
const { AgentService } = await import("../src/main/agent/AgentService");
const { MemoryService } = await import("../src/main/memory/MemoryService");
const { MemoryForgetWatermarks } = await import("../src/main/memory/MemoryForgetWatermarks");
const { MemoryPipelineManager } = await import("../src/main/memory/MemoryPipelineManager");

async function verifySettingsScopeWrites(db: InstanceType<typeof AppDatabase>, native: boolean): Promise<void> {
  const conn = db.connection;
  const memory = new MemoryService(db, { semantic: false });
  const settings = Object.assign(Object.create(AgentService.prototype), {
    db, memoryService: memory, notifyMemoryChanged: () => {},
  }) as Pick<InstanceType<typeof AgentService>, "promoteKernelMemory" | "detachKernelMemoryScope">;
  const fact = memory.create({
    title: "AsterPreference", content: "AsterPreference 的标记是紫杉7319", kind: "fact", sourceType: "manual", scopeType: "global",
  });
  const project = "scope-settings-project";
  const version = 9_000_000_000_000;
  conn.prepare("INSERT INTO projects(id,name,created_at,updated_at) VALUES (?,'Scope fixture',1,?)").run(project, version);
  conn.prepare(
    "INSERT INTO memory_scenarios(id,scope_type,scope_id,title,summary,source_memory_ids_json,content_hash,created_at,updated_at) " +
    "VALUES ('scope-fixture-scenario','project',?,'场景','待重新生成','[]','scope-fixture-hash',1,1)",
  ).run(project);
  const invoke = async <T,>(operation: () => Promise<T>): Promise<T> => {
    if (native) conn.pragma("query_only = ON");
    try { return await operation(); } finally { conn.pragma("query_only = OFF"); }
  };
  const priorText = "AsterPreference 的标记是紫杉7319；保留另一项设置。";
  const recall = (scopeType: "project" | "global", scopeId?: string) => new MemoryForgetWatermarks(conn)
    .sourceFilter([{ scopeType, scopeId }])(priorText, "", 1).userText;
  const projectVersion = () => conn.prepare("SELECT updated_at FROM projects WHERE id=?").pluck().get(project);
  const scenarioStatus = () => conn.prepare("SELECT status FROM memory_scenarios WHERE id='scope-fixture-scenario'").pluck().get();

  const first = await invoke(() => settings.promoteKernelMemory(fact.id, "project", project));
  assert.deepEqual(first.scopes.map(scope => [scope.scopeType, scope.scopeId, scope.binding]),
    [["global", undefined, "owned"], ["project", project, "promoted"]]);
  assert.equal(scenarioStatus(), "stale");
  assert.equal(projectVersion(), version + 1);
  assert.deepEqual((await invoke(() => settings.promoteKernelMemory(fact.id, "project", project)))
    .scopes.map(scope => scope.scopeType), ["global", "project"]);

  conn.prepare("UPDATE projects SET archived=1 WHERE id=?").run(project);
  await assert.rejects(invoke(() => settings.promoteKernelMemory(fact.id, "project", project)), /项目已归档/);
  await assert.rejects(invoke(() => settings.detachKernelMemoryScope(fact.id, "project", project)), /项目已归档/);
  assert.equal(memory.get(fact.id)?.scopes.length, 2);

  conn.prepare("UPDATE projects SET archived=0 WHERE id=?").run(project);
  conn.exec("UPDATE memory_scenarios SET status='active' WHERE id='scope-fixture-scenario'");
  assert.deepEqual(await invoke(() => settings.detachKernelMemoryScope(fact.id, "project", project)), { detached: true, forgotten: false });
  assert.deepEqual(memory.get(fact.id)?.scopes.map(scope => scope.scopeType), ["global"]);
  assert.equal(memory.get(fact.id)?.content, "AsterPreference 的标记是紫杉7319");
  assert.equal(projectVersion(), version + 3);
  assert.equal(scenarioStatus(), "stale");
  assert.equal(recall("project", project), "保留另一项设置。");
  assert.equal(recall("global"), priorText);
  await assert.rejects(invoke(() => settings.detachKernelMemoryScope(fact.id, "project", project)), /作用域绑定不存在/);

  // A promoted copy of the owned binding still counts as the same scope during removal.
  assert.deepEqual((await invoke(() => settings.promoteKernelMemory(fact.id, "global")))
    .scopes.map(scope => scope.binding), ["owned", "promoted"]);
  conn.exec("CREATE TRIGGER fixture_scope_rollback BEFORE DELETE ON memory_records BEGIN SELECT RAISE(ABORT,'fixture scope rollback'); END");
  await assert.rejects(invoke(() => settings.detachKernelMemoryScope(fact.id, "global")), /fixture scope rollback/);
  assert.deepEqual(memory.get(fact.id)?.scopes.map(scope => scope.binding), ["owned", "promoted"]);
  assert.equal(recall("global"), priorText);
  conn.exec("DROP TRIGGER fixture_scope_rollback");

  assert.deepEqual(await invoke(() => settings.detachKernelMemoryScope(fact.id, "global")), { detached: true, forgotten: true });
  assert.equal(memory.get(fact.id), undefined);
  assert.equal(recall("global"), "保留另一项设置。");
  assert.deepEqual(memory.repository.listRevisions(fact.id), []);
  console.log(`PASS ${native ? "Rust" : "Node"} settings scope writes honor archive, rollback and exact last-scope withdrawal`);
}

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
    await agent.queueMemoryExtraction({ taskId: "automatic", userText: "好", assistantText: "完成", assistantMessageId: `auto-${i}`, model: {} });
    await agent.memoryWriteQueue;
  }
  assert.equal(requests.length - callsBeforeAuto, 3, "third/final successful turn does not remain pending");
  await agent.queueMemoryExtraction({ taskId: "automatic", userText: "好", assistantText: "完成", assistantMessageId: "auto-2", model: {} });
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
  await assert.rejects(() => agent.deleteAllKernelMemoryTurns(), /test deletion failure/);
  assert.equal(pipeline.turns.countByState(), l0Before, "failed deletion rolls back sources");
  assert.equal(memory.get(retained.id)?.evidence[0]?.excerpt ?? null, null, "evidence snapshot and source deletion are atomic");
  db.connection.exec("DROP TRIGGER fail_source_delete");
  assert.equal(await agent.deleteAllKernelMemoryTurns(), l0Before, "deletion works with memory disabled and includes hidden/trash/archive rows");
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
  assert.equal(await agent.deleteAllKernelMemoryTurns(), 0, "empty delete is an idempotent no-op");

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
  assert.equal(await agent.deleteAllKernelMemoryTurns(), 1, "deletion does not wait for the model");
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
  await assert.rejects(() => agent.deleteKernelMemoryTurns([selectedA.id, selectedC.id]), /test selected deletion failure/);
  assert.equal(pipeline.turns.countByState(), countBeforeSelection);
  assert.deepEqual(pipeline.turns.getPipelineState("select-partial"), partialBefore);
  assert.ok(memory.get(selectionMemory.id)?.evidence.every((item) => !item.excerpt), "failed selection rolls back evidence writes too");
  db.connection.exec("DROP TRIGGER fail_selected_delete");
  enabled = false;
  assert.equal(await agent.deleteKernelMemoryTurns([selectedA.id, selectedA.id, selectedC.id, "missing-source"]), 2);
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
  assert.equal(await agent.deleteKernelMemoryTurns([]), 0);
  assert.equal(await agent.deleteKernelMemoryTurns([selectedA.id]), 0);
  await assert.rejects(() => agent.deleteKernelMemoryTurns(null), /有效的对话来源/);
  await assert.rejects(() => agent.deleteKernelMemoryTurns([42]), /有效的对话来源/);

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
    assert.equal(await agent.deleteKernelMemoryTurns([removed.id]), 1);
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
  agent.resolveEnabledModel = async () => ({ id: "model", provider: "test" });
  {
    const pendingId = "held-background-extraction";
    task(pendingId);
    task("foreground-send");
    const older = capture(pendingId, "长期偏好是每周汇报测量校准结果。");
    let entered!: () => void;
    let release!: () => void;
    const started = new Promise<void>(resolve => { entered = resolve; });
    const gate = new Promise<void>(resolve => { release = resolve; });
    response = async () => { entered(); await gate; return { candidates: [] }; };
    const extraction = agent.queuePendingMemoryExtraction([pendingId]);
    await started;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      Object.assign(agent, {
        durableAssemblies: new Map(),
        workService: { repo: { bindingForTask: () => undefined } },
        executionFailures: { resolveWorkspaceFailures: () => {} },
        expertBindings: { ensureLegacy: () => {}, active: () => undefined },
        modeProfiles: { getProfile: () => ({ policy: emptyModePolicy() }) },
        projectContextResolver: { resolveTask: () => undefined },
        runtimeCapabilityAvailability: () => ({}),
        expertConnectorIds: () => [],
        emitPatch: () => {},
        runtimeRequirements: { ensurePresetReady: async () => {} },
      });
      agent.settingsStore.setTaskConnectorIds = () => {};
      const send = agent.prepareDurableTask({
        taskId: "foreground-send", userMessageId: "fast-send", assistantMessageId: "fast-answer", text: "继续", modelId: "test/model",
      });
      const admitted = await Promise.race([send, new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error("foreground send waited for background memory model")), 500);
      })]);
      assert.equal(admitted.text, "继续");
      assert.equal(pipeline.turns.get(older.id)?.extractionState, "processing", "memory must still be in flight");
      await new Promise(resolve => setTimeout(resolve, 5));
      const newer = capture(pendingId, "后续新一轮仍由独立批次提炼。");
      release();
      await extraction;
      assert.equal(pipeline.turns.get(older.id)?.extractionState, "completed");
      assert.equal(pipeline.turns.get(newer.id)?.extractionState, "pending");
      console.log("PASS ordinary send does not wait for a held memory model and new evidence remains pending");
    } finally {
      if (timer) clearTimeout(timer);
      release();
      await extraction;
    }
  }
  console.log("memory-extraction-lifecycle-test: PASS (bulk/selected deletion, atomic rollback, exact scope, preserved memories, and safe in-flight/queued extraction and projection generation)");
  if (process.argv.includes("--native")) {
    const executable = locateRuntimeAudit(process.cwd());
    assert(executable, "native capture fixture requires the resident helper");
    const nativeDb = new AppDatabase(join(sandbox, "capture.db"), { runtimeAuditExecutable: executable });
    try {
      const writer = new MemoryPipelineManager(nativeDb);
      const taskId = "completed-durable";
      nativeDb.upsertTask({ id: taskId, title: "Durable fixture", updatedAt: 1 });
      nativeDb.connection.exec(`CREATE TABLE durable_bot_memory_projection (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE, entry_id INTEGER NOT NULL
      )`);
      const through = () => (nativeDb.connection.prepare("SELECT entry_id FROM durable_bot_memory_projection WHERE task_id=?")
        .get(taskId) as { entry_id: number } | undefined)?.entry_id;
      const turn = { taskId, userText: "\uFEFF 记录🧪 \t", assistantText: " 已完成。\r\n", capturedAt: 7 };
      const originals = [
        { ...turn, entryId: 11, assistantMessageId: "durable-11" },
        { ...turn, entryId: 17, assistantMessageId: "durable-17", skipCapture: true },
      ];
      nativeDb.connection.pragma("query_only = ON");
      assert.equal(await writer.captureCompleted(turn), true);
      assert.equal(await writer.captureCompleted({ ...turn, userText: "记录🧪", assistantText: "已完成。" }), false);
      assert.equal(await writer.projectCompleted(taskId, originals, () => true), true);
      assert.equal(await writer.projectCompleted(taskId, originals, () => true), false);
      assert.deepEqual(writer.turns.listPending(taskId).map(row => [row.userText, row.assistantText, row.assistantMessageId]), [
        ["记录🧪", "已完成。", undefined], ["记录🧪", "已完成。", "durable-11"],
      ]);
      assert.equal(through(), 17, "skipped turns still advance the projection");
      assert.equal(writer.turns.getPipelineState(taskId).capturedTurns, 2);

      nativeDb.connection.pragma("query_only = OFF");
      nativeDb.connection.exec(`CREATE TRIGGER reject_capture_checkpoint BEFORE UPDATE ON durable_bot_memory_projection
        WHEN NEW.entry_id=22 BEGIN SELECT RAISE(ABORT, 'fixture rejects projection'); END`);
      nativeDb.connection.pragma("query_only = ON");
      await assert.rejects(() => writer.projectCompleted(taskId, [
        { ...turn, entryId: 22, assistantMessageId: "durable-22" },
      ], () => true));
      assert.equal(through(), 17);
      assert.equal(writer.turns.getByAssistantMessageId("durable-22"), undefined);
      assert.equal(writer.turns.getPipelineState(taskId).capturedTurns, 2);

      nativeDb.connection.pragma("query_only = OFF");
      nativeDb.connection.exec("DROP TRIGGER reject_capture_checkpoint");
      const beforePurge = writer.projectCompleted(taskId, [
        { ...turn, entryId: 22, assistantMessageId: "durable-22" },
      ], () => true);
      const purge = writer.withCaptureWrites(() => writer.turns.deleteAll());
      assert.equal(await beforePurge, true);
      assert.equal(await purge, 3, "deletion orders after a previously accepted capture");
      nativeDb.connection.pragma("query_only = ON");
      assert.equal(await writer.projectCompleted(taskId, originals, () => true), false);
      assert.equal(writer.turns.countByState(), 0, "replaying a deleted durable original cannot restore it");
      assert.equal(through(), 22);
      const closingTurn = writer.captureCompleted(turn);
      await writer.closeCaptureWrites();
      assert.equal(await closingTurn, true);
      assert.equal(await writer.captureCompleted({ ...turn, userText: "after close" }), false);
      console.log("PASS Rust memory capture, replay, atomic rollback, deletion ordering and shutdown");

      nativeDb.connection.pragma("query_only = OFF");
      const first = writer.turns.capture({ ...turn, capturedAt: 100, userText: "统一 甲", sessionId: "saved-session" }).turn;
      const latest = writer.turns.capture({ ...turn, capturedAt: 100, userText: "统一 乙", metadata: { raw: "\uD800" } }).turn;
      nativeDb.connection.prepare("UPDATE memory_turns SET extraction_state='failed',last_error='stored error',attempt_count=2 WHERE id=?")
        .run(latest.id);
      nativeDb.upsertTaskExecutionWorkspaceState({ taskId, directoryName: taskId, state: "trashed", createdAt: 1, updatedAt: 2 });
      const addBot = nativeDb.connection.prepare(`INSERT INTO bots (
        bot_id,user_id,display_name,expert_profile_json,memory_scope_json,authorization_json,created_at,updated_at
      ) VALUES (?,?,'Fixture','{}','{}','{}',1,1)`);
      const addConversation = nativeDb.connection.prepare(`INSERT INTO bot_conversations (
        conversation_id,bot_id,user_id,created_at,updated_at
      ) VALUES (?,?,?,1,1)`);
      for (const [account, owner] of [["local", LOCAL_USER_ID], ["foreign", "fixture-foreign-owner"]]) {
        addBot.run(`${account}-bot`, owner);
        addConversation.run(`${account}-conversation`, `${account}-bot`, owner);
        writer.turns.capture({ ...turn, taskId: `${account}-conversation`, capturedAt: 110, userText: `${account} evidence` });
      }
      // A separate connection must see the committed data even when a temporary host table shadows it.
      nativeDb.connection.exec(`CREATE TEMP TABLE memory_turns AS SELECT * FROM main.memory_turns WHERE 0;
        INSERT INTO temp.memory_turns SELECT * FROM main.memory_turns LIMIT 1;
        UPDATE temp.memory_turns SET id='host-only'`);
      const inspector = Object.assign(Object.create(AgentService.prototype), {
        memoryPipeline: writer, memoryService: new MemoryService(nativeDb, { semantic: false }),
      }) as Pick<InstanceType<typeof AgentService>, "listKernelMemoryTurns" | "getKernelMemoryTurn" | "readKernelMemoryTurnTasks">;
      const results = await inspector.listKernelMemoryTurns({ taskId: ` ${taskId} `, query: " 统一 % ", limit: 1 });
      assert.deepEqual(results.map(row => [row.userText, row.taskTitle, row.taskTrashed]), [["统一 乙", "Durable fixture", true]]);
      const pending = await inspector.listKernelMemoryTurns({ taskId, query: "统一", extractionState: "pending" });
      assert.deepEqual(pending.map(row => [row.userText, row.sessionId]), [["统一 甲", "saved-session"]]);
      const detail = await inspector.getKernelMemoryTurn(latest.id);
      assert.deepEqual([detail?.userText, detail?.assistantText, detail?.extractionState, detail?.attemptCount, detail?.lastError, detail?.metadata],
        ["统一 乙", "已完成。", "failed", 2, "stored error", { raw: "\uD800" }]);
      assert.equal((await inspector.getKernelMemoryTurn(first.id))?.taskTitle, "Durable fixture");
      assert.equal(await inspector.getKernelMemoryTurn("host-only"), undefined);
      assert.deepEqual(await inspector.readKernelMemoryTurnTasks(), [
        { id: "foreign-conversation", title: "原任务已删除", trashed: false },
        { id: "local-conversation", title: "Bot 对话", trashed: false },
        { id: taskId, title: "Durable fixture", trashed: true },
      ]);
      nativeDb.connection.exec("DROP TABLE temp.memory_turns");
      console.log("PASS Rust L0 inspector rows, detail, task titles, audit filters and insertion ordering");

      const l1 = new MemoryService(nativeDb, { semantic: false });
      const left = nativeDb.createSpace({ id: "fixture-memory-left", name: "Left" });
      const right = nativeDb.createSpace({ id: "fixture-memory-right", name: "Right" });
      const add = (title: string, scopeId: string, updatedAt: number, status: "active" | "superseded" = "active") => {
        const item = l1.create({
          kind: "fact", title, content: "校验设置页仍能查看关联资料", status,
          confidence: 0.12345678912345678, explicit: true, sourceType: "manual",
          validFrom: 0.12345678912345678, scopeType: "workspace", scopeId,
          metadata: { original: "\uD800" },
          evidence: [{ evidenceKind: "conversation", refId: first.id, excerpt: "会话原文" }],
        });
        nativeDb.connection.prepare("UPDATE memory_records SET updated_at=? WHERE id=?").run(updatedAt, item.id);
        return item;
      };
      const older = add("记录 \\ 100%_ 甲", left.id, 10);
      const newer = add("记录 \\ 100%_ 乙", left.id, 20);
      add("记录 \\ 100XY", left.id, 30);
      add("记录 \\ 100%_ 丙", right.id, 40);
      add("记录 \\ 100%_ 历史", left.id, 50, "superseded");
      l1.repository.addScope({ memoryId: newer.id, scopeType: "global", binding: "promoted", createdAt: newer.createdAt + 1 });
      l1.repository.addRelation({ id: "fixture-relation", fromMemoryId: older.id, relation: "SUPPORTS", toMemoryId: newer.id, createdAt: 30 });
      l1.update({ id: newer.id, content: "复核过的关联资料", changeReason: "手动复核" });
      nativeDb.connection.prepare("UPDATE memory_records SET updated_at=20 WHERE id=?").run(newer.id);

      nativeDb.connection.exec(`CREATE TEMP TABLE memory_records AS SELECT * FROM main.memory_records WHERE 0;
        CREATE TEMP TABLE memory_revisions AS SELECT * FROM main.memory_revisions WHERE 0`);
      const explorer = Object.assign(Object.create(AgentService.prototype), {
        memoryService: new MemoryService(nativeDb, { semantic: false }),
      }) as Pick<InstanceType<typeof AgentService>, "listKernelMemory" | "getKernelMemory" | "kernelMemoryHistory" | "memoriesForKernelTurn" | "kernelMemoryStats">;
      const filter = { scopeType: "workspace", scopeId: left.id, kind: "fact", status: "active", query: " \\ 100%_ ", limit: 1 } as const;
      assert.deepEqual((await explorer.listKernelMemory(filter)).map((row) => row.title), ["记录 \\ 100%_ 乙"]);
      assert.deepEqual((await explorer.listKernelMemory({ ...filter, offset: 1 })).map((row) => row.title), ["记录 \\ 100%_ 甲"]);
      assert.equal((await explorer.listKernelMemory({ limit: 1, offset: 3 }))[0]?.title, "记录 \\ 100%_ 历史");
      const saved = await explorer.getKernelMemory(newer.id);
      assert.equal(saved?.title, "记录 \\ 100%_ 乙");
      assert.equal(saved?.explicit, true);
      assert.equal(saved?.confidence, 0.12345678912345678);
      assert.equal(saved?.validFrom, 0.12345678912345678);
      assert.deepEqual(saved?.metadata, { original: "\uD800" });
      assert.deepEqual(saved?.scopes.map(({ scopeType, scopeId, binding }) => [scopeType, scopeId, binding]), [
        ["workspace", "fixture-memory-left", "owned"], ["global", undefined, "promoted"],
      ]);
      assert.deepEqual(saved?.evidence.map(({ evidenceKind, excerpt, refTitle }) => [evidenceKind, excerpt, refTitle]), [
        ["conversation", "会话原文", undefined],
      ]);
      assert.deepEqual(saved?.relations.map(({ id, relation }) => [id, relation]), [["fixture-relation", "SUPPORTS"]]);
      assert.equal(await explorer.getKernelMemory("absent"), undefined);
      const revisions = await explorer.kernelMemoryHistory(newer.id);
      assert.deepEqual(revisions.map(row => [
        row.revision, row.content, row.changedBy, row.changeReason, row.confidence, row.validFrom, row.validUntil,
      ]), [
        [2, "复核过的关联资料", "manual", "手动复核", 0.12345678912345678, 0.12345678912345678, undefined],
        [1, "校验设置页仍能查看关联资料", "manual", "created", 0.12345678912345678, 0.12345678912345678, undefined],
      ]);
      assert.deepEqual(await explorer.kernelMemoryHistory("absent"), []);
      assert.deepEqual((await explorer.memoriesForKernelTurn(first.id)).map((row) => row.title), [
        "记录 \\ 100%_ 历史", "记录 \\ 100%_ 丙", "记录 \\ 100XY", "记录 \\ 100%_ 乙", "记录 \\ 100%_ 甲",
      ]);
      nativeDb.connection.prepare("UPDATE memory_turns SET extraction_state='failed',attempt_count=3 WHERE id=?").run(first.id);
      const counters = await explorer.kernelMemoryStats();
      assert.deepEqual([counters.total, counters.active, counters.byKind, counters.byScope, counters.pendingTurns, counters.failedTurns], [
        5, 4, { fact: 5 }, { global: 1, workspace: 5 }, 4, 1,
      ]);
      nativeDb.connection.exec("DROP TABLE temp.memory_records; DROP TABLE temp.memory_revisions");
      console.log("PASS Rust L1 settings list, detail, revision history, turn evidence, scope filters and counters");

      const projectId = "fixture-settings-project";
      const projectStamp = 4_000_000_000_000;
      nativeDb.connection.prepare(
        "INSERT INTO projects(id,name,created_at,updated_at) VALUES (?,'Fixture',1,?)",
      ).run(projectId, projectStamp);
      nativeDb.connection.prepare(
        "INSERT INTO memory_scenarios(id,scope_type,scope_id,title,summary,content_hash,created_at,updated_at) " +
        "VALUES ('fixture-settings-scenario','project',?,'现有场景','场景内容','scenario-hash',1,1)",
      ).run(projectId);
      nativeDb.connection.prepare(
        "INSERT INTO memory_core_profiles(id,scope_type,scope_id,title,content,content_hash,created_at,updated_at) " +
        "VALUES ('fixture-settings-profile','project',?,'现有画像','画像内容','profile-hash',1,1)",
      ).run(projectId);
      nativeDb.connection.exec("CREATE TRIGGER reject_settings_memory_revision BEFORE INSERT ON memory_revisions " +
        "WHEN NEW.title='事务回滚探针' BEGIN SELECT RAISE(ABORT, 'fixture rejects revision'); END");
      const settings = Object.assign(Object.create(AgentService.prototype), {
        memoryService: l1, notifyMemoryChanged: () => {},
      }) as Pick<InstanceType<typeof AgentService>,
        "createKernelMemoryAsync" | "updateKernelMemoryAsync" | "forgetKernelMemories">;
      const version = () => nativeDb.connection.prepare("SELECT updated_at FROM projects WHERE id=?").pluck().get(projectId);
      const views = () => [
        nativeDb.connection.prepare("SELECT status FROM memory_scenarios WHERE id='fixture-settings-scenario'").pluck().get(),
        nativeDb.connection.prepare("SELECT status FROM memory_core_profiles WHERE id='fixture-settings-profile'").pluck().get(),
      ];
      nativeDb.connection.pragma("query_only = ON");
      const manual = await settings.createKernelMemoryAsync({
        kind: "fact", scopeType: "project", scopeId: projectId, sourceType: "manual",
        title: "  项目手动记忆  ", content: "验收前读记录", metadata: { original: "\uD800" },
        validFrom: 0.12345678912345678, confidence: 0.12345678912345678,
        evidence: [
          { evidenceKind: "conversation", refId: first.id, excerpt: "原始语句" },
          { evidenceKind: "conversation", refId: first.id, excerpt: "重复证据" },
        ],
      });
      assert.deepEqual([manual.title, manual.content, manual.confidence, manual.validFrom, manual.metadata], [
        "项目手动记忆", "验收前读记录", 0.12345678912345678, 0.12345678912345678, { original: "\uD800" },
      ]);
      assert.deepEqual(manual.evidence.map(e => [e.refId, e.excerpt]), [[first.id, "原始语句"]]);
      assert.deepEqual(views(), ["stale", "stale"]);
      assert.equal(version(), projectStamp + 1);

      nativeDb.connection.pragma("query_only = OFF");
      nativeDb.connection.exec("UPDATE memory_scenarios SET status='active' WHERE id='fixture-settings-scenario'; " +
        "UPDATE memory_core_profiles SET status='active' WHERE id='fixture-settings-profile'");
      nativeDb.connection.pragma("query_only = ON");
      await Promise.all([
        settings.updateKernelMemoryAsync({ id: manual.id, title: "项目记忆改名", changeReason: "改标题" }),
        settings.updateKernelMemoryAsync({ id: manual.id, content: "验收后保留证据", validFrom: null, changeReason: "改内容" }),
      ]);
      const after = await explorer.getKernelMemory(manual.id);
      assert.deepEqual([after?.title, after?.content, after?.validFrom, after?.evidence[0]?.excerpt],
        ["项目记忆改名", "验收后保留证据", undefined, "原始语句"]);
      assert.deepEqual(l1.repository.listRevisions(manual.id).map(r => [r.revision, r.changedBy]), [
        [3, "manual"], [2, "manual"], [1, "manual"],
      ]);
      assert.deepEqual(views(), ["stale", "stale"]);
      assert.equal(version(), projectStamp + 3);

      assert.equal((await settings.updateKernelMemoryAsync({ id: manual.id, title: "项目记忆改名" })).title, "项目记忆改名");
      await assert.rejects(
        settings.updateKernelMemoryAsync({ id: manual.id, title: "事务回滚探针" }), /fixture rejects revision/,
      );
      assert.equal((await explorer.getKernelMemory(manual.id))?.title, "项目记忆改名");
      assert.equal(l1.repository.listRevisions(manual.id).length, 3);
      assert.equal(version(), projectStamp + 3);

      nativeDb.connection.pragma("query_only = OFF");
      nativeDb.connection.prepare("UPDATE projects SET archived=1 WHERE id=?").run(projectId);
      nativeDb.connection.pragma("query_only = ON");
      await assert.rejects(settings.updateKernelMemoryAsync({ id: manual.id, title: "归档后改名" }), /项目已归档/);
      await assert.rejects(settings.createKernelMemoryAsync({
        kind: "fact", title: "归档后新增", scopeType: "project", scopeId: projectId, sourceType: "manual",
      }), /项目已归档/);
      assert.deepEqual((await explorer.listKernelMemory({ scopeType: "project", scopeId: projectId })).map(r => r.title), [
        "项目记忆改名",
      ]);
      console.log("PASS Rust settings memory creation, concurrent edits, revision rollback, archive and project projections");

      nativeDb.connection.pragma("query_only = OFF");
      const forgetProjectId = "forget-settings-project";
      nativeDb.connection.prepare("INSERT INTO projects(id,name,created_at,updated_at) VALUES (?,'Forget',1,?)")
        .run(forgetProjectId, projectStamp);
      nativeDb.upsertTask({ id: DOTS_TASK_ID, title: "Dots", updatedAt: 1 });
      const forget = l1.create({
        title: "巡检步骤", content: "启用蓝色工位", kind: "procedure",
        scopeType: "task", scopeId: DOTS_TASK_ID, sourceType: "manual",
        evidence: [{ evidenceKind: "conversation", refId: first.id, excerpt: "走西侧通道" }],
      });
      l1.update({ id: forget.id, content: "启用绿色工位" });
      l1.promote(forget.id, "global");
      l1.promote(forget.id, "project", forgetProjectId);
      await new Promise<void>(resolve => setImmediate(resolve));
      const previouslyUsed = JSON.stringify([forget.id]);
      const conn = nativeDb.connection;
      conn.prepare(
        "INSERT INTO memory_scenarios(id,scope_type,scope_id,title,summary,source_memory_ids_json,content_hash,created_at,updated_at) " +
        "VALUES ('forget-dots-scenario','task',?,'原始场景','启用绿色工位',?,'forget-scenario',1,1), " +
        "('forget-project-scenario','project',?,'保留场景','待重新生成','[]','retain-scenario',1,1)",
      ).run(DOTS_TASK_ID, previouslyUsed, forgetProjectId);
      conn.prepare(
        "INSERT INTO memory_core_profiles(id,scope_type,scope_id,title,content,source_scenario_ids_json,content_hash,created_at,updated_at) " +
        "VALUES ('forget-dots-profile','task',?,'旧画像','启用绿色工位','[\"forget-dots-scenario\"]','forget-profile',1,1)",
      ).run(DOTS_TASK_ID);
      conn.prepare(
        "INSERT INTO memory_skill_candidates(id,slug,title,description,instructions,status,scope_type,source_memory_ids_json,source_signature,created_at,updated_at) " +
        "VALUES ('forget-learned-skill','inspect','旧技能','description','instruction','ready','global',?,'forget-skill',1,1)",
      ).run(previouslyUsed);
      conn.prepare(
        "INSERT INTO memory_candidates(id,task_id,kind,title,content,scope_type,confidence,importance,operation_hint,status,created_at,resolved_memory_id) " +
        "VALUES ('forget-extracted',?,'procedure','旧提炼','启用绿色工位','global',1,1,'create','committed',1,?)",
      ).run(taskId, forget.id);
      conn.prepare("INSERT INTO memory_embeddings VALUES (?,'fixture-model','v1',?,1,x'00000000',1)")
        .run(forget.id, forget.contentHash);
      l1.repository.addRelation({ id: "forget-relation", fromMemoryId: forget.id, toMemoryId: manual.id, relation: "SUPPORTS", createdAt: 1 });
      conn.exec("CREATE TRIGGER reject_settings_forget BEFORE DELETE ON memory_records " +
        "WHEN OLD.title='巡检步骤' BEGIN SELECT RAISE(ABORT,'fixture rejects forget'); END");
      conn.pragma("query_only = ON");
      await assert.rejects(settings.forgetKernelMemories([forget.id]), /fixture rejects forget/);
      assert.equal((await explorer.getKernelMemory(forget.id))?.content, "启用绿色工位");
      assert.equal(conn.prepare("SELECT content FROM memory_core_profiles WHERE id='forget-dots-profile'").pluck().get(), "启用绿色工位");
      assert.equal(conn.prepare("SELECT updated_at FROM projects WHERE id=?").pluck().get(forgetProjectId), projectStamp + 1);
      assert.equal(conn.prepare("SELECT COUNT(*) FROM memory_forget_targets WHERE scope_type='project' AND scope_id=?")
        .pluck().get(forgetProjectId), 0);

      conn.pragma("query_only = OFF");
      conn.exec("DROP TRIGGER reject_settings_forget");
      const editOnRetry = nativeDb.runtimeAuditReader!.memoryRecordsData.bind(nativeDb.runtimeAuditReader);
      let edited = false;
      nativeDb.runtimeAuditReader!.memoryRecordsData = async query => {
        const data = await editOnRetry(query);
        if (!edited && query.kind === "forgetSource" && query.id === forget.id) {
          edited = true;
          conn.pragma("query_only = OFF");
          try { conn.prepare("UPDATE memory_records SET content=? WHERE id=?").run("启用红色工位", forget.id); }
          finally { conn.pragma("query_only = ON"); }
        }
        return data;
      };
      conn.pragma("query_only = ON");
      try {
        await assert.rejects(settings.forgetKernelMemories([manual.id, forget.id]), /已删除 1 条；1 条失败：项目已归档/);
      } finally {
        nativeDb.runtimeAuditReader!.memoryRecordsData = editOnRetry;
        conn.pragma("query_only = OFF");
      }
      assert.equal((await explorer.getKernelMemory(manual.id))?.title, "项目记忆改名");
      assert.equal(await explorer.getKernelMemory(forget.id), undefined);
      assert.deepEqual(await explorer.kernelMemoryHistory(forget.id), []);
      assert.deepEqual(l1.repository.get(manual.id)?.relations, []);
      assert.equal(conn.prepare("SELECT COUNT(*) FROM memory_candidates WHERE id='forget-extracted'").pluck().get(), 0);
      assert.equal(conn.prepare("SELECT COUNT(*) FROM memory_embeddings WHERE memory_id=?").pluck().get(forget.id), 0);
      assert.equal(conn.prepare("SELECT COUNT(*) FROM memory_scenarios WHERE id='forget-dots-scenario'").pluck().get(), 0);
      assert.equal(conn.prepare("SELECT COUNT(*) FROM memory_core_profiles WHERE id='forget-dots-profile'").pluck().get(), 0);
      assert.equal(conn.prepare("SELECT status FROM memory_scenarios WHERE id='forget-project-scenario'").pluck().get(), "stale");
      assert.equal(conn.prepare("SELECT status FROM memory_skill_candidates WHERE id='forget-learned-skill'").pluck().get(), "stale");
      assert.equal(conn.prepare("SELECT updated_at FROM projects WHERE id=?").pluck().get(forgetProjectId), projectStamp + 2);
      const watermarks = new MemoryForgetWatermarks(conn);
      const previousText = "巡检步骤启用蓝色工位；巡检步骤启用绿色工位；巡检步骤启用红色工位；走西侧通道；保持南门可通行。";
      for (const scope of [
        { scopeType: "global" },
        { scopeType: "task", scopeId: DOTS_TASK_ID },
        { scopeType: "project", scopeId: forgetProjectId },
      ] as const) {
        const filter = watermarks.sourceFilter([scope]);
        assert.equal(filter(previousText, "", 1).userText, "保持南门可通行。");
        assert.equal(filter(previousText, "", projectStamp).userText, previousText);
      }
      conn.pragma("query_only = ON");
      await settings.forgetKernelMemories([forget.id]);
      assert.equal(conn.prepare("SELECT updated_at FROM projects WHERE id=?").pluck().get(forgetProjectId), projectStamp + 2);
      console.log("PASS Rust settings forget removes dependent data and blocks old evidence in every scope");
      conn.pragma("query_only = OFF");
      await verifySettingsScopeWrites(nativeDb, true);
    } finally {
      await nativeDb.runtimeAuditReader?.close();
      nativeDb.close();
    }
  }
  await verifySettingsScopeWrites(db, false);
} finally {
  db.close();
  rmSync(sandbox, { recursive: true, force: true });
}
