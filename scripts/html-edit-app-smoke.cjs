// Built-app smoke: real renderer button -> IPC -> in-page editor -> native hosts -> source-safe save.
const { join } = require('node:path');
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert/strict');
if (!process.versions.electron) {
  const { spawnSync } = require('node:child_process');
  const profile = mkdtempSync(join(tmpdir(), 'mybuddy-html-app-'));
  const roaming = join(profile, 'AppData', 'Roaming'), local = join(profile, 'AppData', 'Local');
  mkdirSync(roaming, { recursive: true }); mkdirSync(local, { recursive: true });
  const env = { ...process.env, USERPROFILE: profile, HOME: profile, APPDATA: roaming, LOCALAPPDATA: local, MYBUDDY_HTML_TEST_PROFILE: profile };
  delete env.ELECTRON_RUN_AS_NODE;
  const result = spawnSync(require('electron'), [__filename], { env, cwd: process.cwd(), windowsHide: true, encoding: 'utf8', timeout: 70000 });
  process.stdout.write(result.stdout || ''); process.stderr.write(result.stderr || ''); process.exit(result.status ?? 1);
} else {
  const { app, BrowserWindow, webContents } = require('electron');
  const root = process.env.MYBUDDY_HTML_TEST_PROFILE;
  app.setPath('userData', join(root, 'electron-profile'));
  const file = join(root, 'edit.html');
  const html = '<!doctype html><html><head><meta charset="utf-8"><style>body{padding:30px;font:20px system-ui}</style></head><body><h1>完整应用编辑验证</h1><p id="copy">原始文字</p><script>window.example=42;</script></body></html>';
  writeFileSync(file, html);
  const pause = ms => new Promise(r => setTimeout(r, ms));
  const timeout = setTimeout(() => { console.error('App HTML edit test timeout'); app.exit(1); }, 60000);
  let started = false;
  app.on('browser-window-created', (_event, win) => {
    if (started) return; started = true;
    win.webContents.once('did-finish-load', () => { void run(win).catch(error => { console.error(error); clearTimeout(timeout); app.exit(1); }); });
  });
  async function run(win) {
    await pause(1200); win.show(); await pause(200);
    const runMain = code => win.webContents.executeJavaScript(code, true);
    const clickAt = async (wc, point) => { wc.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:Math.round(point.x),y:Math.round(point.y)}); wc.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:Math.round(point.x),y:Math.round(point.y)}); await pause(180); };
    const select = async (wc, selector) => { const p=await wc.executeJavaScript(`(()=>{const b=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return{x:b.left+10,y:b.top+10}})()`); await clickAt(wc,p); wc.sendInputEvent({type:'keyDown',keyCode:'A',modifiers:['control']}); wc.sendInputEvent({type:'keyUp',keyCode:'A',modifiers:['control']}); await pause(80); };
    const clickSave = async wc => { const p=await wc.executeJavaScript(`(()=>{const b=document.querySelector('#__mybuddy_html_toolbar #save').getBoundingClientRect();return{x:b.left+b.width/2,y:b.top+b.height/2}})()`); await clickAt(wc,p); await pause(900); };

    assert.equal(await runMain('typeof window.api.htmlEdit.start'), 'function');
    win.webContents.send('browser:openRequest', {url:pathToFileURL(file).href}); await pause(1000);
    assert.equal(await runMain('!!document.querySelector(\'[aria-label="编辑 HTML"]\')'), true, 'browser edit button is rendered');
    await runMain('document.querySelector(\'[aria-label="编辑 HTML"]\').click()'); await pause(500);
    const browserPage = webContents.getAllWebContents().find(w => w.getURL() === pathToFileURL(file).href);
    assert.ok(browserPage); assert.equal(BrowserWindow.getAllWindows().some(w => w.getTitle() === 'MyBuddy HTML 编辑'), false, 'no second editor window');
    assert.equal(await browserPage.executeJavaScript(`!!document.querySelector('#__mybuddy_html_toolbar')`), true, 'in-page toolbar injected');
    await select(browserPage, '#copy'); browserPage.insertText('完整应用保存成功'); await pause(350); await clickSave(browserPage);
    assert.ok(readFileSync(file, 'utf8').includes('完整应用保存成功')); assert.ok(readFileSync(file, 'utf8').includes('window.example=42'));
    console.log('PASS built app browser: in-page toolbar, trusted input, real save');

    await runMain('window.api.browser.close()');
    const registration = {taskId:'html-edit-app-test',kind:'html',content:html,title:'HTML 编辑验证'};
    const descriptor = await runMain(`window.api.artifactDomain.register(${JSON.stringify(registration)})`);
    await runMain(`window.api.artifact.preview({id:${JSON.stringify(descriptor.id)}})`);
    await runMain('window.api.artifact.surface.requestBounds("artifact-main",{x:500,y:100,width:700,height:600});window.api.artifact.surface.requestVisible("artifact-main",true)'); await pause(450);
    const artifactResult = await runMain(`window.api.htmlEdit.start({target:"artifact",artifactId:${JSON.stringify(descriptor.id)}})`); assert.equal(artifactResult.ok, true, artifactResult.error);
    const artifactPage = webContents.getAllWebContents().find(w => w.getURL().startsWith('mybuddy-artifact://')); assert.ok(artifactPage);
    assert.equal(await artifactPage.executeJavaScript(`!!document.querySelector('#__mybuddy_html_toolbar')`), true);
    await select(artifactPage, '#copy'); artifactPage.insertText('托管产物保存成功'); await pause(350); await clickSave(artifactPage);
    const content = await runMain(`window.api.artifactDomain.readContent({artifactId:${JSON.stringify(descriptor.id)}})`); assert.ok(content.content.includes('托管产物保存成功'));
    const updated = await runMain(`window.api.artifactDomain.get({taskId:"html-edit-app-test",artifactId:${JSON.stringify(descriptor.id)}})`); assert.equal(updated.artifact.version, 2);
    console.log('PASS built app artifact: in-page editor, managed storage commit, version update');
    console.log('Full app test profile: '+root); clearTimeout(timeout); app.exit(0);
  }
  require(join(process.cwd(), 'out/main/index.js'));
}