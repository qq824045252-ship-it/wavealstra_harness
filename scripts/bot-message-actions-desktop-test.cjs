const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'message-actions-'));app.setPath('userData',path.join(dir,'profile'));
app.whenReady().then(async()=>{
 let win;try{
 const out=path.resolve('out/tests'),html=path.join(dir,'fixture.html');
 fs.writeFileSync(html,`<html><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(out,'bot-message-actions-desktop-fixture.css'))}"><div id="root"></div><script src="${pathToFileURL(path.join(out,'bot-message-actions-desktop-fixture.js'))}"></script></html>`);
 win=new BrowserWindow({width:1100,height:900,show:true});await win.loadFile(html);
 const run=s=>win.webContents.executeJavaScript(s),wait=async s=>{for(let i=0;i<100;i++){if(await run(s))return;await new Promise(r=>setTimeout(r,30));}throw Error(s);};
 await wait('document.querySelectorAll(".bot-message-meta").length===4');
 for(const width of [1100,640,360]){
  win.setSize(width,900);await new Promise(r=>setTimeout(r,100));
  assert.equal(await run('document.querySelectorAll(".bot-message-stop").length'),2);
  assert(await run('document.documentElement.scrollWidth<=innerWidth+1'));
  assert(await run(`[...document.querySelectorAll('.bot-message-actions')].every(el=>el.getBoundingClientRect().right<=innerWidth)`));
  assert(await run(`[...document.querySelectorAll('.bot-message-actions button')].every(el=>getComputedStyle(el).borderTopColor==='rgba(0, 0, 0, 0)' && el.getBoundingClientRect().height>=29.9)`));
  assert(await run(`[...document.querySelectorAll('.bot-message-stamp')].every(el=>!el.querySelector('button'))`));
  fs.writeFileSync(path.join(out,`bot-message-actions-${width}.png`),(await win.webContents.capturePage()).toPNG());
 }
 await run(`document.querySelector('[data-case="running"] .bot-message-reply').click()`);
 assert.deepEqual(await run('window.actionEvents'),['reply:1']);
 await run(`document.querySelector('[data-case="running"] .bot-message-stop').focus()`);
 await run(`document.querySelector('[data-case="running"] .bot-message-stop').click()`);
 await wait(`!document.querySelector('[data-case="running"] .bot-message-stop')`);
 assert.deepEqual(await run('window.actionEvents'),['reply:1','stop:1']);
 assert(await run(`Boolean(document.querySelector('[data-case="unknown"] .bot-message-stop'))`));
 console.log('PASS Electron: 1100/640/360px, no overflow, grouped quiet actions, reply callback, scoped stop, completed/unknown states');
 }catch(e){console.error(e);process.exitCode=1;}finally{win?.destroy();app.exit(process.exitCode||0);}
});
