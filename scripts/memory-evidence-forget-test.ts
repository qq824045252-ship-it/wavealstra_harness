import assert from 'node:assert/strict';
import { AppDatabase } from '../src/main/db/AppDatabase';
import { BotRegistry } from '../src/main/agent/work/BotRegistry';
import { BotConversationRepository } from '../src/main/agent/work/BotConversationRepository';
import { BotConversationMemory } from '../src/main/agent/work/BotConversationMemory';
import { createMemoryExtension } from '../src/main/memory/memory-extension';
import { MemoryGatewayService } from '../src/main/memory/MemoryGatewayService';
import { MemoryService } from '../src/main/memory/MemoryService';
import { MemoryPipelineManager } from '../src/main/memory/MemoryPipelineManager';
import { MemoryForgetWatermarks } from '../src/main/memory/MemoryForgetWatermarks';
import { botHistoryContext } from '../src/main/agent/work/BotHistoryContext';
import { LOCAL_USER_ID } from '../src/shared/bot-work';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
const db = new AppDatabase(':memory:');
try {
  new BotRegistry(db.connection).registerBot({ botId:'owner',userId:LOCAL_USER_ID,displayName:'Owner' });
  const memory = new MemoryService(db,{semantic:false}), pipeline = new MemoryPipelineManager(db);
  const messages = new BotConversationRepository(db.connection);
  const bridge = new BotConversationMemory({db,userId:LOCAL_USER_ID,memory,pipeline,enabled:()=>true,extract:async()=>{},changed:()=>{}});
  const raw='请长期记住本Bot两条独立测试事实：AsterPreference 的标记是 紫杉7319；HeliosCalibration 的标记是 青丘8264。分别保存，不要共享给其他Bot。';
  const r=messages.accept(LOCAL_USER_ID,{botId:'owner',requestId:'original',text:raw});
  messages.update(r.assistantMessageId,'completed','已保存紫杉7319和青丘8264');bridge.capture('owner',r.requestId);
  const common={kind:'fact' as const,scopeType:'bot' as const,scopeId:'owner',sourceType:'user' as const,explicit:true,
    evidence:[{evidenceKind:'conversation' as const,refId:r.conversationId,excerpt:raw}]};
  const a=memory.create({...common,title:'AsterPreference 标记',content:'AsterPreference 的标记是 紫杉7319。（长期测试事实，仅存于本 Bot 专属记忆，不共享给其他 Bot）'});
  const b=memory.create({...common,title:'HeliosCalibration 标记',content:'HeliosCalibration 的标记是 青丘8264。（长期测试事实，仅存于本 Bot 专属记忆，不共享给其他 Bot）'});
  const request={botId:'owner',scopeTypes:['bot' as const],includeInherited:false,query:'HeliosCalibration',limit:20};
  assert(JSON.stringify(memory.search(request)).includes('紫杉7319'),'positive precondition: wide evidence really contains A');
  let entered=()=>{},release=()=>{};
  const started=new Promise<void>(resolve=>{entered=resolve;});
  const gate=new Promise<void>(resolve=>{release=resolve;});
  const modelRuntime={completeSimple:async()=>{entered();await gate;return ({stopReason:'stop',content:[{type:'text',text:JSON.stringify({candidates:[{
    kind:'fact',title:'AsterPreference 标记',content:a.content,scopeType:'bot',confidence:1,importance:1,explicit:true,
    operationHint:'create',retention:'stable',sensitivity:'none',userEvidence:'AsterPreference 的标记是 紫杉7319'}]})}]});}} as unknown as ModelRuntime;
  const pendingExtraction=memory.extractAndStore({taskId:r.conversationId,sourceTurns:pipeline.turns.listPending(r.conversationId,50).filter(t=>t.userMessageId===r.userMessageId),userText:'',assistantText:'',
    modelRuntime,model:{maxTokens:4096} as never,isEnabled:()=>true});
  await started;
  const deleted=messages.accept(LOCAL_USER_ID,{botId:'owner',requestId:'forget',text:'忘记 AsterPreference 这条记忆。'});
  const user=messages.message(deleted.userMessageId)!;
  bridge.forget('owner',[a.id],user.text,user.text,deleted.conversationId,{createdAt:user.createdAt,messageId:user.messageId});
  messages.update(deleted.assistantMessageId,'completed','已忘记');bridge.capture('owner',deleted.requestId);
  for(const hits of [memory.search(request),await memory.searchHybrid(request)]) {
    assert(hits.some(hit=>hit.memory.id===b.id),'retained B remains searchable');
    assert(JSON.stringify(hits).includes('青丘8264'));
    assert(!JSON.stringify(hits).includes('紫杉7319'),'forgotten A cannot ride along in B evidence');
  }
  (memory as unknown as {semantic:unknown}).semantic={search:async()=>[{memoryId:b.id,contentHash:b.contentHash,score:1}]};
  const fused=await memory.searchHybrid(request);
  assert(fused.some(hit=>hit.memory.id===b.id));assert(!JSON.stringify(fused).includes('紫杉7319'),'semantic fused DTO uses the same evidence projection');
  (memory as unknown as {semantic:unknown}).semantic=undefined;
  assert(memory.get(b.id)?.evidence[0].excerpt?.includes('紫杉7319'),'stored audit excerpt is not destructively rewritten');
  const projection=botHistoryContext(db.connection,{userId:LOCAL_USER_ID,botId:'owner',query:'HeliosCalibration',before:Date.now()+1000});
  assert(projection.includes('青丘8264'),'B history remains usable');
  assert(!projection.includes('紫杉7319'),'source history also redacted, not only tool DTO');
  const revocations=new MemoryForgetWatermarks(db.connection);
  const safe=revocations.sourceFilter([{scopeType:'bot',scopeId:'owner'}])(raw,'已保存紫杉7319和青丘8264',0);
  assert(safe.userText.includes('青丘8264'));assert(!safe.userText.includes('紫杉7319'));assert.equal(safe.assistantText,'');
  release();
  const result=await pendingExtraction;
  assert.equal(result.committedCount,0,'late extraction of revoked literal A must not revive it');
  assert.equal((db.connection.prepare('SELECT count(*) n FROM memory_forget_watermarks').get() as {n:number}).n,0,'no coarse cutoff workaround');
  console.log('PASS wide evidence + model annotation: sync/hybrid recall, source history, late extraction, B retention');

  // Generic titles are not revocation selectors; equal category titles retain B.
  const genericA=memory.create({...common,title:'回复偏好',content:'先给结论。（长期）',evidence:[{evidenceKind:'conversation',refId:r.conversationId,excerpt:'我的回复偏好：先给结论；我的回复偏好：使用中文'}]});
  const genericB=memory.create({...common,title:'回复偏好',content:'使用中文',evidence:[{evidenceKind:'conversation',refId:r.conversationId,excerpt:'我的回复偏好：先给结论；我的回复偏好：使用中文'}]});
  memory.forget(genericA.id);
  const generic=memory.search({...request,query:'使用中文'});
  assert(generic.some(hit=>hit.memory.id===genericB.id));assert(!JSON.stringify(generic).includes('先给结论'));
  assert(JSON.stringify(generic).includes('使用中文'));
  console.log('PASS generic equal titles do not revoke independent B evidence');
  const sharedEvidence='AlphaSetting 的值是蓝色；BetaSetting 的值是蓝色；不共享给其他Bot';
  const identityA=memory.create({...common,title:'AlphaSetting 值',content:'AlphaSetting 的值是蓝色。（长期，不共享给其他Bot）',
    evidence:[{evidenceKind:'conversation',refId:r.conversationId,excerpt:sharedEvidence}]});
  memory.forget(identityA.id);
  const identitySafe=revocations.sourceFilter([{scopeType:'bot',scopeId:'owner'}])(sharedEvidence,'',0).userText;
  assert(!identitySafe.includes('AlphaSetting'));assert(identitySafe.includes('BetaSetting 的值是蓝色'));assert(identitySafe.includes('不共享给其他Bot'));
  const wrapped=memory.create({...common,title:'Wrapper B',content:'B-only retained',evidence:[{evidenceKind:'conversation',refId:r.conversationId,
    excerpt:'用户：'+raw+'\n助手：A是紫杉7319，B是青丘8264'}]});
  // Set original evidence time before the deletion: a later new statement is not retroactively forgotten.
  db.connection.prepare('UPDATE memory_evidence SET created_at=0 WHERE memory_id=?').run(wrapped.id);
  const projected=memory.search({...request,query:'Wrapper'});
  assert(projected.some(hit=>hit.memory.id===wrapped.id));assert(!JSON.stringify(projected).includes('紫杉7319'));assert(JSON.stringify(projected).includes('青丘8264'));
  console.log('PASS equal values with distinct identities, retention notes, wrapped user/assistant evidence');
  const now=Date.now();
  for(const id of ['p-owner','p-other']) db.connection.prepare('INSERT INTO projects(id,name,created_at,updated_at,archived,resource_budget_chars) VALUES(?,?,?,?,0,128000)').run(id,id,now,now);
  db.upsertTask({id:'t-owner',title:'owner',projectId:'p-owner',status:'in_progress',updatedAt:now});
  db.upsertTask({id:'t-other',title:'other',projectId:'p-other',status:'in_progress',updatedAt:now});
  const projectCommon={...common,scopeType:'project' as const,scopeId:'p-owner'};
  const pa=memory.create({...projectCommon,title:a.title,content:a.content});
  const pb=memory.create({...projectCommon,title:b.title,content:b.content});
  memory.forget(pa.id);
  assert(memory.get(pb.id)?.evidence[0].excerpt?.includes('紫杉7319'),'audit get preserves original evidence');
  assert(!JSON.stringify(memory.getForRecall(pb.id,{taskId:'t-owner'})).includes('紫杉7319'));
  assert.equal(memory.getForRecall(pb.id,{taskId:'t-other'}),undefined,'project scope remains closed');
  const registered=new Map<string,{execute:(...args:any[])=>Promise<any>}>();
  createMemoryExtension({taskId:'t-owner',service:memory})({registerTool:(tool:any)=>registered.set(tool.name,tool)} as never);
  const tool=await registered.get('memory_get')!.execute('call',{id:pb.id});
  assert(!tool.isError);assert(!JSON.stringify(tool).includes('紫杉7319'));assert(JSON.stringify(tool).includes('青丘8264'));
  const deniedTools=new Map<string,{execute:(...args:any[])=>Promise<any>}>();
  createMemoryExtension({taskId:'t-other',service:memory})({registerTool:(tool:any)=>deniedTools.set(tool.name,tool)} as never);
  assert((await deniedTools.get('memory_get')!.execute('call',{id:pb.id})).isError);
  const gateway=new MemoryGatewayService(db,memory,{writeEnabled:false});
  const remote=gateway.get({taskId:'t-owner',id:pb.id});
  assert(!JSON.stringify(remote).includes('紫杉7319'));assert(JSON.stringify(remote).includes('青丘8264'));
  assert.throws(()=>gateway.get({taskId:'t-other',id:pb.id}));
  console.log('PASS real extension memory_get and Gateway get: projected evidence and unchanged scope denial');
  const oldTurn=db.connection.prepare('SELECT id FROM memory_turns WHERE user_message_id=?').get(r.userMessageId) as {id:string};
  db.connection.prepare('UPDATE memory_turns SET captured_at=? WHERE id=?').run(Date.now()+10000,oldTurn.id);
  const lateEvidence=memory.create({...common,title:'LateEvidence B',content:'B retained after delayed evidence insertion',
    evidence:[{evidenceKind:'conversation',refId:oldTurn.id,excerpt:raw}]});
  const lateDto=memory.getForRecall(lateEvidence.id,request)!;
  assert(lateDto.evidence.length>0);assert(JSON.stringify(lateDto).includes('青丘8264'));assert(!JSON.stringify(lateDto).includes('紫杉7319'));
  console.log('PASS late L0 capture uses original Bot message time, not later evidence insertion time');
} finally { db.close(); }
