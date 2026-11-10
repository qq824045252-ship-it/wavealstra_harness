const {app,BrowserWindow}=require('electron');
const fs=require('node:fs'),path=require('node:path'),os=require('node:os'),assert=require('node:assert/strict');
const {pathToFileURL}=require('node:url');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'report-dedup-'));app.setPath('userData',path.join(dir,'profile'));
app.whenReady().then(async()=>{
 let win;try{
 const out=path.resolve('out/tests'),html=path.join(dir,'fixture.html');
 fs.writeFileSync(html,`<html><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(out,'bot-report-dedup-desktop-fixture.css'))}"><div id="root"></div><script src="${pathToFileURL(path.join(out,'bot-report-dedup-desktop-fixture.js'))}"></script></html>`);
 win=new BrowserWindow({width:1100,height:800,show:true});await win.loadFile(html);
 const run=s=>win.webContents.executeJavaScript(s),wait=async s=>{for(let i=0;i<100;i++){if(await run(s))return;await new Promise(r=>setTimeout(r,30));}throw Error(s);};
 const click=()=>run('document.querySelector(".bot-result-expand").click()');
 for(const width of [1100,420]){
  win.setSize(width,800);await run('window.setReportCase("same")');await wait('document.querySelector(".bot-result-body.is-collapsed")');
  assert.equal(await run('document.querySelectorAll(".bot-original-report").length'),0);
  assert.equal(await run('document.body.textContent.split("最后一条证据").length-1'),1);
  await click();await wait('document.querySelector(".bot-result-expand").getAttribute("aria-expanded")==="true"');
  assert(await run('document.querySelector(".bot-result-body").clientHeight>320'));
  await click();await wait('document.querySelector(".bot-result-body.is-collapsed")');
  await run('window.setReportCase("distinct")');await wait('document.querySelector(".bot-original-report")');
  await run('document.querySelector(".bot-original-report summary").click()');
  assert(await run('document.querySelector(".bot-original-report").open'));
  assert(await run('document.querySelector(".bot-original-report").textContent.includes("31 字节")'));
  assert(!(await run('document.querySelector(".bot-original-report").textContent.includes("最后一条证据")')));
  assert(await run('document.documentElement.scrollWidth<=window.innerWidth+1'));
  fs.writeFileSync(path.join(out,`bot-report-dedup-${width}.png`),(await win.webContents.capturePage()).toPNG());
 }
 await run('window.setReportCase("structured")');await wait('document.body.textContent.includes("结构化结论")');assert(await run('document.body.textContent.includes("独有字段")'));
 await run('window.setReportCase("raw")');await wait('document.body.textContent.includes("完整报告（原始格式）")');assert.equal(await run('document.querySelectorAll(".bot-result-expand").length'),0);
 console.log('PASS Electron: same/different/structured/raw reports, repeated expand/collapse, 1100px/420px, source preserved');
 }catch(e){console.error(e);process.exitCode=1;}finally{win?.destroy();app.exit(process.exitCode||0);}
});
