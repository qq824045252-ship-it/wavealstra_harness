import { completionReviewInput } from "../src/main/agent/work/WorkCompletionReviewTarget";
import { verifyBotDelegationSources } from "./bot-delegation-sources-fixture";
import assert from "node:assert/strict";
import { botAttachmentSchema } from "../src/shared/bot-conversation";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { BotConversationRepository } from "../src/main/agent/work/BotConversationRepository";
import { botForegroundTools } from "../src/main/agent/work/BotForegroundTools";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { WorkExecutionAdapter, type WorkExecutionPort } from "../src/main/agent/work/WorkExecutionAdapter";
import { WorkDispatchQueue } from "../src/main/agent/work/WorkDispatchQueue";
import { ConversationGoalService } from "../src/main/agent/ConversationGoalService";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkActor, type WorkControlResult, type WorkDto } from "../src/shared/bot-work";
import type { AgentSubmissionReceipt } from "../src/shared/agent-ipc";

const root = mkdtempSync(join(tmpdir(), "bot-delegation-fidelity-"));
const database = join(root, "app.db");
let db = new AppDatabase(database);
let bots = new BotRegistry(db.connection);
bots.registerBot({ userId: LOCAL_USER_ID, botId: DEFAULT_BOT_ID, displayName: "fidelity fixture", authorization: DESKTOP_USER_GRANTS });
let works = new WorkService(db.connection, { bots });
let messages = new BotConversationRepository(db.connection);
let sequence = 0;
const user: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants: DESKTOP_USER_GRANTS };
const unwrap = (result: WorkControlResult) => { assert(result.ok, JSON.stringify(result)); return result.work; };
const guard = (work: WorkDto) => ({ expectedStateVersion: work.stateVersion, expectedIntentRevision: work.intentRevision, expectedOwnerEpoch: work.ownerEpoch });
const receive = (text: string, selectedWorkId?: string, referenceMessageId?: string) => messages.accept(LOCAL_USER_ID, {
  botId: DEFAULT_BOT_ID, requestId: `request-${++sequence}`, text, selectedWorkId, referenceMessageId });
