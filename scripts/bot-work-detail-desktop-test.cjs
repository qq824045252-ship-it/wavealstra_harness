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
for(const width of [390,760,1440]){await win.webContents.debugger.sendCommand('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});await new Promise(r=>setTimeout(r,100));assert(await ev('document.documentElement.scrollWidth<=innerWidth'),'no overflow at '+width);const shot=await win.webContents.debugger.sendCommand('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'bot-work-detail-'+width+'.png'),Buffer.from(shot.data,'base64'));}
await ev(`document.querySelector('.bot-original-report summary').click()`);assert(await ev(`document.querySelector('.bot-original-report').open`));
await ev(`window.renderDetailFixture({closureConclusion:'ended_unsuccessfully'})`);await new Promise(r=>setTimeout(r,100));assert(await ev(`document.querySelector('[aria-label="目标与进度"]').textContent.includes('未完成')`));
await ev(`window.renderDetailFixture({closureConclusion:'cancelled'})`);await new Promise(r=>setTimeout(r,100));assert(await ev(`document.querySelector('[aria-label="目标与进度"]').textContent.includes('已取消')`));
console.log('PASS: real Chromium detail layout at 390/760/1440, readable report, retained failures, raw expand, terminal outcomes');
}catch(e){console.error(e);process.exitCode=1;}finally{if(win&&!win.isDestroyed())win.close();app.quit();}});
