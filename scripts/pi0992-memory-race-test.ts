import assert from "node:assert/strict";
import { mkdirSync, writeFileSync } from "node:fs";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { MemoryService } from "../src/main/memory/MemoryService";
import { MemorySemanticProvider } from "../src/main/memory/MemorySemanticProvider";
import { SEMANTIC_DIMENSION } from "../src/main/retrieval/SemanticModelManager";

const results: Array<{name:string;passed:boolean;error?:string}> = [];
function deferred<T>() { let resolve!: (v:T)=>void, reject!: (e:unknown)=>void; const promise=new Promise<T>((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}; }
async function test(name:string, fn:()=>Promise<void>) { try{await fn();results.push({name,passed:true});console.log('PASS '+name);}catch(e){results.push({name,passed:false,error:String(e)});console.error('FAIL '+name+': '+e);} }
function fixture(){
 const db=new AppDatabase(':memory:');
 db.createSpace({id:'ws-a',name:'A'});db.createSpace({id:'ws-b',name:'B'});
 const insert=db.connection.prepare('INSERT INTO projects (id,name,created_at,updated_at,archived,resource_budget_chars) VALUES (?,?,?,?,0,128000)');
 insert.run('proj-a','A',Date.now(),Date.now());insert.run('proj-b','B',Date.now(),Date.now());
 db.upsertTask({id:'task-a',title:'Race fixture',spaceId:'ws-a',projectId:'proj-a',updatedAt:Date.now()});
 const memory=new MemoryService(db,{semantic:false});
 const atom=memory.create({kind:'fact',title:'Calibration reference cobalt',content:'Calibration reference cobalt is 17.',scopeType:'project',scopeId:'proj-a',explicit:true,sourceType:'user'});
 return {db,memory,atom};
}
async function race(mutation:string, action:(f:ReturnType<typeof fixture>)=>void, rejectSemantic=false){
 const f=fixture(),gate=deferred<Array<{memoryId:string;score:number}>>();
 (f.memory as any).semantic={search:()=>gate.promise,index:async()=>{}};
 try{const pending=f.memory.searchHybrid({taskId:'task-a',query:'Calibration reference cobalt',limit:10});action(f);if(rejectSemantic)gate.reject(Error('intentional fixture outage'));else gate.resolve([{memoryId:f.atom.id,score:0.99}]);const hits=await pending;assert(!hits.some(h=>h.memory.id===f.atom.id),mutation+' returned a revoked/stale atom');}finally{f.db.close();}
}
await test('forget during hybrid recall cannot return cached lexical content',()=>race('forget',f=>f.memory.forget(f.atom.id)));
await test('supersede during hybrid recall cannot return old active atom',()=>race('supersede',f=>{f.memory.supersede(f.atom.id,{kind:'fact',title:'Replacement',content:'The new value is 22.',scopeType:'project',scopeId:'proj-a',explicit:true});}));
await test('task move during hybrid recall revokes old project visibility',()=>race('task move',f=>{f.db.connection.prepare('UPDATE tasks SET project_id=?,space_id=? WHERE id=?').run('proj-b','ws-b','task-a');}));
await test('scope detachment during hybrid recall cannot leak from promoted copy',()=>race('scope detach',f=>{f.memory.promote(f.atom.id,'project','proj-b');f.memory.detachScope(f.atom.id,'project','proj-a');}));
await test('validity expiry during hybrid recall is enforced at return',()=>race('expiry',f=>{f.memory.update({id:f.atom.id,validUntil:Date.now()-1});}));
await test('semantic failure fallback must not resurrect a forgotten lexical hit',()=>race('error fallback',f=>f.memory.forget(f.atom.id),true));
await test('updated memory content is refreshed after asynchronous search',async()=>{const f=fixture(),gate=deferred<any[]>();(f.memory as any).semantic={search:()=>gate.promise,index:async()=>{}};try{const pending=f.memory.searchHybrid({taskId:'task-a',query:'Calibration reference cobalt',limit:10});f.memory.update({id:f.atom.id,content:'Calibration reference cobalt is now 29.'});gate.resolve([]);const hits=await pending;assert.equal(hits.find(h=>h.memory.id===f.atom.id)?.memory.content,'Calibration reference cobalt is now 29.');}finally{f.db.close();}});
await test('slower old embedding must not overwrite newer revision',async()=>{const f=fixture(),old=deferred<Float32Array>();let calls=0;const provider=Object.create(MemorySemanticProvider.prototype) as MemorySemanticProvider;Object.assign(provider,{db:f.db,runtime:{embed:()=>++calls===1?old.promise:Promise.resolve(new Float32Array(SEMANTIC_DIMENSION).fill(0.25))}});try{const pending=provider.index(f.atom);const current=f.memory.update({id:f.atom.id,content:'Calibration reference cobalt is now 33.'});await provider.index(current);old.resolve(new Float32Array(SEMANTIC_DIMENSION).fill(0.5));await pending;const row=f.db.connection.prepare('SELECT content_hash FROM memory_embeddings WHERE memory_id=?').get(f.atom.id) as any;assert.equal(row.content_hash,current.contentHash);}finally{f.db.close();}});
await test('forget while embedding is pending does not recreate index or throw',async()=>{const f=fixture(),gate=deferred<Float32Array>();const provider=Object.create(MemorySemanticProvider.prototype) as MemorySemanticProvider;Object.assign(provider,{db:f.db,runtime:{embed:()=>gate.promise}});try{const pending=provider.index(f.atom);f.memory.forget(f.atom.id);gate.resolve(new Float32Array(SEMANTIC_DIMENSION));await pending;assert.equal((f.db.connection.prepare('SELECT count(*) AS n FROM memory_embeddings WHERE memory_id=?').get(f.atom.id) as any).n,0);}finally{f.db.close();}});
await test('task move during extraction cannot commit evidence into old project',async()=>{const f=fixture(),gate=deferred<any>();const user='Remember: this project uses cobalt calibration.';try{const pending=f.memory.extractAndStore({taskId:'task-a',spaceId:'ws-a',model:{} as any,modelRuntime:{completeSimple:()=>gate.promise} as any,userText:user,assistantText:'',isEnabled:()=>true});f.db.connection.prepare('UPDATE tasks SET project_id=?,space_id=? WHERE id=?').run('proj-b','ws-b','task-a');gate.resolve({stopReason:'stop',content:[{type:'text',text:JSON.stringify({candidates:[{kind:'decision',title:'Project cobalt calibration',content:'This project uses cobalt calibration.',scopeType:'project',confidence:1,importance:2,explicit:true,operationHint:'create',userEvidence:user}]})}]});try{await pending;}catch(e){assert.match(String(e),/scope|范围|绑定|上下文/i);}assert.equal(f.memory.list().length,1,'old project extraction committed after task changed');}finally{f.db.close();}});
mkdirSync('artifacts/pi0992-memory',{recursive:true});writeFileSync('artifacts/pi0992-memory/memory-race-results.json',JSON.stringify({at:new Date().toISOString(),results,passed:results.every(r=>r.passed)},null,2));process.exitCode=results.every(r=>r.passed)?0:1;
