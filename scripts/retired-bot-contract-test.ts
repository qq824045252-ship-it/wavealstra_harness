import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { locateRuntimeAudit } from "../src/main/platform/runtime-audit";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { BotConversationRepository } from "../src/main/agent/work/BotConversationRepository";
import { HistoricalBotReader } from "../src/main/agent/work/HistoricalBotReader";
import { BotWorkspaceNavigationService } from "../src/main/agent/work/BotWorkspaceNavigationService";
import { WorkService } from "../src/main/agent/work/WorkService";
import { ConversationGoalService } from "../src/main/agent/ConversationGoalService";
import { BotWorkIpc } from "../src/shared/bot-work-ipc";
import { LOCAL_USER_ID } from "../src/shared/bot-work";
import { createActiveContextState } from "../src/renderer/src/store/app/slices/activeContext";
import type { BotWorkApi } from "../src/shared/bot-work-ipc";

assert.deepEqual(BotWorkIpc, {history: "bot-work:history", workspaceNavigation: "bot-work:workspace-navigation", getWork: "bot-work:get-work"});
const state = createActiveContextState();
assert.equal(state.activeTaskId, null);
assert.equal(Object.keys(state).some(key => /bot|selectedWork|selectedTeam/i.test(key)), false);
// Compiler-level boundary: consumers cannot regain the retired write API.
type RetiredApiKeys = Exclude<keyof BotWorkApi, keyof typeof BotWorkIpc>;
const noRetiredApi: [RetiredApiKeys] extends [never] ? true : never = true;
assert.equal(noRetiredApi, true);

