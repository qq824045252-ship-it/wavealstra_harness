const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
exports.run=async({evaluate,until,send,history,report,requests,out,home,modelKey,botId})=>{
 const workspace=path.join(home,'background-research');fs.mkdirSync(workspace);
 const settings=(await evaluate(`window.api.botWork.getSettings(${JSON.stringify(botId)})`)).settings;
 assert((await evaluate(`window.api.botWork.saveSettings(${JSON.stringify({botId,expectedRevision:settings.revision,workspacePath:workspace,modelId:modelKey,expertId:'',skillIds:[],mcpIds:[],connectorIds:[]})})`)).ok);
 report.cases=[];report.failures=[];const persist=()=>{report.modelCalls=requests.length;fs.writeFileSync(path.join(out,'background-progress.json'),JSON.stringify(report,null,2));};
 async function section(name,kind,fn){const r={name,kind,status:'running',requestStart:requests.length};report.cases.push(r);persist();try{await fn(r);r.status='passed';}catch(e){r.status='failed';r.error=String(e.stack||e);report.failures.push(name+': '+e.message);}finally{r.requestEnd=requests.length;persist();console.log(r.status.toUpperCase()+' background '+name);}}
 await section('Background public research and network read','public-research',async r=>{
  const before=new Set((await evaluate('window.api.botWork.listWorks(true)')).map(w=>w.workId));
  await send(`立即创建一次性后台事项“退役后公开研究”：工作目录${workspace}。执行web_search搜索IANA Example Domains，记录真实搜索结果URL和摘要，并明确摘要未作原页核验。另用bash curl --max-time 20 https://example.com/读取这个指定公开页面，记录实际退出码、标题与来源。禁止fetch_content，不访问搜索结果链接；任何地址若被策略拒绝，不重试、不换路径绕过。把两部分和真实失败（如有）写入research.md，用read回读并交付本会话，完成业务验收，不建定时任务。`);
  let work;await until(async()=>{work=(await evaluate('window.api.botWork.listWorks(true)')).find(w=>!before.has(w.workId));return work;},'research Work');
  await until(async()=>{r.work=await evaluate(`window.api.botWork.getWork(${JSON.stringify(work.workId)})`);return r.work.lifecycle==='closed';},'research business closure');
  assert.equal(r.work.closureConclusion,'succeeded');r.histories=[];
  for(const e of r.work.executions)r.histories.push(await evaluate(`window.api.agent.loadTaskHistory(${JSON.stringify(e.taskId)})`));
  r.tools=r.histories.flatMap(h=>h.messages.flatMap(m=>m.tools||[]));
  assert(r.tools.some(t=>t.tool==='web_search'&&t.status==='success'&&/https?:\/\//.test(t.output||'')),'background search must return real source URLs');
  assert(r.tools.some(t=>t.tool==='bash'&&t.status==='success'&&/Example Domain/.test(t.output||'')),'background shell must read actual public page');
  assert(!r.tools.some(t=>t.status==='pending_approval'||/共享资源已隔离|等待.*workspace:write.*授权/.test(t.output||'')));
  const bytes=fs.readFileSync(path.join(workspace,'research.md'));assert.match(bytes.toString(),/Example Domain/);r.file={bytes:bytes.length,sha256:require('node:crypto').createHash('sha256').update(bytes).digest('hex')};
  await until(async()=>{r.feedback=(await history()).messages.filter(m=>m.workIds?.includes(work.workId)&&m.workFeedback?.category==='result');return r.feedback.length;},'research feedback');
  await until(()=>evaluate(`document.querySelector('.bot-thread')?.innerText.includes('research.md')`),'visible research file');
 });
 const shorts=[['Arithmetic','arithmetic','只回复19乘以23的结果，不使用工具或后台事项。',/437/],['Translation','translation','把“明天下午三点见”译成英语，只给译文，不使用工具或后台事项。',/3|three/i],['Editing','editing','校对英文“I has two book.”，只给改正后的句子，不使用工具或后台事项。',/I have two books/i],['Agenda','planning','给30分钟小组例会列3项议程和各自分钟数，总计30分钟，不使用工具或后台事项。',/\d/],['JSON formatting','structured-output','将姓名Ada、项目数2转成单行JSON，键为name和projects，不使用工具或后台事项。',/Ada/]];
 for(const [name,kind,prompt,expected]of shorts)await section(name,kind,async r=>{await send(prompt);const user=(await history()).messages.filter(m=>m.role==='user').at(-1);await until(async()=>{r.answer=(await history()).messages.find(m=>m.role==='assistant'&&m.requestId===user.requestId&&['completed','failed','cancelled','unknown'].includes(m.status));return r.answer;},name+' answer');assert.equal(r.answer.status,'completed');assert.match(r.answer.text,expected);});
 assert.equal(report.cases.length,6);assert.equal(report.failures.length,0,report.failures.join('\n'));report.checks.push('real background public search, independent allowed public curl, disk readback and visible delivery; five distinct short foreground tasks');persist();
};
