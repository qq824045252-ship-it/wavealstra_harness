const { app, BrowserWindow } = require('electron');
const fs=require('node:fs'), path=require('node:path'), os=require('node:os'), assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'detail-ui-')); app.setPath('userData',path.join(dir,'profile'));
app.whenReady().then(async()=>{let win;try{
const out=path.resolve('out/tests'); const url=name=>pathToFileURL(path.join(out,name)).href;
fs.writeFileSync(path.join(dir,'index.html'),`<html><head><link rel="stylesheet" href="${url('bot-work-detail-desktop-fixture.css')}"><style>body{margin:0;padding:16px;font:14px system-ui;background:#fff;color:#222}*{box-sizing:border-box}:root{--surface-right:#fff;--fg:#222;--fg-secondary:#555;--border-default:#ddd;--border-subtle:#eee}#root{max-width:860px;margin:auto}</style></head><body><div id="root"></div><script src="${url('bot-work-detail-desktop-fixture.js')}"></script></body></html>`);
win=new BrowserWindow({width:1000,height:900,show:true,webPreferences:{contextIsolation:true}});
await win.loadFile(path.join(dir,'index.html'));win.webContents.debugger.attach('1.3');
const ev=s=>win.webContents.executeJavaScript(s); await new Promise(r=>setTimeout(r,800));
assert(await ev(`document.querySelector('.bot-result-body').textContent.includes('完成两份对照报告')`));
assert(await ev(`document.querySelector('.bot-result-report').textContent.includes('执行失败')`));
assert(await ev(`!document.querySelector('.bot-result-body').textContent.includes('bot-team-report-v1')`));
assert(await ev(`!document.querySelector('.bot-original-report').open`));
assert.equal(await ev('window.originalCalls()'),0,'original messages are not fetched until explicitly expanded');
assert(await ev(`document.querySelector('.bot-work-goal').textContent.includes('第二行包含界面尾部目标标记')`),'full description instead of repeated title');
await ev(`document.querySelector('.bot-work-original-delegation summary').click()`);await new Promise(r=>setTimeout(r,100));
assert.equal(await ev('window.originalCalls()'),1);
assert(await ev(`document.querySelector('.bot-work-original-delegation').textContent.includes('原文尾部标记')`),'exact original separate from assistant goal');
assert(await ev(`document.querySelector('.bot-work-original-delegation').textContent.includes('上方目标由助理整理')`),'no provenance laundering');

await ev(`Array.from(document.querySelectorAll('details > summary')).find(el=>el.textContent==='高级设置与诊断').click()`);
assert(await ev(`document.querySelectorAll('.bot-collaboration-entry').length===2`),'only exact repeats grouped');
assert(await ev(`document.querySelector('.bot-collaboration-body h2')?.textContent==='核对结论'`),'heading rendered');
assert(await ev(`document.querySelector('.bot-collaboration-body strong')?.textContent==='实际完成'`),'strong rendered');
assert(await ev(`!!document.querySelector('.bot-collaboration-body table')`),'table rendered');
assert(await ev(`!!document.querySelector('.bot-collaboration-body pre')`),'code rendered');
assert(await ev(`!window.collabInjected && !document.querySelector('.bot-collaboration-body script') && !document.querySelector('.bot-collaboration-body a[href^="javascript:"]')`),'no injected script/URL');
assert(await ev(`document.querySelector('.bot-collaboration-log').textContent.includes('独有的后续发现不可丢失')`));
await ev(`document.querySelector('.bot-collaboration-repeats summary').click()`);
assert(await ev(`document.querySelector('.bot-collaboration-repeats').open && document.querySelector('.bot-collaboration-repeats').textContent.includes('collab-2')`),'repeat metadata retained');
await ev(`Array.from(document.querySelectorAll('details > summary')).find(el=>el.textContent==='投递与版本记录').click()`);
assert(await ev(`!document.querySelector('#work-card-card-history .bot-original-report').open`),'historical report collapsed');
await ev(`document.querySelector('#work-card-card-history .bot-original-report summary').click()`);
assert(await ev(`!!document.querySelector('#work-card-card-history table')`),'card markdown table');
assert(await ev(`document.querySelector('#work-card-card-history').textContent.includes('相同原文共 2 条')`),'duplicate diagnostic count preserved');
for(const width of [390,760,1440]){await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await new Promise(r=>setTimeout(r,100));assert(await ev('document.documentElement.scrollWidth<=innerWidth'),'no overflow at '+width);await ev(`document.querySelector('[aria-label="目标与进度"]').scrollIntoView()`);const shot=await win.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'bot-work-detail-'+width+'.png'),Buffer.from(shot.data,'base64'));}
await ev(`document.querySelector('.bot-original-report summary').click()`);assert(await ev(`document.querySelector('.bot-original-report').open`));
await ev(`window.renderDetailFixture({closureConclusion:'ended_unsuccessfully'})`);await new Promise(r=>setTimeout(r,100));assert(await ev(`document.querySelector('[aria-label="目标与进度"]').textContent.includes('未完成')`));
await ev(`window.renderDetailFixture({closureConclusion:'cancelled'})`);await new Promise(r=>setTimeout(r,100));assert(await ev(`document.querySelector('[aria-label="目标与进度"]').textContent.includes('已取消')`));
// Older detail replies cannot install another Work's original text after navigation.
await ev(`window.pendingOriginal={};window.api.botWork.getWork=(id)=>new Promise(resolve=>window.pendingOriginal[id]=resolve);window.renderDetailFixture({workId:'first-pending'});`);await new Promise(r=>setTimeout(r,100));
await ev(`window.renderDetailFixture({workId:'second-pending'})`);await new Promise(r=>setTimeout(r,100));
await ev(`window.pendingOriginal['second-pending']({workId:'second-pending',intentRevision:1,sourceVersion:1,originalDelegation:{messages:[{messageId:'new',text:'当前事项独有原文',intentRevision:1,sourceVersion:1}]}})`);await new Promise(r=>setTimeout(r,100));
await ev(`window.pendingOriginal['first-pending']({workId:'first-pending',intentRevision:1,sourceVersion:1,originalDelegation:{messages:[{messageId:'old',text:'过时事项不得串入',intentRevision:1,sourceVersion:1}]}})`);await new Promise(r=>setTimeout(r,100));
assert(await ev(`document.querySelector('.bot-work-original-delegation').textContent.includes('当前事项独有原文')`));
assert(await ev(`!document.querySelector('.bot-work-original-delegation').textContent.includes('过时事项不得串入')`));
// A goal-only match beyond the first rendered page is reachable without any extra Work fetch.
const callsBeforeSearch=await ev('window.originalCalls()');
await ev('window.renderGoalBrowser()');await new Promise(r=>setTimeout(r,100));
assert.equal(await ev('document.querySelectorAll(".bot-work-card").length'),24);
await ev(`(()=>{const input=document.querySelector('input[type="search"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,'独有尾部 abc');input.dispatchEvent(new Event('input',{bubbles:true}));})()`);await new Promise(r=>setTimeout(r,100));
assert.equal(await ev('document.querySelectorAll(".bot-work-card").length'),1);
assert.equal(await ev('document.querySelector(".bot-work-card").dataset.workId'),'goal-60');
assert.equal(await ev('window.originalCalls()'),callsBeforeSearch,'server summary search never fetches a full Work');
assert(await ev('document.documentElement.scrollWidth<=innerWidth'));
console.log('PASS: real Chromium detail layout at 390/760/1440, readable report, retained failures, raw expand, terminal outcomes');
}catch(e){console.error(e);process.exitCode=1;}finally{if(win&&!win.isDestroyed())win.close();app.quit();}});
