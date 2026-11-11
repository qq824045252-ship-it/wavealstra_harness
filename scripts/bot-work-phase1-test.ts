import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isMainThread, parentPort, Worker, workerData } from "node:worker_threads";
import Database from "better-sqlite3";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { BotWorkContextService } from "../src/main/agent/work/BotWorkContextService";
import { BotExpertBindingService } from "../src/main/agent/work/BotExpertBindingService";
import { WorkSourceObserver } from "../src/main/agent/work/WorkSourceObserver";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { ConversationGoalService } from "../src/main/agent/ConversationGoalService";
import { TaskExpertBindingService } from "../src/main/experts/TaskExpertBindingService";
import { ExpertService } from "../src/main/experts/ExpertService";
import { MemoryService } from "../src/main/memory/MemoryService";
import { projectMemoryContext } from "../src/main/agent/MemoryContextProjection";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkActor, type WorkControlResult, type CreateWorkParams } from "../src/shared/bot-work";

const user: WorkActor = { kind: "user", userId: LOCAL_USER_ID, entry: "desktop", grants: DESKTOP_USER_GRANTS };
function ok(result: WorkControlResult) {
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.work;
}
const concurrentRequest: CreateWorkParams = { operationId: "concurrent-create", title: "唯一委托",
  criteria: [{ id: "concurrent-c", text: "行为通过" }], ownerBotId: DEFAULT_BOT_ID, inputSnapshotId: "snapshot-concurrent" };

