// Selected composer execution is part of the foreground contract, not a separate full-suite gate.
import "./bot-selected-tools-test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi, ToolRegistration } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { z } from "zod";
import { botForegroundRequest } from "../src/main/agent/work/BotForegroundIdentity";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { BotConversationRepository } from "../src/main/agent/work/BotConversationRepository";
import { botForegroundTools, BOT_FOREGROUND_TOOLS } from "../src/main/agent/work/BotForegroundTools";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type ExpectedVersionGuard, type WorkActor, type WorkControlResult, type WorkDto } from "../src/shared/bot-work";

// Reproduced from the real sixth watch request: pi.compaction inserted a
// role=user summary after the original mybuddy.user and before work_create.
const userEntry = (kind: string, data: unknown) => ({kind,data,model:[{role:"user",content:[{type:"text",text:"input"}]}]});
const toolEntry = {kind:"pi.assistant",model:[{role:"assistant",content:[{type:"toolCall",id:"identity-call",name:"work_create",arguments:{}}]}]};
const originalEntry = userEntry("mybuddy.user",{mybuddyInput:{botRequestId:"correct-request"}});
const resolveIdentity = async (pages: unknown[][]) => {
  let stored: string | undefined;
  const api = {memo: async (_key:string,value:unknown) => {
    if (typeof value === "string") stored=value;
    return stored;
  },entries: async (_options:unknown,_limit:number,cursor?:number) => {
    const index=cursor??0; return {items:pages[index],next:index+1<pages.length?index+1:undefined};
  }} as unknown as Parameters<typeof botForegroundRequest>[0];
  return botForegroundRequest(api,"identity-call",BACKGROUND_CONTEXT);
};
assert.equal(await resolveIdentity([[toolEntry,originalEntry]]),"correct-request");
assert.equal(await resolveIdentity([[toolEntry,userEntry("pi.compaction",{})],[originalEntry]]),"correct-request");
assert.equal(await resolveIdentity([[toolEntry,userEntry("pi.compaction",{}),userEntry("pi.user",{mybuddyImported:true}),originalEntry]]),"correct-request");
await assert.rejects(resolveIdentity([[toolEntry,userEntry("mybuddy.user",{}),originalEntry]]),/mybuddyInput/);
await assert.rejects(resolveIdentity([[toolEntry,userEntry("pi.compaction",{}),userEntry("pi.user",{mybuddyImported:true})]]),/原始输入身份/);
await assert.rejects(resolveIdentity([[originalEntry]]),/原始输入身份/);
console.log("PASS foreground identity: original request, compaction and pagination, imported history, malformed input boundary, missing original and missing call");

const root = await mkdtemp(join(tmpdir(), "bot-foreground-contract-"));
const db = new AppDatabase(join(root, "business.db"));
const bots = new BotRegistry(db.connection);
bots.registerBot({ userId: LOCAL_USER_ID, botId: DEFAULT_BOT_ID, displayName: "contract fixture", authorization: DESKTOP_USER_GRANTS });
const works = new WorkService(db.connection, { bots });
const messages = new BotConversationRepository(db.connection);
const scheduled: { workId: string; retryBlocked: boolean | undefined }[] = [];
const memoryQueries: string[] = [];
const forgetInputs: unknown[] = [];
const rememberInputs: unknown[] = [];
const first = messages.accept(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID, requestId: "contract-first", text: "创建并管理这项委托" });
const tools: ToolRegistration[] = botForegroundTools({ db: db.connection, userId: LOCAL_USER_ID, botId: DEFAULT_BOT_ID,
  conversationId: first.conversationId, bots, messages, works, isAuthority: () => true,
  schedule: (work, _operation, retryBlocked) => scheduled.push({ workId: work.workId, retryBlocked }), wake: () => {},
  memoryRemember: (input, userText) => { rememberInputs.push({ input, userText }); return { saved: true }; },
  memorySearch: query => { memoryQueries.push(query); return []; },
  memoryForget: (ids, userText, evidence) => { forgetInputs.push({ ids, userText, evidence }); return { forgottenCount: ids.length }; } });
