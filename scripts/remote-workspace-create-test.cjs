const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const root=path.resolve(__dirname,'..'),out=path.join(root,'out/tests/remote-workspace');fs.mkdirSync(out,{recursive:true});
if(!process.versions.electron){
  require('esbuild').buildSync({entryPoints:[path.join(root,'scripts/remote-workspace-create-fixture.tsx')],bundle:true,platform:'browser',format:'iife',jsx:'automatic',outfile:path.join(out,'fixture.js'),define:{'process.env.NODE_ENV':'"production"'}});
  fs.writeFileSync(path.join(out,'index.html'),'<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="fixture.css"></head><body><div id="root"></div><script src="fixture.js"></script></body></html>');
  const env={...process.env};delete env.ELECTRON_RUN_AS_NODE;
  const r=require('node:child_process').spawnSync(require('electron'),[__filename],{env,windowsHide:true,encoding:'utf8',timeout:45000});process.stdout.write(r.stdout||'');process.stderr.write(r.stderr||'');if(r.error)console.error(r.error);process.exit(r.status??1);
}
const {app,BrowserWindow}=require('electron');app.setPath('userData',path.join(out,'profile'));
let win;const checks=[],wait=ms=>new Promise(r=>setTimeout(r,ms));
const evaluate=async code=>{const r=await win.webContents.executeJavaScript(`(async()=>{try{return {value:await (${code})}}catch(e){return {error:e.stack}}})()`,true);if(r.error)throw Error(r.error);return r.value;};
async function until(code){const end=Date.now()+6000;while(!await evaluate(code)){if(Date.now()>end)throw Error('Timeout '+code);await wait(25);}}
async function click(selector){const p=await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing '+${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect(),x=Math.round(r.x+r.width/2),y=Math.round(r.y+r.height/2),hit=document.elementFromPoint(x,y);if(!e.contains(hit))throw Error('Not clickable '+${JSON.stringify(selector)}+' hit '+hit?.outerHTML.slice(0,160));return {x,y}})()`);win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...p});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...p});await wait(60);}
async function type(text){await evaluate(`(()=>{const e=document.querySelector('textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);await wait(30);}
async function select(label,value){
  const modeLabels={working:'日常办公',coding:'代码开发',bot:'Bot'},tagLabels={'general-office':'通用办公',native:'原生模式',codemode:'Code Mode','custom-dev':'自定义开发'};
  if(label==='新任务模式'){
    if(await evaluate('!!document.querySelector(".task-setup-sheet.open")')){await click('[aria-label="关闭任务设置"]');await wait(300);}
    await click('[aria-label="新任务模式"]');await wait(300);await click('[aria-label="模式：'+modeLabels[value]+'"]');
  } else {await click('[aria-label="Tag：'+tagLabels[value]+'"]');await wait(300);}
}
async function choose(mode='working',tag='general-office'){await select('新任务模式',mode);await select('新任务 Tag',tag);}
function pass(name){checks.push(name);fs.writeSync(1,'PASS '+name+'\n');}
app.whenReady().then(async()=>{win=new BrowserWindow({width:390,height:844,useContentSize:true,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false,offscreen:true}});win.webContents.setFrameRate(30);win.webContents.on('paint',()=>{});win.webContents.startPainting();await win.loadFile(path.join(out,'index.html'));
  await until('!!document.querySelector("textarea")');await click('[aria-label="菜单"]');await wait(250);
  assert.equal(await evaluate('document.querySelectorAll(".drawer-space-new-task").length'),4);
  assert(await evaluate('document.querySelector("[aria-label=\\"在 路径失效 中新建任务\\"]").disabled'));
  assert.equal(await evaluate('document.querySelector(".claude-drawer").innerText.includes("已归档")'),false);
  fs.writeFileSync(path.join(out,'folder-actions.png'),(await win.webContents.capturePage()).toPNG());
  await click('[aria-label="在 项目文件夹 中新建任务"]');await until('!document.querySelector(".claude-drawer").classList.contains("open")');
  assert.equal((await evaluate('workspaceFixture.inspect()')).selectedSpaceId,'child');
  assert.match(await evaluate('document.querySelector(".task-setup-location").textContent'),/项目文件夹/);
  pass('nested and empty folders have touch targets; archived/invalid destinations cannot be selected');
  await type('必须先选择');assert.equal(await evaluate('document.querySelector("[aria-label=发送]").disabled'),true);
  assert.match(await evaluate('workspaceFixture.submit().catch(e=>e.message)'),/选择模式和 Tag/);
  await select('新任务模式','working');fs.writeFileSync(path.join(out,'tag-sheet.png'),(await win.webContents.capturePage()).toPNG());assert.equal(await evaluate('document.querySelector("[aria-label=发送]").disabled'),true);
  await select('新任务 Tag','general-office');await select('新任务模式','bot');
  assert.equal((await evaluate('workspaceFixture.inspect()')).selectedModePresetId,null);
  assert.equal(await evaluate('!!document.querySelector("[aria-label=权限控制]")'),false);
  assert.equal(await evaluate('document.querySelector("[aria-label=发送]").disabled'),true);
  await select('新任务 Tag','native');
  assert.equal(await evaluate('document.querySelector("[aria-label=发送]").disabled'),false);
  pass('mode and tag require explicit choices; changing mode clears tag; Bot hides MyBuddy permission control');
  await choose();
  await click('[aria-label="选择新任务位置"]');await wait(250);
  assert(await evaluate(`!!document.querySelector('[aria-label="位置：公司空间 / 项目文件夹"]')`));
  fs.writeFileSync(path.join(out,'location-sheet.png'),(await win.webContents.capturePage()).toPNG());
  await click('[aria-label="选择关联项目"]');await click('[aria-label="项目：共享项目记忆"]');
  await click('[aria-label="关闭任务设置"]');await wait(300);
  await type('手机文件夹测试');await click('[aria-label="发送"]');await until('workspaceFixture.inspect().activeTaskId!==null');
  let state=await evaluate('workspaceFixture.inspect()');assert.equal(state.requests[0].spaceId,'child');assert.equal(state.requests[0].projectId,'project');assert.equal(state.tasks[0].spaceId,'child');assert.equal(state.selectedSpaceId,null);assert.equal(state.selectedProjectId,null);
  assert.equal(state.requests[0].welcomeMode,'working');assert.equal(state.requests[0].modePresetId,'general-office');
  assert.equal(await evaluate('document.querySelector(".header-task-info .task-mode-label").textContent'),'日常办公 · 通用办公');
  pass('first send carries both folder and project, then clears one-shot selections');
  await click('[aria-label="菜单"]');await wait(250);
  assert.equal(await evaluate('document.querySelector(".drawer-item-btn .task-mode-label").textContent'),'日常办公 · 通用办公');
  await click('.drawer-new-chat-btn');assert.equal((await evaluate('workspaceFixture.inspect()')).selectedWelcomeMode,null);await choose('bot','codemode');await type('独立任务测试');await click('[aria-label="发送"]');await until('workspaceFixture.inspect().requests.length===2');
  state=await evaluate('workspaceFixture.inspect()');assert.equal(state.requests[1].spaceId,undefined);assert.equal(state.requests[1].projectId,undefined);
  assert.equal(state.requests[1].welcomeMode,'bot');assert.equal(state.requests[1].modePresetId,'codemode');assert.equal(state.requests[1].permissionMode,undefined);
  assert.equal(await evaluate('document.querySelector(".header-task-info .task-mode-label").textContent'),'Bot · Code Mode');
  pass('ordinary new conversation does not inherit the previous folder or project');
  await click('[aria-label="菜单"]');await wait(250);await click('[aria-label="在 空文件夹 中新建任务"]');await choose('coding','custom-dev');await evaluate('workspaceFixture.failNext()');await type('保留输入和位置');await click('[aria-label="发送"]');await until('workspaceFixture.inspect().alerts.length===1');
  assert.equal(await evaluate('document.querySelector("textarea").value'),'保留输入和位置');assert.equal((await evaluate('workspaceFixture.inspect()')).selectedSpaceId,'empty');
  assert.equal((await evaluate('workspaceFixture.inspect()')).selectedModePresetId,'custom-dev');
  await click('[aria-label="发送"]');await until('workspaceFixture.inspect().tasks.length===3');assert.equal((await evaluate('workspaceFixture.inspect()')).requests[3].spaceId,'empty');
  pass('failed submission retains draft and destination; retry creates only one task');
  assert.equal((await evaluate('workspaceFixture.inspect()')).requests[3].welcomeMode,'coding');
  assert.equal(await evaluate('document.querySelector(".header-task-info .task-mode-label").textContent'),'代码开发 · 自定义开发');
  pass('office, Bot Code Mode and custom coding tags reach requests and task labels unchanged');
  await click('[aria-label="菜单"]');await wait(250);await click('[aria-label="在 项目文件夹 中新建任务"]');await choose();await evaluate('workspaceFixture.invalidate()');await type('不能静默落到独立任务');await click('[aria-label="发送"]');await until('workspaceFixture.inspect().alerts.length===2');assert.equal((await evaluate('workspaceFixture.inspect()')).requests.length,4);
  pass('deleted destination is rejected without silently creating in another location');
  await evaluate('workspaceFixture.removeTag()');assert.equal(await evaluate('document.querySelector("[aria-label=发送]").disabled'),true);
  assert.match(await evaluate('workspaceFixture.submit().catch(e=>e.message)'),/选择模式和 Tag/);
  await evaluate('workspaceFixture.oldHost()');await click('[aria-label="新任务模式"]');await wait(300);assert.match(await evaluate('document.querySelector(".task-setup-sheet").innerText'),/更新电脑端/);
  assert.equal((await evaluate('workspaceFixture.inspect()')).requests.length,4);
  pass('removed tags and older hosts cannot silently fall back to the wrong mode');
  fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({passed:true,checks},null,2));app.exit(0);
}).catch(async error=>{let state;try{state=await evaluate('({state:workspaceFixture.inspect(),body:document.body.innerText,input:document.querySelector("textarea")?.value})');fs.writeFileSync(path.join(out,'failed.png'),(await win.webContents.capturePage()).toPNG());}catch{}fs.writeFileSync(path.join(out,'results.json'),JSON.stringify({passed:false,checks,error:error.stack,state},null,2));fs.writeSync(2,error.stack+'\n');app.exit(1);});
