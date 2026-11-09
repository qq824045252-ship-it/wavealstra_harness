import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import Database from "better-sqlite3";
import { ensureBotWorkPhase2Tables } from "../src/main/db/bot-work-phase2-schema";
import { retireWorkEffectBlockers } from "../src/main/db/work-effect-retirement";

const db = new Database(":memory:");
assert.deepEqual(retireWorkEffectBlockers(db, 100), { clearedBlockers: 0, consumedAdmissions: 0, promotedPlans: 0, unknownAdmissions: 0 });
db.exec(`
 CREATE TABLE work_blockers(blocker_id TEXT PRIMARY KEY,work_id TEXT,kind TEXT,unknown_external_effect_ref TEXT,status TEXT,reason TEXT,details_json TEXT,created_at INTEGER,cleared_at INTEGER,waiting_for_user_input INTEGER);
 CREATE TABLE work_execution_bindings(binding_id TEXT PRIMARY KEY,work_id TEXT,task_id TEXT,conversation_id TEXT,intent_revision INTEGER,owner_epoch INTEGER,bot_id TEXT,status TEXT,invalidated_at INTEGER,inbox_event_id TEXT,input_snapshot_id TEXT,delegated_scope_json TEXT);
 CREATE TABLE work_action_admissions(admission_id TEXT PRIMARY KEY,work_id TEXT,binding_id TEXT,operation_id TEXT,state TEXT,intent_revision INTEGER,owner_epoch INTEGER,settled_at INTEGER);
 CREATE TABLE execution_attempts(id TEXT PRIMARY KEY,task_id TEXT,execution_id TEXT,assistant_message_id TEXT,tool_call_id TEXT,target TEXT,status TEXT,record_json TEXT,finished_at INTEGER);
 CREATE TABLE works(work_id TEXT PRIMARY KEY,lifecycle TEXT,cancel_requested_at INTEGER,pending_conclusion TEXT,owner_bot_id TEXT,owner_epoch INTEGER,intent_revision INTEGER,input_snapshot_id TEXT);
 CREATE TABLE tasks(id TEXT PRIMARY KEY,permission_mode TEXT);
 CREATE TABLE work_automatic_recovery(source_binding_id TEXT,plan_id TEXT,fingerprint TEXT,mode TEXT,created_at INTEGER);
 CREATE TABLE work_continuation_plans(plan_id TEXT,source_binding_id TEXT,work_id TEXT,reason TEXT,state TEXT,owner_epoch INTEGER,owner_bot_id TEXT,intent_revision INTEGER,input_snapshot_id TEXT);
 CREATE TABLE work_dispatch_requests(task_id TEXT,continuation_plan_id TEXT,state TEXT);
 CREATE TABLE unrelated(value TEXT); INSERT INTO unrelated VALUES ('original business data');
`);
function fixture(id: string, codes = ["exit_code"], mismatch = false): void {
 db.prepare("INSERT INTO tasks VALUES (?, 'auto')").run(id);
 db.prepare("INSERT INTO works VALUES (?,'active',NULL,NULL,'bot',1,1,'snapshot')").run(id);
 db.prepare("INSERT INTO work_execution_bindings VALUES (?,?,?,'conversation',1,1,'bot','failed',NULL,NULL,'snapshot','[]')").run(id,id,id);
 db.prepare("INSERT INTO work_action_admissions VALUES (?,?,?,?,'unknown',1,1,NULL)").run(id,id,id, "tool:conversation:native:call");
 db.prepare("INSERT INTO work_blockers VALUES (?,?,'external_effect',?,'open','original reason','{\"original\":true}',5,NULL,1)").run(id,id,id);
 db.prepare("INSERT INTO work_automatic_recovery VALUES (?,?,?,'readback',10)").run(id, `automatic-recovery:${id}`, id);
 db.prepare("INSERT INTO work_continuation_plans VALUES (?,?,?,'original readback reason','pending',1,'bot',1,'snapshot')").run(`automatic-recovery:${id}`,id,id);
 const executionId = `durable:${id}:conversation:${mismatch ? "other" : "native"}`;
 const attemptId = `attempt-durable-${createHash("sha256").update(JSON.stringify([id,executionId,"message","call"])).digest("hex")}`;
 const record = {id:attemptId, taskId:id,executionId,assistantMessageId:"message",toolCallId:"call",target:"shell",status:"failed",phase:"finished",startedAt:1,verifierId:"durable-tool",verifierVersion:1,
 verification:{attemptId,taskId:id,executionId,assistantMessageId:"message",target:"shell",status:"failed",verifierId:"durable-tool",verifierVersion:1,checkedAt:9,observed:{diagnosticCodes:codes}}};
 db.prepare("INSERT INTO execution_attempts VALUES (?,?,?,?,?,?,'failed',?,9)").run(attemptId,id,executionId,"message","call","shell",JSON.stringify(record));
}
fixture("normal");fixture("unknown",["interrupted"]);fixture("mismatch",["exit_code"],true);
fixture("bad-proof");
db.exec(`UPDATE execution_attempts SET record_json=json_set(record_json,'$.verification.taskId','different-task') WHERE task_id='bad-proof'`);
fixture("metadata",[]);
db.exec(`UPDATE execution_attempts SET record_json=json_set(record_json,'$.verification.observed.completedResponse',json('true'),'$.verification.observed.notStarted',json('false')) WHERE task_id='metadata'`);
fixture("readonly"); db.exec("UPDATE tasks SET permission_mode='readonly' WHERE id='readonly'");
fixture("denied"); db.exec("INSERT INTO work_dispatch_requests VALUES ('prepared','automatic-recovery:denied','blocked')");
fixture("settled"); db.exec("UPDATE work_continuation_plans SET state='settled' WHERE work_id='settled'");
fixture("cancelled");db.exec("UPDATE works SET cancel_requested_at=7 WHERE work_id='cancelled'");
fixture("repeated");db.exec("INSERT INTO work_execution_bindings SELECT 'prior',work_id,'prior','conversation',1,1,'bot','failed',NULL,NULL,'snapshot','[]' FROM work_execution_bindings WHERE binding_id='repeated'; INSERT INTO work_automatic_recovery VALUES ('prior','prior','repeated','exhausted',1)");
fixture("scope");db.exec(`UPDATE work_execution_bindings SET delegated_scope_json='["workspace:read"]' WHERE binding_id='scope'`);
db.exec("INSERT INTO work_blockers VALUES ('permission','unknown','operational',NULL,'open','permission denied','{}',5,NULL,1)");
db.exec("INSERT INTO work_action_admissions VALUES ('orphan','unknown','unknown','other','admitted',1,1,NULL)");
db.exec("INSERT INTO work_execution_bindings VALUES ('active','normal','active','conversation',1,1,'bot','running',NULL,NULL,'snapshot','[]'); INSERT INTO work_action_admissions VALUES ('active','normal','active','other','admitted',1,1,NULL)");
db.exec("INSERT INTO work_execution_bindings VALUES ('unreadable','normal','unreadable','conversation',1,1,'bot','unknown',NULL,NULL,'snapshot','[]'); INSERT INTO work_action_admissions VALUES ('unreadable','normal','unreadable','other','admitted',1,1,NULL)");
// Use the production journal triggers, not a substitute trigger in the fixture.
db.exec(`ALTER TABLE works ADD COLUMN state_version INTEGER NOT NULL DEFAULT 7;
 ALTER TABLE works ADD COLUMN updated_at INTEGER NOT NULL DEFAULT 1;
 ALTER TABLE works ADD COLUMN user_id TEXT NOT NULL DEFAULT 'user';
 ALTER TABLE work_dispatch_requests ADD COLUMN work_id TEXT;
 ALTER TABLE work_dispatch_requests ADD COLUMN intent_revision INTEGER;
 ALTER TABLE work_dispatch_requests ADD COLUMN input_snapshot_id TEXT;
 CREATE TABLE work_notifications(work_id TEXT);
 INSERT INTO works VALUES ('untouched','active',NULL,NULL,'bot',1,1,'snapshot',7,1,'user');
 UPDATE works SET lifecycle='closing',pending_conclusion='cancelled' WHERE work_id='cancelled';`);
