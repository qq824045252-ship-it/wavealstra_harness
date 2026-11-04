import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { LibraryService } from "../src/main/library/LibraryService";
import { WorkspaceLibraryBindingService } from "../src/main/workspace/WorkspaceLibraryBindingService";
import { workspaceLibraryBindingView } from "../src/main/workspace/WorkspaceLibraryBindingView";
import { deleteEmptyWorkspace } from "../src/main/workspace/WorkspaceDeletion";

const root = mkdtempSync(join(tmpdir(), "workspace-materials-view-"));
process.env.HOME = root;
process.env.USERPROFILE = root;
const db = new AppDatabase(join(root, "app.db"));
const library = new LibraryService(db, { libraryRoot: join(root, "library") });
const bindings = new WorkspaceLibraryBindingService(db);
async function main(): Promise<void> {
try {
  db.createSpace({ id: "parent", name: "父空间", parentId: null });
  db.createSpace({ id: "child", name: "子空间", parentId: "parent" });
  db.createSpace({ id: "sibling", name: "同级空间", parentId: "parent" });
  const own = library.ensureOwnedSpace({ type: "workspace", workspaceId: "child" });
  const parent = library.ensureOwnedSpace({ type: "workspace", workspaceId: "parent" });
  const sibling = library.ensureOwnedSpace({ type: "workspace", workspaceId: "sibling" });
  const ownItem = library.createItem({ spaceId: own.id, kind: "markdown", title: "子空间文档" });
  const source = library.createItem({ spaceId: sibling.id, kind: "markdown", title: "引用源文档" });
  const personal = library.ensureReady();
  const folder = library.createCollection({ spaceId: personal.id, name: "规范" });
  const nested = library.createCollection({ spaceId: personal.id, parentId: folder.id, name: "实现细则" });
  bindings.bindCollection("parent", personal.id, folder.id);
  bindings.bind("child", sibling.id);
  bindings.bind("child", own.id); // Old duplicate binding must not turn an owned location into a reference.

  const view = workspaceLibraryBindingView(db, library, bindings, "child");
  assert.equal(view.workspaceName, "子空间");
  assert.deepEqual(view.owned.map((item) => item.librarySpaceId), [own.id]);
  assert.equal(view.ownedItemCount, 1);
  assert.deepEqual(view.direct.map((item) => item.librarySpaceId), [sibling.id]);
  assert.equal(view.direct[0].workspaceId, "sibling");
  assert.match(view.direct[0].path ?? "", /同级空间/);
  assert.ok(view.inherited.some((item) => item.librarySpaceId === parent.id && item.sourceWorkspaceId === "parent"));
  assert.ok(view.inherited.some((item) => item.collectionId === folder.id && item.sourceWorkspaceId === "parent"));
  assert.ok(!view.addable.some((item) => item.librarySpaceId === own.id || item.librarySpaceId === parent.id));
  assert.ok(!view.addable.some((item) => item.collectionId === nested.id), "Already inherited collection subtree must not be offered again");
  assert.ok(view.addable.some((item) => item.librarySpaceId === personal.id && !item.collectionId), "A folder reference must not pretend to cover the entire personal library");
  assert.deepEqual(view.destinations, [{ id: own.id, name: own.name }]);

  bindings.unbind("child", sibling.id);
  assert.ok(library.getItem(source.id), "Removing a reference keeps the source document");
  assert.ok(library.getItem(ownItem.id));
  const afterUnbind = workspaceLibraryBindingView(db, library, bindings, "child");
  assert.equal(afterUnbind.direct.length, 0);
  assert.ok(afterUnbind.addable.some((item) => item.librarySpaceId === sibling.id));
  db.connection.prepare("UPDATE spaces SET archived = 1 WHERE id = ?").run("sibling");
  assert.ok(!workspaceLibraryBindingView(db, library, bindings, "child").addable.some((item) => item.librarySpaceId === sibling.id));
  assert.throws(() => workspaceLibraryBindingView(db, library, bindings, "missing"), /工作空间不存在/);
  let cleanupCalls = 0;
  const blocked = await deleteEmptyWorkspace(db, "child", [{ name: "工具清理", run: () => { cleanupCalls += 1; } }]);
  assert.equal(blocked.ok, false);
  assert.equal(cleanupCalls, 0, "A failed material ownership gate must preserve gadgets too");
  assert.ok(db.getSpace("child"));
  db.createSpace({ id: "empty", name: "空空间" });
  library.ensureOwnedSpace({ type: "workspace", workspaceId: "empty" });
  const deleted = await deleteEmptyWorkspace(db, "empty", [{ name: "工具清理", run: async () => {
    assert.equal(db.getSpace("empty"), undefined, "Database deletion commits before asynchronous irreversible cleanup");
    await Promise.resolve();
    assert.throws(() => library.ensureOwnedSpace({ type: "workspace", workspaceId: "empty" }), /工作空间不存在/, "Late material creation cannot resurrect a deleted owner");
    throw new Error("模拟运行时清理失败");
  } }, { name: "剩余清理", run: () => { cleanupCalls += 1; } }]);
  assert.equal(deleted.ok, true, "A post-commit cleanup failure must not claim the workspace still exists");
  assert.ok(deleted.ok && deleted.warning?.includes("模拟运行时清理失败"));
  assert.equal(cleanupCalls, 1, "Independent cleanup continues after a failure");
  console.log("workspace-materials-view: ownership, inherited sources, reference coverage, unbinding, archive filtering and deletion commit ordering PASS");
} finally {
  db.close();
  rmSync(root, { recursive: true, force: true });
}
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
