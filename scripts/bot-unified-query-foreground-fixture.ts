import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { BotConversationRepository } from "../src/main/agent/work/BotConversationRepository";
import { BotConversationService } from "../src/main/agent/work/BotConversationService";
import { BotCollaborationService, botCollaborationToolSchema } from "../src/main/agent/work/BotCollaborationService";
import { botForegroundTools } from "../src/main/agent/work/BotForegroundTools";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { CronService, type CronAgent } from "../src/main/cron/CronService";
import { LOCAL_USER_ID } from "../src/shared/bot-work";
import { botMessageSchema } from "../src/shared/bot-conversation";

export async function verifyUnifiedForegroundQueries(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "bot-unified-query-"));
  const app = new AppDatabase(join(root, "app.db")), db = app.connection;
  const bots = new BotRegistry(db);
  for (const botId of ["query-a", "query-b", "query-c"]) bots.registerBot({ botId, userId: LOCAL_USER_ID,
    displayName: botId, authorization: DESKTOP_USER_GRANTS });
  const works = new WorkService(db, { bots }), messages = new BotConversationRepository(db);
  const models = await ModelRuntime.create({ authPath: join(root, "auth.json"), modelsPath: null,
    modelsStorePath: join(root, "models.json"), allowModelNetwork: false, refreshOnCreate: false });
  const cron = new CronService(app, { prompt: async () => { throw Error("read query must not execute"); },
    waitForSubmission: async () => { throw Error("read query must not submit"); }, loadTaskHistory: async () => ({ messages: [] }),
    isTaskBusy: () => false, getAppSettings: () => ({}), resolveAvailableModelId: async () => undefined,
    listSkills: () => [], listConnectors: () => [] } satisfies CronAgent);
  const schedules: string[] = [];
  const options = { db, userId: LOCAL_USER_ID, bots, works, models, directory: join(root, "native"), defaultModel: () => undefined,
    isAuthority: () => true, memorySearch: () => [], schedule: (work: { workId: string }) => schedules.push(work.workId), wake: () => {} };
  const collaborations = new BotCollaborationService(options, messages, () => {});
  const conversationService = new BotConversationService(options);
  const source = messages.accept(LOCAL_USER_ID, { botId: "query-a", requestId: "query-original", text: "安排我负责和已委派的事项" });
  let sequence = 0;
  const invoke = async (name: string, args: unknown, turn = source, teamId?: string) => {
    const tools = botForegroundTools({ ...options, botId: turn.botId, conversationId: turn.conversationId,
      teamId, messages, reminders: () => cron });
    const tool = tools.find(item => item.name === name)!;
    assert(Value.Check(Type.Unsafe(JSON.parse(JSON.stringify(tool.parameters))), args), `${name} wire schema`);
    const api = { callId: `call-${++sequence}`, taskId: `tool-${sequence}`, memo: async () => turn.requestId } as unknown as ToolExecutionApi;
    const result = await tool.execute(args as never, api, BACKGROUND_CONTEXT);
    const text = result.output?.find(item => item.type === "text"); assert(text?.type === "text");
    return JSON.parse(text.text) as unknown;
  };
  const createWork = (operationId: string, title: string, ownerBotId: string, privatePlan = false) => {
    const result = works.createWork({ kind: "user", userId: LOCAL_USER_ID, grants: DESKTOP_USER_GRANTS },
      { operationId, title, ownerBotId, conversationId: source.conversationId, sourceMessageId: source.userMessageId,
        ...(privatePlan ? { goalDescription: "PRIVATE_B_INTERNAL_PLAN", constraints: ["PRIVATE_B_CONSTRAINT"] } : {}) });
    assert(result.ok); return result.work;
  };
  const relation = (operationId: string, text: string, workId?: string) => {
    const row = collaborations.repo.ensure({ userId: LOCAL_USER_ID, sourceBotId: source.botId, sourceDisplayName: "A",
      sourceConversationId: source.conversationId, sourceRequestId: source.requestId, sourceUserMessageId: source.userMessageId,
      sourceAssistantMessageId: source.assistantMessageId, targetBotId: "query-b", targetDisplayName: "B", operationId });
    if (workId) collaborations.repo.linkWork(LOCAL_USER_ID, row.collaborationId, workId);
    collaborations.repo.appendMessage(LOCAL_USER_ID, row.collaborationId, { operationId: `${operationId}:request`,
      senderBotId: "query-a", senderDisplayName: "A", kind: "request", text });
    collaborations.repo.appendMessage(LOCAL_USER_ID, row.collaborationId, { operationId: `${operationId}:result`,
      senderBotId: "query-b", senderDisplayName: "B", kind: "result", text: `PUBLIC_RESULT:${text}` });
    return row;
  };
  const workRows = z.array(z.object({ workId: z.string(), readOnly: z.boolean().optional(), delegation: z.object({ collaborationId: z.string() }).optional() }).passthrough());
  const pageSchema = z.object({ items: z.array(z.object({ id: z.string(), kind: z.enum(["work", "reminder", "collaboration"]) }).passthrough()),
    total: z.number(), hasMore: z.boolean(), nextQuery: z.record(z.string(), z.unknown()).nullable() });
  try {
    const owned = createWork("own", "自己处理的安排", "query-a");
    const delegated = createWork("delegated", "委派后的交付", "query-b", true);
    const privateWork = createWork("private", "另一个Bot的私人事项", "query-b", true);
    const delegatedRelation = relation("delegated-relation", "已委派的交付要求", delegated.workId);
    const noWorkRelation = relation("answer-only-relation", "尚未建Work的咨询");
    const now = Date.now();
    cron.upsert({ id: "unified-reminder", name: "查看统一安排提醒", prompt: "查看结果", scheduleType: "every", scheduleExpr: "1h",
      timezone: "Asia/Shanghai", enabled: true, createdAt: now, updatedAt: now, restartPolicy: "resume",
      reminder: { state: "scheduled", kind: "bot-reminder", userId: LOCAL_USER_ID, botId: "query-a", conversationId: source.conversationId } });
    const before = z.object({ n: z.number() }).parse(db.prepare("SELECT total_changes() n").get()).n;
    const firstPage = pageSchema.parse(await invoke("schedule_overview", { limit: 2 }));
    assert.equal(z.object({ n: z.number() }).parse(db.prepare("SELECT total_changes() n").get()).n, before, "overview performs no writes");
    const items = [...firstPage.items]; let page = firstPage;
    while (page.nextQuery) { page = pageSchema.parse(await invoke("schedule_overview", page.nextQuery)); items.push(...page.items); }
    assert.equal(items.length, firstPage.total); assert.equal(new Set(items.map(item => item.id)).size, items.length);
    assert.deepEqual(new Set(items.map(item => item.kind)), new Set(["work", "reminder", "collaboration"]));
    assert(items.some(item => item.workId === owned.workId)); assert(items.some(item => item.workId === delegated.workId));
    assert(!items.some(item => item.workId === privateWork.workId));
    assert(!JSON.stringify(items).includes("PRIVATE_B_")); assert.equal(schedules.length, 0);
    const filtered = pageSchema.parse(await invoke("schedule_overview", { search: "尚未建Work", limit: 1 }));
    assert.equal(filtered.total, 1); assert.equal(filtered.items[0]?.kind, "collaboration");
    assert(firstPage.nextQuery);
    await assert.rejects(invoke("schedule_overview", { ...firstPage.nextQuery, search: "different" }), /游标|筛选|cursor/);

    assert.deepEqual(messages.message(source.assistantMessageId)?.workIds, [delegated.workId],
      "the original delegation projects only its own Work, not every visible responsibility");
    const listTurn = messages.accept(LOCAL_USER_ID, { botId: source.botId, conversationId: source.conversationId,
      requestId: "responsibilities-list", text: "List all responsibilities" });
    const legacy = workRows.parse(await invoke("work_query_status", {}, listTurn));
    assert(legacy.some(item => item.workId === delegated.workId && item.delegation?.collaborationId === delegatedRelation.collaborationId));
    assert.deepEqual(messages.message(listTurn.assistantMessageId)?.workIds, [], "listing responsibilities does not assign the answer to every visible task");
    const queryTurn = (requestId: string, selectedWorkId?: string) => messages.accept(LOCAL_USER_ID, {
      botId: source.botId, conversationId: source.conversationId, requestId, text: "查看事项进度", selectedWorkId });
    const linked = (turn: ReturnType<typeof queryTurn>) => messages.message(turn.assistantMessageId)?.workIds;
    const ownedQuery = queryTurn("owned-task-progress", delegated.workId);
    const unchangedWork = works.getWork(owned.workId);
    await invoke("work_query_status", { workId: owned.workId }, ownedQuery);
    assert.deepEqual(linked(ownedQuery), [owned.workId], "an exact readable task query links its reply to that task, not the stale UI selection");
    assert.deepEqual(messages.message(ownedQuery.userMessageId)?.workIds, [], "a read association cannot become a user delegation or a mutation target");
    await invoke("work_query_status", { workId: owned.workId }, ownedQuery);
    assert.deepEqual(linked(ownedQuery), [owned.workId], "repeated detail reads do not duplicate the task association");
    const restored = new BotConversationRepository(db).history(LOCAL_USER_ID, { botId: source.botId, conversationId: source.conversationId });
    assert.deepEqual(restored.messages.find(message => message.messageId === ownedQuery.assistantMessageId)?.workIds, [owned.workId],
      "task association survives a fresh repository/history read");

    const summaryQuery = queryTurn("owned-task-summary");
    await invoke("work_query_status", { workId: owned.workId, view: "summary" }, summaryQuery);
    assert.deepEqual(linked(summaryQuery), [owned.workId], "exact summary reads carry the same task ownership as details");
    const listQuery = queryTurn("task-list-is-not-a-continuation", owned.workId);
    await invoke("work_query_status", { view: "summary", search: owned.title }, listQuery);
    assert.deepEqual(linked(listQuery), [], "even a one-result list cannot inherit a stale selected task");
    const noMatch = queryTurn("filtered-task-is-absent", owned.workId);
    await invoke("work_query_status", { workId: owned.workId, view: "summary", search: "no-such-title" }, noMatch);
    assert.deepEqual(linked(noMatch), [], "a filtered-out exact task does not capture the reply");
    const rejectedQuery = queryTurn("task-query-rejected", owned.workId);
    await assert.rejects(invoke("work_query_status", { workId: owned.workId, search: "invalid-detail-filter" }, rejectedQuery), /不要携带/);
    assert.deepEqual(linked(rejectedQuery), [], "rejected queries leave no partial association");
    const unreadable = queryTurn("private-or-missing-task", owned.workId);
    for (const workId of [privateWork.workId, "work-missing"]) {
      assert.deepEqual(await invoke("work_query_status", { workId }, unreadable), []);
      await invoke("work_query_status", { workId, view: "summary" }, unreadable);
      assert.deepEqual(linked(unreadable), [], "unreadable and missing tasks cannot capture the reply or fall back to a selected task");
    }
    const comparison = queryTurn("two-explicit-task-queries", privateWork.workId);
    await invoke("work_query_status", { workId: owned.workId }, comparison);
    await invoke("work_query_status", { workId: delegated.workId, view: "summary" }, comparison);
    assert.deepEqual(linked(comparison), [owned.workId, delegated.workId], "multiple explicit reads preserve all actual targets rather than selecting one implicitly");
    assert.deepEqual(works.getWork(owned.workId), unchangedWork, "query affiliation does not amend the Work, its source, or its scheduling state");
    assert.equal(schedules.length, 0, "query affiliation never starts background execution");
    const unbound = works.createWork({ kind: "user", userId: LOCAL_USER_ID, grants: DESKTOP_USER_GRANTS },
      { operationId: "without-conversation-origin", title: "未从对话委派的事项", ownerBotId: source.botId });
    assert(unbound.ok);
    assert.equal(messages.workOrigin(LOCAL_USER_ID, unbound.work.workId), undefined);
    const unboundQuery = queryTurn("query-cannot-become-work-origin");
    await invoke("work_query_status", { workId: unbound.work.workId }, unboundQuery);
    assert.deepEqual(linked(unboundQuery), [unbound.work.workId]);
    assert.equal(messages.workOrigin(LOCAL_USER_ID, unbound.work.workId), undefined, "a status reply cannot invent the original delivery conversation");
    const detail = workRows.parse(await invoke("work_query_status", { workId: delegated.workId }));
    assert.equal(detail[0]?.readOnly, true); assert(JSON.stringify(detail).includes("PUBLIC_RESULT:"));
    assert.deepEqual(messages.message(source.assistantMessageId)?.workIds, [delegated.workId], "an exact delegated query links public task evidence without granting control");
    assert(JSON.stringify(detail).includes("bot_collaborate")); assert(!JSON.stringify(detail).includes("PRIVATE_B_"));
    assert.deepEqual(await invoke("work_query_status", { workId: privateWork.workId }), []);
    assert.equal(db.prepare("SELECT 1 FROM bot_work_reads WHERE work_id=?").get(delegated.workId), undefined);
    await assert.rejects(invoke("work_pause", { workId: delegated.workId, versionGuard: {
      expectedStateVersion: delegated.stateVersion, expectedIntentRevision: delegated.intentRevision, expectedOwnerEpoch: delegated.ownerEpoch } }), /bot_collaborate/);
    assert.equal(works.getWork(delegated.workId)?.lifecycle, "active");

    assert(Value.Check(Type.Unsafe(z.toJSONSchema(botCollaborationToolSchema, { target: "draft-7", io: "input" })), { action: "query", limit: 1 }));
    const list = z.object({ total: z.number(), nextCursor: z.string(), nextQuery: z.record(z.string(), z.unknown()) })
      .parse(await collaborations.command(source.assistantMessageId, "list", { action: "query", limit: 1 }));
    assert.equal(list.total, 2);
    await collaborations.command(source.assistantMessageId, "next-list", list.nextQuery);
    const history = z.object({ nextCursor: z.string(), nextQuery: z.record(z.string(), z.unknown()),
      versionGuard: z.object({ expectedStateVersion: z.number(), expectedIntentRevision: z.number(), expectedOwnerEpoch: z.number() }) })
      .parse(await collaborations.command(source.assistantMessageId, "history", { action: "query", collaborationId: delegatedRelation.collaborationId, limit: 1 }));
    await collaborations.command(source.assistantMessageId, "next-history", history.nextQuery);
    const changesBeforeWrongCursor = z.object({ n: z.number() }).parse(db.prepare("SELECT total_changes() n").get()).n;
    await assert.rejects(collaborations.command(source.assistantMessageId, "wrong-relation-cursor", {
      action: "query", collaborationId: noWorkRelation.collaborationId, cursor: history.nextCursor, limit: 1 }), /游标/);
    assert.equal(z.object({ n: z.number() }).parse(db.prepare("SELECT total_changes() n").get()).n, changesBeforeWrongCursor,
      "an invalid collaboration cursor cannot capture a read guard or link the current request");
    const other = messages.accept(LOCAL_USER_ID, { botId: "query-b", requestId: "other-list", text: "查看收到的协作" });
    await assert.rejects(collaborations.command(other.assistantMessageId, "wrong-bot-cursor", { action: "query", limit: 1, cursor: list.nextCursor }), /游标/);
    const controller = messages.accept(LOCAL_USER_ID, { botId: "query-a", conversationId: source.conversationId,
      requestId: "pause-original-delegation", text: "暂停原委派事项" });
    const control = z.object({ versionGuard: z.object({ expectedStateVersion: z.number(), expectedIntentRevision: z.number(), expectedOwnerEpoch: z.number() }) })
      .parse(await collaborations.command(controller.assistantMessageId, "read-control", { action: "query", collaborationId: delegatedRelation.collaborationId }));
    await collaborations.command(controller.assistantMessageId, "pause-control", { action: "pause",
      collaborationId: delegatedRelation.collaborationId, versionGuard: control.versionGuard });
    assert.equal(works.getWork(delegated.workId)?.lifecycle, "paused");

    const sharedOrigin = { channelId: "slack-fixture", connectionKey: "a".repeat(64), chatId: "shared", senderId: "sender",
      messageId: "shared-query", audience: "shared" as const };
    const sharedConversation = messages.origins.gatewayConversation(LOCAL_USER_ID, "query-a", sharedOrigin);
    const shared = messages.accept(LOCAL_USER_ID, { botId: "query-a", requestId: "shared-query", conversationId: sharedConversation, text: "查我的安排" });
    const sharedPage = pageSchema.parse(await invoke("schedule_overview", {}, shared));
    assert.equal(sharedPage.total, 0); assert.deepEqual(await invoke("work_query_status", { workId: delegated.workId }, shared), []);
    assert.deepEqual(messages.message(shared.assistantMessageId)?.workIds, [], "a shared conversation cannot acquire an inaccessible task association");
    await assert.rejects(collaborations.command(shared.assistantMessageId, "shared-collab", { action: "query" }), /共享渠道/);
    const team = messages.accept(LOCAL_USER_ID, { botId: "query-a", requestId: "team-query", teamId: "query-team", text: "团队安排" });
    assert.equal(pageSchema.parse(await invoke("schedule_overview", {}, team, "query-team")).total, 0);
    assert.deepEqual(await invoke("work_query_status", { workId: delegated.workId }, team, "query-team"), []);
    assert.deepEqual(messages.message(team.assistantMessageId)?.workIds, [], "another team cannot acquire an inaccessible task association");
    await assert.rejects(collaborations.command(team.assistantMessageId, "team-collab", { action: "query" }), /个人请求/);

    // Validated explicit replies expose their persisted source immediately,
    // without transferring Work control or using the current UI selection.
    const referencedInput = { botId: source.botId, conversationId: source.conversationId, requestId: "explicit-reply-continuity",
      text: "补充这条任务回复", referenceMessageId: unboundQuery.assistantMessageId, selectedWorkId: owned.workId };
    const referenced = conversationService.send(referencedInput);
    const queued = messages.message(referenced.assistantMessageId)!;
    assert.equal(queued.status, "queued");
    assert.equal(botMessageSchema.parse(queued).referenceMessageId, unboundQuery.assistantMessageId,
      "queued replies project the exact authenticated receipt reference through the public DTO");
    assert.equal(messages.message(referenced.userMessageId)?.referenceMessageId, undefined, "assistant reply ownership is not inferred on user messages");
    assert.deepEqual(queued.workIds, []);
    assert.deepEqual(messages.message(referenced.userMessageId)?.workIds, []);
    assert.equal(messages.workOrigin(LOCAL_USER_ID, unbound.work.workId), undefined, "display references do not change the Work's delivery origin");
    assert.equal(conversationService.send(referencedInput).replayed, true);
    const referencedChain = conversationService.send({ botId: source.botId, conversationId: source.conversationId,
      requestId: "explicit-reply-chain", text: "再补充一个条件", referenceMessageId: referenced.assistantMessageId });
    assert.equal(messages.message(referencedChain.assistantMessageId)?.referenceMessageId, referenced.assistantMessageId,
      "a later explicit reply retains its direct reference rather than guessing the latest task");
    messages.update(referenced.assistantMessageId, "completed", "已接收补充说明");
    const reloadedReference = new BotConversationRepository(db).history(LOCAL_USER_ID, { botId: source.botId,
      conversationId: source.conversationId }).messages.find(message => message.messageId === referenced.assistantMessageId);
    assert.equal(reloadedReference?.referenceMessageId, unboundQuery.assistantMessageId, "completed replies keep the persisted reference after history reload");

    for (const [column, value] of [["bot_id", "query-c"], ["conversation_id", sharedConversation],
      ["request_id", "wrong-request"], ["user_id", "wrong-user"], ["assistant_message_id", "wrong-assistant"]]) {
      db.exec("SAVEPOINT reference_receipt_scope");
      try {
        db.prepare(`UPDATE bot_send_receipts SET ${column}=? WHERE assistant_message_id=?`).run(value, referenced.assistantMessageId);
        assert.equal(messages.message(referenced.assistantMessageId)?.referenceMessageId, undefined,
          `a mismatched receipt ${column} cannot attribute the reply`);
      } finally { db.exec("ROLLBACK TO reference_receipt_scope; RELEASE reference_receipt_scope"); }
    }
    for (const referenceMessageId of ["bot-message-missing", other.assistantMessageId, shared.assistantMessageId, team.assistantMessageId]) {
      const requestId = `invalid-reference:${referenceMessageId}`;
      assert.throws(() => conversationService.send({ botId: source.botId, conversationId: source.conversationId,
        requestId, text: "不能跨对话引用", referenceMessageId }), /消息引用不属于当前对话/);
      assert.equal(messages.receipt(LOCAL_USER_ID, source.botId, requestId), undefined, "an invalid reference is rejected before any request is persisted");
    }
    assert.equal(schedules.length, 0, "reference projection does not schedule or amend Work");
    console.log("PASS unified foreground queries: delegated/no-Work/reminder pagination, exact reply association without changing user targets or delivery origin, public results only, no Work control grant, original collaboration guards, shared/team isolation");
    console.log("PASS explicit reply references: queued/complete/reload/replay, exact scoped receipt identity, unlinked user/control provenance, unknown/cross-Bot/conversation/team rejection");
  } finally {
    await conversationService.close(); collaborations.close(); app.close(); rmSync(root, { recursive: true, force: true });
  }
}
