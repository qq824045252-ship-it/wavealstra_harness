/** Opt-in: actual built Electron UI + authenticated Pi providers. No provider mocks.
 * Creates an isolated temporary profile, copies credentials without logging them,
 * checks the current source in a temporary task, and removes the profile on exit.
 * Run after pnpm build. Invokes the configured real providers and may incur cost.
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const root = process.cwd();
const port = Number(process.env.MYBUDDY_CONSULT_CDP_PORT || 9368);
const uiOnly = process.env.MYBUDDY_CONSULT_UI_ONLY === '1';
const output = path.join(root, 'out/tests', uiOnly ? 'multi-model-consult-ui-live' : 'multi-model-consult-live');
fs.mkdirSync(output, { recursive: true });
const reportFile = path.join(output, 'report.json');
const report = { mode: uiOnly ? 'ui-only' : 'full-real-model', result: 'RUNNING', phase: 'starting', startedAt: new Date().toISOString(), checks: [], scenarios: {}, error: null };
const save = () => fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
const phase = (value) => { report.phase = value; save(); console.log(value); };
const check = (name, value) => { assert(value, name); report.checks.push(name); save(); };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mybuddy-consult-live-'));
const dir = path.join(profile, '.mybuddy');
fs.mkdirSync(dir, { recursive: true });
const userDir = path.join(os.homedir(), '.mybuddy');
for (const name of ['auth.json', 'models.json', 'models-store.json']) {
  if (fs.existsSync(path.join(userDir, name))) fs.copyFileSync(path.join(userDir, name), path.join(dir, name));
}
const mainId = process.env.MYBUDDY_CONSULT_MAIN || 'commandcode/deepseek/deepseek-v4.1-flash';
const secondId = process.env.MYBUDDY_CONSULT_SECOND || 'google-vertex/gemini-3.8-flash';
const split = mainId.indexOf('/');
const enabledModels = [mainId, secondId];
fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({
  defaultProvider: mainId.slice(0, split), defaultModel: mainId.slice(split + 1), defaultThinkingLevel: 'high',
  enabledModels, memoryEnabled: false, memoryGatewayEnabled: false, remoteAccessEnabled: false,
  closeToTray: false, theme: 'light', language: 'zh-CN', permissionMode: 'readonly',
  cacheWarming: 'off', retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
}));
const caps = {
  schemaVersion: 1, web: { enabled: false }, vision: { enabled: false }, imageGeneration: { enabled: false },
  videoGeneration: { enabled: false }, speechToText: { enabled: false }, textToSpeech: { enabled: false },
  browser: { enabled: false }, execution: { terminalEnabled: false, codeExecutionEnabled: false }, subagent: { enabled: false },
  multiModelConsult: { enabled: true, participants: [{ modelId: mainId }, { modelId: secondId }], maxParallel: 2, readProjectFiles: true, timeoutSeconds: 240 },
};
fs.writeFileSync(path.join(dir, 'capabilities.json'), JSON.stringify(caps));
for (const sub of ['AppData/Roaming', 'AppData/Local']) fs.mkdirSync(path.join(profile, sub), { recursive: true });
const env = { ...process.env, USERPROFILE: profile, HOME: profile, APPDATA: path.join(profile, 'AppData/Roaming'), LOCALAPPDATA: path.join(profile, 'AppData/Local') };
delete env.ELECTRON_RUN_AS_NODE;
const log = fs.openSync(path.join(output, 'runtime.log'), 'w');
const proc = cp.spawn(require('electron'), [path.join(root, 'out/main/index.js'), `--remote-debugging-port=${port}`, '--disable-background-timer-throttling', '--disable-renderer-backgrounding'], { cwd: root, env, stdio: ['ignore', log, log], windowsHide: true });
report.pid = proc.pid; report.profile = profile; report.models = enabledModels; save();
let socket, rpcId = 0;
const pending = new Map();
function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++rpcId;
    const timeout = setTimeout(() => { pending.delete(id); reject(Error(`CDP timeout: ${method}`)); }, 30000);
    pending.set(id, { resolve, reject, timeout });
    socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const response = await rpc('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (response.exceptionDetails) throw Error(JSON.stringify(response.exceptionDetails));
  return response.result?.value;
}
async function waitFor(expression, maxMs = 20000) {
  const start = Date.now();
  while (Date.now() - start < maxMs) { const result = await evaluate(expression); if (result) return result; await sleep(150); }
  throw Error(`Timed out waiting for ${expression.slice(0, 180)}`);
}
async function click(selector) {
  await evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.disabled)throw Error('Missing/disabled: '+${JSON.stringify(selector)});el.click();return true})()`);
}
async function screenshot(name) {
  const shot = await rpc('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(shot.data, 'base64'));
}
async function installProbe() {
  await evaluate(`(()=>{
    window.__consultErrors=[];
    window.addEventListener('error', e=>window.__consultErrors.push(e.message));
    window.addEventListener('unhandledrejection', e=>window.__consultErrors.push(String(e.reason)));
    window.__consultProbe={events:[],consults:{},starts:[],done:false,text:''};
    window.api.agent.onEvent(e=>{
      const p=window.__consultProbe;if(!p)return;
      if(e.type==='assistant_start'&&!p.messageId){p.taskId=e.taskId;p.messageId=e.messageId;}
      if(!p.messageId||e.taskId!==p.taskId||(e.messageId&&e.messageId!==p.messageId)) {
        p.foreignEvents=p.foreignEvents||[];p.foreignEvents.push({type:e.type,messageId:e.messageId,at:Date.now()});return;
      }
      if(e.type==='text_delta')p.text+=e.delta;
      if(e.type==='assistant_end'){p.done=true;p.terminalError=e.error;}
      if(e.type==='tool_start')p.starts.push({id:e.toolCallId,tool:e.tool});
      if(e.type==='tool_update'&&e.consult){p.consults[e.toolCallId]=e.consult;p.progressCount=(p.progressCount||0)+1;p.sawLive=p.sawLive||e.consult.workers.some(w=>w.status==='running'&&(w.answer||w.tools.length));}
      p.events.push({type:e.type,messageId:e.messageId,executionId:e.executionId,status:e.status,tool:e.tool,at:Date.now()});
      if(p.events.length>300)p.events.shift();
    });return true;
  })()`);
}
async function selectConsult() {
  await click('.add-menu-anchor > button');
  await waitFor('!!document.querySelector("[data-testid=consult-add-menu]")');
  await click('[data-testid=consult-add-menu]');
  await waitFor('!!document.querySelector("[data-testid=consult-chip]")');
}
async function send(text, consult = false) {
  if (consult) await selectConsult();
  await evaluate(`(()=>{window.__consultProbe={events:[],consults:{},starts:[],done:false,text:''};const e=[...document.querySelectorAll('.input-area textarea')].find(e=>e.getBoundingClientRect().width>0);if(!e)throw Error('No composer');e.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(text)});e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
  await sleep(100);
  await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
  await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13 });
}
async function finish(name, maxMs = 480000) {
  await waitFor('window.__consultProbe?.done', maxMs);
  await sleep(350);
  const p = await evaluate('window.__consultProbe');
  const history = await evaluate('window.api.agent.loadTaskHistory(window.__consultProbe.taskId)');
  report.scenarios[name] = { ...p, history };
  save();
  check(name + ': main task finished without runtime error', !p.terminalError);
  return { p, history, consultation: Object.values(p.consults).at(-1) };
}
async function setConsultConfig(next) {
  caps.multiModelConsult = next;
  await evaluate(`window.api.agent.saveBuiltinCapabilities(${JSON.stringify(caps)})`);
}

(async () => {
  try {
    let target;
    for (let i = 0; i < 120; i++) {
      if (proc.exitCode !== null) throw Error('Electron exited during startup; see runtime.log');
      try { target = (await fetch(`http://127.0.0.1:${port}/json/list`).then((r) => r.json())).find((t) => t.type === 'page' && /index\.html/.test(t.url)); } catch {}
      if (target) break;
      await sleep(500);
    }
    if (!target) throw Error('No desktop debugging target');
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    socket.onmessage = (event) => { const message = JSON.parse(event.data); const item = pending.get(message.id); if (!item) return; clearTimeout(item.timeout); pending.delete(message.id); message.error ? item.reject(Error(JSON.stringify(message.error))) : item.resolve(message.result); };
    await waitFor('!!window.api?.agent && !!document.querySelector(".input-area textarea")', 60000);
    await installProbe();
    phase('checking-native-models');
    const models = await evaluate('window.api.agent.listModels()');
    report.availableSelectedModels = models.filter((m) => enabledModels.includes(m.id)).map((m) => ({ id: m.id, name: m.name, available: m.available, enabled: m.enabled, thinkingLevels: m.thinkingLevels }));
    check('both selected Pi models are authenticated and enabled', enabledModels.every((id) => models.some((m) => m.id === id && m.available !== false && m.enabled !== false)));
    const initialConfig = { ...caps.multiModelConsult, participants: enabledModels.map((id) => { const m = models.find((m) => m.id === id); return { modelId: id, ...(m.thinkingLevels?.includes('high') ? { thinkingLevel: 'high' } : {}) }; }) };
    await setConsultConfig(initialConfig);

    let cwd;
    if (!uiOnly) {
    phase('ordinary-message-no-forced-consultation');
    await send('仅回复 READY，不要调用任何工具。');
    const base = await finish('ordinary');
    check('ordinary message did not invoke consultation', !base.p.starts.some((t) => t.tool === 'multi_model_consult'));
    check('ordinary message obtained a real model answer', /READY/.test(base.p.text));
    const sessionFile = base.history.sessionFile;
    check('test session is isolated from the user profile', sessionFile && path.resolve(sessionFile).startsWith(path.resolve(profile) + path.sep));
    const header = fs.readFileSync(sessionFile, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)).find((entry) => entry.type === 'session');
    cwd = header?.cwd;
    check('test task directory is inside the temporary profile', cwd && path.resolve(cwd).startsWith(path.resolve(profile) + path.sep));
    report.taskRoot = cwd;
    const sourcePaths = ['src/main/capabilities/MultiModelConsult.ts', 'src/shared/multi-model-consult.ts'];
    report.sourceSnapshots = sourcePaths.map((relative) => {
      const bytes = fs.readFileSync(path.join(root, relative)); const destination = path.join(cwd, relative);
      fs.mkdirSync(path.dirname(destination), { recursive: true }); fs.writeFileSync(destination, bytes);
      return { relative, sha256: crypto.createHash('sha256').update(bytes).digest('hex') };
    });
    phase('real-code-review');
    await send('只读 review 当前任务目录中的 src/main/capabilities/MultiModelConsult.ts 和 src/shared/multi-model-consult.ts。请让每个会诊模型自己用 read 读取这两个文件，独立检查取消、超时、错误状态与会话清理；各给出不超过 5 条有代码证据的发现与行号，不要凭空凑问题，每个模型回答控制在 600 个汉字以内。你最终综合分歧与独有发现。不修改、不执行 shell、不派生其他 Agent。', true);
    const reviewed = await finish('review');
    check('one explicit main-agent consultation tool call', reviewed.p.starts.filter((t) => t.tool === 'multi_model_consult').length === 1);
    check('two real different models completed review', reviewed.consultation?.status === 'complete' && reviewed.consultation.succeeded === 2 && new Set(reviewed.consultation.workers.map((w) => w.modelId)).size === 2);
    check('each worker actually read code with native tools', reviewed.consultation.workers.every((w) => w.tools.some((t) => t.name === 'read' && t.status === 'success')));
    check('workers used no shell, writes or recursive consult', reviewed.consultation.workers.every((w) => w.tools.every((t) => ['read', 'grep', 'find', 'ls'].includes(t.name))));
    check('worker streaming/progress reached the live UI', reviewed.p.sawLive && reviewed.p.progressCount > 2);
    check('one-message chip cleared after send', !await evaluate('!!document.querySelector("[data-testid=consult-chip]")'));
    const persisted = reviewed.history.messages.flatMap((m) => m.tools || []).find((t) => t.consult?.id === reviewed.consultation.id)?.consult;
    check('Pi history retained exact complete worker answers and traces', JSON.stringify(persisted?.workers) === JSON.stringify(reviewed.consultation.workers));
    check('consultation card stays visible outside collapsed execution history', await evaluate('(()=>{const e=[...document.querySelectorAll("[data-testid=multi-model-consult-card]")].at(-1);return !!e&&e.getBoundingClientRect().height>0&&!e.closest("[aria-hidden=true]")})()'));
    await screenshot('review-main');
    await click('[data-testid=consult-open-details]');
    await waitFor('!!document.querySelector("dialog.consult-dialog[open]")');
    check('detail opens with exact first worker answer', await evaluate('document.querySelector("[data-testid=consult-raw-answer]")?.textContent') === reviewed.consultation.workers[0].answer);
    await evaluate('document.querySelectorAll(".consult-tabs [role=tab]")[1].click()');
    check('tabs show the other real worker answer', await evaluate('document.querySelector("[data-testid=consult-raw-answer]")?.textContent') === reviewed.consultation.workers[1].answer);
    await screenshot('review-details');
    await rpc('Emulation.setDeviceMetricsOverride', { width: 420, height: 820, deviceScaleFactor: 1, mobile: false });
    check('detail dialog fits a narrow viewport', await evaluate('(()=>{const d=document.querySelector(".consult-dialog");const r=d.getBoundingClientRect();return r.width<=innerWidth&&r.left>=0&&r.right<=innerWidth+1&&r.height<=innerHeight})()'));
    await screenshot('review-details-narrow');
    await rpc('Emulation.clearDeviceMetricsOverride');
    await click('[data-testid=consult-followup]');
    check('follow-up appends to main composer without starting a new worker', await evaluate('(()=>{const e=document.querySelector(".input-area textarea");return e.value.includes("请基于下列会诊发现继续调查")&&window.__consultProbe.starts.filter(t=>t.tool==="multi_model_consult").length===1})()'));
    await evaluate('(()=>{const e=document.querySelector(".input-area textarea");Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(e,"");e.dispatchEvent(new Event("input",{bubbles:true}));})()');
    // Real application reload, not only an in-memory reducer comparison.
    phase('reload-persistence');
    report.preReloadRendererErrors = await evaluate('window.__consultErrors'); save();
    await rpc('Page.reload');
    await waitFor('!!window.api?.db && !!document.querySelector(".input-area textarea")', 60000);
    // Reload starts at the normal home surface; reopen the persisted task through the real sidebar.
    const reopenTitle = await evaluate(`(async()=>{const tasks=await window.api.db.listTasks();const t=tasks.find(t=>t.id===${JSON.stringify(reviewed.p.taskId)});if(!t)throw Error('Persisted task missing');return t.title||'未命名任务'})()`);
    await waitFor(`[...document.querySelectorAll('.task-item')].some(e=>e.querySelector('.task-item-title')?.textContent===${JSON.stringify(reopenTitle)})`, 60000);
    await evaluate(`[...document.querySelectorAll('.task-item')].find(e=>e.querySelector('.task-item-title')?.textContent===${JSON.stringify(reopenTitle)}).click()`);
    await waitFor('!!document.querySelector("[data-testid=consult-open-details]")', 30000);
    await click('[data-testid=consult-open-details]');
    await waitFor('!!document.querySelector("dialog.consult-dialog[open]")');
    check('reload restores the same raw answer in the detail UI', await evaluate('document.querySelector("[data-testid=consult-raw-answer]")?.textContent') === reviewed.consultation.workers[0].answer);
    await click('[data-testid=consult-close-details]');
    await installProbe();

    phase('non-review-engineering-calculation');
    await setConsultConfig({ ...initialConfig, readProjectFiles: false });
    await send('这是一个独立的计算任务，不需要读取项目，不要创建 Plan 或 Todo，直接调用 multi_model_consult 然后给出计算结论。理想直流输入为 24 V，Buck 输出 5 V、负载 15 mA，效率 85%，输入侧静态电流另加 0.05 mA。输入总电流限制 3.5 mA。请各模型独立计算输入总电流并判断是否满足限制，写出式子，回答不超过 200 汉字。注意不要把输出电流直接加到输入侧。', true);
    const math = await finish('engineering');
    check('consultation works beyond code review', math.consultation?.status === 'complete');
    check('both real models independently obtain about 3.73 mA', math.consultation.workers.every((w) => /3\.(?:72|73)/.test(w.answer)));
    check('no-tools mode performs zero worker tool calls', math.consultation.workers.every((w) => w.tools.length === 0));

    phase('real-provider-plus-explicit-missing-model');
    await setConsultConfig({ ...initialConfig, readProjectFiles: false, participants: [initialConfig.participants[0], { modelId: 'commandcode/__nonexistent_consult_acceptance__' }] });
    await send('请对“19 × 17 = 323”独立核对并给出简短答案；参与模型出错或不可用时如实说明，不要重试或替换模型。', true);
    const degraded = await finish('degraded');
    check('real single-model success is clearly degraded', degraded.consultation?.status === 'degraded' && degraded.consultation.succeeded === 1);
    check('missing model was not silently replaced', degraded.consultation.workers[1].modelId === 'commandcode/__nonexistent_consult_acceptance__' && degraded.consultation.workers[1].status === 'error');

    phase('real-inflight-cancellation');
    await setConsultConfig(initialConfig);
    await send('继续对当前目录上述两个 TypeScript 文件进行独立详细分析。每个模型用 read 阅读代码，分 20 个检查点逐项说明证据、可能的反例和建议验证。只读，不修改，不执行命令。', true);
    await waitFor('Object.values(window.__consultProbe.consults).some(r=>r.workers.some(w=>w.status==="running"&&w.tools.length>0))', 180000);
    const cancelling = await evaluate('window.__consultProbe');
    report.cancellationStarted = { taskId: cancelling.taskId, workers: Object.values(cancelling.consults).at(-1).workers.map((w) => ({ modelId: w.modelId, status: w.status, tools: w.tools.length })) }; save();
    await evaluate('window.api.agent.abort(window.__consultProbe.taskId)');
    await waitFor('window.__consultProbe.done', 30000);
    await sleep(1000);
    const stopped = await evaluate('window.__consultProbe');
    const stopReport = Object.values(stopped.consults).at(-1);
    report.scenarios.cancel = stopped; save();
    check('main cancellation reaches the consultation', stopReport?.status === 'cancelled');
    check('no worker remains queued or running after cancellation', stopReport.workers.every((w) => !['queued', 'running'].includes(w.status)));
    const stable = JSON.stringify(stopReport);
    await sleep(1500);
    check('cancelled workers emit no later answer changes', JSON.stringify(await evaluate('Object.values(window.__consultProbe.consults).at(-1)')) === stable);

    }
    phase('settings-ui');
    await setConsultConfig({ ...initialConfig, enabled: false });
    await click('.add-menu-anchor > button');
    await click('[data-testid=consult-add-menu]');
    await waitFor('!!document.querySelector("[data-testid=consult-capability]")');
    check('unconfigured composer entry opens the native capability settings', await evaluate('!!document.querySelector("[data-testid=consult-settings]")'));
    await screenshot('settings');
    await evaluate('(()=>{const root=document.querySelector("[data-testid=consult-capability]");const toggle=root.querySelector("button[aria-pressed]");if(!toggle)throw Error("No capability toggle");toggle.click();})()');
    // Edit the real controls instead of only loading a pre-seeded configuration.
    await click('[aria-label="移除模型 2"]');
    await waitFor('document.querySelectorAll(".consult-settings-member").length===1');
    await evaluate(`(()=>{const e=document.querySelector('[data-testid=consult-add-model]');e.value=${JSON.stringify(secondId)};e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
    await waitFor('document.querySelectorAll(".consult-settings-member").length===2');
    await evaluate(`(()=>{const e=document.querySelector('[data-testid=consult-thinking-1]');e.value=${JSON.stringify(initialConfig.participants[1].thinkingLevel || '')};e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);
    check('settings can remove and explicitly re-add the selected model', await evaluate('document.querySelectorAll(".consult-settings-member").length===2'));
    await evaluate('(()=>{const e=document.querySelectorAll(".consult-settings-options input")[1];e.focus();Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(e,"6");e.dispatchEvent(new Event("input",{bubbles:true}));return true})()');
    await sleep(50);
    check('timeout field permits entering a multi-digit value', await evaluate('document.querySelectorAll(".consult-settings-options input")[1].value') === '6');
    await evaluate('(()=>{const e=document.querySelectorAll(".consult-settings-options input")[1];Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(e,"60");e.dispatchEvent(new Event("input",{bubbles:true}));return true})()');
    await sleep(50);
    await evaluate('document.querySelectorAll(".consult-settings-options input")[1].blur()');
    check('timeout field retains 60 seconds after blur', await evaluate('document.querySelectorAll(".consult-settings-options input")[1].value') === '60');
    await evaluate('(()=>{const button=[...document.querySelectorAll(".capabilities-page button")].find(b=>/保存/.test(b.textContent)&&!b.disabled);if(!button)throw Error("No save button");button.click();})()');
    await waitFor('(async()=>!!(await window.api.agent.getBuiltinCapabilities()).config.multiModelConsult.enabled)()');
    const savedConfig = await evaluate('(async()=>(await window.api.agent.getBuiltinCapabilities()).config.multiModelConsult)()');
    check('settings save the exact configured participants and native thinking levels', JSON.stringify(savedConfig.participants) === JSON.stringify(initialConfig.participants));
    report.rendererErrors = [...(report.preReloadRendererErrors || []), ...(await evaluate('window.__consultErrors') || [])];
    check('no uncaught renderer errors', !report.rendererErrors.length);
    if (!uiOnly) check('read-only consultation did not alter copied source files', report.sourceSnapshots.every((source) => crypto.createHash('sha256').update(fs.readFileSync(path.join(cwd, source.relative))).digest('hex') === source.sha256));
    report.result = 'PASS'; report.finishedAt = new Date().toISOString(); phase('complete');
    console.log(JSON.stringify({ result: report.result, checks: report.checks.length, models: enabledModels, reportFile }));
  } catch (error) {
    report.result = 'FAIL'; report.error = error.stack || String(error); report.failedAt = new Date().toISOString();
    try {
      report.lastProbe = await evaluate('window.__consultProbe');
      report.failureDom = await evaluate('({text:document.body.innerText.slice(0,12000),buttons:[...document.querySelectorAll("button")].map(e=>({text:e.textContent.slice(0,60),title:e.title,cls:e.className})).slice(0,100)})');
      await screenshot('failure');
    } catch {}
    save(); console.error(report.error); process.exitCode = 1;
  } finally {
    try { if (socket?.readyState === WebSocket.OPEN) await rpc('Browser.close'); } catch {}
    try { socket?.close(); } catch {}
    for (const item of pending.values()) clearTimeout(item.timeout);
    for (let i = 0; i < 20 && proc.exitCode === null; i++) await sleep(150);
    if (proc.exitCode === null) { try { cp.execFileSync('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore' }); } catch {} }
    try { fs.closeSync(log); } catch {}
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }); report.credentialCopyRemoved = !fs.existsSync(path.join(dir, 'auth.json')); }
    catch (error) { report.cleanupError = String(error); report.result = 'FAIL'; process.exitCode = 1; }
    save();
  }
})();
