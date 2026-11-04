import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import { AppDatabase, CURRENT_DATABASE_SCHEMA_VERSION } from "../src/main/db/AppDatabase";
import { ArtifactRepository } from "../src/main/artifact/ArtifactRepository";
import { LibraryRepository } from "../src/main/library/LibraryRepository";
import { LibraryService } from "../src/main/library/LibraryService";
import { WorkspaceLibraryBindingService } from "../src/main/workspace/WorkspaceLibraryBindingService";
import type { LibraryItemDto } from "../src/shared/library-ipc";

const root = mkdtempSync(join(tmpdir(), "mybuddy-library-owner-scope-"));
const db = new AppDatabase(join(root, "scope.db"));
const library = new LibraryService(db, { libraryRoot: join(root, "library") });
const bindings = new WorkspaceLibraryBindingService(db);
const repo = new LibraryRepository(db.connection);

function workspace(id: string, parentId: string | null = null): void {
  db.connection.prepare("INSERT INTO spaces(id,name,parent_id,created_at,updated_at) VALUES (?,?,?,1,1)")
    .run(id, id, parentId);
}
function task(id: string, projectId: string | null, workspaceId: string | null): void {
  db.connection.prepare("INSERT INTO tasks(id,title,status,updated_at,project_id,space_id) VALUES (?,?,'pending',1,?,?)")
    .run(id, id, projectId, workspaceId);
}
function item(spaceId: string, title: string, collectionId: string | null = null, body = "scopebodyneedle"): LibraryItemDto {
  const created = library.createItem({ spaceId, collectionId, kind: "markdown", title: `scopeprobe ${title}` });
  library.writeContent({ id: created.id, content: body });
  return library.getItem(created.id)!;
}
function hasItem(items: Array<{ id: string }>, expected: LibraryItemDto): boolean {
  return items.some((entry) => entry.id === expected.id);
}