const root = mkdtempSync(join(tmpdir(), "retired-bot-"));
const useNative = process.argv.includes("--native");
const runtimeAuditExecutable = useNative ? locateRuntimeAudit(process.cwd()) : undefined;
if (useNative) assert(runtimeAuditExecutable && existsSync(runtimeAuditExecutable), "Rust worker executable is required");
const db = new AppDatabase(join(root, "app.db"), { runtimeAuditExecutable });
try {
  const bots = new BotRegistry(db.connection), bot = bots.ensureDefaultBot(LOCAL_USER_ID);
  bots.registerBot({botId: "foreign", userId: "foreign-user", displayName: "Foreign"});
  const works = new WorkService(db.connection, {bots});
  const messages = new BotConversationRepository(db.connection);
  const attachments = [{ name: "旧材料.txt", path: join(root, "旧材料.txt") }];
  const receipt = messages.accept(LOCAL_USER_ID, {botId: bot.botId, requestId: "historical", text: "旧问题", attachments});
  const segments = [{id: "answer", kind: "answer" as const, text: "旧答案", createdAt: 1, updatedAt: 2}];
  messages.update(receipt.assistantMessageId, "completed", "旧答案", undefined, undefined, segments);
  const reader = new HistoricalBotReader(db, bots, works);
  const navigation = new BotWorkspaceNavigationService(db, LOCAL_USER_ID);
  const changes = () => Number((db.connection.prepare("SELECT total_changes() n").get() as {n: number}).n);
  navigation.ensureBot(bot.botId);
  if (useNative) {
    // Contradict the host-only hydration without changing the committed fixture.
    // The real history API must still deliver both metadata values to the caller.
    db.connection.exec(`CREATE TEMP TABLE bot_message_attachments(message_id TEXT PRIMARY KEY, attachments_json TEXT);
      CREATE TEMP TABLE bot_message_segments(message_id TEXT PRIMARY KEY, segments_json TEXT);`);
  }
  const before = changes();
  for (let i = 0; i < 2; i++) {
    const history = await reader.history({botId: bot.botId, conversationId: receipt.conversationId});
    assert.deepEqual(history.messages.map(message => message.text), ["旧问题", "旧答案"]);
    assert.deepEqual(history.messages[0]?.attachments, attachments);
    assert.deepEqual(history.messages[1]?.segments, segments);
    assert.equal(navigation.snapshot({repair: false}).foregroundRequests[0]?.requestId, "historical");
  }
  await assert.rejects(reader.history({botId: "foreign"}), /不属于/);
  assert.equal(changes(), before, "successive historical reads cannot repair, enqueue or rewrite records");
  const exact = await reader.history({botId: bot.botId, conversationId: receipt.conversationId, messageIds: [receipt.assistantMessageId]});
  assert.deepEqual(exact.messages.map(message => message.text), ["旧答案"]);
  assert.equal(exact.before, undefined);
  if (useNative) db.connection.exec("DROP TABLE temp.bot_message_attachments; DROP TABLE temp.bot_message_segments;");

  const native = db.runtimeAuditReader;
  if (native) {
    const readPage = native.readBotHistoryPage.bind(native);
    native.readBotHistoryPage = async query => {
      const result = await readPage(query);
      assert.equal(result?.kind, "ready");
      db.connection.prepare("UPDATE bots SET user_id=? WHERE bot_id=?").run("foreign-user", bot.botId);
      return result;
    };
    try {
      await assert.rejects(reader.history({botId: bot.botId, conversationId: receipt.conversationId}), /Bot 不属于当前用户/);
    } finally {
      native.readBotHistoryPage = readPage;
      db.connection.prepare("UPDATE bots SET user_id=? WHERE bot_id=?").run(LOCAL_USER_ID, bot.botId);
    }
  }
  for (const method of ["handle", "createFromForeground", "buildFromForeground", "replanFromForeground", "wakePending", "dispatchPending", "continueMissing"])
    assert.equal(method in works.teams, false, method + " is retired");

  const goals = new ConversationGoalService(works, () => {});
  const created = goals.create({taskId: "ordinary-task", title: "当前目标", criteria: [{text: "真实核对"}]});
  assert(created.ok);
  assert.equal(goals.update({goalId: created.goal.id, status: "achieved"}).ok, false, "unverified Goal cannot complete");
  const updated = goals.update({goalId: created.goal.id, criterionUpdates: [{id: created.goal.criteria[0]!.id, status: "met", evidence: "已核对"}]});
  assert(updated.ok);
  assert.equal(updated.goal.criteria[0]?.status, "met");
  const completed = goals.update({goalId: created.goal.id, status: "achieved", progressSummary: "完成"});
  assert(completed.ok);
  assert.equal(completed.goal.status, "achieved");
  assert.equal(works.getWork(created.goal.id)?.closureConclusion, "succeeded");
  assert.equal((await reader.history({botId: bot.botId, conversationId: receipt.conversationId})).messages.length, 2);
  const scope = { botId: bot.botId, conversationId: receipt.conversationId };
  for (let i = 0; i < 59; i++) {
    messages.accept(LOCAL_USER_ID, { ...scope, requestId: `later-${i}`, text: `新问题 ${i}` });
  }
  const recent = await reader.history(scope);
  assert.equal(recent.messages.length, 100);
  assert.equal(recent.messages[0]?.text, "新问题 9");
  assert.equal(recent.messages.at(-2)?.text, "新问题 58");
  assert(recent.before);
  const older = await reader.history({ ...scope, before: recent.before });
  assert.equal(older.messages.length, 20);
  assert.equal(older.messages[0]?.text, "旧问题");
  assert.equal(older.messages.at(-2)?.text, "新问题 8");
  assert.equal(older.before, undefined);
  const caughtUp = await reader.history({ ...scope, after: older.messages.at(-1)!.ordinal, before: recent.messages[2]!.ordinal });
  assert.deepEqual(caughtUp.messages.map(message => message.text), ["新问题 9", ""]);
  const team = messages.accept(LOCAL_USER_ID, { botId: bot.botId, teamId: "team-only", requestId: "team", text: "团队消息" });
  await assert.rejects(reader.history({ botId: bot.botId, conversationId: team.conversationId }), /不属于当前团队或个人空间/);
  console.log("PASS retired Bot API/state/team writers absent; historical reads are unchanged and read-only; Goal evidence and completion remain live");
} finally {await db.runtimeAuditReader?.close(); db.close(); rmSync(root, {recursive: true, force: true});}
