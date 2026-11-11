const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'work-conversation-'));app.setPath('userData',path.join(dir,'profile'));
app.whenReady().then(async()=>{let win;try{
 const out=path.resolve('out/tests'),url=n=>pathToFileURL(path.join(out,n)).href;
 fs.writeFileSync(path.join(dir,'index.html'),`<html><meta charset="utf-8"><link rel="stylesheet" href="${url('bot-work-conversation-desktop-fixture.css')}"><style>*{box-sizing:border-box}body{margin:0;font:14px system-ui;color:#222;background:white}#root{height:100vh;display:flex}:root{--surface-right:white;--fg:#222;--fg-secondary:#666;--border-subtle:#eee;--border-default:#ddd;--bg-input:white;--bg-sidebar:#f5f5f5;--accent:#3871ed}h1,h2,h3,p{margin:0}</style><div id="root"></div><script src="${url('bot-work-conversation-desktop-fixture.js')}"></script></html>`);
 win=new BrowserWindow({width:1100,height:900,show:true});win.webContents.on('console-message',(_e,_l,m)=>console.log('renderer:',m)); await win.loadFile(path.join(dir,'index.html')); 
 const ev=s=>win.webContents.executeJavaScript(s),wait=async s=>{for(let i=0;i<100;i++){if(await ev(s))return;await new Promise(r=>setTimeout(r,40));}throw Error(s);};
 await wait('document.querySelectorAll("[data-message-id]").length===16');
 await ev(`document.addEventListener('click', e=>{if(e.target.closest('.bot-message-work-links button')) window.beforeDetailScroll=document.querySelector('.bot-thread').scrollTop;}, true)`);
 const stableLayout=async()=>{let last='',same=0;for(let i=0;i<50;i++){const next=await ev(`JSON.stringify([innerWidth,innerHeight,document.querySelector('.bot-thread')?.scrollHeight])`);same=next===last?same+1:0;if(same>=3)return;last=next;await new Promise(r=>setTimeout(r,100));}throw Error('window layout did not settle');};
 const click=async(selector)=>{const r=await ev(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return{x:r.x+r.width/2,y:r.y+r.height/2}})()`);win.webContents.sendInputEvent({type:'mouseDown',button:'left',x:Math.round(r.x),y:Math.round(r.y),clickCount:1});win.webContents.sendInputEvent({type:'mouseUp',button:'left',x:Math.round(r.x),y:Math.round(r.y),clickCount:1});await new Promise(r=>setTimeout(r,100));};
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
  await click('[aria-label="全部生成文件"] > summary');
  await click('[aria-label="全部生成文件"] .bot-result-files button');
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
 await wait('document.querySelector(".bot-work-conversation-status").textContent.includes("已完成")');
 await ev('window.detailFixture.remove()');await wait('document.querySelector(".bot-work-conversation-body").textContent.includes("不在当前列表")');
 await click('[aria-label="关闭事项详情并返回对话"]');await ev('window.detailFixture.reset()');
 await click('[data-message-id="m5"] .bot-message-work-links button');
 await new Promise(r=>setTimeout(r,100));assert(await ev('document.querySelector(".bot-navigation-notice").textContent.includes("正在读取")'),'superseded refresh does not falsely reject');
 await ev('window.detailFixture.resolve()');await wait('!!document.querySelector(".bot-work-conversation-detail")');
 await click('.bot-work-conversation-breadcrumb button');await ev('window.detailFixture.reset()');
 await click('[data-message-id="m5"] .bot-message-work-links button');await ev('window.detailFixture.switchTeam();window.detailFixture.resolve()');
 await new Promise(r=>setTimeout(r,100));assert(await ev('!document.querySelector(".bot-work-conversation-detail")'),'late historic fetch cannot open another team');
 await ev('window.detailFixture.reset()');await new Promise(r=>setTimeout(r,100));
 await click('[data-message-id="m6"] .bot-message-work-links button');
 await wait('document.querySelector(".bot-navigation-notice").textContent.includes("无法打开")');
 assert(await ev('!document.querySelector(".bot-work-conversation-detail")'),'missing ID cannot open foreign data');
 await ev('window.detailFixture.blocked()');
 await click('.bot-view-tabs button:nth-child(2)');await click('.bot-work-card');
 await wait('!!document.querySelector(".bot-inspector[open]")');
 await ev(`[...document.querySelectorAll('.bot-inspector button')].find(b=>b.textContent==='向负责人回复此问题').click()`);
 await wait('!document.querySelector(".bot-work-conversation-detail") && document.querySelector("#bot-draft").value.includes("补充原始文件")');
 assert(await ev('!document.querySelector(".bot-composer").hidden'),'reply from list retains editable composer');
 await ev('window.detailFixture.team()');await wait(`!!document.querySelector('[data-message-id="m4"] .bot-message-work-links button')`);
 await click('[data-message-id="m4"] .bot-message-work-links button');
 await wait('document.querySelector(".bot-work-conversation-breadcrumb strong")?.textContent === "临时学习团队的报告"');
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
 await wait('document.querySelector(".bot-navigation-notice")?.textContent.includes("无法打开")');
 assert(await ev('!document.querySelector(".bot-work-conversation-detail")'),'unrelated Bot cannot inspect via copied work ID');
 await ev('window.detailFixture.team()'); await new Promise(r=>setTimeout(r,150));
 await ev('window.detailFixture.otherConversation();window.detailFixture.selectLinked()');await new Promise(r=>setTimeout(r,150));
 assert(await ev('!document.querySelector(".bot-work-conversation-detail")'),'new conversation cannot auto-open former linked work');
 console.log('PASS Electron real clicks: message/detail/back, source-team links with Bot/conversation isolation, 3 widths, scroll+focus restoration, saved artifact target, live status, removed work, stale team lookup. Isolated fixture data; no live model.');
 }catch(e){console.error(e);process.exitCode=1;}finally{win?.close();app.exit(process.exitCode||0);}});
