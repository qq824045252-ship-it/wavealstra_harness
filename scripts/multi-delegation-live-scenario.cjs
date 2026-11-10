const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
exports.run=async({send,until,evaluate,history,rpc,report,requests,rawUsageAudit,agentDir,out,home,modelKey,botId})=>{
 const seed=crypto.randomBytes(6).toString('hex');
 const owner=(await evaluate('window.api.botWork.listBots()')).find(b=>b.botId===botId);
 assert((await evaluate(`window.api.botWork.updateWorkspaceAuthorization(${JSON.stringify({botId,expectedUpdatedAt:owner.updatedAt,allowWorkspaceFiles:true,confirmNewWorksOnly:true})})`)).ok);
 const specs=[
  {id:'M1',kind:'foreground',prompt:'M1 独立计算：137×29等于多少？只返回答案，不用工具不创建Work。',expected:'3973'},
  {id:'M2',kind:'foreground',prompt:'M2 独立翻译：把“苹果”译成英文。只返回英文单词，不用工具不创建Work。',expected:'apple'},
  {id:'M3',kind:'foreground',prompt:'M3 独立结构化：从“名字林晓，年龄27”提取JSON，只有name与age两个字段；不使用工具不创建Work。',expected:'林晓'},
  {id:'M4',kind:'work',title:'文件委托-'+seed,filename:'evidence-'+seed+'.txt',expected:'EVIDENCE_'+seed,
   prompt:`M4 请立即创建一次性后台Work，标题“文件委托-${seed}”。在实际工作目录创建 evidence-${seed}.txt，内容严格为 EVIDENCE_${seed}，用read回读并汇报完整路径及原文。必须真实写文件，不要只提供方法。不要等待其他委托，不要持续追踪。`},
  {id:'M5',kind:'work',title:'数据委托-'+seed,filename:'sales-'+seed+'.json',expected:'184',
   prompt:`M5 请立即创建一次性后台Work，标题“数据委托-${seed}”。数据单价/数量是(12,3),(25,4),(8,6)，计算销售总额，在实际工作目录创建 sales-${seed}.json，内容为JSON {"total":正确总额}；实际read回读核对并汇报。独立执行，不要等待别的委托，不要持续追踪。`},
  {id:'M6',kind:'work',title:'计划委托-'+seed,expected:'厨房',
   prompt:`M6 请立即创建一次性后台Work，标题“计划委托-${seed}”。交付三行周末整理计划，分别厨房、书桌、卧室，每行一个具体行动，不写文件。不等待其他委托，不需要用户再确认，不要持续追踪。`}
 ];
 const accepted=[];
 for(const spec of specs){const submittedAt=Date.now();await send(spec.prompt);const msg=(await history()).messages.filter(m=>m.role==='user').at(-1);assert(msg?.requestId);accepted.push({...spec,requestId:msg.requestId,submittedAt,acceptedAt:Date.now()});}
 report.accepted=accepted;report.inflightAfterSubmission=(await history()).messages.filter(m=>m.role==='assistant').map(m=>({requestId:m.requestId,status:m.status}));
 await until(async()=>{const h=await history();return accepted.every(s=>h.messages.some(m=>m.role==='assistant'&&m.requestId===s.requestId&&['completed','failed','unknown','cancelled'].includes(m.status)));},'all six foreground receipts settle independently');
 const h=await history();report.history=h;
 for(const spec of accepted.filter(s=>s.kind==='foreground')){const answer=h.messages.find(m=>m.role==='assistant'&&m.requestId===spec.requestId);assert.equal(answer.status,'completed',spec.id);assert(answer.text.toLowerCase().includes(spec.expected.toLowerCase()),spec.id+' exact result');}
 await until(async()=>{const works=await evaluate('window.api.botWork.listWorks(true)');report.works=works;return specs.filter(s=>s.kind==='work').every(s=>works.some(w=>w.title===s.title&&w.lifecycle==='closed'));},'all three Work delegations settle');
 const works=await evaluate('window.api.botWork.listWorks(true)');report.works=works;assert.equal(works.length,3,'no duplicate or conflated Work');
 for(const spec of accepted.filter(s=>s.kind==='work')){
  const w=works.find(w=>w.title===spec.title);assert.equal(w.closureConclusion,'succeeded',spec.id+' true completion');
  const receipt=(await history()).messages.find(m=>m.role==='assistant'&&m.requestId===spec.requestId);assert(receipt.workIds.includes(w.workId),spec.id+' original request links own Work');
  const feedback=(await history()).messages.filter(m=>m.workFeedback?.workId===w.workId&&m.workFeedback?.kind==='result');assert(feedback.length>0,spec.id+' returned result');
  assert(JSON.stringify(feedback).includes(spec.expected),spec.id+' result content correct');
  if(spec.filename){const outputs=[];const walk=d=>{for(const entry of fs.readdirSync(d,{withFileTypes:true})){const file=path.join(d,entry.name);if(entry.isDirectory())walk(file);else if(entry.name===spec.filename)outputs.push(file)}};walk(home);assert.equal(outputs.length,1,spec.id+' actual one output');const contents=fs.readFileSync(outputs[0],'utf8');if(spec.id==='M5')assert.equal(JSON.parse(contents).total,184);else assert.equal(contents,spec.expected);spec.disk={file:outputs[0],contents};}
 }
 const raw=rawUsageAudit.map(a=>({requestIndex:a.requestIndex,start:a.requestStartedAt,end:a.endedAt,requestId:requests[a.requestIndex]?.messages?.filter(m=>m.role==='user').reverse().map(m=>accepted.find(s=>JSON.stringify(m.content).includes(s.prompt))?.requestId).find(Boolean)}));
 report.providerIntervals=raw;
 report.overlapPairs=raw.flatMap((a,i)=>raw.slice(i+1).filter(b=>a.requestId&&b.requestId&&a.requestId!==b.requestId&&a.end&&b.end&&a.start<b.end&&b.start<a.end).map(b=>[a.requestIndex,b.requestIndex]));
 assert(report.overlapPairs.length>0,'actual upstream requests overlap, not only queued UI');
 report.history=await history();
 await evaluate(`[...document.querySelectorAll('.bot-thread details')].forEach(d=>{if(!d.open)d.querySelector('summary')?.click()})`);
 for(const w of works){await until(()=>evaluate(`!!document.querySelector('[data-message-id] .bot-message-work-links button')`),'actual Work links');assert(await evaluate(`document.querySelector('.bot-thread').innerText.includes(${JSON.stringify(w.title)})`),'task title visible '+w.title);}
 for(const width of [1280,390]){await rpc('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await evaluate(`document.querySelector('.bot-thread').scrollTop=document.querySelector('.bot-thread').scrollHeight`);await new Promise(r=>setTimeout(r,200));assert(await evaluate('document.documentElement.scrollWidth<=innerWidth'),'no horizontal overflow');const shot=await rpc('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});fs.writeFileSync(path.join(out,'six-delegations-'+width+'.png'),Buffer.from(shot.data,'base64'));}
 report.checks.push('six independently submitted real-model requests; three direct answers and three native Work results; exact file/JSON/prose evidence; no duplicate Work; provider overlaps; visible task-title attribution and 390/1280 layout');
};
