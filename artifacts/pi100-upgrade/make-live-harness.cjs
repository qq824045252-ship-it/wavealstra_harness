const fs=require('node:fs');let s=fs.readFileSync('scripts/pi-minimal-mode-desktop-live.cjs','utf8');
s=s.replace("const out = path.join(root, 'artifacts/pi-minimal-mode/desktop-live');",`const selectedCase = process.argv.includes('--only') ? process.argv[process.argv.indexOf('--only')+1] : 'minimal-no-prompt';
if(!process.argv.includes('--only'))process.argv.push('--only',selectedCase);
const selectedModel=process.env.PI100_LIVE_MODEL || 'commandcode/deepseek/deepseek-v4.1-flash';
const selectedProvider=selectedModel.split('/')[0],selectedModelId=selectedModel.slice(selectedProvider.length+1);
const out=path.join(root,'artifacts/pi100-upgrade/desktop-live',selectedCase+'-'+selectedModel.replace(/[^a-z0-9.-]/gi,'_'));`);
s=s.replace("kind: 'pi-minimal-mode-real-model-packaged-desktop'","kind: 'pi100-real-model-packaged-desktop', selectedModel");
s=s.replaceAll("'artifacts/pi-minimal-mode/build-latest.json'","'artifacts/pi100-upgrade/build-latest.json'");
s=s.replace("process.env.PI_NATIVE_DESKTOP_EXE || acceptedBuild.executable","process.env.PI_NATIVE_DESKTOP_EXE || acceptedBuild.cleanExecutable || acceptedBuild.executable");
s=s.replace("defaultProvider: 'commandcode', defaultModel: 'deepseek/deepseek-v4.1-flash'","defaultProvider: selectedProvider, defaultModel: selectedModelId");
s=s.replace("enabledModels: ['commandcode/deepseek/deepseek-v4.1-flash']","enabledModels: [selectedModel]");
s=s.replace("}, 20000);","}, 8000);");
s=s.replace('for (let i = 0; i < 240; i++)','for (let i = 0; i < 85 && Date.now()-Date.parse(report.startedAt)<95000; i++)');
s=s.replace("const validatorHash =",`fs.writeFileSync(validator, [
 'const fs=require("node:fs"),p=require("node:path");',
 'const expected='+JSON.stringify(nonce)+';let input;try{input=JSON.parse(fs.readFileSync(p.join(__dirname,"repair.json"),"utf8"));}catch{}',
 'const ok=input?.enabled===true&&input?.nonce===expected;',
 'fs.appendFileSync(p.join(__dirname,"validator-audit.jsonl"),JSON.stringify({code:ok?0:7})+String.fromCharCode(10));',
 'if(!ok){console.error("INPUT_INVALID: repair.json requires enabled=true and the nonce in validate.cjs; never edit the validator");process.exit(7)}',
 'fs.writeFileSync(p.join(__dirname,"validated.json"),JSON.stringify({ok:true,nonce:expected}));console.log("VALIDATED_OK")'
].join('\\n'));
const validatorHash =`);
const start=s.indexOf('async function prepareScene('),end=s.indexOf('const cases=',start);if(start<0||end<0)throw Error('scene block');
s=s.slice(0,start)+String.raw`async function prepareScene(task,row){
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
`+s.slice(end);
const old="const cases=[presetCase('minimal-no-prompt','minimal','最小模式'),presetCase('bugfix-prompt-control','bugfix-test','修 Bug')];";
const added=String.raw`const cases=[presetCase('minimal-no-prompt','minimal','最小模式'),presetCase('bugfix-prompt-control','bugfix-test','修 Bug')];
const office=presetCase('office-native-discovery','minimal','最小模式');office.mode='working';office.presetId=undefined;office.prompt='办公场景真实验收：先使用原生 tool_search 找到 fixture 的 read_seed 和 save_result，读取随机 nonce 和 values，计算总和，用 save_result 保存精确 {nonce,sum}。不要使用 codemode，不得猜测数值。只操作测试 fixture，完成后报告结果。';office.check=state=>{const actual=JSON.parse(fs.readFileSync(path.join(workspace,'result.json'),'utf8'));assert.deepEqual(actual,{nonce:office.seed.nonce,sum:office.seed.values.reduce((a,b)=>a+b,0)});assert(!state.tools.some(t=>t.name==='codemode'));assert(state.tools.some(t=>t.name==='tool_search'&&t.status==='success'));return {actual}};cases.push(office);
const basic={mode:'coding',mcp:false,presetId:'minimal',presetLabel:'最小模式'};
cases.push({...basic,name:'codemode-without-mcp',prompt:'在没有 MCP 的代码场景，用 Pi 原生 codemode 调用 read 读取 '+JSON.stringify(path.join(workspace,'sample.json'))+'，计算随机 values 总和。再用原生 write 将精确 {nonce,sum} 写入 '+JSON.stringify(path.join(workspace,'native-result.json'))+'。不要猜值，不操作其他目录。',check(state){const r=JSON.parse(fs.readFileSync(path.join(workspace,'native-result.json'),'utf8'));assert.deepEqual(r,{nonce,sum:values.reduce((a,b)=>a+b,0)});assert(state.tools.some(t=>t.name==='codemode'&&t.status==='success'));assert(!state.tools.some(t=>t.name.startsWith('mcp__')));return {actual:r}}});
cases.push({...basic,name:'native-models-and-reference',prompt:'用 Pi 原生 codemode 验证原生模型接口，只查询，不调用收费生图或分类：调用 models.getModelsOfType("chat")、models.getAvailableOfType("chat") 和 models.getAvailableOfType("image")。用 read 读取 {{PI_DOCS}} 的完整原生参考文档，并确认包含 models.generateImages。用 write 将 {hasNativeImageAPI:typeof models.generateImages==="function",hasNoChatAPI:!("stream" in models),docsHasImageAPI:文档是否包含上述接口,knownChatCount:已知聊天模型数量,availableChatCount:可用聊天模型数量,availableImageCount:可用图像模型数量} 写到 '+JSON.stringify(path.join(workspace,'models-result.json'))+'。只存布尔值和数量，不保存任何凭据。',check(state){const r=JSON.parse(fs.readFileSync(path.join(workspace,'models-result.json'),'utf8'));assert.equal(r.hasNativeImageAPI,true);assert.equal(r.hasNoChatAPI,true);assert.equal(r.docsHasImageAPI,true);assert(r.knownChatCount>0&&r.availableChatCount>0);assert(Number.isInteger(r.availableImageCount));assert(state.tools.some(t=>t.name==='codemode'&&t.status==='success'));assert(state.tools.some(t=>t.name==='read'&&t.status==='success'));return r}});
cases.push({...basic,name:'native-error-repair',prompt:'真实故障恢复验收。必须首先通过 Pi 原生 codemode 的 bash 工具运行 node '+JSON.stringify(validator)+'，它应该返回 exit_code=7。先实际运行一次，不得预先修复。随后读取这个校验脚本，根据脚本中的真实 nonce 创建同目录 repair.json，内容为 enabled:true 和正确 nonce；再次运行同一个 node 命令直至返回0。禁止修改 validate.cjs。最终确认同目录 validated.json。所有操作仅限测试目录。',check(state){const rows=fs.readFileSync(path.join(workspace,'validator-audit.jsonl'),'utf8').trim().split(/?
/).map(JSON.parse);assert.equal(rows[0].code,7);assert.equal(rows.at(-1).code,0);assert.equal(crypto.createHash('sha256').update(fs.readFileSync(validator)).digest('hex'),validatorHash);assert.deepEqual(JSON.parse(fs.readFileSync(path.join(workspace,'validated.json'),'utf8')),{ok:true,nonce});assert(state.tools.filter(t=>t.name==='bash').length>=2);return {exitCodes:rows.map(r=>r.code),validatorUnchanged:true}}});
cases.push({...basic,name:'native-readonly-worker',prompt:'使用 subagent 工具显式调用名为 worker 的只读子任务，让它读取 '+JSON.stringify(path.join(workspace,'sample.json'))+' 并计算随机 values 总和，返回精确 nonce 和 sum。主模型不要自行读取该输入代算。收到 worker 的真实结果后，主模型用 write 把 {nonce,sum} 写入 '+JSON.stringify(path.join(workspace,'worker-result.json'))+'。只调用一次 worker，不进行多模型会诊，不操作其他目录。',check(state){const r=JSON.parse(fs.readFileSync(path.join(workspace,'worker-result.json'),'utf8'));assert.deepEqual(r,{nonce,sum:values.reduce((a,b)=>a+b,0)});assert(state.tools.some(t=>t.name==='subagent'&&t.status==='success'),'No successful native child invocation');return {actual:r,childCalls:state.tools.filter(t=>t.name==='subagent').length}}});
if(!cases.some(c=>c.name===selectedCase))throw Error('Unknown live case '+selectedCase);
`;
if(!s.includes(old))throw Error('cases anchor');s=s.replace(old,added);
s=s.replace('await prepareScene(task,row);',`task.prompt=task.prompt.replace('{{PI_DOCS}}',JSON.stringify(path.join(path.dirname(exe),'resources/app.asar/out/main/pi-docs/codemode.md')));
                await prepareScene(task,row);`);
s=s.replace('report.sessionAudit = sessionAudit;',`report.sessionAudit = sessionAudit;
        assert(sessionAudit.some(a=>a.observedModels.includes(selectedModel)),'Configured real provider/model never produced an answer');`);
fs.writeFileSync('scripts/pi100-desktop-live.cjs',s);console.log('Created bounded, per-case real desktop harness: '+s.length+' bytes');
