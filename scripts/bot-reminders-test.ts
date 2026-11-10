import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
 } finally {cron.stop();db.close();rmSync(root,{recursive:true,force:true});}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
