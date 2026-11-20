import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, readFile, readdir, rmdir, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ArtifactService } from "../src/main/artifact/ArtifactService";
import { createOfficeDocument } from "../src/main/office-use/OfficeDocumentCreation";
import {
  bindOfficeSelection,
  createOfficeSelectionExtension,
} from "../src/main/office-use/OfficeSelectionTools";
import { isMyBuddyNativeExtensionToolName } from "../src/shared/native-tools";

function toolsFor(taskId: string, readonly = false, isEnabled = () => true,
  create?: Parameters<typeof createOfficeSelectionExtension>[0]["create"]) {
  const tools = new Map<string, ToolDefinition>();
  createOfficeSelectionExtension({
    taskId,
    getPermissionMode: () => readonly ? "readonly" : "default",
    isEnabled,
    create,
  })({ registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool) } as unknown as ExtensionAPI);
  const run = (name: string, params: object, signal?: AbortSignal) =>
    tools.get(name)!.execute("test", params, signal, undefined, {} as never);
  return {
    create: (path: string) => run("office_document_create", { path }),
    document: (params: object) => run("office_document_read", params),
    review: (proposalId: string) => run("office_review_status", { proposalId }),
    read: (target?: object) => run("office_selection_read", target ? { target } : {}),
    propose: (captureId: string, text: string) => run("office_selection_propose", { captureId, text }),
  };
}

test("creates all three blank formats as task artifacts and protects existing files", async () => {
  const root = await mkdtemp(join(tmpdir(), "mybuddy-office-create-"));
  const registrations: string[] = [];
  const artifacts = { register: async ({ title }: { title: string }) => {
    registrations.push(title);
    return { id: title };
  } } as unknown as ArtifactService;
  const create: NonNullable<Parameters<typeof createOfficeSelectionExtension>[0]["create"]> = (request, toolCallId, assertWritable) =>
    createOfficeDocument(request, { taskId: "create-fixture", taskRoot: root, toolCallId, artifacts, assertWritable });
  const task = toolsFor("create-fixture", false, () => true, create);
  const readonly = toolsFor("create-fixture", true, () => true, create);
  const disabled = toolsFor("create-fixture", false, () => false, create);
  try {
    assert.equal((await readonly.create("readonly.docx")).isError, true);
    assert.equal((await disabled.create("disabled.docx")).isError, true);
    assert.equal((await task.create("../outside.docx")).isError, true);
    assert.deepEqual(await readdir(root), []);
    const formats = { "blank.docx": "word/document.xml", "blank.xlsx": "xl/worksheets/sheet1.xml", "blank.pptx": "ppt/slides/slide1.xml" };
    for (const [name, part] of Object.entries(formats)) {
      const result = response(await task.create(name));
      assert.equal(result.artifactId, name);
      const bytes = await readFile(join(root, name));
      assert((await JSZip.loadAsync(bytes)).file(part));
      assert.equal((await task.create(name)).isError, true);
      assert.deepEqual(await readFile(join(root, name)), bytes);
    }
    assert.deepEqual(registrations, Object.keys(formats));
  } finally {
    for (const name of await readdir(root)) await unlink(join(root, name));
    await rmdir(root);
  }
});

function response(result: Awaited<ReturnType<ReturnType<typeof toolsFor>["read"]>>) {
  const item = result.content[0];
  assert.equal(item.type, "text");
  return JSON.parse(item.text);
}

test("a saved switch blocks all Office tools in an already registered task", async () => {
  let enabled = true;
  const task = toolsFor("task-office-switch", false, () => enabled);
  let reads = 0;
  const reviews: string[] = [];
  const stop = bindOfficeSelection("task-office-switch", "view", {
    read: async () => assert.fail("a disabled tool must not reach the view"),
    select: async () => ({ captureId: ++reads, content: "selected text", target: { kind: "word" } }),
    propose: async (_id, text) => { reviews.push(text); },
  });
  try {
    const previous = response(await task.read());
    enabled = false;
    assert.equal((await task.document({ action: "inspect" })).isError, true);
    assert.equal((await task.read()).isError, true);
    assert.equal((await task.propose(previous.captureId, "blocked")).isError, true);
    assert.equal(reads, 1);
    assert.deepEqual(reviews, []);
    enabled = true;
    const fresh = response(await task.read());
    assert.equal((await task.propose(fresh.captureId, "approved for review")).isError, undefined);
    assert.deepEqual(reviews, ["approved for review"]);
  } finally {
    stop();
  }
});

