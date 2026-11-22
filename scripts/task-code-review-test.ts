import assert from "node:assert/strict";
import { existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import type { AssistantMessage, Message, Model, ToolCall } from "@earendil-works/pi-ai";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { CodeReviewService } from "../src/main/agent/CodeReviewService";
import { DurableBotService } from "../src/main/agent/durable/DurableBotService";
import { withCodeReviewLease } from "../src/main/agent/durable/DurableToolCoordination";
import { getCanbanReviewRuntime } from "../vendor/canban-review/runtime";
import type { CodeReviewChangedEvent } from "../src/shared/code-review";

const agentDir = mkdtempSync(join(tmpdir(), "mybuddy-code-review-"));
const cwd = join(agentDir, "workspace"), dbPath = join(agentDir, "app.db");
mkdirSync(cwd);
const pathOf = (file: string) => join(cwd, file);
const read = (file: string) => readFileSync(pathOf(file), "utf8");
const seed = (file: string, content: string) => writeFileSync(pathOf(file), content);
const task = "review-a", otherTask = "review-b";
const model: Model<"openai-completions"> = {
  id: "fixture", name: "Fixture", provider: "fixture", api: "openai-completions", reasoning: false,
  baseUrl: "http://fixture", input: ["text"], contextWindow: 128_000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};

let next: ToolCall | undefined;
const models = {
  getAuth: async () => undefined, getModel: () => model, getAvailable: async () => [model], refresh: async () => ({}),
  streamSimple: (_model: unknown, context: { messages: Message[] }) => {
    const stream = createAssistantMessageEventStream();
    const recent = context.messages.at(-1);
    if (recent?.role === "toolResult") assert.equal(recent.isError, false, JSON.stringify(recent.content));
    const item = recent?.role === "toolResult" ? undefined : next;
    const message: AssistantMessage = {
      role: "assistant", content: item ? [item] : [{ type: "text", text: "Complete" }],
      stopReason: item ? "toolUse" : "stop",
      model: model.id, provider: model.provider, api: model.api, timestamp: Date.now(),
      usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    };
    queueMicrotask(() => {
      stream.push({ type: "done", reason: item ? "toolUse" : "stop", message });
      stream.end();
    });
    return stream;
  },
} as unknown as ModelRuntime;

let db = new AppDatabase(dbPath);
for (const id of [task, otherTask]) db.upsertTask({ id, cwd, title: id, updatedAt: Date.now(), modelId: "fixture/fixture" });
const changes: CodeReviewChangedEvent[] = [];
let review = new CodeReviewService(db.connection, change => changes.push(change));
const bot = new DurableBotService({
  db, codeReview: review, models, agentDir, mcpDir: join(agentDir, "mcp"),
  resolveCwd: () => cwd, instructions: () => "", toolMode: () => "native",
  defaultModel: () => "fixture/fixture", emit: () => {},
});

let sequence = 0;
async function tool(name: string, args: ToolCall["arguments"], taskId = task) {
  const id = `code-review-${++sequence}`;
  next = { type: "toolCall", id, name, arguments: args };
  await bot.prompt({ taskId, text: name, userMessageId: `user-${id}`, assistantMessageId: `assistant-${id}` }, false);
}

const write = (file: string, content: string, taskId?: string) => tool("write", { path: file, content }, taskId);
const edit = (file: string, oldText: string, newText: string, taskId?: string) =>
  tool("edit", { path: file, edits: [{ oldText, newText }] }, taskId);
const find = (file: string, taskId = task) => {
  const row = review.list(taskId).find(item => item.path === file);
  assert(row, `missing review file ${file} for ${taskId}`);
  return row;
};
const decide = (action: "accept" | "reject", ids: string[], taskId = task) =>
  review.decide({ taskId, action, ids }, () => cwd, withCodeReviewLease);

try {
  assert.equal(review.pendingCount(task), 0);
  assert.equal(review.pendingCount(otherTask), 0);
  const original = "\ufeffbefore\r\npreserved dirty line\r\n";
  seed("existing.txt", original);
  await edit("existing.txt", "before", "first");
  assert.deepEqual(changes.at(-1), { taskId: task, pendingCount: 1 });
  const stale = find("existing.txt").id;
  await edit("existing.txt", "first", "second");
  assert.equal(review.pendingCount(task), 1);
  const current = find("existing.txt");
  assert.notEqual(current.id, stale);
  const currentDetail = await review.detail(task, current.id);
  assert(currentDetail?.patch);
  assert.equal(currentDetail.before, original);
  assert.equal(currentDetail.after, "\ufeffsecond\r\npreserved dirty line\r\n");
  assert.deepEqual(getCanbanReviewRuntime().parse(currentDetail.patch, current.path).hunks[0]?.lines, [
    { kind: "-", oldLine: 1, newLine: null, text: "\ufeffbefore" },
    { kind: "+", oldLine: null, newLine: 1, text: "\ufeffsecond" },
    { kind: " ", oldLine: 2, newLine: 2, text: "preserved dirty line" },
  ]);
  assert.deepEqual([current.kind, current.additions, current.deletions], ["modified", 1, 1]);
  assert.equal((await decide("reject", [stale])).results[0]?.status, "conflict");
  assert.match(read("existing.txt"), /second/);

  seed("deleted.txt", "unsaved original");
  if (process.platform === "win32") {
    await tool("powershell", { command: "Remove-Item -LiteralPath 'deleted.txt' -ErrorAction Stop" });
  } else {
    await tool("bash", { command: "rm -- deleted.txt" });
  }
  assert.equal(existsSync(pathOf("deleted.txt")), false);
  const deleted = find("deleted.txt");
  assert.equal(deleted.kind, "deleted");
  assert.equal((await review.detail(task, deleted.id))?.after, null);
  await write("nested/added.txt", "new file");
  const added = find("nested/added.txt");
  assert.equal(added.kind, "added");
  seed("manual.txt", "original");
  await write("manual.txt", "agent");
  const manual = find("manual.txt");
  seed("manual.txt", "user edited afterward");
  assert.deepEqual(changes.at(-1), { taskId: task, pendingCount: 4 });
  assert.deepEqual((await decide("reject", [manual.id, deleted.id, added.id, current.id])).results.map(result => result.status),
    ["conflict", "rejected", "rejected", "rejected"]);
  assert.deepEqual(changes.at(-1), { taskId: task, pendingCount: 1 });
  assert.equal(read("manual.txt"), "user edited afterward");
  assert.equal(read("deleted.txt"), "unsaved original");
  assert.equal(existsSync(pathOf("nested/added.txt")), false);
  assert.equal(read("existing.txt"), original);

  seed("accepted.txt", "original");
  await write("accepted.txt", "first change");
  const accepted = find("accepted.txt");
  assert.equal((await decide("accept", [accepted.id])).results[0]?.status, "accepted");
  assert.deepEqual(changes.at(-1), { taskId: task, pendingCount: 1 });
  assert.equal(read("accepted.txt"), "first change");
  await write("accepted.txt", "next change");
  assert.equal((await decide("reject", [find("accepted.txt").id])).results[0]?.status, "rejected");
  assert.equal(read("accepted.txt"), "first change");

  seed("shared.txt", "original");
  await write("shared.txt", "one");
  const first = find("shared.txt");
  await write("shared.txt", "two", otherTask);
  assert.deepEqual(changes.at(-1), { taskId: otherTask, pendingCount: 1 });
  assert.equal(review.pendingCount(task), 2);
  const second = find("shared.txt", otherTask);
  assert.equal((await decide("reject", [second.id])).results[0]?.status, "conflict");
  assert.equal((await decide("reject", [first.id])).results[0]?.status, "conflict");
  assert.equal(read("shared.txt"), "two");
  assert.equal((await decide("reject", [second.id], otherTask)).results[0]?.status, "rejected");
  assert.deepEqual(changes.at(-1), { taskId: otherTask, pendingCount: 0 });
  assert.equal(read("shared.txt"), "one");

  mkdirSync(pathOf("link-test"));
  seed("link-test/target.txt", "old");
  await write("link-test/target.txt", "agent");
  const link = find("link-test/target.txt");
  const newDirectory = join(agentDir, "unrelated");
  mkdirSync(newDirectory);
  writeFileSync(join(newDirectory, "target.txt"), "unrelated");
  renameSync(pathOf("link-test"), pathOf("original-folder"));
  symlinkSync(newDirectory, pathOf("link-test"), "junction");
  assert.equal((await decide("reject", [link.id])).results[0]?.status, "conflict");
  assert.equal(readFileSync(join(newDirectory, "target.txt"), "utf8"), "unrelated");
  assert(lstatSync(pathOf("link-test")).isSymbolicLink());

  const large = "line before\n" + "unchanged text\n".repeat(83_000);
  seed("large.txt", large);
  await edit("large.txt", "line before", "line after");
  const largeReview = find("large.txt");
  assert.equal(largeReview.canReject, true);
  assert.match((await review.detail(task, largeReview.id))?.reason ?? "", /512 KiB/);
  assert.equal((await decide("reject", [largeReview.id])).results[0]?.status, "rejected");
  assert.equal(read("large.txt"), large);

  seed("oversize.txt", "x".repeat(2 * 1024 * 1024 + 1));
  await write("oversize.txt", "changed without a complete backup");
  const oversize = find("oversize.txt");
  assert.equal(oversize.canReject, false);
  assert.equal(oversize.statsAvailable, false);
  assert.equal((await decide("reject", [oversize.id])).results[0]?.status, "unavailable");
  assert.equal((await decide("accept", [oversize.id])).results[0]?.status, "accepted");
  assert.equal(read("oversize.txt"), "changed without a complete backup");

  seed("reverted.txt", "original");
  const pendingBeforeWrite = review.pendingCount(task);
  await write("reverted.txt", "changed");
  assert.deepEqual(changes.at(-1), { taskId: task, pendingCount: pendingBeforeWrite + 1 });
  await write("reverted.txt", "original");
  assert.deepEqual(changes.at(-1), { taskId: task, pendingCount: pendingBeforeWrite });
} finally {
  await bot.close();
  db.close();
}

db = new AppDatabase(dbPath);
try {
  review = new CodeReviewService(db.connection);
  assert.equal(review.pendingCount(task), changes.at(-1)?.pendingCount);
  assert.equal(review.pendingCount(otherTask), 0);
  const reopened = find("existing.txt");
  assert.equal(reopened.status, "rejected");
  assert.equal((await decide("reject", [reopened.id])).results[0]?.status, "rejected");
  assert.equal(find("manual.txt").status, "pending");
  assert.match(find("manual.txt").reason ?? "", /手工修改/);
} finally { db.close(); }
console.log("PASS code review via native Durable tools, real files, task scope and SQLite reopen");
