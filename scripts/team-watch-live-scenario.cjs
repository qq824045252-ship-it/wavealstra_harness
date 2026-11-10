const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
exports.run=async({send,foregroundDone,until,evaluate,history,rpc,report,out,home,modelKey,botId})=>{
 const rescheduleOnly=process.argv.includes('--team-watch-reschedule');
 const workspace=path.join(home,'team-watch-source');fs.mkdirSync(workspace);
 const seed=crypto.randomBytes(6).toString('hex'),file=path.join(workspace,'progress.txt');fs.writeFileSync(file,'ROUND_A_'+seed+'\n');
 const settings=(await evaluate(`window.api.botWork.getSettings('${botId}')`)).settings;
 assert((await evaluate(`window.api.botWork.saveSettings(${JSON.stringify({botId,expectedRevision:settings.revision,workspacePath:workspace,modelId:modelKey,expertId:'',skillIds:[],mcpIds:[],connectorIds:[]})})`)).ok);
 const created=await evaluate(`window.api.botWork.createBot({requestId:crypto.randomUUID(),displayName:'持续观察员',responsibilitySummary:'每轮读取指定文件并逐字报告'})`);assert(created.ok);
 const memberId=created.bot.botId;
 assert((await evaluate(`window.api.botWork.teamControl(${JSON.stringify({kind:'save_template',request:{operationId:'team-watch-template',name:'持续观察团队',plan:{workspacePath:workspace,ownerBotId:botId,ownerResponsibility:'核对观察员本轮原文并汇报完整内容和轮次，不重复旧结果，不提前结束长期委托。',executionPolicy:'parallel',maxConcurrency:2,members:[{botId:memberId,responsibility:`本轮用真实read读取 ${file}，逐字报告完整原文，不写文件不联网。`,delegatedScope:['workspace:read']}]}}})})`)).ok);
 const endsAt=Date.now()+600000;
 await send(`用已保存“持续观察团队”执行长期任务，持续每分钟整点UTC（cron明确为 * * * * *，不是0 * * * *）观察 ${file}，现在也检查一次。每轮由成员真实read读取，负责人汇总完整原文，再回到本对话。明确在 ${new Date(endsAt).toISOString()}（Unix毫秒${endsAt}）终止。不要联网，不写文件，不第一轮就结束。`);await foregroundDone();
 const rows=await evaluate('window.api.botWork.listWorks(true)');assert.equal(rows.length,1);const id=rows[0].workId;
 const detail=()=>evaluate(`window.api.botWork.getWork(${JSON.stringify(id)})`);
 let work=await detail();assert.equal(work.mode,'watch');assert.equal(work.watchPlan.endsAt,endsAt);assert.equal(work.phase4.subscriptions.find(s=>s.source==='cron'&&s.status!=='stopped')?.cronExpression,'* * * * *','every-minute cadence remains exact');
 await until(async()=>{const h=await history();report.history=h;return h.messages.some(m=>m.workFeedback?.kind==='result'&&m.workFeedback?.category==='result'&&m.text.includes('ROUND_A_'+seed));},'team round A foreground delivery');
 if(!rescheduleOnly) {
 fs.writeFileSync(file,'ROUND_B_'+seed+'\n');
 await until(async()=>{const h=await history();report.history=h;return h.messages.some(m=>m.workFeedback?.kind==='result'&&m.workFeedback?.category==='result'&&m.text.includes('ROUND_B_'+seed));},'team round B re-reads changed source and returns');
 work=await detail();assert.equal(work.lifecycle,'active');assert(work.executions.length>=4);report.beforePause=work;
 await send('暂停刚才的持续观察团队事项，暂时不要安排下一轮。');await foregroundDone();
 work=await detail();assert.equal(work.lifecycle,'paused');const count=work.executions.length;
 await new Promise(r=>setTimeout(r,65000));assert.equal((await detail()).executions.length,count,'pause no new member or owner dispatch');
 await send('恢复刚才暂停的团队持续观察，继续原来的每分钟安排和原终止时间。');await foregroundDone();
 work=await detail();assert.equal(work.lifecycle,'active','resume succeeds before expiry');
 }
 work=await detail();const originalIntent=work.intentRevision,originalSnapshot=work.inputSnapshotId;
 const finalEndsAt=Date.now()+60000;
 await send(`把该团队追踪终止时刻调整为 ${new Date(finalEndsAt).toISOString()}，Unix毫秒 ${finalEndsAt}，其他安排不变。`);await foregroundDone();
 const adjusted=await detail();assert.equal(adjusted.watchPlan.endsAt,finalEndsAt);assert.equal(adjusted.intentRevision,originalIntent,'time change must not supersede team');assert.equal(adjusted.inputSnapshotId,originalSnapshot,'time change keeps original team inputs');assert.notEqual(adjusted.team.state,'superseded');
 await until(async()=>{work=await detail();report.latestWork=work;return work.lifecycle==='closed';},'team explicit expiry');
 assert.equal(work.watchPlan.termination.reason,'schedule_expired');assert.equal(work.closureConclusion,undefined);
 await until(async()=>{const h=await history();report.history=h;return h.messages.some(m=>m.workFeedback?.kind==='closure'&&m.text.includes('到期结束'));},'team expiry feedback');
 const finalCount=work.executions.length;await new Promise(r=>setTimeout(r,65000));assert.equal((await detail()).executions.length,finalCount,'expiry no later dispatch');
 report.finalWork=await detail();report.diagnostics=await evaluate(`window.api.botWork.executionDiagnostics({kind:'work',workId:${JSON.stringify(id)}})`);
 for(const width of [1280,390]){await rpc('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await new Promise(r=>setTimeout(r,200));assert(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'));const shot=await rpc('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'team-watch-'+width+'.png'),Buffer.from(shot.data,'base64'));}
 report.checks.push(rescheduleOnly ? 'real team first round, pure deadline amendment preserves intent/snapshot/team plan, expiry and 65s no subsequent dispatch' : 'real natural-language team watch admission; two changed-source rounds with member + owner + foreground return; pause for 65s; resume; absolute expiry; 65s no post-expiry dispatch');
};
