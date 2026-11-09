// Real Electron renderer/component test. Model and durable lifecycle have separate native fixtures.
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'artifact-desktop-'));
app.setPath('userData', path.join(profile, 'chromium'));
app.whenReady().then(async () => {
  let win;
  try {
    const html = path.join(profile, 'fixture.html');
    const script = path.resolve('out/tests/work-artifact-desktop-fixture.js');
    fs.writeFileSync(html, '<!doctype html><meta charset="utf-8"><style>body{font:14px sans-serif}button{margin:6px}li{max-width:100%}</style><div id="root"></div><script src="'+require('node:url').pathToFileURL(script).href+'"></script>');
    const source = path.join(profile, 'result.html'), snapshot = path.join(profile, 'saved.html');
    fs.writeFileSync(source, '<h1>original</h1>'); fs.copyFileSync(source, snapshot); fs.writeFileSync(source, '<h1>changed</h1>');
    win = new BrowserWindow({ width: 640, height: 900, show: true, webPreferences: { contextIsolation: true } });
    await win.loadFile(html);
    await win.webContents.executeJavaScript(`window.opened=[]; window.api={openFolder:async path=>window.opened.push(path),showItemInFolder:async()=>{},botWork:{}};void 0;`);
    const work = { workId:'fixture',title:'HTML task',mode:'once',lifecycle:'active',ownerBotId:'owner',ownerEpoch:1,intentRevision:1,sourceVersion:1,stateVersion:1,inputSnapshotId:'input',inputSnapshotBound:true,goalSources:[],criteria:[],acceptedDeliverableIds:[],deliverables:[],blockers:[],executions:[],notifications:[],subscriptionIds:[],uncoveredScope:[],nextSteps:[],updatedAt:1,
      generatedArtifacts:[{bindingId:'b',path:source,snapshotPath:snapshot,digest:'a'.repeat(64),sizeBytes:17,registeredAt:1,sourceEntryId:2}],
      runtimeObservations:[{bindingId:'b',state:'recovering',reason:'正在恢复原执行，文件快照保留'}] };
    await win.webContents.executeJavaScript(`window.renderArtifactFixture(${JSON.stringify(work)})`);
    for(let i=0;i<100;i++){if(await win.webContents.executeJavaScript(`document.body.textContent.includes('打开保存版本')`))break;await new Promise(r=>setTimeout(r,50));}
    assert(await win.webContents.executeJavaScript(`document.body.textContent.includes('恢复中')`));
    await win.webContents.executeJavaScript(`[...document.querySelectorAll('button')].find(b=>b.textContent==='打开保存版本').click()`);
    await new Promise(r=>setTimeout(r,100));
    assert.deepEqual(await win.webContents.executeJavaScript('window.opened'),[snapshot]);
    assert.equal(fs.readFileSync(snapshot,'utf8'),'<h1>original</h1>');
    await win.webContents.executeJavaScript(`window.api.openFolder=async()=>{throw new Error('missing fixture')};[...document.querySelectorAll('button')].find(b=>b.textContent==='打开保存版本').click()`);
    await new Promise(r=>setTimeout(r,100));
    assert(await win.webContents.executeJavaScript(`document.body.textContent.includes('无法打开文件')`));
    const image = await win.webContents.capturePage();
    fs.writeFileSync('out/tests/work-artifact-desktop.png', image.toPNG());
    console.log('PASS real Electron: running/recovery status, immutable version target, file-open failure feedback');
  } catch(e) { console.error(e);process.exitCode=1; }
  finally { win?.destroy();app.exit(process.exitCode || 0); }
});
