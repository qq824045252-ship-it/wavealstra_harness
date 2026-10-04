const { DatabaseSync } = require('node:sqlite');
/** Real provider + actual packaged desktop + composer/IPC/DOM, with isolated credentials and workspace. */
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process'), crypto = require('node:crypto'), net = require('node:net');
const root = path.resolve(__dirname, '..');
process.chdir(root);
const out = path.join(root, 'artifacts/pi-minimal-mode/desktop-live');
fs.mkdirSync(out, { recursive: true });
// A retried bridge invocation must never run the same paid-model acceptance twice.
const lock = path.join(out, 'acceptance.lock');
try {
    const fd = fs.openSync(lock, 'wx');
    fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
    fs.closeSync(fd);
}
catch (error) {
    if (error.code === 'EEXIST') {
        console.error('Native desktop acceptance is already running; refusing duplicate launch.');
        process.exit(2);
    }
    throw error;
}
process.on('exit', () => { try {
    if (JSON.parse(fs.readFileSync(lock, 'utf8')).pid === process.pid)
        fs.unlinkSync(lock);
}
catch { } });
const report = { kind: 'pi-minimal-mode-real-model-packaged-desktop', harnessPid: process.pid, startedAt: new Date().toISOString(), tests: [], status: 'running' };
const save = () => fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(report, null, 2));
const wait = ms => new Promise(r => setTimeout(r, ms));
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'pi-minimal-mode-desktop-'));
const home = path.join(temp, 'profile'), agentDir = path.join(home, '.mybuddy'), workspace = path.join(temp, 'workspace');
fs.mkdirSync(agentDir, { recursive: true });
fs.mkdirSync(workspace, { recursive: true });
const sourceHome = path.join(os.homedir(), '.mybuddy');
for (const name of ['auth.json', 'models.json', 'models-store.json'])
    if (fs.existsSync(path.join(sourceHome, name)))
        fs.copyFileSync(path.join(sourceHome, name), path.join(agentDir, name));
for (const dir of ['AppData/Roaming', 'AppData/Local'])
    fs.mkdirSync(path.join(home, dir), { recursive: true });
fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: 'commandcode', defaultModel: 'deepseek/deepseek-v4.1-flash', defaultThinkingLevel: 'high', enabledModels: ['commandcode/deepseek/deepseek-v4.1-flash'], memoryEnabled: false, memoryGatewayEnabled: false, remoteAccessEnabled: false, closeToTray: false, theme: 'light', language: 'zh-CN', permissionMode: 'auto' }));
fs.writeFileSync(path.join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [path.join(root, 'scripts/pi-codemode-auto-fixture.mjs'), workspace], exposure: 'codemode', timeout: 15 } } }));
const nonce = crypto.randomBytes(12).toString('hex'), values = Array.from({ length: 13 }, () => crypto.randomInt(-500, 1000));
fs.writeFileSync(path.join(workspace, 'sample.json'), JSON.stringify({ nonce, values }));
const validator = path.join(workspace, 'validate.cjs');
fs.writeFileSync(validator, `const fs=require('node:fs'),p=require('node:path');const expected=${JSON.stringify(nonce)};let input;try{input=JSON.parse(fs.readFileSync(p.join(__dirname,'repair.json'),'utf8'));}catch{}const ok=input?.enabled===true&&input?.nonce===expected;fs.appendFileSync(p.join(__dirname,'validator-audit.jsonl'),JSON.stringify({code:ok?0:7,at:Date.now()})+'\\n');if(!ok){console.error('INPUT_INVALID: repair.json must contain enabled=true and the exact expected nonce documented in validate.cjs. Do not change the validator.');process.exit(7);}fs.writeFileSync(p.join(__dirname,'validated.json'),JSON.stringify({ok:true,nonce:expected,source:'real-node'}));console.log('VALIDATED_OK');`);
const validatorHash = crypto.createHash('sha256').update(fs.readFileSync(validator)).digest('hex');
fs.mkdirSync(path.join(agentDir, 'agents'), { recursive: true });
fs.writeFileSync(path.join(agentDir, 'agents/worker.md'), '---\nname: worker\ndescription: Read-only native Pi acceptance worker\ntools: read, ls\nmodel: commandcode/deepseek/deepseek-v4.1-flash\n---\nRead the actual task input. Report exact values; do not guess.');
let proc, socket, log;
let id = 0;
const pending = new Map();
function rpc(method, params = {}) { return new Promise((resolve, reject) => { const n = ++id, timer = setTimeout(() => { pending.delete(n); reject(Error('CDP timeout: ' + method)); }, 20000); pending.set(n, { resolve, reject, timer }); socket.send(JSON.stringify({ id: n, method, params })); }); }
async function evaluate(expression) { const r = await rpc('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails)
    throw Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result?.value; }
async function freePort() { return new Promise((resolve, reject) => { const s = net.createServer(); s.once('error', reject); s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); }); }); }
function inventory() { const files = []; function walk(dir) { for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const f = path.join(dir, e.name);
    if (e.isSymbolicLink())
        continue;
    if (e.isDirectory())
        walk(f);
    else if (/\.tsx?$/.test(e.name))
        files.push({ path: path.relative(root, f).replaceAll('\\', '/'), bytes: fs.statSync(f).size });
} } walk(path.join(root, 'src')); files.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path)); return { total: files.length, totalBytes: files.reduce((n, f) => n + f.bytes, 0), largest: files.slice(0, 3) }; }
const listing = path.join(workspace, 'listing');
fs.mkdirSync(listing, { recursive: true });
fs.writeFileSync(path.join(listing, 'alpha-' + nonce.slice(0, 6) + '.txt'), 'listing fixture alpha');
fs.writeFileSync(path.join(listing, 'beta-' + nonce.slice(0, 6) + '.md'), 'listing fixture beta');
fs.mkdirSync(path.join(listing, 'nested'));
fs.writeFileSync(path.join(listing, 'nested', 'child.txt'), 'not requested');
const missing = path.join(workspace, 'missing-' + nonce + '.txt');
const slow = path.join(workspace, 'slow.cjs'), slowAudit = path.join(workspace, 'slow-audit.jsonl');
fs.writeFileSync(slow, "const fs=require('node:fs');fs.appendFileSync(" + JSON.stringify(slowAudit) + ",JSON.stringify({started:Date.now()})+'\\n');setTimeout(()=>console.log('TOO_LATE'),60000);");
function countActualWrites(target) { const audit=path.join(temp,'server-write-audit.jsonl'); const records=fs.existsSync(audit)?fs.readFileSync(audit,'utf8').trim().split(/\r?\n/).filter(Boolean).map(l=>JSON.parse(l)):[]; return records.filter(r=>r.operation==='write_file'&&r.path===target).length; }
function presetCase(name,presetId,presetLabel) {
  const seed={nonce:crypto.randomBytes(10).toString('hex'),values:Array.from({length:9},()=>crypto.randomInt(-50,200))};
  const expected={nonce:seed.nonce,sum:seed.values.reduce((a,b)=>a+b,0)};
  const prompt='代码 Tag 真实验收：必须使用 Pi 原生 codemode，通过 fixture 的 read_seed 读取本轮随机 nonce 和 values，计算总和，再用 save_result 保存精确 {nonce,sum}。不得猜值，只操作测试 fixture；最后简要报告结果。';
  return {name,mode:'coding',mcp:true,presetId,presetLabel,seed,prompt,check(state){
    const actual=JSON.parse(fs.readFileSync(path.join(workspace,'result.json'),'utf8'));assert.deepEqual(actual,expected);
    assert(state.tools.some(t=>t.name==='codemode'&&t.status==='success'),'Pi native codemode was not used successfully');
    assert(state.tools.some(t=>t.name==='mcp__fixture__read_seed'&&t.status==='success'),'fixture read missing');
    assert(state.tools.some(t=>t.name==='mcp__fixture__save_result'&&t.status==='success'),'fixture write missing');
    return {actual,codemodeCalls:state.tools.filter(t=>t.name==='codemode').length};
  }};
}
async function prepareScene(task,row){
  await evaluate('(()=>{const button=document.querySelector(".sidebar-cta-btn");if(!button)throw Error("New-task button unavailable");button.click();return true;})()');
  for(let i=0;i<50;i++){if(await evaluate('Boolean(document.querySelector(".hero"))'))break;await wait(100);}
  await evaluate('(()=>{const wanted="代码开发";const button=[...document.querySelectorAll(".hero-categories button")].find(b=>b.textContent.trim()===wanted);if(!button)throw Error("Coding scene button unavailable");button.click();return true;})()');
  for(let i=0;i<50;i++){if(await evaluate('document.querySelector(".hero")?.getAttribute("data-mode")==="coding"'))break;await wait(100);}
  row.hero=await evaluate('(()=>({mode:document.querySelector(".hero")?.getAttribute("data-mode"),statusVisible:Boolean(document.querySelector("[data-testid=pi-codemode-status]")),tags:[...document.querySelectorAll(".hero-scenes button")].map(b=>({label:b.textContent.trim(),pressed:b.getAttribute("aria-pressed")}))}))()');
  assert.equal(row.hero.mode,'coding');assert.equal(row.hero.statusVisible,false,'Code Mode actual-state badge must be hidden');
  assert.equal(row.hero.tags[0]?.label,'最小模式','Minimal tag must render first');
  const selected=await evaluate('(()=>{const wanted='+JSON.stringify(task.presetLabel)+';const button=[...document.querySelectorAll(".hero-scenes button")].find(b=>b.textContent.trim()===wanted);if(!button)throw Error("Preset unavailable: "+wanted);button.click();return true;})()');assert(selected);
  for(let i=0;i<50;i++){if(await evaluate('(()=>{const wanted='+JSON.stringify(task.presetLabel)+';return [...document.querySelectorAll(".hero-scenes button")].some(b=>b.textContent.trim()===wanted&&b.getAttribute("aria-pressed")==="true")})()'))break;await wait(100);}
  row.selectedPreset=await evaluate('(()=>{const wanted='+JSON.stringify(task.presetLabel)+';const b=[...document.querySelectorAll(".hero-scenes button")].find(x=>x.textContent.trim()===wanted);return {label:b?.textContent.trim(),pressed:b?.getAttribute("aria-pressed")};})()');
  assert.equal(row.selectedPreset.pressed,'true');
  const enabled=await evaluate('window.api.mcp.setServerEnabled("fixture",true)');assert(enabled.ok!==false,JSON.stringify(enabled));
  fs.writeFileSync(path.join(workspace,'seed.json'),JSON.stringify(task.seed));fs.writeFileSync(path.join(workspace,'mcp-audit.jsonl'),'');fs.rmSync(path.join(workspace,'result.json'),{force:true});
}
async function inspectScene(task,row,state){
  const snapshot=await evaluate('window.api.mcp.status('+JSON.stringify(state.taskId)+')');assert(snapshot?.codeMode);assert.equal(snapshot.codeMode.active,true);
  row.nativeCodeMode=snapshot.codeMode;
  const tasks=await evaluate('window.api.db.listTasks()'),saved=tasks.find(t=>t.id===state.taskId);assert(saved);
  row.persisted={welcomeMode:saved.welcomeMode,modePresetId:saved.modePresetId};assert.equal(saved.welcomeMode,'coding');assert.equal(saved.modePresetId,task.presetId);
  row.statusVisibleAfter=await evaluate('Boolean(document.querySelector("[data-testid=pi-codemode-status]"))');assert.equal(row.statusVisibleAfter,false,'Code Mode actual-state badge must stay hidden in chat');
  const db=new DatabaseSync(path.join(agentDir,'app.db'),{readOnly:true});
  try{
    const snap=db.prepare("SELECT resolved_instructions_json FROM task_runtime_context_snapshots WHERE task_id=? ORDER BY started_at DESC LIMIT 1").get(state.taskId);assert(snap?.resolved_instructions_json,'Missing runtime instruction snapshot');
    const text=String(snap.resolved_instructions_json);row.promptEvidence={hasModePresetSegment:text.includes('"modePreset"'),hasMinimalLabel:text.includes('场景预设：最小模式'),hasBugfixLabel:text.includes('场景预设：修 Bug')};
    if(task.presetId==='minimal'){assert.equal(row.promptEvidence.hasModePresetSegment,false,'minimal must not add a modePreset system segment');assert.equal(row.promptEvidence.hasMinimalLabel,false);}
    else {assert.equal(row.promptEvidence.hasModePresetSegment,true,'bugfix must retain its modePreset system segment');assert.equal(row.promptEvidence.hasBugfixLabel,true);}
  }finally{db.close();}
}
const cases=[presetCase('minimal-no-prompt','minimal','最小模式'),presetCase('bugfix-prompt-control','bugfix-test','修 Bug')];
(async () => {
    try {
        const pointer = JSON.parse(fs.readFileSync(path.join(root, 'artifacts/pi-minimal-mode/build-latest.json'), 'utf8'));
        const acceptedBuild = JSON.parse(fs.readFileSync(pointer.report, 'utf8'));
        assert.equal(acceptedBuild.status, 'passed');
        const exe = process.env.PI_NATIVE_DESKTOP_EXE || acceptedBuild.executable;
        report.asarSha256=acceptedBuild.asarSha256;report.sourceFingerprint=acceptedBuild.sourceFingerprint;
        assert(fs.existsSync(exe), 'Verified portable executable is missing');
        report.executable = exe;
        const port = await freePort();
        report.port = port;
        log = fs.openSync(path.join(out, 'desktop.log'), 'w');
        const env = { ...process.env, USERPROFILE: home, HOME: home, APPDATA: path.join(home, 'AppData/Roaming'), LOCALAPPDATA: path.join(home, 'AppData/Local') };
        delete env.ELECTRON_RUN_AS_NODE;
        proc = cp.spawn(exe, ['--remote-debugging-address=127.0.0.1', '--remote-debugging-port=' + port, '--disable-background-timer-throttling', '--disable-renderer-backgrounding'], { cwd: temp, env, stdio: ['ignore', log, log], windowsHide: true });
        report.pid = proc.pid;
        save();
        let target;
        for (let i = 0; i < 120; i++) {
            try {
                const targets = await fetch('http://127.0.0.1:' + port + '/json/list').then(r => r.json());
                target = targets.find(t => t.type === 'page' && t.url.includes('index.html')) || targets.find(t => t.type === 'page' && !t.url.startsWith('devtools'));
                if (target)
                    break;
            }
            catch { }
            if (proc.exitCode !== null)
                throw Error('Desktop exited before readiness: ' + proc.exitCode);
            await wait(250);
        }
        assert(target, 'Desktop CDP page unavailable');
        socket = new WebSocket(target.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => { socket.addEventListener('open', resolve, { once: true }); socket.addEventListener('error', reject, { once: true }); });
        socket.addEventListener('message', ev => { const r = JSON.parse(ev.data), p = pending.get(r.id); if (!p)
            return; pending.delete(r.id); clearTimeout(p.timer); r.error ? p.reject(Error(JSON.stringify(r.error))) : p.resolve(r.result); });
        await rpc('Runtime.enable');
        await rpc('Emulation.setDeviceMetricsOverride', { width: 1280, height: 900, deviceScaleFactor: 1, mobile: false });
        let ready = false;
        for (let i = 0; i < 120; i++) {
            ready = await evaluate('Boolean(window.api?.agent&&document.querySelector("textarea"))');
            if (ready)
                break;
            await wait(250);
        }
        assert(ready, 'Desktop composer unavailable');
        await evaluate(`(()=>{window.__pi099={current:null,errors:[]};window.addEventListener('error',e=>window.__pi099.errors.push(e.message));window.addEventListener('unhandledrejection',e=>window.__pi099.errors.push(String(e.reason)));window.api.agent.onEvent(e=>{const p=window.__pi099.current;if(!p)return;if(e.taskId)p.taskId=e.taskId;if(e.type==='assistant_start'){p.started=true;p.messageId=e.messageId;p.done=false;p.error=undefined;}if(e.type==='thinking_delta')p.thinkingEvents++;if(e.type==='text_delta'){p.textEvents++;p.receivedText+=e.delta||'';}if(e.type==='tool_start')p.tools.push({id:e.toolCallId,name:e.tool,parent:e.parentToolCallId,summary:e.summary,status:'running'});if(e.type==='tool_update'){const t=p.tools.find(t=>t.id===e.toolCallId);if(t){if(e.status)t.status=e.status;if(e.output)t.output=String(e.output).slice(-1800);}}if(e.type==='assistant_end'){p.done=true;p.error=e.error;p.finishedAt=Date.now();}});return true;})()`);
        for (const task of cases.filter(c => !process.argv.includes('--only') || c.name === process.argv[process.argv.indexOf('--only') + 1])) {
            const row = { name: task.name, status: 'running', startedAt: new Date().toISOString() };
            report.tests.push(row);
            save();
            try {
                await prepareScene(task,row);
                await evaluate(`window.__pi099.current={tools:[],thinkingEvents:0,textEvents:0,receivedText:'',started:false,done:false}`);
                await evaluate('(()=>{const e=document.querySelector("textarea");e.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(e,' + JSON.stringify(task.prompt) + ');e.dispatchEvent(new Event("input",{bubbles:true}));return true;})()');
                await wait(120);
                await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
                await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
                let state;
                for (let i = 0; i < 240; i++) {
                    await wait(1000);
                    state = await evaluate('window.__pi099.current');
                    row.progress = { elapsedMs: Date.now() - Date.parse(row.startedAt), started: state.started, done: state.done, toolCount: state.tools?.length, lastTool: state.tools?.at(-1)?.name, textEvents: state.textEvents };
                    save();
                    if (i === 20 && !state.started)
                        throw Error('Composer did not start a task');
                    if (state.done)
                        break;
                }
                if (!state?.done) {
                    if (state?.taskId)
                        await evaluate('window.api.agent.abort(' + JSON.stringify(state.taskId) + ')');
                    throw Error('Desktop task timed out');
                }
                assert(!state.error, 'Desktop assistant failed: ' + state.error);
                await inspectScene(task,row,state);
                assert(state.textEvents > 0, 'No streamed text events');
                row.tools = state.tools;
                row.finalText = state.receivedText;
                row.streaming = { thinkingEvents: state.thinkingEvents, textEvents: state.textEvents };
                row.taskId = state.taskId;
                save();
                row.result = task.check(state);
                row.tools = state.tools;
                row.streaming = { thinkingEvents: state.thinkingEvents, textEvents: state.textEvents };
                row.taskId = state.taskId;
                row.finalText = state.receivedText;
                row.finishedAtMs = state.finishedAt;
                row.history = await evaluate('(async()=>{const p=window.__pi099.current,h=await window.api.agent.loadTaskHistory(p.taskId);const m=h.messages.filter(m=>m.role==="assistant").at(-1);return {found:!!m,textChars:m?.text?.length||0};})()');
                assert(row.history.found && row.history.textChars > 0, 'Completed answer was not persisted');
                row.status = 'passed';
                console.log('PASS actual desktop ' + task.name);
            }
            catch (e) {
                row.status = 'failed';
                row.error = e.message;
                try {
                    row.probe = await evaluate('window.__pi099.current');
                }
                catch { }
                console.error('FAIL actual desktop ' + task.name + ': ' + e.message);
            }
            finally {
                row.finishedAt = new Date().toISOString();
                save();
                try {
                    const s = await rpc('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
                    fs.writeFileSync(path.join(out, task.name + '.png'), Buffer.from(s.data, 'base64'));
                }
                catch { }
            }
        }
        report.modeFallbackChecks = [];
        const sessionAudit = [];
        function auditSessions(dir) { if (!fs.existsSync(dir))
            return; for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            const file = path.join(dir, e.name);
            if (e.isDirectory())
                auditSessions(file);
            else if (e.name.endsWith('.jsonl')) {
                const rows = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).map(l => JSON.parse(l));
                const controls = rows.filter(r => /mybuddy_completion_gate|mybuddy_request_user_input_recovery/.test(r.customType || r.message?.customType || ''));
                assert.equal(controls.length, 0, 'retired host control message was persisted');
                sessionAudit.push({ file: e.name, entries: rows.length, userMessages: rows.filter(r => r.message?.role === 'user').length, retiredControlMessages: controls.length, observedModels: [...new Set(rows.filter(r=>r.message?.role==='assistant').map(r=>r.message.provider+'/'+r.message.model))] });
            }
        } }
        auditSessions(path.join(agentDir, 'sessions'));
        report.sessionAudit = sessionAudit;
        assert.equal(new Set(report.tests.map(t=>t.taskId)).size,report.tests.length,'Every scene must be a distinct actual task');
        assert(sessionAudit.length > 0, 'No real native session history found');
        report.rendererErrors = await evaluate('window.__pi099.errors');
        assert.equal(report.rendererErrors.length, 0, 'Renderer errors occurred');
        report.status = report.tests.every(t => t.status === 'passed') ? 'passed' : 'failed';
    }
    catch (e) {
        report.status = 'failed';
        report.error = e.stack;
    }
    finally {
        if (socket) {
            try {
                await rpc('Browser.close');
            }
            catch { }
            socket.close();
        }
        for (const p of pending.values()) {
            clearTimeout(p.timer);
            p.reject(Error('CDP closed'));
        }
        pending.clear();
        if (proc) {
            await wait(700);
            if (proc.exitCode === null) {
                try {
                    cp.execFileSync('C:/Windows/System32/taskkill.exe', ['/PID', String(proc.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true, timeout: 5000 });
                }
                catch { }
            }
        }
        if (log !== undefined)
            fs.closeSync(log);
        try {
            fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
            report.temporaryCredentialsRemoved = true;
        }
        catch (e) {
            report.cleanupError = e.message;
            report.status = 'failed';
        }
        report.finishedAt = new Date().toISOString();
        save();
        process.exitCode = report.status === 'passed' ? 0 : 1;
        console.log(JSON.stringify({ status: report.status, report: path.join(out, 'results.json') }, null, 2));
    }
})();