ensureBotWorkPhase2Tables(db);
const rawAttempts = db.prepare("SELECT * FROM execution_attempts ORDER BY id").all();
const rawBindings = db.prepare("SELECT * FROM work_execution_bindings ORDER BY binding_id").all();
const report = db.transaction(() => retireWorkEffectBlockers(db,100))();
assert.equal((db.prepare("SELECT count(*) AS n FROM work_projection_events").get() as any).n,11);
assert.equal((db.prepare("SELECT sequence FROM work_projection_streams WHERE user_id='user'").get() as any).sequence,11);
for (const row of db.prepare("SELECT * FROM works").all() as any[]) {
 assert.equal(row.state_version,row.work_id === 'untouched' ? 7 : 8);
 assert.equal(row.updated_at,row.work_id === 'untouched' ? 1 : 100);
}
const closing = db.prepare("SELECT * FROM works WHERE work_id='cancelled'").get() as any;
assert.equal(closing.lifecycle,'closing');
assert.equal(closing.pending_conclusion,'cancelled');
assert.equal(report.clearedBlockers,11);
assert.equal(report.consumedAdmissions,8);
assert.equal(report.unknownAdmissions,1);
assert.equal(report.promotedPlans,4); // Continuation is allowed independently of verification; it never replays unknown actions.
const get = (table:string,id:string,key:string) => db.prepare(`SELECT * FROM ${table} WHERE ${key}=?`).get(id) as any;
assert.equal(get("work_action_admissions","normal","admission_id").state,"consumed");
assert.equal(get("work_action_admissions","orphan","admission_id").state,"unknown");
assert.equal(get("work_action_admissions","active","admission_id").state,"admitted");
assert.equal(get("work_action_admissions","unreadable","admission_id").state,"admitted");
for(const id of ["unknown","mismatch","bad-proof"]) assert.equal(get("work_action_admissions",id,"admission_id").state,"unknown");
assert.equal(get("work_blockers","permission","blocker_id").status,"open");
for(const id of ["readonly","denied","settled","cancelled","repeated","scope","unknown"])
 assert.equal(get("work_automatic_recovery",id,"source_binding_id").mode,"readback",id);
