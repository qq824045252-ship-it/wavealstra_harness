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
const output = path.resolve('out/tests/project-notes-package');
fs.mkdirSync(output, { recursive: true });
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), 'mybuddy-project-notes-package-'));
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
    const waitFor = async expression => {
      for (let i = 0; i < 150; i++) { if (await renderer(expression)) return; await pause(100); }
      throw Error('UI condition timed out: ' + expression);
    };
    await waitFor('!!window.api?.projectNotes && !!document.querySelector(".sidebar-user-main")');
    let projectId;
    if (phase === 'save') {
      const created = await renderer(`window.api.db.createProject({name:'项目便签验收'})`);
      assert(created.ok, JSON.stringify(created));
      projectId = created.project.id;
      fs.writeFileSync(path.join(output, 'fixture-project.json'), JSON.stringify({projectId}));
    } else {
      projectId = JSON.parse(fs.readFileSync(path.join(output, 'fixture-project.json'))).projectId;
      const persisted = await renderer(`window.api.projectNotes.read(${JSON.stringify(projectId)})`);
      assert(persisted.content.includes('任务可共同维护'));
      assert.equal(persisted.revision, 1);
      reports.push({ phase, persisted });
    }
    await renderer(`(()=>{document.querySelector('.sidebar-user-main').click()})()`);
    await waitFor(`[...document.querySelectorAll('.sidebar-popup-item')].some(e=>e.textContent.trim()==='项目')`);
    await renderer(`(()=>{[...document.querySelectorAll('.sidebar-popup-item')].find(e=>e.textContent.trim()==='项目').click()})()`);
    await waitFor(`[...document.querySelectorAll('.project-home-card-open')].some(e=>e.textContent.includes('项目便签验收'))`);
    await renderer(`(()=>{[...document.querySelectorAll('.project-home-card-open')].find(e=>e.textContent.includes('项目便签验收')).click()})()`);
    await waitFor(`[...document.querySelectorAll('.project-desk-tab')].some(e=>e.textContent==='便签')`);
    await renderer(`(()=>{[...document.querySelectorAll('.project-desk-tab')].find(e=>e.textContent==='便签').click()})()`);
    await waitFor(`!!document.querySelector('[aria-label="Markdown 便签内容"]') && !document.querySelector('textarea[aria-label="Markdown 便签内容"]').disabled`);
    if (phase === 'save') {
      const content = '# 项目便签\n\n**任务可共同维护**\n\n- [ ] 核对项目进度';
      await renderer(`(()=>{const e=document.querySelector('textarea[aria-label="Markdown 便签内容"]');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(content)});e.dispatchEvent(new Event('input',{bubbles:true}))})()`);
      await waitFor(`[...document.querySelectorAll('button')].some(e=>e.textContent==='保存便签'&&!e.disabled)`);
      await renderer(`(()=>{[...document.querySelectorAll('button')].find(e=>e.textContent==='保存便签').click()})()`);
      await waitFor(`document.querySelector('[aria-label="项目便签"]').innerText.includes('已保存 ·')`);
      const saved = await renderer(`window.api.projectNotes.read(${JSON.stringify(projectId)})`);
      assert.equal(saved.content, content);
      reports.push({phase, saved});
    }
    await renderer(`(()=>{[...document.querySelectorAll('button')].find(e=>e.textContent==='预览').click()})()`);
    await waitFor(`document.querySelector('.workspace-notes-preview strong')?.textContent==='任务可共同维护'`);
    // capturePage can observe the previous compositor frame immediately after a React update.
    await pause(300);
    const identity = await evaluate(`(async()=>{const req=process.mainModule.require.bind(process.mainModule);const {app}=req('electron');const w=globalThis.noteTestWindow;const image=await w.capturePage();req('node:fs').writeFileSync(${JSON.stringify(path.join(output, phase + '-packaged-project-notes.png'))},image.toPNG());return {version:app.getVersion(),packaged:app.isPackaged,userData:app.getPath('userData'),pid:process.pid}})()`);
    assert(identity.packaged && identity.version === expected);
    reports.push({phase, identity});
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
