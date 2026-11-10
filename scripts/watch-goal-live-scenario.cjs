const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
exports.run=async({send,foregroundDone,until,evaluate,history,rpc,report,out,home,modelKey,botId})=>{
 const workspace=path.join(home,'release-source');fs.mkdirSync(workspace,{recursive:true});
 const file=path.join(workspace,'status.txt'),seed=crypto.randomBytes(6).toString('hex'),waiting='WAITING_'+seed,ready='READY_'+seed;
 fs.writeFileSync(file,waiting+'\n');
 const settings=(await evaluate(`window.api.botWork.getSettings('${botId}')`)).settings;
 assert((await evaluate(`window.api.botWork.saveSettings(${JSON.stringify({botId,expectedRevision:settings.revision,workspacePath:workspace,modelId:modelKey,expertId:'',skillIds:[],mcpIds:[],connectorIds:[]})})`)).ok);
 await send(`持续关注发布准备，每分钟（UTC，cron * * * * *）用read读取 ${file}，现在不要提前检查。每轮报告文件完整原文，不要写文件或联网。当文件内容为 ${ready}，表示发布准备就绪，主动结束持续委托并汇报，不需我确认。尚未就绪时继续检查。标题“发布准备-${seed}”。`);
 await foregroundDone();
 const works=await evaluate('window.api.botWork.listWorks(true)');assert.equal(works.length,1);const id=works[0].workId;
 const detail=()=>evaluate(`window.api.botWork.getWork(${JSON.stringify(id)})`);
 let w=await detail();assert.equal(w.mode,'watch');assert.equal(w.phase4.subscriptions.find(s=>s.status==='online').cronExpression,'* * * * *');
 await until(async()=>{w=await detail();report.latestWork=w;return (await history()).messages.some(m=>m.workFeedback?.kind==='result'&&m.text.includes(waiting));},'first WAITING observation');
 assert.equal(w.lifecycle,'active');report.waiting=w;
 fs.writeFileSync(file,ready+'\n');
 await until(async()=>{w=await detail();report.latestWork=w;report.history=await history();return w.lifecycle==='closed';},'READY causes evidence-based automatic closure without confirmation');
 assert.equal(w.closureConclusion,'succeeded');
 assert(report.history.messages.some(m=>m.workFeedback?.kind==='result'&&m.text.includes(ready)),'real READY result returns before closure');
 const interactions=await evaluate(`document.body.innerText`);assert(!interactions.includes('确认完成 Work'),'no artificial completion approval');
 const count=w.executions.length;await new Promise(r=>setTimeout(r,65000));
 w=await detail();assert.equal(w.executions.length,count,'no new round after goal satisfied');assert.equal(w.lifecycle,'closed');
 report.finalWork=w;report.history=await history();report.checks.push('actual model + Electron UI + native read: WAITING remains active; READY closes succeeded without confirmation; final result delivered; 65s no new dispatch');
 for(const width of [1280,390]){await rpc('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await new Promise(r=>setTimeout(r,200));assert(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'));const shot=await rpc('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'watch-goal-'+width+'.png'),Buffer.from(shot.data,'base64'));}
};
