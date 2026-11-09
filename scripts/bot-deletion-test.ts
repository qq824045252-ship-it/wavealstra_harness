import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { BotDeletionService } from "../src/main/agent/work/BotDeletionService";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkActor } from "../src/shared/bot-work";
const root = mkdtempSync(join(tmpdir(), "bot-delete-"));
const db = new AppDatabase(join(root, "app.db"));
const bots = new BotRegistry(db.connection);
const grants = { ...DESKTOP_USER_GRANTS, allowRedelegation: true };
const actor: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants };
const works = new WorkService(db.connection, { bots });
let authority = true;
const service = new BotDeletionService(db.connection, bots, works, { userId: LOCAL_USER_ID, isAuthority: () => authority });
const register = (id: string, userId = LOCAL_USER_ID) => bots.registerBot({ botId: id, userId, displayName: id, authorization: grants });
const remove = (id: string) => service.delete({ botId: id, expectedUpdatedAt: bots.getBot(id)!.updatedAt });
function create(ownerBotId: string) {
 const result = works.createWork(actor, { operationId: `create-${ownerBotId}`, title: ownerBotId, ownerBotId, authorization: grants, inputSnapshotId: "input" });
 assert(result.ok, JSON.stringify(result)); return result.work;
}
try {
 register(DEFAULT_BOT_ID); register("test-bot"); register("other-bot"); register("foreign", "other-user");
 assert.equal(remove(DEFAULT_BOT_ID).ok, false); assert.equal(remove("foreign").ok, false);
 authority = false; assert.equal(remove("test-bot").ok, false); authority = true;
 const work = create("test-bot");
 db.connection.prepare(`INSERT INTO bot_conversations(conversation_id,bot_id,user_id,created_at,updated_at) VALUES ('conv','test-bot',?,1,1)`).run(LOCAL_USER_ID);
 db.connection.exec(`INSERT INTO bot_messages(message_id,conversation_id,bot_id,request_id,role,text,status,created_at,updated_at)
 VALUES ('msg','conv','test-bot','req','assistant','hello','running',1,1)`);
 assert.equal(remove("test-bot").ok, false, "running conversation rejects without side effects");
 assert.equal(works.getWork(work.workId)?.ownerBotId, "test-bot");
 db.connection.exec("UPDATE bot_messages SET status='completed'");
 const deleted = remove("test-bot"); assert(deleted.ok, JSON.stringify(deleted));
 assert.equal(bots.getBot("test-bot"), undefined); assert(bots.getBot("other-bot"));
 assert.equal((db.connection.prepare("SELECT count(*) n FROM bot_messages WHERE bot_id='test-bot'").get() as { n: number }).n, 0);
 assert.equal(works.getWork(work.workId)?.ownerBotId, DEFAULT_BOT_ID);
 assert.equal(works.getWork(work.workId)?.ownerEpoch, work.ownerEpoch + 1);
 assert.equal(works.getWork(work.workId)?.lifecycle, "active");
 assert.equal(works.collaboration.history(work.workId).filter(m => m.kind === "handoff").length, 1);
 register("closed-bot"); const closed = create("closed-bot");
 db.connection.prepare("UPDATE works SET lifecycle='closed',closure_conclusion='cancelled',closed_at=2 WHERE work_id=?").run(closed.workId);
 assert(remove("closed-bot").ok); assert.equal(works.getWork(closed.workId)?.lifecycle, "closed");
 assert.equal(works.getWork(closed.workId)?.ownerBotId, DEFAULT_BOT_ID);
 register("rollback-bot"); const fail = create("rollback-bot");
 db.connection.prepare("UPDATE works SET authorization_json=json_set(authorization_json,'$.allowRedelegation',json('false')) WHERE work_id=?").run(fail.workId);
 assert.equal(remove("rollback-bot").ok, false); assert(bots.getBot("rollback-bot"));
 assert.equal(works.getWork(fail.workId)?.ownerBotId, "rollback-bot");
 assert.deepEqual(db.connection.pragma("foreign_key_check"), []);
 console.log("PASS Bot deletion: live handoff, closed history, conversation deletion, atomic failure, default/foreign/host protection");
} finally { db.close(); rmSync(root, { recursive: true, force: true }); }
