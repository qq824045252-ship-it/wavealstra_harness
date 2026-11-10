const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
exports.run=async({send,foregroundDone,until,evaluate,history,rpc,report,out,home,agentDir,modelKey,botId})=>{
 const workspace=path.join(home,'team-watch-goal-source');fs.mkdirSync(workspace);
 const seed=crypto.randomBytes(6).toString('hex'),files=[path.join(workspace,'build-status.txt'),path.join(workspace,'test-status.txt')];
 const waiting='WAITING_'+seed,ready='READY_'+seed;for(const file of files)fs.writeFileSync(file,waiting+'\n');
 const settings=(await evaluate(`window.api.botWork.getSettings('${botId}')`)).settings;
 assert((await evaluate(`window.api.botWork.saveSettings(${JSON.stringify({botId,expectedRevision:settings.revision,workspacePath:workspace,modelId:modelKey,expertId:'',skillIds:[],mcpIds:[],connectorIds:[]})})`)).ok);
 const members=[];
 for(const [index,label] of ['构建状态观察员','测试状态观察员'].entries()){
  const created=await evaluate(`window.api.botWork.createBot(${JSON.stringify({requestId:crypto.randomUUID(),displayName:label,responsibilitySummary:'每轮真实读取指定状态文件并逐字报告'})})`);assert(created.ok);
  const memberId=created.bot.botId;
  members.push({botId:memberId,responsibility:`本轮用真实read读取 ${files[index]}，逐字报告完整原文；不写文件不联网，不等待下轮，不调用完成确认工具。`,delegatedScope:['workspace:read']});
 }
 assert((await evaluate(`window.api.botWork.teamControl(${JSON.stringify({kind:'save_template',request:{operationId:'team-watch-goal-template',name:'发布准备观察团队',plan:{workspacePath:workspace,ownerBotId:botId,ownerResponsibility:'汇总两名观察员当前这一轮的真实完整原文，明确构建和测试是否同时就绪，不复用旧轮结果；本轮结束后由前台判断长期委托是否结束，不向用户请求确认。',executionPolicy:'parallel',maxConcurrency:2,members}}})})`)).ok);
 await send(`用已保存“发布准备观察团队”持续检查发布准备情况：每分钟UTC整点（cron * * * * *），现在也检查一次。两位成员分别真实读取 ${files[0]} 和 ${files[1]}，每轮负责人汇总两个文件完整原文并回到本对话。只有同一轮两个文件都等于 ${ready} 时，才代表发布准备全部就绪，达成后主动结束持续委托并汇报，无须我再确认；任何一个仍为 WAITING 或读取失败就继续观察。不要联网，不写文件，不要创建额外定时任务。`);
 await foregroundDone();
 const all=await evaluate('window.api.botWork.listWorks(true)');assert.equal(all.length,1);const id=all[0].workId;
 const detail=()=>evaluate(`window.api.botWork.getWork(${JSON.stringify(id)})`);
 let work=await detail();assert.equal(work.mode,'watch');assert(work.team);assert.equal(work.team.members.length,2);assert.equal(work.phase4.subscriptions.find(s=>s.source==='cron'&&s.status!=='stopped')?.cronExpression,'* * * * *');
 await until(async()=>{const h=await history();report.history=h;return h.messages.some(m=>m.workFeedback?.kind==='result'&&m.workFeedback?.category==='result'&&m.text.includes(waiting));},'both WAITING team round returns through foreground');
 work=await detail();assert.equal(work.lifecycle,'active','unsatisfied team goal must keep watching');report.notMetWork=work;
 const originalCount=work.executions.length;
 for(const file of files)fs.writeFileSync(file,ready+'\n');
 await until(async()=>{work=await detail();report.latestWork=work;return work.lifecycle==='closed';},'both current member reads READY automatically settle watch goal');
 assert.equal(work.closureConclusion,'succeeded','goal completion, not expiry/cancel/failure');assert.equal(work.watchPlan?.termination,undefined,'not a time-expiry shortcut');
 assert(work.executions.length>=originalCount+3,'new round includes two members and owner');
 await until(async()=>{const h=await history();report.history=h;return h.messages.some(m=>m.workFeedback?.kind==='result'&&m.workFeedback?.category==='result'&&m.text.includes(ready)&&m.workFeedback.eventId?.startsWith('watch-supervision:'));},'actual READY result visible via foreground supervision');
 const Database=require('better-sqlite3'),db=new Database(path.join(agentDir||path.join(home,'.mybuddy'),'app.db'),{readonly:true});
 try{
  assert.equal(db.prepare("SELECT COUNT(*) n FROM conversation_interactions WHERE status='pending'").get().n,0,'no human confirmation required');
  const goalReviews=db.prepare("SELECT r.context_json,r.decision_json,r.state FROM work_watch_reviews r JOIN work_execution_bindings b ON b.binding_id=r.binding_id WHERE b.work_id=? AND json_extract(r.decision_json,'$.stopAssessment.status')='met'").all(id);
  assert(goalReviews.length>=1,'real frontend model submits met assessment');
  const finalReview=goalReviews.at(-1),context=JSON.parse(finalReview.context_json),decision=JSON.parse(finalReview.decision_json);
  assert(context.verifiedObservations.length>=2,'both members contribute raw source evidence');
  for(const file of files)assert(context.verifiedObservations.some(e=>e.source===file&&e.text.includes(ready)),'raw READY evidence from '+path.basename(file));
  assert(decision.stopAssessment.evidence.length>=2,'frontend cites both observed facts');
  report.finalGoalReview={state:finalReview.state,decision,verifiedObservations:context.verifiedObservations};
 }finally{db.close();}
 const count=work.executions.length;await new Promise(r=>setTimeout(r,65000));assert.equal((await detail()).executions.length,count,'65 seconds after goal completion no new round');
 report.finalWork=await detail();report.history=await history();
 for(const width of [1280,390]){await rpc('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await new Promise(r=>setTimeout(r,200));assert(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'));const shot=await rpc('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'team-watch-goal-'+width+'.png'),Buffer.from(shot.data,'base64'));}
 report.checks.push('real two-member team watch: WAITING remains active; next same-round source reads both READY; owner and frontend report correct sources; semantic succeeded with no pending interaction; 65s no later dispatch; desktop/mobile no horizontal overflow');
};
