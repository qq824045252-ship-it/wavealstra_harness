import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { WorkExecutionAdapter, type WorkExecutionPort } from "../src/main/agent/work/WorkExecutionAdapter";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkActor, type WorkControlResult } from "../src/shared/bot-work";
const root=await mkdtemp(join(tmpdir(),"work-execution-isolation-"));
const db=new AppDatabase(join(root,"app.db"));
const bots=new BotRegistry(db.connection);bots.ensureDefaultBot(LOCAL_USER_ID);
const service=new WorkService(db.connection,{bots});
const actor:WorkActor={kind:"user",userId:LOCAL_USER_ID,grants:DESKTOP_USER_GRANTS};
const unwrap=(value:WorkControlResult)=>{if(!value.ok)throw Error(value.message);return value.work;};
const make=(name:string)=>{
 const work=unwrap(service.createWork(actor,{operationId:`create:${name}`,title:name,inputSnapshotId:name,authorization:actor.grants}));
 db.upsertTask({id:name,title:name,updatedAt:Date.now(),cwd:root});
 const dispatched=unwrap(service.dispatchExecution(actor,{operationId:`dispatch:${name}`,workId:work.workId,botId:DEFAULT_BOT_ID,taskId:name,durableStoreKey:join(root,name),conversationId:"1",workspaceBinding:root}));
 return service.repo.getBinding(dispatched.activeExecutionIds[0]!)!;
};
const held=make("held-stop"), sibling=make("sibling");
unwrap(service.pauseWork(actor,{operationId:"pause-held",workId:held.workId}));
let release!:()=>void, entered!:()=>void, stopped=false,stopCalls=0;
const gate=new Promise<void>(r=>release=r), started=new Promise<void>(r=>entered=r);
const inspected:string[]=[];const errors:unknown[]=[];
const port:WorkExecutionPort={prepare:async()=>{throw Error("unused");},
 find:async b=>({taskId:b.taskId,operationId:b.operationId,submissionId:1,status:"placed"}),
 submit:async()=>{throw Error("accepted business operation must not be repeated");},
 inspect:async b=>{inspected.push(b.bindingId);return b.bindingId===held.bindingId&&!stopped?{status:"running"}:{status:b.bindingId===held.bindingId?"stopped":"completed",summary:"actual receipt",hasWriteConflicts:false,artifactRefs:[]};},
 stop:async()=>{stopCalls++;entered();await gate;stopped=true;}
};
const adapter=new WorkExecutionAdapter(service,port,LOCAL_USER_ID,()=>true,(_id,e)=>errors.push(e));
let pending:Promise<void>|undefined;
try{
 pending=adapter.flush();await started;
 for(let i=0;i<30&&service.repo.getBinding(sibling.bindingId)?.status!=="completed";i++)await delay(10);
 assert.equal(service.repo.getBinding(sibling.bindingId)?.status,"completed","a pending stop must not prevent another Work from ingesting its completed receipt");
 const late=make("late-sibling");const second=adapter.flush();
 for(let i=0;i<30&&service.repo.getBinding(late.bindingId)?.status!=="completed";i++)await delay(10);
 assert.equal(service.repo.getBinding(late.bindingId)?.status,"completed","later wakes must admit new independent Work while the original stop remains pending");
 assert.equal(stopCalls,1,"overlapping wakes must not run the same stop concurrently");
 release();await Promise.all([pending,second]);await adapter.flush();
 assert.equal(service.repo.getBinding(held.bindingId)?.status,"stopped");
 assert.equal(service.repo.listDeliverables(sibling.workId).length,1);
 assert.equal(service.repo.listDeliverables(late.workId).length,1);
 assert.deepEqual(errors,[]);
 console.log("PASS blocked native stop does not strand independent or newly admitted Work; per-Work stop and results remain single-flight");
}finally{release();await pending?.catch(()=>{});await adapter.close();db.close();await rm(root,{recursive:true,force:true});}