try {
  db.connection.exec("INSERT INTO projects(id,name,created_at,updated_at) VALUES ('p1','Project One',1,1),('p2','Project Two',1,1)");
  workspace("root");
  workspace("child", "root");
  workspace("grandchild", "child");
  workspace("sibling", "root");
  workspace("external");
  workspace("referenced");
  task("combined", "p1", "child");
  task("work-only", null, "child");
  task("root-task", null, "root");
  task("standalone", null, null);
  task("project-only", "p1", null);
  task("rebound", "p2", "sibling");

  const personal = library.ensureOwnedSpace({ type: "personal" });
  const p1 = library.createSpace({ name: "First project library", projectId: "p1" });
  const p1Second = library.createSpace({ name: "Second project library", projectId: "p1" });
  assert.equal(library.ensureOwnedSpace({ type: "project", projectId: "p1" }).id, p1.id, "existing project spaces reuse the first stable owner");
  const p2 = library.ensureOwnedSpace({ type: "project", projectId: "p2" });
  const ownedRoot = library.ensureOwnedSpace({ type: "workspace", workspaceId: "root" });
  const ownedChild = library.ensureOwnedSpace({ type: "workspace", workspaceId: "child" });
  const ownedGrandchild = library.ensureOwnedSpace({ type: "workspace", workspaceId: "grandchild" });
  const ownedSibling = library.ensureOwnedSpace({ type: "workspace", workspaceId: "sibling" });
  const external = library.ensureOwnedSpace({ type: "workspace", workspaceId: "external" });
  const referenced = library.ensureOwnedSpace({ type: "workspace", workspaceId: "referenced" });
  assert.equal(library.ensureOwnedSpace({ type: "workspace", workspaceId: "child" }).id, ownedChild.id, "workspace owner is lazy and idempotent");
  assert.equal(library.snapshot().spaces.find((space) => space.id === ownedChild.id)?.workspaceName, "child");
  assert.throws(() => library.createSpace({ name: "Conflicting ownership", projectId: "p1", workspaceId: "child" }), /归属/);
  assert.throws(() => library.ensureOwnedSpace({ type: "workspace", workspaceId: "missing" }), /不存在/);
  assert.throws(() => db.connection.prepare("UPDATE library_spaces SET project_id = 'p1' WHERE id = ?").run(ownedChild.id), /constraint/i, "database also enforces mutually exclusive owners");

  const privatePersonal = item(personal.id, "private personal");
  const attachedPersonal = item(personal.id, "attached personal");
  const pinnedPersonal = item(personal.id, "pinned personal");
  const sharedFolder = library.createCollection({ spaceId: personal.id, name: "Explicit shared folder" });
  const nestedFolder = library.createCollection({ spaceId: personal.id, parentId: sharedFolder.id, name: "Nested shared" });
  const sharedPersonal = item(personal.id, "folder reference", sharedFolder.id);
  const nestedPersonal = item(personal.id, "nested reference", nestedFolder.id);
  const projectItem = item(p1.id, "project owner");
  const projectSecondItem = item(p1Second.id, "second project owner");
  const otherProjectItem = item(p2.id, "other project");
  const inheritedItem = item(ownedRoot.id, "ancestor owner");
  const directItem = item(ownedChild.id, "current owner");
  const childItem = item(ownedGrandchild.id, "direct child opt in");
  const siblingItem = item(ownedSibling.id, "sibling hidden");
  const boundItem = item(external.id, "whole bound workspace");
  const referencedItem = item(referenced.id, "single referenced workspace");
  const referenceSibling = item(referenced.id, "unreferenced sibling asset");
  bindings.bindCollection("root", personal.id, sharedFolder.id);
  bindings.bind("root", external.id);
  bindings.bind("root", p2.id);
  library.attachToTask({ itemId: attachedPersonal.id, taskId: "combined" });
  library.attachToTask({ itemId: referencedItem.id, taskId: "combined" });
  db.connection.prepare("INSERT INTO project_context_pins(id,project_id,item_id,created_at) VALUES ('pin-personal','p1',?,1),('pin-other-project','p1',?,1)")
    .run(pinnedPersonal.id, otherProjectItem.id);
  assert.throws(() => library.attachToTask({ itemId: otherProjectItem.id, taskId: "combined" }), /跨项目/);

  const scope = library.resolveTaskScope("combined", "p2");
  assert.equal(scope.projectId, "p1", "persisted task project overrides fallback");
  assert.deepEqual([...scope.workspaceIds].sort(), ["child", "root"]);
  const visible = [projectItem, projectSecondItem, inheritedItem, directItem, boundItem, attachedPersonal, pinnedPersonal, sharedPersonal, nestedPersonal, referencedItem];
  const hidden = [privatePersonal, otherProjectItem, childItem, siblingItem, referenceSibling];
  const scopedItems = library.listItemsForTask("combined");
  for (const entry of visible) {
    assert(library.isItemVisibleInScope(entry, scope), `${entry.title} should be readable`);
    assert(hasItem(scopedItems, entry));
  }
  for (const entry of hidden) {
    assert.equal(library.isItemVisibleInScope(entry, scope), false, `${entry.title} must remain out of scope`);
    assert.equal(hasItem(scopedItems, entry), false);
  }
  assert(library.isSpaceVisibleInScope(personal, scope), "partial references expose container metadata");
  assert.equal(scope.readableSpaceIds.has(personal.id), false, "partial references do not expose the entire personal space");
  assert(library.isItemWritableInScope(projectItem, scope));
  assert(library.isItemWritableInScope(directItem, scope));
  for (const entry of [inheritedItem, boundItem, attachedPersonal, pinnedPersonal, nestedPersonal, referencedItem]) {
    assert.equal(library.isItemWritableInScope(entry, scope), false, "inheritance and references grant read only");
  }
  const searchIds = new Set(library.searchForTask("scopebodyneedle", "combined").map((entry) => entry.id));
  assert.deepEqual(searchIds, new Set(visible.map((entry) => entry.id)), "content search and direct reads share the same exact scope");
  const catalog = library.formatCatalog(100, { taskId: "combined" });
  assert(catalog.includes(inheritedItem.title) && catalog.includes(pinnedPersonal.title));
  assert(!catalog.includes(privatePersonal.title) && !catalog.includes(otherProjectItem.title));

  assert.equal(library.defaultSpaceForTask("combined").id, p1.id, "project is the preferred save owner");
  assert.equal(library.defaultSpaceForTask("work-only").id, ownedChild.id, "workspace is the next save owner");
  assert.equal(library.defaultSpaceForTask("standalone").id, personal.id, "standalone tasks save to personal");
  assert(hasItem(library.listItemsForTask("standalone"), privatePersonal));
  assert.equal(hasItem(library.listItemsForTask("project-only"), privatePersonal), false);
  assert.equal(library.resolveTaskScope("missing", "p1").defaultOwner, null, "unknown task cannot borrow a fallback project");
  assert.deepEqual(library.listItemsForTask("missing", "p1"), []);
  assert.throws(() => library.defaultSpaceForTask("missing", "p1"), /有效任务/);
  assert.equal(library.resolveTaskScope(undefined, null, { workspaceFallback: "missing" }).defaultOwner, null);
  assert.equal(library.resolveTaskScope(undefined, "p1").projectId, "p1");
  const draftScope = library.resolveTaskScope(undefined, null, { workspaceFallback: "child" });
  assert(library.isItemVisibleInScope(directItem, draftScope) && library.isItemVisibleInScope(inheritedItem, draftScope));
  assert.equal(library.isItemVisibleInScope(privatePersonal, draftScope), false, "a workspace draft does not preview unrelated personal files");
  const draftCatalog = library.formatCatalog(100, { workspaceId: "child" });
  assert(draftCatalog.includes(directItem.title) && draftCatalog.includes(inheritedItem.title));
  assert(!draftCatalog.includes(privatePersonal.title));
  assert.equal(library.resolveTaskScope("missing", "p1", { workspaceFallback: "child" }).visibleSpaceIds.size, 0, "an unknown task cannot borrow either preview fallback");
  assert.equal(library.resolveTaskScope("combined", "p2", { workspaceFallback: "external" }).workspaceId, "child", "a real task takes precedence over preview workspace fallback");
  workspace("lazy-owner");
  task("lazy-task", null, "lazy-owner");
  assert.equal(library.listWorkspaceSpaces("lazy-owner").length, 0);
  const lazyOwner = library.defaultSpaceForTask("lazy-task");
  assert.equal(lazyOwner.workspaceId, "lazy-owner");
  assert.equal(library.defaultSpaceForTask("lazy-task").id, lazyOwner.id);

  const extended = library.resolveTaskScope("combined", null, { additionalWorkspaceIds: ["grandchild", "sibling"] });
  assert(library.isItemVisibleInScope(childItem, extended), "explicit direct child can contribute read sources");
  assert.equal(library.isItemWritableInScope(childItem, extended), false);
  assert.equal(library.isItemVisibleInScope(siblingItem, extended), false);
  assert.equal(library.isItemVisibleInScope(childItem, library.resolveTaskScope("root-task", null, { additionalWorkspaceIds: ["grandchild"] })), false, "grandchildren cannot be requested directly");

  // Rebinding a task cannot preserve access to its former project through a stale explicit reference.
  library.attachToTask({ itemId: otherProjectItem.id, taskId: "rebound" });
  db.connection.prepare("UPDATE tasks SET project_id = 'p1' WHERE id = 'rebound'").run();
  assert.equal(hasItem(library.listItemsForTask("rebound"), otherProjectItem), false);
  assert.equal(library.listTaskReferences("rebound").items.length, 0);
  assert.equal(library.formatTaskAttachments("rebound"), null);

  // Owner search is restricted before ranking/limit and a reference can only narrow the real owner.
  const legacy = library.createSpace({ name: "Historical unowned space" });
  const legacyItem = item(legacy.id, "legacy personal entry");
  assert(hasItem(library.searchOwnedScope("scopeprobe", { type: "personal" }), legacyItem));
  assert.deepEqual(new Set(library.searchOwnedScope("scopeprobe", { type: "workspace", workspaceId: "child" }).map((entry) => entry.id)), new Set([directItem.id]));
  assert.deepEqual(new Set(library.searchOwnedScope("scopeprobe", { type: "personal" }, { spaceId: personal.id, collectionId: sharedFolder.id }).map((entry) => entry.id)), new Set([sharedPersonal.id, nestedPersonal.id]));
  assert.deepEqual(library.searchOwnedScope("scopeprobe", { type: "workspace", workspaceId: "child" }, { spaceId: personal.id }), []);
  assert.deepEqual(library.searchOwnedScope("scopeprobe", { type: "personal" }, { spaceId: personal.id, collectionId: "missing" }), []);
  assert.deepEqual(library.searchOwnedScope("scopeprobe", { type: "personal" }, { spaceId: personal.id, itemId: sharedPersonal.id }).map((entry) => entry.id), [sharedPersonal.id], "Owner-page item reference stays exact before search limits");
  assert.deepEqual(library.searchOwnedScope("scopeprobe", { type: "personal" }, { spaceId: personal.id, collectionId: sharedFolder.id, itemId: nestedPersonal.id }).map((entry) => entry.id), [nestedPersonal.id]);
  assert.deepEqual(library.searchOwnedScope("scopeprobe", { type: "personal" }, { spaceId: personal.id, itemId: directItem.id }), [], "Item reference cannot widen its owner");
  const spacesBeforeMissingSearch = library.listSpaces().length;
  assert.deepEqual(library.searchOwnedScope("scopeprobe", { type: "workspace", workspaceId: "unknown-owner" }), []);
  assert.equal(library.listSpaces().length, spacesBeforeMissingSearch);

  // Scoped artifact saves re-read the source task; an old renderer snapshot cannot widen the owner.
  new ArtifactRepository(db.connection);
  task("artifact-source", "p1", "child");
  const artifactFile = join(root, "owned-artifact.md");
  writeFileSync(artifactFile, "initial artifact payload");
  db.connection.prepare(`INSERT INTO artifacts(id,task_id,space_id,kind,source_type,entry_file,root_dir,version,capabilities_json,created_at,updated_at)
    VALUES ('owned-artifact','artifact-source','child','markdown','workspace-file',?,?,1,'{}',1,1)`).run(artifactFile, root);
  const itemCountBeforeRejectedSave = library.listAllItems().length;
  assert.throws(() => library.saveArtifact({ artifactId: "owned-artifact", spaceId: p2.id, owner: { type: "project", projectId: "p1" } }), /目标资料空间/);
  assert.throws(() => library.saveArtifact({ artifactId: "owned-artifact", spaceId: p2.id, owner: { type: "project", projectId: "p2" } }), /来源任务/);
  assert.throws(() => library.saveArtifact({ artifactId: "owned-artifact", spaceId: personal.id, owner: { type: "personal" } }), /来源任务/);
  assert.equal(library.listAllItems().length, itemCountBeforeRejectedSave, "rejected source/target owners create no library items");
  const savedArtifact = library.saveArtifact({ artifactId: "owned-artifact", spaceId: p1.id, owner: { type: "project", projectId: "p1" } });
  assert.equal(readFileSync(library.absolutePath(savedArtifact), "utf8"), "initial artifact payload");
  db.connection.prepare("UPDATE tasks SET project_id = 'p2', space_id = 'sibling' WHERE id = 'artifact-source'").run();
  writeFileSync(artifactFile, "changed after source task moved");
  assert.throws(() => library.saveArtifact({ artifactId: "owned-artifact", spaceId: p1.id, owner: { type: "project", projectId: "p1" } }), /来源任务/);
  assert.throws(() => library.saveArtifact({ artifactId: "owned-artifact", spaceId: ownedChild.id, owner: { type: "workspace", workspaceId: "child" } }), /来源任务/);
  assert.equal(readFileSync(library.absolutePath(savedArtifact), "utf8"), "initial artifact payload", "stale owner is rejected before refreshing an existing saved copy");
  assert.equal(library.listAllItems().length, itemCountBeforeRejectedSave + 1);
  assert.equal(library.saveArtifact({ artifactId: "owned-artifact", spaceId: ownedSibling.id, owner: { type: "workspace", workspaceId: "sibling" } }).sourceArtifactId, "owned-artifact", "workspace ownership uses the live task, not stale artifacts.space_id");
  db.connection.prepare("UPDATE tasks SET project_id = NULL WHERE id = 'artifact-source'").run();
  assert.throws(() => library.saveArtifact({ artifactId: "owned-artifact", spaceId: personal.id, owner: { type: "personal" } }), /来源任务/, "personal rejects tasks that still belong to a workspace");
  db.connection.prepare("UPDATE tasks SET space_id = NULL WHERE id = 'artifact-source'").run();
  assert.equal(library.saveArtifact({ artifactId: "owned-artifact", spaceId: personal.id, owner: { type: "personal" } }).sourceArtifactId, "owned-artifact");

  // Many out-of-scope, strongly matching documents must not consume the result limit.
  const precision = item(personal.id, "precise explicit reference", null, `precisionsearchterm ${"padding ".repeat(200)}`);
  library.attachToTask({ itemId: precision.id, taskId: "project-only" });
  for (let i = 0; i < 12; i += 1) item(personal.id, `hidden rank ${i}`, null, "precisionsearchterm");
  assert.deepEqual(library.retrieveInScope("precisionsearchterm", library.resolveTaskScope("project-only"), { limit: 1 }).map((hit) => hit.itemId), [precision.id]);
  assert.deepEqual(repo.searchChunks("precisionsearchterm", { spaceIds: new Set(), itemIds: new Set([precision.id]), limit: 1 }).map((hit) => hit.itemId), [precision.id]);
  assert.deepEqual(library.retrieve("precisionsearchterm", { itemIds: new Set([precision.id]), limit: 1 }).map((hit) => hit.itemId), [precision.id], "item-only query does not default back to all spaces");

  db.archiveSpace("external", true);
  assert(library.isItemVisibleInScope(boundItem, library.resolveTaskScope("combined")), "explicit archived sources remain readable as historical evidence");
  assert.equal(library.isItemWritableInScope(boundItem, library.resolveTaskScope("combined")), false);
  assert.throws(() => library.writeContent({ id: boundItem.id, content: "must not write" }), /归档/);
  db.archiveSpace("external", false);
  db.connection.prepare("UPDATE projects SET archived = 1 WHERE id = 'p1'").run();
  assert.equal(library.resolveTaskScope("combined").writableSpaceIds.size, 0, "archived project makes the entire task read only");
  assert.equal(library.isItemWritableInScope(directItem, scope), false, "cached scopes revalidate project archival");
  assert.throws(() => library.defaultSpaceForTask("combined"), /归档/);
  assert.throws(() => library.attachToTask({ itemId: privatePersonal.id, taskId: "combined" }), /归档/);
  assert.throws(() => library.detachFromTask({ itemId: attachedPersonal.id, taskId: "combined" }), /归档/);
  db.connection.prepare("UPDATE projects SET archived = 0 WHERE id = 'p1'").run();
  db.connection.exec("INSERT INTO projects(id,name,archived,created_at,updated_at) VALUES ('archived-empty','Archived without library',1,1,1)");
  task("archived-empty-task", "archived-empty", "child");
  assert.throws(() => library.defaultSpaceForTask("archived-empty-task"), /归档/);
  assert.equal(library.listProjectSpaces("archived-empty").length, 0, "default resolution cannot create a library for an archived project");

  // A workspace deletion must preserve owned documents and every task/binding until the user clears it.
  workspace("delete-leaf");
  const deleteOwner = library.ensureOwnedSpace({ type: "workspace", workspaceId: "delete-leaf" });
  const protectedItem = item(deleteOwner.id, "protected document");
  const protectedPath = library.absolutePath(protectedItem);
  assert(db.hasSpaceDeleteBlockers("delete-leaf"), "preflight blocks deletion before any dependent service side effects");
  assert.throws(() => db.deleteSpace("delete-leaf"), /自有资料/);
  assert(db.getSpace("delete-leaf") && library.getItem(protectedItem.id) && existsSync(protectedPath));
  assert.throws(() => db.deleteSpaceTree("root"), /自有资料/);
  assert.equal(db.getTask("combined")?.spaceId, "child", "failed tree deletion is atomic");
  assert(db.getSpace("root") && db.getSpace("child"));
  library.deleteItem(protectedItem.id);
  bindings.bind("delete-leaf", personal.id);
  bindings.bind("root", deleteOwner.id);
  db.deleteSpace("delete-leaf");
  assert.equal(library.getSpace(deleteOwner.id), null, "empty owner is cleaned up with its workspace");
  assert.equal(bindings.listByLibrarySpace(deleteOwner.id).length, 0);
  assert(library.getItem(privatePersonal.id), "deleting a workspace never deletes its referenced source");

  // Same-schema additive migration preserves files, item IDs, references, pins and collection structure.
  const migrationPath = join(root, "migration.db");
  const migrationLibraryRoot = join(root, "migration-library");
  let migrating = new AppDatabase(migrationPath);
  migrating.connection.exec("INSERT INTO projects(id,name,created_at,updated_at) VALUES ('mp','Migration Project',1,1); INSERT INTO spaces(id,name,created_at,updated_at) VALUES ('mw','Migration Workspace',1,1); INSERT INTO tasks(id,title,status,updated_at,project_id,space_id) VALUES ('mt','Migration Task','pending',1,'mp','mw')");
  let migrationLibrary = new LibraryService(migrating, { libraryRoot: migrationLibraryRoot });
  const oldOwner = migrationLibrary.createSpace({ name: "Existing library", projectId: "mp" });
  const oldFolder = migrationLibrary.createCollection({ spaceId: oldOwner.id, name: "Existing folder" });
  const oldItem = migrationLibrary.createItem({ spaceId: oldOwner.id, collectionId: oldFolder.id, kind: "markdown", title: "Existing preserved file" });
  migrationLibrary.writeContent({ id: oldItem.id, content: "unchanged migration payload" });
  migrationLibrary.attachToTask({ itemId: oldItem.id, taskId: "mt" });
  new WorkspaceLibraryBindingService(migrating).bindCollection("mw", oldOwner.id, oldFolder.id);
  migrating.connection.prepare("INSERT INTO project_context_pins(id,project_id,item_id,created_at) VALUES ('migration-pin','mp',?,1)").run(oldItem.id);
  const oldPath = migrationLibrary.absolutePath(oldItem);
  migrating.close();
  const raw = new Database(migrationPath);
  raw.exec("DROP INDEX uq_library_spaces_workspace; ALTER TABLE library_spaces DROP COLUMN workspace_id");
  assert.equal(raw.pragma("user_version", { simple: true }), CURRENT_DATABASE_SCHEMA_VERSION);
  raw.close();
  migrating = new AppDatabase(migrationPath);
  migrationLibrary = new LibraryService(migrating, { libraryRoot: migrationLibraryRoot });
  assert.equal(migrating.schemaVersion, CURRENT_DATABASE_SCHEMA_VERSION);
  assert.equal(migrationLibrary.getItem(oldItem.id)?.collectionId, oldFolder.id);
  assert.equal(readFileSync(oldPath, "utf8"), "unchanged migration payload");
  assert.equal(migrationLibrary.listTaskReferences("mt").items[0]?.id, oldItem.id);
  assert.equal(new WorkspaceLibraryBindingService(migrating).listCollectionsByWorkspace("mw")[0]?.collectionId, oldFolder.id);
  assert.equal((migrating.connection.prepare("SELECT item_id FROM project_context_pins WHERE id = 'migration-pin'").get() as { item_id: string }).item_id, oldItem.id);
  const newOwnerId = migrationLibrary.ensureOwnedSpace({ type: "workspace", workspaceId: "mw" }).id;
  migrating.close();
  migrating = new AppDatabase(migrationPath);
  migrationLibrary = new LibraryService(migrating, { libraryRoot: migrationLibraryRoot });
  assert.equal(migrationLibrary.ensureOwnedSpace({ type: "workspace", workspaceId: "mw" }).id, newOwnerId, "additive migration and lazy ownership stay idempotent after restart");
  assert.equal(migrationLibrary.ensureOwnedSpace({ type: "project", projectId: "mp" }).id, oldOwner.id);
  migrating.close();

  console.log("library owner scope: PASS (ownership, exact read/write grants, scoped FTS, archive/deletion safety, additive migration)");
} finally {
  db.close();
  rmSync(root, { recursive: true, force: true });
}
