/**
 * Real AgentService → BotConversationService / DurableBotService → local model.
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
import { BotRegistry } from '../src/main/agent/work/BotRegistry';
import { WorkExecutionAdapter, type WorkExecutionPort } from '../src/main/agent/work/WorkExecutionAdapter';
import { DESKTOP_USER_GRANTS } from '../src/main/agent/work/WorkService';
import { ProjectRepository } from '../src/main/project/ProjectRepository';
import { ProjectService } from '../src/main/project/ProjectService';
import { MemoryService } from '../src/main/memory/MemoryService';
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkControlResult } from '../src/shared/bot-work';
import type { MemoryScopeType } from '../src/shared/memory-kernel';

const home=process.env.BOT_RECALL_SCOPE_HOME!,out=process.env.BOT_RECALL_SCOPE_OUT!,repo=process.env.BOT_RECALL_SCOPE_REPO!;
assert(home&&out&&repo);assert.equal(resolve(homedir()),resolve(home));assert(!resolve(home).startsWith(resolve(repo)+'/'));
const live=process.argv.includes('--live'), modelId='opendesign/deepseek-v4.1-flash',provider='scope-live',modelKey=provider+'/'+modelId;
const sha=(b:string|Buffer)=>createHash('sha256').update(b).digest('hex');
const save=(name:string,value:unknown)=>writeFileSync(join(out,name),JSON.stringify(value,null,2));
const provenance=JSON.parse(readFileSync(join(out,'compile-provenance.json'),'utf8'));
const fingerprints=()=>Object.fromEntries(Object.keys(provenance.inputs).map(p=>[p,sha(readFileSync(join(repo,p)))]));
assert.deepEqual(fingerprints(),provenance.inputs);
const report:any={live,startedAt:new Date().toISOString(),source:{commit:provenance.commit,compiledInputCount:Object.keys(provenance.inputs).length},model:JSON.parse(readFileSync(join(out,'model.json'),'utf8'))?.evidence,cases:[],calls:[],fixture:{},scope:'Production service wiring with synthetic scope bindings; not UI or full Work delivery lifecycle'};
const persist=()=>save('report.json',report);
const captures:Promise<unknown>[]=[];let active:any;let serial=0;let agent!:AgentService;
const nativeFetch=globalThis.fetch;
const auditFetch:typeof fetch=async(input,init)=>{
 assert(live,'Harness preflight must make zero model calls');
 const request=new Request(input,init);assert.equal(request.url,'http://127.0.0.1:3425/v1/chat/completions');
 const body=await request.clone().text(),payload=JSON.parse(body);assert.equal(payload.model,modelId);assert(report.calls.length<100,'Hard model HTTP request cap');
 const call:any={index:report.calls.length+1,caseId:active?.id??'background',startedAt:new Date().toISOString(),requestSha256:sha(body),lane:payload.tools?.length?'agent':'auxiliary'};
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
const catalog=JSON.parse(readFileSync(join(out,'model.json'),'utf8'));
models.registerProvider(provider,{api:'openai-completions',apiKey:'synthetic-local-no-auth',baseUrl:'http://127.0.0.1:3425/v1',models:[catalog?.model??{id:modelId,name:'Non-inference preflight',reasoning:false,input:['text'],contextWindow:131072,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}}]});
const stream=models.streamSimple.bind(models);
models.streamSimple=(model,context,options)=>{assert.equal(model.provider,provider);assert.equal(model.id,modelId);return stream(model,context,{...options,fetch:auditFetch,maxRetries:0,timeoutMs:90000});};
await models.refresh({allowNetwork:false});
const settings=SettingsManager.create(repo,join(home,'.mybuddy'));settings.setDefaultModelAndProvider(provider,modelId);settings.setEnabledModels([modelKey]);await settings.flush();
const db=new AppDatabase(join(home,'app.db'));
const bots=new BotRegistry(db.connection);bots.ensureDefaultBot(LOCAL_USER_ID);bots.registerBot({botId:'scope-foreign',userId:LOCAL_USER_ID,displayName:'Foreign Scope Bot',authorization:DESKTOP_USER_GRANTS});
const memory=new MemoryService(db,{semantic:false});
const projects=new ProjectService(new ProjectRepository(db.connection),memory);
const p=projects.create({name:'Scope Project P'}),q=projects.create({name:'Scope Project Q'});
const actor={kind:'user' as const,userId:LOCAL_USER_ID,entry:'desktop' as const,grants:{...DESKTOP_USER_GRANTS,allowRedelegation:true}};
const unwrap=(r:WorkControlResult)=>{assert(r.ok,JSON.stringify(r));return r.work;};
const open=async(front=false,enabled?:boolean)=>{agent=new AgentService(db,new TaskExecutionWorkspace(join(home,'tasks')),{models});await agent.init();await agent.updateAppSettings({...(enabled===undefined?{}:{memoryEnabled:enabled}),permissionMode:'readonly',defaultModelId:modelKey,enabledModels:[modelKey]});if(front)await agent.resumePersistedTasks();};
const close=async()=>{await agent.closeDurableBots();agent.dispose();};
const markers:Record<string,string>={};const atoms:Record<string,string>={};
const seed=(key:string,scopeType:MemoryScopeType,scopeId?:string,extra:object={})=>{const marker=`SCOPE_${key.toUpperCase()}_${sha(key).slice(0,9)}`;markers[key]=marker;const m=agent.createKernelMemory({kind:'constraint',title:'验收参考码 '+key,content:`当前作用域的验收参考码为 ${marker}。仅在用户要求列出当前可用验收参考码时列出。`,scopeType,scopeId,sourceType:'user',explicit:true,importance:3,confidence:1,...extra});atoms[key]=m.id;return m;};
const question=(task:string)=>`${task}\n请直接在聊天中完成，不调用外部工具，不创建后台工作，不写文件。最后另起一行，逐字列出当前有效记忆提供的所有验收参考码；没有则写“没有参考码”。不要猜测或从过去回答复制已撤回的参考码。`;
const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
async function until<T>(fn:()=>Promise<T|undefined>,label:string){const end=Date.now()+150000;while(Date.now()<end){const v=await fn();if(v!==undefined)return v;await pause(100);}throw Error('Timeout: '+label);}
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
const bot=async(text:string,teamId?:string,conversationId?:string)=>{
 const receipt=await agent.sendBotMessage({botId:DEFAULT_BOT_ID,teamId,conversationId,requestId:'scope-'+(++serial),text:question(text),selection:{modelId:modelKey,expertId:'',skillIds:[],mcpIds:[],connectorIds:[]}});
 const message=await until(async()=>{const history=await agent.botMessageHistory({botId:DEFAULT_BOT_ID,teamId,conversationId:receipt.conversationId});const item=history.messages.find(m=>m.messageId===receipt.assistantMessageId);if(item&&['completed','failed','cancelled','unknown'].includes(item.status))return item;},receipt.requestId);
 assert.equal(message.status,'completed',message.error);return message.text;
};
const createTask=(id:string,projectId?:string)=>{db.upsertTask({id,title:id,projectId,welcomeMode:'general',updatedAt:Date.now(),modelId:modelKey,permissionMode:'readonly'});return id;};
const port=():WorkExecutionPort=>(agent as any).durableBots.workExecutionPort();
const task=async(id:string,text:string,raw=false)=>{const n=++serial,works=agent.getWorkService(),binding=works.repo.bindingForTask(id);
 if(binding)assert(works.markDispatchAttempt(binding.bindingId,`attempt:${binding.bindingId}`).ok);
 const accepted=await agent.prompt({taskId:id,text:raw?text:question(text),modelId:modelKey,permissionMode:'readonly',welcomeMode:'general',userMessageId:binding?.operationId??`user-${n}`,assistantMessageId:`answer-${n}`});assert(accepted.receipt);
 if(binding)assert(works.recordSubmissionReceipt(binding.bindingId,JSON.stringify(accepted.receipt)).ok);
 const settled=await agent.waitForSubmission(accepted.receipt);assert.equal(settled.receipt?.status,'done',JSON.stringify(settled));
 if(binding){const observation=await port().inspect(binding,accepted.receipt);assert.equal(observation.status,'completed');assert.deepEqual(works.nativeResults.receive(binding,accepted.receipt,observation),[]);port().acknowledgeObservation?.(binding,accepted.receipt,observation);assert.equal(works.repo.getBinding(binding.bindingId)?.status,'completed');}
 const history=await agent.loadTaskHistory(id);const answer=history.messages.filter(m=>m.role==='assistant').at(-1);assert(answer);return answer.text;};
try{
 await open(true,true);
 // Filled through the product team API, not synthetic SQL ownership rows.
 const teamPlan={ownerBotId:DEFAULT_BOT_ID,ownerResponsibility:'汇总文字结果',members:[{botId:'scope-foreign',responsibility:'核对合成测试数据',delegatedScope:['workspace:read']}]};
 const teams=['A','B'].map(name=>{const result=agent.teamWorkControl({kind:'save_template',request:{operationId:'scope-template-'+name,name:'Scope Team '+name,plan:teamPlan}});assert(result.ok&&result.template,JSON.stringify(result));return result.template.templateId;});
 report.fixture={projects:[p.id,q.id],teams};
 seed('owner','bot',DEFAULT_BOT_ID);seed('foreign','bot','scope-foreign');seed('teamA','team',teams[0]);seed('teamB','team',teams[1]);seed('public','global',undefined,{metadata:{publicShared:true}});seed('legacy','global');seed('projectP','project',p.id);seed('projectQ','project',q.id);
 if(live){
 await check('personal-bot','inventory',()=>bot('甲仓7件、乙仓11件，请算总库存。'),['owner','public'],['foreign','teamA','teamB','projectP','projectQ','legacy'],/18/);
 await check('team-a','meeting-agenda',()=>bot('请把开场2分钟、讨论8分钟、总结5分钟排成会议议程并写总时长。',teams[0]),['teamA','public'],['owner','foreign','teamB','projectP','projectQ','legacy'],/15/);
 await check('team-b','editing',()=>bot('把“星期五前把预算表发给林经理”改写成一句礼貌提醒，不改日期和收件人。',teams[1]),['teamB','public'],['owner','foreign','teamA','projectP','projectQ','legacy'],/星期五|周五/);
 const history=await agent.botMessageHistory({botId:DEFAULT_BOT_ID});seed('conversation','conversation',history.conversationId);
 await check('same-conversation','sorting',()=>bot('将8、1、11、3按升序排列。',undefined,history.conversationId),['owner','public','conversation'],['foreign','teamA','teamB','projectP','projectQ','legacy'],/1.*3.*8.*11/s);
 agent.archiveBotConversation(DEFAULT_BOT_ID,history.conversationId);
 await check('new-conversation','punctuation',()=>bot('给“你好小林明天见”补上合适标点。'),['owner','public'],['conversation','foreign','teamA','teamB','projectP','projectQ','legacy'],/你好/);
 }
 await close();await open(); // No scheduler bootstrap: exercise admitted native tasks without creating autonomous Work runs.
 // Work-service operations and native prompt cases are below.
 const work=unwrap(agent.getWorkService().createWork(actor,{operationId:'scope-personal-work',title:'Scope Personal Work',ownerBotId:DEFAULT_BOT_ID,projectId:p.id,workspacePath:home,inputSnapshotId:'scope-input',authorization:{allowedScopes:['workspace:read']}}));
 const bind=async(id:string,workId:string)=>{createTask(id,q.id);const namespace=await port().prepare(id);return unwrap(agent.getWorkService().dispatchExecution(actor,{operationId:'bind-'+id,workId,botId:DEFAULT_BOT_ID,...namespace,delegatedScope:['workspace:read']}));};
 await bind('personal-work-task',work.workId);seed('personalWork','work',work.workId);seed('exactTask','task','personal-work-task');
 // Task-only evidence may inform this producer, but this task explicitly withholds
 // its code from the Work result. Published final answers are intentionally shared
 // within a Work; requiring withdrawal of that output would test a different contract.
 if(live)await check('personal-work','unit-conversion',()=>task('personal-work-task',question('把2.5公里换算成米。')+'\n特别限制：验收参考码仅输出非 task 范围的。标有 [task] 的参考码仅供本次执行内部判断，绝不输出到回答或工作成果，也不要写文件、调用工具。',true),['owner','personalWork','exactTask','projectP','public'],['foreign','teamA','teamB','projectQ','legacy','conversation'],/2500|2,500/,['exactTask'],['exactTask']);
 if(live){
 await bind('personal-work-second',work.workId);
 await check('same-work-second-execution','duration',()=>task('personal-work-second','90分钟等于几小时？'),['owner','personalWork','projectP','public'],['foreign','teamA','teamB','projectQ','legacy','conversation','exactTask'],/1.5|一.*半/);
 }
 const madeTeam=agent.teamWorkControl({kind:'create',request:{...teamPlan,operationId:'scope-team-work',templateId:teams[0],title:'Scope Team Work',goalDescription:question('从“李明提交，王芳审核”中提取两个人名。'),workspacePath:home,projectId:p.id,criteria:['给出两个人名，并列出当前有效的验收参考码'],members:[{...teamPlan.members[0],responsibility:question('从“李明提交，王芳审核”中提取两个人名。')}]}});
 assert(madeTeam.ok&&madeTeam.work&&madeTeam.team,JSON.stringify(madeTeam));seed('teamWork','work',madeTeam.work.workId);
 class ManualAdapter extends WorkExecutionAdapter{override wake(_taskId?:string):void{}}
 const manual=new ManualAdapter(agent.getWorkService(),port(),LOCAL_USER_ID,()=>true,(_id,error)=>{throw error;});
 await agent.getWorkService().teams.dispatchPending(db,manual,()=>modelKey,()=> 'readonly');
 const memberExecution=agent.getWorkService().teams.get(madeTeam.work.workId)!.executions.find(x=>x.role==='member')!;
 const memberBinding=agent.getWorkService().repo.bindingForTask(memberExecution.taskId)!;assert(memberBinding);
 if(live)await check('team-work-member','name-extraction',()=>task(memberExecution.taskId,agent.getWorkService().repo.executionInput(memberBinding),true),['teamA','teamWork','projectP','public'],['owner','foreign','teamB','personalWork','exactTask','projectQ','legacy','conversation'],/李明.*王芳/s);
 await manual.close();
 // Project-only tasks use the real task binding and production context resolver.
 if(live){
 await check('project-p-first','checklist',()=>task(createTask('project-p-first',p.id),'把“检查备份、验证版本、确认健康状态”整理成三项检查清单。'),['projectP','public','legacy'],['owner','foreign','teamA','teamB','personalWork','exactTask','projectQ','conversation'],/备份/);
 await check('project-p-second','translation',()=>task(createTask('project-p-second',p.id),'把 The appointment is on Friday at 3 PM. 翻译成中文。'),['projectP','public','legacy'],['owner','foreign','teamA','teamB','personalWork','exactTask','projectQ','conversation'],/3|三/);
 await check('project-q','percentage',()=>task(createTask('project-q',q.id),'20个零件中有5个不合格，不合格率是多少？'),['projectQ','public','legacy'],['owner','foreign','teamA','teamB','personalWork','exactTask','projectP','conversation'],/25\s*%/);
 }
 // Each mutation is applied to a record proved present in a real earlier request.
 // Historical references must refuse before inference; fresh scopes still complete.
 for(const mode of ['detach','expiry','forget','disable']){
 const project=projects.create({name:'Reauthorization '+mode}),keep=projects.create({name:'Retained '+mode});
 const key='life_'+mode,record=seed(key,'project',project.id);if(mode==='detach')agent.promoteKernelMemory(record.id,'project',keep.id);
 const old=createTask('old-'+mode,project.id);
 if(live)await check(mode+'-before','ratio',()=>task(old,'4杯水分给2人，每人几杯？'),[key],[],/2|两/);
 if(mode==='detach')agent.detachKernelMemoryScope(record.id,'project',project.id);
 if(mode==='expiry')agent.updateKernelMemory({id:record.id,validUntil:Date.now()-1});
 if(mode==='forget')agent.forgetKernelMemory(record.id);
 if(mode==='disable')await agent.updateAppSettings({memoryEnabled:false});
 await close();await open();if(mode==='disable')assert.equal(agent.getAppSettings().memoryEnabled,false,'Disabled state persists across service reconstruction');
 if(live){
 const row:any={id:mode+'-old-session',type:'reauthorization-denial',startedAt:new Date().toISOString()};report.cases.push(row);active=row;const start=report.calls.filter((c:any)=>c.lane==='agent').length;
 try{await task(old,'把3、2、1按升序排列。');throw Error('Revoked historical session was allowed to continue');}catch(e){row.error=String(e);row.zeroModelCalls=report.calls.filter((c:any)=>c.lane==='agent').length===start;row.passed=row.zeroModelCalls&&/历史 Memory.*已(停用|撤销)|历史派生记忆已撤销/.test(row.error);}
 persist();console.log(`${row.passed?'PASS':'FAIL'} ${row.id}`);active=undefined;
 await check(mode+'-fresh-session','temperature',()=>task(createTask('fresh-'+mode,project.id),'摄氏0度等于华氏多少度？'),[],[key],/32/);
 if(mode==='detach')await check('detach-retained-scope','name-extraction',()=>task(createTask('retained-detach',keep.id),'从“李明提交了表格；王芳审核了表格”提取两个人名。'),[key],[],/李明.*王芳/s);
 }
 if(mode==='disable')await agent.updateAppSettings({memoryEnabled:true});
 }
 report.fixture.atoms=atoms;report.fixture.markers=markers;
 if(!live){assert.equal(report.calls.length,0);report.preflightPassed=true;}
}catch(e){report.fatal=e instanceof Error?{message:e.message,stack:e.stack}:String(e);console.error(e);}
finally{
 if(agent!)await close().catch(e=>{report.closeError=String(e);});await Promise.allSettled(captures);
 report.source.unchanged=JSON.stringify(fingerprints())===JSON.stringify(provenance.inputs);
 report.modelCallCount=report.calls.length;report.agentModelCalls=report.calls.filter((c:any)=>c.lane==='agent').length;report.auxiliaryModelCalls=report.calls.filter((c:any)=>c.lane==='auxiliary').length;report.pricing='not-measured; SDK zero catalog prices are not actual cost';report.restartBoundary='AgentService reconstruction against the same on-disk DB/native logs, not a process restart';report.laneClassifier='Request has provider tools: agent; no tools: auxiliary (heuristic; raw bodies retained)';report.distinctTaskTypes=[...new Set(report.cases.filter((c:any)=>c.type!=='reauthorization-denial').map((c:any)=>c.type))];
 report.passed=report.cases.filter((c:any)=>c.passed).length;report.failed=report.cases.filter((c:any)=>!c.passed).length;report.finishedAt=new Date().toISOString();
 // Keep immutable raw native logs for exact ledger references; never publish fake tokens as real secrets.
 const ledgers:any[]=[];const collect=(value:any,path:string)=>{if(!value||typeof value!=='object')return;if(value.kind==='mybuddy.context-ledger')ledgers.push({path: path.replace(home,'ISOLATED_HOME'),entryId:value.id,data:value.data});for(const nested of Object.values(value))collect(nested,path);};
 const walk=(dir:string)=>{for(const name of readdirSync(dir)){const path=join(dir,name);if(statSync(path).isDirectory())walk(path);else if(name.endsWith('.jsonl'))for(const line of readFileSync(path,'utf8').split('\n'))if(line.includes('mybuddy.context-ledger')){try{collect(JSON.parse(line),path);}catch{}}}};
 walk(join(home,'.mybuddy'));save('ledger-records.json',ledgers);report.ledgerRecordCount=ledgers.length;
 report.ledgerHasInlineMarkers=Object.values(markers).some(marker=>JSON.stringify(ledgers).includes(marker));
 if(live&&(!ledgers.length||report.ledgerHasInlineMarkers))report.ledgerError='Native context ledger missing or contains inline synthetic source markers';
 persist();db.close();console.log(JSON.stringify({live,passed:report.passed,failed:report.failed,modelCalls:report.modelCallCount,types:report.distinctTaskTypes.length,fatal:report.fatal?.message,out}));
 process.exitCode=report.fatal||report.failed||report.ledgerError||!report.source.unchanged?1:0;
}
