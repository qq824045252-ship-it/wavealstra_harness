import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, rmSync, rmdirSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { LibraryService } from "../src/main/library/LibraryService";
import { locateRuntimeAudit, RuntimeAuditUnknownOperationError, type RuntimeLibraryDeleteReply } from "../src/main/platform/runtime-audit";

const root = mkdtempSync(join(tmpdir(), "mybuddy-library-lifecycle-tx-"));
// 隔离 HOME：LibraryService 把资料库文件写到 ~/.mybuddy/library（POSIX 的 os.homedir() 读 HOME），
// 只把 SQLite 放进临时目录而不同时隔离 HOME，会把夹具文档写进真实用户资料库。
process.env.HOME = root;
process.env.USERPROFILE = root;
const db = new AppDatabase(join(root, "app.db"));
db.connection.prepare(`INSERT INTO projects(id,name,created_at,updated_at) VALUES ('p1','P1',1,1)`).run();
const library = new LibraryService(db, { libraryRoot: join(root, "library") });
const internal = library as any;
const repo = internal.repo;

try {
  const personal = library.ensureReady();

  // 1. title-only metadata update must compensate when FTS refresh fails.
  const text = library.createItem({ spaceId: personal.id, collectionId: null, kind: "markdown", title: "Old Unique Title" });
  library.writeContent({ id: text.id, content: "body-stable" });
  const realRefreshFts = internal.refreshFts.bind(internal);
  let ftsCalls = 0;
  internal.refreshFts = (item: unknown) => {
    ftsCalls += 1;
    if (ftsCalls === 1) throw new Error("fixture title fts failure");
    return realRefreshFts(item);
  };
  assert.throws(() => library.updateItem({ id: text.id, title: "New Unique Title" }), /fixture title fts failure/);
  internal.refreshFts = realRefreshFts;
  assert.equal(library.getItem(text.id)!.title, "Old Unique Title", "title metadata restored after FTS failure");
  assert(library.search("Old Unique Title").some((row) => row.id === text.id), "old FTS title restored");
  assert.equal(library.search("New Unique Title").some((row) => row.id === text.id), false, "failed title never leaks into FTS");

  // 2. Collection recursive deletion: any DB failure rolls back all rows before files are touched.
  const space = library.createSpace({ name: "Project Space", projectId: "p1" });
  const parent = library.createCollection({ spaceId: space.id, parentId: null, name: "Parent" });
  const child = library.createCollection({ spaceId: space.id, parentId: parent.id, name: "Child" });
  const pItem = library.createItem({ spaceId: space.id, collectionId: parent.id, kind: "markdown", title: "Parent item" });
  const cItem = library.createItem({ spaceId: space.id, collectionId: child.id, kind: "markdown", title: "Child item" });
  const pPath = library.absolutePath(pItem);
  const cPath = library.absolutePath(cItem);
  const realDeleteCollection = repo.deleteCollection.bind(repo);
  let collectionDeletes = 0;
  repo.deleteCollection = (id: string) => {
    collectionDeletes += 1;
    if (collectionDeletes === 1) throw new Error("fixture collection DB failure");
    return realDeleteCollection(id);
  };
  assert.throws(() => library.deleteCollection(parent.id), /fixture collection DB failure/);
  repo.deleteCollection = realDeleteCollection;
  assert(library.getCollection(parent.id), "parent collection row survives rolled-back delete");
  assert(library.getCollection(child.id), "child collection row survives rolled-back delete");
  assert(library.getItem(pItem.id) && library.getItem(cItem.id), "item rows survive rolled-back collection delete");
  assert(existsSync(pPath) && existsSync(cPath), "managed files are untouched before durable collection commit");
  library.deleteCollection(parent.id);
  assert.equal(library.getCollection(parent.id), null);
  assert.equal(library.getCollection(child.id), null);
  assert.equal(library.getItem(pItem.id), null);
  assert.equal(library.getItem(cItem.id), null);
  assert.equal(existsSync(pPath), false);
  assert.equal(existsSync(cPath), false);

  // 3. Space deletion: failure at the final space-row delete rolls back item/collection deletion too.
  const doomed = library.createSpace({ name: "Doomed Space", projectId: "p1" });
  const doomedCollection = library.createCollection({ spaceId: doomed.id, parentId: null, name: "Folder" });
  const doomedRootItem = library.createItem({ spaceId: doomed.id, collectionId: null, kind: "markdown", title: "Root item" });
  const doomedNestedItem = library.createItem({ spaceId: doomed.id, collectionId: doomedCollection.id, kind: "markdown", title: "Nested item" });
  const rootPath = library.absolutePath(doomedRootItem);
  const nestedPath = library.absolutePath(doomedNestedItem);
  const realDeleteSpace = repo.deleteSpace.bind(repo);
  repo.deleteSpace = () => { throw new Error("fixture space DB failure"); };
  assert.throws(() => library.deleteSpace(doomed.id), /fixture space DB failure/);
  repo.deleteSpace = realDeleteSpace;
  assert(library.getSpace(doomed.id), "space row survives transaction rollback");
  assert(library.getCollection(doomedCollection.id), "collection row survives space rollback");
  assert(library.getItem(doomedRootItem.id) && library.getItem(doomedNestedItem.id), "all item rows survive space rollback");
  assert(existsSync(rootPath) && existsSync(nestedPath), "all files survive space rollback");
  library.deleteSpace(doomed.id);
  assert.equal(library.getSpace(doomed.id), null);
  assert.equal(library.getCollection(doomedCollection.id), null);
  assert.equal(library.getItem(doomedRootItem.id), null);
  assert.equal(library.getItem(doomedNestedItem.id), null);
  assert.equal(existsSync(rootPath), false);
  assert.equal(existsSync(nestedPath), false);

  console.log("library lifecycle transaction: PASS (title FTS compensation, collection/space DB-first delete)");
} finally {
  db.close();
  rmSync(root, { recursive: true, force: true });
}