const blocker = get("work_blockers","normal","blocker_id");
assert.equal(blocker.reason,"original reason");assert.equal(blocker.unknown_external_effect_ref,"normal");
assert.deepEqual(JSON.parse(blocker.details_json),{original:true,effectDisposition:"continue_without_replay",effectRetirement:{migration:"work-effect-retirement-v1",businessOutcome:"failed"}});
assert.equal(blocker.waiting_for_user_input,0);
assert.equal(get("work_blockers","permission","blocker_id").waiting_for_user_input,1);
assert.equal(JSON.parse(get("work_blockers","unknown","blocker_id").details_json).effectRetirement.businessOutcome,"unverified");
const originalBlocker = JSON.parse((db.prepare("SELECT provenance_json FROM work_effect_retirement_audit WHERE entity_type='blocker' AND entity_id='normal'").get() as any).provenance_json).original;
assert.equal(originalBlocker.waiting_for_user_input,1);
assert.equal(originalBlocker.reason,"original reason");
assert.equal(originalBlocker.status,"open");
assert.deepEqual(db.prepare("SELECT * FROM execution_attempts ORDER BY id").all(),rawAttempts);
assert.deepEqual(db.prepare("SELECT * FROM work_execution_bindings ORDER BY binding_id").all(),rawBindings);
assert.equal((db.prepare("SELECT value FROM unrelated").get() as any).value,"original business data");
const dump = () => (db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {name:string}[]).map(({name})=>[name,db.prepare(`SELECT * FROM ${name}`).all()]);
const before = dump();
assert.deepEqual(retireWorkEffectBlockers(db,200),{clearedBlockers:0,consumedAdmissions:0,promotedPlans:0,unknownAdmissions:0});
assert.deepEqual(dump(),before);
assert.equal(db.pragma("user_version",{simple:true}),0);
db.close();
console.log("PASS work effect retirement: preservation, exact identity, genuine unknown, permissions, recovery scope and idempotence");
