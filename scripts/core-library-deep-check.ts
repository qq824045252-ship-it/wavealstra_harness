import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AppDatabase, CURRENT_DATABASE_SCHEMA_VERSION } from "../src/main/db/AppDatabase";
import { initializeCoreDatabase, shutdownCoreWorker } from "../src/main/platform/core-client";
import { createLibraryExtension } from "../src/main/library/library-extension";
import { LibraryService } from "../src/main/library/LibraryService";

const root = mkdtempSync(join(tmpdir(), "mybuddy-library-deep-"));
const exe = resolve(process.argv[2] ?? "out/native/linux-x64/mybuddy-runtime-audit");
const path = join(root, "app.duckdb");
await initializeCoreDatabase(exe, root, path, CURRENT_DATABASE_SCHEMA_VERSION);
const open = () => AppDatabase.open(path, {runtimeAuditExecutable:exe, runtimeAuditSupervised:true});
const db = await open();
const close = async () => {
  await db.runtimeAuditReader?.close();
  db.close();
  await shutdownCoreWorker(root,path);
};
try {
  const library = new LibraryService(db,{libraryRoot:join(root,"library")});
  for (const id of ["owned","foreign"]) {
    await db.writeWorkspaceUpsert({id,name:id});
    assert.deepEqual(await db.runtimeAuditReader!.batch3Write({kind:"libraryInsertSpace",id:id+"-docs",workspaceId:id,
      name:id,spaceKind:"team",createdAt:1,updatedAt:1}),{ok:true});
  }
  const add = (space:string,title:string,content:string)=>library.createItemAsync({spaceId:space+"-docs",kind:"markdown",title,content});
  const seed=await add("owned","Index","Norlite refers to Quartz-Spec.");
  const bridge=await add("owned","Policy","Quartz-Spec coverage is three years. 测试");
  await add("foreign","Private","Norlite Quartz-Spec foreign private evidence.");
  const request={query:"Norlite",owner:{type:"workspace" as const,workspaceId:"owned"}};
  const score:import("../src/main/library/LibraryDeepSearch").LibraryEvidenceJudge =
    async ({candidates},_signal,validate)=>{
      await validate();
      assert(!candidates.some(p=>p.text.includes("foreign private")));
      return JSON.stringify({judgments:candidates.map(({id})=>({id,score:3}))});
    };
  await db.writeTaskRecord({id:"deep-task",title:"Research",spaceId:"owned",updatedAt:1});
  let moveTask = false;
  const tools = new Map<string,{execute:(id:string,args:{query:string})=>Promise<{isError?:boolean;content:{text:string}[]}>}>();
  await createLibraryExtension({service:library,taskId:"deep-task",resolveProjectId:()=>"untrusted-project",
    resolveEvidenceJudge:async()=>async(input,signal,validate)=>{
      if (moveTask) {
        await db.writeTaskRecord({id:"deep-task",title:"Research",spaceId:"foreign",updatedAt:2});
        await validate();
        throw new Error("scope guard did not block reassignment");
      }
      return score(input,signal,validate);
    }} )({registerTool:(tool:{name:string;execute:never})=>tools.set(tool.name,tool)} as never);
  const taskSearch=()=>tools.get("library_deep_search")!.execute("check",{query:"Norlite"});
  const initial=await taskSearch();
  assert(!initial.isError && initial.content[0].text.includes(bridge.id));
  moveTask=true;
  const changed=await taskSearch();
  assert(changed.isError && changed.content[0].text.includes("资料范围或索引已变化"));
  const result=await library.deepSearchOwnedScope(request,async()=>score);
  const hit=result.hits.find(row=>row.itemId===bridge.id);
  assert(hit && hit.round>1,"term frequencies expand into a second scoped document");
  const read=async(owner:typeof request.owner)=> library.readScopedEvidence({...request,owner,itemId:hit.itemId,source:hit.source});
  assert.equal((await read(request.owner)).text,hit.text);
  await assert.rejects(read({type:"workspace",workspaceId:"foreign"}));
  await library.writeContentAsync({id:bridge.id,content:"a changed policy"});
  await assert.rejects(read(request.owner));
  await assert.rejects(library.deepSearchOwnedScope(request,async()=>async(_input,_signal,validate)=>{
    await library.deleteItemAsync(seed.id);
    await validate();
    throw new Error("guard should have rejected the withdrawn evidence");
  }),/资料范围或索引已变化/);
  assert.equal(existsSync(join(root,"app.db")),false);
  console.log("PASS scoped deep search: chunk lookup, term expansion, scoped evidence, Pi task scope reassignment, edited source and pre-dispatch withdrawal");
} finally {
  await close();
  rmSync(root,{recursive:true,force:true});
}
