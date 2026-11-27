import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AppDatabase, CURRENT_DATABASE_SCHEMA_VERSION } from "../src/main/db/AppDatabase";
import { initializeCoreDatabase, shutdownCoreWorker } from "../src/main/platform/core-client";
import { LibraryService } from "../src/main/library/LibraryService";

const root = mkdtempSync(join(tmpdir(), "mybuddy-library-access-"));
const exe = resolve(process.argv[2] ?? "out/native/linux-x64/mybuddy-runtime-audit");
const path = join(root, "app.duckdb");
await initializeCoreDatabase(exe, root, path, CURRENT_DATABASE_SCHEMA_VERSION);
const open = () => AppDatabase.open(path, {runtimeAuditExecutable:exe, runtimeAuditSupervised:true});
let db = await open();
const close = async () => {
  await db.runtimeAuditReader?.close();
  db.close();
  await shutdownCoreWorker(root,path);
};
try {
  const libraryRoot = join(root,"library");
  const library = new LibraryService(db,{libraryRoot});
  assert.deepEqual(await db.runtimeAuditReader!.batch3Write({kind:"libraryInsertSpace",id:"personal",name:"Fixture library",
    spaceKind:"personal",createdAt:1,updatedAt:1}),{ok:true});
  const note = await library.createItemAsync({spaceId:"personal",kind:"markdown",title:"Root note",content:"root body"});
  const folder = join(root,"fixtures");
  mkdirSync(folder);
  writeFileSync(join(folder,"child.md"),"child body");
  const imported = await library.importFolder({owner:{type:"personal"},spaceId:"personal",collectionId:null,sourcePath:folder});
  const child = (await library.readItems("personal",imported.folder.id))[0];
  assert.equal(child.filename,"child.md");
  assert.deepEqual((await library.readItems("personal",null)).map(row=>row.id),[note.id]);
  assert.deepEqual((await library.readItems("personal")).map(row=>row.id).sort(),[note.id,child.id].sort());
  assert.equal((await library.readItemAsync(child.id))?.id,child.id);
  assert.equal(await library.readItemAsync("missing"),null);
  assert.equal(readFileSync(await library.readItemLocation(child.id),"utf8"),"child body");
  const [visited,favorite] = await Promise.all([library.visitItem(note.id), library.setFavorite({id:note.id,favorite:true})]);
  assert(visited.lastVisitedAt);
  assert.equal(favorite.favorite,true);
  await close();
  db = await open();
  const restored = new LibraryService(db,{libraryRoot});
  const persisted = await restored.readItemAsync(note.id);
  assert(persisted?.favorite);
  assert.equal(persisted.lastVisitedAt,visited.lastVisitedAt);
  assert.equal((await restored.setFavorite({id:note.id,favorite:false})).favorite,false);
  await assert.rejects(restored.visitItem("missing"));
  await assert.rejects(restored.readItemLocation("missing"));
  await assert.rejects(restored.setFavorite({id:"missing",favorite:true}));
  await db.writeWorkspaceUpsert({id:"workspace",name:"Workspace"});
  const reader=db.runtimeAuditReader!;
  assert.deepEqual(await reader.batch3Write({kind:"libraryInsertSpace",id:"workspace-library",workspaceId:"workspace",
    name:"Workspace library",spaceKind:"team",createdAt:1,updatedAt:1}),{ok:true});
  const protectedNote=await restored.createItemAsync({spaceId:"workspace-library",kind:"markdown",title:"Archived note",content:"protected body"});
  assert.equal((await reader.setSidebarArchive({kind:"space",id:"workspace",archived:true,at:Date.now()}))?.status,"saved");
  await assert.rejects(restored.setFavorite({id:protectedNote.id,favorite:true}));
  assert.equal((await restored.visitItem(protectedNote.id)).favorite,false);
  if (process.argv.includes("--search")) {
    const hits = await restored.searchAsync({query:"child body",owner:{type:"personal"}});
    assert(hits.some(hit=>hit.id===child.id));
  }
  assert.equal(existsSync(join(root,"app.db")),false);
  console.log("PASS library access: root/all/folder listing, item lookup, managed file location, concurrent visit and favorite, restart, archived workspace and missing items");
} finally {
  await close();
  rmSync(root,{recursive:true,force:true});
}
