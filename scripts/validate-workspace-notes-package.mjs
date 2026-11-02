import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const asar = require('@electron/asar');
const appDir = path.resolve(process.argv[2] || 'release/win-unpacked');
const exe = path.join(appDir, 'MyBuddy.exe');
const output = path.resolve('out/tests/workspace-notes-package');
fs.mkdirSync(output, { recursive: true });
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'mybuddy-notes-package-'));
for (const dir of ['appdata', 'localappdata']) fs.mkdirSync(path.join(fixture, dir));
const expected = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
const hash = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
assert.equal(JSON.parse(asar.extractFile(path.join(appDir, 'resources/app.asar'), 'package.json')).version, expected);
const bundleHash = hash(asar.extractFile(path.join(appDir, 'resources/app.asar'), path.join('out', 'main', 'index.js')));
assert.equal(bundleHash, hash(fs.readFileSync('out/main/index.js')));
const env = { ...process.env, HOME: fixture, USERPROFILE: fixture, APPDATA: path.join(fixture, 'appdata'), LOCALAPPDATA: path.join(fixture, 'localappdata'), XDG_CONFIG_HOME: path.join(fixture, '.config') };
delete env.ELECTRON_RUN_AS_NODE;
const pause = ms => new Promise(r => setTimeout(r, ms));
const reports = [];
for (const phase of ['save', 'reopen']) {
  const server = net.createServer();
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  await new Promise(r => server.close(r));
  const stdout = fs.openSync(path.join(output, phase + '.stdout.log'), 'w');
  const stderr = fs.openSync(path.join(output, phase + '.stderr.log'), 'w');
  const child = spawn(exe, [`--user-data-dir=${path.join(fixture, 'chromium')}`, `--inspect=127.0.0.1:${port}`], { cwd: appDir, env, windowsHide: true, stdio: ['ignore', stdout, stderr] });
  let exited = false, ws;
  child.on('exit', () => { exited = true; });
  try {
    let target;
    for (let i = 0; i < 150; i++) {
      if (exited) throw Error('Packaged app exited before inspection');
      try { target = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()).find(t => t.type === 'node'); } catch {}
      if (target) break;
      await pause(200);
    }
    assert(target);
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
    let seq = 0;
    const pending = new Map();
    ws.onmessage = e => { const msg = JSON.parse(e.data); if (msg.id) { const entry = pending.get(msg.id); pending.delete(msg.id); msg.error ? entry.reject(msg.error) : entry.resolve(msg.result); } };
    const evaluate = async expression => {
      const result = await new Promise((resolve, reject) => { const id = ++seq; pending.set(id, { resolve, reject }); ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true, timeout: 45000 } })); });
      if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    assert.equal(await evaluate('process.pid'), child.pid);
    await evaluate(`(async()=>{const req=process.mainModule.require.bind(process.mainModule);const {app,BrowserWindow}=req('electron');await app.whenReady();if(req('node:os').homedir()!==${JSON.stringify(fixture)}||!app.getPath('userData').startsWith(${JSON.stringify(fixture)}))throw Error('Profile isolation failed');for(let i=0;i<150;i++){globalThis.noteTestWindow=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('out/renderer/index.html')&&!w.webContents.isLoadingMainFrame());if(globalThis.noteTestWindow)break;await new Promise(r=>setTimeout(r,200))}if(!globalThis.noteTestWindow)throw Error('Renderer absent');return true})()`);
    const renderer = async code => {
      const result = await evaluate(`globalThis.noteTestWindow.webContents.executeJavaScript(${JSON.stringify(`(async()=>{try{return {value:await (${code})}}catch(e){return {error:String(e?.stack??e)}}})()`)} )`);
      if (result.error) throw Error(result.error);
      return result.value;
    };
    for (let i = 0; i < 100; i++) { if (await renderer('!!window.api?.workspace?.notes && document.body.innerText.length > 50')) break; await pause(100); }
    if (phase === 'save') {
      const result = await renderer(`(async()=>{const space=await window.api.db.upsertSpace({id:'notes-acceptance',name:'便签验收空间',createdAt:Date.now(),updatedAt:Date.now()});if(!space.ok)throw Error(JSON.stringify(space));const note=await window.api.workspace.notes.save({workspaceId:'notes-acceptance',content:${JSON.stringify('# 运维便签\n\n**手动记录**：周日检查备份。')},expectedRevision:0});const before=await window.api.workspace.libraryBindings.list('notes-acceptance');const created=await window.api.workspace.libraryBindings.createFolder({workspaceId:'notes-acceptance',librarySpaceId:before.destinations[0].id,name:'部署说明'});if(!created.ok)throw Error(created.error);const binding=await window.api.workspace.libraryBindings.list('notes-acceptance');return {note,binding}})()`);
      assert.equal(result.note.revision, 1);
      assert.equal(result.binding.direct.length, 1);
      assert(result.binding.direct[0].path.includes('部署说明'));
      assert(result.binding.libraryStoragePath.startsWith(fixture));
      reports.push({ phase, result });
    } else {
      const persisted = await renderer(`window.api.workspace.notes.read('notes-acceptance')`);
      assert(persisted.content.includes('周日检查备份'));
      await renderer(`(()=>{const row=[...document.querySelectorAll('.space-header')].find(e=>e.textContent.includes('便签验收空间'));if(!row)throw Error('Workspace not hydrated');row.click()})()`);
      await pause(300);
      await renderer(`(()=>{const tab=[...document.querySelectorAll('.workspace-detail-tab')].find(e=>e.textContent==='便签');if(!tab)throw Error('Note tab absent');tab.click()})()`);
      await pause(300);
      assert((await renderer(`document.querySelector('[aria-label="Markdown 便签内容"]').value`)).includes('周日检查备份'));
      await renderer(`(()=>{[...document.querySelectorAll('button')].find(e=>e.textContent==='预览').click()})()`);
      await pause(300);
      const identity = await evaluate(`(async()=>{const req=process.mainModule.require.bind(process.mainModule);const {app}=req('electron');const w=globalThis.noteTestWindow;const image=await w.capturePage();req('node:fs').writeFileSync(${JSON.stringify(path.join(output, 'packaged-notes.png'))},image.toPNG());return {version:app.getVersion(),packaged:app.isPackaged,userData:app.getPath('userData'),pid:process.pid}})()`);
      assert(identity.packaged && identity.version === expected);
      reports.push({ phase, persisted, identity });
    }
    await evaluate(`setTimeout(()=>process.mainModule.require('electron').app.quit(),100);true`);
  } finally {
    ws?.close();
    for (let i = 0; i < 50 && !exited; i++) await pause(100);
    if (!exited) child.kill('SIGTERM');
    fs.closeSync(stdout); fs.closeSync(stderr);
  }
}
const report = { passed: true, exe, version: expected, fixture, executableHash: hash(fs.readFileSync(exe)), mainBundleHash: bundleHash, reports };
fs.writeFileSync(path.join(output, 'acceptance.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify({ passed: true, exe, version: expected, report: path.join(output, 'acceptance.json') }));
