const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
exports.run=async ({send,foregroundDone,until,evaluate,history,rpc,report,requests,home,out,botId})=>{
 const fixtures=await require('./bot-attachment-fixtures.cjs').create(path.join(home,'user-documents'));
 report.cases=[];
 for(const item of fixtures){
  // Seed a user-selected fixture into the existing composer, then click its real send UI.
  // This does not validate the OS file picker; all snapshot/extraction/runtime code is real.
  await evaluate(`import('/src/store/appStore.ts').then(m=>{const s=m.useAppStore.getState();s.setBotAttachments(${JSON.stringify(botId)},[${JSON.stringify({name:item.name,path:item.path})}]);})`);
  await until(()=>evaluate(`document.querySelector('.bot-composer .input-attach-chips')?.textContent.includes(${JSON.stringify(item.name)})`),'attachment chip');
  const start=Date.now(),offset=requests.length;await send(item.prompt);await foregroundDone();
  const messages=(await history()).messages,answer=messages.filter(x=>x.role==='assistant').at(-1),user=messages.filter(x=>x.role==='user').at(-1);
  assert.equal(answer.requestId,user.requestId);assert.equal(answer.workIds.length,0,'simple document stays frontend');
  for(const pattern of item.expected)assert(new RegExp(pattern,'i').test(answer.text),item.name+': answer factual match '+pattern);
  const native=requests.slice(offset).map(r=>r.messages.slice(r.messages.findLastIndex(m=>m.role==='user')));
  assert(JSON.stringify(native).includes(item.name),'current native request carries attachment');
  assert(user.attachments?.length===1 && user.attachments[0].path!==item.path,'host immutable snapshot persisted');
  const row={name:item.name,prompt:item.prompt,answer:answer.text,elapsedMs:Date.now()-start,modelCalls:requests.length-offset,snapshot:user.attachments[0],expected:item.expected};report.cases.push(row);
  console.log(JSON.stringify(row));
 }
 for(const width of [1280,390]){await rpc('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await new Promise(r=>setTimeout(r,300));assert(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'));const shot=await rpc('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,`attachments-${width}.png`),Buffer.from(shot.data,'base64'));}
 report.checks.push('six real-model document tasks: CSV inventory, JSON configuration, DOCX contract, XLSX expense, PPTX brief, PDF receipt; existing composer + snapshot + extraction + reply, no Work');
};
