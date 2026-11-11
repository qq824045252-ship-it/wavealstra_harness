/** Real Electron mode navigation regression; default launches pnpm dev with an empty profile.
 * MYBUDDY_MODE_TEST_CDP_PORT optionally targets an already isolated dev instance.
 * No model requests or user data are used. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const net = require('node:net');
let port = Number(process.env.MYBUDDY_MODE_TEST_CDP_PORT), child, log;
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'out/tests/mode-navigation');
fs.mkdirSync(output, { recursive: true });
async function launch() {
  if (Number.isInteger(port) && port > 0) return;
  port = await new Promise(resolve => { const server=net.createServer();server.listen(0,'127.0.0.1',()=>{const p=server.address().port;server.close(()=>resolve(p));}); });
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mybuddy-mode-navigation-'));
  const agentDir = path.join(home, '.mybuddy');fs.mkdirSync(agentDir,{recursive:true});
  fs.writeFileSync(path.join(agentDir,'settings.json'),JSON.stringify({memoryEnabled:false,remoteAccessEnabled:false,closeToTray:false}));
  const env={...process.env,HOME:home,USERPROFILE:home,APPDATA:path.join(home,'AppData/Roaming'),LOCALAPPDATA:path.join(home,'AppData/Local'),XDG_CONFIG_HOME:path.join(home,'.config'),XDG_CACHE_HOME:path.join(home,'.cache'),PI_CODING_AGENT_DIR:agentDir};
  delete env.ELECTRON_RUN_AS_NODE;delete env.ELECTRON_CLI_ARGS;
  log=fs.openSync(path.join(output,'dev.log'),'w');
  child=cp.spawn(process.execPath,[path.join(root,'node_modules/electron-vite/bin/electron-vite.js'),'dev','--remoteDebuggingPort',String(port)],{cwd:root,env,stdio:['ignore',log,log]});
}
let ws, sequence = 0;
const pending = new Map();
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error('Timeout: ' + method)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    ws.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const r = await rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
  if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result?.value;
}
async function clickText(selector, text) {
  const p = await evaluate(`(()=>{const b=[...document.querySelectorAll(${JSON.stringify(selector)})].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b)throw Error('Missing '+${JSON.stringify(text)});b.scrollIntoView({block:'center'});const r=b.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
  for (const type of ['mousePressed', 'mouseReleased']) await rpc('Input.dispatchMouseEvent', { type, button:'left', clickCount:1, ...p });
  await wait(150);
}

async function clickSelector(selector) {
  const point = await evaluate(`(()=>{const element=document.querySelector(${JSON.stringify(selector)});if(!element)throw Error('Missing '+${JSON.stringify(selector)});const rect=element.getBoundingClientRect();return {x:rect.x+rect.width/2,y:rect.y+rect.height/2}})()`);
  for (const type of ['mousePressed', 'mouseReleased']) await rpc('Input.dispatchMouseEvent', { type, button:'left', clickCount:1, ...point });
  await wait(150);
}
async function accountMenu(mode) {
  const expected = ['助手','项目','自动化','插件','我的工作台','任务成果','设置','用量统计','API 聚合'];
  for (const dismissal of ['toggle','escape','outside']) {
    await clickSelector('.sidebar-user-main');
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('.account-popup > button.sidebar-popup-item')].map(button=>button.textContent.trim())`), expected, mode+' account menu keeps other actions and excludes Bot mode');
    assert.equal(await evaluate(`document.querySelector('.sidebar-mode-nav [aria-current="page"]').textContent.trim()`), mode);
    if (dismissal === 'toggle') await clickSelector('.sidebar-user-main');
    else if (dismissal === 'escape') {
      await rpc('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
      await rpc('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',code:'Escape',windowsVirtualKeyCode:27});
      await wait(150);
    } else await clickSelector('.sidebar-title');
    assert.equal(await evaluate(`Boolean(document.querySelector('.account-popup'))`),false,dismissal+' dismisses menu');
  }
  await clickSelector('.sidebar-user-main');
  const shot=await rpc('Page.captureScreenshot',{format:'png'});
  fs.writeFileSync(path.join(output,mode==='Bot 模式'?'bot-account-menu.png':'ordinary-account-menu.png'),Buffer.from(shot.data,'base64'));
  await clickSelector('.sidebar-user-main');
  console.log('PASS '+mode+' account menu omits Bot mode; all other actions, toggle, Escape and outside dismissal remain');
}
async function remainingAccountRoutes() {
  for (const [label,page] of [['助手','assistant'],['项目','projects'],['自动化','automation'],['插件','experts'],['我的工作台','gadgets'],['任务成果','files']]) {
    await clickSelector('.sidebar-user-main');
    await clickText('.account-popup > button',label);
    assert.equal(await evaluate(`import('/src/store/appStore.ts').then(module=>module.useAppStore.getState().page)`),page,label+' navigates correctly');
    assert.equal(await evaluate(`Boolean(document.querySelector('.account-popup'))`),false,label+' closes account menu');
  }
  await clickText('.sidebar-mode-nav button','普通模式');
  console.log('PASS all six retained account navigation actions route correctly and dismiss menu');
}

async function selection(mode, label) {
  const actual = await evaluate(`({mode:document.querySelector('.hero')?.dataset.mode,selected:[...document.querySelectorAll('.hero-categories [aria-pressed=true]')].map(b=>b.textContent.trim()),dark:[...document.querySelectorAll('.hero-categories .dark')].map(b=>b.textContent.trim())})`);
  assert.deepEqual(actual, {mode, selected:[label], dark:[label]});
}
(async () => {
  try {
    await launch();
    let target;
    for (const deadline=Date.now()+180000;Date.now()<deadline;) {
      if(child?.exitCode != null)throw Error('Dev process exited '+child.exitCode);
      try {const targets=await fetch(`http://127.0.0.1:${port}/json/list`).then(r=>r.json());target=targets.find(t=>t.type==='page'&&/^http:\/\/(localhost|127\.0\.0\.1):/.test(t.url));if(target)break;}catch{}
      await wait(200);
    }
    assert(target, 'Expected actual dev renderer');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    ws.onmessage = event => { const r=JSON.parse(event.data), p=pending.get(r.id); if(!p)return;pending.delete(r.id);clearTimeout(p.timer);r.error?p.reject(Error(JSON.stringify(r.error))):p.resolve(r.result); };
    for(let i=0;i<100;i++){if(await evaluate(`Boolean(document.querySelector('.hero-categories button'))`))break;await wait(100);}
    await rpc('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
    for (let repeat=0;repeat<2;repeat++) for(const [mode,label] of [['general','通用模式'],['coding','代码开发'],['working','日常办公'],['general','通用模式']]) {
      await clickText('.hero-categories button',label);await selection(mode,label);
    }
    console.log('PASS repeated real mode clicks match selected styling and actual mode');
    await evaluate(`window.dispatchEvent(new Event('focus'))`);await wait(500);await selection('general','通用模式');
    await rpc('Emulation.setDeviceMetricsOverride',{width:680,height:850,deviceScaleFactor:1,mobile:false});await wait(200);await selection('general','通用模式');
    console.log('PASS focus/model refresh and resize preserve selection');
    await rpc('Emulation.setDeviceMetricsOverride',{width:1280,height:900,deviceScaleFactor:1,mobile:false});
    await accountMenu('普通模式');
    await remainingAccountRoutes();
    await clickText('.sidebar-mode-nav button','Bot 模式');await wait(600);assert(await evaluate(`Boolean(document.querySelector('.app--bot'))`));
    await evaluate(`window.dispatchEvent(new Event('focus'))`);await wait(400);assert(await evaluate(`Boolean(document.querySelector('.app--bot'))`));
    await accountMenu('Bot 模式');
    await clickText('.sidebar-mode-nav button','普通模式');await wait(200);await selection('general','通用模式');
    console.log('PASS actual Bot workspace navigation stays in Bot and returns to selected ordinary mode');
    await rpc('Page.reload');await wait(1500);
    await clickText('.hero-categories button','通用模式');await selection('general','通用模式');
    await accountMenu('普通模式');
    console.log('PASS renderer restart preserves account menu removal and ordinary mode');
    const shot=await rpc('Page.captureScreenshot',{format:'png'});
    const out=path.resolve('out/tests/mode-navigation');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'general-selected.png'),Buffer.from(shot.data,'base64'));
  } finally { if(child&&ws?.readyState===1){ws.send(JSON.stringify({id:++sequence,method:'Browser.close'}));await wait(1000);}ws?.close();for(const p of pending.values())clearTimeout(p.timer);if(child?.exitCode===null)child.kill('SIGTERM');if(log!==undefined)fs.closeSync(log); }
})().catch(error=>{console.error(error);process.exitCode=1;});
