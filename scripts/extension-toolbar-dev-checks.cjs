/** Full production renderer in a visible isolated pnpm dev Electron session.
 * Only task rows/content are fixtures; toolbar, PTY, browser and IPC are real.
 */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
module.exports = async ({ evaluate, rpc, until, report, out, home }) => {
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const geometry = () => evaluate(`(() => {
    const panel=document.querySelector('.artifact-panel'), bar=panel.querySelector('.extension-top-bar'), nav=bar.querySelector('.extension-nav-tabs');
    const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}};
    return {panel:rect(panel),bar:rect(bar),nav:rect(nav),scrollLeft:nav.scrollLeft,scrollWidth:nav.scrollWidth,clientWidth:nav.clientWidth,
      tools:[...nav.querySelectorAll('button')].map(e=>({...rect(e),title:e.title,active:e.classList.contains('active')})),
      actions:[...bar.querySelectorAll('.extension-top-actions button')].map(e=>({...rect(e),title:e.title,topmost:e.contains(document.elementFromPoint(e.getBoundingClientRect().x+14,e.getBoundingClientRect().y+14))}))};
  })()`);
  const click = async selector => {
    let previous, p;
    // The panel animates its width. Read a stable, unobscured target before clicking.
    await until(async()=>{
      const next=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)return null;const r=e.getBoundingClientRect(),x=r.x+r.width/2,y=r.y+r.height/2;return {x,y,topmost:e.contains(document.elementFromPoint(x,y))}})()`);
      const stable=next?.topmost&&previous&&Math.abs(next.x-previous.x)<0.1&&Math.abs(next.y-previous.y)<0.1;
      previous=next;p=next&&{x:next.x,y:next.y};return stable;
    },'stable click '+selector);
    await rpc('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...p});
    await rpc('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...p});
  };
  const screenshot = async name => fs.writeFileSync(path.join(out,name+'.png'),Buffer.from((await rpc('Page.captureScreenshot',{format:'png',captureBeyondViewport:false})).data,'base64'));
  const verify = async (name, reference, compact=false) => {
    const g=await geometry();
    assert.equal(g.tools.length,7); assert.equal(g.actions.length,3);
    assert(g.nav.y>=g.bar.y&&g.nav.bottom<=g.bar.bottom,name+' tool group and scrollbar fit vertically');
    assert(g.nav.right<=g.actions[0].x-7, name+' navigation must not overlap controls');
    assert(g.actions.every(a=>a.topmost&&a.right<=g.panel.right&&a.y>=g.bar.y&&a.bottom<=g.bar.bottom),name+' controls reachable within toolbar');
    for(let i=1;i<g.tools.length;i++)assert(g.tools[i].x-g.tools[i-1].right>=3.9,name+' buttons never overlap');
    if(!compact) {
      assert(g.nav.width<=257.1&&g.nav.width>=255,name+' rail width remains normal');
      assert(g.scrollWidth<=g.clientWidth,name+' normal and wide toolbar do not scroll');
      if(reference) for(let i=0;i<7;i++) assert(Math.abs((g.tools[i].x-g.nav.x)-(reference.tools[i].x-reference.nav.x))<1.1,name+' tool '+i+' spacing matches normal rail');
    } else {
      assert(g.scrollWidth>g.clientWidth,name+' narrow navigation scrolls');
      const active=g.tools.find(t=>t.active); assert(active&&active.x>=g.nav.x-0.5&&active.right<=g.nav.right+0.5,name+' selected tool stays visible');
    }
    report.checks.push({name,...g}); return g;
  };
  await rpc('Page.bringToFront');
  await rpc('Emulation.setDeviceMetricsOverride',{width:1600,height:940,deviceScaleFactor:1,mobile:false});
  const workspace=path.join(home,'toolbar-workspace');fs.mkdirSync(workspace);
  await evaluate(`(async()=>{const {useAppStore:s}=await import('/src/store/appStore.ts');window.toolbarStore=s;
    const tasks=['normal','bot'].map((mode,i)=>({id:'toolbar-'+mode,title:mode==='bot'?'Bot 侧栏布局验收':'普通任务侧栏布局验收',updatedAt:Date.now()-i,cwd:${JSON.stringify(workspace)},status:'idle',welcomeMode:mode==='bot'?'general':'working',executionBackend:mode==='bot'?'pi-durable':'pi',messages:[{id:'toolbar-message-'+i,role:'assistant',createdAt:Date.now(),blocks:[{type:'text',content:'侧栏布局验证，不会发送模型请求。'}]}]}));
    for(const task of tasks)await window.api.db.upsertTask(task);
    s.setState({theme:'light',page:'chat',tasks,activeTaskId:tasks[0].id,activeBotId:null,draft:null,sidebarCollapsed:false,panelOpen:true,panelMode:'overview',panelWidth:375,panelExpanded:false,workspaceFilesCount:4,gadgetsCount:4});
  })()`);
  report.seededPresentationFacts.push('Two task rows in isolated temporary DB, ordinary Pi and Bot Pi Durable; no model execution.');
  await until(()=>evaluate('Boolean(document.querySelector(".extension-nav-tabs"))'),'production shared toolbar');
  const reference=await verify('normal overview');
  await screenshot('normal-overview');
  for(const mode of ['normal','bot']) {
    await evaluate(`window.toolbarStore.setState({activeTaskId:'toolbar-${mode}',panelMode:'overview',panelWidth:375,panelExpanded:false})`);
    await wait(300);
    await verify(mode+' overview',reference);
    for(const [tool,selector] of [['terminal','button[title="终端"]'],['browser','button[title="内置浏览器"]']]) {
      await click('.extension-nav-tabs '+selector);
      await until(()=>evaluate(`window.toolbarStore.getState().panelMode==='${tool}'`),mode+' '+tool+' mouse click');
      await wait(250); await verify(mode+' '+tool,reference);
      await screenshot(mode+'-'+tool);
      await click('.extension-top-actions button[title="展开"]');
      await until(()=>evaluate('window.toolbarStore.getState().panelExpanded'),'expand');
      await wait(250); await verify(mode+' '+tool+' expanded',reference);
      await click('.extension-top-actions button[title="还原宽度"]');
      await until(()=>evaluate('!window.toolbarStore.getState().panelExpanded'),'restore');
      await wait(250); await verify(mode+' '+tool+' restored',reference);
    }
  }
  // Actual terminal creation, input, PTY output, switching and reattachment.
  await click('.extension-nav-tabs button[title="终端"]');
  await click('.extension-tab-add-btn[title="新建终端"]');
  await until(()=>evaluate('Object.values(window.toolbarStore.getState().terminalSessions).some(s=>s.alive)'),'real PTY running');
  await until(()=>evaluate('Boolean(document.querySelector(".xterm-helper-textarea"))'),'xterm mounted');
  await click('.xterm-screen');
  await rpc('Input.insertText',{text:process.platform==='win32'?"Write-Output ('TOOLBAR_' + 'PTY_OK')":"printf 'TOOLBAR_%s\\n' PTY_OK"});
  await rpc('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});
  await rpc('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
  await until(()=>evaluate(`(async()=>{const s=Object.values(window.toolbarStore.getState().terminalSessions).find(s=>s.alive);if(!s)return false;const tail=await window.api.terminal.tail({...s,maxBytes:8192});return JSON.stringify(tail).includes('TOOLBAR_PTY_OK')})()`),'real PTY command output');
  const session=await evaluate('Object.values(window.toolbarStore.getState().terminalSessions).find(s=>s.alive).sessionId');
  await screenshot('bot-terminal-live');
  const requests=[];
  const server=http.createServer((req,res)=>{requests.push(req.url);res.writeHead(200,{'Content-Type':'text/html','Cache-Control':'no-store'});res.end('<!doctype html><title>Toolbar browser acceptance</title><h1>TOOLBAR_BROWSER_OK</h1>');});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try {
    await click('.extension-nav-tabs button[title="内置浏览器"]');
    const url=`http://127.0.0.1:${server.address().port}/toolbar`;
    await evaluate(`window.toolbarBrowserUrls=[];window.toolbarBrowserOff=window.api.browser.onUrlChanged(url=>window.toolbarBrowserUrls.push(url))`);
    await click('input[aria-label="浏览器地址"]');
    await rpc('Input.insertText',{text:url});
    await rpc('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13,text:'\r'});
    await rpc('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
    await until(()=>requests.filter(u=>u==='/toolbar').length>0,'real native browser loads loopback page');
    await until(()=>evaluate(`window.toolbarBrowserUrls.includes(${JSON.stringify(url)})`),'native browser navigation committed');
    const first=requests.filter(u=>u==='/toolbar').length;
    await click('[aria-label="硬刷新（忽略缓存）"]');
    await until(()=>requests.filter(u=>u==='/toolbar').length>first,'real browser hard refresh');
    await verify('native browser loaded',reference);
    await screenshot('bot-browser-live');
    await click('.extension-nav-tabs button[title^="终端"]');
    await until(()=>evaluate('Boolean(document.querySelector(".xterm-helper-textarea"))'),'terminal reattachment');
    assert.equal(await evaluate('Object.values(window.toolbarStore.getState().terminalSessions).find(s=>s.alive).sessionId'),session,'same PTY survives browser switching');
    report.actualControlChecks.push('Real mouse click -> terminal creation -> typed shell command -> PTY output; native browser URL Enter -> HTTP load -> hard refresh -> same terminal reattached.');
  } finally { await evaluate('window.toolbarBrowserOff?.();window.toolbarStore.getState().setBrowserUrl(null)'); report.browserRequests=requests; server.closeAllConnections();await new Promise(resolve=>server.close(resolve)); }
  // Real layout at smaller viewports. Production setter clamps to 200px minimum.
  for(const width of [1024,760,600]) {
    await rpc('Emulation.setDeviceMetricsOverride',{width,height:800,deviceScaleFactor:1,mobile:false});
    await evaluate(`window.toolbarStore.setState({sidebarCollapsed:true});window.toolbarStore.getState().setPanelWidth(200);window.toolbarStore.getState().showBrowser();window.toolbarStore.getState().setPanelWidth(200)`);
    await wait(300);
    const g=await geometry();
    await verify('narrow '+width,null,g.nav.width<255);
    if(g.nav.width<255) {
      // Keyboard focus must scroll every clipped tool into view without obscuring controls.
      await evaluate(`document.querySelector('.extension-nav-tabs button').focus()`);
      for(let i=0;i<7;i++) {
        const focus=await evaluate(`(()=>{const e=document.activeElement,r=e.getBoundingClientRect(),n=document.querySelector('.extension-nav-tabs').getBoundingClientRect();return {inside:e.matches('.extension-tab-btn'),visible:r.x>=n.x-1&&r.right<=n.right+1}})()`);
        assert(focus.inside&&focus.visible,'narrow '+width+' keyboard tool '+i+' reachable: '+JSON.stringify(focus));
        await rpc('Input.dispatchKeyEvent',{type:'keyDown',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
        await rpc('Input.dispatchKeyEvent',{type:'keyUp',key:'Tab',code:'Tab',windowsVirtualKeyCode:9});
      }
      await evaluate(`document.querySelector('.extension-nav-tabs button').focus()`);
      const navBeforeResize=(await geometry()).nav.width;
      await rpc('Emulation.setDeviceMetricsOverride',{width:width-20,height:800,deviceScaleFactor:1,mobile:false});
      await wait(300);
      const navAfterResize=(await geometry()).nav.width;
      assert(Math.abs(navAfterResize-navBeforeResize)>1,'resize must actually change the navigation width');
      report.focusResize={navBeforeResize,navAfterResize};
      assert(await evaluate(`(()=>{const e=document.activeElement,r=e.getBoundingClientRect(),n=document.querySelector('.extension-nav-tabs').getBoundingClientRect();return e.matches('.extension-tab-btn')&&r.x>=n.x-1&&r.right<=n.right+1})()`),'resize preserves visibility of focused inactive tool');
      await rpc('Emulation.setDeviceMetricsOverride',{width,height:800,deviceScaleFactor:1,mobile:false});
      await evaluate(`window.toolbarStore.getState().showOverview();window.toolbarStore.getState().setPanelWidth(200)`);
      await wait(100); await verify('narrow '+width+' overview',null,true);
    }
    await screenshot('narrow-'+width);
  }
  // Resize observer reveals the selected tool; full restore still matches reference.
  await rpc('Emulation.setDeviceMetricsOverride',{width:1600,height:940,deviceScaleFactor:1,mobile:false});
  await evaluate(`window.toolbarStore.setState({sidebarCollapsed:false});window.toolbarStore.getState().showBrowser()`);
  await wait(300); await verify('restored wide browser',reference);
  await click('.extension-top-actions button[title*="钉住"]');
  assert(await evaluate('window.toolbarStore.getState().panelPinned'),'pin works');
  await click('.extension-top-actions button[title="关闭侧栏"]');
  await until(()=>evaluate('!document.querySelector(".artifact-panel")'),'close sidebar');
  report.actualControlChecks.push('Ordinary/Bot overview, terminal/browser, expand/restore, pin/close; 1600/1024/760/600px; scrollable narrow tools reached by keyboard.');
};
