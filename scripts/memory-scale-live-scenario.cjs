const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
exports.run=async({send,foregroundDone,until,evaluate,history,rpc,report,requests,out,home,agentDir,botId,setBotId})=>{
 assert(/^bot-frontdoor-live-/.test(path.basename(home)));assert.equal(path.resolve(agentDir),path.resolve(home,'.mybuddy'));
 report.cases=[];report.fixtureBoundary={bulkViaProductIpc:true,modelLearnedBulk:false,realEmbeddingClaim:false,scales:[5000,10000]};
 for(const size of [5000,10000]){
  if(size===10000){const name='万条独立验收Bot';const c=await evaluate(`window.api.botWork.createBot({requestId:crypto.randomUUID(),displayName:'${name}',responsibilitySummary:'独立个人助理'})`);assert(c.ok);botId=c.bot.botId;
   await until(()=>evaluate(`[...document.querySelectorAll('.sidebar-bot-identity')].some(e=>e.querySelector('strong')?.textContent==='${name}')`),'new bot');
   await evaluate(`[...document.querySelectorAll('.sidebar-bot-identity')].find(e=>e.querySelector('strong')?.textContent==='${name}').click()`);setBotId(botId);
   await until(()=>evaluate(`document.querySelector('.sidebar-bot-identity[aria-pressed=true] strong')?.textContent==='${name}'`),'selected');}
  const needle='SCALE'+size+'QZVXNEEDLE',answer=size===5000?'23.718406':'61.930257';
  const row={size,botId,status:'running'};report.cases.push(row);const start=Date.now();
  try{for(let batchStart=0;batchStart<size;batchStart+=250) await evaluate(`(async()=>{const common={kind:'fact',scopeType:'bot',scopeId:${JSON.stringify(botId)},sourceType:'user',explicit:true,importance:1,confidence:1,metadata:{liveFixture:true}};if(${batchStart}===0) await window.api.memory.create({...common,title:'${needle}',content:'校准常数是 ${answer}'});for(let i=${Math.max(1,batchStart)};i<${Math.min(size,batchStart+250)};i++)await window.api.memory.create({...common,title:'容量夹具记录'+i,content:'与查询无关的独立合成事实编号'+i});return true;})()`);
   row.seedElapsedMs=Date.now()-start;
   const prompt=`请调用记忆搜索查找 ${needle}，只告诉我其校准常数。不得猜测，不要联网。`;const offset=requests.length;const turnStart=Date.now();
   await send(prompt);await foregroundDone();const h=await history(),u=h.messages.filter(m=>m.role==='user').at(-1),reply=h.messages.filter(m=>m.role==='assistant'&&m.requestId===u.requestId).at(-1);
   assert.equal(reply?.status,'completed');const wire=requests.slice(offset).filter(r=>(r.messages||[]).some(m=>m.role==='user'&&(typeof m.content==='string'?m.content===prompt:Array.isArray(m.content)&&m.content.some(p=>p.type==='text'&&p.text===prompt))));
   assert(wire.length);assert(reply.text.includes(answer));assert(wire.some(r=>JSON.stringify(r).includes(answer)));assert(wire.some(r=>(r.messages||[]).some(m=>(m.tool_calls||[]).some(t=>t.function?.name==='memory_search'))));
   Object.assign(row,{status:'passed',output:reply.text,requestId:u.requestId,conversationId:h.conversationId,providerCalls:requests.length-offset,foregroundProviderCalls:wire.length,turnElapsedMs:Date.now()-turnStart});
  }catch(e){row.status='failed';row.error=String(e.stack||e);}row.elapsedMs=Date.now()-start;console.log(JSON.stringify(row));
 }
 report.failedCases=report.cases.filter(x=>x.status!=='passed');report.unverified=[...(report.unverified||[]),'Controlled IPC seeded records, not model learning; real embedding quality not exercised; no new product edits'];
 const shot=await rpc('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'memory-scale-live.png'),Buffer.from(shot.data,'base64'));
 assert.equal(report.failedCases.length,0);report.checks.push('real Electron foreground memory_search retrieves oldest eligible facts at 5000 and 10000 records in separate Bots');
};
