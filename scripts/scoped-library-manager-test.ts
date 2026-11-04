import assert from "node:assert/strict";
import type { LibraryCollectionDto, LibraryItemDto, LibraryListRowDto, LibraryOwnerScope, LibrarySnapshotDto, LibrarySpaceDto } from "../src/shared/library-ipc";
import {
  isLibraryTaskOwnedBy, libraryMoveTargets, resolveScopedLibraryLink,
  scopedLibrarySearchRows, scopedLibrarySnapshot,
} from "../src/renderer/src/lib/scopedLibrary";
import { ScopedLibraryOperations, type ScopedLibraryApi } from "../src/renderer/src/lib/scopedLibraryOperations";
import { libraryDraftKey, readLibraryDraft, syncLibraryDraft } from "../src/renderer/src/lib/libraryDraft";

const space = (id: string, owner: Partial<LibrarySpaceDto> = {}): LibrarySpaceDto => ({ id, name: id, kind: "team", createdAt: 1, updatedAt: 1, ...owner });
const folder = (id: string, spaceId: string, parentId: string | null = null): LibraryCollectionDto => ({ id, spaceId, parentId, name: id, owner: "我", createdAt: 1, updatedAt: 1 });
const item = (id: string, spaceId: string, collectionId: string | null = null, filename = `${id}.md`): LibraryItemDto => ({
  id, spaceId, collectionId, filename, kind: "markdown", title: id, mimeType: "text/markdown", sizeBytes: 10,
  owner: "我", favorite: false, createdAt: 1, updatedAt: 1, lastVisitedAt: null, originalPath: `/original/${filename}`,
});
const row = (id: string, title = id): LibraryListRowDto => ({ id, source: "library", kind: "markdown", title, owner: "我", location: "global", updatedAt: 1 });
const project: LibraryOwnerScope = { type: "project", projectId: "project-a" };
const seed: LibrarySnapshotDto = {
  spaces: [space("personal", { kind: "personal" }), space("legacy"), space("project", { projectId: "project-a" }),
    space("other-project", { projectId: "project-b" }), space("workspace", { workspaceId: "workspace-a" }),
    space("invalid-dual-owner", { projectId: "project-a", workspaceId: "workspace-a" })],
  collections: [folder("reference", "project"), folder("nested", "project", "reference"), folder("sibling", "project"), folder("foreign-folder", "other-project")],
  items: [item("personal-document", "personal"), item("legacy-document", "legacy"), item("root", "project"),
    item("inside", "project", "reference"), item("descendant", "project", "nested", "data.csv"), item("outside", "project", "sibling"),
    item("foreign", "other-project", "foreign-folder"), item("workspace-document", "workspace"), item("invalid", "invalid-dual-owner")],
  recent: [row("inside"), row("foreign")],
  artifacts: [{ id: "artifact-a", taskId: "task-a", kind: "markdown", title: "本项目成果", owner: "我", location: "task-a", updatedAt: 1 },
    { id: "artifact-b", taskId: "task-b", kind: "markdown", title: "其他项目成果", owner: "我", location: "task-b", updatedAt: 1 }],
  storage: { usedBytes: 9999 }, ownerName: "我",
};

