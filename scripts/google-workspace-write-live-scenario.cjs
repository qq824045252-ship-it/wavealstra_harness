const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),cp=require('node:child_process');
exports.seed=(home,root)=>{
  const dir=path.join(home,'.local/share/gws'),bin=path.join(home,'.local/bin');fs.mkdirSync(dir,{recursive:true});fs.mkdirSync(bin,{recursive:true});
  fs.copyFileSync(path.join(root,'scripts/google-workspace-write-fixture.py'),path.join(dir,'gws.py'));
  fs.writeFileSync(path.join(dir,'isolated-fixture-marker'),'no network or credentials');
  fs.writeFileSync(path.join(dir,'fixture-state.json'),JSON.stringify({sent:[],events:{original731:{id:'original731',etag:'"v1"',summary:'原会议 ORIGINAL_731',start:{dateTime:'2026-11-15T09:00:00+08:00',timeZone:'Asia/Shanghai'},end:{dateTime:'2026-11-15T10:00:00+08:00',timeZone:'Asia/Shanghai'},description:'保留说明 KEEP_731',location:'保留地点',attendees:[]}}}));
  const python=cp.execFileSync('which',['python3'],{encoding:'utf8'}).trim();
  fs.writeFileSync(path.join(bin,'gws'),`#!/bin/sh\nexec '${python}' '${path.join(dir,'gws.py')}' "$@"\n`,{mode:0o700});
};
exports.run=async({send,foregroundDone,until,evaluate,history,rpc,report,requests,out,home})=>{
  const dir=path.join(home,'.local/share/gws');
  const state=()=>JSON.parse(fs.readFileSync(path.join(dir,'fixture-state.json'),'utf8'));
  const audit=()=>fs.existsSync(path.join(dir,'fixture-audit.jsonl'))?fs.readFileSync(path.join(dir,'fixture-audit.jsonl'),'utf8').trim().split('\n').filter(Boolean).map(JSON.parse):[];
  const writeCount=()=>audit().filter(r=>['send','insert','patch'].includes(r.action)).length;
  const cases=[
    ['只起草不发送','请给 alice@example.test 起草一封邮件，主题“草稿 DRAFT_731”，正文说明星期五前核对合同。只写草稿，不能发送或创建后台任务。',()=>assert.equal(writeCount(),0)],
    ['明确发送邮件','请现在发送纯文本邮件给 alice@example.test，主题“SEND_731”，正文“收到，我会在星期五前核对合同。”。直接发送，不需要再问确认，不创建后台任务。',()=>{assert.equal(state().sent.length,1);assert.equal(state().sent[0].subject,'SEND_731');assert.equal(state().sent[0].to,'alice@example.test');}],
    ['创建定时日程','请在我的主日历创建“TIMED_731”，2026-11-15上海时间14:00到15:00，无来宾，不发送邀请。直接创建，不重复确认，不创建后台任务。',()=>assert(Object.values(state().events).some(e=>e.summary==='TIMED_731'&&e.start.dateTime.includes('14:00')))],
    ['创建全天日程','请在主日历创建全天安排“ALLDAY_WRITE_731”，2026-11-16当天，只有这一天，没有来宾。直接创建，无需重复确认或后台任务。',()=>{const e=Object.values(state().events).find(e=>e.summary==='ALLDAY_WRITE_731');assert.equal(e.start.date,'2026-11-16');assert.equal(e.end.date,'2026-11-17');}],
    ['修改已知日程','请读取主日历事件original731的最新内容，然后只把标题改为“UPDATED_731”，其他时间、说明、地点保持不变。没有来宾，不通知任何人。直接修改，不重复确认或后台任务。',()=>{const e=state().events.original731;assert.equal(e.summary,'UPDATED_731');assert.equal(e.description,'保留说明 KEEP_731');assert.equal(e.start.dateTime,'2026-11-15T09:00:00+08:00');}],
    ['创建带邀请日程','请在主日历创建“INVITE_731”，2026-11-17上海时间10:00到11:00，邀请 bob@example.test，并发送邀请通知。直接执行，不重复确认或后台任务。',()=>{const e=Object.values(state().events).find(e=>e.summary==='INVITE_731');assert.equal(e.attendees[0].email,'bob@example.test');assert(audit().some(r=>r.action==='insert'&&r.args.body.summary==='INVITE_731'&&r.args.sendUpdates==='all'));}],
  ];
  report.cases=[];
  for(const[label,prompt,verify]of cases){const offset=requests.length,start=Date.now();await send(prompt);await foregroundDone();verify();const answer=(await history()).messages.filter(r=>r.role==='assistant').at(-1);assert.equal(answer.workIds.length,0);const item={label,answer:answer.text,modelCalls:requests.length-offset,elapsedMs:Date.now()-start};report.cases.push(item);console.log(JSON.stringify(item));}
  // Actual Electron write UI follows, with explicit user submit to synthetic service.
  await evaluate(`import('/src/store/appStore.ts').then(m=>m.useAppStore.getState().setPage('mailbox'))`);
  await until(()=>evaluate(`!!document.querySelector('#workspace-mail')`),'mailbox page');
  const click=text=>evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(text)}).click()`);
  const field=(name,value)=>evaluate(`(()=>{const e=document.querySelector('.workspace-compose [name="'+${JSON.stringify(name)}+'"]');Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  const submitTwice=()=>evaluate(`(()=>{const form=document.querySelector('.workspace-compose');form.requestSubmit();form.requestSubmit();})()`);
  const screenshot=async name=>{
    fs.writeFileSync(path.join(out,name),Buffer.from((await rpc('Page.captureScreenshot',{format:'png'})).data,'base64'));
    await evaluate(`document.querySelector('.workspace-compose [role="status"]')?.scrollIntoView({block:'center'})`);
    fs.writeFileSync(path.join(out,name.replace('.png','-receipt.png')),Buffer.from((await rpc('Page.captureScreenshot',{format:'png'})).data,'base64'));
  };
  let count=writeCount();await click('撰写邮件');await field('to','alice@example.test');await field('subject','CANCELLED_UI');await field('body','Do not send');await click('取消');assert.equal(writeCount(),count);
  await click('撰写邮件');await field('to','alice@example.test');await field('subject','UI_SEND_731');await field('body','UI synthetic mail');await submitTwice();
  await until(()=>evaluate(`document.querySelector('.workspace-compose')?.textContent.includes('邮件已发送')`),'UI send receipt');assert.equal(writeCount(),count+1);await screenshot('mail-send.png');await click('完成');
  await click('新建日程');await field('title','UI_EVENT_731');await field('start','2026-11-18T10:00+08:00');await field('end','2026-11-18T11:00+08:00');await field('description','KEEP_UI_731');await submitTwice();
  await until(()=>evaluate(`document.querySelector('.workspace-compose')?.textContent.includes('日程已保存')`),'UI event receipt');assert.equal(writeCount(),count+2);await screenshot('calendar-create.png');await click('完成');
  await click('Google 日历');await click('查询日程');await until(()=>evaluate(`document.body.textContent.includes('UI_EVENT_731')`),'UI event list');
  await evaluate(`[...document.querySelectorAll('article')].find(a=>a.querySelector('h3')?.textContent==='UI_EVENT_731').querySelector('button').click()`);
  await until(()=>evaluate(`document.querySelector('.workspace-compose [name="title"]')?.value==='UI_EVENT_731'`),'fresh event editor');
  await field('location','UPDATED_UI_LOCATION');await submitTwice();await until(()=>evaluate(`document.querySelector('.workspace-compose')?.textContent.includes('日程已保存')`),'UI edit receipt');
  assert.equal(writeCount(),count+3);const updated=Object.values(state().events).find(e=>e.summary==='UI_EVENT_731');assert.equal(updated.location,'UPDATED_UI_LOCATION');assert.equal(updated.description,'KEEP_UI_731');assert.equal(updated.start.dateTime,'2026-11-18T10:00:00+08:00');await screenshot('calendar-update.png');await click('完成');
  report.checks.push('Actual Electron write forms: cancel no write, duplicate submit single effect, mail receipt, timed create, fresh-etag changed-fields-only update and unchanged description/time preserved');
  report.checks.push('Six distinct real-model intent tasks execute production native tools/bridge against isolated Python SDK fixture; no real external writes');
  // Fault injection last: SDK commits synthetic mail then process disappears before receipt.
  fs.writeFileSync(path.join(dir,'unknown-outcome'),'simulate post-send response loss');
  await evaluate(`import('/src/store/appStore.ts').then(m=>m.useAppStore.getState().setPage('bot'))`);await until(()=>evaluate(`!!document.querySelector('#bot-draft')`),'bot again');
  const before=state().sent.length,offset=requests.length;
  await send('请现在发送纯文本邮件给 alice@example.test，主题“UNKNOWN_731”，正文“仅这一次测试回执”。只发送一次，不创建后台任务。');await foregroundDone();
  assert.equal(state().sent.length,before+1,'post-send lost response must not resend');
  const answer=(await history()).messages.filter(r=>r.role==='assistant').at(-1);assert(/不确定|不能确定|尚未确认|结果不明|结果未知|无法确认|未确认/.test(answer.text),'unknown outcome honest');assert.equal(answer.workIds.length,0);
  report.cases.push({label:'最后注入发送回执丢失',answer:answer.text,modelCalls:requests.length-offset});
  report.checks.push('Post-send response loss is unknown, never retried; only one synthetic side effect, no auth expansion or production credentials');
};