const findTool = (name: string) => { const tool = tools.find(item => item.name === name); assert(tool, name); return tool; };
// Check the JSON actually sent to Function Calling, not TypeBox metadata or the Zod object.
const schemas = new Map(tools.map(tool => [tool.name, Type.Unsafe(JSON.parse(JSON.stringify(tool.parameters)))]));
const accepts = (name: string, args: unknown) => Value.Check(schemas.get(name)!, args);
let nextTask = 0;
const invoke = async (name: string, args: unknown, requestId = first.requestId, replayTaskId?: string): Promise<unknown> => {
  // Only the native invocation identity is a fixture. Tool parsing, receipts, reads,
  // Work guards, mutations and transaction effects all use the real implementations.
  const api = { callId: `call-${++nextTask}`, taskId: replayTaskId ?? `tool-${nextTask}`, memo: async () => requestId } as unknown as ToolExecutionApi;
  const result = await findTool(name).execute(args as never, api, BACKGROUND_CONTEXT);
  const output = result.output?.find(block => block.type === "text");
  assert(output?.type === "text");
  return JSON.parse(output.text);
};
const validInvoke = async (name: string, args: unknown, requestId = first.requestId) => {
  assert(accepts(name, args), `${name} must accept valid wire arguments`);
  return invoke(name, args, requestId);
};
const unwrap = (value: unknown) => { const result = value as WorkControlResult; assert(result.ok, JSON.stringify(result)); return result.work; };
const guardOf = (work: WorkDto): ExpectedVersionGuard => ({ expectedStateVersion: work.stateVersion,
  expectedIntentRevision: work.intentRevision, expectedOwnerEpoch: work.ownerEpoch });
const queryGuard = async (workId: string, requestId = first.requestId) => {
  const result = z.array(z.object({ workId: z.string(), versionGuard: z.object({ expectedStateVersion: z.number(),
    expectedIntentRevision: z.number(), expectedOwnerEpoch: z.number() }) })).parse(await validInvoke("work_query_status", { workId }, requestId));
  assert.equal(result.length, 1); assert.equal(result[0].workId, workId); return result[0].versionGuard;
};
const readCount = (requestId: string) => z.object({ count: z.number() }).parse(db.connection
  .prepare("SELECT COUNT(*) count FROM bot_work_reads WHERE conversation_id=? AND request_id=?")
  .get(first.conversationId, requestId)).count;