if (!isMainThread) {
  const connection = new Database(workerData.dbPath);
  connection.pragma("busy_timeout = 10000");
  const service = new WorkService(connection, { bots: new BotRegistry(connection) });
  parentPort!.once("message", () => {
    try { parentPort!.postMessage(service.createWork(user, concurrentRequest)); }
    finally { connection.close(); }
  });
  parentPort!.postMessage("ready");
} else {
  const root = mkdtempSync(join(tmpdir(), "mybuddy-phase1-"));
  process.env.USERPROFILE = root;
  process.env.HOME = root;
  const path = join(root, "app.db");
  let db = new AppDatabase(path);
  let bots = new BotRegistry(db.connection);
  bots.ensureDefaultBot(LOCAL_USER_ID);
  let work = new WorkService(db.connection, { bots });
  const create = (operationId: string, extra: Partial<CreateWorkParams> = {}) => ok(work.createWork(user, {
    operationId, title: operationId, ownerBotId: DEFAULT_BOT_ID, inputSnapshotId: `input-${operationId}`,
    authorization: { allowedScopes: ["workspace:read", "workspace:write"] }, ...extra,
  }));
  const dispatch = (workId: string, taskId: string, botId = DEFAULT_BOT_ID) => {
    db.upsertTask({ id: taskId, title: taskId, updatedAt: Date.now(), welcomeMode: "general" });
    ok(work.dispatchExecution(user, { operationId: `dispatch-${taskId}`, workId, botId, taskId,
      durableStoreKey: `store-${taskId}`, conversationId: `execution-${taskId}`, workspaceBinding: root }));
    return work.repo.bindingForTask(taskId)!;
  };
  try {
    // R01: independent real SQLite connections race on one host-scoped operation.
    const workers = Array.from({ length: 4 }, () => new Worker(new URL(import.meta.url), { workerData: { dbPath: path } }));
    const results = workers.map(worker => new Promise<WorkControlResult>((resolve, reject) => {
      worker.on("error", reject);
      worker.on("message", message => { if (message !== "ready") resolve(message); });
      worker.on("exit", code => { if (code !== 0) reject(new Error(`worker exit ${code}`)); });
    }));
    await Promise.all(workers.map(worker => new Promise<void>(resolve => worker.once("message", () => resolve()))));
    workers.forEach(worker => worker.postMessage("go"));
    const receipts = await Promise.all(results);
    assert.equal(new Set(receipts.map(result => ok(result).workId)).size, 1);
    assert.equal(receipts.filter(result => result.ok && !result.replayed).length, 1);
    assert.equal((db.connection.prepare("SELECT COUNT(*) n FROM work_operation_receipts WHERE operation_id=?").get(concurrentRequest.operationId) as { n: number }).n, 1);
    const concurrentId = ok(receipts[0]).workId;
    assert.equal(work.repo.listOutbox(concurrentId).length, 1);
    assert.equal(work.createWork(user, { ...concurrentRequest, title: " 唯一委托 ", constraints: [], mode: "once", goalSources: [] }).ok, true,
      "omitted defaults and normalized strings replay the effective request");
    assert.equal(work.createWork(user, { ...concurrentRequest, criteria: [{ id: "concurrent-c", text: "changed" }] }).ok, false);
    await Promise.all(workers.map(worker => new Promise<void>(resolve => worker.threadId === -1 ? resolve() : worker.once("exit", () => resolve()))));

    // R08: stable authenticated channel identity; no query creates a Work.
    bots.registerBot({ botId: "analyst-bot", userId: LOCAL_USER_ID, displayName: "分析员" });
    let context = new BotWorkContextService(db.connection, bots, work);
    context.bind(LOCAL_USER_ID, "desktop", "main-chat", "analyst-bot");
    context.bind(LOCAL_USER_ID, "gateway", "gateway-chat", "analyst-bot");
    assert.equal(context.resolveBot(LOCAL_USER_ID, "desktop", "main-chat", DEFAULT_BOT_ID).botId,
      context.resolveBot(LOCAL_USER_ID, "gateway", "gateway-chat", DEFAULT_BOT_ID).botId);
    assert.throws(() => context.bind("another-user", "desktop", "main-chat", "analyst-bot"), /不属于/);
    const count = work.listWorks(LOCAL_USER_ID).length;
    assert.equal(context.resolveWork(LOCAL_USER_ID, "plain-chat"), undefined);
    assert.equal(work.listWorks(LOCAL_USER_ID).length, count);
    const first = create("multi-first", { conversationId: "multi-chat" });
    const second = create("multi-second", { conversationId: "multi-chat" });
    assert.throws(() => context.resolveWork(LOCAL_USER_ID, "multi-chat"), /多个/);
    assert.throws(() => work.findLiveWorkForConversation("multi-chat"), /多个/);
    context.linkMessage(LOCAL_USER_ID, first.workId, "multi-chat", "card-first");
    assert.equal(context.resolveWork(LOCAL_USER_ID, "multi-chat", { messageId: "card-first" })?.workId, first.workId);
    assert.equal(context.resolveWork(LOCAL_USER_ID, "multi-chat", { workId: second.workId })?.workId, second.workId);
    assert.throws(() => context.resolveWork("another-user", "multi-chat", { workId: first.workId }), /引用/);

    // R05: editing a criterion is not verification; multi-operation adapter failures roll back.
    const goals = new ConversationGoalService(work, () => {});
    const goal = goals.create({ taskId: "goal-chat", title: "Goal", criteria: [{ text: "old" }] });
    assert(goal.ok);
    const criterion = goal.goal.criteria[0].id;
    const edited = goals.update({ goalId: goal.goal.id, criterionUpdates: [{ id: criterion, text: "new" }] });
    assert(edited.ok);
    assert.equal(edited.goal.criteria[0].status, "pending");
    assert.equal(edited.goal.criteria[0].text, "new");
    const before = work.getWork(goal.goal.id)!;
    const rejected = goals.update({ goalId: before.workId, title: "", criterionUpdates: [{ id: criterion, status: "met", evidence: "user check" }] });
    assert.equal(rejected.ok, false);
    assert.deepEqual(work.getWork(before.workId), before, "failed amend must roll back prior attestation and receipt");

    // R05: real host inspection can accept an unaffected portion; model assertions cannot.
    const partial = create("partial", { criteria: [{ id: "valid", text: "有效文件" }, { id: "blocked", text: "必需写入" }] });
    const binding = dispatch(partial.workId, "partial-task");
    const worker: WorkActor = { kind: "worker", botId: binding.botId, bindingId: binding.bindingId };
    const artifact = join(root, "result.txt");
    writeFileSync(artifact, "actual useful result");
    ok(work.submitDeliverable(worker, { operationId: "partial-result", workId: partial.workId, bindingId: binding.bindingId,
      deliverableId: "partial-d", summary: "可保留的部分成果", artifactRefs: [artifact], hasWriteConflicts: true,
      uncoveredScope: ["必需写入被资源锁阻止"], uncoveredCriterionIds: ["blocked"],
      evidence: [{ kind: "automated_test", sourceRef: "model claims PASS", criterionIds: ["valid"] }] }));
    const claimed = work.getProjection(partial.workId)!.deliverables[0].evidenceRefs;
    assert.equal(work.acceptDeliverable(user, { operationId: "claim-accept", workId: partial.workId, deliverableId: "partial-d",
      partialAcceptance: { reason: "只采纳有效部分", criterionIds: ["valid"] }, criterionUpdates: [{ criterionId: "valid", evidenceIds: claimed }] }).ok, false);
    assert.throws(() => work.verifyExecutionEvidence(binding.bindingId, { sourceRef: artifact, kind: "inspection", criterionIds: ["valid"],
      verify: () => ({ passed: false, detail: "failed inspection" }) }), /未通过/);
    const verified = work.verifyExecutionEvidence(binding.bindingId, { sourceRef: artifact, kind: "inspection", criterionIds: ["valid"],
      verify: () => { const body = readFileSync(artifact, "utf8"); return { passed: body === "actual useful result", detail: "host read actual file",
        sourceSha: createHash("sha256").update(body).digest("hex") }; } });
    const accepted = ok(work.acceptDeliverable(user, { operationId: "partial-accept", workId: partial.workId, deliverableId: "partial-d",
      partialAcceptance: { reason: "宿主核对文件，保留有效部分", criterionIds: ["valid"] },
      criterionUpdates: [{ criterionId: "valid", evidenceIds: [verified.evidenceId] }] }));
    assert.equal(accepted.criteria.find(c => c.id === "valid")?.status, "satisfied");
    assert.equal(accepted.criteria.find(c => c.id === "blocked")?.status, "pending");
    ok(work.reconcileExecution({ kind: "system", reason: "read-back" }, { bindingId: binding.bindingId, outcome: "completed" }));
    assert.equal(work.closeWork(user, { operationId: "partial-close", workId: partial.workId, conclusion: "succeeded" }).ok, false);
    const changed = ok(work.amendWork(user, { operationId: "new-constraints", workId: partial.workId, constraints: ["新增约束"] }));
    assert(changed.criteria.every(c => c.status === "pending" && c.verifiedIntentRevision === undefined));
    const repaired = dispatch(partial.workId, "repair-task");
    writeFileSync(artifact, "both requirements fulfilled");
    ok(work.submitDeliverable({ kind: "worker", botId: repaired.botId, bindingId: repaired.bindingId }, {
      operationId: "repair-result", workId: partial.workId, bindingId: repaired.bindingId,
      deliverableId: "repair-d", summary: "补齐新要求和必需写入", artifactRefs: [artifact] }));
    const repairProof = work.verifyExecutionEvidence(repaired.bindingId, { sourceRef: artifact, kind: "inspection", criterionIds: ["valid", "blocked"],
      verify: () => ({ passed: readFileSync(artifact, "utf8") === "both requirements fulfilled", detail: "host verified repaired actual file" }) });
    ok(work.acceptDeliverable(user, { operationId: "repair-accept", workId: partial.workId, deliverableId: "repair-d",
      criterionUpdates: ["valid", "blocked"].map(criterionId => ({ criterionId, evidenceIds: [repairProof.evidenceId] })) }));
    ok(work.reconcileExecution({ kind: "system", reason: "read-back" }, { bindingId: repaired.bindingId, outcome: "completed" }));
    assert.equal(ok(work.closeWork(user, { operationId: "repair-close", workId: partial.workId, conclusion: "succeeded" })).lifecycle, "closed");
    assert.equal(work.getProjection(partial.workId)!.deliverables.find(d => d.deliverableId === "partial-d")?.status, "accepted",
      "partial artifact remains reviewable after missing requirements are repaired");

    // R07: one watch round cannot end a continuing duty; finite stop is explicit and local.
    const watching = create("watching", { mode: "watch", watchRule: { subscriptions: ["file:watched"], stopConditionText: "用户确认跟进完成" } });
    const unrelated = create("unrelated-watch", { mode: "watch", watchRule: { subscriptions: ["file:unrelated"] } });
    assert.equal(work.closeWork({ kind: "bot", botId: DEFAULT_BOT_ID, userId: LOCAL_USER_ID, host: "foreground", grants: DESKTOP_USER_GRANTS }, {
      operationId: "watch-round", workId: watching.workId, conclusion: "succeeded", closureSummary: "本轮完成",
      versionGuard: { expectedStateVersion: watching.stateVersion, expectedIntentRevision: watching.intentRevision, expectedOwnerEpoch: watching.ownerEpoch } }).ok, false);
    assert.equal(work.getWork(watching.workId)?.lifecycle, "active");
    assert.equal(ok(work.closeWork(user, { operationId: "watch-stop", workId: watching.workId, conclusion: "succeeded",
      closureSummary: "用户确认停止条件已满足" })).lifecycle, "closed");
    assert(work.repo.listSubscriptions(watching.workId).every(subscription => subscription.stoppedAt));
    assert(work.repo.listSubscriptions(unrelated.workId).every(subscription => !subscription.stoppedAt));

    // R06: real external file changes and out-of-order source reads cannot roll back the target.
    const sourceWork = create("source-work");
    const observer = new WorkSourceObserver(work);
    const sourceFile = join(root, "external-input.txt");
    writeFileSync(sourceFile, "A");
    const sourceA = ok(await observer.file(user, sourceWork.workId, "source-A", sourceFile));
    let completeOldRead!: (value: { inputSnapshotId: string; sources: typeof sourceA.goalSources }) => void;
    const oldRead = observer.refresh(user, sourceWork.workId, "late-A-observation", () => new Promise(resolve => { completeOldRead = resolve; }));
    writeFileSync(sourceFile, "B");
    const sourceB = ok(await observer.file(user, sourceWork.workId, "source-B", sourceFile));
    assert.equal(sourceB.intentRevision, sourceA.intentRevision);
    assert.equal(sourceB.sourceVersion, sourceA.sourceVersion + 1);
    completeOldRead({ inputSnapshotId: sourceA.inputSnapshotId, sources: sourceA.goalSources });
    assert.equal((await oldRead).ok, false);
    assert.equal(work.getWork(sourceWork.workId)?.inputSnapshotId, sourceB.inputSnapshotId);
    assert.equal(ok(await observer.file(user, sourceWork.workId, "late-event-read-current", sourceFile)).inputSnapshotId, sourceB.inputSnapshotId);

    // A23/R09: real installed expert, complete skill packages, frozen per-execution assembly.
    const source = join(root, "expert-source");
    mkdirSync(join(source, "agents"), { recursive: true });
    mkdirSync(join(source, "skills", "calibration", "references"), { recursive: true });
    writeFileSync(join(source, "agents", "phase1-analyst.md"), "---\nname: phase1-analyst\ndisplayName: Phase1 analyst\ndescription: fixture\n---\nIdentity one\n");
    writeFileSync(join(source, "skills", "calibration", "SKILL.md"), "---\nname: calibration\ndescription: fixture calibration\n---\nRead references/curve.txt\n");
    writeFileSync(join(source, "skills", "calibration", "references", "curve.txt"), "curve one");
    const experts = new ExpertService();
    const installed = experts.installByPath(source);
    let globalSkillEnabled = true;
    const taskExperts = new TaskExpertBindingService(db, experts, { rootDir: join(root, "task-experts"), isSkillEnabled: () => globalSkillEnabled });
    const expertBindings = new BotExpertBindingService(bots, experts, taskExperts, { rootDir: join(root, "bot-experts") });
    const staged = expertBindings.stage("analyst-bot", LOCAL_USER_ID, installed.id);
    assert(staged.ok);
    assert.equal(bots.adoptExpertVersion("analyst-bot", {}).ok, false, "adoption requires reviewed identity");
    assert(bots.adoptExpertVersion("analyst-bot", { pendingVersion: staged.pendingVersion }).ok);
    const expertWork = create("expert-work", { ownerBotId: "analyst-bot" });
    const oldBinding = dispatch(expertWork.workId, "expert-task", "analyst-bot");
    const detail = experts.getDetail(installed.id);
    const editedExpert = experts.update({ id: installed.id, name: detail.name, description: detail.description,
      instructions: "Identity two", expectedRevision: detail.revision, mcpIds: ["mcp-two"], connectorIds: ["connector-two"] });
    const nextVersion = expertBindings.stage("analyst-bot", LOCAL_USER_ID, installed.id);
    assert(nextVersion.ok);
    assert(bots.adoptExpertVersion("analyst-bot", { pendingVersion: nextVersion.pendingVersion }).ok);
    assert.equal(bots.adoptExpertVersion("analyst-bot", { pendingVersion: staged.pendingVersion }).ok, false);
    experts.uninstall(installed.id);
    expertBindings.install(oldBinding);
    assert.match(taskExperts.active("expert-task")!.instructions, /Identity one/);
    assert.equal(readFileSync(join(taskExperts.activeSkillDirectories("expert-task")[0], "references", "curve.txt"), "utf8"), "curve one");
    db.upsertTask({ id: "global-snapshot-task", title: "global snapshot", updatedAt: Date.now() });
    taskExperts.installFrozen("global-snapshot-task", { ...oldBinding.expertSnapshot.configuration!, revision: "frozen-global", skillIds: ["global-one"] },
      [{ id: "global-one", directory: oldBinding.expertSnapshot.skillPackages![0].directory, origin: "global" }]);
    assert.equal(taskExperts.activeSkillDirectories("global-snapshot-task").length, 1);
    globalSkillEnabled = false;
    assert.equal(taskExperts.activeSkillDirectories("global-snapshot-task").length, 0, "host revocation remains effective after snapshot copying");
    assert.equal(taskExperts.activeSkillDirectories("expert-task").length, 1, "private package remains task owned");
    const newerWork = create("new-expert-work", { ownerBotId: "analyst-bot" });
    const newerBinding = dispatch(newerWork.workId, "new-expert-task", "analyst-bot");
    expertBindings.install(newerBinding);
    assert.equal(taskExperts.active("new-expert-task")!.instructions, editedExpert.instructions);
    assert.deepEqual(taskExperts.active("new-expert-task")!.mcpIds, ["mcp-two"]);
    assert.deepEqual(taskExperts.active("new-expert-task")!.connectorIds, ["connector-two"]);

    // A07/A08: existing Memory Kernel and actual prompt projection obey Bot/Work visibility.
    db.connection.prepare("INSERT INTO projects(id,name,created_at,updated_at,archived,resource_budget_chars) VALUES ('shared-project','shared',?,?,0,128000)")
      .run(Date.now(), Date.now());
    const scoped = create("memory-work", { projectId: "shared-project" });
    dispatch(scoped.workId, "memory-task");
    const memory = new MemoryService(db, { semantic: false });
    const own = memory.create({ kind: "preference", title: "own bot private", scopeType: "bot", scopeId: DEFAULT_BOT_ID, sourceType: "user" });
    const other = memory.create({ kind: "preference", title: "other bot private", scopeType: "bot", scopeId: "analyst-bot", sourceType: "user" });
    const global = memory.create({ kind: "preference", title: "personal global", scopeType: "global", sourceType: "user" });
    const shared = memory.create({ kind: "fact", title: "shared project fact", scopeType: "project", scopeId: "shared-project", sourceType: "user" });
    const visible = memory.search({ taskId: "memory-task", botId: "analyst-bot", limit: 30 }).map(hit => hit.memory.id);
    assert(visible.includes(own.id) && visible.includes(shared.id));
    assert(!visible.includes(other.id) && !visible.includes(global.id), "caller fields cannot replace authoritative execution identity");
    const prompt = projectMemoryContext(memory, { taskId: "memory-task", limit: 30, trackRecall: false });
    assert.match(prompt.text, /own bot private/);
    assert.match(prompt.text, /shared project fact/);
    assert.doesNotMatch(prompt.text, /other bot private|personal global/);
    context.bind(LOCAL_USER_ID, "desktop", "private-bot-chat", "analyst-bot");
    db.upsertTask({ id: "private-bot-chat", title: "Bot 前台", updatedAt: Date.now(), welcomeMode: "general" });
    const foregroundPrompt = projectMemoryContext(memory, { taskId: "private-bot-chat", limit: 30, trackRecall: false });
    assert.match(foregroundPrompt.text, /other bot private/);
    assert.doesNotMatch(foregroundPrompt.text, /own bot private|personal global/);
    assert.deepEqual(memory.inferAgentScope("private-bot-chat"), { scopeType: "bot", scopeId: "analyst-bot" });
    assert.equal(memory.canPromoteFromTask("private-bot-chat", "global"), false);
    assert.deepEqual(memory.inferAgentScope("memory-task"), { scopeType: "work", scopeId: scoped.workId });
    assert.equal(memory.canPromoteFromTask("memory-task", "global"), false);
    assert.equal(memory.canPromoteFromTask("memory-task", "project", "shared-project"), true);
    assert.equal(memory.canPromoteFromTask("memory-task", "project", "unbound-project"), false);
    assert.throws(() => memory.create({ kind: "fact", title: "speculation", scopeType: "global", sourceType: "agent", sourceTaskId: "memory-task" }), /记忆写入范围不属于当前/);
    assert(memory.search({ limit: 30 }).some(hit => hit.memory.id === global.id), "ordinary memory context retains global behavior");

    // Disable preserves settlement responsibility but blocks fresh business even on another active worker.
    const disabled = create("disable-owner", { ownerBotId: "analyst-bot" });
    bots.disableBot("analyst-bot");
    assert.equal(work.dispatchExecution(user, { operationId: "disabled-dispatch", workId: disabled.workId, botId: DEFAULT_BOT_ID,
      taskId: "unused", durableStoreKey: "unused", conversationId: "unused", workspaceBinding: root }).ok, false);
    assert(work.getWork(disabled.workId));

    // Reopen actual storage: channel mappings, message references, experts and memory all survive.
    db.close();
    db = new AppDatabase(path);
    bots = new BotRegistry(db.connection);
    work = new WorkService(db.connection, { bots });
    context = new BotWorkContextService(db.connection, bots, work);
    assert.equal(context.resolveWork(LOCAL_USER_ID, "multi-chat", { messageId: "card-first" })?.workId, first.workId);
    assert.equal(work.repo.getBinding(oldBinding.bindingId)?.expertSnapshot.configuration?.instructions, oldBinding.expertSnapshot.configuration?.instructions);
    assert.equal(new MemoryService(db, { semantic: false }).canAccess(other.id, { taskId: "memory-task" }), false);
    console.log("bot work Phase 1: passed (concurrent SQLite, host identity, references, acceptance, real expert assembly, memory projection, durable reopen)");
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}
