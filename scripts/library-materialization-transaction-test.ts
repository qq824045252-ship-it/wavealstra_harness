import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { ArtifactRepository } from "../src/main/artifact/ArtifactRepository";
import { LibraryMaterializationPartialStateError, LibraryService } from "../src/main/library/LibraryService";

const root = mkdtempSync(join(tmpdir(), "mybuddy-library-atomic-"));
// 隔离 HOME：LibraryService 把资料库文件写到 ~/.mybuddy/library（POSIX 的 os.homedir() 读 HOME），
// 只把 SQLite 放进临时目录而不同时隔离 HOME，会把夹具文档写进真实用户资料库。
process.env.HOME = root;
process.env.USERPROFILE = root;
const dbPath = join(root, "app.db");
const libraryRoot = join(root, "library");
const sourcePath = join(root, "source.md");
writeFileSync(sourcePath, "fixture content", "utf8");
const db = new AppDatabase(dbPath);
new ArtifactRepository(db.connection);
db.connection.prepare(`INSERT INTO projects (id,name,created_at,updated_at) VALUES ('p1','P1',1,1)`).run();
const library = new LibraryService(db, { libraryRoot });
const personal = library.ensureReady();

function managedFiles(spaceId: string): string[] {
  const dir = join(libraryRoot, spaceId);
  return existsSync(dir) ? readdirSync(dir).filter((name) => !name.startsWith(".")) : [];
}
function itemCount(): number {
  return (db.connection.prepare("SELECT COUNT(*) c FROM library_items").get() as { c: number }).c;
}

try {
  const internal = library as any;
  const repo = internal.repo;

  // 1. DB insert failure after file materialization -> file must be removed.
  const before1 = itemCount();
  const beforeFiles1 = new Set(managedFiles(personal.id));
  const realInsertItem = repo.insertItem.bind(repo);
  repo.insertItem = () => { throw new Error("fixture item insert failure"); };
  assert.throws(() => library.createItem({ spaceId: personal.id, collectionId: null, kind: "markdown", title: "insert-fail" }), /fixture item insert failure/);
  repo.insertItem = realInsertItem;
  assert.equal(itemCount(), before1, "failed insert must not leave a DB item row");
  assert.deepEqual(new Set(managedFiles(personal.id)), beforeFiles1, "failed insert must remove materialized file");

  // 2. FTS failure after row insert -> row and file must both roll back.
  const before2 = itemCount();
  const beforeFiles2 = new Set(managedFiles(personal.id));
  const realRefreshFts = internal.refreshFts.bind(internal);
  internal.refreshFts = () => { throw new Error("fixture fts failure"); };
  assert.throws(() => library.createItem({ spaceId: personal.id, collectionId: null, kind: "markdown", title: "fts-fail" }), /fixture fts failure/);
  internal.refreshFts = realRefreshFts;
  assert.equal(itemCount(), before2, "FTS failure must roll back DB item row");
  assert.deepEqual(new Set(managedFiles(personal.id)), beforeFiles2, "FTS failure must roll back managed file");

  // 3. importFile uses the same commit boundary.
  const before3 = itemCount();
  const beforeFiles3 = new Set(managedFiles(personal.id));
  repo.insertItem = () => { throw new Error("fixture import insert failure"); };
  assert.throws(() => library.importFile({ spaceId: personal.id, sourcePath }), /fixture import insert failure/);
  repo.insertItem = realInsertItem;
  assert.equal(itemCount(), before3);
  assert.deepEqual(new Set(managedFiles(personal.id)), beforeFiles3, "import DB failure must remove copied file");

  // 4. saveArtifact also uses the same boundary. Seed minimal task+artifact fixture.
  db.connection.prepare(`INSERT INTO spaces(id,name,created_at,updated_at) VALUES ('s1','S1',1,1)`).run();
  db.connection.prepare(`INSERT INTO tasks(id,title,status,updated_at,space_id) VALUES ('t1','T1','done',1,'s1')`).run();
  const artifactPath = join(root, "artifact.md");
  writeFileSync(artifactPath, "artifact content", "utf8");
  db.connection.prepare(`INSERT INTO artifacts(id,task_id,kind,source_type,entry_file,root_dir,version,capabilities_json,created_at,updated_at) VALUES ('a1','t1','markdown','workspace-file',?,?,1,'{}',1,1)`).run(artifactPath, root);
  const before4 = itemCount();
  const beforeFiles4 = new Set(managedFiles(personal.id));
  repo.insertItem = () => { throw new Error("fixture artifact insert failure"); };
  assert.throws(() => library.saveArtifact({ artifactId: "a1", spaceId: personal.id, collectionId: null }), /fixture artifact insert failure/);
  repo.insertItem = realInsertItem;
  assert.equal(itemCount(), before4);
  assert.deepEqual(new Set(managedFiles(personal.id)), beforeFiles4, "artifact save DB failure must remove copied file");

  // 5. Rollback DB deletion failure must be explicit partial state and preserve file.
  internal.refreshFts = () => { throw new Error("fixture fts after insert"); };
  const realDeleteItem = repo.deleteItem.bind(repo);
  repo.deleteItem = () => { throw new Error("fixture rollback delete failure"); };
  let partial: LibraryMaterializationPartialStateError | undefined;
  try {
    library.createItem({ spaceId: personal.id, collectionId: null, kind: "markdown", title: "rollback-fail" });
  } catch (error) {
    if (error instanceof LibraryMaterializationPartialStateError) partial = error;
    else throw error;
  }
  repo.deleteItem = realDeleteItem;
  internal.refreshFts = realRefreshFts;
  assert(partial, "rollback failure must surface typed partial state");
  assert.equal(partial!.entityKind, "item");
  assert(existsSync(partial!.retainedPath!), "file is retained when DB row rollback fails, avoiding a dangling DB row");
  assert(db.connection.prepare("SELECT 1 FROM library_items WHERE id=?").get(partial!.entityId), "DB row is still present when rollback deletion failed");
  // cleanup fixture through normal service path
  library.deleteItem(partial!.entityId);

  // 6. Space row insert failure must not create a directory.
  const beforeSpaces = new Set(readdirSync(libraryRoot));
  const realInsertSpace = repo.insertSpace.bind(repo);
  repo.insertSpace = () => { throw new Error("fixture space insert failure"); };
  assert.throws(() => library.createSpace({ name: "fail-space", projectId: "p1" }), /fixture space insert failure/);
  repo.insertSpace = realInsertSpace;
  assert.deepEqual(new Set(readdirSync(libraryRoot)), beforeSpaces, "space insert failure must not create storage directory");

  console.log("library materialization transaction: PASS (create/import/artifact/FTS rollback + explicit partial state)");
} finally {
  db.close();
  rmSync(root, { recursive: true, force: true });
}