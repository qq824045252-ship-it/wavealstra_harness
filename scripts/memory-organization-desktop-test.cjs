/** Real desktop + preload IPC + model HTTP + SQLite validation, using an isolated temporary profile. */
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const root = path.resolve(__dirname, '..');
const exe = process.argv[2] ? path.resolve(process.argv[2]) : undefined;
const out = path.join(root, 'out/tests/memory-organization-desktop', exe ? 'packaged' : 'dev');
fs.mkdirSync(out, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mybuddy-organization-desktop-'));
const agentDir = path.join(profile, '.mybuddy');
for (const dir of [agentDir, path.join(agentDir, 'plugins'), path.join(profile, 'appdata'), path.join(profile, 'localappdata')]) fs.mkdirSync(dir, { recursive: true });
const report = { startedAt: new Date().toISOString(), profile, exe, requests: 0, phases: [], status: 'running' };
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const server = http.createServer(async (req, res) => {
  try {
    assert(req.method === 'POST' && req.url.endsWith('/chat/completions'));
    const buffers = []; for await (const buffer of req) buffers.push(buffer);
    const body = JSON.parse(Buffer.concat(buffers).toString('utf8'));
    assert(JSON.stringify(body.messages).includes('记忆整理器'), 'unexpected model operation');
    const message = [...body.messages].reverse().find(m => m.role === 'user');
    const records = JSON.parse(typeof message.content === 'string' ? message.content : message.content.map(c => c.text || '').join('')).memories;
    report.requests++;
    const duplicates = records.filter(r => r.content.includes('先完善示波器'));
    const value = { reviewedIds: records.map(r => r.id), proposals: duplicates.length >= 2 ? [{ action: 'merge', sourceIds: duplicates.map(r => r.id), reason: '同一开发顺序的重复表达', after: [{ kind: duplicates[0].kind, title: '仪器开发顺序', content: '先完善示波器，再开发频谱仪。' }] }] : [] };
    res.writeHead(200, { 'content-type': 'text/event-stream' });
    const base = { id: 'chatcmpl-organization', object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'organization-fixture' };
    for (const [delta, finish_reason] of [[{ role: 'assistant' }, null], [{ content: JSON.stringify(value) }, null], [{}, 'stop']]) {
      res.write('data: ' + JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason }] }) + '\n\n');
    }
    res.end('data: [DONE]\n\n');
  } catch (error) { report.serverError = error.stack; res.writeHead(500); res.end(JSON.stringify({ error: { message: error.message } })); }
});
async function port() {
  const probe = net.createServer(); await new Promise(r => probe.listen(0, '127.0.0.1', r));
  const result = probe.address().port; await new Promise(r => probe.close(r)); return result;
}
async function phase(name, work) {
  const debugPort = await port();
  const env = { ...process.env, HOME: profile, USERPROFILE: profile, APPDATA: path.join(profile, 'appdata'), LOCALAPPDATA: path.join(profile, 'localappdata'), PI_CODING_AGENT_DIR: agentDir };
  delete env.ELECTRON_RUN_AS_NODE;
  for (const key of Object.keys(env)) if (/^MYBUDDY_/i.test(key)) delete env[key];
  const log = fs.openSync(path.join(out, name + '.log'), 'w');
  const child = spawn(exe || require('electron'), [...(exe ? [] : [path.join(root, 'out/main/index.js')]), `--inspect=127.0.0.1:${debugPort}`,
    `--user-data-dir=${path.join(profile, 'chromium')}`], { cwd: profile, env, windowsHide: true, stdio: ['ignore', log, log] });
  let ws, exited = false;
  child.on('exit', () => { exited = true; });
  const pending = new Map(); let sequence = 0;
  const rpc = (method, params) => new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout: ' + method)); }, 30000);
    pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async expression => {
    const result = await rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
    return result.result.value;
  };
  try {
    let target;
    for (let i = 0; i < 150; i++) {
      if (exited) throw Error('Desktop exited before startup');
      try { target = (await fetch(`http://127.0.0.1:${debugPort}/json/list`).then(r => r.json())).find(t => t.type === 'node'); } catch {}
      if (target) break; await delay(200);
    }
    assert(target, 'main process inspector missing');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = reject; });
    ws.onmessage = event => { const message = JSON.parse(event.data); const item = pending.get(message.id); if (!item) return;
      pending.delete(message.id); clearTimeout(item.timer); message.error ? item.reject(Error(JSON.stringify(message.error))) : item.resolve(message.result); };
    assert.equal(await evaluate('process.pid'), child.pid);
    await evaluate(`(async()=>{const req=process.mainModule.require.bind(process.mainModule);const {app,BrowserWindow}=req('electron');await app.whenReady();
      if(req('node:os').homedir()!==${JSON.stringify(profile)}||!app.getPath('userData').startsWith(${JSON.stringify(profile)}))throw Error('Profile isolation failed');
      for(let i=0;i<150;i++){globalThis.organizationWindow=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('out/renderer/index.html')&&!w.webContents.isLoadingMainFrame());if(globalThis.organizationWindow)break;await new Promise(r=>setTimeout(r,200))}
      if(!globalThis.organizationWindow)throw Error('Renderer missing');return true})()`);
    const renderer = async expression => {
      const result = await evaluate(`globalThis.organizationWindow.webContents.executeJavaScript(${JSON.stringify(`(async()=>{try{return {value:await (${expression})}}catch(error){return {error:String(error.stack||error)}}})()`)} )`);
      if (result.error) throw Error(result.error); return result.value;
    };
    const until = async expression => {
      for (let i = 0; i < 200; i++) { const value = await renderer(expression); if (value) return value; await delay(100); }
      throw Error('UI condition timed out: ' + expression);
    };
    await until('!!window.api?.memory?.startOrganization && !!document.querySelector(".sidebar-user-main")');
    const invoke = (method, ...args) => renderer(`window.api.${method}(${args.map(arg => JSON.stringify(arg)).join(',')})`);
    const click = async label => {
      await until(`[...document.querySelectorAll('button')].some(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled&&b.getClientRects().length)`);
      await renderer(`(()=>{[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===${JSON.stringify(label)}&&!b.disabled&&b.getClientRects().length).click();return true})()`);
    };
    const openMemory = async () => {
      await renderer(`(()=>{document.querySelector('.sidebar-user-main').click();return true})()`); await click('设置');
      await until(`!!document.querySelector('.settings-nav')`);
      await renderer(`(()=>{[...document.querySelectorAll('.settings-nav button')].find(b=>b.textContent.trim()==='记忆').click();return true})()`);
      await until(`!!document.querySelector('[aria-label="AI 整理记忆"]')`);
    };
    await work({ invoke, renderer, until, click, openMemory });
    const identity = await evaluate(`(async()=>{const req=process.mainModule.require.bind(process.mainModule);const {app}=req('electron');const image=await globalThis.organizationWindow.capturePage();req('node:fs').writeFileSync(${JSON.stringify(path.join(out, name + '.png'))},image.toPNG());return {version:app.getVersion(),packaged:app.isPackaged,userData:app.getPath('userData'),pid:process.pid}})()`);
    if (exe) { assert(identity.packaged); assert.equal(identity.version, JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version); }
    report.phases.push({ name, identity });
    await evaluate(`setTimeout(()=>process.mainModule.require('electron').app.quit(),50);true`);
  } finally {
    ws?.close();
    for (const item of pending.values()) { clearTimeout(item.timer); item.reject(Error('Desktop closed')); }
    for (let i = 0; i < 40 && !exited; i++) await delay(100);
    if (!exited) child.kill('SIGTERM');
    fs.closeSync(log);
  }
}
(async () => {
  try {
    await new Promise(r => server.listen(0, '127.0.0.1', r));
    fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { fixture: { api: 'openai-completions', baseUrl: `http://127.0.0.1:${server.address().port}/v1`, apiKey: 'local-fixture-only', models: [{ id: 'organization-fixture', name: 'Organization fixture', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 8192, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
    fs.writeFileSync(path.join(agentDir, 'auth.json'), '{}');
    fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'fixture', defaultModel: 'organization-fixture', enabledModels: ['fixture/organization-fixture'], memoryEnabled: true, memoryGatewayEnabled: false, remoteAccessEnabled: false, closeToTray: false, proxyUrl: '' }));
    fs.writeFileSync(path.join(agentDir, 'plugins/mcp.json'), '{"mcpServers":{}}');
    const capabilities = { schemaVersion: 1, execution: { terminalEnabled: false, codeExecutionEnabled: false } };
    for (const key of ['web', 'vision', 'imageGeneration', 'videoGeneration', 'speechToText', 'textToSpeech', 'browser', 'diagnostics', 'subagent', 'multiModelConsult']) capabilities[key] = { enabled: false };
    fs.writeFileSync(path.join(agentDir, 'capabilities.json'), JSON.stringify(capabilities));
    let runId;
    await phase('preview', async ({ invoke, until, click, openMemory }) => {
      assert.equal((await invoke('memory.stats')).total, 0, 'temporary database must start empty');
      assert.equal((await invoke('agent.getModelsConfig')).providers.fixture.baseUrl, `http://127.0.0.1:${server.address().port}/v1`);
      await invoke('db.upsertSpace', { id: 'organization-space', name: '仪器研发' });
      for (const scope of [{ scopeType: 'global' }, { scopeType: 'workspace', scopeId: 'organization-space' }]) {
        for (const title of ['先做示波器的决定', '再次确认开发顺序']) await invoke('memory.create', { ...scope, kind: 'decision', title, content: '先完善示波器，再开发频谱仪。', sourceType: 'manual', evidence: [{ evidenceKind: 'external', refId: title, excerpt: '已确认的开发顺序' }] });
      }
      await openMemory(); await click('整理全部记忆');
      const result = await until(`window.api.memory.organization().then(r=>r?.status==='ready'?r:r?.status==='paused'?Promise.reject(Error(r.error)):false)`);
      assert.equal(result.total, 4); assert.equal(result.scanned, 4); assert.equal(result.proposals.length, 2);
      assert(result.proposals.every(p => p.scopes.length === 1));
      assert.equal((await invoke('memory.stats')).active, 4, 'preview must not change facts'); runId = result.id;
      await click('收起变更明细');
      console.log('PASS actual desktop: whole-store preview through local model HTTP, original scopes retained');
    });
    await phase('reopen-apply-undo', async ({ invoke, until, click, openMemory }) => {
      assert.equal((await invoke('memory.organization')).id, runId, 'preview survives real app restart');
      await openMemory(); await click('应用 2 项变更');
      await until(`window.api.memory.organization().then(r=>r?.status==='applied')`);
      assert.equal((await invoke('memory.stats')).active, 2);
      const current = await invoke('memory.list', { status: 'active' });
      assert(current.every(r => r.evidence.length === 2 && r.relations.length === 1));
      await click('撤销整理');
      await until(`window.api.memory.organization().then(r=>r?.status==='undone')`);
      assert.equal((await invoke('memory.stats')).active, 4);
      assert((await invoke('memory.list', { status: 'active' })).every(r => r.evidence.length === 1 && r.relations.length === 0));
      console.log('PASS actual desktop: persisted preview, atomic application, original provenance and undo');
    });
    assert(!report.serverError, report.serverError);
    report.status = 'passed';
    if (exe) report.asarSha256 = crypto.createHash('sha256').update(fs.readFileSync(path.join(path.dirname(exe), 'resources/app.asar'))).digest('hex');
  } catch (error) { report.status = 'failed'; report.error = error.stack; console.error(error.stack); process.exitCode = 1; }
  finally { server.closeAllConnections(); server.close(); fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(report, null, 2)); }
})();
