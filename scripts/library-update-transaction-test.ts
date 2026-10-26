import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { ArtifactRepository } from "../src/main/artifact/ArtifactRepository";
import { LibraryService, LibraryUpdatePartialStateError } from "../src/main/library/LibraryService";

const root = mkdtempSync(join(tmpdir(), "mybuddy-library-update-tx-"));
// 隔离 HOME：LibraryService 把资料库文件写到 ~/.mybuddy/library（POSIX 的 os.homedir() 读 HOME），
// 只把 SQLite 放进临时目录而不同时隔离 HOME，会把夹具文档写进真实用户资料库。
process.env.HOME = root;
process.env.USERPROFILE = root;
const db = new AppDatabase(join(root, "app.db"));
new ArtifactRepository(db.connection);
const library = new LibraryService(db, { libraryRoot: join(root, "library") });
const personal = library.ensureReady();
const internal = library as any;
const repo = internal.repo;

function versions(id: string): number { return library.listVersions(id).length; }
function content(id: string): string { return library.readContent(id).content; }

try {
  const text = library.createItem({ spaceId: personal.id, collectionId: null, kind: "markdown", title: "Original" });
  library.writeContent({ id: text.id, content: "old body" });
  const baseline = library.getItem(text.id)!;
  const baselineVersions = versions(text.id);

  // 1. FTS failure after file+metadata update: compensation restores file, metadata and version rows.
  const realRefreshFts = internal.refreshFts.bind(internal);
  let ftsCalls = 0;
  internal.refreshFts = (item: unknown) => {
    ftsCalls += 1;
    if (ftsCalls === 1) throw new Error("fixture fts update failure");
    return realRefreshFts(item);
  };
  assert.throws(
    () => library.updateTextContent({ id: text.id, title: "Changed", content: "new body" }),
    /fixture fts update failure/,
  );
  internal.refreshFts = realRefreshFts;
  assert.equal(content(text.id), "old body", "text file restored after post-write FTS failure");
  assert.equal(library.getItem(text.id)!.title, baseline.title, "metadata restored after FTS failure");
  assert.equal(library.getItem(text.id)!.contentHash, baseline.contentHash);
  assert.equal(versions(text.id), baselineVersions, "failed update does not leave a fake version row");

  // 2. Metadata write failure after file replacement: old file survives and no version leak remains.
  const realUpdateItem = repo.updateItem.bind(repo);
  let updateCalls = 0;
  repo.updateItem = (item: unknown) => {
    updateCalls += 1;
    if (updateCalls === 1) throw new Error("fixture metadata update failure");
    return realUpdateItem(item);
  };
  assert.throws(() => library.updateTextContent({ id: text.id, content: "another body" }), /fixture metadata update failure/);
  repo.updateItem = realUpdateItem;
  assert.equal(content(text.id), "old body", "file restored when metadata commit fails");
  assert.equal(versions(text.id), baselineVersions);

  // 3. If a compensation step fails, residual state is explicit rather than hidden.
  ftsCalls = 0;
  internal.refreshFts = (item: unknown) => {
    ftsCalls += 1;
    if (ftsCalls === 1) throw new Error("fixture fts causes rollback");
    return realRefreshFts(item);
  };
  const realDeleteVersion = repo.deleteVersion.bind(repo);
  repo.deleteVersion = () => { throw new Error("fixture version rollback failure"); };
  let partial: LibraryUpdatePartialStateError | undefined;
  try { library.updateTextContent({ id: text.id, content: "partial body" }); }
  catch (error) { if (error instanceof LibraryUpdatePartialStateError) partial = error; else throw error; }
  repo.deleteVersion = realDeleteVersion;
  internal.refreshFts = realRefreshFts;
  assert(partial, "rollback failure produces typed partial-state error");
  assert.equal(content(text.id), "old body", "even with version rollback failure, managed file was restored");
  // Remove the residual version fixture so later assertions stay isolated.
  for (const version of library.listVersions(text.id).filter((v: any) => v.version > baselineVersions)) realDeleteVersion(version.id);

  // 4. Existing saved Artifact refresh is also compensating.
  db.connection.prepare(`INSERT INTO spaces(id,name,created_at,updated_at) VALUES ('s1','S1',1,1)`).run();
  db.connection.prepare(`INSERT INTO tasks(id,title,status,updated_at,space_id) VALUES ('t1','T1','done',1,'s1')`).run();
  const artifactPath = join(root, "artifact.md");
  writeFileSync(artifactPath, "artifact-v1", "utf8");
  db.connection.prepare(`INSERT INTO artifacts(id,task_id,kind,source_type,entry_file,root_dir,version,capabilities_json,created_at,updated_at) VALUES ('a1','t1','markdown','workspace-file',?,?,1,'{}',1,1)`).run(artifactPath, root);
  const saved = library.saveArtifact({ artifactId: "a1", spaceId: personal.id, collectionId: null });
  const savedPath = library.absolutePath(saved);
  const oldSavedBytes = readFileSync(savedPath, "utf8");
  const oldSavedMeta = library.getItem(saved.id)!;
  const oldSavedVersions = versions(saved.id);
  writeFileSync(artifactPath, "artifact-v2", "utf8");
  ftsCalls = 0;
  internal.refreshFts = (item: unknown) => {
    ftsCalls += 1;
    if (ftsCalls === 1) throw new Error("fixture artifact refresh fts failure");
    return realRefreshFts(item);
  };
  assert.throws(() => library.saveArtifact({ artifactId: "a1", spaceId: personal.id, collectionId: null }), /fixture artifact refresh fts failure/);
  internal.refreshFts = realRefreshFts;
  assert.equal(readFileSync(savedPath, "utf8"), oldSavedBytes, "artifact managed copy restored after refresh failure");
  assert.equal(library.getItem(saved.id)!.contentHash, oldSavedMeta.contentHash, "artifact metadata restored");
  assert.equal(versions(saved.id), oldSavedVersions, "artifact refresh version row rolled back");
  assert.equal(existsSync(savedPath + ".rollback"), false);

  // 5. Delete DB failure must keep the managed file; durable row never points to a missing file.
  const deleteTarget = library.createItem({ spaceId: personal.id, collectionId: null, kind: "markdown", title: "Delete me" });
  const deletePath = library.absolutePath(deleteTarget);
  const realDeleteItem = repo.deleteItem.bind(repo);
  repo.deleteItem = () => { throw new Error("fixture DB delete failure"); };
  assert.throws(() => library.deleteItem(deleteTarget.id), /fixture DB delete failure/);
  repo.deleteItem = realDeleteItem;
  assert(library.getItem(deleteTarget.id), "DB row remains after failed durable delete");
  assert(existsSync(deletePath), "managed file remains while DB row remains");
  library.deleteItem(deleteTarget.id);
  assert.equal(library.getItem(deleteTarget.id), null);
  assert.equal(existsSync(deletePath), false, "file cleanup happens only after durable row deletion");

  console.log("library update transaction: PASS (text/artifact compensation, explicit residuals, safe delete commit point)");
} finally {
  db.close();
  rmSync(root, { recursive: true, force: true });
}