const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'bot-add-menu-'));app.setPath('userData',path.join(dir,'profile'));
app.whenReady().then(async()=>{
 let win;try{
 const out=path.resolve('out/tests'),html=path.join(dir,'fixture.html');
 fs.writeFileSync(html,`<html><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(out,'bot-add-menu-desktop-fixture.css'))}"><div id="root"></div><script src="${pathToFileURL(path.join(out,'bot-add-menu-desktop-fixture.js'))}"></script></html>`);
 win=new BrowserWindow({width:1100,height:900,show:true});await win.loadFile(html);
 const run=s=>win.webContents.executeJavaScript(s),wait=async s=>{for(let i=0;i<150;i++){if(await run(s))return;await new Promise(r=>setTimeout(r,30));}throw Error(s);};
 const pause=()=>new Promise(r=>setTimeout(r,100));
 const click=async expr=>{
  win.focus();await pause();
  const p=await run(`(()=>{const el=${expr};if(!el)throw Error('click target missing');const r=el.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);
  win.webContents.sendInputEvent({type:'mouseMove',...p});await pause();
  win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...p});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...p});await pause();
 };
 const open=async()=>{await click(`document.querySelector('[aria-label="添加"]')`);await wait(`document.querySelectorAll('.add-menu > .add-menu-item').length === 9`);};
 // Hover is how the existing cascade opens. Avoid toggling the same submenu twice.
 const hover=async label=>{const p=await run(`(()=>{const r=[...document.querySelectorAll('.add-menu-item')].find(el=>el.textContent.trim()===${JSON.stringify(label)}).getBoundingClientRect();return{x:Math.round(r.x+30),y:Math.round(r.y+r.height/2)}})()`);win.webContents.sendInputEvent({type:'mouseMove',...p});await pause();await wait(`Boolean(document.querySelector('.add-menu-flyout'))`);};
 const choose=async label=>click(`[...document.querySelectorAll('.add-menu-flyout button')].find(el=>el.textContent.includes(${JSON.stringify(label)}))`);
 const close=async()=>{win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await wait(`!document.querySelector('.add-menu')`);};
 await wait(`Boolean(document.querySelector('[aria-label="添加"]:not(:disabled)'))`);
 for(const width of [1100,640,530,500,360]){
  win.setSize(width,900);await pause();await open();
  assert.deepEqual(await run(`[...document.querySelectorAll('.add-menu > .add-menu-item')].map(el=>el.textContent.trim())`),['多模型会诊','添加文件','引用任务','引用对话中的文件1','外部 Agent','专家','技能','MCP','连接器']);
  assert(await run(`(()=>{const a=document.querySelector('.add-menu-anchor').getBoundingClientRect(),m=document.querySelector('.add-menu').getBoundingClientRect();return Math.abs(a.top-m.bottom-8)<2 && m.left>=0 && m.right<=innerWidth})()`),'anchored 8px above plus');
  fs.writeFileSync(path.join(out,`bot-add-menu-${width}.png`),(await win.webContents.capturePage()).toPNG());
  await hover('专家');
  assert(await run(`(()=>{const r=document.querySelector('.add-menu-flyout').getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight})()`),'submenu inside viewport');
  if(width===360){assert(await run(`Boolean(document.querySelector('.add-menu-flyout-back'))`));await choose('返回添加菜单');await wait(`!document.querySelector('.add-menu-flyout')`);}
  await close();
 }
 // Real pointer selection -> real scoped store draft for each ordinary menu entry.
 win.setSize(1100,900);await pause();
 await open();await hover('添加文件');await choose('本地文件');await wait(`document.querySelector('.bot-composer').textContent.includes('picked.txt')`);
 await open();await hover('引用任务');await choose('源任务');await wait(`window.addMenuFixture.store.getState().botComposerDrafts.bot.refTasks?.length===1`);
 await open();await hover('引用对话中的文件1');
 assert(!(await run(`document.querySelector('.add-menu-flyout').textContent`)).includes('unrelated.txt'));
 await choose('conversation.txt');await wait(`window.addMenuFixture.store.getState().botComposerDrafts.bot.refFiles?.length===1`);
 for(const [label,value,key] of [['专家','Fixture expert','expertId'],['技能','Fixture skill','skillIds'],['MCP','fixture-mcp','mcpIds'],['连接器','引用','connectorIds']]){
  console.log("Selecting",label);await open();await hover(label);await choose(value);await wait(`window.addMenuFixture.store.getState().botComposerDrafts.bot.${key}.length>0`);
 }
 await run(`window.addMenuFixture.configure(false)`);await open();await click(`document.querySelector('[data-testid="consult-add-menu"]')`);
 await wait(`document.querySelector('.bot-composer-capability-notice')?.textContent.includes('尚未启用')`);
 assert(!(await run(`window.addMenuFixture.store.getState().botComposerDrafts.bot.consultRequested`)));
 await run(`window.addMenuFixture.configure(true)`);await open();await click(`document.querySelector('[data-testid="consult-add-menu"]')`);
 await wait(`window.addMenuFixture.store.getState().botComposerDrafts.bot.consultRequested===true`);
 await open();await hover('外部 Agent');await choose('Fixture ACP');
 await wait(`window.addMenuFixture.store.getState().botComposerDrafts.bot.externalAgentId==='fixture-acp'`);
 assert.equal(await run(`window.addMenuFixture.store.getState().botComposerDrafts.bot.consultRequested`),false);
 await open();assert.equal(await run(`document.querySelector('[data-testid="consult-add-menu"]').disabled`),true);await close();
 await click(`document.querySelector('[aria-label="移除外部 Agent"]')`);
 await open();await click(`document.querySelector('[data-testid="consult-add-menu"]')`);await wait(`window.addMenuFixture.store.getState().botComposerDrafts.bot.consultRequested===true`);
 await run(`window.concurrentFixture.draft('检查这些引用')`);await click(`document.querySelector('[aria-label="发送消息"]')`);
 await wait(`window.concurrentFixture.requests.length===1`);
 const request=await run(`window.concurrentFixture.requests[0]`);
 assert(request.text.includes('引用上下文验证'));assert(request.selection.consultRequested);assert.equal(request.selection.refTasks[0].id,'source');assert.equal(request.selection.refFiles[0].name,'conversation.txt');assert.equal(request.attachments.length,2);
 assert(!(await run(`document.querySelector('.user-bubble-text').textContent`)).includes('mybuddy:reference-context'));
 await wait(`!window.addMenuFixture.store.getState().botComposerDrafts.bot.refTasks?.length`);
 await run(`window.addMenuFixture.store.setState(state=>({tasks:[...state.tasks,{id:'bot-acp-a-'+window.concurrentFixture.requests[0].requestId,title:'Bot · Fixture ACP',updatedAt:1,messages:[]}]}))`);
 await wait(`[...document.querySelectorAll('.bot-message button')].some(el=>el.textContent.includes('打开外部 Agent 任务'))`);
 await click(`[...document.querySelectorAll('.bot-message button')].find(el=>el.textContent.includes('打开外部 Agent 任务'))`);
 assert((await run(`window.addMenuFixture.store.getState().activeTaskId`)).startsWith('bot-acp-'));

 await run(`window.addMenuFixture.switchTeam()`);await wait(`document.querySelector('.bot-heading').textContent.includes('团队')`);await open();await hover('引用对话中的文件');
 assert((await run(`document.querySelector('.add-menu-flyout').textContent`)).includes('暂无可引用文件'));await close();
 console.log('PASS Electron Bot add menu: 9 entries, 1100/640/360px, anchored placement, bounded submenus/back, all selectors, consult readiness/conflict, actual request context, one-shot clearing, Bot/team isolation');
 }catch(e){if(win){fs.writeFileSync(path.resolve("out/tests/bot-add-menu-failed.png"),(await win.webContents.capturePage()).toPNG());console.error(await win.webContents.executeJavaScript("document.body.innerText"));}console.error(e);process.exitCode=1;}finally{win?.destroy();app.exit(process.exitCode||0);}
});
