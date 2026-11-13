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
import { BotCollaborationService, botCollaborationToolSchema } from "../src/main/agent/work/BotCollaborationService";
import { botForegroundTools } from "../src/main/agent/work/BotForegroundTools";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { CronService, type CronAgent } from "../src/main/cron/CronService";
import { LOCAL_USER_ID } from "../src/shared/bot-work";

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

    const legacy = workRows.parse(await invoke("work_query_status", {}));
    assert(legacy.some(item => item.workId === delegated.workId && item.delegation?.collaborationId === delegatedRelation.collaborationId));
    const detail = workRows.parse(await invoke("work_query_status", { workId: delegated.workId }));
    assert.equal(detail[0]?.readOnly, true); assert(JSON.stringify(detail).includes("PUBLIC_RESULT:"));
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
    await assert.rejects(collaborations.command(shared.assistantMessageId, "shared-collab", { action: "query" }), /共享渠道/);
    const team = messages.accept(LOCAL_USER_ID, { botId: "query-a", requestId: "team-query", teamId: "query-team", text: "团队安排" });
    assert.equal(pageSchema.parse(await invoke("schedule_overview", {}, team, "query-team")).total, 0);
    assert.deepEqual(await invoke("work_query_status", { workId: delegated.workId }, team, "query-team"), []);
    await assert.rejects(collaborations.command(team.assistantMessageId, "team-collab", { action: "query" }), /个人请求/);
    console.log("PASS unified foreground queries: delegated/no-Work/reminder pagination, public results only, no Work control grant, original collaboration guards, shared/team isolation");
  } finally {
    collaborations.close(); app.close(); rmSync(root, { recursive: true, force: true });
  }
}