const user: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants: DESKTOP_USER_GRANTS };
try {
  assert.deepEqual(new Set(tools.map(tool => tool.name)), BOT_FOREGROUND_TOOLS);
  assert(accepts("work_query_status", {}), "query without an id lists this Bot's known Work");
  const createArgs = { requestedOutcome: "one_time", mode: "once", title: "  Schema contract  ", goalDescription: "  Preserve acceptance evidence  ",
    constraints: ["  stay inside the delegated workspace  "],
    criteria: [{ text: "  verified result  ", requiresRealEnvironmentCheck: true, requiredEnvironment: "  Linux fixture  " }] };
  let work = unwrap(await validInvoke("work_create", createArgs));
  assert.equal(work.title, "Schema contract");
  assert.equal(work.goalDescription, "Preserve acceptance evidence");
  assert.deepEqual(work.constraints, ["stay inside the delegated workspace"]);
  assert.equal(work.criteria[0].text, "verified result");
  assert.equal(work.criteria[0].requiresRealEnvironmentCheck, true);
  assert.equal(work.criteria[0].requiredEnvironment, "Linux fixture");
  assert.equal(scheduled.length, 1);
  assert.deepEqual(messages.message(first.userMessageId)?.workIds, [work.workId]);

  // Required fields and all bounds are enforced both before execution and by the
  // runtime parser. Extra actor/authorization/acceptance fields cannot cross either.
  const guard = guardOf(work);
  const controls = ["work_amend", "work_pause", "work_resume", "work_cancel"];
  const invalid: [string, unknown][] = [
    ["work_create", {}], ["work_create", { ...createArgs, title: "" }],
    ["work_create", { ...createArgs, title: " \n\t " }],
    ["work_create", { ...createArgs, title: ` ${"x".repeat(32000)}` }],
    ["work_create", { ...createArgs, constraints: Array(31).fill("constraint") }],
    ["work_create", { ...createArgs, constraints: [" \t "] }],
    ["work_create", { ...createArgs, criteria: Array(13).fill({ text: "criterion" }) }],
    ["work_create", { ...createArgs, criteria: [{ requiresRealEnvironmentCheck: true }] }],
    ["work_create", { ...createArgs, criteria: [{ text: "criterion", requiredEnvironment: " " }] }],
    ["work_create", { ...createArgs, criteria: [{ text: "criterion", status: "accepted" }] }],
    ["work_create", { ...createArgs, actor: { kind: "system" } }],
    ["work_create", { ...createArgs, authorization: DESKTOP_USER_GRANTS }],
    ["work_query_status", { workId: " \n " }], ["work_query_status", { workId: work.workId, actor: "system" }],
    ["memory_forget", { ids: [], userEvidence: "忘记" }], ["memory_forget", { ids: ["x"], userEvidence: " " }],
    ["memory_forget", { ids: ["x"], userEvidence: "忘记", botId: "foreign" }],
    ["memory_remember", { scope: "bot", kind: "fact", title: "x", content: "x", userEvidence: "x" }],
    ["memory_remember", { scope: "current", kind: "fact", title: "x", content: "x", userEvidence: "x", botId: "foreign" }],
    ["memory_search", {}], ["memory_search", { query: " \t " }], ["memory_search", { query: "q".repeat(32001) }],
    ["memory_search", { query: "valid", botId: "another-bot" }],
    ["work_amend", { workId: work.workId, versionGuard: guard, constraints: Array(31).fill("constraint") }],
    ["work_amend", { workId: work.workId, versionGuard: guard, criteria: [{ text: "criterion", accepted: true }] }],
  ];
  for (const name of controls) {
    invalid.push([name, { workId: work.workId }], [name, { workId: " ", versionGuard: guard }],
      [name, { workId: work.workId, versionGuard: { expectedStateVersion: 1, expectedIntentRevision: 1 } }],
      [name, { workId: work.workId, versionGuard: { ...guard, actor: "system" } }]);
    for (const field of Object.keys(guard)) for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      invalid.push([name, { workId: work.workId, versionGuard: { ...guard, [field]: value } }]);
    }
  }
  for (const [name, args] of invalid) {
    assert.equal(accepts(name, args), false, `${name} model schema must reject ${JSON.stringify(args).slice(0, 180)}`);
    await assert.rejects(() => invoke(name, args), z.ZodError, `${name} execution must reject the same input`);
  }
  assert.equal(works.listWorks(LOCAL_USER_ID, { includeClosed: true }).length, 1);
  assert.equal(scheduled.length, 1, "invalid arguments cannot schedule work");
  assert(accepts("work_create", { requestedOutcome: "one_time", mode: "once", title: "x".repeat(32000), constraints: Array(30).fill("constraint"),
    criteria: Array(12).fill({ text: "criterion", requiresRealEnvironmentCheck: false }) }), "documented limits are inclusive");
  await validInvoke("memory_search", { query: "  remembered constraint  " });
  assert.deepEqual(memoryQueries, ["remembered constraint"]);
  const rememberRequest = messages.accept(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID, requestId: "remember-request", text: "仅本次对话记住蓝莓" });
  const rememberInput = { scope: "conversation", kind: "preference", title: "口味", content: "蓝莓", userEvidence: "记住蓝莓" };
  await validInvoke("memory_remember", rememberInput, rememberRequest.requestId);
  assert.deepEqual(rememberInputs, [{ input: rememberInput, userText: "仅本次对话记住蓝莓" }]);
  messages.update(rememberRequest.assistantMessageId, "completed", "done");
  await assert.rejects(() => validInvoke("memory_remember", rememberInput, rememberRequest.requestId), /原始用户消息已结束/);
  const forgetRequest = messages.accept(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID, requestId: "forget-request", text: "忘记测试代号" });
  await validInvoke("memory_forget", { ids: ["memory-fixture"], userEvidence: "忘记测试代号" }, forgetRequest.requestId);
  assert.deepEqual(forgetInputs, [{ ids: ["memory-fixture"], userText: "忘记测试代号", evidence: "忘记测试代号" }]);
  messages.update(forgetRequest.assistantMessageId, "completed", "done");
  await assert.rejects(() => validInvoke("memory_forget", { ids: ["memory-fixture"], userEvidence: "忘记测试代号" }, forgetRequest.requestId), /原始用户消息已结束/);


  // A correct-looking version alone cannot replace a read made by this request.
  await assert.rejects(() => validInvoke("work_pause", { workId: work.workId, versionGuard: guard }), /必须先查询/);
  assert.equal(works.getWork(work.workId)?.lifecycle, "active");
  const read = await queryGuard(work.workId);
  assert.deepEqual(read, guard);
  assert.equal(readCount(first.requestId), 1);
  await assert.rejects(() => validInvoke("work_pause", { workId: work.workId,
    versionGuard: { ...read, expectedStateVersion: read.expectedStateVersion + 1 } }), /必须先查询/);
  const otherRequest = messages.accept(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID, requestId: "contract-other-request",
    conversationId: first.conversationId, selectedWorkId: work.workId, text: "暂停选中的事项" });
  await assert.rejects(() => validInvoke("work_pause", { workId: work.workId, versionGuard: read }, otherRequest.requestId), /必须先查询/);

  work = unwrap(await validInvoke("work_pause", { workId: work.workId, versionGuard: read, reason: "  user pause  " }));
  assert.equal(work.lifecycle, "paused");
  const stale = await validInvoke("work_resume", { workId: work.workId, versionGuard: read }) as WorkControlResult;
  assert(!stale.ok); assert.equal(stale.code, "version_conflict", "the backend still rejects a previously read stale snapshot");
  assert.equal(works.getWork(work.workId)?.lifecycle, "paused");
  work = unwrap(await validInvoke("work_resume", { workId: work.workId, versionGuard: await queryGuard(work.workId) }));
  assert.equal(work.lifecycle, "active"); assert.equal(scheduled.at(-1)?.retryBlocked, true);
  work = unwrap(await validInvoke("work_amend", { workId: work.workId, versionGuard: await queryGuard(work.workId),
    title: "  Revised contract  ", goalDescription: "  New goal  ", constraints: ["  new boundary  "],
    criteria: [{ text: "  revised evidence  ", requiresRealEnvironmentCheck: true, requiredEnvironment: "  revised fixture  " }] }));
  assert.equal(work.title, "Revised contract"); assert.equal(work.goalDescription, "New goal");
  assert.deepEqual(work.constraints, ["new boundary"]);
  assert.equal(work.criteria[0].text, "revised evidence"); assert.equal(work.criteria[0].requiredEnvironment, "revised fixture");
  assert.equal(scheduled.length, 3, "only create/amend/resume schedule business work");

  const second = unwrap(works.createWork(user, { operationId: "contract-second-work", title: "Second responsibility" }));
  const selectedSecond = messages.accept(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID, requestId: "contract-second-selection",
    conversationId: first.conversationId, selectedWorkId: second.workId, text: "暂停选中的第二项" });
  await queryGuard(work.workId, selectedSecond.requestId);
  await assert.rejects(() => validInvoke("work_pause", { workId: second.workId, versionGuard: guardOf(second) }, selectedSecond.requestId), /必须先查询/);
  const ambiguous = messages.accept(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID, requestId: "contract-ambiguous",
    conversationId: first.conversationId, text: "暂停" });
  await queryGuard(second.workId, ambiguous.requestId);
  await assert.rejects(() => validInvoke("work_pause", { workId: second.workId, versionGuard: guardOf(second) }, ambiguous.requestId), /请明确/);

  // A late tool can pass a beforeTool hook just before a request ends. The receipt
  // is checked again inside the mutation/read transaction, so GC is not reversible.
  for (const status of ["completed", "failed", "cancelled"] as const) {
    const terminal = messages.accept(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID, requestId: `contract-${status}`,
      conversationId: first.conversationId, selectedWorkId: second.workId, text: "暂停选中的事项" });
    const terminalGuard = await queryGuard(second.workId, terminal.requestId);
    messages.update(terminal.assistantMessageId, status, status);
    // Model a collected row explicitly; lifecycle rejection must hold independently
    // of whether the collector ran in this update or during host startup.
    db.connection.prepare("DELETE FROM bot_work_reads WHERE conversation_id=? AND request_id=?").run(first.conversationId, terminal.requestId);
    await assert.rejects(() => validInvoke("work_query_status", { workId: second.workId }, terminal.requestId), /已结束/);
    await assert.rejects(() => validInvoke("work_pause", { workId: second.workId, versionGuard: terminalGuard }, terminal.requestId), /已结束/);
    assert.equal(readCount(terminal.requestId), 0, "a terminal request cannot recreate a collected guard");
  }
  assert.equal(works.getWork(second.workId)?.lifecycle, "active");
  messages.update(selectedSecond.assistantMessageId, "unknown", "recoverable input");
  unwrap(await validInvoke("work_pause", { workId: second.workId,
    versionGuard: await queryGuard(second.workId, selectedSecond.requestId) }, selectedSecond.requestId));
  assert.equal(works.getWork(second.workId)?.lifecycle, "paused", "unknown inputs remain recoverable");

  const cancelled = unwrap(await validInvoke("work_cancel", { workId: work.workId,
    versionGuard: await queryGuard(work.workId), reason: "  finished by user  " }));
  assert.equal(cancelled.closureConclusion, "cancelled");
  assert.equal(scheduled.length, 3);

  // Explicit IDs come from the persisted user message and override stale cards
  // and reply context. Each mutation still goes through the real read/guard path.
  const targetA = unwrap(works.createWork(user, { operationId: "target-a", title: "Target A" }));
  const targetB = unwrap(works.createWork(user, { operationId: "target-b", title: "Target B" }));
  let targetRequest = 0;
  const requestFor = (text: string, selectedWorkId?: string, referenceMessageId?: string) => messages.accept(LOCAL_USER_ID, {
    botId: DEFAULT_BOT_ID, conversationId: first.conversationId, requestId: `target-request-${++targetRequest}`,
    text, selectedWorkId, referenceMessageId });
  const assertRejectedTarget = async (requestId: string, target: WorkDto) => {
    const before = works.getWork(target.workId);
    await assert.rejects(() => validInvoke("work_pause", { workId: target.workId,
      versionGuard: guardOf(target) }, requestId), /请明确/);
    assert.deepEqual(works.getWork(target.workId), before);
  };
  const restore = (workId: string) => unwrap(works.resumeWork(user, { workId,
    operationId: `restore-${++targetRequest}`, versionGuard: guardOf(works.getWork(workId)!) }));
  const reference = requestFor("卡片上下文");
  messages.linkWork(messages.receipt(LOCAL_USER_ID, DEFAULT_BOT_ID, reference.requestId)!, targetA.workId);
  const explicit = requestFor(`请暂停（${targetB.workId}），确认是 ${targetB.workId}。`, targetA.workId, reference.assistantMessageId);
  await assertRejectedTarget(explicit.requestId, targetA);
  await assert.rejects(() => validInvoke("work_pause", { workId: targetB.workId,
    versionGuard: guardOf(targetB) }, explicit.requestId), /必须先查询/);
  const explicitGuard = await queryGuard(targetB.workId, explicit.requestId);
  const explicitArgs = { workId: targetB.workId, versionGuard: explicitGuard };
  assert.equal(unwrap(await invoke("work_pause", explicitArgs, explicit.requestId, "explicit-replay")).lifecycle, "paused");
  const replayed = await invoke("work_pause", explicitArgs, explicit.requestId, "explicit-replay") as WorkControlResult;
  assert(replayed.ok && replayed.replayed, "explicit controls remain replay-safe after linkWork changes the message");
  await assertRejectedTarget(explicit.requestId, targetA);
  restore(targetB.workId);

  const noIds = requestFor("暂停选中的事项", targetA.workId);
  assert.equal(unwrap(await validInvoke("work_pause", { workId: targetA.workId,
    versionGuard: await queryGuard(targetA.workId, noIds.requestId) }, noIds.requestId)).lifecycle, "paused");
  restore(targetA.workId);
  const replyOnly = requestFor("暂停这项", targetB.workId, reference.assistantMessageId);
  await assertRejectedTarget(replyOnly.requestId, targetB);
  assert.equal(unwrap(await validInvoke("work_pause", { workId: targetA.workId,
    versionGuard: await queryGuard(targetA.workId, replyOnly.requestId) }, replyOnly.requestId)).lifecycle, "paused");
  restore(targetA.workId);
  const noTarget = requestFor("暂停");
  await assertRejectedTarget(noTarget.requestId, targetA);
  const multiple = requestFor(`${targetA.workId} 和 ${targetB.workId} 怎么样？`, targetA.workId, reference.assistantMessageId);
  // Even a same-request link must not turn ambiguous text into permission.
  messages.linkWork(messages.receipt(LOCAL_USER_ID, DEFAULT_BOT_ID, multiple.requestId)!, targetA.workId);
  await assertRejectedTarget(multiple.requestId, targetA);
  await assertRejectedTarget(multiple.requestId, targetB);
  messages.linkWork(messages.receipt(LOCAL_USER_ID, DEFAULT_BOT_ID, reference.requestId)!, targetB.workId);
  const multipleReference = requestFor("暂停这些", targetA.workId, reference.assistantMessageId);
  await assertRejectedTarget(multipleReference.requestId, targetA);
  await assertRejectedTarget(multipleReference.requestId, targetB);

  bots.registerBot({ userId: LOCAL_USER_ID, botId: "foreign-target-bot", displayName: "Other Bot", authorization: DESKTOP_USER_GRANTS });
  const foreignBotWork = unwrap(works.createWork(user, { operationId: "foreign-bot-target", title: "Other Bot Work", ownerBotId: "foreign-target-bot" }));
  bots.registerBot({ userId: "foreign-target-user", botId: "foreign-user-bot", displayName: "Other User", authorization: DESKTOP_USER_GRANTS });
  const foreignUserWork = unwrap(works.createWork({ ...user, userId: "foreign-target-user" }, {
    operationId: "foreign-user-target", title: "Other User Work", ownerBotId: "foreign-user-bot" }));
  const beforeUnavailable = works.getWork(targetB.workId);
  for (const unavailable of [foreignBotWork.workId, foreignUserWork.workId, "work-00000000-0000-4000-8000-000000000000",
    `${targetB.workId}_typo`, `${targetB.workId}--typo`, `${targetB.workId}-`]) {
    const request = requestFor(`暂停 ${unavailable}`, targetA.workId);
    await assertRejectedTarget(request.requestId, targetA);
    assert.deepEqual(await validInvoke("work_query_status", { workId: unavailable }, request.requestId), []);
    await assert.rejects(() => validInvoke("work_pause", { workId: unavailable,
      versionGuard: guardOf(targetA) }, request.requestId), /不属于当前用户与 Bot/);
    const mixed = requestFor(`${targetA.workId} 还是 ${unavailable}？`, targetA.workId);
    await assertRejectedTarget(mixed.requestId, targetA);
    assert.deepEqual(works.getWork(targetB.workId), beforeUnavailable, "a malformed ID must not authorize its valid prefix");
  }
  assert.equal(works.getWork(foreignBotWork.workId)?.lifecycle, "active");
  assert.equal(works.getWork(foreignUserWork.workId)?.lifecycle, "active");
  const closedRequest = requestFor(`暂停 ${cancelled.workId}`, targetA.workId);
  await assertRejectedTarget(closedRequest.requestId, targetA);
  const closedResult = await validInvoke("work_pause", { workId: cancelled.workId,
    versionGuard: await queryGuard(cancelled.workId, closedRequest.requestId) }, closedRequest.requestId) as WorkControlResult;
  assert(!closedResult.ok, "explicit target selection does not bypass closed lifecycle rejection");
  assert.equal(works.getWork(cancelled.workId)?.lifecycle, "closed");

  // A newly created Work is linked during this request and remains controllable
  // despite stale selection; repeat execution keeps the same operation identity.
  const createRequest = requestFor("创建一个新事项，然后暂停它", targetA.workId);
  const created = unwrap(await validInvoke("work_create", { requestedOutcome: "one_time", mode: "once", title: "Created in request" }, createRequest.requestId));
  const createdArgs = { workId: created.workId, versionGuard: await queryGuard(created.workId, createRequest.requestId) };
  assert.equal(unwrap(await invoke("work_pause", createdArgs, createRequest.requestId, "created-replay")).lifecycle, "paused");
  const createdReplay = await invoke("work_pause", createdArgs, createRequest.requestId, "created-replay") as WorkControlResult;
  assert(createdReplay.ok && createdReplay.replayed);
  const explicitWithLink = requestFor(`暂停 ${targetB.workId}`, targetA.workId);
  messages.linkWork(messages.receipt(LOCAL_USER_ID, DEFAULT_BOT_ID, explicitWithLink.requestId)!, targetA.workId);
  await assertRejectedTarget(explicitWithLink.requestId, targetA);
  assert.equal(unwrap(await validInvoke("work_pause", { workId: targetB.workId,
    versionGuard: await queryGuard(targetB.workId, explicitWithLink.requestId) }, explicitWithLink.requestId)).lifecycle, "paused");

  messages.archive(LOCAL_USER_ID, DEFAULT_BOT_ID, first.conversationId);
  const newConversation = messages.accept(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID, requestId: "contract-new-conversation", text: "新对话查询" });
  assert.notEqual(newConversation.conversationId, first.conversationId);
  await assert.rejects(() => validInvoke("work_query_status", {}, newConversation.requestId), /不属于当前对话/);
  console.log(`PASS foreground Function Calling/runtime contract (${invalid.length} invalid inputs), create/amend/control execution, exact request/work/conversation reads, stale guards and terminal-request rejection`);
  console.log("PASS foreground target resolution: unique/repeated explicit ID, stale selection/reference, no/multiple IDs, reference ambiguity, unknown/foreign/closed targets, same-request links and replay");
} finally { db.close(); await rm(root, { recursive: true, force: true }); }
