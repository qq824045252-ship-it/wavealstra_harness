/** Real React lifecycle regression with controlled Library replies; no Electron/display required. */
import assert from "node:assert/strict";
import { parseHTML } from "linkedom";
import { act } from "react";
import type { Root } from "react-dom/client";
import type { LibraryContentDto, LibraryItemDto } from "../src/shared/library-ipc";
import type { ScopedLibraryOperations } from "../src/renderer/src/lib/scopedLibraryOperations";
import { libraryDraftKey, readLibraryDraft } from "../src/renderer/src/lib/libraryDraft";
import { useLibraryDocumentEditor } from "../src/renderer/src/components/pages/library/useLibraryDocumentEditor";

const { window: testWindow, document: testDocument } = parseHTML("<html><body></body></html>");
const entries = new Map<string, string>();
const storage = {
  getItem: (key: string) => entries.get(key) ?? null,
  setItem: (key: string, text: string) => { entries.set(key, text); },
  removeItem: (key: string) => { entries.delete(key); },
};
Object.assign(globalThis, { window: testWindow, document: testDocument, IS_REACT_ACT_ENVIRONMENT: true });
Object.defineProperty(testWindow, "sessionStorage", { value: storage, configurable: true });
const key = (id = "a") => libraryDraftKey("project:project-a", id);
const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
};
const documentItem = (id: string): LibraryContentDto => ({
  item: { id, spaceId: "project-a-library", collectionId: null, title: `Document ${id}`, filename: `${id}.md`, kind: "markdown",
    mimeType: "text/markdown", owner: "我", favorite: false, sizeBytes: 10, createdAt: 1, updatedAt: 1, lastVisitedAt: null },
  content: `Saved ${id}`,
});
let saved: LibraryItemDto[] = [];
let documents = new Map<string, LibraryContentDto>();
let read: (id: string) => Promise<LibraryContentDto>;
let write: (id: string, content: string) => Promise<LibraryItemDto>;
let access: ScopedLibraryOperations;
let itemId = "a";
let root: Root;
let editor!: ReturnType<typeof useLibraryDocumentEditor>;
function Harness() {
  editor = useLibraryDocumentEditor({ itemId, access, onSaved: (item) => saved.push(item) });
  return <span>{editor.payload?.item.id ?? "loading"}:{editor.draft}</span>;
}
const clone = <T,>(value: T): T => structuredClone(value);
const makeAccess = (readOnly = false) => ({
  scope: { type: "project", projectId: "project-a" }, readOnly,
  read: (id: string) => read(id),
  renameItem: async (id: string, title: string) => {
    const payload = documents.get(id)!;
    payload.item = { ...payload.item, title, updatedAt: payload.item.updatedAt + 1 };
    return clone(payload.item);
  },
  writeContent: (id: string, content: string) => write(id, content),
}) as unknown as ScopedLibraryOperations;
const render = async () => { await act(async () => { root.render(<Harness />); }); };
const edits = async (content: string, title?: string) => { await act(async () => { editor.setDraft(content); if (title) editor.setTitle(title); }); };
async function mount() {
  const { createRoot } = await import("react-dom/client");
  root = createRoot(testDocument.body.appendChild(testDocument.createElement("div")));
  await render();
}
async function reset() {
  if (root) await act(async () => root.unmount());
  entries.clear(); saved = []; itemId = "a";
  documents = new Map(["a", "b"].map((id) => [id, documentItem(id)]));
  read = async (id) => clone(documents.get(id)!);
  write = async (id, content) => {
    const payload = documents.get(id)!;
    payload.content = content;
    payload.item = { ...payload.item, updatedAt: payload.item.updatedAt + 1 };
    return clone(payload.item);
  };
  access = makeAccess();
  await mount();
}
async function test(name: string, run: () => Promise<void>) {
  await reset();
  await run();
  console.log(`PASS ${name}`);
}
async function main() {
  await test("save persists title/body and withdraws only the saved draft", async () => {
    await edits("New body", "New title");
    assert.equal(readLibraryDraft(storage, key())?.content, "New body");
    await act(async () => editor.save());
    assert.equal(editor.dirty, false);
    assert.equal(documents.get("a")!.item.title, "New title");
    assert.equal(documents.get("a")!.content, "New body");
    assert.equal(readLibraryDraft(storage, key()), null);
    assert.equal(saved.length, 1);
  });
  await test("failed body save retains draft after successful rename and can retry", async () => {
    await edits("Retry body", "Renamed");
    const persist = write;
    write = async () => { throw new Error("write failed"); };
    await act(async () => assert.rejects(editor.save(), /write failed/));
    assert.equal(editor.payload?.item.title, "Renamed");
    assert.equal(editor.dirty, true);
    assert.equal(editor.saving, false);
    assert.equal(readLibraryDraft(storage, key())?.content, "Retry body");
    write = persist;
    await act(async () => editor.save());
    assert.equal(editor.dirty, false);
    assert.equal(documents.get("a")!.content, "Retry body");
  });
  await test("switching readonly and back preserves the editable draft", async () => {
    await edits("Private unsaved body");
    access = makeAccess(true); await render();
    assert.equal(editor.draft, "Saved a");
    assert.equal(editor.dirty, false);
    assert.equal(readLibraryDraft(storage, key())?.content, "Private unsaved body");
    access = makeAccess(false); await render();
    assert.equal(editor.draft, "Private unsaved body");
    assert.equal(editor.dirty, true);
  });
  await test("switching documents cannot persist the old draft under the next item", async () => {
    await edits("Draft a");
    itemId = "b"; await render();
    assert.equal(editor.payload?.item.id, "b");
    assert.equal(editor.draft, "Saved b");
    assert.equal(readLibraryDraft(storage, key("b")), null);
    assert.equal(readLibraryDraft(storage, key())?.content, "Draft a");
  });
  await test("late read cannot replace the currently selected document", async () => {
    const pending = deferred<LibraryContentDto>();
    read = (id) => id === "b" ? pending.promise : Promise.resolve(clone(documents.get(id)!));
    itemId = "b"; await render();
    itemId = "a"; await render();
    await act(async () => pending.resolve(clone(documents.get("b")!)));
    assert.equal(editor.payload?.item.id, "a");
    assert.equal(editor.draft, "Saved a");
  });
  await test("save from an unmounted editor cannot erase a reopened, newer draft", async () => {
    await edits("First draft");
    const pending = deferred<LibraryItemDto>();
    write = () => pending.promise;
    let saving!: Promise<void>;
    await act(async () => { saving = editor.save(); });
    await act(async () => root.unmount());
    await mount();
    assert.equal(editor.draft, "First draft");
    await edits("Newer draft after reopening");
    await act(async () => { pending.resolve({ ...documents.get("a")!.item, updatedAt: 2 }); await saving; });
    assert.equal(editor.draft, "Newer draft after reopening");
    assert.equal(readLibraryDraft(storage, key())?.content, "Newer draft after reopening");
    assert.equal(saved.length, 0, "An old save must not refresh the new owner view");
  });
  await test("old save completion cannot unlock or clear a newer generation's save", async () => {
    await edits("Draft a");
    const pendingA = deferred<LibraryItemDto>(), pendingB = deferred<LibraryItemDto>();
    write = (id) => id === "a" ? pendingA.promise : pendingB.promise;
    let first!: Promise<void>, second!: Promise<void>;
    await act(async () => { first = editor.save(); });
    itemId = "b"; await render();
    assert.equal(editor.saving, false);
    await edits("Draft b");
    await act(async () => { second = editor.save(); });
    assert.equal(editor.saving, true);
    await act(async () => { pendingA.resolve({ ...documents.get("a")!.item, updatedAt: 2 }); await first; });
    assert.equal(editor.saving, true);
    await act(async () => { pendingB.resolve({ ...documents.get("b")!.item, updatedAt: 2 }); await second; });
    assert.equal(editor.saving, false);
    assert.equal(editor.draft, "Draft b");
    assert.deepEqual(saved.map((item) => item.id), ["b"]);
  });
  await act(async () => root.unmount());
  console.log("library document editor: PASS (7 React lifecycle regressions)");
}
void main().catch((error) => { console.error(error); process.exitCode = 1; });
