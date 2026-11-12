/**
 * Actual cold-process AgentService native task → local model acceptance.
 * Synthetic authorized L1/scope fixtures use product service APIs. No hand-built
 * memory prompt, extraction mock, provider-response substitution, or user profile.
 * Headless service acceptance, not Electron UI or complete Work lifecycle proof.
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { ModelRuntime, SettingsManager } from '@earendil-works/pi-coding-agent';
import { AgentService } from '../src/main/agent/AgentService';
import { TaskExecutionWorkspace } from '../src/main/task/TaskExecutionWorkspace';
import { AppDatabase } from '../src/main/db/AppDatabase';
const home=process.env.BOT_RECALL_SCOPE_HOME!,out=process.env.BOT_RECALL_SCOPE_OUT!,repo=process.env.BOT_RECALL_SCOPE_REPO!;
assert(home&&out&&repo);assert.equal(resolve(homedir()),resolve(home));assert(!resolve(home).startsWith(resolve(repo)+'/'));
const live=process.argv.includes('--live'), modelId='opendesign/deepseek-v4.1-flash',provider='scope-live',modelKey=provider+'/'+modelId;
const sha=(b:string|Buffer)=>createHash('sha256').update(b).digest('hex');
const save=(name:string,value:unknown)=>writeFileSync(join(out,name),JSON.stringify(value,null,2));
const provenance=JSON.parse(readFileSync(join(out,'compile-provenance.json'),'utf8'));
const fingerprints=()=>Object.fromEntries(Object.keys(provenance.inputs).map(p=>[p,sha(readFileSync(join(repo,p)))]));
assert.deepEqual(fingerprints(),provenance.inputs);
const prior=JSON.parse(readFileSync(join(out,'prior-report.json'),'utf8'));
const report:any={live,startedAt:new Date().toISOString(),source:{commit:provenance.commit,coldCommit:provenance.coldCommit,priorCommit:provenance.priorCommit,compiledInputCount:Object.keys(provenance.inputs).length},model:JSON.parse(readFileSync(join(out,'model.json'),'utf8'))?.evidence,cases:[],calls:[],unscopedAttempts:[],freshTaskIds:[],fixture:prior.fixture,scope:'Production service wiring with synthetic scope bindings; not UI or full Work delivery lifecycle'};
const persist=()=>save('report.json',report);
if(!live){assert(prior.passed===24&&prior.failed===0);report.preflightPassed=true;report.modelCallCount=0;persist();console.log('PASS cold harness zero-inference preflight');process.exit(0);}
const captures:Promise<unknown>[]=[];let active:any;let serial=0;let agent!:AgentService;
const nativeFetch=globalThis.fetch;
const auditFetch:typeof fetch=async(input,init)=>{
 assert(live,'Harness preflight must make zero model calls');
 const request=new Request(input,init);assert.equal(request.url,'http://127.0.0.1:3425/v1/chat/completions');
 const body=await request.clone().text(),payload=JSON.parse(body);assert.equal(payload.model,modelId);assert(report.calls.length<30,'Hard model HTTP request cap');
 const lane=payload.tools?.length?'agent':'auxiliary';
 if(!active){const attempt={attemptedAt:new Date().toISOString(),lane,requestSha256:sha(body),networkAllowed:lane==='auxiliary'};report.unscopedAttempts.push(attempt);save(`unscoped-request-${report.unscopedAttempts.length}.json`,payload);persist();if(lane==='agent')throw Error('Outside-case agent inference blocked');}
 const call:any={index:report.calls.length+1,caseId:lane==='agent'?active.id:(!active?'background':undefined),observedDuringCaseId:active?.id,scopeAttribution:payload.tools?.length?'tools-present heuristic':'unknown auxiliary scope; timing is not provenance',startedAt:new Date().toISOString(),requestSha256:sha(body),lane:payload.tools?.length?'agent':'auxiliary'};
 save(`request-${call.index}.json`,payload);report.calls.push(call);persist();
 const headers=new Headers(request.headers);headers.delete('authorization');call.authorizationSent=headers.has('authorization');
 try{
 const response=await nativeFetch(new Request(request,{headers}));call.status=response.status;
 captures.push(response.clone().text().then(raw=>{writeFileSync(join(out,`response-${call.index}.txt`),raw);call.responseSha256=sha(raw);
 const events:any[]=[];for(const line of raw.split('\n'))if(line.startsWith('data: ')&&line.slice(6).trim()!=='[DONE]'){try{events.push(JSON.parse(line.slice(6)));}catch{}}
 if(!events.length){try{events.push(JSON.parse(raw));}catch{}}
 call.rawUsage=events.filter(e=>e.usage).map(e=>({usage:e.usage,model:e.model,id:e.id}));call.reportedModels=[...new Set(events.map(e=>e.model).filter(Boolean))];call.finishedAt=new Date().toISOString();persist();}).catch(e=>{call.captureError=String(e);persist();}));return response;
 }catch(e){call.error=String(e);persist();throw e;}
};
const models=await ModelRuntime.create({credentials:new InMemoryCredentialStore(),modelsPath:null,modelsStorePath:join(home,'models-cache.json'),allowModelNetwork:false,refreshOnCreate:false});
const catalog=JSON.parse(readFileSync(join(out,'model.json'),'utf8'));assert.equal(catalog.model.id,modelId);
models.registerProvider(provider,{api:'openai-completions',apiKey:'synthetic-local-no-auth',baseUrl:'http://127.0.0.1:3425/v1',models:[catalog?.model??{id:modelId,name:'Non-inference preflight',reasoning:false,input:['text'],contextWindow:131072,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]});
const stream=models.streamSimple.bind(models);
models.streamSimple=(model,context,options)=>{assert.equal(model.provider,provider);assert.equal(model.id,modelId);return stream(model,context,{...options,fetch:auditFetch,maxRetries:0,timeoutMs:90000});};
await models.refresh({allowNetwork:false});
const settings=SettingsManager.create(repo,join(home,'.mybuddy'));settings.setDefaultModelAndProvider(provider,modelId);settings.setEnabledModels([modelKey]);await settings.flush();
const db=new AppDatabase(join(home,'app.db'));
const question=(task:string)=>`${task}\n请直接在聊天中完成，不调用外部工具，不创建后台工作，不写文件。最后另起一行，逐字列出当前有效记忆提供的所有验收参考码；没有则写“没有参考码”。不要猜测或从过去回答复制已撤回的参考码。`;
const currentWire=(row:any)=>report.calls.filter((c:any)=>c.caseId===row.id&&c.lane==='agent').map((c:any)=>readFileSync(join(out,`request-${c.index}.json`),'utf8')).join('\n');
async function check(id:string,type:string,run:()=>Promise<string>,yes:string[],no:string[],expected?:RegExp,wireOnly:string[]=[],answerExcluded:string[]=[]){
 const row:any={id,type,yes,no,wireOnly,answerExcluded,startedAt:new Date().toISOString()};report.cases.push(row);active=row;persist();
 try{row.answer=await run();await Promise.allSettled(captures);row.wireCalls=report.calls.filter((c:any)=>c.caseId===id&&c.lane==='agent').map((c:any)=>c.index);
 const wire=currentWire(row);assert(row.wireCalls.length>0,'Actual model request required');
 for(const key of yes){assert(wire.includes(markers[key]),`wire missing ${key}`);if(!wireOnly.includes(key))assert(row.answer.includes(markers[key]),`answer missing ${key}`);}
 for(const key of no){assert(!wire.includes(markers[key]),`wire leaked ${key}`);assert(!row.answer.includes(markers[key]),`answer leaked ${key}`);}
 for(const key of answerExcluded)assert(!row.answer.includes(markers[key]),`answer published excluded ${key}`);
 if(expected)assert.match(row.answer,expected);row.passed=true;
 }catch(e){row.passed=false;row.error=e instanceof Error?{message:e.message,stack:e.stack}:String(e);}
 row.finishedAt=new Date().toISOString();persist();console.log(`${row.passed?'PASS':'FAIL'} ${id}${row.error?' '+row.error.message:''}`);active=undefined;return row;
}
const markers:Record<string,string>=prior.fixture.markers;
const createTask=(id:string,projectId?:string)=>{assert(!db.getTask(id),'Fresh task must not preexist');db.upsertTask({id,title:id,projectId,welcomeMode:'general',updatedAt:Date.now(),modelId:modelKey,permissionMode:'readonly'});report.freshTaskIds.push(id);persist();return id;};
const task=async(id:string,text:string)=>{
 const n=++serial;
 const accepted=await agent.prompt({taskId:id,text:question(text),modelId:modelKey,permissionMode:'readonly',welcomeMode:'general',userMessageId:`cold-user-${n}`,assistantMessageId:`cold-answer-${n}`});assert(accepted.receipt);
 const settled=await agent.waitForSubmission(accepted.receipt);assert.equal(settled.receipt?.status,'done',JSON.stringify(settled));
 const history=await agent.loadTaskHistory(id);const answer=history.messages.filter(m=>m.role==='assistant').at(-1);assert(answer);return answer.text;
};
try{
 agent=new AgentService(db,new TaskExecutionWorkspace(join(home,'tasks')),{models});await agent.init(); // deliberately no resumePersistedTasks
 assert.equal(agent.getAppSettings().memoryEnabled,true,'Prior fixture must remain enabled; never enable it in this probe');
 await agent.updateAppSettings({permissionMode:'readonly',defaultModelId:modelKey,enabledModels:[modelKey]});
 const revokedProjects:Record<string,string>={};
 for(const mode of ['forget','detach','expiry']){
  const old=db.getTask('old-'+mode);assert(old?.projectId);revokedProjects[mode]=old.projectId;
  const row:any={id:'cold-'+mode+'-old-session',type:'reauthorization-denial',startedAt:new Date().toISOString()};report.cases.push(row);active=row;const startAgent=report.calls.filter((c:any)=>c.lane==='agent').length,startAux=report.calls.filter((c:any)=>c.lane==='auxiliary').length;
  try{await task('old-'+mode,'把3、2、1按升序排列。');row.error='Revoked historical session was allowed';row.passed=false;}
  catch(e){row.error=String(e);row.zeroAgentModelCalls=report.calls.filter((c:any)=>c.lane==='agent').length===startAgent;row.passed=row.zeroAgentModelCalls&&/历史 Memory.*已(停用|撤销)|历史派生记忆已撤销/.test(row.error);}
  row.auxWindowCalls=report.calls.filter((c:any)=>c.lane==='auxiliary').length-startAux;row.finishedAt=new Date().toISOString();persist();console.log(`${row.passed?'PASS':'FAIL'} ${row.id}`);active=undefined;
 }
 const fresh=(suffix:string,projectId?:string)=>createTask(`cold-${process.pid}-${suffix}`,projectId);
 const deny=(yes:string[])=>Object.keys(markers).filter(k=>!yes.includes(k));
 const cases:Array<[string,string,string,string|undefined,string[],RegExp]>=[
 ['forget','inventory','甲仓7件、乙仓11件，请算总库存。',revokedProjects.forget,['public','legacy'],/18/],
 ['detach','meeting-agenda','请把开场2分钟、讨论8分钟、总结5分钟排成会议议程并写总时长。',revokedProjects.detach,['public','legacy'],/15/],
 ['expiry','translation','把 The appointment is on Friday at 3 PM. 翻译成中文。',revokedProjects.expiry,['public','legacy'],/3|三/],
 ['project-p','unit-conversion','把2.5公里换算成米。',prior.fixture.projects[0],['public','legacy','projectP'],/2500|2,500/],
 ['project-q','sorting','将8、1、11、3按升序排列。',prior.fixture.projects[1],['public','legacy','projectQ'],/1.*3.*8.*11/s],
 ['unbound','checklist','把“检查备份、验证版本、确认健康状态”整理成三项检查清单。',undefined,['public','legacy'],/备份/]
 ];
 assert.equal(new Set(cases.map(c=>c[1])).size,6);
 for(const [id,type,prompt,project,yes,expected] of cases)await check('cold-'+id,type,()=>task(fresh(id,project),prompt),yes,deny(yes),expected);
}catch(e){report.fatal=e instanceof Error?{message:e.message,stack:e.stack}:String(e);console.error(e);}
finally{
 if(agent!){await agent.closeDurableBots().catch(e=>{report.closeError=String(e);});agent.dispose();}await Promise.allSettled(captures);
 report.source.unchanged=JSON.stringify(fingerprints())===JSON.stringify(provenance.inputs);
 report.modelCallCount=report.calls.length;report.agentModelCalls=report.calls.filter((c:any)=>c.lane==='agent').length;report.auxiliaryModelCalls=report.calls.filter((c:any)=>c.lane==='auxiliary').length;
 report.pricing='not-measured; SDK zero catalog prices are not actual cost';
 report.restartBoundary='New OS process against prior completed live run synthetic DB and native disk logs; no autonomous resume';
 report.coldDisable='UNVERIFIED: prior run re-enabled memory after service reconstruction; this probe never toggles memoryEnabled';
 report.laneClassifier='Request has provider tools: agent; no tools: auxiliary (heuristic only; scope assertions inspect tools-present agent requests; auxiliary scope attribution unknown)';
 report.distinctTaskTypes=[...new Set(report.cases.filter((c:any)=>c.type!=='reauthorization-denial').map((c:any)=>c.type))];
 report.passed=report.cases.filter((c:any)=>c.passed).length;report.failed=report.cases.filter((c:any)=>!c.passed).length;report.finishedAt=new Date().toISOString();
 report.coveragePassed=report.cases.length===9&&report.distinctTaskTypes.length===6&&report.cases.filter((c:any)=>c.type==='reauthorization-denial'&&c.passed).length===3;
 const ledgers:any[]=[];const collect=(value:any,path:string)=>{if(!value||typeof value!=='object')return;if(value.kind==='mybuddy.context-ledger')ledgers.push({path:path.replace(home,'ISOLATED_HOME'),entryId:value.id,data:value.data});for(const nested of Object.values(value))collect(nested,path);};
 const walk=(dir:string)=>{for(const name of readdirSync(dir)){const path=join(dir,name);if(statSync(path).isDirectory())walk(path);else if(name.endsWith('.jsonl'))for(const line of readFileSync(path,'utf8').split('\n'))if(line.includes('mybuddy.context-ledger')){try{collect(JSON.parse(line),path);}catch{}}}};
 walk(join(home,'.mybuddy'));save('ledger-records.json',ledgers);report.ledgerRecordCount=ledgers.length;
 report.ledgerHasInlineMarkers=Object.values(markers).some(marker=>JSON.stringify(ledgers).includes(marker));
 const freshIds=new Set<string>(report.freshTaskIds);
 const newLedgers=ledgers.filter(entry=>freshIds.has(entry.data?.scope?.taskId));save('new-task-ledger-records.json',newLedgers);
 report.newTaskLedgerRecordCount=newLedgers.length;
 report.newTaskLedgerCounts=Object.fromEntries(report.freshTaskIds.map((id:string)=>[id,newLedgers.filter(entry=>entry.data?.scope?.taskId===id).length]));
 report.newTaskLedgerHasInlineMarkers=Object.values(markers).some(marker=>JSON.stringify(newLedgers).includes(marker));
 report.newTaskLedgerReferencesOnly=newLedgers.every(entry=>Array.isArray(entry.data?.additions)&&entry.data.additions.every((item:any)=>!('text' in item)&&!('content' in item)&&!('renderedText' in item)&&(!String(item.id).startsWith('memory:')||item.reference?.id)));
 report.auxiliaryAudit={callIndices:report.calls.filter((c:any)=>c.lane==='auxiliary').map((c:any)=>c.index),scopeAttribution:'unknown; observedDuringCaseId records timing only, not originating case'};
 report.evidencePassed=freshIds.size===6&&Object.values(report.newTaskLedgerCounts).every(count=>Number(count)>0)&&!report.newTaskLedgerHasInlineMarkers&&report.newTaskLedgerReferencesOnly&&!report.unscopedAttempts.some((attempt:any)=>attempt.lane==='agent')&&!report.calls.some((c:any)=>c.captureError||c.error);
 persist();db.close();console.log(JSON.stringify({passed:report.passed,failed:report.failed,modelCalls:report.modelCallCount,types:report.distinctTaskTypes.length,fatal:report.fatal?.message,out}));
 process.exitCode=report.fatal||report.failed||report.closeError||!report.source.unchanged||!report.coveragePassed||!report.evidencePassed?1:0;
}
