const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
exports.run=async({send,foregroundDone,until,evaluate,history,rpc,report,out,home,modelKey,botId})=>{
 const workspace=path.join(home,'team-watch-source');fs.mkdirSync(workspace);
 const seed=crypto.randomBytes(6).toString('hex'),file=path.join(workspace,'progress.txt'),a='BASELINE_'+seed,b='CHANGED_'+seed;fs.writeFileSync(file,a+'\n');
 const settings=(await evaluate(`window.api.botWork.getSettings('${botId}')`)).settings;
 assert((await evaluate(`window.api.botWork.saveSettings(${JSON.stringify({botId,expectedRevision:settings.revision,workspacePath:workspace,modelId:modelKey,expertId:'',skillIds:[],mcpIds:[],connectorIds:[]})})`)).ok);
 const created=await evaluate(`window.api.botWork.createBot({requestId:crypto.randomUUID(),displayName:'变化观察员',responsibilitySummary:'每轮读取指定文件并逐字报告'})`);assert(created.ok);
 const memberId=created.bot.botId;
 assert((await evaluate(`window.api.botWork.teamControl(${JSON.stringify({kind:'save_template',request:{operationId:'team-changes-template',name:'变化观察团队',plan:{workspacePath:workspace,ownerBotId:botId,ownerResponsibility:'核对观察员本轮真实read原文，完整报告本轮观察，不重复旧结果，不提前结束长期委托。',executionPolicy:'parallel',maxConcurrency:2,members:[{botId:memberId,responsibility:`本轮用真实read读取 ${file}，逐字报告完整原文；文件缺失必须如实报告读取错误，不可以推测旧内容，不写文件不联网。`,delegatedScope:['workspace:read']}]}}})})`)).ok);
 await send(`用已保存“变化观察团队”执行持续追踪。持续每分钟整点UTC（cron * * * * *）观察 ${file}，现在不要提前检查。每轮成员真实read读取，负责人汇总本轮原文。首轮仅建立基线不通知，之后只有内容变化才通知一次，未变化必须静默（notificationMode=changes_only）。读取失败或文件缺失必须如实通知，不可视为无变化。不要联网不要写文件，不要第一轮就结束，持续直到我暂停或取消。`);await foregroundDone();
 const rows=await evaluate('window.api.botWork.listWorks(true)');assert.equal(rows.length,1);const id=rows[0].workId;
 const detail=()=>evaluate(`window.api.botWork.getWork(${JSON.stringify(id)})`);
 let work=await detail();report.admitted=work;assert.equal(work.mode,'watch');assert.equal(work.phase4.subscriptions.find(s=>s.source==='cron'&&s.status!=='stopped')?.cronExpression,'* * * * *');
 const reviewState=()=>JSON.parse(require('node:child_process').execFileSync('python3',['-c',`import sqlite3,json,sys
c=sqlite3.connect('file:'+sys.argv[1]+'?mode=ro',uri=True)
c.row_factory=sqlite3.Row
print(json.dumps([dict(r) for r in c.execute('SELECT r.* FROM work_watch_reviews r JOIN work_execution_bindings b ON b.binding_id=r.binding_id WHERE b.work_id=? ORDER BY r.reviewed_at', (sys.argv[2],))]))`,path.join(home,'.mybuddy/app.db'),id],{encoding:'utf8'}));
 const resultMessages=h=>h.messages.filter(m=>m.workFeedback?.kind==='result'&&m.workFeedback?.category==='result');
 report.rounds=[];
 const round=async(n,count,expected)=>{
  await until(async()=>{work=await detail();report.latestWork=work;return work.executions.filter(e=>e.status==='completed').length>=n*2;},'team member and owner complete round '+n);
  await until(async()=>{report.reviews=reviewState();return report.reviews.filter(r=>['silent','delivered'].includes(r.state)).length>=n;},'frontend supervision settled round '+n);
  const h=await history();report.history=h;const results=resultMessages(h);report.rounds.push({n,at:Date.now(),results,work:await detail()});
  assert.equal(results.length,count,'owner-only frontend result count after round '+n);
  if(expected)assert(results.at(-1).text.includes(expected));
 };
 await round(1,0);await round(2,0);fs.writeFileSync(file,b+'\n');
 await until(async()=>resultMessages(await history()).some(m=>m.text.includes(b)),'changed member observation delivered');
 let settled=reviewState().filter(r=>['silent','delivered'].includes(r.state)).length;
 await round(settled,1,b);await round(settled+1,1,b);
 await send(`暂停 ${id}，不要取消，不要再检查。`);await foregroundDone();work=await detail();assert.equal(work.lifecycle,'paused');const pausedCount=work.executions.length;
 await new Promise(r=>setTimeout(r,65000));assert.equal((await detail()).executions.length,pausedCount,'paused real clock produces no dispatch');
 await send(`恢复 ${id}，继续原来的每分钟UTC计划和仅变化通知，不立即执行。`);await foregroundDone();assert.equal((await detail()).lifecycle,'active');
 settled=reviewState().filter(r=>['silent','delivered'].includes(r.state)).length;await round(settled+1,1,b);
 fs.renameSync(file,file+'.saved');
 await until(async()=>{const h=await history();report.history=h;return resultMessages(h).length>1;},'missing source yields visible error instead of silence');
 const results=resultMessages(report.history);assert.equal(results.length,2,'one change notification plus one missing-source error');assert.match(results.at(-1).text,/不存在|缺失|失败|无法|ENOENT|找不到|未能/);report.missingSource=await detail();
 await send(`暂停 ${id}，不再检查。`);await foregroundDone();assert.equal((await detail()).lifecycle,'paused');
 report.finalWork=await detail();report.history=await history();
 for(const width of [1280,390]){await rpc('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await new Promise(r=>setTimeout(r,200));assert(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'));const shot=await rpc('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'team-watch-changes-'+width+'.png'),Buffer.from(shot.data,'base64'));}
 report.checks.push('real team member+owner rounds: baseline silent, unchanged silent, member source changed exactly one owner frontend report, next unchanged silent, pause65s no dispatch, resume unchanged silent, missing-source error visible');
};
