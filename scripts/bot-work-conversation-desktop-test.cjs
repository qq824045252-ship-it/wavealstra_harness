const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'work-conversation-'));app.setPath('userData',path.join(dir,'profile'));
app.whenReady().then(async()=>{let win;try{
 const out=path.resolve('out/tests'),url=n=>pathToFileURL(path.join(out,n)).href;
 fs.writeFileSync(path.join(dir,'index.html'),`<html><meta charset="utf-8"><link rel="stylesheet" href="${url('bot-work-conversation-desktop-fixture.css')}"><style>*{box-sizing:border-box}body{margin:0;font:14px system-ui;color:#222;background:white}#root{height:100vh;display:flex}:root{--surface-right:white;--fg:#222;--fg-secondary:#666;--border-subtle:#eee;--border-default:#ddd;--bg-input:white;--bg-sidebar:#f5f5f5;--accent:#3871ed}h1,h2,h3,p{margin:0}</style><div id="root"></div><script src="${url('bot-work-conversation-desktop-fixture.js')}"></script></html>`);
 const rendererErrors=[];
 win=new BrowserWindow({width:1100,height:900,show:true,webPreferences:{backgroundThrottling:false}});
 win.webContents.on('console-message',event=>{
   console.log('renderer:',event.message);
   if(event.level==='error')rendererErrors.push(event.message);
 });
 await win.loadFile(path.join(dir,'index.html'));
 const ev=async s=>{let timer;try{return await Promise.race([win.webContents.executeJavaScript(s),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Renderer query timed out: '+s)),10000);})]);}finally{clearTimeout(timer);}},wait=async s=>{for(let i=0;i<100;i++){if(await ev(s))return;await new Promise(r=>setTimeout(r,40));}throw Error(s);};
 await wait('document.querySelectorAll("[data-message-id]").length===16');
 assert.deepEqual(rendererErrors,[],'fixture startup must not hide renderer errors');
 assert.equal(await ev('window.detailRequests.length'),0,'initial conversation loads no full Work details');
 await ev(`document.addEventListener('click', e=>{if(e.target.closest('.bot-message-work-links button')) window.beforeDetailScroll=document.querySelector('.bot-thread').scrollTop;}, true)`);
 const stableLayout=async()=>{let last='',same=0;for(let i=0;i<50;i++){const next=await ev(`JSON.stringify([innerWidth,innerHeight,document.querySelector('.bot-thread')?.scrollHeight])`);same=next===last?same+1:0;if(same>=3)return;last=next;await new Promise(r=>setTimeout(r,100));}throw Error('window layout did not settle');};
 const click=async(selector)=>{const r=await ev(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);win.webContents.sendInputEvent({type:'mouseDown',button:'left',x:Math.round(r.x),y:Math.round(r.y),clickCount:1});win.webContents.sendInputEvent({type:'mouseUp',button:'left',x:Math.round(r.x),y:Math.round(r.y),clickCount:1});await new Promise(r=>setTimeout(r,100));};
 const escape=async()=>{win.webContents.sendInputEvent({type:'keyDown',keyCode:'ESC'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'ESC'});};
 if (!process.env.WORK_DETAIL_FOCUS) {
 // Real Bot workspace, with persisted-style request pairs and refreshed snapshots.
 for (const width of [1100,390]) {
  win.setSize(width,900);
  for (const [kind,count] of [["same",1],["queued",1],["running",1],["unknown",1],["failed",1],["cancelled",1],["extra",2],["distinct",2],["partial",1],["different-request",2],["feedback",2],["next-turn",2],["team",1]]) {
   await ev(`window.detailFixture.linkCase(${JSON.stringify(kind)})`);
   await wait(`document.querySelectorAll('.bot-message-work-links button').length===${count}`);
   const snapshot=await ev(`Array.from(document.querySelectorAll('[data-message-id]')).map(e=>({id:e.dataset.messageId,links:e.querySelectorAll('.bot-message-work-links button').length,text:e.textContent}))`);
   assert.equal(snapshot.find(row=>row.id==='link-answer').links, ['extra','distinct','partial','different-request','feedback'].includes(kind)?1:0,kind+' reply link ownership');
   assert(snapshot.find(row=>row.id==='link-answer').text.includes('已开始做，正文保留。'),kind+' independent answer retained');
   assert(await ev('document.documentElement.scrollWidth<=innerWidth+1'),'no link overflow '+width+' '+kind);
  }
  await ev('window.detailFixture.linkCase("same")');await wait(`document.querySelectorAll('.bot-message-work-links button').length===1`);
  await click('[data-message-id="link-user"] .bot-message-work-links button');
  await wait('!!document.querySelector(".bot-work-conversation-detail")');
  await click('.bot-work-conversation-breadcrumb button');
  await wait('!document.querySelector(".bot-work-conversation-detail")');
  assert.equal(await ev('document.querySelectorAll(".bot-message-work-links button").length'),1,'back does not duplicate cards');
  await ev('window.detailFixture.linkCase("same")');
  await wait(`document.querySelectorAll('[data-message-id]').length===2`);
  assert.equal(await ev('document.querySelectorAll(".bot-message-work-links button").length'),1,'reconnect snapshot remains deduplicated');
  fs.writeFileSync(path.join(out,`bot-work-link-dedup-${width}.png`),(await win.webContents.capturePage()).toPNG());
 }
 await ev('window.detailFixture.original()');await wait(`document.querySelectorAll('[data-message-id]').length===16`);
 console.log('PASS Work-link UI: 13 states/cases, 2 widths, same-title distinct IDs, refresh/reconnect, preserved body, input-card click/back.');
 for(const width of [1100,760,390]){
  win.setSize(width,900);await stableLayout();
  await ev(`document.querySelector('[data-message-id="m4"] .bot-message-work-links button').scrollIntoView({block:'center'})`);await new Promise(r=>setTimeout(r,100));
  await click('[data-message-id="m4"] .bot-message-work-links button');
  // Native click helper may reposition/focus the target; preserve the viewport
  // at the actual click, not before a second scrollIntoView.
  const before=await ev('window.beforeDetailScroll');
  await wait('!!document.querySelector(".bot-work-conversation-detail")');
  assert(await ev('document.querySelector(".bot-thread").hidden'));
  assert(await ev('!document.querySelector("dialog[open]")'),'no blocking side overlay');
  assert(await ev('document.documentElement.scrollWidth<=innerWidth+1'),'no horizontal overflow '+width);
  await click('[aria-label="过程与依据"] > summary');
  await click('[aria-label="全部生成文件"] > summary');
  await click('[aria-label="全部生成文件"] .bot-result-files button');
  await wait(`window.detailEvents.at(-1)==='/saved/report-v1.md'`);
  assert.equal((await ev('window.detailEvents')).at(-1),'/saved/report-v1.md');
  assert(await ev('document.querySelector(".bot-work-conversation-header").getBoundingClientRect().top>=0'),'back remains visible');
  fs.writeFileSync(path.join(out,`bot-work-conversation-${width}.png`),(await win.webContents.capturePage()).toPNG());
  await click('.bot-work-conversation-breadcrumb button');
  await wait('!document.querySelector(".bot-work-conversation-detail")');
  assert(Math.abs((await ev('document.querySelector(".bot-thread").scrollTop'))-before)<2,'return scroll position');
  assert(await ev('document.activeElement.closest("[data-message-id]").dataset.messageId==="m4"'),'return focus');
 }
 await ev('window.detailFixture.selectWork()');await wait('!!document.querySelector(".bot-work-conversation-detail")');
 await ev('window.detailFixture.update()');
 await wait('document.querySelector(".bot-work-detail-heading .bot-work-status").textContent.includes("已完成")');
 await ev('window.detailFixture.remove()');await wait('document.querySelector(".bot-work-conversation-body").textContent.includes("已不可用")');
 await click('[aria-label="关闭事项详情并返回对话"]');await ev('window.detailFixture.reset()');
 await click('[data-message-id="m5"] .bot-message-work-links button');
 await new Promise(r=>setTimeout(r,100));assert(await ev('document.querySelector(".bot-work-conversation-body").textContent.includes("正在读取")'),'superseded refresh does not falsely reject');
 await ev('window.detailFixture.resolve()');await wait('!!document.querySelector(".bot-work-conversation-detail")');
 await click('.bot-work-conversation-breadcrumb button');await ev('window.detailFixture.reset()');
 await click('[data-message-id="m5"] .bot-message-work-links button');await ev('window.detailFixture.switchTeam();window.detailFixture.resolve()');
 await new Promise(r=>setTimeout(r,100));assert(await ev('!document.querySelector(".bot-work-conversation-detail")'),'late historic fetch cannot open another team');
 await ev('window.detailFixture.reset()');await new Promise(r=>setTimeout(r,100));
 await click('[data-message-id="m6"] .bot-message-work-links button');
 await wait('document.querySelector(".bot-work-conversation-body").textContent.includes("已不可用")');
 assert(await ev('!document.querySelector(".bot-work-details")'),'missing ID cannot open foreign data');
 await click('.bot-work-conversation-breadcrumb button');
 await ev('window.detailFixture.blocked()');
 await click('.bot-view-tabs button:nth-child(2)');await click('.bot-work-card');
 await wait('!!document.querySelector(".bot-work-conversation-detail")');
 await ev(`[...document.querySelectorAll('.bot-work-conversation-detail button')].find(b=>b.textContent==='回复此问题').click()`);
 await wait('!document.querySelector(".bot-work-conversation-detail") && document.querySelector("#bot-draft").value.includes("补充原始文件")');
 assert(await ev('!document.querySelector(".bot-composer").hidden'),'reply from list retains editable composer');
 await ev('window.detailFixture.team()');await wait(`!!document.querySelector('[data-message-id="m4"] .bot-message-work-links button')`);
 await click('[data-message-id="m4"] .bot-message-work-links button');
 await wait('document.querySelector(".bot-work-detail-heading h2")?.textContent === "临时学习团队的报告"');
 assert(await ev('document.querySelector(".bot-heading h1").textContent === "MyBuddy"'),'source personal conversation retained');
 fs.writeFileSync(path.join(out,'bot-linked-team-detail.png'),(await win.webContents.capturePage()).toPNG());
 const teamScroll=await ev('window.beforeDetailScroll');
 await click('.bot-work-conversation-breadcrumb button');
 await wait('!document.querySelector(".bot-work-conversation-detail")');
 assert(Math.abs((await ev('document.querySelector(".bot-thread").scrollTop'))-teamScroll)<2,'team return restores source scroll');
 await click('.bot-view-tabs button:nth-child(2)');
 assert(await ev('document.querySelector(".bot-work-browser") && !document.querySelector(".bot-work-browser").textContent.includes("临时学习团队的报告")'),'team not added to personal list/count');
 await ev('window.detailFixture.otherBot()'); await new Promise(r=>setTimeout(r,150));
 await click('[data-message-id="m4"] .bot-message-work-links button');
 await wait('document.querySelector(".bot-work-conversation-body")?.textContent.includes("已不可用")');
 assert(await ev('document.querySelector(".bot-work-conversation-body").textContent.includes("已不可用")'),'unrelated Bot cannot inspect via copied work ID');
 await click('.bot-work-conversation-breadcrumb button');
 await ev('window.detailFixture.team()'); await new Promise(r=>setTimeout(r,150));
 await ev('window.detailFixture.otherConversation();window.detailFixture.selectLinked()');await new Promise(r=>setTimeout(r,150));
 assert(await ev('document.querySelector(".bot-work-conversation-body").textContent.includes("已不可用")'),'new conversation cannot expose former linked work');
 await click('.bot-work-conversation-breadcrumb button');
 // Every list entry must use the same inline detail, preserving the mounted list.
 const listSnapshot = `(()=>{const b=document.querySelector('.bot-work-browser');return {query:b.querySelector('input[type=search]').value,sort:b.querySelector('select').value,filter:b.querySelector('.bot-work-filters [aria-pressed=true]')?.textContent,page:b.querySelector('.bot-work-pagination span')?.textContent,ids:[...b.querySelectorAll('.bot-work-card')].map(e=>e.dataset.workId),scroll:b.scrollTop}})()`;
 await ev(`document.addEventListener('click',e=>{if(e.target.closest('.bot-work-card')) {window.listBefore=${listSnapshot};window.listNode=document.querySelector('.bot-work-browser');window.listTrigger=e.target.closest('.bot-work-card');}},true)`);
 for(const scope of ['personal','team']) for(const [state,label,tab] of [['active','进行中',2],['completed','已完成',3],['closed','归档',4]]) for(const width of [1440,1100,760,390]) {
  win.setSize(width,900);
  await ev(`window.detailFixture.listCase(${JSON.stringify(scope)},${JSON.stringify(state)})`);
  await wait('!!document.querySelector(".bot-view-tabs")');
  await click(`.bot-view-tabs button:nth-child(${tab})`);
  await wait('document.querySelectorAll(".bot-work-card").length===24');
  // Exercise React-controlled search and sort with DOM input/change events.
  await ev(`(()=>{const b=document.querySelector('.bot-work-browser'),i=b.querySelector('input[type=search]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(i,'保留');i.dispatchEvent(new Event('input',{bubbles:true}));const s=b.querySelector('select');s.value='oldest';s.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await wait('document.querySelector(".bot-work-list-summary").textContent.includes("匹配 55 件")');
  if(state !== 'completed') await click('.bot-work-filters button:nth-child(2)');
  await click('.bot-work-pagination button:last-child');
  await wait('document.querySelector(".bot-work-pagination span").textContent.includes("第 2 / 3 页")');
  const source=scope==='team'?'验收团队':'MyBuddy';
  for(const close of ['back','close','escape']) {
   await click('.bot-work-card-container:nth-child(12) .bot-work-card');
   await wait('!!document.querySelector(".bot-work-conversation-detail")');
   assert(await ev('document.querySelector(".bot-work-browser")===window.listNode'), 'source list stays mounted');
   assert(await ev('!!document.querySelector(".bot-work-browser").closest("[hidden]")'),'source list hidden');
   assert(await ev('!document.querySelector(".bot-inspector") && !document.querySelector("dialog[open]")'),'no side panel or modal');
   assert.equal(await ev('document.querySelector(".bot-work-conversation-breadcrumb button").getAttribute("aria-label")'),`返回${source}的${label}`);
   assert(await ev('document.documentElement.scrollWidth<=innerWidth+1'),'no overflow '+scope+state+width);
   if(close==='back') {
    await ev('window.openDetailNode=document.querySelector(".bot-work-conversation-detail")');
    win.setSize(width===390?1440:390,900);await stableLayout();
    assert(await ev('window.openDetailNode===document.querySelector(".bot-work-conversation-detail")'),'resize does not remount detail');
    assert(await ev('document.querySelector(".bot-work-conversation-header").getBoundingClientRect().top>=0'),'resize keeps return accessible');
    win.setSize(width,900);await stableLayout();
    fs.writeFileSync(path.join(out,`bot-list-detail-${scope}-${state}-${width}.png`),(await win.webContents.capturePage()).toPNG());
    await click('.bot-work-conversation-breadcrumb button');
   } else if(close==='close') await click(`[aria-label="关闭事项详情并返回${label}"]`);
   else await escape();
   await wait('!document.querySelector(".bot-work-conversation-detail")');
   await wait('document.activeElement===window.listTrigger && Math.abs(document.querySelector(".bot-work-browser").scrollTop-window.listBefore.scroll)<2');
   const before=await ev('window.listBefore'),after=await ev(listSnapshot);
   assert(before.scroll>0,'list restoration exercises a scrolled viewport');
   assert(Math.abs(after.scroll-before.scroll)<2,'list scroll restored '+scope+state+width+close);
   delete before.scroll;delete after.scroll;assert.deepEqual(after,before,'query/filter/sort/page/card order retained');
   assert(await ev('document.activeElement===window.listTrigger'),'list trigger focus restored');
  }
  // Clear local list state before the next matrix case, even when scope/view stay unchanged.
  await click('.bot-view-tabs button:first-child');
  console.log(`PASS list ${scope}/${state}/${width}: card/back/close/Escape, resize, mounted source, search/filter/sort/page/scroll/focus.`);
 }
 // Selection from navigation/deep links and an archived transition cannot fall back to a side panel.
 await ev('window.detailFixture.listCase("personal","active")');
 await wait('!!document.querySelector(".bot-view-tabs")');
 await click('.bot-view-tabs button:nth-child(2)');
 await ev('window.detailFixture.selectListWork()');await wait('!!document.querySelector(".bot-work-conversation-detail")');
 await escape();await wait('!document.querySelector(".bot-work-conversation-detail")');
 await click('.bot-work-card-container:nth-child(12) .bot-work-card');
 await wait('!!document.querySelector(".bot-work-conversation-detail")');
 await ev('window.detailFixture.updateSelected()');
 await wait('document.querySelector(".bot-work-detail-heading .bot-work-status").textContent.includes("已完成")');
 assert(await ev('!document.querySelector(".bot-inspector")'),'live archive transition stays inline');
 await escape();await wait('!!document.querySelector(".bot-work-browser") && !document.querySelector(".bot-work-conversation-detail")');
 assert(await ev('document.querySelector(".bot-work-browser").getAttribute("aria-label")==="进行中事项"'),'status change returns to source view');
 await wait('document.activeElement===document.querySelector(".bot-work-browser")');
 await click('.bot-work-card-container:nth-child(12) .bot-work-card');
 await wait('!!document.querySelector(".bot-work-conversation-detail")');
 await ev('window.detailFixture.refreshListHistory()');
 await escape();await wait('!document.querySelector(".bot-work-conversation-detail")');
 await wait('document.activeElement===window.listTrigger');
 assert(await ev('Math.abs(document.querySelector(".bot-work-browser").scrollTop-window.listBefore.scroll)<2'),'history refresh preserves list scroll');
 console.log('PASS list deep-link selection, live completion/archive transition with missing-trigger focus fallback, and history refresh scroll/focus.');
 }
 // Deep links outside the summary cache load only the active ID; late results cannot replace newer selection.
 await ev('window.detailFixture.original()');
 await wait('!!document.querySelector(".bot-view-tabs")');
 await ev('window.detailFixture.old()');
 await wait('document.querySelector(".bot-work-conversation-body")?.textContent.includes("正在读取")');
 await ev('window.detailFixture.newer()');
 await wait('window.detailRequests.includes("pending-new")');
 await ev('window.detailFixture.settle("pending-old","过期详情不得出现")');
 assert(await ev('!document.querySelector(".bot-work-conversation-detail").textContent.includes("过期详情不得出现")'),'late old result ignored');
 await ev('window.detailFixture.settle("pending-new","当前完整详情")');
 await wait('document.querySelector(".bot-work-detail-heading h2")?.textContent==="当前完整详情"');
 await ev('window.detailFixture.summary()');
 await wait('document.querySelector(".bot-work-detail-heading h2")?.textContent==="当前完整详情"');
 await ev('window.detailFixture.invalidate("pending-new")');
 await wait('document.querySelector(".bot-work-conversation-body")?.textContent.includes("水位更新后的目标")');
 await ev('window.detailFixture.invalidate("pending-new",true)');
 await wait('document.querySelector(".bot-work-conversation-body")?.textContent.includes("已不可用")');
 await escape();await wait('!document.querySelector(".bot-work-conversation-detail")');
 console.log('PASS lazy details: no initial full reads, uncached IDs, stale selection suppression, summary isolation, same-stateVersion journal facts, deletion and Escape.');
 // Removal from a named/temporary team invalidates the ordinary detail route.
 await ev('window.detailFixture.team()');await wait('!!document.querySelector(".bot-view-tabs")');
 await click('.bot-view-tabs button:first-child');
 await click('[data-message-id="m4"] .bot-message-work-links button');
 await wait('document.querySelector(".bot-work-detail-heading h2")?.textContent==="临时学习团队的报告"');
 await ev('window.detailFixture.removeTeam()');
 await wait('document.querySelector(".bot-work-conversation-body")?.textContent.includes("已不可用")');
 assert.equal(await ev('document.querySelector(".bot-work-conversation-body").querySelectorAll("button").length'),0,'removed team Work exposes no execution or management actions in ordinary route');
 await escape();await wait('!document.querySelector(".bot-work-conversation-detail")');
 console.log('PASS removed team detail becomes unavailable with no action controls.');
 // Historical team is a read-only overlay over the original mounted source, never a new team identity.
 for(const width of [1100,390]) for(const sourceView of ['conversation','active']) {
   win.setSize(width,900);await ev('window.detailFixture.team()');
   await wait('!!document.querySelector(".bot-view-tabs")');
   await click('.bot-view-tabs button:nth-child('+ (sourceView==='conversation'?1:2) +')');
   await wait(sourceView==='conversation'?'!!document.querySelector(".bot-thread")':'!!document.querySelector(".bot-work-card")');
   await ev(`(()=>{const source=document.querySelector(${JSON.stringify('.bot-thread')}); const list=document.querySelector('.bot-work-browser');window.historySource=list??source;window.historySource.scrollTop=200;window.historyScroll=window.historySource.scrollTop;window.historyTrigger=window.historySource.querySelector('button')??window.historySource;window.historyTrigger.focus({preventScroll:true});window.historyIdentity=window.detailFixture.identity();window.detailFixture.historical();})()`);
   await wait(`document.querySelector('[aria-label="历史团队事项"] .bot-work-detail-heading h2')?.textContent==="临时学习团队的报告"`);
   assert(await ev('!!window.historySource.closest("[hidden]")'),'historical source stays mounted and hidden');
   assert.deepEqual(await ev('window.detailFixture.identity()'),await ev('window.historyIdentity'),'history creates no team or composer identity');
   await escape();await wait(`!document.querySelector('[aria-label="历史团队事项"]')`);
   await wait('document.activeElement===window.historyTrigger');
   assert(await ev('Math.abs(window.historySource.scrollTop-window.historyScroll)<2'),'historical return restores scroll');
 }
 console.log('PASS historical team: conversation/list return, two widths, unchanged identity, mounted source and native Escape/focus restoration.');
 assert.deepEqual(rendererErrors,[],'navigation must not hide renderer errors');
 if (!process.env.WORK_DETAIL_FOCUS) console.log('PASS Electron real clicks: message/detail/back, source-team links with Bot/conversation isolation, 3 widths, scroll+focus restoration, saved artifact target, live status, removed work, stale team lookup. Isolated fixture data; no live model.');
 }catch(e){console.error(e);process.exitCode=1;}finally{win?.close();app.exit(process.exitCode||0);}});
