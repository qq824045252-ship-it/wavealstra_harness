import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Type } from 'typebox';
import { getCurrentTools } from '@earendil-works/pi-ai';
import { createAssistantMessageEventStream, type AssistantMessage, type Model, type Context } from '@earendil-works/pi-ai/compat';
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type ModelRuntime } from '@earendil-works/pi-coding-agent';
import { AppDatabase } from '../src/main/db/AppDatabase';
import { MemoryService } from '../src/main/memory/MemoryService';
import { EphemeralContextProjection } from '../src/main/agent/EphemeralContextProjection';
import { resolveTaskMemoryScope } from '../src/main/agent/MemoryContextProjection';

const results:any[]=[];
const model:Model<any>={id:'memory-capsule-fixture',provider:'fixture',api:'openai-completions',name:'Memory capsule fixture',baseUrl:'http://invalid.invalid',reasoning:false,input:['text'],contextWindow:128000,maxTokens:4096,cost:{input:0,output:0,cacheRead:0,cacheWrite:0}};
function response(content:AssistantMessage['content'],stopReason:AssistantMessage['stopReason']='stop',errorMessage?:string):AssistantMessage{return {role:'assistant',content,stopReason,errorMessage,api:model.api,provider:model.provider,model:model.id,timestamp:Date.now(),usage:{input:2000,output:15,cacheRead:0,cacheWrite:0,totalTokens:2015,cost:{input:0,output:0,cacheRead:0,cacheWrite:0,total:0}}};}
async function scenario(name:string,mutation:'none'|'update'|'forget'|'detach',compact=false){
 const root=mkdtempSync(join(tmpdir(),'pi0992-memory-capsule-')),db=new AppDatabase(':memory:');let session:any;
 try{
  db.createSpace({id:'parent',name:'Parent'});db.createSpace({id:'child',name:'Child',parentId:'parent'});db.createSpace({id:'sibling',name:'Sibling',parentId:'parent'});
  db.connection.prepare('INSERT INTO projects (id,name,created_at,updated_at,archived,resource_budget_chars) VALUES (?,?,?,?,0,128000)').run('project','Project',Date.now(),Date.now());
  db.upsertTask({id:'task',title:name,spaceId:'child',projectId:'project',updatedAt:Date.now()});
  const memory=new MemoryService(db,{semantic:false});
  const add=(scopeType:any,scopeId:string|undefined,content:string)=>memory.create({scopeType,scopeId,kind:'fact',title:'Calibration reference '+content,content,explicit:true,sourceType:'user'});
  const atom=add('project','project','CANARY_PROJECT_OLD');add('workspace','child','CANARY_WORKSPACE');add('workspace','parent','CANARY_PARENT');add('global',undefined,'CANARY_GLOBAL');add('workspace','sibling','CANARY_FOREIGN_SIBLING');
  const settings=SettingsManager.inMemory({compaction:{enabled:false,keepRecentTokens:100},retry:{enabled:false,maxRetries:0}}),manager=SessionManager.inMemory(root);
  manager.appendMessage({role:'user',content:'OLD_CANONICAL_HISTORY '.repeat(2000),timestamp:Date.now()-60000});manager.appendMessage(response([{type:'text',text:'Old canonical answer. '.repeat(100)}]));
  let captureGuard:(()=>()=>void)|undefined,toolCalls=0,summaryCalls=0,denied=0;
  const sent:Context[]=[],projectionLogs:string[]=[];
  const projection=new EphemeralContextProjection({memory,enabled:()=>true,scope:()=>resolveTaskMemoryScope('task',db.getTask('task')),supplementalEvidence:()=>[],registerRequestGuard:(_s,capture)=>{captureGuard=capture},log:s=>projectionLogs.push(s)});
  const runtime={hasConfiguredAuth:()=>true,getAuth:async()=>({auth:{apiKey:'fixture-only'}}),getModel:()=>model,
   streamSimple:(_model:any,context:Context)=>{
    const stream=createAssistantMessageEventStream();let m:AssistantMessage;
    if(!getCurrentTools(context.messages).length){
      summaryCalls++;assert(!JSON.stringify(context).includes('mybuddy.context-capsule'),'capsule leaked into native compaction input');assert(!JSON.stringify(context).includes('CANARY_PROJECT_OLD'),'request-only memory leaked into compaction input');
      m=response([{type:'text',text:'PI_SUMMARY_WITHOUT_MEMORY_CAPSULE'}]);
    }else{
      try{captureGuard?.()();sent.push(structuredClone(context));m=sent.length===1?response([{type:'toolCall',id:'fixture-mutation',name:'fixture_tool',arguments:{}}],'toolUse'):response([{type:'text',text:'DONE_WITHOUT_ECHOING_CONTEXT'}]);}
      catch(e){denied++;m=response([],'error',String(e));}
    }
    stream.push({type:'start',partial:m});if(m.stopReason==='error')stream.push({type:'error',reason:'error',error:m});else stream.push({type:'done',reason:m.stopReason as 'stop'|'toolUse',message:m});stream.end();return stream;
   }} as unknown as ModelRuntime;
  const loader=new DefaultResourceLoader({cwd:root,agentDir:root,settingsManager:settings,noExtensions:true,noSkills:true,noThemes:true,noPromptTemplates:true,extensionFactories:[projection.extension]});await loader.reload();
  session=(await createAgentSession({cwd:root,agentDir:root,model,modelRuntime:runtime,settingsManager:settings,sessionManager:manager,resourceLoader:loader,noTools:'builtin',customTools:[{name:'fixture_tool',label:'Fixture tool',description:'Memory regression mutation boundary only',parameters:Type.Object({}),execute:async()=>{toolCalls++;if(mutation==='update')memory.update({id:atom.id,title:'Calibration reference CANARY_PROJECT_NEW',content:'CANARY_PROJECT_NEW'});if(mutation==='forget')memory.forget(atom.id);if(mutation==='detach')db.connection.prepare('UPDATE tasks SET project_id=NULL,space_id=NULL WHERE id=?').run('task');return {content:[{type:'text' as const,text:'Fixture operation completed'}],details:{}};}}]})).session;
  projection.attach(session);await session.bindExtensions({mode:'rpc'});await session.prompt('Recall calibration reference.');
  assert.equal(toolCalls,1);assert(session.isIdle);assert(sent.length>=1);
  const first=JSON.stringify(sent[0]);for(const canary of ['CANARY_PROJECT_OLD','CANARY_WORKSPACE','CANARY_PARENT','CANARY_GLOBAL'])assert(first.includes(canary),canary+' missing');assert(!first.includes('CANARY_FOREIGN_SIBLING'));
  if(mutation==='forget'||mutation==='detach'){assert.equal(denied,1);assert.equal(sent.length,1,'revoked memory reached another provider request');}
  else{assert.equal(sent.length,2);
    // Pi converts custom messages to provider user messages. Inspect transmitted
    // content, not the host-only customType which is deliberately no longer present.
    const capsules=sent.map(c=>c.messages.filter((m:any)=>JSON.stringify(m.content).includes('CANARY_PROJECT_OLD')));
    assert(capsules.every(c=>c.length===1),'exactly one capsule per provider request');
    assert.deepEqual(capsules[0],capsules[1],'capsule changed inside one logical user turn');
  }
  const persisted=JSON.stringify(manager.getBranch());assert(!persisted.includes('mybuddy.context-capsule'));assert(!persisted.includes('CANARY_PROJECT_OLD'));assert.equal(memory.listTurns().length,0,'context projection must not create L0/L1 records');
  const before=sent.length;await session.prompt('Recall calibration reference again.');assert.equal(sent.length,before+1);
  const next=JSON.stringify(sent.at(-1));
  if(mutation==='update'){assert(next.includes('CANARY_PROJECT_NEW'));assert(!next.includes('CANARY_PROJECT_OLD'));
  }else if(mutation==='forget'){assert(!next.includes('CANARY_PROJECT_OLD'));
  }else if(mutation==='detach'){assert(!next.includes('CANARY_WORKSPACE'));assert(!next.includes('CANARY_PROJECT_OLD'));assert(next.includes('CANARY_GLOBAL'));}
  if(compact){const count=memory.stats().total;await session.compact();assert(summaryCalls>0);assert.equal(memory.stats().total,count,'native compaction must not create memory');assert(!JSON.stringify(manager.getBranch()).includes('mybuddy.context-capsule'));}
  results.push({name,passed:true,providerRequests:sent.length,blockedBeforeProvider:denied,summaryCalls,projectionResolutions:projectionLogs.length});console.log('PASS '+name);
 }catch(e){results.push({name,passed:false,error:String(e)});console.error('FAIL '+name+': '+e);}finally{session?.dispose();db.close();rmSync(root,{recursive:true,force:true});}
}
await scenario('scope isolation, per-turn capsule and native compaction exclusion','none',true);
await scenario('current turn frozen; updated L1 visible next turn','update');
await scenario('forget blocks next request and never resurrects next turn','forget');
await scenario('detached task loses old project and workspace immediately','detach');

