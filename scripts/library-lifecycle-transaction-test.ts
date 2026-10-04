import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { LibraryService } from "../src/main/library/LibraryService";

const root = mkdtempSync(join(tmpdir(), "mybuddy-library-lifecycle-tx-"));
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