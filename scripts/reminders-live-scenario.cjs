const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
exports.run=async({send,foregroundDone,until,evaluate,history,rpc,report,requests,out,home,botId,restart})=>{
 const wait=ms=>new Promise(r=>setTimeout(r,ms));
 const jobs=()=>evaluate('window.api.cron.list()');
 const notes=()=>evaluate('window.api.notification.list({limit:100})');
 const initialWorks=(await evaluate('window.api.botWork.listWorks(true)')).length;
 report.scenarios=[];
 const record=(name,data)=>{report.scenarios.push({name,...data});fs.writeFileSync(path.join(out,'reminder-progress.json'),JSON.stringify(report.scenarios,null,2));};
 const locate=async title=>{const found=(await jobs()).filter(j=>j.name.includes(title));assert.equal(found.length,1,`one reminder ${title}`);assert(found[0].reminder);return found[0];};
 const delivered=async(id,count=1)=>{await until(async()=>(await notes()).filter(n=>n.sourceId===id&&n.type==='reminder.due').length>=count,'due reminder '+id);return(await notes()).filter(n=>n.sourceId===id&&n.type==='reminder.due');};
 const request=async text=>{await send(text);await foregroundDone();report.history=await history();};
 // 1 Real 120 seconds from the persisted user input, not a shortened timer.
 await request('2分钟后提醒我喝水，提醒名称“喝水实测”，内容“该喝水了”。这是一次提醒，不要创建执行任务。');
 let j=await locate('喝水实测');let input=(await history()).messages.filter(m=>m.role==='user').at(-1);
 assert.equal(Date.parse(j.scheduleExpr),input.createdAt+120000);
 let baseline=requests.length;const water=await delivered(j.id);assert.equal(requests.length,baseline,'due notification does not call model');
 assert((await history()).messages.some(m=>m.text.startsWith('⏰')&&m.text.includes('该喝水了')));
 record('两分钟一次提醒',{id:j.id,requestedAt:input.createdAt,dueAt:Date.parse(j.scheduleExpr),shownAt:water[0].createdAt,modelCallsAtDelivery:0});
 // 2 Repeating reminders with natural pause, no Work creation.
 await request('每20秒提醒我起身活动，名称“活动实测”，内容“起身活动一下”，直到我暂停。');
 j=await locate('活动实测');assert.equal(j.scheduleType,'every');const repeatNotes=await delivered(j.id,2);
 await request(`暂停活动实测提醒（${j.id}），不要取消别的提醒。`);assert.equal((await locate('活动实测')).enabled,false);
 record('重复提醒与暂停',{id:j.id,deliveries:repeatNotes.length});
 // 3 Change existing timing; do not create a second reminder.
 await request('2分钟后提醒我检查资料，名称“改期实测”，内容“检查资料”。');j=await locate('改期实测');const oldDue=Date.parse(j.scheduleExpr);
 await request(`把改期实测 ${j.id} 改成从现在起20秒后提醒，保持同一个提醒。`);let updated=await locate('改期实测');assert.equal(updated.id,j.id);assert(Date.parse(updated.scheduleExpr)<oldDue);
 await delivered(j.id);record('改期不重复',{id:j.id,oldDue,newDue:Date.parse(updated.scheduleExpr)});
 // 4 Cancel before due and prove absence afterward.
 await request('45秒后提醒我查看快递，名称“取消实测”，内容“查看快递”。');j=await locate('取消实测');const cancelDue=Date.parse(j.scheduleExpr);
 await request(`取消取消实测这个提醒 ${j.id}。`);assert.equal((await locate('取消实测')).enabled,false);
 await wait(Math.max(1000,cancelDue-Date.now()+1500));assert(!(await notes()).some(n=>n.sourceId===j.id));record('取消不误发',{id:j.id});
 // 5 Reminder should arrive even during a foreground response, no dependency on task busy.
 await request('30秒后提醒我休息，名称“并发实测”，内容“先休息一下”。');j=await locate('并发实测');
 await send('请详细写一篇关于事件循环和线程池差别的教程，至少1800字，分8节，直接回答不要调用工具。');
 const busyNotes=await delivered(j.id);await foregroundDone();record('提醒与前台回复并行',{id:j.id,shownAt:busyNotes[0].createdAt});
 // 6 Normal application shutdown across deadline; not fault/crash injection.
 await request('40秒后提醒我恢复工作，名称“恢复实测”，内容“恢复工作”。');j=await locate('恢复实测');
 await restart(45000);const recovered=await delivered(j.id);assert(recovered[0].body.includes('原定'));
 record('正常退出跨期恢复补发',{id:j.id,dueAt:Date.parse(j.scheduleExpr),shownAt:recovered[0].createdAt});
 // Additional daily schedule and snooze preservation check.
 await request('每天上海时间上午9点提醒我查看日程，名称“每日实测”，内容“查看今天日程”。');j=await locate('每日实测');assert.equal(j.scheduleType,'cron');assert.equal(j.timezone,'Asia/Shanghai');const original=j.scheduleExpr;
 await request(`每日实测 ${j.id} 这次先过15秒再提醒，以后的每天9点不变。`);updated=await locate('每日实测');assert.equal(updated.scheduleExpr,original);assert.equal(updated.scheduleType,'cron');await delivered(j.id);
 await request(`取消每日实测 ${j.id}。`);record('每日提醒与稍后保留周期',{id:j.id,cron:original});
 assert.equal((await evaluate('window.api.botWork.listWorks(true)')).length,initialWorks,'no reminder Work');
 report.history=await history();report.reminders=await jobs();report.notifications=await notes();
 for(const width of [1280,390]){await rpc('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await wait(200);assert(await evaluate('document.documentElement.scrollWidth<=innerWidth+1'));const shot=await rpc('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'reminders-'+width+'.png'),Buffer.from(shot.data,'base64'));}
 // Supplemental management UI: existing automation page, real edit/save and paused preview.
 await rpc('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
 await evaluate(`import('/src/store/appStore.ts').then(m=>m.useAppStore.getState().setPage('automation'))`);
 await until(async()=>await evaluate(`!![...document.querySelectorAll('.auto-row-main')].find(e=>e.textContent.includes('活动实测'))`),'reminder in existing automation page');
 await evaluate(`[...document.querySelectorAll('.auto-row-main')].find(e=>e.textContent.includes('活动实测')).click()`);
 await until(async()=>await evaluate(`!!document.querySelector('.auto-form-container')`),'reminder edit form');
 assert(await evaluate(`[...document.querySelectorAll('.auto-field')].filter(e=>['任务类型','工作目录'].includes(e.querySelector('.auto-field-label')?.textContent)).every(e=>getComputedStyle(e).display==='none')`));
 assert(await evaluate(`document.body.innerText.includes('提醒内容（到时直接发送）')`));
 await evaluate(`(()=>{const e=document.querySelector('input[placeholder="给自动化任务起个名字"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(e,'活动实测编辑');e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
 await evaluate(`[...document.querySelectorAll('.auto-form-top-actions button')].find(e=>e.textContent.trim()==='保存').click()`);
 await until(async()=>(await jobs()).some(j=>j.name==='活动实测编辑'),'UI saved');
 const edited=(await jobs()).find(j=>j.name==='活动实测编辑');assert.equal(edited.scheduleType,'every');assert.equal(edited.scheduleExpr,'20s');assert.equal(edited.enabled,false);
 const shot=await rpc('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'reminder-management.png'),Buffer.from(shot.data,'base64'));
 report.checks.push('Existing automation UI edit/save preserved paused state and 20-second interval; irrelevant task fields hidden');
 report.checks.push('7 real model scenario types; actual 120s reminder; repeat/pause, reschedule, cancel, foreground concurrent, normal offline recovery, daily and snooze; direct Bot message + persisted notification, no Work');
};
