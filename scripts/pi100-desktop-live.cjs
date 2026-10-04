const { DatabaseSync } = require('node:sqlite');
/** Real provider + actual packaged desktop + composer/IPC/DOM, with isolated credentials and workspace. */
const assert = require('node:assert/strict'), fs = require('node:fs'), path = require('node:path'), os = require('node:os'), cp = require('node:child_process'), crypto = require('node:crypto'), net = require('node:net');
const root = path.resolve(__dirname, '..');
process.chdir(root);
const selectedCase = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only')+1] : 'minimal-no-prompt';
if(!['minimal-no-prompt','bugfix-prompt-control','office-native-discovery','codemode-without-mcp','native-models-and-reference','native-error-repair','native-readonly-worker'].includes(selectedCase))throw Error('Unknown live case');
if(!process.argv.includes('--only'))process.argv.push('--only',selectedCase);
const selectedModel=process.env.PI100_LIVE_MODEL || 'commandcode/deepseek/deepseek-v4.1-flash';
const selectedProvider=selectedModel.split('/')[0],selectedModelId=selectedModel.slice(selectedProvider.length+1);
const out=path.join(root,'artifacts/pi100-upgrade/desktop-live',selectedCase+'-'+selectedModel.replace(/[^a-z0-9.-]/gi,'_'));
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
const report = { kind: 'pi100-real-model-packaged-desktop', selectedModel, harnessPid: process.pid, startedAt: new Date().toISOString(), tests: [], status: 'running' };
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
fs.writeFileSync(path.join(agentDir, 'settings.json'), JSON.stringify({ defaultProvider: selectedProvider, defaultModel: selectedModelId, defaultThinkingLevel: 'high', enabledModels: [selectedModel], memoryEnabled: false, memoryGatewayEnabled: false, remoteAccessEnabled: false, closeToTray: false, theme: 'light', language: 'zh-CN', permissionMode: 'auto' }));
fs.writeFileSync(path.join(agentDir, 'mcp.json'), JSON.stringify({ mcpServers: { fixture: { command: process.execPath, args: [path.join(root, 'scripts/pi-codemode-auto-fixture.mjs'), workspace], exposure: 'codemode', timeout: 15 } } }));
const nonce = crypto.randomBytes(12).toString('hex'), values = Array.from({ length: 13 }, () => crypto.randomInt(-500, 1000));
fs.writeFileSync(path.join(workspace, 'sample.json'), JSON.stringify({ nonce, values }));
const validator = path.join(workspace, 'validate.cjs');
fs.writeFileSync(validator, `const fs=require('node:fs'),p=require('node:path');const expected=${JSON.stringify(nonce)};let input;try{input=JSON.parse(fs.readFileSync(p.join(__dirname,'repair.json'),'utf8'));}catch{}const ok=input?.enabled===true&&input?.nonce===expected;fs.appendFileSync(p.join(__dirname,'validator-audit.jsonl'),JSON.stringify({code:ok?0:7,at:Date.now()})+'\\n');if(!ok){console.error('INPUT_INVALID: repair.json must contain enabled=true and the exact expected nonce documented in validate.cjs. Do not change the validator.');process.exit(7);}fs.writeFileSync(p.join(__dirname,'validated.json'),JSON.stringify({ok:true,nonce:expected,source:'real-node'}));console.log('VALIDATED_OK');`);
fs.writeFileSync(validator, [
 'const fs=require("node:fs"),p=require("node:path");',
 'const expected='+JSON.stringify(nonce)+';let input;try{input=JSON.parse(fs.readFileSync(p.join(__dirname,"repair.json"),"utf8"));}catch{}',
 'const ok=input?.enabled===true&&input?.nonce===expected;',
 'fs.appendFileSync(p.join(__dirname,"validator-audit.jsonl"),JSON.stringify({code:ok?0:7})+String.fromCharCode(10));',
 'if(!ok){console.error("INPUT_INVALID: repair.json requires enabled=true and the nonce in validate.cjs; never edit the validator");process.exit(7)}',
 'fs.writeFileSync(p.join(__dirname,"validated.json"),JSON.stringify({ok:true,nonce:expected}));console.log("VALIDATED_OK")'
].join('\n'));
const validatorHash = crypto.createHash('sha256').update(fs.readFileSync(validator)).digest('hex');
fs.mkdirSync(path.join(agentDir, 'agents'), { recursive: true });
fs.writeFileSync(path.join(agentDir, 'agents/worker.md'), '---\nname: worker\ndescription: Read-only native Pi acceptance worker\ntools: read, ls\nmodel: commandcode/deepseek/deepseek-v4.1-flash\n---\nRead the actual task input. Report exact values; do not guess.');
let proc, socket, log;
let id = 0;
const pending = new Map();
function rpc(method, params = {}) { return new Promise((resolve, reject) => { const n = ++id, timer = setTimeout(() => { pending.delete(n); reject(Error('CDP timeout: ' + method)); }, 8000); pending.set(n, { resolve, reject, timer }); socket.send(JSON.stringify({ id: n, method, params })); }); }
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
 await evaluate('document.querySelector(".sidebar-cta-btn").click()');
 for(let i=0;i<60;i++){if(await evaluate('Boolean(document.querySelector(".hero"))'))break;await wait(100)}
 const label=task.mode==='working'?'日常办公':'代码开发';
 await evaluate('(()=>{const b=[...document.querySelectorAll(".hero-categories button")].find(b=>b.textContent.trim()==='+JSON.stringify(label)+');if(!b)throw Error("Mode unavailable");b.click();})()');
 for(let i=0;i<60;i++){if(await evaluate('document.querySelector(".hero")?.getAttribute("data-mode")==='+JSON.stringify(task.mode)))break;await wait(100)}
 row.hero=await evaluate('({mode:document.querySelector(".hero")?.getAttribute("data-mode"),statusVisible:!!document.querySelector("[data-testid=pi-codemode-status]"),tags:[...document.querySelectorAll(".hero-scenes button")].map(b=>({label:b.textContent.trim(),pressed:b.getAttribute("aria-pressed")}))})');
 assert.equal(row.hero.mode,task.mode);assert.equal(row.hero.statusVisible,false);
 if(task.mode==='coding'){
   assert.equal(row.hero.tags[0]?.label,'最小模式');assert.equal(row.hero.tags[0]?.pressed,'true','Fresh coding scene must default to minimal');
   await evaluate('(()=>{const b=[...document.querySelectorAll(".hero-scenes button")].find(b=>b.textContent.trim()==='+JSON.stringify(task.presetLabel)+');if(!b)throw Error("Preset unavailable");b.click();})()');
 }
 const enabled=await evaluate('window.api.mcp.setServerEnabled("fixture",'+JSON.stringify(task.mcp!==false)+')');assert(enabled.ok!==false,JSON.stringify(enabled));
 if(task.seed)fs.writeFileSync(path.join(workspace,'seed.json'),JSON.stringify(task.seed));
 fs.writeFileSync(path.join(workspace,'mcp-audit.jsonl'),'');fs.rmSync(path.join(workspace,'result.json'),{force:true});
}
async function inspectScene(task,row,state){
 const snapshot=await evaluate('window.api.mcp.status('+JSON.stringify(state.taskId)+')');assert(snapshot?.codeMode);assert.equal(snapshot.codeMode.active,task.mode==='coding');assert.equal(snapshot.codeMode.models,task.mode==='coding');row.nativeCodeMode=snapshot.codeMode;
 const tasks=await evaluate('window.api.db.listTasks()'),saved=tasks.find(t=>t.id===state.taskId);assert(saved);row.persisted={welcomeMode:saved.welcomeMode,modePresetId:saved.modePresetId};assert.equal(saved.welcomeMode,task.mode);if(task.mode==='coding')assert.equal(saved.modePresetId,task.presetId);
 assert.equal(await evaluate('!!document.querySelector("[data-testid=pi-codemode-status]")'),false);
 const db=new DatabaseSync(path.join(agentDir,'app.db'),{readOnly:true});try{const snap=db.prepare('SELECT resolved_instructions_json FROM task_runtime_context_snapshots WHERE task_id=? ORDER BY started_at DESC LIMIT 1').get(state.taskId);assert(snap?.resolved_instructions_json);const text=String(snap.resolved_instructions_json);row.promptEvidence={hasModePresetSegment:text.includes('"modePreset"')};if(task.presetId==='minimal')assert(!row.promptEvidence.hasModePresetSegment);if(task.presetId==='bugfix-test')assert(row.promptEvidence.hasModePresetSegment)}finally{db.close()}
}
const cases=[presetCase('minimal-no-prompt','minimal','最小模式'),presetCase('bugfix-prompt-control','bugfix-test','修 Bug')];
const office=presetCase('office-native-discovery','minimal','最小模式');office.mode='working';office.presetId=undefined;office.prompt='办公场景真实验收：先使用原生 tool_search 找到 fixture 的 read_seed 和 save_result，读取随机 nonce 和 values，计算总和，用 save_result 保存精确 {nonce,sum}。不要使用 codemode，不得猜测数值。只操作测试 fixture，完成后报告结果。';office.check=state=>{const actual=JSON.parse(fs.readFileSync(path.join(workspace,'result.json'),'utf8'));assert.deepEqual(actual,{nonce:office.seed.nonce,sum:office.seed.values.reduce((a,b)=>a+b,0)});assert(!state.tools.some(t=>t.name==='codemode'));assert(state.tools.some(t=>t.name==='tool_search'&&t.status==='success'));return {actual}};cases.push(office);
const basic={mode:'coding',mcp:false,presetId:'minimal',presetLabel:'最小模式'};
cases.push({...basic,name:'codemode-without-mcp',prompt:'在没有 MCP 的代码场景，用 Pi 原生 codemode 调用 read 读取 '+JSON.stringify(path.join(workspace,'sample.json'))+'，计算随机 values 总和。再用原生 write 将精确 {nonce,sum} 写入 '+JSON.stringify(path.join(workspace,'native-result.json'))+'。不要猜值，不操作其他目录。',check(state){const r=JSON.parse(fs.readFileSync(path.join(workspace,'native-result.json'),'utf8'));assert.deepEqual(r,{nonce,sum:values.reduce((a,b)=>a+b,0)});assert(state.tools.some(t=>t.name==='codemode'&&t.status==='success'));assert(!state.tools.some(t=>t.name.startsWith('mcp__')));return {actual:r}}});
cases.push({...basic,name:'native-models-and-reference',prompt:'用 Pi 原生 codemode 验证原生模型接口，只查询，不调用收费生图或分类：调用 models.getModelsOfType("chat")、models.getAvailableOfType("chat") 和 models.getAvailableOfType("image")。用 read 读取 {{PI_DOCS}} 的完整原生参考文档，并确认包含 models.generateImages。用 write 将 {hasNativeImageAPI:typeof models.generateImages==="function",hasNoChatAPI:!("stream" in models),docsHasImageAPI:文档是否包含上述接口,knownChatCount:已知聊天模型数量,availableChatCount:可用聊天模型数量,availableImageCount:可用图像模型数量} 写到 '+JSON.stringify(path.join(workspace,'models-result.json'))+'。只存布尔值和数量，不保存任何凭据。',check(state){const r=JSON.parse(fs.readFileSync(path.join(workspace,'models-result.json'),'utf8'));assert.equal(r.hasNativeImageAPI,true);assert.equal(r.hasNoChatAPI,true);assert.equal(r.docsHasImageAPI,true);assert(r.knownChatCount>0&&r.availableChatCount>0);assert(Number.isInteger(r.availableImageCount));assert(state.tools.some(t=>t.name==='codemode'&&t.status==='success'));assert(state.tools.some(t=>t.name==='read'&&t.status==='success'));return r}});
cases.push({...basic,name:'native-error-repair',prompt:'真实故障恢复验收。必须首先通过 Pi 原生 codemode 的 bash 工具运行 node '+JSON.stringify(validator)+'，它应该返回 exit_code=7。先实际运行一次，不得预先修复。随后读取这个校验脚本，根据脚本中的真实 nonce 创建同目录 repair.json，内容为 enabled:true 和正确 nonce；再次运行同一个 node 命令直至返回0。禁止修改 validate.cjs。最终确认同目录 validated.json。所有操作仅限测试目录。',check(state){const rows=fs.readFileSync(path.join(workspace,'validator-audit.jsonl'),'utf8').trim().split(String.fromCharCode(10)).filter(Boolean).map(line=>JSON.parse(line.trim()));assert.equal(rows[0].code,7);assert.equal(rows.at(-1).code,0);assert.equal(crypto.createHash('sha256').update(fs.readFileSync(validator)).digest('hex'),validatorHash);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(workspace,'validated.json'),'utf8')),{ok:true,nonce});assert(state.tools.filter(t=>t.name==='bash').length>=2);return {exitCodes:rows.map(r=>r.code),validatorUnchanged:true}}});
cases.push({...basic,name:'native-readonly-worker',prompt:'使用 subagent 工具显式调用名为 worker 的只读子任务，让它读取 '+JSON.stringify(path.join(workspace,'sample.json'))+' 并计算随机 values 总和，返回精确 nonce 和 sum。主模型不要自行读取该输入代算。收到 worker 的真实结果后，主模型用 write 把 {nonce,sum} 写入 '+JSON.stringify(path.join(workspace,'worker-result.json'))+'。只调用一次 worker，不进行多模型会诊，不操作其他目录。',check(state){const r=JSON.parse(fs.readFileSync(path.join(workspace,'worker-result.json'),'utf8'));assert.deepEqual(r,{nonce,sum:values.reduce((a,b)=>a+b,0)});assert(state.tools.some(t=>t.name==='subagent'&&t.status==='success'),'No successful native child invocation');return {actual:r,childCalls:state.tools.filter(t=>t.name==='subagent').length}}});
if(!cases.some(c=>c.name===selectedCase))throw Error('Unknown live case '+selectedCase);

