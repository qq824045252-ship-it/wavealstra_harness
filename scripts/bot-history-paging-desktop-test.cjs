const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const profile=fs.mkdtempSync(path.join(os.tmpdir(),'bot-page-ui-'));app.setPath('userData',path.join(profile,'chromium'));
app.whenReady().then(async()=>{let win;try{
  const out=path.resolve('out/tests'),html=path.join(profile,'fixture.html');
  const url=suffix=>pathToFileURL(path.join(out,`bot-conversation-concurrent-desktop-fixture.${suffix}`)).href;
  fs.writeFileSync(html,`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="${url('css')}"><style>body{margin:0;font:14px system-ui}*{box-sizing:border-box}:root{--fg:#222;--fg-secondary:#555;--fg-muted:#777;--bg-panel:#fafafa;--bg-elevated:#fff;--border-default:#ddd;--border-subtle:#ddd;--accent:#2563eb}#root,.bot-workspace{height:100vh}</style></head><body><div id="root"></div><script src="${url('js')}"></script></body></html>`);
  win=new BrowserWindow({width:1440,height:900,show:true,webPreferences:{contextIsolation:true}});await win.loadFile(html);
  const evaluate=code=>win.webContents.executeJavaScript(code),settle=()=>new Promise(r=>setTimeout(r,160));
  const wait=async code=>{const end=Date.now()+10000;while(!await evaluate(code)){if(Date.now()>end)throw Error('timeout: '+code);await new Promise(r=>setTimeout(r,30));}};
  const click=async selector=>{const r=await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()`);win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...r});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...r});};
  const anchor=()=>evaluate(`(()=>{const e=document.querySelector('.bot-thread'),t=e.getBoundingClientRect().top,n=[...e.querySelectorAll('[data-message-id]')].find(n=>n.getBoundingClientRect().height&&n.getBoundingClientRect().bottom>t);return{id:n.dataset.messageId,offset:n.getBoundingClientRect().top-t}})()`);
  const offset=id=>evaluate(`document.querySelector('[data-message-id="${id}"]').getBoundingClientRect().top-document.querySelector('.bot-thread').getBoundingClientRect().top`);
  await wait('Boolean(window.concurrentFixture)');
  for(const width of [1440,760,390]) for(const team of [false,true]){
    win.setSize(width,900);await evaluate(`window.concurrentFixture.seedPaging(${team?'"team-page"':'undefined'})`);await settle();
    assert.equal(await evaluate(`document.querySelectorAll('[data-message-id]').length`),100);
    assert(await evaluate(`(()=>{const e=document.querySelector('.bot-thread');return e.scrollHeight-e.clientHeight-e.scrollTop<2})()`),'initial load follows latest');
    await evaluate(`(()=>{const e=document.querySelector('.bot-thread');e.focus();e.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}));e.scrollTop=0})()`);await settle();
    if(!team)fs.writeFileSync(path.join(out,`bot-history-controls-${width}.png`),await win.webContents.capturePage().then(i=>i.toPNG()));
    await click('.bot-history-controls button');await wait('window.concurrentFixture.pagingCalls.some(c=>c.before)');
    await click('.bot-history-controls button');
    assert.equal(await evaluate('window.concurrentFixture.pagingCalls.filter(c=>c.before).length'),1,'repeated clicks single request');
    // Reader navigation during an in-flight page becomes the new anchor.
    if(team){await evaluate(`(()=>{const e=document.querySelector('.bot-thread');e.dispatchEvent(new KeyboardEvent('keydown',{key:'PageDown',bubbles:true}));e.scrollTop=350})()`);await settle();}
    const a=await anchor();
    await evaluate('window.concurrentFixture.appendPaging()');await settle();assert(Math.abs(await offset(a.id)-a.offset)<2,'concurrent new message preserves reader');
    const interrupted=team&&width===390;
    if(interrupted){await evaluate(`document.querySelector('.bot-view-tabs button:nth-child(2)').click()`);await settle();assert.equal(await evaluate(`Boolean(document.querySelector('.bot-thread'))`),false,'navigation interrupts pending history');}
    await evaluate('window.concurrentFixture.releasePaging()');
    if(interrupted){await settle();await evaluate(`document.querySelector('.bot-view-tabs button:first-child').click()`);}
    await wait(`document.querySelectorAll('[data-message-id]').length===201`);await settle();
    assert(Math.abs(await offset(a.id)-a.offset)<2,'prepend preserves visible message anchor');
    if(!interrupted)assert.equal(await evaluate(`document.activeElement===document.querySelector('.bot-history-controls button')`),true,'loading does not replace or blur button');
    // Late content above the reader and viewport reflow cannot displace the anchor.
    await evaluate(`document.querySelector('[data-message-id="paging-60"]').style.minHeight='900px'`);await settle();assert(Math.abs(await offset(a.id)-a.offset)<2,'late content growth preserves anchor');
    win.setSize(Math.max(360,width-30),850);await settle();assert(Math.abs(await offset(a.id)-a.offset)<2,'resize preserves reader anchor');
    await evaluate(`(()=>{const e=document.querySelector('.bot-thread');e.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}));e.scrollTop=0})()`);await settle();
    await click('.bot-history-controls button');await wait(`document.querySelectorAll('[data-message-id]').length===251`);await settle();
    assert.equal(await evaluate(`document.querySelector('.bot-history-controls button').textContent`),'已到最早消息');
    const reads=await evaluate('window.concurrentFixture.pagingCalls.length');await evaluate(`document.querySelector('.bot-history-controls button').click()`);assert.equal(await evaluate('window.concurrentFixture.pagingCalls.length'),reads,'EOF stops requests');
    await evaluate(`document.querySelector('.bot-latest-button').click()`);await settle();
    assert(await evaluate(`(()=>{const e=document.querySelector('.bot-thread');return e.scrollHeight-e.clientHeight-e.scrollTop<2})()`),'latest restores tail');
    assert(await evaluate(`document.querySelector('.bot-thread').scrollWidth<=document.querySelector('.bot-thread').clientWidth+1`),'no horizontal overflow');
    if(!team)fs.writeFileSync(path.join(out,`bot-history-paging-${width}.png`),await win.webContents.capturePage().then(i=>i.toPNG()));
    console.log(`PASS ${width}px ${team?'team':'personal'}: 100/100/50 pages, concurrent append, repeat, anchor, focus, late growth, resize, EOF/latest`);
  }
}catch(error){console.error(error);process.exitCode=1;}finally{win?.destroy();app.exit(process.exitCode||0);}});