async function verifyNativeDeletion() {
  const runtimeAuditExecutable = locateRuntimeAudit(process.cwd());
  assert(runtimeAuditExecutable && existsSync(runtimeAuditExecutable));
  const fixture = mkdtempSync(join(tmpdir(), "mybuddy-native-library-delete-"));
  const libraryRoot = join(fixture, "library");
  const openDatabase = () => new AppDatabase(join(fixture, "app.db"), { runtimeAuditExecutable });
  let database = openDatabase();
  try {
    let service = new LibraryService(database, { libraryRoot });
    database.connection.exec(`
      INSERT INTO projects(id,name,created_at,updated_at) VALUES ('p1','项目',1,1);
      CREATE TABLE fixture_reject_delete(id TEXT PRIMARY KEY);
      CREATE TRIGGER fixture_delete_rejected BEFORE DELETE ON library_items
      WHEN EXISTS(SELECT 1 FROM fixture_reject_delete WHERE id=old.id)
      BEGIN SELECT RAISE(ABORT,'fixture library deletion rejected'); END;
    `);
    const projectSpace = service.createSpace({ name: "项目资料", projectId: "p1" });
    database.upsertTask({ id: "task", title: "任务", updatedAt: 1, projectId: "p1" });
    const note = service.createItem({ spaceId: projectSpace.id, kind: "markdown", title: "待删除资料", content: "首版" });
    await service.writeContentAsync({ id: note.id, content: "墨岩索引关键字" });
    service.attachToTask({ itemId: note.id, taskId: "task" });
    const path = service.absolutePath(note);
    const versionsDir = path + ".versions";
    mkdirSync(versionsDir);
    writeFileSync(join(versionsDir, "old.md"), "历史文件");
    const chunk = database.connection.prepare("SELECT id,hash FROM library_chunks WHERE item_id=? LIMIT 1")
      .get(note.id) as { id: string; hash: string };
    database.connection.prepare(`
      INSERT INTO library_chunk_embeddings(chunk_id,model_id,model_version,chunk_hash,dimension,embedding,created_at)
      VALUES (?, 'fixture', '1', ?, 1, ?, 1)
    `).run(chunk.id, chunk.hash, Buffer.alloc(4));
    database.connection.prepare("INSERT INTO fixture_reject_delete VALUES (?)").run(note.id);
    await assert.rejects(service.deleteItemAsync(note.id), /资料删除失败/);
    assert.equal(service.getItem(note.id)?.title, "待删除资料");
    assert.equal(service.readVersion(note.id, 1), "首版");
    assert.equal(existsSync(path), true, "failed SQLite transaction keeps the file");
    assert.equal(service.search("墨岩索引关键字")[0]?.id, note.id);
    database.connection.prepare("DELETE FROM fixture_reject_delete WHERE id=?").run(note.id);
    const reader = database.runtimeAuditReader!;
    const deleteWithReply = reader.deleteLibrary.bind(reader);
    const queryReceipt = reader.queryOperation.bind(reader);
    const pending = service.createItem({ spaceId: projectSpace.id, kind: "markdown", title: "结果尚未确认" });
    const pendingPath = service.absolutePath(pending);
    let deleteAttempts = 0;
    let receiptQueries = 0;
    let hostDeletes = 0;
    const hostDelete = service.deleteItem.bind(service);
    service.deleteItem = () => { hostDeletes += 1; throw new Error("unknown delete must not fall back to Host"); };
    reader.deleteLibrary = async () => {
      deleteAttempts += 1;
      throw new RuntimeAuditUnknownOperationError("fixture-unconfirmed-delete", "deleteLibrary");
    };
    reader.queryOperation = async requestId => {
      receiptQueries += 1;
      return { requestId, state: "running" };
    };
    await assert.rejects(service.deleteItemAsync(pending.id), error =>
      error instanceof Error && "code" in error && error.code === "RUNTIME_OPERATION_UNKNOWN"
        && "requestId" in error && error.requestId === "fixture-unconfirmed-delete"
        && /结果尚未确认/.test(error.message));
    assert.equal(deleteAttempts, 1, "an unknown deletion must never be replayed");
    assert.equal(receiptQueries, 1, "unknown outcome is checked against its operation receipt");
    assert.equal(hostDeletes, 0, "unknown outcome must never become a second Node writer");
    assert(service.getItem(pending.id));
    assert(existsSync(pendingPath), "an unconfirmed operation is not reported as a completed deletion");
    reader.deleteLibrary = deleteWithReply;
    reader.queryOperation = queryReceipt;
    service.deleteItem = hostDelete;
    await service.deleteItemAsync(pending.id);

    let committedReply: RuntimeLibraryDeleteReply | undefined;
    reader.deleteLibrary = async (...args) => {
      committedReply = await deleteWithReply(...args);
      assert.equal(committedReply?.status, "deleted");
      throw new RuntimeAuditUnknownOperationError("fixture-committed-delete", "deleteLibrary");
    };
    reader.queryOperation = async requestId => {
      assert.equal(requestId, "fixture-committed-delete");
      return { requestId, state: "committed", result: committedReply };
    };
    await service.deleteItemAsync(note.id);
    reader.deleteLibrary = deleteWithReply;
    reader.queryOperation = queryReceipt;
    assert.equal(service.getItem(note.id), null);
    assert.equal(service.listVersions(note.id).length, 0);
    assert.equal(service.listTaskReferences("task").items.length, 0);
    assert.deepEqual(service.search("墨岩索引关键字"), []);
    assert.equal(database.connection.prepare("SELECT 1 FROM library_chunk_embeddings WHERE chunk_id=?").get(chunk.id), undefined);
    assert.equal(existsSync(path), false);
    assert.equal(existsSync(versionsDir), false);

    const folder = service.createCollection({ spaceId: projectSpace.id, name: "目录" });
    const child = service.createCollection({ spaceId: projectSpace.id, name: "子目录", parentId: folder.id });
    const descendant = service.createItem({ spaceId: projectSpace.id, collectionId: child.id, kind: "markdown", title: "已回收条目" });
    await service.trashNotes({ type: "project", projectId: "p1" }, [descendant.id]);
    database.connection.prepare("INSERT INTO workspace_library_collection_links VALUES ('w1',?,?,1)").run(projectSpace.id, child.id);
    database.connection.prepare("INSERT INTO fixture_reject_delete VALUES (?)").run(descendant.id);
    await assert.rejects(service.deleteCollectionAsync(folder.id), /资料删除失败/);
    assert(service.getCollection(child.id));
    assert(existsSync(service.absolutePath(descendant)));
    assert(database.connection.prepare("SELECT 1 FROM workspace_library_collection_links WHERE collection_id=?").get(child.id));
    database.connection.prepare("DELETE FROM fixture_reject_delete WHERE id=?").run(descendant.id);
    await service.deleteCollectionAsync(folder.id);
    assert.equal(service.getCollection(child.id), null);
    assert.deepEqual(await service.readTrashedNotes({ type: "project", projectId: "p1" }), []);
    assert.equal(existsSync(service.absolutePath(descendant)), false);
    assert.equal(database.connection.prepare("SELECT 1 FROM workspace_library_collection_links WHERE collection_id=?").get(child.id), undefined);
    assert(service.getSpace(projectSpace.id));

    const standalone = service.createSpace({ name: "待删除独立资料" });
    const asset = service.createItem({ spaceId: standalone.id, kind: "markdown", title: "独立空间条目" });
    const outside = join(fixture, "outside-library");
    mkdirSync(outside);
    const sentinel = join(outside, "keep.txt");
    writeFileSync(sentinel, "keep");
    symlinkSync(outside, join(libraryRoot, standalone.id, "linked-directory"), process.platform === "win32" ? "junction" : "dir");
    await service.deleteSpaceAsync(standalone.id);
    assert.equal(service.getSpace(standalone.id), null);
    assert.equal(existsSync(service.absolutePath(asset)), false);
    assert.equal(existsSync(sentinel), true, "space cleanup never follows a link outside the managed directory");
    const projectAsset = service.createItem({ spaceId: projectSpace.id, kind: "markdown", title: "项目资料待清理" });
    database.connection.prepare("UPDATE projects SET archived=1 WHERE id='p1'").run();
    await assert.rejects(service.deleteItemAsync(projectAsset.id), /归档/);
    await assert.rejects(service.deleteSpaceAsync(projectSpace.id), /归档/);
    assert.equal(existsSync(service.absolutePath(projectAsset)), true);

    const personal = service.ensureReady();
    const retry = service.createItem({ spaceId: personal.id, kind: "markdown", title: "待重试清理" });
    const retryPath = service.absolutePath(retry);
    rmSync(retryPath);
    mkdirSync(retryPath);
    await service.deleteItemAsync(retry.id);
    assert.equal(service.getItem(retry.id), null, "metadata deletion commits independently of file cleanup");
    assert(database.connection.prepare("SELECT 1 FROM library_file_cleanup WHERE item_id=?").get(retry.id));
    assert.equal(existsSync(retryPath), true);
    rmdirSync(retryPath);
    writeFileSync(retryPath, "尚未删除的旧文件");
    const retained = service.createItem({ spaceId: personal.id, kind: "markdown", title: "保留文件", content: "同 ID 有效资料" });
    database.connection.prepare("INSERT INTO library_file_cleanup VALUES (?,?,?,?)")
      .run(libraryRoot, retained.spaceId, retained.id, retained.filename);

    await database.runtimeAuditReader?.close();
    database.close();
    database = openDatabase();
    service = new LibraryService(database, { libraryRoot });
    await service.recoverFileDeletes();
    await service.recoverFileDeletes();
    assert.equal(existsSync(retryPath), false, "restart finishes a previously unsuccessful cleanup");
    assert.equal(service.readContent(retained.id).content, "同 ID 有效资料", "stale cleanup cannot delete an occupied path");
    assert.deepEqual(database.connection.prepare("SELECT item_id FROM library_file_cleanup").all(), []);
    console.log("PASS Rust library deletion: committed/unknown receipts without replay, DB-first files, scope, tree, history, references, search, restart retry");
  } finally {
    await database.runtimeAuditReader?.close();
    database.close();
    rmSync(fixture, { recursive: true, force: true });
  }
}

if (process.argv.includes("--native")) void verifyNativeDeletion().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
