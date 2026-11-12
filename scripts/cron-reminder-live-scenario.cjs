const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
exports.run=async({evaluate,until,report,requests,agentDir,out,botId,rpc})=>{
 assert(/^bot-frontdoor-live-/.test(path.basename(path.dirname(agentDir))) && path.basename(agentDir)==='.mybuddy','fresh isolated frontdoor profile required');
 const db=new(require('better-sqlite3'))(path.join(agentDir,'app.db'),{fileMustExist:true});
 const now=Date.now(),conversationId='cron45-live-recovery';
 db.prepare('INSERT INTO bot_conversations(conversation_id,bot_id,user_id,created_at,updated_at) VALUES (?,?,?,?,?)').run(conversationId,botId,'user-local-primary',now,now);
 const job={id:'cron45-live-fault',name:'Cron45 恢复验收',prompt:'隔离测试提醒已恢复',scheduleType:'at',scheduleExpr:new Date(now+8000).toISOString(),timezone:'UTC',enabled:true,createdAt:now,updatedAt:now,reminder:{kind:'bot-reminder',userId:'user-local-primary',botId,conversationId,state:'scheduled'}};
 db.exec("CREATE TRIGGER cron45_live_fault BEFORE INSERT ON cron_reminder_delivery WHEN NEW.job_id='cron45-live-fault' BEGIN SELECT RAISE(ABORT,'isolated reminder failure'); END;");
 const beforeCalls=requests.length;
 try {
 await evaluate(`window.api.cron.upsert(${JSON.stringify(job)})`);
 await until(()=>!!db.prepare('SELECT * FROM cron_reminder_retries WHERE job_id=?').get(job.id),'real Electron records reminder retry',30000);
 const retry=db.prepare('SELECT * FROM cron_reminder_retries WHERE job_id=?').get(job.id);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM bot_messages WHERE conversation_id=?').get(conversationId).n,0);
 assert.equal((await evaluate('window.api.cron.list()')).find(j=>j.id===job.id).enabled,true);
 db.exec('DROP TRIGGER cron45_live_fault');
 await until(()=>db.prepare('SELECT COUNT(*) n FROM cron_reminder_delivery WHERE job_id=?').get(job.id).n===1,'real Electron retries original occurrence',30000);
 await until(async()=>(await evaluate('window.api.notification.list({limit:100})')).some(n=>n.sourceId===job.id&&n.type==='reminder.due'),'actual application notification sink',15000);
 const delivery=db.prepare('SELECT * FROM cron_reminder_delivery WHERE job_id=?').get(job.id);
 assert.equal(db.prepare('SELECT COUNT(*) n FROM bot_messages WHERE conversation_id=?').get(conversationId).n,1);
 assert.equal(requests.length,beforeCalls);
 assert.equal((await evaluate('window.api.cron.list()')).find(j=>j.id===job.id).reminder.state,'delivered');
 report.cron45={dueAt:Date.parse(job.scheduleExpr),retry,deliveryId:delivery.delivery_id,notificationAt:delivery.notification_at,modelCalls:requests.length-beforeCalls};
 report.checks.push('Real Electron scheduler: precommit SQLite trigger failure leaves zero messages; after fault removal original occurrence retries once through actual notification sink with zero model calls');
 report.limitations=['OS toast was not visually verified; notification sink/journal is not proof a system banner was visible. This run is not a process crash/restart test.'];
 fs.writeFileSync(path.join(out,'cron45-recovery.json'),JSON.stringify(report.cron45,null,2));
 }finally{db.exec('DROP TRIGGER IF EXISTS cron45_live_fault');db.close();}
};
