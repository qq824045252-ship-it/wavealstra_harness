import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppDatabase } from '../src/main/db/AppDatabase';
import { BotRegistry } from '../src/main/agent/work/BotRegistry';
import { MemoryService } from '../src/main/memory/MemoryService';
import { WorkMemoryCapture } from '../src/main/memory/WorkMemoryCapture';
import { LOCAL_USER_ID } from '../src/shared/bot-work';
const dir = mkdtempSync(join(tmpdir(), 'work-memory-capture-'));
let db = new AppDatabase(join(dir, 'test.db'));
try {
  new BotRegistry(db.connection).registerBot({botId:'a',userId:LOCAL_USER_ID,displayName:'A'});
  db.connection.prepare(`INSERT INTO works(work_id,user_id,owner_bot_id,title,authorization_json,active_intent_snapshot_id,input_snapshot_id,created_by,mode,created_at,updated_at)
    VALUES('w',?,'a','Track releases','{}','intent','input','user','watch',1,1)`).run(LOCAL_USER_ID);
  db.connection.prepare(`INSERT INTO work_deliverables(deliverable_id,work_id,producer_bot_id,execution_id,intent_revision,owner_epoch,input_snapshot_id,status,summary,created_at)
    VALUES('d','w','a','e',1,1,'input','proposed','Release found, awaiting verification',1)`).run();
  let memory = new MemoryService(db,{semantic:false});
  let changes = 0;
  let bridge = new WorkMemoryCapture(db,memory,() => {
    assert(!db.connection.inTransaction,'UI notification must follow transaction commit');
    changes++;
  });
  const id = bridge.capture('w')!;
  assert(id); assert.equal(changes,1); assert.equal(bridge.capture('w'),id); assert.equal(changes,1,'unchanged capture must not notify');
  let record = memory.get(id)!;
  assert(record.content.includes('待核验成果')); assert(record.content.includes('单轮产出不代表结束'));
  assert.equal(record.scopes[0].scopeType,'work');
  db.connection.prepare("UPDATE work_deliverables SET status='accepted' WHERE deliverable_id='d'").run();
  bridge.capture('w'); assert.equal(changes,2,'fact change must notify once'); record=memory.get(id)!;
  assert(record.content.includes('已采纳（关联有效证据 0 条')); assert(!record.content.includes('待核验成果'));
  db.connection.prepare("UPDATE works SET progress_summary='password: do-not-copy-this' WHERE work_id='w'").run();
  bridge.capture('w'); assert(!memory.get(id)!.content.includes('do-not-copy-this'));
  db.connection.prepare(`INSERT INTO work_blockers(blocker_id,work_id,reason,kind,created_at) VALUES('b','w','Await source update','operational',1)`).run();
  bridge.capture('w'); assert(memory.get(id)!.content.includes('未决事项：Await source update'));
  db.connection.prepare("UPDATE work_blockers SET status='cleared' WHERE blocker_id='b'").run();
  bridge.capture('w'); assert(!memory.get(id)!.content.includes('Await source update'));
  memory.forget(id);
  const beforeSuppression=changes; assert.equal(bridge.capture('w'),undefined); assert.equal(changes,beforeSuppression,'suppression is not a visible memory edit');
  db.close(); db = new AppDatabase(join(dir,'test.db'));
  memory = new MemoryService(db,{semantic:false}); bridge = new WorkMemoryCapture(db,memory);
  assert.equal(bridge.capture('w'),undefined);
  db.connection.prepare("UPDATE works SET progress_summary='A genuinely new progress update' WHERE work_id='w'").run();
  assert.equal(bridge.capture('w'),undefined,'forgotten source must remain suppressed even when facts advance');
  assert.equal(memory.listExactScope('work','w').length,0);
  assert.equal(bridge.capture('missing'),undefined);
  db.connection.prepare(`INSERT INTO works(work_id,user_id,owner_bot_id,title,authorization_json,active_intent_snapshot_id,input_snapshot_id,created_by,created_at,updated_at)
    VALUES('redacted',?,'a','Packing checklist','{}','intent','input','user',1,1)`).run(LOCAL_USER_ID);
  db.connection.prepare(`INSERT INTO work_deliverables(deliverable_id,work_id,producer_bot_id,execution_id,intent_revision,owner_epoch,input_snapshot_id,status,summary,created_at)
    VALUES('redacted-d','redacted','a','e',1,1,'input','proposed','带好身份证或门禁卡、常用银行卡',1)`).run();
  const redacted=memory.get(bridge.capture('redacted')!)!;
  assert(redacted.content.includes('待核验成果（非已验证事实）'),'redaction must preserve real proposal status');
  assert(redacted.content.includes('未复制到记忆'));
  assert(!redacted.content.includes('银行卡'));
  for (const workId of ['corrected', 'unbound', 'long']) {
    db.connection.prepare(`INSERT INTO works(work_id,user_id,owner_bot_id,title,authorization_json,active_intent_snapshot_id,input_snapshot_id,created_by,created_at,updated_at)
      VALUES(?,?,'a',?,'{}','intent','input','user',1,1)`).run(workId,LOCAL_USER_ID,workId);
  }
  const correctedId=bridge.capture('corrected')!;
  memory.update({id:correctedId,content:'Owner correction must survive scans',changedBy:'user'});
  assert.equal(bridge.capture('corrected'),undefined);
  assert.equal(memory.get(correctedId)!.content,'Owner correction must survive scans');
  const unboundId=bridge.capture('unbound')!;
  db.connection.prepare("DELETE FROM memory_scopes WHERE memory_id=? AND scope_type='work'").run(unboundId);
  assert.equal(bridge.capture('unbound'),undefined);
  for(let i=0;i<10;i++) db.connection.prepare(`INSERT INTO work_blockers(blocker_id,work_id,reason,kind,created_at)
    VALUES(?,'long',?,'operational',1)`).run(`long-${i}`,'Pending detail '.repeat(150));
  const longId=bridge.capture('long')!;
  assert(memory.get(longId)!.content.length<=6000);
  assert.equal(bridge.capture('long'),longId,'normalization and truncation must not look like a manual edit');
  db.close(); db=new AppDatabase(join(dir,'test.db'));
  memory=new MemoryService(db,{semantic:false}); bridge=new WorkMemoryCapture(db,memory);
  db.connection.prepare("UPDATE works SET progress_summary='New facts after manual editing' WHERE work_id IN ('corrected','unbound')").run();
  assert.equal(bridge.capture('corrected'),undefined);
  assert.equal(bridge.capture('unbound'),undefined);
  assert.equal(memory.get(correctedId)!.content,'Owner correction must survive scans');
  assert.equal(memory.get(unboundId)!.scopes.length,0);
  for(const name of ['title-edited','status-edited','many-rounds']) db.connection.prepare(`INSERT INTO works(work_id,user_id,owner_bot_id,title,authorization_json,active_intent_snapshot_id,input_snapshot_id,created_by,mode,created_at,updated_at)
    VALUES(?,?,'a',?,'{}','intent','input','user','watch',1,1)`).run(name,LOCAL_USER_ID,name);
  for(const [workId,patch] of [['title-edited',{title:'User title'}],['status-edited',{status:'resolved' as const}]] as const) {
    const editedId=bridge.capture(workId)!;
    memory.update({id:editedId,...patch,changedBy:'user'});
    db.connection.prepare("UPDATE works SET progress_summary='New progress' WHERE work_id=?").run(workId);
    assert.equal(bridge.capture(workId),undefined,'title/status edit must stop capture');
    assert.equal((db.connection.prepare('SELECT suppressed FROM memory_capture_receipts WHERE memory_id=?').get(editedId) as {suppressed:number}).suppressed,1);
  }
  for(let i=1;i<=20;i++) {
    db.connection.prepare(`INSERT INTO work_deliverables(deliverable_id,work_id,producer_bot_id,execution_id,intent_revision,owner_epoch,input_snapshot_id,status,summary,created_at)
      VALUES(?,'many-rounds','a','e',1,1,'input','proposed',?,?)`).run('round-'+i,`Result round ${i}: `+'detail '.repeat(300),i);
    db.connection.prepare(`INSERT INTO work_blockers(blocker_id,work_id,reason,kind,created_at) VALUES(?,'many-rounds',?,'operational',?)`).run('pending-'+i,`Pending round ${i}: `+'detail '.repeat(300),i);
    const captured=bridge.capture('many-rounds')!;
    const text=memory.get(captured)!.content;
    assert(text.includes(`Result round ${i}:`),'newest result must survive bounded summaries');
    assert(text.includes(`Pending round ${i}:`)); assert(text.length<=6000);
  }
  const snapshot=memory.listExactScope('work','many-rounds')[0].content;
  assert(!snapshot.includes('Result round 1:'));
  assert(snapshot.includes('其余 14 条')); assert(snapshot.includes('Result round 20:'));
  assert.equal((db.connection.prepare("SELECT COUNT(*) n FROM work_deliverables WHERE work_id='many-rounds'").get() as {n:number}).n,20,'capture must never delete source history');
  console.log('WorkMemoryCapture passed: idempotence, proposal/acceptance distinction, watch persistence, sensitive exclusion, blocker refresh and restart-safe forget');
} finally { db.close(); rmSync(dir,{recursive:true,force:true}); }
