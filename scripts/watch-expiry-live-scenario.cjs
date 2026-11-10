const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
exports.run=async({send,foregroundDone,until,evaluate,history,rpc,report,out,home,modelKey,botId})=>{
 const workspace=path.join(home,'expiry-source');fs.mkdirSync(workspace,{recursive:true});
 const seed=crypto.randomBytes(6).toString('hex'),file=path.join(workspace,'progress.txt');fs.writeFileSync(file,'EXPIRY_'+seed+'\n');
 const settings=(await evaluate(`window.api.botWork.getSettings('${botId}')`)).settings;
 assert((await evaluate(`window.api.botWork.saveSettings(${JSON.stringify({botId,expectedRevision:settings.revision,workspacePath:workspace,modelId:modelKey,expertId:'',skillIds:[],mcpIds:[],connectorIds:[]})})`)).ok);
 const endsAt=Date.now()+150000, iso=new Date(endsAt).toISOString();
 await send(`创建持续跟踪事项，标题“真实到期跟踪-${seed}”。每分钟整点（UTC）用真实read检查 ${file}，现在也检查一次；每轮简短报告完整原文和检查时间。终止时刻明确为 ${iso}，Unix毫秒 ${endsAt}。这是终止期限不是提醒：到期自动停止后续检查并告诉我追踪结束，不表示目标成功。不要写文件，不要联网，不要在第一轮完成后提前结束。`);
 await foregroundDone();
 const rows=await evaluate('window.api.botWork.listWorks(true)');assert.equal(rows.length,1);const id=rows[0].workId;
 const detail=()=>evaluate(`window.api.botWork.getWork(${JSON.stringify(id)})`);
 let work=await detail();assert.equal(work.watchPlan.endsAt,endsAt);assert.equal(work.mode,'watch');
 report.explicitDeadline={endsAt,iso,workId:id};
 await until(async()=>{work=await detail();report.latestWork=work;return work.executions.some(e=>e.status==='completed');},'real model read round');
 assert.equal(work.lifecycle,'active','one round does not end watch');
 await until(async()=>{const h=await history();return h.messages.some(m=>m.workFeedback?.kind==='result'&&m.text.includes('EXPIRY_'+seed));},'real round result delivered before expiry');
 await until(async()=>{work=await detail();report.latestWork=work;return work.lifecycle==='closed';},'actual wall clock expiry and settled closure');
 assert.equal(work.closureConclusion,undefined);assert.equal(work.watchPlan.termination.reason,'schedule_expired');assert(work.closedAt>=endsAt);
 await until(async()=>{const h=await history();report.history=h;return h.messages.some(m=>m.workFeedback?.kind==='closure'&&m.text.includes('到期结束'));},'expiry feedback original conversation');
 const count=work.executions.length;await new Promise(r=>setTimeout(r,65000));work=await detail();assert.equal(work.executions.length,count,'no post-expiry minute dispatch');
 assert(work.phase4.subscriptions.every(s=>s.status==='stopped'));assert.equal(fs.readFileSync(file,'utf8'),'EXPIRY_'+seed+'\n');
 for(const width of [1280,390]){await rpc('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await new Promise(r=>setTimeout(r,200));assert(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'));const shot=await rpc('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'watch-expiry-'+width+'.png'),Buffer.from(shot.data,'base64'));}
 report.finalWork=work;report.checks.push('real model explicit finite watch; native file read; actual wall-clock expiry; terminal review; neutral expiry feedback; 65s after expiry no new dispatch; no business write');
};
