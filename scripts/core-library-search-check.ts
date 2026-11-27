import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AppDatabase, CURRENT_DATABASE_SCHEMA_VERSION } from "../src/main/db/AppDatabase";
import { initializeCoreDatabase, shutdownCoreWorker } from "../src/main/platform/core-client";
import { LibraryService } from "../src/main/library/LibraryService";
import { WorkspaceSemanticProvider, SEMANTIC_DIMENSION, SEMANTIC_MODEL_ID, SEMANTIC_MODEL_VERSION } from "../src/main/retrieval/WorkspaceSemanticProvider";
import { writeMaterialRetrievalSettings } from "../src/main/library/MaterialRetrievalSettings";

const root = await mkdtemp(join(tmpdir(), "mybuddy-core-search-"));
process.env.HOME = root;
process.env.USERPROFILE = root;
const exe = resolve(process.argv[2] ?? "out/native/linux-x64/mybuddy-runtime-audit");
const path = join(root,"app.duckdb");
await initializeCoreDatabase(exe,root,path,CURRENT_DATABASE_SCHEMA_VERSION);
const db = await AppDatabase.open(path,{runtimeAuditSupervised:true,runtimeAuditExecutable:exe});
const embed = WorkspaceSemanticProvider.prototype.embed;
try {
  const library = new LibraryService(db,{libraryRoot:join(root,"library")});
  const owner = {type:"personal"} as const;
  const ids = (query:string, extra = {}) => library.searchAsync({owner,query,...extra}).then(rows=>rows.map(row=>row.id));
  await writeMaterialRetrievalSettings(db,{mode:"keyword"});
  await db.runtimeAuditReader!.batch3Write({kind:"libraryInsertSpace",id:"personal-a",name:"存档",spaceKind:"personal",createdAt:1,updatedAt:1});
  const note = await library.createItemAsync({spaceId:"personal-a",kind:"markdown",title:"示例",content:"黄昏 red panda"});
  const alt = await library.createItemAsync({spaceId:"personal-a",kind:"markdown",title:"示例二",content:"a different note"});
  assert.deepEqual(await ids("示例"),[note.id,alt.id]);
  assert.deepEqual(await ids("RED PANDA"),[note.id]);
  assert.deepEqual(await ids("昏"),[note.id]);
  assert.deepEqual(await ids("panda",{reference:{spaceId:"personal-a",itemId:alt.id}}),[]);
  assert.deepEqual(await ids("panda",{owner:{type:"workspace",workspaceId:"foreign"}}),[]);
  assert.deepEqual(await ids("panda",{owner:{type:"project",projectId:"foreign"}}),[]);
  assert.deepEqual(await ids("panda",{filter:{favorite:true}}),[]);
  await library.setFavorite({id:note.id,favorite:true});
  assert.deepEqual(await ids("panda",{filter:{favorite:true}}),[note.id]);
  for (const [id,parentId,name] of [["folder",null,"visible"],["hidden","folder",".private"],["nested","hidden","subfolder"]] as const) {
    assert.ok(await db.runtimeAuditReader!.batch3Write({kind:"libraryInsertCollection",id,parentId,name,spaceId:"personal-a",owner:"fixture",createdAt:1,updatedAt:1}));
  }
  const folderDoc = await library.createItemAsync({spaceId:"personal-a",collectionId:"nested",kind:"markdown",title:"documents",content:"folder marker"});
  assert.deepEqual(await ids("folder marker",{reference:{spaceId:"personal-a",collectionId:"folder"}}),[folderDoc.id]);
  assert.deepEqual(await ids("folder marker",{reference:{spaceId:"personal-a",collectionId:"folder"},filter:{hideDotfiles:true}}),[]);
  assert.deepEqual(await ids("folder marker",{filter:{collectionIds:[null]}}),[]);
  const strong = await library.createItemAsync({spaceId:"personal-a",kind:"markdown",title:"A",content:"tangerine tangerine tangerine"});
  const weak = await library.createItemAsync({spaceId:"personal-a",kind:"markdown",title:"B",content:"tangerine plus boring filler text without another hit"});
  assert.deepEqual(await ids("tangerine"),[strong.id,weak.id]);
  console.log("PASS scoped body, short CJK, title precedence, reference and favorite filter through workbench search");

  // Deterministic inference fixture only. DuckDB stores and ranks the actual
  // model/version/dimension vectors through production publication and search.
  const vector=new Float32Array(SEMANTIC_DIMENSION);
  vector[0]=1;
  const indexed=await db.runtimeAuditReader!.batch3Write({kind:"libraryChunkEmbeddings",deleteChunkIds:[],upsert:[{
    chunkId:note.id+"#0",chunkHash:createHash("sha256").update("黄昏 red panda").digest("hex").slice(0,16),
    modelId:SEMANTIC_MODEL_ID,modelVersion:SEMANTIC_MODEL_VERSION,dimension:SEMANTIC_DIMENSION,
    eligibleSpaceIds:["personal-a"],embeddingBase64:Buffer.from(vector.buffer).toString("base64"),createdAt:1,
  }]});
  assert.deepEqual(indexed,{succeeded:1});
  const matches = await db.runtimeAuditReader!.semantic({target:"library",limit:50,dimension:SEMANTIC_DIMENSION,
    modelId:SEMANTIC_MODEL_ID,modelVersion:SEMANTIC_MODEL_VERSION,query:vector,threshold:0.5,
    scope:{sql:"li.id IN (SELECT unnest(?::JSON::VARCHAR[]))",args:[JSON.stringify([note.id])]}});
  assert.equal(matches?.[0]?.id,note.id+"#0");
  let embedded=0;
  WorkspaceSemanticProvider.prototype.embed=async()=>{embedded++;return vector;};
  assert.deepEqual(await ids("unrelated query words"),[]);
  assert.equal(embedded,0);
  await writeMaterialRetrievalSettings(db,{mode:"hybrid"});
  assert.deepEqual(await ids("unrelated query words"),[note.id]);
  assert.equal(embedded,1);
  assert.deepEqual(await ids("unrelated query words",{reference:{spaceId:"personal-a",itemId:alt.id}}),[]);
  WorkspaceSemanticProvider.prototype.embed=async()=>{
    await library.setFavorite({id:note.id,favorite:false});
    return vector;
  };
  assert.deepEqual(await ids("unrelated query words",{filter:{favorite:true}}),[]);
  console.log("PASS real scoped DuckDB vector publication, ranking, keyword policy and revocation during inference");
  await assert.rejects(access(join(root,"app.db")),{code:"ENOENT"});
} finally {
  WorkspaceSemanticProvider.prototype.embed=embed;
  await db.runtimeAuditReader?.close();
  db.close();
  await shutdownCoreWorker(root,path);
  await rm(root,{recursive:true,force:true});
}
