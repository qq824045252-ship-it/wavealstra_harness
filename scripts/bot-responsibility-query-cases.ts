import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { BotConversationRepository } from "../src/main/agent/work/BotConversationRepository";
import { BotWorkQuery } from "../src/main/agent/work/BotWorkQuery";
import { botScheduleOverview, type BotScheduleOverviewQuery } from "../src/main/agent/work/BotScheduleOverview";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { CronService } from "../src/main/cron/CronService";
import { LOCAL_USER_ID, type WorkActor } from "../src/shared/bot-work";

export function verifyResponsibilityQueries(): void {
  const directory = mkdtempSync(join(tmpdir(), "responsibility-query-"));
  const db = new AppDatabase(join(directory, "app.db"));
  try {
    const bots = new BotRegistry(db.connection);
    for (const botId of ["A", "B", "C"]) bots.registerBot({ botId, userId: LOCAL_USER_ID, displayName: botId, authorization: DESKTOP_USER_GRANTS });
    const works = new WorkService(db.connection, { bots });
    const messages = new BotConversationRepository(db.connection);
    const user: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants: DESKTOP_USER_GRANTS };
    const source = messages.accept(LOCAL_USER_ID, { botId: "A", requestId: "source", text: "我交办的事" });
    const query = new BotWorkQuery(db.connection, LOCAL_USER_ID, "A");
    const cron = new CronService(db, { prompt: async () => { throw Error("query must not run a model"); },
      waitForSubmission: async () => { throw Error("query must not submit"); }, loadTaskHistory: async () => ({ messages: [] }),
      isTaskBusy: () => false, getAppSettings: () => ({}), resolveAvailableModelId: async () => undefined,
      listSkills: () => [], listConnectors: () => [] });
    const dependencies = { db: db.connection, works, catalogue: query, reminders: () => cron,
      userId: LOCAL_USER_ID, botId: "A", conversationId: source.conversationId };
    const overview = (input: BotScheduleOverviewQuery = {}) => botScheduleOverview(dependencies, input);
    const create = (id: string, ownerBotId = "A", deadlineAt?: number) => {
      const result = works.createWork(user, { operationId: id, title: id, ownerBotId, deadlineAt });
      assert(result.ok, JSON.stringify(result)); return result.work;
    };
    const relation = (id: string, createdAt = Date.now()) => {
      const result = messages.collaborations.ensure({ userId: LOCAL_USER_ID, sourceBotId: "A", sourceDisplayName: "A",
        sourceConversationId: source.conversationId, sourceRequestId: source.requestId, sourceUserMessageId: source.userMessageId,
        sourceAssistantMessageId: source.assistantMessageId, targetBotId: "B", targetDisplayName: "B", operationId: id, now: createdAt });
      messages.collaborations.appendMessage(LOCAL_USER_ID, result.collaborationId, { operationId: id,
        senderBotId: "A", senderDisplayName: "A", kind: "request", text: id });
      return result;
    };
    const self = create("self"), delegated = create("delegated", "B"), unrelated = create("unrelated", "B");
    const linked = relation("delegated request"), unbound = relation("request without Work");
    messages.collaborations.linkWork(LOCAL_USER_ID, linked.collaborationId, delegated.workId);
    const now = Date.now();
    cron.upsert({ id: self.workId, name: "Independent reminder", prompt: "Saved reminder text", scheduleType: "at",
      scheduleExpr: new Date(now + 86_400_000).toISOString(), timezone: "UTC", enabled: true, createdAt: now, updatedAt: now, restartPolicy: "resume",
      reminder: { state: "scheduled", kind: "bot-reminder", userId: LOCAL_USER_ID, botId: "A", conversationId: source.conversationId } });
    assert.equal(query.page({}).total, 1, "control catalogue retains its original scope");
    assert.equal(query.canRead(delegated.workId), false);
    assert.equal(query.outgoingCollaboration(delegated.workId)?.collaborationId, linked.collaborationId);
    assert.equal(query.responsibilitiesPage({}).total, 2);
    assert.equal(query.outgoingCollaboration(unrelated.workId), undefined);
    const first = overview();
    assert.equal(first.total, 4); assert.equal(first.counts.total, 4);
    assert(first.items.some(item => item.kind === "collaboration" && item.collaborationId === unbound.collaborationId && item.status === "sent" && item.needsUserInput === null));
    assert.equal(new Set(first.items.map(item => item.id)).size, 4, "reminder and Work never share an item identity");
    assert(!first.items.some(item => item.kind === "work" && item.workId === unrelated.workId));
    const insertParticipant = db.connection.prepare("INSERT INTO work_participants(work_id,bot_id,role,delegated_scope_json,expert_snapshot_json,added_at) VALUES (?,?,'watcher','[]','{}',1)");
    insertParticipant.run(self.workId, "A"); insertParticipant.run(delegated.workId, "A");
    assert.equal(query.responsibilitiesPage({}).total, 2, "owner, participant and outgoing relation deduplicate before counting");
    assert.equal(overview().total, 4);
    messages.collaborations.event(LOCAL_USER_ID, linked.collaborationId, { operationId: "returned", kind: "returned" });
    assert(overview().items.some(item => item.kind === "work" && item.workId === delegated.workId && item.lifecycle === "active"), "returned receipt does not close its active Work");

    works.repo.linkConversation(self.workId, "shared", "desktop", now);
    const shared = new BotWorkQuery(db.connection, LOCAL_USER_ID, "A", undefined, "shared");
    assert.equal(shared.responsibilitiesPage({}).total, 1);
    assert.equal(shared.outgoingCollaboration(delegated.workId), undefined);
    assert.equal(botScheduleOverview({ ...dependencies, catalogue: shared, conversationId: "shared" }).total, 1);
    const team = new BotWorkQuery(db.connection, LOCAL_USER_ID, "A", "other-team");
    assert.equal(botScheduleOverview({ ...dependencies, catalogue: team, teamId: "other-team" }).total, 0);
    assert.equal(new BotWorkQuery(db.connection, "other-user", "A").responsibilitiesPage({}).total, 0);

    db.connection.prepare("DELETE FROM work_participants WHERE work_id=? AND bot_id='A'").run(delegated.workId);
    assert(works.handoffOwner(user, { operationId: "handoff", workId: delegated.workId, targetBotId: "C" }).ok);
    assert.equal(query.outgoingCollaboration(delegated.workId), undefined);
    assert(!query.responsibilitiesPage({}).items.some(item => item.workId === delegated.workId));
    const changed = overview().items.find(item => item.id === `collaboration:${linked.collaborationId}`);
    assert(changed?.kind === "collaboration" && changed.scopeChanged, "ownership change retains the original responsibility without leaking the new owner's Work");
    assert.equal("workId" in changed, false);
    messages.collaborations.event(LOCAL_USER_ID, linked.collaborationId, { operationId: "cancelled", kind: "cancelled" });
    assert(!overview().items.some(item => item.id === changed.id), "cancelled collaboration cannot reopen because its owner changed");
    assert(overview({ status: "all" }).items.some(item => item.id === changed.id));
    for (const destination of ["A", "C"]) {
      const title = `HandoffVisible${destination}`;
      const assigned = create(title, "B"), association = relation(title);
      messages.collaborations.linkWork(LOCAL_USER_ID, association.collaborationId, assigned.workId);
      if (destination === "C") insertParticipant.run(assigned.workId, "A");
      const handed = works.handoffOwner(user, { operationId: `handoff:${title}`, workId: assigned.workId, targetBotId: destination });
      assert(handed.ok, JSON.stringify(handed));
      const reassigned = overview({ search: title });
      assert.equal(reassigned.total, 1, "independently readable handoff keeps one responsibility, not Work plus original relation");
      assert.equal(reassigned.items[0]?.id, `collaboration:${association.collaborationId}`);
      assert.equal(reassigned.items[0]?.kind, "work");
      assert.equal(query.outgoingCollaboration(assigned.workId), undefined, "stable identity never grants old target control authority");
    }

    works.repo.insertWork({ ...self, workId: "long-title", title: "x".repeat(250) + "FindWorkTitleTail" });
    cron.upsert({ id: "long-reminder", name: "x".repeat(250) + "FindReminderTitleTail", prompt: "x".repeat(600) + "FindReminderBodyTail",
      scheduleType: "at", scheduleExpr: new Date(now + 86_400_000).toISOString(), timezone: "UTC", enabled: true,
      createdAt: now, updatedAt: now, restartPolicy: "resume", reminder: { state: "scheduled", kind: "bot-reminder",
        userId: LOCAL_USER_ID, botId: "A", conversationId: source.conversationId } });
    assert.equal(overview({ search: "FindWorkTitleTail" }).total, 1, "search uses full Work title before output truncation");
    assert.equal(overview({ search: "FindReminderTitleTail" }).total, 1);
    const reminderTail = overview({ search: "FindReminderBodyTail" });
    assert.equal(reminderTail.total, 1);
    const boundedReminder = reminderTail.items[0];
    assert(boundedReminder.kind === "reminder" && boundedReminder.title.length === 200 && boundedReminder.content.length === 500);
    assert(!JSON.stringify(reminderTail).includes("x".repeat(501)), "complete reminder search facts never escape in response metadata");

    const waitingUser = create("waiting user"), waitingExternal = create("waiting external"), waitingTime = create("waiting time");
    const blocker = db.connection.prepare("INSERT INTO work_blockers(blocker_id,work_id,reason,kind,waiting_for_user_input,status,created_at) VALUES (?,?,?,'operational',?,'open',1)");
    blocker.run("input", waitingUser.workId, "User must supply destination", 1);
    blocker.run("external", waitingExternal.workId, "External service unavailable", 0);
    works.repo.insertSubscription({ subscriptionId: "future", workId: waitingTime.workId, source: "cron", filter: {}, maxMergeWaitMs: 0,
      maxQueueDepth: 1, nextWakeAt: now + 60_000, catchUpPolicy: "latest", createdAt: now, updatedAt: now });
    const waiting = overview({ search: "waiting" });
    assert.deepEqual(waiting.items.map(item => item.kind === "work" ? item.status : "wrong").sort(), ["blocked", "scheduled", "waiting_input"]);
    assert.equal(overview({ needsUserInput: true }).total, 1);
    assert(overview({ needsUserInput: false }).items.every(item => item.kind === "work"), "absence of a Work input fact is not false");

    db.connection.transaction(() => {
      for (let index = 0; index < 513; index++) works.repo.insertWork({ ...self, workId: `bulk-${index}`, title: `Bulk ${index}`,
        createdAt: index < 6 ? 1 + Math.floor(index / 2) : 1000 + index, updatedAt: 1,
        deadlineAt: index < 6 ? 1000 + Math.floor(index / 2) : undefined });
    })();
    const changesBefore = db.connection.prepare("SELECT total_changes() n").get();
    const overviewStarted = performance.now();
    let page = overview({ search: "Bulk", limit: 50 });
    const firstPageMs = performance.now() - overviewStarted;
    assert.equal(page.total, 513); assert.equal(page.items.length, 50); assert(page.hasMore && page.nextQuery);
    const ids: string[] = [];
    do { ids.push(...page.items.map(item => item.id)); if (!page.nextQuery) break; page = overview(page.nextQuery); } while (true);
    assert.equal(ids.length, 513); assert.equal(new Set(ids).size, 513);
    const traversalMs = performance.now() - overviewStarted;
    let due = overview({ search: "Bulk", deadlineFrom: 1000, deadlineBefore: 1003, sort: "deadline_asc", limit: 2 });
    assert.equal(due.total, 6);
    const dueIds: string[] = [];
    const dueFirst = due;
    do { dueIds.push(...due.items.map(item => item.id)); if (!due.nextQuery) break; due = overview(due.nextQuery); } while (true);
    assert.deepEqual(dueIds, ["work:bulk-1", "work:bulk-0", "work:bulk-3", "work:bulk-2", "work:bulk-5", "work:bulk-4"]);
    assert.equal(overview({ search: "Bulk", deadlineFrom: 1001, deadlineBefore: 1002 }).total, 2);
    assert.equal(overview({ deadlineBefore: 1000 }).total, 0);
    assert.deepEqual(db.connection.prepare("SELECT total_changes() n").get(), changesBefore, "unified query performs zero SQLite writes");
    assert(dueFirst.nextQuery);
    assert.throws(() => overview({ ...dueFirst.nextQuery, deadlineBefore: 1002 }), /不匹配/);
    assert.throws(() => botScheduleOverview({ ...dependencies, botId: "B", catalogue: new BotWorkQuery(db.connection, LOCAL_USER_ID, "B") }, dueFirst.nextQuery!), /不匹配/);
    assert.throws(() => botScheduleOverview({ ...dependencies, catalogue: shared, conversationId: "shared" }, dueFirst.nextQuery!), /不匹配/);

    const lateFirst = relation("LateCase first", 3000), lateSecond = relation("LateCase second", 2000), lateThird = relation("LateCase third", 1000);
    const beforeLink = overview({ search: "LateCase", limit: 1 });
    assert.equal(beforeLink.items[0]?.id, `collaboration:${lateFirst.collaborationId}`); assert(beforeLink.nextQuery);
    const linkedFirst = create("LateCase first Work", "B"), linkedSecond = create("LateCase second Work", "B");
    messages.collaborations.linkWork(LOCAL_USER_ID, lateFirst.collaborationId, linkedFirst.workId);
    messages.collaborations.linkWork(LOCAL_USER_ID, lateSecond.collaborationId, linkedSecond.workId);
    db.connection.prepare("UPDATE works SET progress_summary='New progress',updated_at=? WHERE work_id=?").run(Date.now(), linkedFirst.workId);
    const afterLink = overview(beforeLink.nextQuery);
    assert.equal(afterLink.items[0]?.id, `collaboration:${lateSecond.collaborationId}`);
    assert.equal(afterLink.items[0]?.kind, "work"); assert(afterLink.nextQuery);
    assert.equal(overview(afterLink.nextQuery).items[0]?.id, `collaboration:${lateThird.collaborationId}`);
    const dueAnchor = create("DeadlineLate anchor", "A", 1000), dueLate = relation("DeadlineLate request");
    const beforeDueLink = overview({ search: "DeadlineLate", sort: "deadline_asc", limit: 1 });
    assert.equal(beforeDueLink.items[0]?.id, `work:${dueAnchor.workId}`); assert(beforeDueLink.nextQuery);
    const newlyDue = create("DeadlineLate Work", "B", 500);
    messages.collaborations.linkWork(LOCAL_USER_ID, dueLate.collaborationId, newlyDue.workId);
    assert.throws(() => overview(beforeDueLink.nextQuery!), /事项集合或排序已变化/, "late deadline crossing the cursor requires a fresh page, never silent omission");
    assert.equal(overview({ search: "DeadlineLate", sort: "deadline_asc" }).items[0]?.id, `collaboration:${dueLate.collaborationId}`);
    console.log(`PASS unified responsibilities: scoped outgoing Work, no-Work receipts, distinct reminders, deduplicated counts, 513-row traversal (${firstPageMs.toFixed(1)}ms first page/${traversalMs.toFixed(1)}ms traversal), deadline/input filters, late-link cursors, handoff privacy, complete-text search and zero writes`);
  } finally { db.close(); rmSync(directory, { recursive: true, force: true }); }
}
