const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
exports.run=async({evaluate,history,rpc,until,report,out,botId,agentDir})=>{
 const now=Date.now(); const db=new (require('better-sqlite3'))(path.join(agentDir,'app.db'));
 const conversationId='ui-reminder-conversation';db.prepare('INSERT INTO bot_conversations(conversation_id,bot_id,user_id,created_at,updated_at) VALUES (?,?,?,?,?)').run(conversationId,botId,'user-local-primary',now,now);db.close();
 const target={kind:'bot-reminder',userId:'user-local-primary',botId,conversationId,state:'scheduled'};
 const fixture={id:'ui-reminder-precision',name:'精确时间',prompt:'不提前提醒',scheduleType:'at',scheduleExpr:new Date(now+600123).toISOString(),timezone:'Asia/Shanghai',enabled:true,createdAt:now,updatedAt:now,reminder:target};
 await evaluate(`window.api.cron.upsert(${JSON.stringify(fixture)})`);
 await evaluate(`import('/src/store/appStore.ts').then(m=>m.useAppStore.getState().setPage('automation'))`);
 const edit=async(name,newName)=>{
 await until(()=>evaluate(`!![...document.querySelectorAll('.auto-row-main')].find(e=>e.textContent.includes(${JSON.stringify(name)}))`),'reminder row');
 await evaluate(`[...document.querySelectorAll('.auto-row-main')].find(e=>e.textContent.includes(${JSON.stringify(name)})).click()`);
 await until(()=>evaluate(`!!document.querySelector('.auto-form-container')`),'edit form');
 if(await evaluate('innerWidth===390')){
  assert(await evaluate(`document.querySelector('.auto-form-container').scrollWidth<=document.querySelector('.auto-form-container').clientWidth+1`),'narrow edit overflow');
  assert(await evaluate(`[...document.querySelectorAll('.auto-form-top-actions button')].every(e=>e.getBoundingClientRect().right<=innerWidth+1)`),'save/cancel visible');
  const shot=await rpc('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'management-form-390.png'),Buffer.from(shot.data,'base64'));
 }
 assert(await evaluate(`[...document.querySelectorAll('.auto-field')].filter(e=>['任务类型','工作目录'].includes(e.querySelector('.auto-field-label')?.textContent)).every(e=>getComputedStyle(e).display==='none')`));
 await evaluate(`(()=>{const e=document.querySelector('input[placeholder="给自动化任务起个名字"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(newName)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 await evaluate(`[...document.querySelectorAll('.auto-form-top-actions button')].find(e=>e.textContent.trim()==='保存').click()`);
 await until(async()=>(await evaluate('window.api.cron.list()')).some(j=>j.name===newName),'save name');
 };
 await edit('精确时间','精确时间改名');let jobs=await evaluate('window.api.cron.list()');assert.equal(jobs.find(j=>j.id===fixture.id).scheduleExpr,fixture.scheduleExpr);
 const past={...fixture,id:'ui-reminder-past',name:'过去已提醒',enabled:false,scheduleExpr:new Date(now-30000).toISOString(),reminder:{...target,state:'delivered'}};
 await evaluate(`window.api.cron.upsert(${JSON.stringify(past)})`);await edit('过去已提醒','过去已提醒改名');jobs=await evaluate('window.api.cron.list()');assert.equal(jobs.find(j=>j.id===past.id).scheduleExpr,past.scheduleExpr);assert.equal(jobs.find(j=>j.id===past.id).enabled,false);
 const repeat={...fixture,id:'ui-reminder-repeat',name:'暂停秒周期',enabled:false,scheduleType:'every',scheduleExpr:'20s',reminder:{...target,state:'paused'}};
 await evaluate(`window.api.cron.upsert(${JSON.stringify(repeat)})`);await edit('暂停秒周期','暂停秒周期改名');jobs=await evaluate('window.api.cron.list()');assert.equal(jobs.find(j=>j.id===repeat.id).scheduleExpr,'20s');assert.equal(jobs.find(j=>j.id===repeat.id).enabled,false);
 const daily={...fixture,id:'ui-reminder-daily',name:'每日9点',scheduleType:'cron',scheduleExpr:'0 9 * * *'};await evaluate(`window.api.cron.upsert(${JSON.stringify(daily)})`);await until(()=>evaluate(`document.body.innerText.includes('每天 09:00 · Asia/Shanghai')`),'daily cron label');
 report.checks.push('real renderer edit/save: unchanged one-time timestamp retains milliseconds; past delivered reminder editable without rescheduling; paused 20-second recurrence retained; irrelevant task fields hidden');
 for(const width of [1280,720,390]){
  await rpc('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
  await new Promise(r=>setTimeout(r,250));
  assert(await evaluate(`document.querySelector('.auto-root').scrollWidth<=document.querySelector('.auto-root').clientWidth+1`),'automation overflow '+width);
  if(width<=720){
   assert(await evaluate(`!!document.querySelector('button[aria-label="打开主导航"]')`));
   await evaluate(`document.querySelector('button[aria-label="打开主导航"]').click()`);
   await until(()=>evaluate(`!!document.querySelector('dialog[aria-label="主导航"][open]')`),'navigation drawer');
   assert(await evaluate(`document.querySelector('.auto-root').getBoundingClientRect().width>=innerWidth-2`),'drawer must overlay not squeeze content');
   await evaluate(`document.querySelector('dialog[open] button[title="收起侧边栏"]').click()`);
   await until(()=>evaluate(`!document.querySelector('dialog[aria-label="主导航"][open]')`),'close drawer');
   assert(await evaluate(`[...document.querySelectorAll('.auto-row-actions')].every(e=>getComputedStyle(e).display!=='none')`),'touch actions visible');
   await evaluate(`document.querySelector('.auto-row button[title="更多"]').click()`);
   assert(await evaluate(`document.querySelector('.auto-row-menu').getBoundingClientRect().right<=innerWidth+1`),'menu fits');
   await evaluate(`document.querySelector('.auto-row button[title="更多"]').click()`);
  }
  const shot=await rpc('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'management-'+width+'.png'),Buffer.from(shot.data,'base64'));
 }
 await edit('精确时间改名','窄屏保存成功');
 assert(await evaluate(`document.querySelector('.auto-root').scrollWidth<=document.querySelector('.auto-root').clientWidth+1`));
 report.checks.push('1280/720/390 no automation overflow; existing drawer overlays content and closes; touch actions/menu accessible; 390px edit/save succeeds');
};