type LifecycleMutation = 'update' | 'resolve' | 'supersede' | 'supersede-update'
  | 'forget' | 'invalid' | 'expiry' | 'future' | 'scope-detach' | 'disabled'
  | 'supersede-expiry' | 'supersede-natural-expiry'
  | 'dismiss-scenario' | 'dismiss-profile' | 'delete-scenario' | 'delete-profile';

/** Another task retires shared evidence between this task's tool result and next request. */
async function sharedLifecycle(mutation: LifecycleMutation, derived: 'none' | 'scenario' | 'profile' = 'none') {
  const name = `shared ${derived} evidence: ${mutation}`;
  const root = mkdtempSync(join(tmpdir(), 'memory-shared-lifecycle-'));
  const db = new AppDatabase(':memory:');
  const originalNow = Date.now;
  const startedAt = originalNow();
  let clockOffset = 0;
  Date.now = () => startedAt + clockOffset;
  let session: Awaited<ReturnType<typeof createAgentSession>>['session'] | undefined;
  try {
    for (const id of ['reader', 'writer']) db.upsertTask({ id, title: id, updatedAt: Date.now() });
    const memory = new MemoryService(db, { semantic: false });
    const otherTaskMemory = new MemoryService(db, { semantic: false });
    const atom = otherTaskMemory.create({
      scopeType: 'global', kind: 'fact', title: 'Shared calibration reference',
      content: 'SHARED_GLOBAL_OLD', sourceTaskId: 'writer', sourceType: 'user', explicit: true,
      validUntil: mutation === 'supersede-natural-expiry' ? startedAt + 60_000 : undefined,
    });
    if (mutation === 'scope-detach') otherTaskMemory.promote(atom.id, 'task', 'writer');
    const scope = { scopeType: 'global' as const };
    const scene = derived === 'none' ? undefined : memory.cognition.projections.replaceScenarios(scope, [{
      title: 'Shared calibration scene', summary: 'SHARED_GLOBAL_OLD DERIVED_SCENE', sourceMemoryIds: [atom.id],
    }])[0];
    const profile = derived !== 'profile' ? undefined : memory.cognition.projections.replaceCoreProfile(scope, {
      title: 'Shared calibration profile', content: 'SHARED_GLOBAL_OLD DERIVED_PROFILE', sourceScenarioIds: [scene!.id],
    });
    let enabled = true;
    let captureGuard: (() => () => void) | undefined;
    const sent: Context[] = [];
    const denied: string[] = [];
    let mutated = false;
    const mutate = () => {
      clockOffset = 1000;
      if (mutation.startsWith('supersede')) {
        otherTaskMemory.supersede(atom.id, {
          scopeType: 'global', kind: 'fact', title: 'Shared calibration reference',
          content: 'SHARED_GLOBAL_NEW', sourceTaskId: 'writer', sourceType: 'user', explicit: true,
        });
      }
      if (mutation === 'update') otherTaskMemory.update({ id: atom.id, content: 'SHARED_GLOBAL_NEW' });
      if (mutation === 'resolve') otherTaskMemory.resolve(atom.id, 'agent');
      if (mutation === 'supersede-update') otherTaskMemory.update({ id: atom.id, importance: 2 });
      if (mutation === 'forget') otherTaskMemory.forget(atom.id);
      if (mutation === 'invalid') otherTaskMemory.update({ id: atom.id, status: 'invalid' });
      if (mutation === 'expiry' || mutation === 'supersede-expiry') {
        otherTaskMemory.update({ id: atom.id, validUntil: Date.now() - 1 });
      }
      if (mutation === 'future') otherTaskMemory.update({ id: atom.id, validFrom: Date.now() + 60_000 });
      if (mutation === 'supersede-natural-expiry') clockOffset = 120_000;
      if (mutation === 'scope-detach') otherTaskMemory.detachScope(atom.id, 'global');
      if (mutation === 'disabled') enabled = false;
      if (mutation === 'dismiss-scenario') otherTaskMemory.dismissProjection(scene!.id, 'scenario');
      if (mutation === 'dismiss-profile') otherTaskMemory.dismissProjection(profile!.id, 'profile');
      if (mutation === 'delete-scenario') otherTaskMemory.deleteProjectionRecords({ kind: 'scenario', targetIds: [scene!.id] });
      if (mutation === 'delete-profile') otherTaskMemory.deleteProjectionRecords({ kind: 'profile', targetIds: [profile!.id] });
    };
    const projection = new EphemeralContextProjection({
      memory, enabled: () => enabled, scope: () => ({ taskId: 'reader' }), supplementalEvidence: () => [],
      registerRequestGuard: (_, capture) => { captureGuard = capture; }, log: () => {},
    });
    const runtime = {
      hasConfiguredAuth: () => true, getAuth: async () => ({ auth: { apiKey: 'fixture-only' } }), getModel: () => model,
      streamSimple: (_model: unknown, context: Context) => {
        const stream = createAssistantMessageEventStream();
        let message: AssistantMessage;
        try {
          captureGuard!()();
          sent.push(structuredClone(context));
          message = mutated ? response([{ type: 'text', text: 'COMPLETED' }])
            : response([{ type: 'toolCall', id: 'other-task-change', name: 'fixture_tool', arguments: {} }], 'toolUse');
        } catch (error) {
          denied.push(String(error));
          message = response([], 'error', String(error));
        }
        if (message.stopReason === 'error') stream.push({ type: 'error', reason: 'error', error: message });
        else stream.push({ type: 'done', reason: message.stopReason as 'stop' | 'toolUse', message });
        stream.end();
        return stream;
      },
    } as unknown as ModelRuntime;
    const manager = SessionManager.inMemory(root);
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0 } });
    const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
      noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, extensionFactories: [projection.extension] });
    await loader.reload();
    session = (await createAgentSession({ cwd: root, agentDir: root, model, modelRuntime: runtime,
      settingsManager: settings, sessionManager: manager, resourceLoader: loader, noTools: 'builtin', customTools: [{
        name: 'fixture_tool', label: 'Concurrent task', description: 'Allow the other task to update shared memory',
        parameters: Type.Object({}), execute: async () => {
          await Promise.resolve();
          mutate(); mutated = true;
          return { content: [{ type: 'text' as const, text: 'Other task finished its memory operation.' }], details: {} };
        },
      }] })).session;
    projection.attach(session);
    await session.bindExtensions({ mode: 'rpc' });
    await session.prompt('Recall shared calibration reference.');
    assert(session.isIdle);
    assert(mutated, 'reader did not reach the concurrent task change');
    assert(JSON.stringify(sent[0]).includes('SHARED_GLOBAL_OLD'), 'shared memory was not selected');
    if (derived !== 'none') assert(JSON.stringify(sent[0]).includes(derived === 'profile' ? 'DERIVED_PROFILE' : 'DERIVED_SCENE'));
    const soft = ['update', 'resolve', 'supersede', 'supersede-update'].includes(mutation);
    assert.equal(denied.length, soft ? 0 : 1, JSON.stringify(denied));
    assert.equal(sent.length, soft ? 2 : 1, 'unexpected provider request after the source changed');
    if (soft) {
      const capsules = sent.map(context => context.messages.filter(message => JSON.stringify(message.content).includes('SHARED_GLOBAL_OLD')));
      assert.deepEqual(capsules[1], capsules[0], 'ordinary lifecycle changes must preserve the current turn snapshot');
    }
    assert(!JSON.stringify(manager.getBranch()).includes('SHARED_GLOBAL_OLD'), 'capsule persisted into canonical history');
    assert.equal(memory.listTurns().length, 0);
    const before = sent.length;
    await session.prompt('Recall shared calibration reference again.');
    assert.equal(sent.length, before + 1, 'a fresh turn must recover without the retired source');
    const next = JSON.stringify(sent.at(-1));
    if (!mutation.startsWith('dismiss-') && !mutation.startsWith('delete-')) assert(!next.includes('SHARED_GLOBAL_OLD'));
    if (mutation === 'update' || mutation.startsWith('supersede')) assert(next.includes('SHARED_GLOBAL_NEW'));
    if (derived !== 'none') {
      assert(!next.includes('DERIVED_PROFILE'), 'stale or revoked profile survived a fresh turn');
      if (mutation !== 'dismiss-profile' && mutation !== 'delete-profile') {
        assert(!next.includes('DERIVED_SCENE'), 'stale or revoked scene survived a fresh turn');
      }
    }
    results.push({ name, passed: true, providerRequests: sent.length, blockedBeforeProvider: denied.length });
    console.log('PASS ' + name);
  } catch (error) {
    results.push({ name, passed: false, error: String(error) });
    console.error('FAIL ' + name + ': ' + error);
  } finally {
    session?.dispose(); db.close(); Date.now = originalNow;
    rmSync(root, { recursive: true, force: true });
  }
}

for (const derived of ['none', 'scenario', 'profile'] as const) {
  for (const mutation of ['update', 'resolve', 'supersede', 'forget', 'invalid'] as const) await sharedLifecycle(mutation, derived);
}
for (const mutation of ['supersede-update', 'expiry', 'future', 'scope-detach', 'disabled', 'supersede-expiry', 'supersede-natural-expiry'] as const) await sharedLifecycle(mutation);
for (const mutation of ['dismiss-scenario', 'dismiss-profile', 'delete-scenario', 'delete-profile'] as const) await sharedLifecycle(mutation, 'profile');
mkdirSync('artifacts/pi0992-memory',{recursive:true});writeFileSync('artifacts/pi0992-memory/memory-capsule-results.json',JSON.stringify({at:new Date().toISOString(),results,passed:results.every(r=>r.passed)},null,2));process.exitCode=results.every(r=>r.passed)?0:1;
