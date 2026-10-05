/** Full Electron/IPC/Pi path with isolated profile, controlled search HTTP and an inline evidence model. */
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process'), net = require('node:net'), http = require('node:http');
const root = path.resolve(__dirname, '..'), temp = fs.mkdtempSync(path.join(os.tmpdir(), 'mybuddy-search-desktop-'));
const profile = path.join(temp, 'profile'), agentDir = path.join(profile, '.mybuddy'), out = path.join(root, 'out/tests/multi-search');
for (const dir of [agentDir, out, path.join(profile, 'AppData/Roaming'), path.join(profile, 'AppData/Local')]) fs.mkdirSync(dir, { recursive: true });
const requests = [];
let dispatchedSearch = false;
const server = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const body = JSON.parse(raw); requests.push(body);
  const stringify = c => typeof c === 'string' ? c : JSON.stringify(c);
  const semantic = body.messages.some(m => stringify(m.content).includes('You assess web evidence'));
  let tool, content;
  if (semantic) {
    let user = body.messages.findLast(m => m.role === 'user').content;
    if (Array.isArray(user)) user = user.map(p => p.text || '').join('');
    const input = JSON.parse(user);
    const support = input.passages.find(p => p.kind === 'page' && p.text.includes('支持离线运行'));
    const contra = input.passages.find(p => p.kind === 'page' && p.text.includes('不支持离线运行'));
    assert(support && contra, 'actual page passages must reach evidence model');
    content = JSON.stringify({ claims: [{ claim: '该设备支持离线运行。', rationale: '旧版与新版的原文说明不同，存在版本限制。', citations: [{ passageId: support.passage_id, quote: support.text, stance: 'support' }, { passageId: contra.passage_id, quote: contra.text, stance: 'contradict' }] }] });
  } else {
    if (!dispatchedSearch) { dispatchedSearch = true; tool = { name: 'web_search', arguments: JSON.stringify({ query: '该设备是否支持离线运行', workflow: 'none' }) }; }
    else content = 'MULTI_SEARCH_DESKTOP_COMPLETE';
  }
  const packet = (delta, finish_reason) => ({ id: 'search-fixture-' + requests.length, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model: 'fixture', choices: [{ index: 0, delta, finish_reason }] });
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.write('data: ' + JSON.stringify(packet(tool ? { role: 'assistant', tool_calls: [{ index: 0, id: 'search-call-' + requests.length, type: 'function', function: tool }] } : { role: 'assistant', content }, null)) + '\n\n');
  res.end('data: ' + JSON.stringify(packet({}, tool ? 'tool_calls' : 'stop')) + '\n\ndata: [DONE]\n\n');
});
const bootstrap = path.join(temp, 'bootstrap.cjs');
fs.writeFileSync(bootstrap, `
const fs = require('node:fs');
require('electron').app.setPath('userData', ${JSON.stringify(path.join(profile, 'electron-user-data'))});
const original = globalThis.fetch;
const log = ${JSON.stringify(path.join(out, 'network-fixture.jsonl'))};
globalThis.fetch = async (input, init) => {
  const url = String(input);
  if (url.includes('api.tavily.com/search') || url.includes('google.serper.dev/search')) {
    fs.appendFileSync(log, JSON.stringify({url,at:Date.now()})+'\\n');
    await new Promise(r=>setTimeout(r,url.includes('tavily')?450:100));
    const a = {title:'旧版产品说明',url:'https://example.com/spec?utm_source=tavily',content:'该设备支持离线运行。'};
    return Response.json(url.includes('tavily')?{answer:'供应商摘要未经独立核验',results:[a]}:{organic:[{title:a.title,link:'https://example.com/spec?utm_source=serper',snippet:a.content},{title:'新版产品说明',link:'https://example.org/update',snippet:'新版设备不支持离线运行。'}]});
  }
  if (url.includes('example.com') || url.includes('example.org')) {
    const sentence=url.includes('example.org')?'新版设备不支持离线运行。':'该设备支持离线运行。';
    return new Response('<html lang="zh"><head><title>产品规格说明</title></head><body><article><h1>设备运行说明</h1><p>'+sentence+'本文记录相应版本的实际运行条件，测试日期为 2026 年 9 月。'+('请核对产品型号与软件版本，以本文具体说明为准。'.repeat(20))+'</p></article></body></html>',{headers:{'content-type':'text/html; charset=utf-8'}});
  }
  return original(input,init);
};
require(${JSON.stringify(path.join(root, 'out/main/index.js'))});
`);
let proc, socket, fd, seq = 0; const pending = new Map();
const delay = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label, timeout = 30000) { const end = Date.now() + timeout; while (Date.now() < end) { const v = await fn(); if (v) return v; await delay(100); } throw Error('Timeout: ' + label); }
function rpc(method, params = {}) { return new Promise((resolve, reject) => { const id = ++seq, timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout ' + method)); }, 20000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); }); }
async function evaluate(expression) { const r = await rpc('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result?.value; }
async function launch() {
  const port = await new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
  const env = { ...process.env, HOME: profile, USERPROFILE: profile, APPDATA: path.join(profile, 'AppData/Roaming'), LOCALAPPDATA: path.join(profile, 'AppData/Local'), PI_CODING_AGENT_DIR: agentDir }; delete env.ELECTRON_RUN_AS_NODE;
  fd = fs.openSync(path.join(out, 'desktop.log'), 'a');
  proc = cp.spawn(require('electron'), [bootstrap, '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port], { cwd: root, env, stdio: ['ignore', fd, fd], windowsHide: true });
  const page = await until(async () => { if (proc.exitCode !== null) throw Error('Electron exited ' + proc.exitCode); try { return (await fetch('http://127.0.0.1:' + port + '/json/list').then(r => r.json())).find(t => t.type === 'page' && t.url.includes('index.html')); } catch {} }, 'renderer');
  socket = new WebSocket(page.webSocketDebuggerUrl); await new Promise((r, j) => { socket.addEventListener('open', r, { once: true }); socket.addEventListener('error', j, { once: true }); });
  socket.addEventListener('message', e => { const m = JSON.parse(e.data), p = pending.get(m.id); if (!p) return; pending.delete(m.id); clearTimeout(p.timer); m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result); });
  await rpc('Runtime.enable'); await rpc('Emulation.setDeviceMetricsOverride', { width: 1280, height: 960, deviceScaleFactor: 1, mobile: false });
  await until(() => evaluate('Boolean(window.api?.agent && document.querySelector("button[title=设置]"))'), 'app ready');
  await evaluate('window.__searchEvents=[];window.__searchErrors=[];window.api.agent.onEvent(e=>window.__searchEvents.push(e));window.addEventListener("error",e=>window.__searchErrors.push(e.message));true');
}
async function close() { if (socket) { try { await rpc('Browser.close'); } catch {} socket.close(); socket = null; } if (proc) { await delay(500); if (proc.exitCode === null) cp.execFileSync('C:/Windows/System32/taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); proc = null; } if (fd !== undefined) { fs.closeSync(fd); fd = undefined; } }
async function click(selector) { await until(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`), selector); const point = await evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'center'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`); await rpc('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point }); await rpc('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point }); await delay(100); }
async function screenshot(name) { const r = await rpc('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(r.data, 'base64')); }
const report = { tests: [], status: 'running', profile };
(async () => { try {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const baseUrl = 'http://127.0.0.1:' + server.address().port + '/v1';
  fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { 'search-fixture': { baseUrl, api: 'openai-completions', apiKey: 'fixture', models: [{ id: 'fixture', name: 'Search Fixture', reasoning: false, input: ['text'], contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
  fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'search-fixture', defaultModel: 'fixture', enabledModels: ['search-fixture/fixture'], memoryEnabled: false, memoryGatewayEnabled: false, remoteAccessEnabled: false, closeToTray: false, theme: 'light' }));
  fs.writeFileSync(path.join(agentDir, 'web-search.json'), JSON.stringify({ tavilyApiKey: 'fixture', serperApiKey: 'fixture', workflow: 'none', searchRouting: { providers: ['tavily'], fallbackOn: ['network', 'quota', 'transient'] }, ssrf: { allowRanges: ['198.18.0.0/15'] } }));
  await launch();
  await click('button[title="设置"]');
  await evaluate(`([...document.querySelectorAll('.settings-nav-btn')].find(e=>e.textContent.trim()==='工具能力')).click()`);
  await until(() => evaluate('Boolean(document.querySelector(".search-settings"))'), 'search settings');
  await evaluate(`(()=>{const e=document.querySelector('.search-settings select');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,'parallel');e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
  await until(() => evaluate(`document.querySelectorAll('.search-provider-grid input:checked').length===2`), 'two selected providers');
  await evaluate(`document.querySelector('.search-settings').scrollIntoView({block:'center'})`);
  await screenshot('settings-parallel');
  await click('.capabilities-footer .btn.primary');
  const saved = await until(() => evaluate('window.api.agent.getWebSearchConfig().then(c=>c.searchPolicy?.mode==="parallel"?c.searchPolicy:false)'), 'saved policy');
  assert.deepEqual(saved.providers, ['tavily', 'serper']); assert.equal(saved.verifySources, true); report.tests.push('settings checkbox -> IPC -> file readback: two providers and evidence enabled');
  await click('.settings-content-head .icon-btn');
  await until(() => evaluate('!document.querySelector(".settings-modal")'), 'close settings');
  await evaluate(`(()=>{const e=document.querySelector('.chat-input textarea')||document.querySelector('textarea');e.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,'请搜索该设备是否支持离线运行');e.dispatchEvent(new Event('input',{bubbles:true}));})()`); await delay(100);
  await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 }); await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await until(() => evaluate('document.body.innerText.includes("MULTI_SEARCH_DESKTOP_COMPLETE")'), 'native search with inline evidence', 90000);
  const end = await evaluate('window.__searchEvents.filter(e=>e.type==="tool_update"&&e.webSearch?.evidence).at(-1)');
  assert(end?.webSearch, 'search report must traverse native events'); assert.equal(end.webSearch.sources.length, 2); assert.equal(end.webSearch.evidence[0].status, 'unclear'); assert.equal(end.webSearch.evidence[0].citations.length, 2);
  assert(await evaluate('window.__searchEvents.some(e=>e.webSearch?.runs.some(r=>r.status==="success")&&e.webSearch?.runs.some(r=>r.status==="running"))'));
  const toolResultRequest = requests.find(r => JSON.stringify(r.messages).includes('Passage-grounded assessment')); assert(toolResultRequest, 'parent model receives original evidence and provider state');
  report.tests.push('real native Pi tool -> concurrent adapters -> original-page extraction -> bounded inline semantic model -> exact conflicting citations -> parent model');
  await click('.web-search-heading'); await screenshot('results-merged');
  await evaluate(`([...document.querySelectorAll('.web-search-tabs button')].find(e=>e.textContent==='serper')).click()`);
  assert(await evaluate('document.querySelector(".web-search-scroll").innerText.includes("原始排名")')); await screenshot('results-provider');
  await evaluate(`([...document.querySelectorAll('.web-search-tabs button')].find(e=>e.textContent==='原文核验')).click()`);
  assert(await evaluate('document.querySelectorAll(".web-search-evidence blockquote").length===2')); await screenshot('results-evidence');
  assert.equal((await evaluate('window.__searchErrors')).length, 0); report.tests.push('merged / provider / evidence tabs with rendered exact Chinese quotes and no renderer errors');
  const history = await evaluate(`window.api.agent.loadTaskHistory(${JSON.stringify(end.taskId)})`); const stored = history.messages.flatMap(m => m.tools || []).find(t => t.webSearch)?.webSearch;
  assert.deepEqual(stored, end.webSearch); await close(); await launch();
  const restored = await evaluate(`window.api.agent.loadTaskHistory(${JSON.stringify(end.taskId)})`); assert.deepEqual(restored.messages.flatMap(m => m.tools || []).find(t => t.webSearch)?.webSearch, stored);
  assert.equal((await evaluate('window.api.agent.getWebSearchConfig()')).searchPolicy.mode, 'parallel');
  report.tests.push('full provider details and original evidence survive Electron restart and native history readback'); report.status = 'passed';
} catch (error) { report.status = 'failed'; report.error = error.stack; try { report.body = await evaluate('document.body.innerText.slice(-5000)'); report.events = await evaluate('window.__searchEvents.slice(-5)'); await screenshot('failure'); } catch {} }
finally { await close(); server.close(); fs.writeFileSync(path.join(out, 'desktop-results.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2)); process.exitCode = report.status === 'passed' ? 0 : 1; } })();