test("routes only to the current task, and stages an edit for review", async () => {
  const task = toolsFor("task-a");
  const other = toolsFor("task-b");
  const reviews: unknown[][] = [];
  const stop = bindOfficeSelection("task-a", "view", {
    read: async (query) => ({ query, items: [{ blockIndex: 9, preview: "unsaved text" }] }),
    select: async () => ({ captureId: 1, content: "selected text", target: { kind: "word" } }),
    propose: async (...args) => { reviews.push(args); },
    review: async proposalId => reviews.some(args => args[2] === proposalId) ? { proposalId, status: "awaiting-user-review" } : null,
  });
  try {
    assert(isMyBuddyNativeExtensionToolName("office_document_read"));
    assert(isMyBuddyNativeExtensionToolName("office_selection_read"));
    assert(isMyBuddyNativeExtensionToolName("office_selection_propose"));
    assert.equal((await other.read()).isError, true);
    assert.equal((await other.document({ action: "inspect" })).isError, true);
    const query = { action: "find", query: "unsaved" };
    assert.deepEqual(response(await toolsFor("task-a", true).document(query)), { query, items: [{ blockIndex: 9, preview: "unsaved text" }] });
    assert.equal((await toolsFor("task-a", true).read({ kind: "word", blockIndex: 9, text: "unsaved text" })).isError, true);
    const selection = response(await task.read());
    assert.equal(selection.content, "selected text");
    assert.deepEqual(selection.target, { kind: "word" });
    assert.notEqual(selection.captureId, 1);
    await task.document({ action: "inspect" });
    assert.equal((await other.propose(selection.captureId, "blocked")).isError, true);
    assert.equal((await toolsFor("task-a", true).propose(selection.captureId, "blocked")).isError, true);
    assert.deepEqual(reviews, []);
    const pending = response(await task.propose(selection.captureId, "replacement"));
    assert.equal(pending.status, "awaiting-user-review");
    assert.match(pending.proposalId, /^[0-9a-f-]{36}$/u);
    assert.deepEqual(reviews, [[1, "replacement", pending.proposalId]]);
    assert.deepEqual(response(await task.review(pending.proposalId)), pending);
    assert.equal((await other.review(pending.proposalId)).isError, true);
    assert.equal((await task.propose(selection.captureId, "repeat")).isError, true);
  } finally {
    stop();
  }
});

test("rejects ambiguous bindings and a capture from a closed or replaced view", async () => {
  const task = toolsFor("task-overlap");
  const ports = {
    read: async () => ({}),
    select: async () => ({ captureId: "1", content: "text", target: {} }),
    propose: async () => { assert.fail("stale proposal must not reach the view"); },
  };
  const stop = bindOfficeSelection("task-overlap", "view-1", ports);
  const other = bindOfficeSelection("task-overlap", "view-2", ports);
  try {
    assert.equal((await task.read()).isError, true);
    other();
    const selection = response(await task.read());
    const replace = bindOfficeSelection("task-overlap", "view-1", ports);
    try {
      stop();
      assert.equal((await task.propose(selection.captureId, "wrong")).isError, true);
      assert.equal(response(await task.read()).content, "text");
    } finally {
      replace();
    }
  } finally {
    stop();
    other();
  }
});

test("drops a delayed capture if its Office view closes while reading", async () => {
  const task = toolsFor("task-close");
  let finish!: (value: unknown) => void;
  const stop = bindOfficeSelection("task-close", "view-1", {
    read: async () => ({}),
    select: () => new Promise(resolve => { finish = resolve; }),
    propose: async () => assert.fail("closed view must receive no proposals"),
  });
  const reading = task.read();
  stop();
  finish({ captureId: 1, content: "old text", target: {} });
  assert.equal((await reading).isError, true);
});

test("returns readable format boundaries without forwarding a replacement proposal", async () => {
  const task = toolsFor("task-mixed-format");
  const stop = bindOfficeSelection("task-mixed-format", "view", {
    read: async () => ({}),
    select: async () => ({
      captureId: "1", content: "Plain and bold", target: { kind: "word", offset: 0 },
      editable: false, reason: "Selection spans character formatting.",
    }),
    propose: async () => assert.fail("non-editable selection must receive no proposals"),
  });
  try {
    const selection = response(await task.read());
    assert.equal(selection.content, "Plain and bold");
    assert.equal(selection.editable, false);
    assert.equal(selection.reason, "Selection spans character formatting.");
    assert.equal((await task.propose(selection.captureId, "wrong")).isError, true);
  } finally {
    stop();
  }
});
