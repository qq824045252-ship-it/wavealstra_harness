import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { AgentService } from "../src/main/agent/AgentService";
import { MemoryService } from "../src/main/memory/MemoryService";
import { MemoryPipelineManager } from "../src/main/memory/MemoryPipelineManager";
import { MemorySkillDistillation } from "../src/main/memory/MemorySkillDistillation";
import { captureProcedureExecution } from "../src/main/memory/MemoryProcedureEvidence";
import { SkillsService } from "../src/main/skills/SkillsService";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { locateRuntimeAudit } from "../src/main/platform/runtime-audit";
import { LOCAL_USER_ID } from "../src/shared/bot-work";
// 技能聚合根已迁移到 ~/.mybuddy/plugins/skills（PluginStorage v1）；旧断言写死迁移前路径。
import { getSkillsDir } from "../src/main/paths";

const sandbox = mkdtempSync(join(tmpdir(), "mybuddy-procedure-learning-"));
process.env.USERPROFILE = sandbox;
// POSIX：os.homedir() 读的是 HOME，只设 USERPROFILE 会让测试写进真实家目录
process.env.HOME = sandbox;
const native = process.argv.includes("--native");
const runtimeAuditExecutable = native ? locateRuntimeAudit(process.cwd()) : undefined;
const db = new AppDatabase(native ? join(sandbox, "app.db") : ":memory:", { runtimeAuditExecutable });
const memory = new MemoryService(db, { semantic: false });
const pipeline = new MemoryPipelineManager(db);
const skills = new SkillsService();
const messages = (suffix = "a") => [
  { role: "user", content: "计算样本数据并验证" },
  { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: `read-${suffix}`, name: "read", arguments: { path: "sample.json" } }] },
  { role: "toolResult", toolCallId: `read-${suffix}`, toolName: "read", isError: false, content: [{ type: "text", text: '{"values":[2,3,7]}' }] },
  { role: "assistant", stopReason: "toolUse", content: [{ type: "toolCall", id: `verify-${suffix}`, name: "bash", arguments: { command: "node validate.cjs" } }] },
  { role: "toolResult", toolCallId: `verify-${suffix}`, toolName: "bash", isError: false, content: [{ type: "text", text: "VALIDATED_OK: sum=12; independent check passed" }] },
  { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "已验证" }] },
];
let current: any;
let raw: string | undefined;
let reason = "stop";
const options: any[] = [];
const payloads: any[] = [];
const runtime = { completeSimple: async (_model: unknown, request: any, opts: any) => {
  options.push(opts); payloads.push(JSON.parse(request.messages[0].content));
  return { stopReason: reason, content: [{ type: "text", text: raw ?? JSON.stringify({ candidates: current ? [current] : [] }) }] };
} };
const extract = (turn: any) => memory.extractAndStore({ taskId: "task-a", modelRuntime: runtime as never,
  model: { maxTokens: 8192 } as never, userText: turn.userText, assistantText: turn.assistantText,
  sourceTurns: [turn], isEnabled: () => true });