async function main() {
  const personal = scopedLibrarySnapshot(seed, { type: "personal" });
  assert.deepEqual(personal.spaces.map((entry) => entry.id), ["personal", "legacy"]);
  assert.deepEqual(personal.items.map((entry) => entry.id), ["personal-document", "legacy-document"]);
  assert.equal(personal.items[1].originalPath, seed.items[1].originalPath, "Legacy source metadata and IDs remain intact");
  const owned = scopedLibrarySnapshot(seed, project);
  assert.deepEqual(owned.spaces.map((entry) => entry.id), ["project"]);
  assert.equal(owned.storage.usedBytes, 40, "Global storage usage cannot reveal other owners");
  assert.deepEqual(owned.artifacts, [], "Task artifacts need a separate task-ownership filter");
  assert.deepEqual(scopedLibrarySnapshot(seed, { type: "workspace", workspaceId: "workspace-a" }).items.map((entry) => entry.id), ["workspace-document"]);
  const reference = { spaceId: "project", collectionId: "reference" };
  const referenced = scopedLibrarySnapshot(seed, project, reference);
  assert.deepEqual(referenced.items.map((entry) => entry.id), ["inside", "descendant"]);
  assert.deepEqual(referenced.collections.map((entry) => entry.id), ["reference", "nested"]);
  assert.deepEqual(referenced.recent.map((entry) => entry.id), ["inside"]);
  for (const invalid of [{ spaceId: "other-project" }, { spaceId: "project", collectionId: "foreign-folder" }, { spaceId: "project", itemId: "foreign" }]) {
    const filtered = scopedLibrarySnapshot(seed, project, invalid);
    assert.equal(filtered.spaces.length + filtered.collections.length + filtered.items.length, 0, "Invalid references must not fall back to the whole owner");
  }
  const pinned = scopedLibrarySnapshot(seed, project, { spaceId: "project", itemId: "descendant" });
  assert.deepEqual(pinned.items.map((entry) => entry.id), ["descendant"]);
  assert.deepEqual(pinned.collections, [], "A single-item pin does not expose sibling/ancestor folder metadata");
  const found = scopedLibrarySearchRows(referenced, "body-only-match", [row("inside", "untrusted result title"), row("foreign")]);
  assert.deepEqual(found.map((entry) => [entry.id, entry.title]), [["inside", "inside"]]);
  const folderRow: LibraryListRowDto = { ...row("reference"), kind: "folder", spaceId: "project" };
  assert.deepEqual(libraryMoveTargets(owned, folderRow).map((entry) => entry.id), ["sibling"]);
  assert.equal(resolveScopedLibraryLink(referenced, "inside", "./data.csv"), "descendant");
  assert.equal(resolveScopedLibraryLink(referenced, "inside", "mybuddy-library://local/descendant/"), "descendant");
  assert.throws(() => resolveScopedLibraryLink(referenced, "inside", "mybuddy-library://local/outside/"));
  assert.throws(() => resolveScopedLibraryLink(referenced, "inside", "outside.md"));
  assert.throws(() => resolveScopedLibraryLink(referenced, "inside", "javascript:alert(1)"));
  assert(isLibraryTaskOwnedBy({ projectId: "project-a", spaceId: "workspace-a" }, project));
  assert(isLibraryTaskOwnedBy({ projectId: "project-a", spaceId: "workspace-a" }, { type: "workspace", workspaceId: "workspace-a" }));
  assert(!isLibraryTaskOwnedBy({ spaceId: "workspace-a" }, { type: "personal" }));
  assert(isLibraryTaskOwnedBy({}, { type: "personal" }));

  let current = structuredClone(seed);
  const calls: Array<{ method: string; request?: any }> = [];
  const call = (method: string, request?: any): void => { calls.push({ method, request }); };
  const api = {
    snapshot: async () => structuredClone(current),
    ensureOwnedSpace: async (owner: LibraryOwnerScope) => {
      call("ensure", owner);
      const existing = scopedLibrarySnapshot(current, owner).spaces[0];
      if (existing) return { ok: true, value: existing };
      const created = space("new-workspace", { workspaceId: owner.type === "workspace" ? owner.workspaceId : undefined });
      current.spaces.push(created); return { ok: true, value: created };
    },
    createItem: async (request: any) => { call("create", request); const created = item("new-item", request.spaceId, request.collectionId); current.items.push(created); return { ok: true, value: created }; },
    createCollection: async (request: any) => { call("create-folder", request); const created = folder("new-folder", request.spaceId, request.parentId); current.collections.push(created); return { ok: true, value: created }; },
    updateItem: async (request: any) => { call("update", request); const entry = current.items.find((value) => value.id === request.id)!; Object.assign(entry, request); return { ok: true, value: entry }; },
    writeContent: async (request: any) => { call("write", request); return { ok: true, value: current.items.find((entry) => entry.id === request.id) }; },
    deleteItem: async (id: string) => { call("delete", id); current.items = current.items.filter((entry) => entry.id !== id); return { ok: true }; },
    renameCollection: async (request: any) => { call("rename-folder", request); return { ok: true, value: current.collections.find((entry) => entry.id === request.id) }; },
    moveCollection: async (request: any) => { call("move-folder", request); return { ok: true, value: current.collections.find((entry) => entry.id === request.id) }; },
    deleteCollection: async (id: string) => { call("delete-folder", id); return { ok: true }; },
    favorite: async (request: any) => { call("favorite", request); return { ok: true, value: current.items.find((entry) => entry.id === request.id) }; },
    readContent: async (id: string) => { call("read", id); return { ok: true, value: { item: structuredClone(current.items.find((entry) => entry.id === id)!), content: "body" } }; },
    markVisited: async (id: string) => { call("visited", id); return { ok: true, value: current.items.find((entry) => entry.id === id) }; },
    search: async (request: any) => { call("search", request); return [row("inside"), row("foreign")]; },
    saveArtifact: async (request: any) => { call("save-artifact", request); return { ok: true, value: item("saved-artifact", request.spaceId, request.collectionId) }; },
    showInFolder: async (id: string) => { call("show", id); return { ok: true }; },
    pickAndImport: async (request: any) => { call("import", request); return { ok: true, value: [] }; },
  } as unknown as ScopedLibraryApi;
  const access = new ScopedLibraryOperations(() => api, project, undefined, false, () => new Set(["task-a"]));
  await access.snapshot();
  await access.search("body-only-match");
  assert.equal(calls.some((entry) => entry.method === "ensure"), false, "Opening/searching must not materialize a new library");
  assert.deepEqual(calls.find((entry) => entry.method === "search")?.request.owner, project, "Scope is passed to search before its limit is applied");
  await assert.rejects(() => access.read("foreign"));
  assert.equal(calls.some((entry) => entry.method === "read"), false, "A foreign item is rejected before content IO");
  await assert.rejects(() => access.createItem({ spaceId: "workspace", collectionId: null }, "markdown", "wrong"));
  await assert.rejects(() => access.renameItem("foreign", "wrong"));
  await assert.rejects(() => access.move({ id: "inside", kind: "markdown" }, "foreign-folder"));
  await assert.rejects(() => access.move({ id: "reference", kind: "folder" }, "nested"));
  assert.equal(calls.some((entry) => ["create", "update", "move-folder"].includes(entry.method)), false);
  await access.move({ id: "inside", kind: "markdown" }, "sibling");
  assert.equal(current.items.find((entry) => entry.id === "inside")?.collectionId, "sibling");
  await access.move({ id: "reference", kind: "folder" }, "sibling");
  assert.equal(calls.filter((entry) => entry.method === "move-folder").length, 1);

  const empty = new ScopedLibraryOperations(() => api, { type: "workspace", workspaceId: "empty" });
  await empty.snapshot();
  assert.equal(calls.some((entry) => entry.method === "ensure"), false);
  await empty.createItem({ spaceId: null, collectionId: null }, "markdown", "first");
  assert.deepEqual(calls.find((entry) => entry.method === "ensure")?.request, { type: "workspace", workspaceId: "empty" });
  assert.equal(calls.find((entry) => entry.method === "create")?.request.spaceId, "new-workspace");
  const corrupt = new ScopedLibraryOperations(() => ({ ...api, ensureOwnedSpace: async () => ({ ok: true, value: seed.spaces[3] }) }), { type: "workspace", workspaceId: "another-empty" });
  await assert.rejects(() => corrupt.createItem({ spaceId: null, collectionId: null }, "markdown", "wrong owner"));
  assert.equal(calls.filter((entry) => entry.method === "create").length, 1);

  current = structuredClone(seed);
  const readOnly = new ScopedLibraryOperations(() => api, project, reference);
  const before = calls.length;
  await assert.rejects(() => readOnly.createFolder({ spaceId: "project", collectionId: "reference" }, "no"));
  await assert.rejects(() => readOnly.writeContent("inside", "no"));
  await assert.rejects(() => readOnly.renameItem("inside", "no"));
  await assert.rejects(() => readOnly.renameFolder("reference", "no"));
  await assert.rejects(() => readOnly.move({ id: "inside", kind: "markdown" }, "nested"));
  await assert.rejects(() => readOnly.deleteItem("inside"));
  await assert.rejects(() => readOnly.deleteFolder("reference"));
  await assert.rejects(() => readOnly.favorite("inside", true));
  await assert.rejects(() => readOnly.importFiles({ spaceId: "project", collectionId: "reference" }));
  assert.equal(calls.length, before, "A reference view has no write path, even when callbacks are invoked directly");
  await readOnly.read("inside");
  assert.equal(calls.slice(before).filter((entry) => entry.method === "visited").length, 0);
  await assert.rejects(() => readOnly.read("outside"));
  assert.deepEqual((await readOnly.search("body-only-match")).rows.map((entry) => entry.id), ["inside"]);
  assert.deepEqual(calls.filter((entry) => entry.method === "search").at(-1)?.request.reference, reference);

  // The result projection must observe edits made while the search IPC is pending.
  // These use stale backend hits deliberately; the fresh scoped snapshot is authoritative.
  for (const change of ["deleted", "moved-out", "owner-changed", "joined", "renamed"] as const) {
    let searchState = structuredClone(seed);
    let finish!: (rows: LibraryListRowDto[]) => void;
    const delayed = new Promise<LibraryListRowDto[]>((resolve) => { finish = resolve; });
    const searchAccess = new ScopedLibraryOperations(() => ({ ...api,
      snapshot: async () => structuredClone(searchState), search: async () => delayed,
    }), project, reference);
    const pending = searchAccess.search(change === "joined" ? "outside" : change === "renamed" ? "body-only-match" : "inside");
    if (change === "deleted") searchState.items = searchState.items.filter((entry) => entry.id !== "inside");
    if (change === "moved-out") searchState.items.find((entry) => entry.id === "inside")!.collectionId = "sibling";
    if (change === "owner-changed") searchState.spaces.find((entry) => entry.id === "project")!.projectId = "project-b";
    if (change === "joined") searchState.items.find((entry) => entry.id === "outside")!.collectionId = "reference";
    if (change === "renamed") Object.assign(searchState.items.find((entry) => entry.id === "inside")!, { title: "fresh title", updatedAt: 2 });
    finish(change === "joined" ? [] : [row("inside", "stale title")]);
    const result = await pending;
    if (change === "joined") {
      assert.deepEqual(result.rows.map((entry) => entry.id), ["outside"], "A newly in-scope title match is visible even if the earlier search missed it");
      assert(result.snapshot.items.some((entry) => entry.id === "outside"), "Result navigation receives the same fresh item metadata");
    } else if (change === "renamed") {
      assert.deepEqual(result.rows.map((entry) => [entry.id, entry.title, entry.updatedAt]), [["inside", "fresh title", 2]]);
      assert.equal(result.snapshot.items.find((entry) => entry.id === "inside")?.title, "fresh title");
    } else {
      assert.deepEqual(result.rows, [], `${change}: stale hits and old title matches cannot restore an unavailable item`);
      assert(!result.snapshot.items.some((entry) => entry.id === "inside"), `${change}: navigation also excludes the removed item`);
    }
  }

  const readMethod = api.readContent;
  api.readContent = async (id) => {
    const payload = await readMethod(id);
    current.items.find((entry) => entry.id === id)!.collectionId = "sibling";
    return payload;
  };
  await assert.rejects(() => readOnly.read("inside"), /范围/);
  api.readContent = readMethod;
  await assert.rejects(() => access.renameItem("deleted", "new title"));
  assert.deepEqual((await access.artifacts()).map((entry) => entry.id), ["artifact-a"]);
  await assert.rejects(() => access.saveArtifact({ spaceId: "project", collectionId: null }, "artifact-b"));
  await access.saveArtifact({ spaceId: "project", collectionId: null }, "artifact-a");
  assert.equal(calls.filter((entry) => entry.method === "save-artifact").length, 1);
  assert.deepEqual(current.artifacts.map((entry) => entry.id), ["artifact-a", "artifact-b"], "Saving a library copy retains the source artifact");

  const entries = new Map<string, string>();
  const storage = { getItem: (key: string) => entries.get(key) ?? null, setItem: (key: string, text: string) => { entries.set(key, text); }, removeItem: (key: string) => { entries.delete(key); } };
  const key = libraryDraftKey("project:project-a", "inside");
  assert(syncLibraryDraft(storage, key, { title: "inside", content: "unsaved", baseUpdatedAt: 1 }));
  assert.equal(readLibraryDraft(storage, key)?.content, "unsaved", "An unmounted editor can recover its draft");
  assert.equal(readLibraryDraft(storage, libraryDraftKey("project:project-b", "inside")), null, "Drafts cannot cross owners");
  assert(syncLibraryDraft(storage, key, null));
  assert.equal(readLibraryDraft(storage, key), null, "Manually restoring saved content withdraws the old draft");
  console.log("scoped library manager: PASS (owner/reference isolation, checked CRUD, lazy ownership, source retention, scoped links, readonly, fresh deferred search, draft withdrawal)");
}

void main().catch((error) => { console.error(error); process.exitCode = 1; });
