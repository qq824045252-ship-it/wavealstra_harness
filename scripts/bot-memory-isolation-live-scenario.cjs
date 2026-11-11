const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
exports.run=async({send,foregroundDone,until,evaluate,history,rpc,report,requests,out,botId,setBotId})=>{
 const a=botId; const created=await evaluate(`window.api.botWork.createBot({requestId:crypto.randomUUID(),displayName:'独立旅行助理',responsibilitySummary:'独立处理旅行与日常任务'})`);assert(created.ok);const b=created.bot.botId;
 const atoms=id=>evaluate(`window.api.memory.list({scopeType:'bot',scopeId:${JSON.stringify(id)},status:'active'})`);
 const select=async(id,name)=>{await evaluate(`[...document.querySelectorAll('.sidebar-bot-identity')].find(b=>b.querySelector('strong')?.textContent===${JSON.stringify(name)}).click()`);setBotId(id);await until(()=>evaluate(`document.querySelector('.sidebar-bot-identity[aria-pressed=true] strong')?.textContent===${JSON.stringify(name)}`),'select '+name);};
 const newChat=async()=>{const prev=(await history()).conversationId;await evaluate('document.querySelector(".bot-new-conversation").click()');await until(()=>evaluate('[...document.querySelectorAll("button")].some(b=>b.textContent==="归档并开始新对话")'),'new dialog');await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent==="归档并开始新对话").click()');await until(async()=>(await history()).conversationId!==prev&&(await history()).messages.length===0,'new ID');};
 await send('请记住长期格式偏好：每次最终答复末尾单独写“松果甲”。只适用于当前Bot。');await foregroundDone();await until(async()=>JSON.stringify(await atoms(a)).includes('松果甲'),'A learned');
 await select(b,'独立旅行助理'); await send('请记住长期格式偏好：每次最终答复末尾单独写“海星乙”。只适用于当前Bot。');await foregroundDone();await until(async()=>JSON.stringify(await atoms(b)).includes('海星乙'),'B learned');
 assert(!JSON.stringify(await atoms(a)).includes('海星乙'));assert(!JSON.stringify(await atoms(b)).includes('松果甲'));
 report.cases=[];
 const cases=[['库存计算',a,'MyBuddy','库存有17和29件，合计多少？','46','松果甲','海星乙'],['行程建议',b,'独立旅行助理','给我一份不依赖实时信息的半日散步建议。','','海星乙','松果甲'],['会议议程',a,'MyBuddy','列一个15分钟项目例会的三段议程。','','琥珀甲','海星乙'],['文字改写',b,'独立旅行助理','把“我们将在明天回复您的问题”改得友好简短。','','海星乙','琥珀甲'],['单位换算',a,'MyBuddy','2.5公里等于多少米？写出关系。','2500',null,'海星乙'],['待办清单',b,'独立旅行助理','列出门前的三项物品检查清单。','','海星乙','琥珀甲']];
 for(let i=0;i<cases.length;i++){
  const [title,id,name,prompt,expected,mark,forbidden]=cases[i];await select(id,name);
  if(i===2){await send('更正长期末尾标记：改为“琥珀甲”，不再使用“松果甲”。');await foregroundDone();await until(async()=>JSON.stringify(await atoms(a)).includes('琥珀甲'),'A corrected');assert(JSON.stringify(await atoms(b)).includes('海星乙'));}
  if(i===4){await send('忘记并删除关于答复末尾标记的长期记忆。');await foregroundDone();await until(async()=>!JSON.stringify(await atoms(a)).includes('琥珀甲'),'A forgotten');assert(JSON.stringify(await atoms(b)).includes('海星乙'));}
  await newChat();const offset=requests.length;
  await send(prompt);await foregroundDone();const answer=(await history()).messages.filter(m=>m.role==='assistant').at(-1);assert.equal(answer.status,'completed');if(expected)assert(answer.text.includes(expected));if(mark)assert(answer.text.includes(mark));else assert(!/松果甲|琥珀甲/.test(answer.text));assert(!answer.text.includes(forbidden));
  assert(!JSON.stringify(requests.slice(offset)).includes(forbidden),'other Bot memory absent from model wire');
  const row={title,botId:id,conversationId:(await history()).conversationId,answer:answer.text,modelCalls:requests.length-offset};report.cases.push(row);console.log(JSON.stringify(row));
 }
 await select(a,'MyBuddy');await evaluate('[...document.querySelectorAll("button")].find(b=>b.getAttribute("aria-label")==="Bot 设置与对话管理").click()');
 await until(()=>evaluate('[...document.querySelectorAll("button")].some(b=>b.textContent==="专属记忆")'),'memory tab');await evaluate('[...document.querySelectorAll("button")].find(b=>b.textContent==="专属记忆").click()');await until(()=>evaluate('document.body.innerText.includes("此 Bot 的专属记忆")'),'dedicated memory page');
 assert(!await evaluate('document.querySelector(".memory-explorer").innerText.includes("海星乙")'));
 const shot=await rpc('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'bot-private-memory.png'),Buffer.from(shot.data,'base64'));
 report.checks.push('six distinct real-model tasks across two Bots; natural remember/correct/forget; separate conversation IDs; other Bot memory absent on wire and in answer; dedicated settings view');
};
