/** Six distinct real tasks completing issue 21's cross-mode and renderer evidence. */
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict');
const {currentTurn}=require('./work-isolation-live-scenario.cjs').observation;
exports.run=async h=>{
 const {evaluate,until,send,history,requests,report,out,home,modelKey,botId,restart}=h;
 const workspace=path.join(home,'closure-inputs');fs.mkdirSync(workspace);
 const marker='CLOSURE-'+crypto.randomBytes(8).toString('hex');fs.writeFileSync(path.join(workspace,'source.txt'),marker+'\n');
 fs.writeFileSync(path.join(workspace,'sales.csv'),'item,units,price\nTea,3,12\nCake,4,8\n');
 const spaceId='closure-'+crypto.randomUUID();await evaluate(`window.api.db.upsertSpace(${JSON.stringify({id:spaceId,name:'Issue21 closure',path:workspace,createdAt:Date.now(),updatedAt:Date.now()})})`);
 await evaluate(`(()=>{window.__closureEvents=[];window.api.agent.onEvent(e=>window.__closureEvents.push(e));return true})()`);
 report.cases=[];report.failures=[];
 const persist=()=>{report.modelCalls=requests.length;fs.writeFileSync(path.join(out,'closure-progress.json'),JSON.stringify(report,null,2));};
 async function section(name,kind,fn){const row={name,kind,status:'running',requestStart:requests.length};report.cases.push(row);persist();try{await fn(row);row.status='passed';}catch(e){row.status='failed';row.error=String(e.stack||e);report.failures.push(name+': '+e.message);}finally{row.requestEnd=requests.length;persist();console.log(row.status.toUpperCase()+' closure '+name);}}
 async function native(row,prompt,{mode='native',taskId,abort=false}={}){
  taskId ||= 'closure-'+crypto.randomUUID();row.taskId=taskId;
  await evaluate(`window.api.db.upsertTask(${JSON.stringify({id:taskId,title:row.name,spaceId,cwd:workspace,updatedAt:Date.now(),welcomeMode:'working',modelId:modelKey,modePresetId:mode,permissionMode:'readonly'})})`);
  const before=await evaluate(`window.api.agent.loadTaskHistory(${JSON.stringify(taskId)})`), previous=new Set((before?.messages||[]).map(m=>m.id));
  const start=await evaluate('window.__closureEvents.length');
  await evaluate(`(()=>{window.api.agent.prompt(${JSON.stringify({taskId,text:prompt,spaceId,modelId:modelKey,welcomeMode:'working',modePresetId:mode,permissionMode:'readonly',userMessageId:crypto.randomUUID(),assistantMessageId:crypto.randomUUID()})}).catch(e=>window.__closureError=String(e));return true})()`);
  if(abort){await until(async()=>{const x=await evaluate(`window.api.agent.loadTaskHistory(${JSON.stringify(taskId)})`);return x.messages.flatMap(m=>m.tools||[]).some(t=>t.tool==='bash'&&['running','pending'].includes(t.status));},'real in-flight shell');await evaluate(`window.api.agent.abort(${JSON.stringify(taskId)})`);}
  await until(()=>evaluate(`(()=>{const a=window.__closureEvents.slice(${start}).filter(e=>e.type==='durable_delta'&&e.taskId===${JSON.stringify(taskId)}&&e.delta.state).map(e=>e.delta.state);return a.some(s=>s.busy)&&a.at(-1)?.busy===false&&['completed','failed','aborted'].includes(a.at(-1)?.outcome)})()`),'native terminal '+row.name);
  row.state=await evaluate(`window.__closureEvents.slice(${start}).filter(e=>e.type==='durable_delta'&&e.taskId===${JSON.stringify(taskId)}&&e.delta.state).at(-1).delta.state`);
  if(!abort)assert.equal(row.state.outcome,'completed',row.state.error);
  row.history=await evaluate(`window.api.agent.loadTaskHistory(${JSON.stringify(taskId)})`);
  row.turn=currentTurn(row.history,previous,prompt);row.tools=row.turn.flatMap(m=>m.tools||[]);
  assert(!row.tools.some(t=>t.status==='pending_approval'||/共享资源已隔离|等待.*workspace:write.*授权/.test(t.output||'')));
  if(mode==='codemode')assert(row.tools.some(t=>t.tool==='codemode'&&t.status==='success'),'actual Code Mode execution missing');
  return row.turn.filter(m=>m.role==='assistant').map(m=>m.text||'').join('\n');
 }
 await section('Code Mode CSV analysis','data-analysis',async row=>{await native(row,`用 Code Mode 实际读取 ${workspace}/sales.csv，计算units*price总和，写 ${workspace}/total.txt 为 68，然后回读确认。必须实际调用codemode，不使用后台事项。`,{mode:'codemode'});assert.equal(fs.readFileSync(path.join(workspace,'total.txt'),'utf8').trim(),'68');});
 await section('Code Mode code generation','code-generation',async row=>{await native(row,`用 Code Mode 创建 ${workspace}/sum.cjs，导出(a,b)=>a+b，并调用bash执行Node断言sum(19,23)===42，把真实测试PASS写入 ${workspace}/test-result.txt，回读确认。不要建后台事项。`,{mode:'codemode'});assert.match(fs.readFileSync(path.join(workspace,'test-result.txt'),'utf8'),/PASS/);assert.equal(require(path.join(workspace,'sum.cjs'))(19,23),42);});
 await section('Native subagent source extraction','source-extraction',async row=>{const text=await native(row,`必须调用 reader subagent，isolation=shared，model=${modelKey}，让子代理实际读取 ${workspace}/source.txt，将完整原文写到 ${workspace}/child-copy.txt 并回读。你不能替代子代理读写，收到真实结果再回复完整标记。`);assert(row.tools.some(t=>t.tool==='subagent'&&t.status==='success'));assert.equal(fs.readFileSync(path.join(workspace,'child-copy.txt'),'utf8').trim(),marker);assert(text.includes(marker));});
 let uiTask;
 await section('Ordinary translation with real output','translation',async row=>{const text=await native(row,`把“会议改到周五上午十点”译为英语，将译文以及标记 ${marker} 写入 ${workspace}/translation.txt 并read回读；回复两者。不使用后台事项。`);uiTask=row.taskId;assert(text.includes(marker));assert.match(fs.readFileSync(path.join(workspace,'translation.txt'),'utf8'),/Friday/i);});
 await section('Team source document and business closure','team-document',async row=>{
  const member=await evaluate(`window.api.botWork.createBot({requestId:crypto.randomUUID(),displayName:'闭环资料员',responsibilitySummary:'读取指定来源并交付文件'})`);assert(member.ok);
  const settings=(await evaluate(`window.api.botWork.getSettings(${JSON.stringify(botId)})`)).settings;
  assert((await evaluate(`window.api.botWork.saveSettings(${JSON.stringify({botId,expectedRevision:settings.revision,workspacePath:workspace,modelId:modelKey,expertId:'',skillIds:[],mcpIds:[],connectorIds:[]})})`)).ok);
  const plan={workspacePath:workspace,ownerBotId:botId,ownerResponsibility:'读取成员实际成果，汇总来源标记并交付team-note.md，完成业务验收。不替代成员写文件。',executionPolicy:'parallel',maxConcurrency:2,members:[{botId:member.bot.botId,responsibility:`实际读取 ${workspace}/source.txt，写 ${workspace}/team-note.md，包含完整标记和一句中文来源说明，再回读交付。`,delegatedScope:[]}]};
  assert((await evaluate(`window.api.botWork.teamControl(${JSON.stringify({kind:'save_template',request:{operationId:'closure-team-'+crypto.randomUUID(),name:'退役闭环资料组',plan}})})`)).ok);
  const before=new Set((await evaluate('window.api.botWork.listWorks(true)')).map(w=>w.workId));
  await send('使用已保存的“退役闭环资料组”团队立即执行一次性来源文档任务，严格按模板分工，成员实际读取source.txt并写team-note.md，负责人汇总交付并完成业务验收。不创建定时检查。');
  let work;await until(async()=>{work=(await evaluate('window.api.botWork.listWorks(true)')).find(w=>!before.has(w.workId));return work;},'team Work');
  await until(async()=>{row.work=await evaluate(`window.api.botWork.getWork(${JSON.stringify(work.workId)})`);return row.work.lifecycle==='closed';},'team business closure');
  assert.equal(row.work.closureConclusion,'succeeded');assert(row.work.team?.executions.some(e=>e.role==='member'&&e.status==='completed'));assert(row.work.team.executions.some(e=>e.role==='owner_summary'&&['completed','recovered'].includes(e.status)));
  assert(fs.readFileSync(path.join(workspace,'team-note.md'),'utf8').includes(marker));
  await until(async()=>{row.feedback=(await history()).messages.filter(m=>m.workIds?.includes(work.workId)&&m.workFeedback?.category==='result');return row.feedback.length;},'team returned to source conversation');
  await until(()=>evaluate(`document.querySelector('.bot-thread')?.innerText.includes('team-note.md')`),'visible team file');
 });
 await section('Actual stop and same-session recovery','cancellation',async row=>{
  const target=path.join(workspace,'must-not-write-after-stop.txt');
  await native(row,`立即执行bash：sleep 25; printf forbidden > ${target}。不要后台执行，不创建Work。`,{abort:true});
  row.cancelledState=row.state;assert.equal(row.state.outcome,'aborted');assert(!fs.existsSync(target));
  const text=await native(row,`前一轮已停止。现在只read ${workspace}/source.txt 并回复完整标记，不重试前轮写入。`,{taskId:row.taskId});assert(text.includes(marker));assert(!fs.existsSync(target));
 });
 // Reopen the real UI, then call the same production navigation action as a task row.
 await restart();await evaluate(`import('/src/store/appStore.ts').then(m=>m.useAppStore.getState().setActiveTask(${JSON.stringify(uiTask)}))`);
 await until(()=>evaluate(`document.body.innerText.includes(${JSON.stringify(marker)})&&document.body.innerText.includes('Friday')`),'real native chat shows persisted model result');
 report.nativeUi={taskId:uiTask,markerVisible:true,translationVisible:true,navigation:'production setActiveTask after actual app restart; no synthetic renderer history'};
 const shot=await h.rpc('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(out,'ordinary-result.png'),Buffer.from(shot.data,'base64'));
 report.modelCalls=requests.length;report.checks.push('six real task types; Code Mode, native subagent, ordinary renderer, team delivery, cancellation and restart');persist();assert.equal(report.failures.length,0,report.failures.join('\n'));
};
