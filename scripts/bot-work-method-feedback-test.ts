import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { BotWorkMethodFeedback } from "../src/main/agent/work/BotWorkMethodFeedback";
import type { AppDatabase } from "../src/main/db/AppDatabase";
import type { BotMessageReceipt } from "../src/main/agent/work/BotConversationRepository";
import type { WorkDto } from "../src/shared/bot-work";

// Real SQLite selection/receipt/idempotence, real production record method.
// Skill installation and revision services are deterministic observation ports.
function fixture(text: string, invocations: Array<{ id: string; skill: string; version: string | null }>) {
  const connection = new Database(":memory:");
  connection.exec(`
    CREATE TABLE bot_messages(message_id TEXT,role TEXT,text TEXT,status TEXT);
    CREATE TABLE bot_conversations(conversation_id TEXT,user_id TEXT);
    CREATE TABLE bot_send_receipts(user_id TEXT,bot_id TEXT,request_id TEXT,conversation_id TEXT,user_message_id TEXT,assistant_message_id TEXT);
    CREATE TABLE work_teams(work_id TEXT);
    CREATE TABLE works(work_id TEXT,user_id TEXT,intent_revision INTEGER,owner_epoch INTEGER,input_snapshot_id TEXT);
    CREATE TABLE work_execution_bindings(bot_id TEXT,task_id TEXT,binding_id TEXT,status TEXT,work_id TEXT,invalidated_at INTEGER,intent_revision INTEGER,owner_epoch INTEGER,input_snapshot_id TEXT,admitted_at INTEGER);
    CREATE TABLE memory_skill_effectiveness(id TEXT,task_id TEXT,assistant_message_id TEXT,skill_id TEXT,candidate_id TEXT,invoked_at INTEGER);
    INSERT INTO bot_conversations VALUES('conversation','user');
    INSERT INTO bot_send_receipts VALUES('user','B','request','conversation','user-message','assistant-message');
    INSERT INTO bot_messages VALUES('assistant-message','assistant','','running');
    INSERT INTO works VALUES('work','user',1,1,'input');
    INSERT INTO work_execution_bindings VALUES('B','task','binding','completed','work',NULL,1,1,'input',1);
  `);
  connection.prepare("INSERT INTO bot_messages VALUES('user-message','user',?,'completed')").run(text);
  invocations.forEach((item, index) => connection.prepare("INSERT INTO memory_skill_effectiveness VALUES(?,?,?,?,?,?)")
    .run(item.id, "task", `turn-${index}`, item.skill, item.version, index + 1));
  const feedback: Array<{ id: string; candidateId: string }> = [];
  let refreshes = 0;
  type Options = ConstructorParameters<typeof BotWorkMethodFeedback>[0];
  const options = {
    db: { connection } as unknown as AppDatabase,
    works: {}, memory: {}, userId: "user",
    skills: { listInstalled: () => [...new Set(invocations.map(item => item.skill))].map(id => ({ id, name: id })),
      getLearnedSkillRevisionSource: (id: string) => ({ skillId: id, candidateId: "v2" }) },
    effectiveness: { setWorkFeedback: (input: { id: string; candidateId: string }) => feedback.push(input) },
    revisions: { refresh: () => { refreshes++; return { candidate: { id: "revision" } }; } },
  } as unknown as Options;
  const service = new BotWorkMethodFeedback(options);
  const source = { user_id: "user", bot_id: "B", request_id: "request", conversation_id: "conversation",
    user_message_id: "user-message", assistant_message_id: "assistant-message" } as BotMessageReceipt;
  const work = { workId: "work", userId: "user", ownerBotId: "B" } as WorkDto;
  return { connection, feedback, refreshes: () => refreshes, record: () => service.record(source, work) as {
    status: string; invocationIds?: string[]; skillVersions?: Array<{ skillId: string; candidateId: string | null; invocationIds: string[] }> } };
}

const cases: Array<() => void> = [
  () => {
    const f = fixture("纠正 same-skill 方法：以后必须核对输出。", [
      { id: "first", skill: "same-skill", version: "v2" }, { id: "latest", skill: "same-skill", version: "v2" },
    ]);
    try {
      const result = f.record();
      assert.equal(result.status, "skill_revision_feedback");
      assert.deepEqual(result.invocationIds, ["latest", "first"]);
      assert.deepEqual(f.feedback.map(item => item.id), ["latest"]);
      assert.equal(f.refreshes(), 1);
      assert.deepEqual(f.record(), result, "replaying the same receipt reuses persisted evidence");
      assert.equal(f.feedback.length, 1);
      assert.equal(f.refreshes(), 1);
    } finally { f.connection.close(); }
  },
  () => {
    const f = fixture("纠正 same-skill 方法：以后必须核对输出。", [
      { id: "old", skill: "same-skill", version: "v1" }, { id: "new", skill: "same-skill", version: "v2" },
    ]);
    try {
      const result = f.record();
      assert.equal(result.status, "ambiguous_skill");
      assert.deepEqual(result.skillVersions?.map(item => item.candidateId), ["v2", "v1"]);
      assert.equal(f.feedback.length, 0); assert.equal(f.refreshes(), 0);
    } finally { f.connection.close(); }
  },
  () => {
    const invocations = [{ id: "a", skill: "method-a", version: "v2" }, { id: "b", skill: "method-b", version: "v2" }];
    for (const named of [false, true]) {
      const f = fixture(`纠正${named ? " method-a" : ""}方法：以后必须核对输出。`, invocations);
      try {
        assert.equal(f.record().status, named ? "skill_revision_feedback" : "ambiguous_skill");
        assert.deepEqual(f.feedback.map(item => item.id), named ? ["a"] : []);
      } finally { f.connection.close(); }
    }
  },
  () => {
    for (const version of ["v2", null]) {
      const f = fixture("纠正 same-skill 方法：以后必须核对输出。", [{ id: "one", skill: "same-skill", version }]);
      try {
        assert.equal(f.record().status, version ? "skill_revision_feedback" : "skill_revision_changed");
        assert.equal(f.feedback.length, version ? 1 : 0);
      } finally { f.connection.close(); }
    }
  },
];
for (const run of cases) run();
console.log("PASS bot work method feedback: same-version grouping, version ambiguity, explicit selection, replay and missing version");