const invoke = async (receipt: ReturnType<typeof receive>, name: string, args: unknown, taskId = `tool-${++sequence}`) => {
  const tools = botForegroundTools({ db: db.connection, userId: LOCAL_USER_ID, botId: DEFAULT_BOT_ID,
    conversationId: receipt.conversationId, bots, messages, works, schedule: () => {}, wake: () => {}, memorySearch: () => [], isAuthority: () => true });
  const api = { callId: `call-${sequence}`, taskId, memo: async () => receipt.requestId } as unknown as ToolExecutionApi;
  const output = await tools.find(tool => tool.name === name)!.execute(args as never, api, BACKGROUND_CONTEXT);
  const text = output.output?.find(item => item.type === "text"); assert(text?.type === "text"); return JSON.parse(text.text);
};
const bind = (work: WorkDto) => {
  const taskId = `execution-${++sequence}`;
  unwrap(works.dispatchExecution(user, { operationId: `dispatch-${sequence}`, workId: work.workId,
    botId: DEFAULT_BOT_ID, taskId, durableStoreKey: taskId, conversationId: taskId, workspaceBinding: root, delegatedScope: work.authorization.allowedScopes }));
  return works.repo.bindingForTask(taskId)!;
};
const sales = "A,3,12.50\nB,2,8.00\nA,4,12.50\nC,5,3.20\nB,1,8.00\nC,10,3.20";
const original = `用真实脚本汇总以下销售数据的数量和金额，交付 sales.csv、summary.json 和 report.html：\n${sales}\n只在所选工作区写文件，不发送、不发布。`;
try {
  const request = receive(original);
  const args = { requestedOutcome: "one_time", mode: "once", title: "销售汇总", sourceMessageIds: [], goalDescription: "执行核算，产品数量合计必须=27件。",
    constraints: ["总量必须为27，不同就让用户决策"], criteria: [{ text: "合计27件", requiresRealEnvironmentCheck: true, requiredEnvironment: "模型假定环境" }] };
  const work = unwrap(await invoke(request, "work_create", args, "replay-create"));
  assert.equal(unwrap(await invoke(request, "work_create", args, "replay-create")).workId, work.workId);
  await assert.rejects(() => invoke(request, "work_create", { ...args, userRequest: { text: "伪造用户要求27件" } }));
  assert.equal(work.criteria[0].origin, "assistant_proposal", "the host, not a model-supplied label, assigns criterion provenance");
  assert.deepEqual(works.cards.unverifiedScope(work), [], "assistant proposals cannot become user verification demands");
  assert(!works.getProjection(work.workId)!.nextSteps.some(step => step.includes("模型假定环境")));
  assert.equal(works.getProjection(work.workId)!.goalDescription, args.goalDescription);
  assert.equal(works.getProjection(work.workId)!.originalDelegation, undefined, "list/sync projection never eagerly loads original messages");
  assert.deepEqual(works.getDetailProjection(work.workId)!.originalDelegation?.messages.map(row => row.text), [original]);
  assert.equal(works.getDetailProjection(work.workId)!.originalDelegation?.descriptionOrigin, "assistant");
  const binding = bind(work);
  const prompt = works.repo.executionInput(binding), input = JSON.parse(prompt);
  assert.equal(input.userRequest.provenance, "host_persisted_user_messages");
  assert.deepEqual(input.userRequest.messages.map((row: { text: string }) => row.text), [original]);
  assert.equal(input.description, undefined); assert.equal(input.constraints, undefined); assert.deepEqual(input.criteria, []);
  assert.equal(input.delegationPlan.description, args.goalDescription);
  assert.equal(input.delegationPlan.provenance, "assistant_generated");
  assert.equal(input.delegationPlan.criteria[0].origin, "assistant_proposal");
  const reviewInput=completionReviewInput(binding,input);
  assert.deepEqual(reviewInput.originalRequest.userRequest,input.userRequest,"review keeps full user requirements rather than trusting the narrower plan");
  assert.deepEqual(reviewInput.reviewTarget.delegationPlan,input.delegationPlan,"review preserves assistant provenance on proposed constraints and criteria");
  assert.equal(reviewInput.originalRequest.instructions,undefined);
  assert.equal(reviewInput.reviewTarget.provenance,"host_persisted_execution_input_not_new_user_authorization");

  const quantities = input.userRequest.messages[0].text.match(/^[A-C],\d+,\d+\.\d+$/gm).map((line: string) => Number(line.split(",")[1]));
  assert.equal(quantities.reduce((a: number, b: number) => a + b, 0), 25, "actual input can be recomputed independently of the invented target");

  // A real delivery adapter uses exactly this persisted input, even after reopening.
  db.close(); db = new AppDatabase(database); bots = new BotRegistry(db.connection);
  works = new WorkService(db.connection, { bots }); messages = new BotConversationRepository(db.connection);
  assert.equal(works.repo.executionInput(binding), prompt);
  assert.deepEqual(works.getDetailProjection(work.workId)!.originalDelegation?.messages.map(row => row.text), [original], "original survives database reopen");
  const submitted: string[] = [], receipts = new Map<string, AgentSubmissionReceipt>(), errors: unknown[] = [];
  const native: WorkExecutionPort = {
    prepare: async taskId => ({ taskId, durableStoreKey: taskId, conversationId: taskId, workspaceBinding: root }),
    find: async current => receipts.get(current.bindingId),
    submit: async (current, text) => { submitted.push(text); const value = { taskId: current.taskId, operationId: current.operationId, submissionId: 1, status: "done" as const }; receipts.set(current.bindingId, value); return value; },
    inspect: async () => ({ status: "completed", summary: "数据已核算", hasWriteConflicts: false, artifactRefs: [], usageTokens: 1 }), stop: async () => {},
  };
  const adapter = new WorkExecutionAdapter(works, native, LOCAL_USER_ID, () => true, (_id, error) => errors.push(error));
  await adapter.flush(); await adapter.flush();
  assert.deepEqual(errors, []); assert.deepEqual(submitted, [prompt], "retry does not substitute a new model summary or duplicate submission");

  // Gap-only continuations retain source fidelity without rerunning completed scope.
  works.transaction(() => works.partialResults.record(binding, [{ itemId: "remaining", task: "补充报告说明", required: true, dependencies: [],
    criterionIds: [], nativeStatus: "completed", outcome: "blocked", artifactRefs: [], writeConflicts: [], summary: "说明尚缺" }]));
  unwrap(works.continueWork(user, { operationId: "continue-fidelity", workId: work.workId, sourceBindingId: binding.bindingId,
    gapItemIds: ["remaining"], reason: "补齐说明", versionGuard: guard(works.getWork(work.workId)!) }));
  const queue = new WorkDispatchQueue(db, works, adapter, () => true, () => undefined);
  await queue.drain(); await adapter.flush(); await queue.close(); await adapter.close();
  assert.deepEqual(errors, []);
  assert(submitted[1].includes("补充报告说明"));
  assert(submitted[1].includes(JSON.stringify(input.userRequest)), "continuation carries exact source instead of the model's gap description alone");

  // Later amendments are additive history for their new execution only.
  const amendedRequest = receive("保留原始数据，报告改成英文；不得发送给第三方。", work.workId);
  const read = await invoke(amendedRequest, "work_query_status", { workId: work.workId });
  const amended = unwrap(await invoke(amendedRequest, "work_amend", { workId: work.workId, versionGuard: read[0].versionGuard,
    goalDescription: "英文报告，预计成本99元，截止2030-12-31", constraints: ["模型自行推定预算99元"], criteria: [{ text: "达到99元预算" }] }));
  const amendedBinding = bind(amended), amendedInput = JSON.parse(works.repo.executionInput(amendedBinding));
  assert.deepEqual(amendedInput.userRequest.messages.map((row: { text: string }) => row.text), [original, messages.message(amendedRequest.userMessageId)!.text]);
  assert.equal(amendedInput.userRequest.messages.some((row: { text: string }) => row.text.includes("99元")), false);
  receive("不相关的未来任务，预算1元。");
  assert.equal(works.repo.executionInput(binding), prompt, "future revisions and unrelated conversation messages cannot alter old execution evidence");

  // Long input and explicit references keep original text and roles, not UI clipping.
  const context = receive("这是独立上下文，只能引用不能冒充本次指令。");
  messages.update(context.assistantMessageId, "completed", "助理建议：日期可能为2031-01-01，尚未核验。");
  const longText = `${"完整用户材料。".repeat(1200)}\n最后要求：以原始日期2029-02-03为准，不得对外发送。`;
  const longRequest = receive(longText, undefined, context.assistantMessageId);
  const longWork = unwrap(await invoke(longRequest, "work_create", { requestedOutcome: "one_time", mode: "once", title: "长材料", sourceMessageIds: [], goalDescription: "短摘要" }));
  const longBinding = bind(longWork), longInput = JSON.parse(works.repo.executionInput(longBinding));
  assert.equal(longInput.userRequest.messages[0].text, longText);
  assert.deepEqual(works.getDetailProjection(longWork.workId)!.originalDelegation?.messages.map(row => row.text), [longText], "detail is full text, not clipped or from other Work");
  assert.deepEqual(longInput.userRequest.referencedContext.map((row: { role: string; text: string }) => [row.role, row.text]),
    [["user", "这是独立上下文，只能引用不能冒充本次指令。"], ["assistant", "助理建议：日期可能为2031-01-01，尚未核验。"]]);
  assert(!JSON.stringify(longInput.userRequest.messages).includes("不相关的未来任务"), "unbound dialogue is context, not this Work's authenticated request");

  // A direct user-authored criterion remains a hard gate, including after a frontend amendment.
  let direct = unwrap(works.createWork(user, { operationId: "direct", title: "用户明确验收", goalDescription: "只读核验指定环境",
    constraints: ["禁止发布"], criteria: [{ id: "required", text: "用户明确要求真机验收", requiresRealEnvironmentCheck: true }], inputSnapshotId: "direct-source" }));
  assert.equal(works.closeWork(user, { operationId: "direct-close", workId: direct.workId, conclusion: "succeeded", versionGuard: guard(direct) }).ok, false);
  const directChange = receive("调整检查说明，增加一份检查，不改变原来的限制。", direct.workId);
  const directRead = await invoke(directChange, "work_query_status", { workId: direct.workId });
  direct = unwrap(await invoke(directChange, "work_amend", { workId: direct.workId, versionGuard: directRead[0].versionGuard,
    goalDescription: "更新检查说明", criteria: [{ text: "建议附一个示例" }] }));
  assert.equal(direct.criteria[0].id, "required"); assert.equal(direct.criteria[0].origin, undefined);
  assert.equal(direct.criteria[1].origin, "assistant_proposal");
  assert.equal(works.closeWork(user, { operationId: "direct-still-required", workId: direct.workId, conclusion: "succeeded", versionGuard: guard(direct) }).ok, false);
  const directInput = JSON.parse(works.repo.executionInput(bind(direct)));
  assert.equal(directInput.criteria[0].id, "required");
  assert.deepEqual(directInput.userRequest.structuredUserRequirements[0].changes.constraints, ["禁止发布"]);
  const adviceRequest = receive("只需计算结果，不设置其他验收门槛。");
  const advice = unwrap(await invoke(adviceRequest, "work_create", { requestedOutcome: "one_time", mode: "once", title: "独立建议检查", sourceMessageIds: [], criteria: [{ text: "模型虚构数值必须为123456" }] }));
  assert.equal(works.closeWork(user, { operationId: "advice-not-gate", workId: advice.workId, conclusion: "succeeded", versionGuard: guard(advice) }).ok, true,
    "pending assistant criteria are not a fabricated mandatory gate; explicit user closing remains supported");

  // Editing only a title cannot launder an inherited model description into a user requirement.
  const titleOnly = unwrap(works.amendWork(user, { operationId: "title-only", workId: work.workId, title: "用户新标题" }));
  const titleInput = JSON.parse(works.repo.executionInput(bind(titleOnly)));
  assert.equal(titleInput.description, undefined); assert.equal(titleInput.constraints, undefined);
  assert.equal(titleInput.title, "用户新标题");
  assert(!JSON.stringify(titleInput.userRequest.structuredUserRequirements).includes("99元"));
  assert.equal(titleInput.delegationPlan.description, amendedInput.delegationPlan.description);

  // A short clarification answer inherits the pending dialogue with roles intact.
  const dataFile = join(root, "clarification-data.csv"); writeFileSync(dataFile, "A,3\nB,2");
  const dataTurn = messages.accept(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID, requestId: `request-${++sequence}`,
    text: "A=3，B=2。帮我做报告，不得发布。", attachments: [{ name: "clarification-data.csv", path: dataFile }] });
  messages.update(dataTurn.assistantMessageId, "completed", "报告用什么格式？");
  const formatTurn = receive("HTML。", undefined, dataTurn.assistantMessageId);
  const clarified = unwrap(await invoke(formatTurn, "work_create", { requestedOutcome: "one_time", mode: "once", title: "澄清后的报告", goalDescription: "HTML报告",
    sourceMessageIds: [dataTurn.userMessageId, dataTurn.assistantMessageId] }));
  const clarifiedBinding = bind(clarified);
  const clarifiedInput = JSON.parse(works.repo.executionInput(clarifiedBinding));
  assert(works.getDetailProjection(clarified.workId)!.originalDelegation?.messages.some(row => row.text.includes("不得发布")), "selected clarification requirements remain authoritative user input");
  const clarifiedAttachments = works.repo.attachmentInput(clarifiedBinding).split("\n")
    .filter(line => line.startsWith("{")).map(line => botAttachmentSchema.parse(JSON.parse(line)));
  assert(clarifiedAttachments.some(file => file.path === dataFile && readFileSync(file.path, "utf8") === "A,3\nB,2"),
    "clarification preserves the earlier uploaded input and readable bytes on every platform");
  assert(clarifiedInput.userRequest.messages.some((entry: { text: string; role: string }) => entry.role === "user" && entry.text.includes("不得发布")));
  assert(clarifiedInput.userRequest.dialogueContext.some((entry: { text: string; role: string }) => entry.role === "assistant" && entry.text === "报告用什么格式？"));
  assert(!JSON.stringify(clarifiedInput.userRequest).includes(longText), "already delegated Work is a dialogue boundary");

  // Explicit negative feedback must make a model-suggested check binding.
  const feedbackRequest = receive("生成报告并检查。");
  const feedbackWork = unwrap(await invoke(feedbackRequest, "work_create", { requestedOutcome: "one_time", mode: "once", title: "报告反馈", criteria: [{ text: "报告正确" }] }));
  const failed = unwrap(works.attestCriteria(user, { operationId: "negative-feedback", workId: feedbackWork.workId,
    inputSnapshotId: feedbackWork.inputSnapshotId, versionGuard: guard(feedbackWork),
    criterionUpdates: [{ criterionId: feedbackWork.criteria[0].id, status: "not_met", evidence: "报告总数错误，请修复" }] }));
  assert.equal(failed.criteria[0].origin, undefined); assert.equal(failed.criteria[0].status, "failed");
  assert.equal(works.closeWork(user, { operationId: "cannot-ignore-feedback", workId: failed.workId, conclusion: "succeeded", versionGuard: guard(failed) }).ok, false);
  const environmentRequest = receive("生成并检查另一份报告。");
  const environmentWork = unwrap(await invoke(environmentRequest, "work_create", { requestedOutcome: "one_time", mode: "once", title: "环境反馈", criteria: [{ text: "真机运行", requiresRealEnvironmentCheck: true }] }));
  const environmentFailed = unwrap(works.recordUserFeedback(user, { operationId: "negative-environment-feedback", workId: environmentWork.workId,
    inputSnapshotId: environmentWork.inputSnapshotId, versionGuard: guard(environmentWork), environment: "fixture", sourceRef: "fixture-version",
    failed: true, criterionIds: [environmentWork.criteria[0].id] }));
  assert.equal(environmentFailed.criteria[0].origin, undefined);
  assert.equal(works.closeWork(user, { operationId: "cannot-ignore-environment-feedback", workId: environmentFailed.workId, conclusion: "succeeded", versionGuard: guard(environmentFailed) }).ok, false);

  // Frozen sources remain available after the original receipts disappear.
  db.connection.prepare("DELETE FROM bot_send_receipts WHERE request_id=? AND user_id=?").run(formatTurn.requestId, LOCAL_USER_ID);
  assert.deepEqual(JSON.parse(works.repo.executionInput(works.repo.listBindings(clarified.workId)[0])).userRequest, clarifiedInput.userRequest);
  db.connection.prepare("DELETE FROM bot_work_user_inputs WHERE work_id=?").run(clarified.workId);
  assert.throws(() => works.repo.executionInput(works.repo.listBindings(clarified.workId)[0]), /缺少可核验的原始用户输入/);

  // Native Task inputs use another identity namespace and do not have Bot-chat receipts.
  const goals = new ConversationGoalService(works, () => {}, { resolveSourceMessageId: () => "trusted-native-input" });
  const nativeGoal = goals.create({ taskId: "native-conversation", title: "原生对话目标", criteria: [{ text: "完成原始任务" }] },
    { actor: goals.modelActor("native-conversation") });
  assert(nativeGoal.ok);
  const nativeWork = works.listWorksByConversation("native-conversation")[0];
  const nativeInput = JSON.parse(works.repo.executionInput(bind(nativeWork)));
  assert.equal(nativeInput.title, "原生对话目标"); assert.equal(nativeInput.userRequest, undefined);

  // Foreign references cannot cross users/Bots, and a corrupt bound identity is not silently promoted to a goal.
  bots.registerBot({ userId: "foreign", botId: "foreign-bot", displayName: "foreign", authorization: DESKTOP_USER_GRANTS });
  const foreign = messages.accept("foreign", { botId: "foreign-bot", requestId: "private", text: "foreign private data" });
  const badReference = receive("处理当前输入", undefined, foreign.userMessageId);
  const workCount = db.connection.prepare("SELECT count(*) count FROM works").get();
  await assert.rejects(() => invoke(badReference, "work_create", { requestedOutcome: "one_time", mode: "once", title: "隔离" }), /来源不属于/);
  assert.deepEqual(db.connection.prepare("SELECT count(*) count FROM works").get(), workCount, "invalid source leaves no orphan Work");
  db.connection.prepare("UPDATE bot_messages SET request_id='corrupt' WHERE message_id=?").run(longRequest.userMessageId);
  assert.equal(JSON.parse(works.repo.executionInput(longBinding)).userRequest.messages[0].text, longText, "frozen original input survives changes to mutable chat rows");
  await assert.rejects(() => invoke(longRequest, "work_create", { requestedOutcome: "one_time", mode: "once", title: "不能使用损坏身份" }), /已结束或不属于当前对话/);
  await verifyBotDelegationSources();
  console.log("PASS delegation fidelity: exact user data, advisory model calculations/criteria, persistent adapter delivery, gap continuation, bounded amendments, long input, role/tenant isolation and direct-user acceptance gates");
} finally { db.close(); rmSync(root, { recursive: true, force: true }); }
