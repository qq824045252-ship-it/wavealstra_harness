/** Real packaged Electron, existing provider credentials, real tools, and UI approval. */
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const cp = require('node:child_process'), crypto = require('node:crypto'), net = require('node:net');
const root = path.resolve(__dirname, '..');
const output = path.resolve(root, process.env.MYBUDDY_LEARNING_LIVE_OUTPUT || 'artifacts/skill-learning-20261002/live');
fs.mkdirSync(output, { recursive: true });
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'mybuddy-procedure-live-'));
const agentDir = path.join(profile, '.mybuddy'), workspace = path.join(profile, 'workflow');
fs.mkdirSync(agentDir, { recursive: true }); fs.mkdirSync(workspace, { recursive: true });
const source = path.join(os.homedir(), '.mybuddy');
for (const file of ['auth.json', 'models.json', 'models-store.json']) {
  if (fs.existsSync(path.join(source, file))) fs.copyFileSync(path.join(source, file), path.join(agentDir, file));
}
const existing = JSON.parse(fs.readFileSync(path.join(source, 'settings.json'), 'utf8'));
const modelId = process.env.MYBUDDY_LEARNING_LIVE_MODEL || `${existing.defaultProvider}/${existing.defaultModel}`;
const slash = modelId.indexOf('/');
fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({
  defaultProvider: modelId.slice(0, slash), defaultModel: modelId.slice(slash + 1), enabledModels: [modelId],
  defaultThinkingLevel: 'low', memoryEnabled: true, memoryGatewayEnabled: false, remoteAccessEnabled: false,
  closeToTray: false, permissionMode: 'auto', theme: 'light', language: 'zh-CN',
  cacheWarming: 'off', retry: { enabled: false, maxRetries: 0, provider: { maxRetries: 0 } },
}));
fs.writeFileSync(path.join(agentDir, 'mcp.json'), '{"mcpServers":{}}');
for (const folder of ['AppData/Roaming', 'AppData/Local']) fs.mkdirSync(path.join(profile, folder), { recursive: true });
const exe = process.env.MYBUDDY_LEARNING_LIVE_EXE || path.join(root, 'artifacts/skill-learning-20261002/recovery-package/win-unpacked/MyBuddy.exe');
const report = { startedAt: new Date().toISOString(), modelId, executable: exe, checks: [], status: 'running', phases: [] };
const save = () => fs.writeFileSync(path.join(output, 'results.json'), JSON.stringify(report, null, 2));
const phase = (name) => { report.phase = name; report.phases.push({ name, at: new Date().toISOString() }); save(); console.log(name); };
const check = (name, value) => { assert(value, name); report.checks.push(name); save(); console.log('PASS ' + name); };
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const values = Array.from({ length: 9 }, () => crypto.randomInt(-100, 300));
const nonce = crypto.randomBytes(6).toString('hex');
fs.writeFileSync(path.join(workspace, 'sample.json'), JSON.stringify({ nonce, values }));
fs.writeFileSync(path.join(workspace, 'calculate.cjs'), "const fs=require('node:fs'),p=require('node:path');const d=JSON.parse(fs.readFileSync(p.join(__dirname,'sample.json'),'utf8'));if(!Array.isArray(d.values)||!d.values.every(Number.isFinite))throw Error('INVALID_VALUES');fs.writeFileSync(p.join(__dirname,'result.json'),JSON.stringify({nonce:d.nonce,count:d.values.length,sum:d.values.reduce((a,b)=>a+b,0)}));console.log('CALCULATED_RESULT: result.json written');");
fs.writeFileSync(path.join(workspace, 'validate.cjs'), "const fs=require('node:fs'),p=require('node:path');const d=JSON.parse(fs.readFileSync(p.join(__dirname,'sample.json'),'utf8')),r=JSON.parse(fs.readFileSync(p.join(__dirname,'result.json'),'utf8'));let sum=0;for(const n of d.values)sum+=n;const ok=r.nonce===d.nonce&&r.count===d.values.length&&r.sum===sum;console.log(ok?'CHECK_OK: independent sum/count/nonce validation passed':'CHECK_FAILED');process.exit(ok?0:7);");
const sourceHashes = ['calculate.cjs', 'validate.cjs'].map((name) => crypto.createHash('sha256').update(fs.readFileSync(path.join(workspace, name))).digest('hex'));
let proc, socket, log, rpcId = 0;
const pending = new Map();
function rpc(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++rpcId;
    const timer = setTimeout(() => { pending.delete(id); reject(Error('CDP timeout ' + method)); }, 25000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params }));
  });
}
async function evaluate(expression) {
  const reply = await rpc('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (reply.exceptionDetails) throw Error(reply.exceptionDetails.exception?.description || reply.exceptionDetails.text);
  return reply.result?.value;
}
async function until(expression, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await evaluate(expression); if (value) return value;
    if (proc.exitCode !== null) throw Error('Test desktop exited'); await pause(400);
  }
  throw Error('Timed out: ' + expression.slice(0, 150));
}
async function click(label) {
  await until(`(()=>{const b=[...document.querySelectorAll('button')].find(e=>e.getClientRects().length&&e.textContent.trim()===${JSON.stringify(label)});if(!b||b.disabled)return false;b.click();return true;})()`);
}
async function screenshot(name) {
  const shot = await rpc('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(path.join(output, name + '.png'), Buffer.from(shot.data, 'base64'));
}
async function prompt(taskId, text, projectId) {
  await evaluate('window.__learningProbe={taskId:' + JSON.stringify(taskId) + ',tools:[],done:false,text:""};true');
  await evaluate('window.api.db.upsertTask(' + JSON.stringify({ id: taskId, title: '真实技能学习验收', projectId, cwd: workspace, welcomeMode: 'coding', modelId, permissionMode: 'auto', updatedAt: Date.now() }) + ')');
  const request = { taskId, text, userMessageId: 'u-' + crypto.randomUUID(), assistantMessageId: 'a-' + crypto.randomUUID(), modelId, permissionMode: 'auto' };
  await evaluate(`(()=>{void window.api.agent.prompt(${JSON.stringify(request)}).then(r=>window.__learningProbe.accepted=r).catch(e=>{window.__learningProbe.error=String(e);window.__learningProbe.done=true});return true;})()`);
  await until('window.__learningProbe.done', 240000);
  const result = await evaluate('window.__learningProbe'); check('actual model task completed: ' + taskId, !result.error && result.tools.length >= 2);
  report.lastTask = result; save(); return result;
}
async function stop() {
  try { socket?.close(); } catch {}
  for (const p of pending.values()) { clearTimeout(p.timer); p.reject(Error('acceptance completed')); } pending.clear();
  if (proc && proc.exitCode === null) cp.spawnSync('taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
  if (log !== undefined) fs.closeSync(log);
  // Isolated credentials are removed after use; reports contain only nonsecret evidence.
  for (const file of ['auth.json', 'models.json', 'models-store.json']) {
    try { fs.unlinkSync(path.join(agentDir, file)); } catch {}
  }
}
(async () => {
  try {
    assert(fs.existsSync(exe), 'Packaged executable missing');
    const port = await new Promise((resolve, reject) => { const server = net.createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const n = server.address().port; server.close(() => resolve(n)); }); });
    log = fs.openSync(path.join(output, 'desktop.log'), 'w');
    const env = { ...process.env, USERPROFILE: profile, APPDATA: path.join(profile, 'AppData/Roaming'), LOCALAPPDATA: path.join(profile, 'AppData/Local') };
    delete env.ELECTRON_RUN_AS_NODE;
    proc = cp.spawn(exe, ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port, '--disable-background-timer-throttling', '--disable-renderer-backgrounding'], { cwd: profile, env, stdio: ['ignore', log, log], windowsHide: true });
    report.pid = proc.pid; save(); phase('start packaged desktop');
    let target;
    for (let i = 0; i < 120; i++) {
      try { target = (await fetch('http://127.0.0.1:' + port + '/json/list').then((r) => r.json())).find((t) => t.type === 'page' && /index\.html/.test(t.url)); } catch {}
      if (target) break; if (proc.exitCode !== null) throw Error('Desktop startup failed'); await pause(300);
    }
    assert(target, 'Desktop renderer unavailable');
    socket = new WebSocket(target.webSocketDebuggerUrl); await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    socket.onmessage = (event) => { const m = JSON.parse(event.data), p = pending.get(m.id); if (!p) return; clearTimeout(p.timer); pending.delete(m.id); m.error ? p.reject(Error(JSON.stringify(m.error))) : p.resolve(m.result); };
    await rpc('Runtime.enable'); await rpc('Emulation.setDeviceMetricsOverride', { width: 1280, height: 940, deviceScaleFactor: 1, mobile: false });
    await until('!!window.api?.memory?.skillLearningStatus && !!document.querySelector("textarea")', 60000);
    await evaluate(`(()=>{window.__learningErrors=[];window.addEventListener('error',e=>window.__learningErrors.push(e.message));window.api.agent.onEvent(e=>{const p=window.__learningProbe;if(!p||e.taskId!==p.taskId)return;if(e.type==='tool_start')p.tools.push({id:e.toolCallId,name:e.tool});if(e.type==='text_delta')p.text+=e.delta||'';if(e.type==='assistant_end'){p.done=true;p.error=e.error}});return true;})()`);
    const initial = await evaluate('window.api.memory.skillLearningStatus()'); check('isolated profile starts with no procedures', initial.procedures === 0);
    const project = await evaluate('window.api.db.createProject({name:"JSON 统计流程验收"})'); assert(project.ok); const projectId = project.project.id;
    phase('real tools and automatic procedure extraction');
    const firstTask = 'learning-' + crypto.randomUUID();
    await prompt(firstTask, `完成当前项目的一次 JSON 数据统计。文件位于 ${workspace}。先用 read 读取 sample.json、calculate.cjs、validate.cjs；分别执行 node calculate.cjs 和 node validate.cjs（指定工作目录或绝对脚本路径），最后 read result.json 检查。不要修改两个脚本。只在独立校验输出 CHECK_OK 后报告完成。`, projectId);
    const result = JSON.parse(fs.readFileSync(path.join(workspace, 'result.json'), 'utf8'));
    check('actual output matches independently generated input', result.nonce === nonce && result.sum === values.reduce((a, b) => a + b, 0));
    check('validator and calculation scripts were preserved', ['calculate.cjs', 'validate.cjs'].every((name, i) => crypto.createHash('sha256').update(fs.readFileSync(path.join(workspace, name))).digest('hex') === sourceHashes[i]));
    await until('window.api.memory.turns().then(ts=>ts.some(t=>t.taskId===' + JSON.stringify(firstTask) + '&&["completed","failed"].includes(t.extractionState)))', 150000);
    report.turns = await evaluate('window.api.memory.turns()');
    check('host persisted actual successful tool evidence', report.turns.some((t) => t.taskId === firstTask && t.metadata.procedureExecution?.tools.length >= 2));
    const candidates = await evaluate('window.api.memory.skillCandidates()'); report.candidates = candidates; save();
    check('real extraction automatically created a skill candidate', candidates.some((c) => c.status === 'draft' || c.status === 'ready'));
    const candidate = candidates.find((c) => c.status === 'draft' || c.status === 'ready');
    report.procedure = await evaluate('window.api.memory.get(' + JSON.stringify(candidate.sourceMemoryIds[0]) + ')');
    check('procedure retains real verification provenance', report.procedure.evidence.some((e) => e.evidenceKind === 'agent_run' && /CHECK_OK/.test(e.excerpt)));
    phase('approve generated skill through actual settings UI');
    await evaluate(`document.querySelector('button[title="设置"]').click();true`);
    await click('记忆'); await click('技能学习'); await until('document.body.innerText.includes(' + JSON.stringify(candidate.title) + ')');
    await screenshot('automatic-candidate');
    await click(candidate.status === 'ready' ? '批准生成技能' : '确认生成技能');
    await until('window.api.memory.skillCandidates().then(cs=>cs.some(c=>c.id===' + JSON.stringify(candidate.id) + '&&c.status==="materialized"))');
    await screenshot('approved-skill');
    const generated = (await evaluate('window.api.memory.skillCandidates()')).find((c) => c.id === candidate.id);
    const skillPath = path.join(agentDir, 'skills', candidate.slug, 'SKILL.md'); check('UI approval materialized a real skill file', fs.existsSync(skillPath));
    await evaluate('window.api.agent.setSkillEnabled(' + JSON.stringify(generated.installedSkillId) + ',true)');
    const disabled = await evaluate('window.api.memory.skillLearningStatus()');
    check('activated skill passes live provenance checks', !disabled.blockedSkills.some((s) => s.id === generated.installedSkillId));
    phase('invoke learned skill in a new real task');
    await prompt('reuse-' + crypto.randomUUID(), `/skill:${candidate.slug}\n按这个已学习流程重新处理 ${workspace} 的 sample.json，执行计算及独立校验。不要修改脚本。`, projectId);
    const invocations = await evaluate('window.api.memory.skillEffectiveness(100,true)'); report.invocations = invocations;
    check('new real task actually invoked the learned skill', invocations.some((i) => i.skillId === generated.installedSkillId && i.invokedAt && i.outcome === 'completed'));
    check('no renderer runtime errors', (await evaluate('window.__learningErrors')).length === 0);
    report.status = 'passed'; report.finishedAt = new Date().toISOString(); save(); phase('acceptance passed');
  } catch (error) {
    report.status = 'failed'; report.error = String(error); save();
    try { report.failureStatus = await evaluate('window.api.memory.skillLearningStatus()'); report.failureTurns = await evaluate('window.api.memory.turns()'); report.failureCandidates = await evaluate('window.api.memory.candidates()'); save(); await screenshot('failure'); } catch {}
    console.error(report.error); process.exitCode = 1;
  } finally { await stop(); }
})();
