// Real Electron composer -> durable IPC -> local Magpie. Never reads the user's profile.
const fs = require('node:fs'), path = require('node:path'), cp = require('node:child_process'), net = require('node:net');
const WebSocket = require('ws');
const getJson=url=>new Promise((resolve,reject)=>{const req=require('node:http').get(url,r=>{let s='';r.on('data',c=>s+=c);r.on('end',()=>{try{resolve(JSON.parse(s))}catch(e){reject(e)}})});req.setTimeout(3000,()=>req.destroy(Error('HTTP timeout')));req.on('error',reject)});
const root = path.resolve(__dirname, '..');
fs.mkdirSync(path.join(root, 'out/diagnostics'), { recursive: true });
const run = process.env.ADMISSION_ATTACH_RUN || fs.mkdtempSync(path.join(root, 'out/diagnostics/send-admission-'));
const home = path.join(run, 'profile'), agentDir = path.join(home, '.mybuddy');
for (const d of [agentDir, 'AppData/Roaming', 'AppData/Local', '.config', '.cache'].map(d => path.isAbsolute(d) ? d : path.join(home, d))) fs.mkdirSync(d, { recursive: true });
const model = 'opendesign/deepseek-v4.1-flash-eco';
fs.writeFileSync(path.join(agentDir, 'models.json'), JSON.stringify({ providers: { 'admission-magpie': { baseUrl: 'http://127.0.0.1:3425/v1', api: 'openai-completions', apiKey: 'local-loopback-no-secret', models: [{ id: model, name: 'Admission Magpie', reasoning: false, input: ['text'], contextWindow: 327680, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }] } } }));
fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultModelId: 'admission-magpie/' + model, defaultProvider: 'admission-magpie', defaultModel: model, enabledModels: ['admission-magpie/' + model], memoryEnabled: true, memoryGatewayEnabled: false, remoteAccessEnabled: false, closeToTray: false, permissionMode: 'auto', theme: 'light' }));
const report = { run, model, isolatedProfile: home, memoryEnabled: true, turns: [], status: 'running' };
const wait = ms => new Promise(r => setTimeout(r, ms));
async function until(fn, label, timeout = 60000) { const end = Date.now() + timeout; while (Date.now() < end) { if (await fn()) return; await wait(50); } throw Error('Timeout: ' + label); }
const freePort = () => new Promise(r => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); });
let proc, socket, log, seq = 0;
const pending = new Map();
function rpc(method, params = {}) { return new Promise((resolve, reject) => { const id = ++seq; const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout ' + method)); }, 30000); pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params })); }); }
async function evaluate(expression) { const r = await rpc('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result?.value; }
async function send(text) {
  await evaluate(`(()=>{const e=document.querySelector('.chat-input textarea')||document.querySelector('textarea');e.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
  await wait(120);
  await evaluate(`window.__probe.turns.push({text:${JSON.stringify(text)},start:performance.now(),pressedAt:new Date().toISOString(),previousAssistantIds:Object.keys(window.__probe.assistants)})`);
  await evaluate(`(()=>{const b=document.querySelector('.send-btn');if(!b||b.disabled)throw Error('Send button unavailable '+document.body.innerText.slice(-1000));b.click();})()`);
  await until(()=>evaluate('Boolean(window.__probe.turns.at(-1)?.acceptedMs)'), 'IPC admission', 30000);
  await until(() => evaluate('Boolean(window.__probe.turns.at(-1)?.completedMs)'), 'real model completion', 180000);
  await until(() => evaluate('Boolean(window.__probe.turns.at(-1)?.visibleMs)'), 'user bubble');
  await evaluate(`(()=>{const t=window.__probe.turns.at(-1);t.finalBubbleCount=[...document.querySelectorAll('.msg-row.user .user-bubble-text')].filter(e=>e.textContent.includes(t.text)).length;})()`);
  report.turns = await evaluate('window.__probe.turns');
  console.log(JSON.stringify(report.turns.at(-1)));
}
(async () => { try {
  const port = Number(process.env.ADMISSION_CDP_PORT) || await freePort(), rendererPort = Number(process.env.ADMISSION_RENDERER_PORT) || await freePort();
  const config = path.join(run, 'vite.config.mjs');
  const base = path.join(root, 'electron.vite.config.ts').replaceAll('\\', '/');
  fs.writeFileSync(config, `import base from ${JSON.stringify(base)};\nconst c=base;\nfor(const k of ['main','preload','renderer'])c[k].build={...c[k].build,outDir:${JSON.stringify(run.replaceAll('\\', '/'))}+'/'+k,emptyOutDir:true};\nc.renderer.server={...c.renderer.server,port:${rendererPort},strictPort:true};\nexport default c;\n`);
  const env = { ...process.env, HOME: home, USERPROFILE: home, APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local'), XDG_CONFIG_HOME: path.join(home, '.config'), XDG_CACHE_HOME: path.join(home, '.cache'), PI_CODING_AGENT_DIR: agentDir, MYBUDDY_ADMISSION_TRACE: '1', ELECTRON_ENTRY: path.join(run, 'main/index.js'), ELECTRON_CLI_ARGS: JSON.stringify(['--remote-debugging-address=127.0.0.1', '--disable-background-timer-throttling', '--disable-backgrounding-occluded-windows', '--disable-features=CalculateNativeWinOcclusion']) };
  delete env.ELECTRON_RUN_AS_NODE;
  log = fs.openSync(path.join(run, 'desktop.log'), 'a');
  if (!process.env.ADMISSION_ATTACH_RUN) proc = cp.spawn(process.execPath, [path.join(root, 'node_modules/electron-vite/bin/electron-vite.js'), 'dev', '--config', config, '--remoteDebuggingPort', String(port)], { cwd: root, env, windowsHide: true, stdio: ['ignore', log, log] });
  report.launcherPid = proc?.pid; console.log('ISOLATED_LAUNCH ' + JSON.stringify({ run, pid: proc?.pid, port, rendererPort }));
  let target;
  await until(async () => { if (proc && proc.exitCode !== null) throw Error('Dev exited ' + proc.exitCode); try { target = (await getJson(`http://127.0.0.1:${port}/json/list`)).find(t => t.type === 'page' && t.url.includes(':' + rendererPort)); return !!target; } catch { return false; } }, 'isolated compiled renderer', 300000);
  console.log('COMPILED_ISOLATED_ELECTRON_READY');
  socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r, j) => { socket.addEventListener('open', r, { once: true }); socket.addEventListener('error', j, { once: true }); });
  socket.addEventListener('message', e => { const r = JSON.parse(e.data), p = pending.get(r.id); if (!p) return; pending.delete(r.id); clearTimeout(p.timer); r.error ? p.reject(Error(JSON.stringify(r.error))) : p.resolve(r.result); });
  await rpc('Runtime.enable');
  await until(() => evaluate('Boolean(window.api?.agent&&document.querySelector("textarea"))'), 'composer');
  await evaluate(`(()=>{const e=[...document.querySelectorAll('.hero-categories button')].find(e=>e.textContent.trim()==='通用模式');e?.click();})()`);
  await evaluate(`window.__probe={turns:[],events:[],assistants:{}};window.api.agent.onEvent(e=>{
    const p=window.__probe,t=p.turns.at(-1);if(!t)return;const ms=performance.now()-t.start;
    if(e.type==='durable_snapshot'||e.type==='durable_delta'){
      const rows=e.snapshot?.messages||e.delta?.upserts||[];
      const user=rows.find(m=>m.role==='user'&&m.text===t.text);
      if(user&&!t.acceptedMs){t.acceptedMs=ms;t.taskId=e.taskId;t.inputRequestId=user.inputRequestId;}
      const assistant=rows.find(m=>m.role==='assistant'&&m.text?.trim()&&!t.previousAssistantIds.includes(m.id));rows.filter(m=>m.role==='assistant').forEach(m=>p.assistants[m.id]=true);
      if(t.acceptedMs&&assistant&&!t.firstOutputMs){t.firstOutputMs=ms;t.firstOutput=assistant.text.slice(0,200);}
      const state=e.snapshot||e.delta?.state;
      if(assistant)t.finalText=assistant.text;
      if(t.firstOutputMs&&state?.busy===false&&!t.completedMs)t.completedMs=ms;
    }
    if(e.type==='error')p.events.push({type:e.type,message:e.message,ms});
  });
  window.__probe.observer=new MutationObserver(()=>{const t=window.__probe.turns.at(-1);if(!t)return;const ms=performance.now()-t.start;const el=[...document.querySelectorAll('.msg-row.user .user-bubble-text')].find(e=>e.textContent.includes(t.text));if(el&&!t.visibleMs){t.visibleMs=ms;t.visibleAsSubmitting=!!el.closest('.msg-row')?.querySelector('.bot-submission-status');} });window.__probe.observer.observe(document.body,{subtree:true,childList:true,characterData:true});`);
  await send('这是消息显示速度实测。请记住本对话的项目代号是青松，负责人是小林。只回复：已记住。不要调用任何工具。');
  await send('继续刚才的项目。请用一句话说出项目代号和负责人。只根据本对话回答，不要调用工具。');
  report.events = await evaluate('window.__probe.events');
  const [initial, followup] = report.turns;
  if (report.events.length || report.turns.some(t => !(t.visibleMs >= 0 && t.visibleMs <= 500 && t.acceptedMs >= 0 && t.firstOutputMs >= 0 && t.completedMs >= t.firstOutputMs && t.finalBubbleCount === 1 && t.inputRequestId))) throw Error('Real-send acceptance failure: '+JSON.stringify(report.turns));
  if (!followup.visibleAsSubmitting || followup.taskId !== initial.taskId || followup.inputRequestId === initial.inputRequestId || !/青松/.test(followup.finalText) || !/小林/.test(followup.finalText)) throw Error('Continuation did not stay in the same task or use prior context');
  report.status = 'passed';
} catch (e) { if(socket?.readyState===1){try{report.turns=await evaluate('window.__probe?.turns');report.dom=await evaluate('document.body.innerText.slice(-2500)')}catch{}} report.status = 'failed'; report.error = e.stack; process.exitCode = 1;
} finally {
  if (socket?.readyState === 1) { try { await rpc('Browser.close'); } catch {} socket.close(); }
  if (proc && proc.exitCode === null) { await wait(1000); if (proc.exitCode === null) proc.kill(); }
  if (log !== undefined) fs.closeSync(log);
  fs.writeFileSync(path.join(run, 'report.json'), JSON.stringify(report, null, 2)); console.log(JSON.stringify(report, null, 2));
} })();




