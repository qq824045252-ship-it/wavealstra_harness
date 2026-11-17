import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
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
const db = new AppDatabase(join(root, "app.db"));
try {
  const bots = new BotRegistry(db.connection), bot = bots.ensureDefaultBot(LOCAL_USER_ID);
  bots.registerBot({botId: "foreign", userId: "foreign-user", displayName: "Foreign"});
  const works = new WorkService(db.connection, {bots});
  const messages = new BotConversationRepository(db.connection);
  const receipt = messages.accept(LOCAL_USER_ID, {botId: bot.botId, requestId: "historical", text: "旧问题"});
  messages.update(receipt.assistantMessageId, "completed", "旧答案");
  const reader = new HistoricalBotReader(db, bots, works);
  const navigation = new BotWorkspaceNavigationService(db, LOCAL_USER_ID);
  const changes = () => Number((db.connection.prepare("SELECT total_changes() n").get() as {n: number}).n);
  navigation.ensureBot(bot.botId);
  const before = changes();
  for (let i = 0; i < 2; i++) {
    const history = await reader.history({botId: bot.botId, conversationId: receipt.conversationId});
    assert.deepEqual(history.messages.map(message => message.text), ["旧问题", "旧答案"]);
    assert.equal(navigation.snapshot({repair: false}).foregroundRequests[0]?.requestId, "historical");
  }
  await assert.rejects(reader.history({botId: "foreign"}), /不属于/);
  assert.equal(changes(), before, "successive historical reads cannot repair, enqueue or rewrite records");
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
  console.log("PASS retired Bot API/state/team writers absent; historical reads are unchanged and read-only; Goal evidence and completion remain live");
} finally {db.close(); rmSync(root, {recursive: true, force: true});}
