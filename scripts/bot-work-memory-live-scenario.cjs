const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
exports.run=async({send,foregroundDone,until,evaluate,history,rpc,report,requests,agentDir,out,botId})=>{
 const atoms=()=>evaluate(`window.api.memory.list({scopeType:'bot',scopeId:${JSON.stringify(botId)},status:'active'})`);
 await send('请记住一个长期回复偏好：任何任务的最终答复末尾单独写“青苔标记”。这只是测试格式。');await foregroundDone();
 await until(async()=>JSON.stringify(await atoms()).includes('青苔标记'),'natural preference stored');
 const oldChat=(await history()).conversationId;
 await evaluate('document.querySelector(".bot-new-conversation").click()');
 await until(()=>evaluate('[...document.querySelectorAll("button")].some(b=>b.textContent==="归档并开始新对话")'),'new chat dialog');
 await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent==="归档并开始新对话").click()');
 await until(async()=>(await history()).conversationId!==oldChat && (await history()).messages.length===0,'separate new conversation');
 const cases=[['库存统计','库存A有17件，B有29件，计算总数。','46'],['会议安排','写一个15分钟项目例会的三段议程。',''],['行程规划','设计一个不依赖实时查询的杭州半日散步路线，说明它是建议而非实时核验。',''],['文字编辑','把“我们已经收到您的来信并将在明天回复”改写成一句简洁友好的客服答复。',''],['单位换算','将2.5公里换算成米，并写出换算关系。','2500'],['清单整理','列一个出门前的三项普通物品检查清单。','']];
 report.cases=[];
 for(let i=0;i<cases.length;i++){
  if(i===3){await send('修正长期回复偏好：末尾标记改为“琥珀标记”，不再使用“青苔标记”。');await foregroundDone();await until(async()=>{const x=await atoms();return x.some(a=>a.content.includes('琥珀标记'))&&!x.some(a=>a.content.includes('青苔标记')&&!a.content.includes('琥珀标记'));},'preference correction persisted');}
  if(i===5){await send('忘记并删除关于回复末尾标记的长期记忆，不再要求任何末尾标记。');await foregroundDone();await until(async()=>!(await atoms()).some(a=>/青苔标记|琥珀标记/.test(a.content)),'forget persisted');}
  const [title,task,expected]=cases[i],before=new Set((await evaluate('window.api.botWork.listWorks(true)')).map(w=>w.workId)),offset=requests.length;
  await send(`请创建一次性后台委托，标题“记忆验收${i+1}-${title}”：${task}由后台独立完成，直接交付文字，不创建文件，不持续追踪，不需要我手工验收。`);await foregroundDone();
  await until(async()=>(await evaluate('window.api.botWork.listWorks(true)')).some(w=>!before.has(w.workId)),'new Work');
  const id=(await evaluate('window.api.botWork.listWorks(true)')).find(w=>!before.has(w.workId)).workId;
  await until(async()=>(await evaluate(`window.api.botWork.getWork(${JSON.stringify(id)})`)).lifecycle==='closed','Work completion');
  const work=await evaluate(`window.api.botWork.getWork(${JSON.stringify(id)})`);assert.equal(work.closureConclusion,'succeeded');
  const native=requests.slice(offset).filter(r=>r.messages.some(m=>m.role==='user'&&JSON.stringify(m.content).includes(id)));
  assert(native.length,'native Work requests recorded');
  const evidence=native.flatMap(r=>r.messages).map(m=>JSON.stringify(m.content)).filter(t=>t.includes('[L1 ')).join('\n');
  if(i<5)assert(evidence.includes(i<3?'青苔标记':'琥珀标记'),'stable preference is in native L1 projection');
  else assert(!/青苔标记|琥珀标记/.test(evidence),'forgotten preference absent from new Work evidence');
  const output=work.deliverables.map(d=>d.summary).join('\n');
  if(expected)assert(output.includes(expected),'task factual outcome from deliverable, not input');
  if(i<5)assert(output.includes(i<3?'青苔标记':'琥珀标记'),'final deliverable follows current preference');
  else assert(!/青苔标记|琥珀标记/.test(output),'forgotten preference not repeated in new result');
  const row={title,workId:id,conclusion:work.closureConclusion,nativeCalls:native.length,output,preference:i<3?'青苔标记':i<5?'琥珀标记':null};report.cases.push(row);console.log(JSON.stringify(row));
 }
 const shot=await rpc('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'work-memory.png'),Buffer.from(shot.data,'base64'));
 report.checks.push('six real-model native Work types; natural learning, separate conversation, correction and forgetting; authoritative L1 evidence in runtime requests');
};