(async () => {
    try {
        const pointer = JSON.parse(fs.readFileSync(path.join(root, 'artifacts/pi100-upgrade/build-latest.json'), 'utf8'));
        const buildId=process.argv.includes('--build') ? process.argv[process.argv.indexOf('--build')+1] : undefined;
        if(buildId && !/^build-\d+$/.test(buildId))throw Error('Invalid build identifier');
        const buildReport=buildId ? path.join(root,'artifacts/pi100-upgrade',buildId,'build.json') : pointer.report;
        const acceptedBuild=JSON.parse(fs.readFileSync(buildReport,'utf8'));
        report.buildReport=buildReport;
        assert.equal(acceptedBuild.status, 'passed');
        const exe = process.env.PI_NATIVE_DESKTOP_EXE || acceptedBuild.cleanExecutable || acceptedBuild.executable;
        report.asarSha256=acceptedBuild.asarSha256;report.sourceFingerprint=acceptedBuild.sourceFingerprint;
        assert(fs.existsSync(exe), 'Verified portable executable is missing');
        assert.equal(crypto.createHash('sha256').update(fs.readFileSync(path.join(path.dirname(exe),'resources/app.asar'))).digest('hex'),acceptedBuild.asarSha256,'Live binary must match verified package');
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
                task.prompt=task.prompt.replace('{{PI_DOCS}}',JSON.stringify(path.join(path.dirname(exe),'resources/app.asar/out/main/pi-docs/codemode.md')));
                await prepareScene(task,row);
                await evaluate(`window.__pi099.current={tools:[],thinkingEvents:0,textEvents:0,receivedText:'',started:false,done:false}`);
                await evaluate('(()=>{const e=document.querySelector("textarea");e.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,"value").set.call(e,' + JSON.stringify(task.prompt) + ');e.dispatchEvent(new Event("input",{bubbles:true}));return true;})()');
                await wait(120);
                await rpc('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
                await rpc('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
                let state;
                for (let i = 0; i < 85 && Date.now()-Date.parse(report.startedAt)<95000; i++) {
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
        assert(sessionAudit.some(a=>a.observedModels.includes(selectedModel)),'Configured real provider/model never produced an answer');
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
