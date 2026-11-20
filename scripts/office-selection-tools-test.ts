import assert from "node:assert/strict";
import { test } from "node:test";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import {
  bindOfficeSelection,
  createOfficeSelectionExtension,
} from "../src/main/office-use/OfficeSelectionTools";
import { isMyBuddyNativeExtensionToolName } from "../src/shared/native-tools";

function toolsFor(taskId: string, readonly = false, isEnabled = () => true) {
  const tools = new Map<string, ToolDefinition>();
  createOfficeSelectionExtension({
    taskId,
    getPermissionMode: () => readonly ? "readonly" : "default",
    isEnabled,
  })({ registerTool: (tool: ToolDefinition) => tools.set(tool.name, tool) } as unknown as ExtensionAPI);
  const run = (name: string, params: object, signal?: AbortSignal) =>
    tools.get(name)!.execute("test", params, signal, undefined, {} as never);
  return {
    document: (params: object) => run("office_document_read", params),
    read: (target?: object) => run("office_selection_read", target ? { target } : {}),
    propose: (captureId: string, text: string) => run("office_selection_propose", { captureId, text }),
  };
}

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
    assert.deepEqual(response(await task.propose(selection.captureId, "replacement")), {
      status: "awaiting-user-review",
    });
    assert.deepEqual(reviews, [[1, "replacement"]]);
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
