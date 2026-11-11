const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
exports.run=async({send,foregroundDone,until,evaluate,history,rpc,report,requests,agentDir,out,home,modelKey,botId})=>{
 const workspace=path.join(home,'watch-memory-inputs');fs.mkdirSync(workspace,{recursive:true});
 const settings=(await evaluate(`window.api.botWork.getSettings('${botId}')`)).settings;
 assert((await evaluate(`window.api.botWork.saveSettings(${JSON.stringify({botId,expectedRevision:settings.revision,workspacePath:workspace,modelId:modelKey,expertId:'',skillIds:[],mcpIds:[],connectorIds:[]})})`)).ok);
 const atoms=()=>evaluate(`window.api.memory.list({scopeType:'bot',scopeId:${JSON.stringify(botId)},status:'active'})`),detail=id=>evaluate(`window.api.botWork.getWork(${JSON.stringify(id)})`);
 await send('请记住长期回复格式偏好：每份结果末尾单独写“松露标记”。');await foregroundDone();
 await until(async()=>JSON.stringify(await atoms()).includes('松露标记'),'original preference stored');
 const cases=[['库存','stock.csv','item,count\nA,17\nB,29','计算库存总数量','46'],['待办','todo.txt','done: book\nopen: call\nopen: email','统计open待办数量','2'],['会议','agenda.md','09:00 项目例会\n10:30 设计评审','列出当天最早一项会议及时间','09:00'],['温度','temperature.json','{"celsius":20}','按F=C*1.8+32换算华氏温度','68'],['摘要','note.txt','项目已完成原型，当前等待设计评审，下周计划联调。','一句话总结项目当前状态','评审'],['费用','expense.csv','item,amount\nTrain,73\nHotel,126','计算费用合计','199']];
 report.works=[];report.rounds=[];const memoryIds=new Map();
 for(const [title,name,data,task,expected] of cases){
  const file=path.join(workspace,name);fs.writeFileSync(file,data+'\n');const before=new Set((await evaluate('window.api.botWork.listWorks(true)')).map(w=>w.workId));
  await send(`创建持续跟踪事项“长期记忆-${title}”：每2分钟整点（UTC）实际read文件 ${file}，${task}，每轮简短报告结果，即使没变化也返回。按每轮最新有效长期回复偏好输出，不把旧偏好写死进委托目标。不要现在提前执行，不写文件、不联网，持续至我暂停，不要首轮完成后关闭。`);await foregroundDone();
  const w=(await evaluate('window.api.botWork.listWorks(true)')).find(w=>!before.has(w.workId));assert(w&&w.mode==='watch');report.works.push({workId:w.workId,title,expected,file});
 }
 const changes={
  库存:[['item,count\nA,20\nB,30','50'],['item,count\nA,1\nB,2','3']],
  待办:[['done: book\nopen: call','1'],['open: book\nopen: call\nopen: email','3']],
  会议:[['08:30 站会\n10:30 设计评审','08:30'],['11:00 联调\n14:00 复盘','11:00']],
  温度:[['{"celsius":0}','32'],['{"celsius":10}','50']],
  摘要:[['项目设计评审已完成，当前正在联调，下周计划上线。','联调'],['项目联调已完成，目前已经上线，等待用户反馈。','上线']],
  费用:[['item,amount\nTrain,10\nHotel,15','25'],['item,amount\nTrain,2\nHotel,3','5']]
 };
 const changeInputs=phase=>{for(const item of report.works){const [data,expected]=changes[item.title][phase];fs.writeFileSync(item.file,data+'\n');item.expected=expected;}};
 let phaseAt=0;
 const observe=async(round,marker)=>{
  for(const item of report.works){
   let w,e;await until(async()=>{w=await detail(item.workId);e=w.executions.filter(e=>e.inboxEventId&&e.status==='completed'&&(e.submittedAt??e.admittedAt)>=phaseAt).sort((a,b)=>(a.submittedAt??a.admittedAt)-(b.submittedAt??b.admittedAt))[0];return !!e;},'watch '+round+' '+item.title);
   assert.equal(w.lifecycle,'active');
   const deliverable=w.deliverables.find(d=>d.executionId===e.bindingId);assert(deliverable,'round result');
   const output=deliverable.summary;assert(output.includes(item.expected),item.title+' actual result');
   if(marker)assert(output.includes(marker),'current preference '+item.title);else assert(!/松露标记|琉璃标记/.test(output),'forgotten preference '+item.title);
   await until(async()=>(await history()).messages.some(m=>m.workFeedback?.executionId===e.bindingId&&m.workFeedback?.kind==='result'),'foreground result '+item.title);
   const message=(await history()).messages.find(m=>m.workFeedback?.executionId===e.bindingId&&m.workFeedback?.kind==='result');
   const foreground=message.text.split('原始执行记录：')[0];
   if(marker)assert(foreground.includes(marker),'foreground summary keeps current preference '+item.title);
   else assert(!/松露标记|琉璃标记/.test(foreground),'foreground summary forgets old preference '+item.title);
   const native=requests.filter(r=>r.tools?.some(t=>t.function?.name==='read')&&JSON.stringify(r.messages).includes(e.bindingId));
   assert(native.length,'actual native request for this exact watch execution');
   const l1=native.flatMap(r=>r.messages).map(m=>typeof m.content==='string'?m.content:JSON.stringify(m.content)).filter(t=>t.includes('[L1 ')).join('\n');
   const botEvidence=l1.split(/(?=\[L1 )/).filter(block=>/^\[L1 [^\n]*\[bot\]/.test(block)).join('\n');
   if(marker)assert(botEvidence.includes(marker),'current preference in native Bot L1');
   else assert(!/松露标记|琉璃标记/.test(botEvidence),'forgotten preference absent from native Bot L1; old Work history remains factual');
   const scopeRows=()=>evaluate(`window.api.memory.list(${JSON.stringify({scopeType:'work',scopeId:item.workId,status:'active'})})`);
   await until(async()=>(await scopeRows()).some(m=>m.metadata?.captureSource===`work-summary:${item.workId}`),'persistent Work memory');
   const summary=(await scopeRows()).find(m=>m.metadata?.captureSource===`work-summary:${item.workId}`);
   assert(summary.scopes.every(s=>s.scopeType==='work'&&s.scopeId===item.workId),'no task/private scope leakage');
   assert(summary.content.includes('持续追踪（单轮产出不代表结束）')&&summary.content.includes('状态：active'),'memory does not close standing commission');
   if(memoryIds.has(item.workId))assert.equal(summary.id,memoryIds.get(item.workId),'one persistent Work memory across distinct execution tasks');
   memoryIds.set(item.workId,summary.id);
   const row={expected:item.expected,memoryId:summary.id,nativeCalls:native.length,submittedAt:e.submittedAt,round,title:item.title,workId:item.workId,bindingId:e.bindingId,taskId:e.taskId,marker,output,foreground};report.rounds.push(row);console.log(JSON.stringify(row));
  }
 };
 await observe(1,'松露标记');
 changeInputs(0);
 await send('修正长期回复格式偏好：以后末尾改为“琉璃标记”，旧的松露标记不再使用。');await foregroundDone();
 await until(async()=>{const current=await atoms();return current.some(a=>a.content.includes('琉璃标记'))&&!current.some(a=>a.content.includes('松露标记')&&!a.content.includes('琉璃标记'));},'corrected preference persisted without contradictory old active record');
 phaseAt=Date.now();await observe(2,'琉璃标记');
 changeInputs(1);
 await send('忘记并删除所有关于末尾标记的长期记忆，以后不附加标记。');await foregroundDone();
 await until(async()=>!(await atoms()).some(a=>/松露标记|琉璃标记/.test(a.content)),'preference forgotten');
 phaseAt=Date.now();await observe(3,null);
 for(const item of report.works){const rounds=report.rounds.filter(r=>r.workId===item.workId);assert.equal(new Set(rounds.map(r=>r.taskId)).size,3,'fresh execution task per real timer round');await send(`暂停持续跟踪 ${item.workId}，不要再检查。`);await foregroundDone();assert.equal((await detail(item.workId)).lifecycle,'paused');}
 const shot=await rpc('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'watch-memory.png'),Buffer.from(shot.data,'base64'));
 report.checks.push('six task types, three actual timer rounds each, original/corrected/deleted memory in native Bot L1 and output, foreground return, distinct execution tasks sharing one persistent Work memory; paused afterwards');
};