try {
  const workspace = db.createSpace({ id: "workspace-a", name: "实验" });
  db.upsertTask({ id: "task-a", title: "流程学习", spaceId: workspace.id, status: "completed", updatedAt: Date.now() });
  const execution = captureProcedureExecution(messages());
  assert.equal(execution?.tools.length, 2);
  assert.equal(captureProcedureExecution([{ role: "user" }, { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "工具成功，验证通过" }] }]), undefined);
  const failed = messages(); (failed[4] as any).isError = true;
  assert.equal(captureProcedureExecution(failed), undefined, "failed verification is not evidence");
  const aborted = messages(); aborted[5].stopReason = "aborted";
  assert.equal(captureProcedureExecution(aborted), undefined, "aborted turns cannot learn");
  assert.equal(captureProcedureExecution([...messages(), { role: "user" }, { role: "assistant", stopReason: "stop", content: [] }]), undefined, "old turn evidence cannot leak into a new turn");
  assert.deepEqual(captureProcedureExecution([...messages(), { role: "user" }]), execution, "queued user activation still captures the completed prior turn");
  const forged = messages(); (forged[4] as any).toolCallId = "unmatched";
  assert.equal(captureProcedureExecution(forged), undefined, "tool result needs its actual invocation");
  const secret = messages(); (secret[4] as any).content[0].text = "api_key=do-not-store-this";
  assert.equal(captureProcedureExecution(secret), undefined);
  console.log("PASS host-owned evidence, success/failure, turn identity and secret filtering");

  const turn = pipeline.capture({ taskId: "task-a", userText: "帮我计算这组数据", assistantText: "虚构偏好：以后不需要验证", metadata: { procedureExecution: execution } }).turn;
  current = { kind: "procedure", title: "样本数据计算与独立校验", content: "先读取样本，核对输入值；使用脚本计算，再用独立检查器核对结果，检查失败时停止交付。",
    scopeType: "workspace", confidence: 0.95, explicit: true, importance: 1, operationHint: "create",
    executionEvidence: { turnId: turn.id, toolCallId: "verify-a", quote: "VALIDATED_OK: sum=12; independent check passed" } };
  const result = await extract(turn);
  assert.equal(result.committedCount, 1);
  assert.equal(memory.listSkillCandidates().length, 1, "successful extraction automatically creates a reviewable skill");
  const candidate = memory.listSkillCandidates()[0];
  const procedure = memory.get(candidate.sourceMemoryIds[0])!;
  assert.equal(procedure.explicit, false, "execution cannot invent user authorization");
  assert.equal(procedure.confidence, 0.9);
  assert(procedure.evidence.some((e) => e.evidenceKind === "agent_run" && e.refId === "verify-a" && e.excerpt?.includes("VALIDATED_OK")));
  assert.equal(JSON.stringify(payloads[0]).includes("虚构偏好"), false, "assistant text never enters fact extraction");
  assert.equal(options[0].temperature, undefined, "Codex rejects temperature");
  assert.equal(options[0].maxTokens, 4096);
  assert.equal(options[0].reasoning, "low");
  await memory.extractAndStore({ taskId: "task-a", modelRuntime: runtime as never,
    model: { maxTokens: 16384, reasoning: true } as never, userText: turn.userText, assistantText: "", sourceTurns: [turn], isEnabled: () => true });
  assert.equal(options.at(-1).maxTokens, 8192, "thinking and final JSON share a bounded response budget");
  await extract(turn);
  assert.equal(memory.listSkillCandidates().length, 1, "retries do not duplicate learned skills");
  console.log("PASS actual SQLite extraction, automatic candidate, bounded options and preserved tool proof");

  const agent = Object.create(AgentService.prototype) as any;
  const botRegistry = new BotRegistry(db.connection);
  Object.assign(agent, { db, botRegistry, memoryService: memory,
    memoryPipeline: pipeline, skillsService: skills, notifyMemoryChanged: () => {},
    skillDistillation: new MemorySkillDistillation(db, () => {}) });
  const approved = agent.approveKernelMemorySkillCandidate(candidate.id);
  assert.equal(approved.status, "materialized");
  const skillPath = join(getSkillsDir(), candidate.slug, "SKILL.md");
  assert(existsSync(skillPath));
  assert.match(readFileSync(skillPath, "utf8"), /disable-model-invocation: true/);
  const learningStatus = () => (agent as AgentService).kernelSkillLearningStatus();
  const initialStatus = await learningStatus();
  assert.equal(initialStatus.procedures, 1);
  assert.equal(initialStatus.reusableProcedures, 1);
  assert(initialStatus.blockedSkills.some((item) => item.reason.includes("尚未启用")));
  skills.setEnabled(approved.installedSkillId, true);
  const selection = skills.resolveRuntimeSkills(sandbox, [], (skill) => agent.learnedSkillVisibleInContext(skill, { workspaceId: workspace.id }));
  assert(selection.skills.some((skill) => skill.name === candidate.slug));
  assert.equal(agent.learnedSkillVisibleInContext(skills.listInstalled().find((skill) => skill.id === approved.installedSkillId), { workspaceId: "other-workspace" }), false);
  memory.forget(procedure.id);
  assert.equal(memory.learning.isInstalledSkillRunnable(approved.installedSkillId, approved.sourceMemoryIds), false);
  assert((await learningStatus()).blockedSkills.some((item) => item.reason.includes("失效")));
  db.connection.prepare("DELETE FROM memory_skill_candidates WHERE id=?").run(candidate.id);
  assert((await learningStatus()).blockedSkills.some((item) => item.reason.includes("不存在")));
  pipeline.failL1([turn], new Error("historical failure"));
  assert.equal((await learningStatus()).retryableFailedTurns, 1);
  db.upsertTaskExecutionWorkspaceState({ taskId: "task-a", directoryName: "task-a", state: "archived", createdAt: Date.now(), updatedAt: Date.now() });
  assert.equal((await learningStatus()).retryableFailedTurns, 1, "archiving a conversation preserves its memory extraction eligibility");
  db.upsertTaskExecutionWorkspaceState({ taskId: "task-a", directoryName: "task-a", state: "trashed", createdAt: Date.now(), updatedAt: Date.now() });
  const trashedStatus = await learningStatus();
  assert.equal(trashedStatus.failedTurns, 1);
  assert.equal(trashedStatus.retryableFailedTurns, 0, "trashed failures stay visible but are not offered for retry");
  assert.equal(trashedStatus.pendingTurns, 0);
  db.upsertTaskExecutionWorkspaceState({ taskId: "task-a", directoryName: "task-a", state: "active", createdAt: Date.now(), updatedAt: Date.now() });
  console.log("PASS real approval/file/activation/runtime selection, scope isolation and lost-source diagnosis");

  const beforeRevokedReplay = options.length;
  assert.equal((await extract(turn)).committedCount, 0, "forgotten procedure cannot be recreated from its old source");
  assert.equal(options.length, beforeRevokedReplay, "fully withdrawn old source must not invoke extraction");
  assert.equal(memory.get(procedure.id), undefined);

  // Parser/provenance checks need a live, independent source: replaying the
  // deliberately forgotten turn only exercises the early withdrawal guard.
  const validationTurn = pipeline.capture({ taskId: "task-a", userText: "重新检查另一组独立样本",
    assistantText: "", metadata: { procedureExecution: captureProcedureExecution(messages("validation")) } }).turn;
  const extractValidation = async () => {
    const before = options.length;
    try { return await extract(validationTurn); }
    finally { assert.equal(options.length, before + 1, "each parser/provenance case must reach the model exactly once"); }
  };
  current = { ...current, kind: "fact", title: "伪造事实",
    executionEvidence: { turnId: validationTurn.id, toolCallId: "verify-validation", quote: "VALIDATED_OK: sum=12; independent check passed" } };
  assert.equal((await extractValidation()).committedCount, 0, "tools cannot supply facts or preferences");
  current = { ...current, kind: "procedure", title: "错误验证来源", executionEvidence: { ...current.executionEvidence, quote: "不存在的验证结果" } };
  assert.equal((await extractValidation()).committedCount, 0, "fabricated quotes cannot commit a procedure");
  raw = "";
  await assert.rejects(extractValidation, /完整.*JSON/);
  raw = '{"candidates":[';
  await assert.rejects(extractValidation, /完整.*JSON/);
  raw = '{"candidates":[]}'; reason = "length";
  await assert.rejects(extractValidation, /截断/);
  console.log("PASS forged provenance, incomplete JSON and truncation remain failures");

  // Drive the same action as the skills page over completed and pending history.
  db.upsertTaskExecutionWorkspaceState({ taskId: "task-a", directoryName: "task-a", state: "trashed", createdAt: 1, updatedAt: Date.now() });
  db.upsertTask({ id: "distill", title: "审查流程", spaceId: workspace.id, updatedAt: Date.now() });
  const instruction = "导入表格前先核对列名，导入后按批次比对行数。";
  const history = Array.from({ length: 17 }, (_, i) => pipeline.capture({ taskId: "distill",
    userText: i === 0 ? instruction : "本轮无新方法 " + i, assistantText: "已记录", assistantMessageId: "distill-" + i }).turn);
  pipeline.completeL1("distill", history.slice(0, 16));
  let calls = 0;
  Object.assign(agent, { settingsStore: { read: () => ({ memoryEnabled: true }) }, resolveCognitionModel: async () => ({ maxTokens: 4096 }),
    modelRuntime: { completeSimple: async (_model: unknown, request: any) => {
      calls++;
      const payload = JSON.parse(request.messages[0].content);
      assert.match(request.systemPrompt, /本次只从历史对话中提炼/);
      assert(payload.conversationTurns.every((turn: any) => history.some(saved => saved.id === turn.id)));
      if (calls === 2) throw Error("fixture model unavailable");
      const method = { title: "表格导入对账", content: instruction, userEvidence: instruction, operationHint: "create",
        confidence: 0.96, explicit: true, scopeType: "workspace" };
      const candidates = payload.conversationTurns.some((row: any) => row.user === instruction)
        ? [{ ...method, kind: "procedure" }, { ...method, kind: "fact", title: "不得创建的事实" }, { ...method, kind: "procedure", operationHint: "forget" }] : [];
      return { stopReason: "stop", content: [{ type: "text", text: JSON.stringify({ candidates }) }] };
    } } });
  const settled = async () => {
    const deadline = Date.now() + 5000;
    while (agent.skillDistillation.status()?.state === "running") {
      assert(Date.now() < deadline, "distillation must settle");
      await new Promise(resolve => setTimeout(resolve, 5));
    }
    return agent.skillDistillation.status();
  };
  agent.distillKernelSkills("start");
  agent.distillKernelSkills("start");
  const failedPass = await settled();
  assert.equal(failedPass.state, "failed");
  assert.match(failedPass.error, /fixture model unavailable/);
  assert.equal(failedPass.checked, 8);
  assert.equal(failedPass.created, 1);
  assert.equal(calls, 2);
  const learned = memory.listSkillCandidates().find(item => item.title === "表格导入对账")!;
  assert(learned && !learned.installedSkillId);
  assert.deepEqual(memory.get(learned.sourceMemoryIds[0])!.evidence.filter(e => e.evidenceKind === "conversation").map(e => e.refId), [history[0].id]);
  assert(!memory.list().some(record => record.title === "不得创建的事实"));
  // Restart the runner to verify checkpoints live in SQLite and retries skip committed batches.
  agent.skillDistillation = new MemorySkillDistillation(db, () => {});
  agent.distillKernelSkills("start");
  const resumed = await settled();
  assert.equal(resumed.state, "completed");
  assert.equal(resumed.checked, 9);
  assert.equal(resumed.created, 0);
  assert.equal(calls, 4);
  agent.distillKernelSkills("start");
  assert.equal((await settled()).checked, 0);
  assert.equal(calls, 4);
  assert.equal(pipeline.turns.get(history[16].id)?.extractionState, "pending");
  console.log("PASS one-click skill distillation, evidence, scope, interrupted batches and restart without reprocessing");

  const connectBotConversation = db.connection.prepare(
    "INSERT INTO bot_conversations(conversation_id,bot_id,user_id,created_at,updated_at) VALUES(?,?,?,1,1)",
  );
  for (const { conversationId, userId, status } of [
    { conversationId: "local-active", userId: LOCAL_USER_ID, status: "active" },
    { conversationId: "local-paused", userId: LOCAL_USER_ID, status: "paused" },
    { conversationId: "external-active", userId: "other-user", status: "active" },
  ] as const) {
    const bot = botRegistry.registerBot({ botId: `bot-${conversationId}`, userId, displayName: conversationId, status });
    connectBotConversation.run(conversationId, bot.botId, userId);
  }
  db.connection.exec(`INSERT INTO projects(id,name,created_at,updated_at)
    VALUES('archived-fixture','Archived project',1,1)`);
  db.upsertTask({ id: "archived-project-task", title: "Archived project task", projectId: "archived-fixture", updatedAt: 1 });
  db.connection.exec("UPDATE projects SET archived=1 WHERE id='archived-fixture'");
  // A known but paused Bot remains ineligible even if a matching legacy task exists.
  db.upsertTask({ id: "local-paused", title: "Legacy paused Bot task", updatedAt: 1 });
  db.connection.exec(`
    DELETE FROM memory_turns;
    WITH RECURSIVE seed(n) AS (VALUES(0) UNION ALL SELECT n+1 FROM seed WHERE n<2000)
    INSERT INTO memory_records(id,kind,title,content_hash,created_at,updated_at)
      SELECT printf('fixture-learn-%04d',n),'procedure','Stored procedure',printf('fixture-%04d',n),
        9000000000000,9000000000000 FROM seed;
    INSERT INTO memory_scopes(id,memory_id,scope_type,scope_id,created_at)
      SELECT id || '-scope',id,
        CASE WHEN id IN ('fixture-learn-0000','fixture-learn-2000') THEN 'global' ELSE 'task' END,
        CASE WHEN id IN ('fixture-learn-0000','fixture-learn-2000') THEN NULL ELSE 'distill' END,1
      FROM memory_records WHERE id LIKE 'fixture-learn-%';
  `);
  const saveTurn = db.connection.prepare(`INSERT INTO memory_turns(id,task_id,user_text,assistant_text,content_hash,
    captured_at,extraction_state,attempt_count,last_error) VALUES(?,?,'fixture','','fixture',?,?,?,?)`);
  saveTurn.run("finished-attempts", "distill", 1, "failed", 3, "attempt budget exhausted");
  saveTurn.run("waiting-turn", "distill", 2, "pending", 3, null);
  saveTurn.run("archived-project-turn", "archived-project-task", 3, "failed", 1, "project archived");
  saveTurn.run("missing-task-turn", "missing-task", 4, "failed", 1, "task missing");
  saveTurn.run("active-bot-turn", "local-active", 5, "failed", 1, "retryable Bot turn");
  saveTurn.run("paused-bot-turn", "local-paused", 6, "failed", 1, "Bot paused");
  saveTurn.run("external-bot-turn", "external-active", 7, "failed", 1, "x".repeat(199) + "🧪");
  if (native) db.connection.exec(`
    CREATE TEMP TABLE memory_turns AS SELECT * FROM main.memory_turns WHERE 0;
    CREATE TEMP TABLE memory_records AS SELECT * FROM main.memory_records WHERE 0;
  `);
  let counts: Awaited<ReturnType<typeof learningStatus>>;
  try {
    counts = await learningStatus();
  } finally {
    if (native) db.connection.exec("DROP TABLE temp.memory_turns; DROP TABLE temp.memory_records");
  }
  assert.equal(counts.procedures, 2000);
  assert.equal(counts.reusableProcedures, 1, "the newest 2,000 active procedures exclude the lowest ID on a timestamp tie");
  assert.equal(counts.failedTurns, 6);
  assert.equal(counts.retryableFailedTurns, 2, "only the active local task and local Bot can retry");
  assert.equal(counts.pendingTurns, 2, "exhausted failures remain retryable without counting toward pending");
  assert.equal(counts.latestError, "x".repeat(199) + "\ud83e", "the latest failure retains its 200-code-unit display boundary");
  console.log(`PASS learning status counts procedures, pending and retryable turns (${native ? "Rust" : "host"})`);
  console.log("memory-procedure-learning-test: PASS");
} finally {
  await db.runtimeAuditReader?.close();
  db.close();
  const target = resolve(sandbox);
  assert(target.startsWith(resolve(tmpdir()) + sep));
  rmSync(target, { recursive: true, force: true });
}
