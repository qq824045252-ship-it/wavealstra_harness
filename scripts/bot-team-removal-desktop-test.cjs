/** Actual Chromium clicks against production component, synthetic data only. */
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'team-removal-ui-'));
app.setPath('userData', path.join(profile, 'chromium'));
app.whenReady().then(async () => {
 let win;
 try {
  const out = path.resolve('out/tests'), html = path.join(profile, 'fixture.html');
  fs.writeFileSync(html, `<html><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(out,'bot-team-removal-desktop-fixture.css')).href}"></head><body><div id="root"></div><script src="${pathToFileURL(path.join(out,'bot-team-removal-desktop-fixture.js')).href}"></script></body></html>`);
  win = new BrowserWindow({width: 1050,height: 820,show: true});
  await win.loadFile(html);
  const evalJs = s => win.webContents.executeJavaScript(s);
  const wait = async expr => { for(let i=0;i<100;i++){if(await evalJs(expr))return; await new Promise(r=>setTimeout(r,40));} throw Error(expr); };
  const click = text => evalJs(`[...document.querySelectorAll('button')].find(b=>b.textContent===${JSON.stringify(text)}).click()`);
  await wait("document.body.textContent.includes('停止并删除此事项')");
  await click('停止并删除此事项');
  await wait("document.body.textContent.includes('停止且仅停止此事项')");
  await click('取消'); assert.deepEqual(await evalJs('window.deletionCalls'), []);
  await click('停止并删除此事项'); await click('确认移到回收站');
  await wait("document.body.textContent.includes('正在停止并移到回收站…')");
  assert.deepEqual(await evalJs('window.deletionCalls'), ['stop_and_remove_work']);
  assert(await evalJs("[...document.querySelectorAll('button')].find(b=>b.textContent==='正在停止并移到回收站…').disabled"));
  await evalJs('window.settleDeletion()'); await wait("document.body.textContent.includes('恢复此事项')");
  await click('恢复此事项'); await wait("document.body.textContent.includes('删除此事项')");
  assert.deepEqual(await evalJs('window.deletionCalls'), ['stop_and_remove_work','restore_work']);
  fs.writeFileSync(path.join(out,'bot-team-removal-desktop.png'), (await win.webContents.capturePage()).toPNG());
  console.log('PASS Electron: active deletion enabled, scoped confirmation, cancel no-op, pending double-click blocked, settled restore without execution');
 } catch(e) { console.error(e); process.exitCode=1; }
 finally { win?.destroy(); app.exit(process.exitCode||0); }
});
