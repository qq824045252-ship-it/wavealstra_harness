import {createHash} from "node:crypto";
import {execFileSync} from "node:child_process";
import {REMINDER_RESULT_LIMITS,verifyReminderSnapshot,verifyReminderSnapshots} from "../src/main/cron/CronReminderResults";
import {CronReminderDelivery} from "../src/main/cron/CronReminderDelivery";
import assert from "node:assert/strict";
import { closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, renameSync, rmSync, writeFileSync, symlinkSync, truncateSync } from "node:fs";
import { hashWindowsSnapshot } from "../src/main/platform/windows-snapshot";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ToolExecutionApi } from "@earendil-works/pi-durable";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { CronService, type CronAgent } from "../src/main/cron/CronService";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { BotConversationRepository } from "../src/main/agent/work/BotConversationRepository";
import { botReminderTool, reminderSchedule } from "../src/main/agent/work/BotReminderTools";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { DEFAULT_BOT_ID, LOCAL_USER_ID } from "../src/shared/bot-work";
import type { ReminderDelivery } from "../src/main/cron/CronReminderDelivery";

async function main() {
 const root = mkdtempSync(join(tmpdir(), "bot-reminders-"));
 const db = new AppDatabase(join(root,"app.db"));
 const bots = new BotRegistry(db.connection);
 bots.registerBot({ userId:LOCAL_USER_ID,botId:DEFAULT_BOT_ID,displayName:"提醒测试",authorization:DESKTOP_USER_GRANTS });
 const works = new WorkService(db.connection,{bots});
 const messages = new BotConversationRepository(db.connection);
 const receipt = messages.accept(LOCAL_USER_ID,{botId:DEFAULT_BOT_ID,requestId:"r1",text:"提醒我喝水"});
 let calls = 0; const delivered: ReminderDelivery[] = [];
 const agent: CronAgent = { prompt:async()=>{calls++;throw Error("reminders must never call models");},waitForSubmission:async()=>{throw Error("no");},
 loadTaskHistory:async()=>({messages:[]}),isTaskBusy:()=>true,getAppSettings:()=>({}),resolveAvailableModelId:async()=>undefined,listSkills:()=>[],listConnectors:()=>[] };
 let cron = new CronService(db,agent,undefined,undefined,value=>delivered.push(value));
 const tool=botReminderTool({db:db.connection,userId:LOCAL_USER_ID,botId:DEFAULT_BOT_ID,conversationId:receipt.conversationId,
 bots,messages,works,reminders:()=>cron,isAuthority:()=>true,memorySearch:()=>[],schedule:()=>{throw Error("no Work");},wake:()=>{}});
 let serial=0;
 const invoke=async(args:unknown,key?:string)=>{
 const api={taskId:key??`call-${++serial}`,callId:`call-${serial}`,memo:async()=>receipt.requestId} as unknown as ToolExecutionApi;
 const result=await tool.execute(args as never,api,BACKGROUND_CONTEXT);
 const output=result.output?.find(block=>block.type==='text');assert(output?.type==='text'); return JSON.parse(output.text);
 };
 const wait=async(check:()=>boolean)=>{for(let i=0;i<200&&!check();i++)await delay(10);assert(check());};
 try {
  assert.equal(reminderSchedule({kind:'after',seconds:120},100000).scheduleExpr,new Date(220000).toISOString());
  const scheduled=await invoke({action:'create',title:'喝水',content:'该喝水了',schedule:{kind:'after',seconds:1}},'stable');
  const id=scheduled.reminder.reminderId;
  assert.equal((await invoke({action:'create',title:'喝水',content:'该喝水了',schedule:{kind:'after',seconds:1}},'stable')).reminder.reminderId,id);
  assert.equal(cron.list().length,1);
  cron.start(); await wait(()=>delivered.length===1);
  assert.equal(calls,0);assert.equal(db.listTasks().length,0);assert.equal(cron.list()[0].enabled,false);
  assert.equal(messages.history(LOCAL_USER_ID,{botId:DEFAULT_BOT_ID,conversationId:receipt.conversationId}).messages.filter(m=>m.text.includes('⏰')).length,1);
  console.log('PASS relative time, idempotency, busy chat independence, no model/task, direct Bot delivery');
  const second=await invoke({action:'create',title:'取消',content:'do not send',schedule:{kind:'after',seconds:60}});
  await invoke({action:'cancel',reminderId:second.reminder.reminderId});assert.equal(cron.list().find(j=>j.id===second.reminder.reminderId)!.enabled,false);
  await invoke({action:'snooze',reminderId:id,snoozeSeconds:2}); await wait(()=>delivered.length===2);
  assert.equal(new Set(delivered.map(v=>v.deliveryId)).size,2);
  console.log('PASS cancel and snooze same reminder');
  cron.stop();
  const late=cron.upsert({...cron.list()[0],id:'late',name:'离线提醒',prompt:'恢复补发',scheduleExpr:new Date(Date.now()-60000).toISOString(),enabled:true});
  const repeat=cron.upsert({...late,id:'repeat',scheduleType:'every',scheduleExpr:'60s',createdAt:Date.now()-3600000});
  db.connection.prepare('UPDATE cron_reminder_state SET next_due_at=? WHERE job_id=?').run(Date.now()-300000,repeat.id);
  cron=new CronService(db,agent,undefined,undefined,value=>delivered.push(value));cron.start();
  await wait(()=>delivered.length===4);
  assert(delivered.find(v=>v.jobId==='late')!.body.includes('原定'));
  assert(delivered.find(v=>v.jobId==='repeat')!.body.includes('合并'));
  assert(cron.list().find(j=>j.id==='repeat')!.nextRunAt!>Date.now());
  cron.stop();cron=new CronService(db,agent,undefined,undefined,value=>delivered.push(value));cron.start();await delay(20);assert.equal(delivered.length,4);
  console.log('PASS normal restart, one-time catchup, repeat catchup collapsed, no duplicate');
  const beforePreview = cron.list().find(j=>j.id==='repeat')!.nextRunAt;
  await cron.runNow('repeat'); await wait(()=>delivered.length===5);
  assert.equal(cron.list().find(j=>j.id==='repeat')!.nextRunAt,beforePreview);
  assert(delivered.at(-1)!.body.startsWith('测试提醒：'));
  const nextSnooze=Date.now()+100;
  cron.snoozeReminder('repeat',nextSnooze);
  assert.equal(cron.list().find(j=>j.id==='repeat')!.scheduleType,'every');
  await wait(()=>delivered.length===6);
  assert(cron.list().find(j=>j.id==='repeat')!.nextRunAt!>Date.now());
  console.log('PASS early manual preview does not consume occurrence; repeat snooze keeps original recurrence');

  cron.setEnabled('repeat',false);
  cron.upsert({...cron.list().find(j=>j.id==='repeat')!,scheduleExpr:'120s',name:'暂停后编辑'});
  cron.setEnabled('repeat',true);
  assert(cron.list().find(j=>j.id==='repeat')!.nextRunAt!>Date.now());
  const preserved=Date.now()+30000;
  cron.snoozeReminder('repeat',preserved);
  cron.upsert({...cron.list().find(j=>j.id==='repeat')!,name:'只改名称'});
  assert.equal(cron.list().find(j=>j.id==='repeat')!.nextRunAt,preserved);
  cron.setEnabled('repeat',false);
  await cron.runNow('repeat'); await wait(()=>delivered.length===7);
  assert.equal(cron.list().find(j=>j.id==='repeat')!.enabled,false);
  assert.equal(cron.list().find(j=>j.id===id)!.reminder!.state,'delivered');
  assert.equal(cron.list().find(j=>j.id===second.reminder.reminderId)!.reminder!.state,'cancelled');
  console.log('PASS paused edits resume; title edit preserves snooze; paused preview; delivered/cancelled states');

  await assert.rejects(()=>invoke({action:'cancel',reminderId:'foreign'}));
  const changed=await invoke({action:'update',reminderId:id,schedule:{kind:'at',iso:new Date(Date.now()+60000).toISOString()},content:'新内容'});
  assert.equal(changed.reminder.content,'新内容');assert.equal(cron.list().find(j=>j.id===id)!.reminder!.botId,DEFAULT_BOT_ID);
  assert.equal(calls,0);console.log('PASS scope and reschedule');
  cron.stop();
  const created=works.createWork({kind:'user',userId:LOCAL_USER_ID,grants:DESKTOP_USER_GRANTS},
    {operationId:'reminder-result-work',title:'silent benchmark',conversationId:receipt.conversationId,authorization:DESKTOP_USER_GRANTS});
  assert(created.ok);const w=created.work;
  db.connection.prepare("UPDATE work_conversations SET channel_type='bot-delivery' WHERE work_id=?").run(w.workId);
  const associated=await invoke({action:'create',title:'看成果',content:'看benchmark',schedule:{kind:'after',seconds:60},result:{workId:w.workId}});
  const resultJobId=associated.reminder.reminderId;
  await invoke({action:'update',reminderId:resultJobId,schedule:{kind:'after',seconds:120}});
  const resultJob=()=>cron.list().find(j=>j.id===resultJobId)!;
  assert.equal(resultJob().reminder!.result!.workId,w.workId,'reschedule preserves association');
  const host=new CronReminderDelivery(db);
  assert.match(host.deliver(resultJob(),Date.now(),Date.now(),true).body,/尚无当前可投递/);
  await assert.rejects(()=>invoke({action:'update',reminderId:resultJobId,result:{workId:'foreign-work'}}),/必须属于/);
  const sourcePath=join(root,'benchmark.json');
  const publish=(version:number)=>{
    const snapshot=join(root,`benchmark-v${version}.json`),bytes=JSON.stringify({version});writeFileSync(snapshot,bytes);
    const binding=`result-binding-${version}`;
    db.connection.prepare(`INSERT INTO work_execution_bindings(binding_id,work_id,operation_id,bot_id,task_id,durable_store_key,conversation_id,
      intent_revision,owner_epoch,input_snapshot_id,expert_snapshot_json,workspace_binding,status,admitted_at,settled_at)
      VALUES (?,?,?,?,?,?,?, ?,?,?,'{}',?,'completed',?,?)`).run(binding,w.workId,binding,w.ownerBotId,binding,binding,binding,w.intentRevision,w.ownerEpoch,w.inputSnapshotId,root,version,version);
    const artifact={path:sourcePath,snapshotPath:snapshot,digest:createHash('sha256').update(bytes).digest('hex'),sizeBytes:Buffer.byteLength(bytes),registeredAt:version,sourceEntryId:version};
    db.connection.prepare('INSERT INTO work_generated_artifacts VALUES (?,?,?,?)').run(binding,sourcePath,artifact.digest,JSON.stringify(artifact));
    db.connection.prepare(`INSERT INTO work_deliverables(deliverable_id,work_id,producer_bot_id,execution_id,intent_revision,owner_epoch,input_snapshot_id,status,summary,artifact_refs_json,created_at)
      VALUES (?,?,?,?,?,?,?,'proposed',?,?,?)`).run(binding,w.workId,w.ownerBotId,binding,w.intentRevision,w.ownerEpoch,w.inputSnapshotId,`silent ${version}`,JSON.stringify([sourcePath]),version);
    return snapshot;
  };
  publish(1);const newest=publish(2);
  // Two snapshots from this same current binding, oldest ref listed first.
  const oldSnapshot=join(root,'same-binding-old.json'),oldBytes='old';writeFileSync(oldSnapshot,oldBytes);
  const oldDigest=createHash('sha256').update(oldBytes).digest('hex');
  db.connection.prepare('INSERT INTO work_generated_artifacts VALUES (?,?,?,?)').run('result-binding-2',sourcePath,oldDigest,
    JSON.stringify({path:sourcePath,snapshotPath:oldSnapshot,digest:oldDigest,sizeBytes:3,registeredAt:1,sourceEntryId:1}));
  db.connection.prepare('UPDATE work_deliverables SET artifact_refs_json=? WHERE execution_id=?').run(JSON.stringify([oldSnapshot,newest]),'result-binding-2');
  for(const [fileRefs,expected] of [[undefined,newest],[[newest],newest],[[oldSnapshot],oldSnapshot],[[sourcePath],newest]] as const) {
    await invoke({action:'update',reminderId:resultJobId,result:{workId:w.workId,...(fileRefs?{fileRefs}: {})}});
    const versioned=host.deliver(resultJob(),Date.now(),Date.now(),true);
    assert.equal(versioned.event.message.workFeedback!.report!.files![0].openPath,expected,'exact snapshot selection precedes per-path deduplication');
  }
  db.connection.prepare('UPDATE work_deliverables SET artifact_refs_json=? WHERE execution_id=?').run(JSON.stringify([sourcePath]),'result-binding-2');
  await invoke({action:'update',reminderId:resultJobId,result:{workId:w.workId}});
  console.log('PASS same binding dual versions: newest default, explicit new/old snapshot and raw path');
  for (const [column,value] of [['intent_revision',w.intentRevision+1],['input_snapshot_id','different'],['owner_epoch',w.ownerEpoch+1]] as const) {
    const previous=(db.connection.prepare(`SELECT ${column} value FROM works WHERE work_id=?`).get(w.workId) as {value:unknown}).value;
    db.connection.prepare(`UPDATE works SET ${column}=? WHERE work_id=?`).run(value,w.workId);
    assert.match(host.deliver(resultJob(),Date.now(),Date.now(),true).body,/尚无当前可投递/);
    db.connection.prepare(`UPDATE works SET ${column}=? WHERE work_id=?`).run(previous,w.workId);
  }
  db.connection.prepare('UPDATE work_execution_bindings SET settled_at=NULL WHERE work_id=?').run(w.workId);
  assert.match(host.deliver(resultJob(),Date.now(),Date.now(),true).body,/尚无当前可投递/);
  db.connection.prepare('UPDATE work_execution_bindings SET settled_at=admitted_at WHERE work_id=?').run(w.workId);
  await invoke({action:'update',reminderId:resultJobId,result:{workId:w.workId,fileRefs:['/never/read/arbitrary/path']}});
  const unregistered=host.deliver(resultJob(),Date.now(),Date.now(),true);
  assert.equal(unregistered.event.message.workFeedback!.report!.files!.length,0);assert.match(unregistered.body,/指定文件/);
  await invoke({action:'update',reminderId:resultJobId,result:{workId:w.workId,fileRefs:[sourcePath]}});
  const beforeWorks=db.connection.prepare('SELECT count(*) n FROM works').get();
  const due=Date.now();const sent=host.deliver(resultJob(),due);
  assert.equal(sent.event.message.workFeedback!.report!.files![0].openPath,newest,'silent result uses latest current immutable snapshot');
  assert.equal(sent.event.message.conversationId,receipt.conversationId);
  assert.equal(sent.event.message.workFeedback!.report!.summary,`⏰ ${sent.body}`,'main report summary preserves reminder body');
  assert.equal(sent.event.message.workFeedback!.report!.title,resultJob().name);
  assert(sent.event.message.workFeedback!.report!.sourceNotices!.some(note=>note.includes('silent 2')));
  const lateResult=host.deliver(resultJob(),due+1,due+10000);
  assert.match(lateResult.event.message.workFeedback!.report!.summary,/看benchmark[\s\S]*已有成果[\s\S]*原定/);
  assert.equal(lateResult.event.message.workFeedback!.report!.completion,undefined,'reminder never declares goal completion');
  assert.deepEqual(host.deliver(resultJob(),due),JSON.parse(JSON.stringify(sent)),'same due time reuses frozen delivery');
  writeFileSync(newest,'tampered');
  const bad=host.deliver(resultJob(),due,Date.now(),true);
  assert.equal(bad.event.message.workFeedback!.report!.files!.length,0);assert.match(bad.body,/校验失败/);
  assert.deepEqual(host.deliver(resultJob(),due),JSON.parse(JSON.stringify(sent)),'replay does not resolve later mutations');
  // Descriptor verification stays bounded for huge/special files and repeated failures.
  const large=join(root,'large-snapshot');writeFileSync(large,'');truncateSync(large,REMINDER_RESULT_LIMITS.fileBytes+1);
  const ioBudget={bytes:REMINDER_RESULT_LIMITS.totalBytes as number};
  assert.equal(verifyReminderSnapshot(large,REMINDER_RESULT_LIMITS.fileBytes+1,'unused',ioBudget),'budget');
  assert.equal(ioBudget.bytes,REMINDER_RESULT_LIMITS.totalBytes);
  const valid=join(root,'valid-snapshot');writeFileSync(valid,'valid');const digest=createHash('sha256').update('valid').digest('hex');
  const beforeValid=ioBudget.bytes;
  assert.equal(verifyReminderSnapshot(valid,5,digest,ioBudget),'verified','real regular snapshot works on the current host');
  assert.equal(ioBudget.bytes,beforeValid-5);
  assert.equal(verifyReminderSnapshot(valid,5,'0'.repeat(64),ioBudget),'unreadable','corrupt snapshot consumes its actual read budget');
  assert.equal(ioBudget.bytes,beforeValid-10);
  assert.equal(verifyReminderSnapshot(root,0,createHash('sha256').digest('hex'),ioBudget),'unreadable','directory is never a snapshot');
  if(process.platform==='win32') {
    // Junction creation does not require Windows symbolic-link privileges. This
    // is a real reparse-point negative, not a skipped symlink assertion.
    const actual=join(root,'junction-target'),link=join(root,'junction-snapshot');mkdirSync(actual);writeFileSync(join(actual,'file'),'valid');
    symlinkSync(actual,link,'junction');
    assert.equal(verifyReminderSnapshot(join(link,'file'),5,digest,ioBudget),'unreadable','Windows junction ancestor is never followed');
    assert.equal(verifyReminderSnapshot(link,0,createHash('sha256').digest('hex'),ioBudget),'unreadable','final reparse point is rejected');
    const alternate=valid+':untrusted';writeFileSync(alternate,'valid');
    assert.equal(verifyReminderSnapshot(alternate,5,digest,ioBudget),'unreadable','real NTFS alternate stream is not a snapshot');
    assert.equal(verifyReminderSnapshot('\\\\.\\pipe\\mybuddy-reminder-test',0,createHash('sha256').digest('hex'),ioBudget),'unreadable','pipe namespace is rejected before opening');
    const writer=openSync(valid,'r+');
    try { assert.equal(verifyReminderSnapshot(valid,5,digest,ioBudget),'unreadable','native share-read handle excludes existing writers'); }
    finally { closeSync(writer); }
    assert.equal(verifyReminderSnapshot(valid,5,digest,ioBudget),'verified','same regular bytes remain readable after writer closes');
    const exchanged=join(root,'exchanged-snapshot');writeFileSync(exchanged,'valid');
    const beforeSwap=lstatSync(exchanged,{bigint:true});
    renameSync(exchanged,exchanged+'.old');writeFileSync(exchanged,'valid');
    const staleIdentity=hashWindowsSnapshot(exchanged,5,REMINDER_RESULT_LIMITS.chunkBytes,beforeSwap);
    assert.equal(staleIdentity.valid,false,'same bytes at a substituted inode cannot satisfy the pre-open identity');
    assert.equal(staleIdentity.bytesRead,0,'TOCTOU replacement is refused before content reads');
    console.log('PASS Windows native regular handle, real junction/reparse and ADS rejection, pipe namespace rejection and writer exclusion');
  } else {
    const link=join(root,'symlink-snapshot');symlinkSync(valid,link);
    assert.equal(verifyReminderSnapshot(link,5,digest,ioBudget),'unreadable','symlink never followed');
  }
  // mkfifo is a fixture only on hosts which provide it; assertions are not skipped on Linux.
  if(process.platform!=='win32') {
    const fifo=join(root,'fifo-snapshot');execFileSync('mkfifo',[fifo]);
    assert.equal(verifyReminderSnapshot(fifo,0,createHash('sha256').digest('hex'),ioBudget),'unreadable','FIFO open never blocks');
  }
  const full=join(root,'budget-snapshot'),fullBytes=Buffer.alloc(REMINDER_RESULT_LIMITS.fileBytes,1);
  writeFileSync(full,fullBytes);const fullDigest=createHash('sha256').update(fullBytes).digest('hex');
  const exhausted={bytes:REMINDER_RESULT_LIMITS.totalBytes as number};
  assert.deepEqual(verifyReminderSnapshots(Array.from({length:3},()=>({path:full,size:fullBytes.length,digest:fullDigest})),exhausted),['verified','verified','budget']);
  assert.equal(exhausted.bytes,0);
  const failedBudget={bytes:5};
  assert.deepEqual(verifyReminderSnapshots([{path:valid,size:5,digest:'0'.repeat(64)},{path:join(root,'missing-after-budget'),size:5,digest}],failedBudget),['unreadable','budget']);
  assert.equal(failedBudget.bytes,0,'a failed digest still exhausts the shared content budget');
  const many=Array.from({length:70},(_,i)=>join(root,`registered-${i}.json`));
  for(const [i,path] of many.entries()) db.connection.prepare('INSERT INTO work_generated_artifacts VALUES (?,?,?,?)')
    .run('result-binding-2',path,digest,JSON.stringify({path,snapshotPath:valid,digest,sizeBytes:5,registeredAt:i+10,sourceEntryId:i+10}));
  db.connection.prepare('UPDATE work_deliverables SET artifact_refs_json=? WHERE execution_id=?').run(JSON.stringify(many),'result-binding-2');
  await invoke({action:'update',reminderId:resultJobId,result:{workId:w.workId}});
  const childProcess:typeof import('node:child_process')=require('node:child_process');
  const originalExec=childProcess.execFileSync;let nativeReaders=0;
  Object.defineProperty(childProcess,'execFileSync',{value(file:string,args:string[],options:import('node:child_process').ExecFileSyncOptionsWithStringEncoding){
    if(options.env?.MYBUDDY_SNAPSHOT_READS) nativeReaders++;
    return originalExec(file,args,options);
  }});
  const capped=(()=>{try{return host.deliver(resultJob(),Date.now(),Date.now(),true);}finally{Object.defineProperty(childProcess,'execFileSync',{value:originalExec});}})();
  assert.equal(capped.event.message.workFeedback!.report!.files!.length,20);
  if(process.platform==='win32') assert.equal(nativeReaders,1,'actual 20-file reminder starts one native reader, not 20 compilers');
  assert.match(capped.body,/6 条引用未检查/);assert.match(capped.body,/44 个文件未检查/);
  db.connection.prepare('UPDATE work_deliverables SET artifact_refs_json=? WHERE execution_id=?').run(JSON.stringify([sourcePath]),'result-binding-2');
  console.log('PASS bounded chunk hashing, per-file/total bytes, reference/file caps and host-native special-file rejection');
  rmSync(newest);
  assert.match(host.deliver(resultJob(),due,Date.now(),true).body,/已删除/);
  db.connection.prepare('UPDATE works SET user_id=? WHERE work_id=?').run('other',w.workId);
  assert.match(host.deliver(resultJob(),due,Date.now(),true).body,/不可访问/);
  db.connection.prepare('UPDATE works SET user_id=? WHERE work_id=?').run(LOCAL_USER_ID,w.workId);
  db.connection.prepare("UPDATE work_conversations SET channel_type='desktop' WHERE work_id=?").run(w.workId);
  assert.match(host.deliver(resultJob(),due,Date.now(),true).body,/不可访问/);
  assert.deepEqual(db.connection.prepare('SELECT count(*) n FROM works').get(),beforeWorks);assert.equal(calls,0);
  await invoke({action:'update',reminderId:resultJobId,result:null});assert.equal(resultJob().reminder!.result,undefined);
  console.log('PASS existing silent result, latest immutable version, reschedule, unavailable, tamper, scope, replay and zero model/Work');

 } finally {cron.stop();db.close();rmSync(root,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
