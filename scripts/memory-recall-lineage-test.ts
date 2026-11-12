import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppDatabase } from '../src/main/db/AppDatabase';
import { BotRegistry } from '../src/main/agent/work/BotRegistry';
import { BotConversationRepository } from '../src/main/agent/work/BotConversationRepository';
import { BotConversationMemory } from '../src/main/agent/work/BotConversationMemory';
import { botHistoryContext } from '../src/main/agent/work/BotHistoryContext';
import { projectBotMemoryHistory } from '../src/main/agent/work/BotMemoryHistoryProjection';
import { MemoryService } from '../src/main/memory/MemoryService';
import { MemoryPipelineManager } from '../src/main/memory/MemoryPipelineManager';
import { MemoryRecallLineage } from '../src/main/memory/MemoryRecallLineage';
import { LOCAL_USER_ID } from '../src/shared/bot-work';
const root=mkdtempSync(join(tmpdir(),'recall-lineage-'));
let db=new AppDatabase(join(root,'app.db'));
const setup=()=>{
  new BotRegistry(db.connection).registerBot({botId:'owner',userId:LOCAL_USER_ID,displayName:'Owner'});
  const memory=new MemoryService(db,{semantic:false}), pipeline=new MemoryPipelineManager(db);
  const messages=new BotConversationRepository(db.connection);
  const bridge=new BotConversationMemory({db,userId:LOCAL_USER_ID,memory,pipeline,enabled:()=>true,changed:()=>{},extract:async()=>{}});
  return {memory,pipeline,messages,bridge,lineage:new MemoryRecallLineage(db.connection)};
};
let s=setup(),seq=0;
const begin=(text:string,sources:string[]=[])=>{
  const receipt=s.messages.accept(LOCAL_USER_ID,{botId:'owner',requestId:'r'+(++seq),text});
  db.connection.prepare('INSERT INTO bot_request_runs(message_id,runtime_key,context_json,created_at) VALUES(?,?,?,?)')
    .run(receipt.assistantMessageId,'test-'+receipt.requestId,JSON.stringify({sourceMessageIds:sources}),Date.now());
  return receipt;
};
const finish=(r:ReturnType<typeof begin>,text:string)=>{s.messages.update(r.assistantMessageId,'completed',text);s.bridge.capture('owner',r.requestId);};
const scopes=[{scopeType:'bot' as const,scopeId:'owner'},{scopeType:'global' as const}];
try {
  const original=begin('记住 AsterPreference 的标记是紫杉7319；HeliosCalibration 的标记是青丘8264。');
  finish(original,'已保存。');
  const common={scopeType:'bot' as const,scopeId:'owner',sourceType:'user' as const,kind:'fact' as const,
    evidence:[{evidenceKind:'conversation' as const,refId:original.conversationId,excerpt:'AsterPreference 的标记是紫杉7319；HeliosCalibration 的标记是青丘8264'}]};
  const a=s.memory.create({...common,title:'AsterPreference 标记',content:'AsterPreference 的标记是紫杉7319。'});
  const b=s.memory.create({...common,title:'HeliosCalibration 标记',content:'HeliosCalibration 的标记是青丘8264。'});
  const injected=begin('保存的长期事实有什么用途？');
  assert(s.bridge.context('owner',injected.conversationId,injected.userMessageId).includes('紫杉7319'));
  finish(injected,'稳定事实类信息，如紫杉7319、青丘8264这类标记。');
  assert(s.lineage.snapshot(injected.assistantMessageId)?.records.some(r=>r.id===a.id));
  const searched=begin('查一下AsterPreference。');
  assert((await s.bridge.search('owner','AsterPreference',searched.conversationId,searched.userMessageId)).some(hit=>hit.memory.id===a.id));
  finish(searched,'紫杉7319。');
  const inherited=begin('如果全部忘记会怎样？',[original.userMessageId,original.assistantMessageId]);
  finish(inherited,'例如紫杉7319、青丘8264这些长期信息会失去。');
  const late=begin('回答等会儿再给',[inherited.assistantMessageId]);
  const bOnly=begin('独立B证据');
  assert((await s.bridge.search('owner','HeliosCalibration',bOnly.conversationId,bOnly.userMessageId)).some(hit=>hit.memory.id===b.id));
  // A broad evidence excerpt was actually exposed with B; use a separate source
  // for the equal-value control, rather than pretending that broad read was clean.
  finish(bOnly,'青丘8264。');
  const peer=s.memory.create({scopeType:'bot',scopeId:'owner',sourceType:'user',kind:'fact',title:'OtherEntity',content:'OtherEntity 的标记是紫杉7319。'});
  const independent=begin('独立同值实体');
  s.lineage.record(independent.assistantMessageId,[peer]);finish(independent,'OtherEntity 的值是紫杉7319。');
  const initialMessages=[original,injected,independent].flatMap(r=>[s.messages.message(r.userMessageId)!,s.messages.message(r.assistantMessageId)!]);
  assert(!projectBotMemoryHistory(db.connection,initialMessages,{botId:'owner',conversationId:original.conversationId}).changed,'no withdrawals preserves the native-history fast path');
  const deletion=begin('忘记 AsterPreference 这条记忆。');
  const user=s.messages.message(deletion.userMessageId)!;
  s.bridge.forget('owner',[a.id],user.text,user.text,deletion.conversationId,{createdAt:user.createdAt,messageId:user.messageId});
  finish(deletion,'已删除。');
  for(const r of [injected,searched,inherited,late]) assert(s.lineage.assistantRevoked(r.assistantMessageId,scopes),r.requestId);
  assert(s.lineage.assistantRevoked(bOnly.assistantMessageId,scopes),'B search consumed old broad evidence containing A, not just B record identity');
  assert(!s.lineage.assistantRevoked(independent.assistantMessageId,scopes),'same value, distinct actual dependency remains valid');
  const local=projectBotMemoryHistory(db.connection,initialMessages,{botId:'owner',conversationId:original.conversationId});
  assert(local.changed);assert(local.messages.find(m=>m.messageId===original.userMessageId)!.text.includes('青丘8264'));
  assert(!local.messages.find(m=>m.messageId===original.userMessageId)!.text.includes('紫杉7319'));
  assert(!local.messages.find(m=>m.messageId===injected.assistantMessageId)!.text.includes('紫杉7319'));
  assert(local.messages.find(m=>m.messageId===independent.assistantMessageId)!.text.includes('紫杉7319'),'same value another entity is retained, not value blacklisted');
  assert(s.memory.get(b.id),'independent B L1 retained');
  const history=botHistoryContext(db.connection,{userId:LOCAL_USER_ID,botId:'owner',query:'长期事实',before:Date.now()+1000});
  assert(!history.includes('紫杉7319'),'identity-free derived quotation withheld by provenance');
  finish(late,'迟到答案：紫杉7319。');
  assert(s.lineage.assistantRevoked(late.assistantMessageId,scopes),'late completion timestamp cannot grant fresh evidence');
  console.log('PASS actual host context and search dependencies, frozen source chain, same-value identity, late completion');

  const clean=begin('HeliosCalibration 标记是多少？');
  const stable=s.bridge.context('owner',clean.conversationId,clean.userMessageId);
  assert(stable.includes('青丘8264'));
  // A is gone; unrelated same-value peer must not turn a value-string test into
  // false revocation. The parent batch asserts wire content by ownership.
  finish(clean,'HeliosCalibration 的标记是青丘8264。');
  assert(!s.lineage.assistantRevoked(clean.assistantMessageId,scopes),'newly projected B history does not inherit withdrawn raw A');
  console.log('PASS post-forget sanitized user B projection remains usable');
  const cleanSearch=begin('再查HeliosCalibration');
  await s.bridge.search('owner','HeliosCalibration',cleanSearch.conversationId,cleanSearch.userMessageId);finish(cleanSearch,'青丘8264');
  assert(!s.lineage.assistantRevoked(cleanSearch.assistantMessageId,scopes),'safe evidence actually consumed after deletion stays valid');

  new BotRegistry(db.connection).registerBot({botId:'other',userId:LOCAL_USER_ID,displayName:'Other'});
  const shared=s.memory.create({scopeType:'bot',scopeId:'owner',sourceType:'user',kind:'fact',title:'ScopedNeedle',content:'ScopedNeedle remains available'});
  s.memory.promote(shared.id,'bot','other');
  const scoped=begin('ScopedNeedle');
  await s.bridge.search('owner','ScopedNeedle',scoped.conversationId,scoped.userMessageId);finish(scoped,'ScopedNeedle');
  assert(s.lineage.snapshot(scoped.assistantMessageId)!.records.find(r=>r.id===shared.id)!.scopes.every(scope=>scope.scopeId==='owner'));
  s.memory.detachScope(shared.id,'bot','other');
  assert(!s.lineage.assistantRevoked(scoped.assistantMessageId,scopes),'unrelated Bot binding withdrawal does not revoke owner read');
  s.memory.detachScope(shared.id,'bot','owner');
  assert(s.lineage.assistantRevoked(scoped.assistantMessageId,scopes),'actual authorization withdrawal revokes dependent read');
  console.log('PASS actual consumed scope intersection and other-Bot detach isolation');

  const ids:string[]=[];
  for(let i=0;i<110;i++) {const r=begin('ordinary '+i,ids.slice(-1));finish(r,'ordinary answer');ids.push(r.assistantMessageId);}
  const check=s.lineage.projection(scopes),start=performance.now();
  for(const id of [...ids].reverse()) assert(!check(id));
  const elapsed=performance.now()-start;assert(elapsed<3000,'110-node projection must stay bounded');
  console.log('PASS 110-source batch memoization',JSON.stringify({elapsedMs:elapsed}));
  const malformed=begin('损坏依赖');finish(malformed,'unknown');
  db.connection.prepare("UPDATE bot_request_runs SET context_json=json_set(context_json,'$.memoryRecallDependencies',json(?)) WHERE message_id=?")
    .run(JSON.stringify({version:1,records:[{id:'broken'}],sourceMessageIds:[]}),malformed.assistantMessageId);
  assert(s.lineage.assistantRevoked(malformed.assistantMessageId,scopes),'malformed dependency only withholds this derived answer, not throws');

  const saved=s.lineage.snapshot(injected.assistantMessageId);
  assert(saved?.records.length);
  db.close();db=new AppDatabase(join(root,'app.db'));s=setup();
  db.connection.prepare('DELETE FROM bot_request_runs WHERE message_id=?').run(injected.assistantMessageId);
  assert(s.lineage.assistantRevoked(injected.assistantMessageId,scopes),'L0 metadata retains consumed identities after run cleanup and restart');
  assert(!s.lineage.assistantRevoked(independent.assistantMessageId,scopes));
  console.log('PASS file SQLite reopen, L0 dependency retention, untouched independent source');

  const legacy=s.messages.accept(LOCAL_USER_ID,{botId:'owner',requestId:'legacy',text:'旧问题'});
  finish(legacy,'旧回答没有可查依赖');
  assert.equal(s.lineage.snapshot(legacy.assistantMessageId),undefined);
  assert(!s.lineage.assistantRevoked(legacy.assistantMessageId,scopes),'unknown legacy ancestry is not invented or blanket disabled');
  console.log('PASS explicit legacy-no-provenance boundary (not claimed as reconstructed or verified clean)');
  const whole=begin('忘记全部历史记忆。');const wholeUser=s.messages.message(whole.userMessageId)!;
  s.memory.recordForgetBoundary('bot','owner',wholeUser.createdAt,wholeUser.messageId);
  assert(s.lineage.assistantRevoked(inherited.assistantMessageId,scopes),'legacy/full-scope boundaries also revoke inherited original sources');
  const coarseProjection=projectBotMemoryHistory(db.connection,initialMessages,{botId:'owner',conversationId:original.conversationId});
  assert(coarseProjection.changed);assert(!coarseProjection.messages.some(m=>m.text.includes('紫杉7319')||m.text.includes('青丘8264')));
  console.log('PASS explicit coarse watermark remains authoritative for direct and derived native context');
} finally {db.close();rmSync(root,{recursive:true,force:true});}
