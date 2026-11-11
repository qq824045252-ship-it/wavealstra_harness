import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Cursor, EntryQuery, EntryRecord, SubmissionRecord, ToolExecutionApi } from "@earendil-works/pi-durable";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { readDurableWorkExecution } from "../src/main/agent/durable/DurableWorkExecutionProjection";
import { BotConversationRepository } from "../src/main/agent/work/BotConversationRepository";
import { botForegroundTools } from "../src/main/agent/work/BotForegroundTools";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkConversationFeedback } from "../src/main/agent/work/WorkConversationFeedback";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import type { AgentSubmissionReceipt } from "../src/shared/agent-ipc";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkActor, type WorkControlResult } from "../src/shared/bot-work";

const root = mkdtempSync(join(tmpdir(), "bot-work-milestones-"));
const dbPath = join(root, "app.db");
let db = new AppDatabase(dbPath);
const user: WorkActor = { kind: "user", userId: LOCAL_USER_ID, grants: DESKTOP_USER_GRANTS };
const open = () => {
  const bots = new BotRegistry(db.connection);
  bots.ensureDefaultBot(LOCAL_USER_ID);
  const works = new WorkService(db.connection, { bots });
  const messages = new BotConversationRepository(db.connection);
  const feedback = new WorkConversationFeedback({ db: db.connection, userId: LOCAL_USER_ID, works, isAuthority: () => true });
  return { bots, works, messages, feedback };
};
let { bots, works, messages, feedback } = open();
let serial = 0;
const operation = () => `milestone-${++serial}`;
const unwrap = (result: WorkControlResult) => {
  if (!result.ok) throw new Error(`${result.code}: ${result.message}`);
  return result.work;
};
const fileA = join(root, "read-a.txt");
const fileB = join(root, "read-b.txt");
const fileC = join(root, "report.txt");
writeFileSync(fileA, "文件甲正文");
writeFileSync(fileB, "文件乙正文");
writeFileSync(fileC, "综合报告草稿");
const snapshotA = join(root, "artifacts", "read-a.v1.txt");
const snapshotC = join(root, "artifacts", "report.v1.txt");

const assistant = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"] = "stop"): AssistantMessage => ({
  role: "assistant", content, stopReason, api: "openai-completions", model: "fixture", provider: "fixture", timestamp: 1,
  usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});
const entry = (id: number, conversationId: number, model: EntryRecord["model"] = []): EntryRecord => ({
  id: id as EntryRecord["id"], conversationId: conversationId as EntryRecord["conversationId"], kind: "pi.assistant", model,
});
const userEntry = (id: number): EntryRecord => ({ ...entry(id, 1, [{ role: "user", content: "请执行计划", timestamp: id }]), kind: "pi.user" });
const persisted = (entries: EntryRecord[]) => ({
  scanEntries: async (query: EntryQuery, limit: number, cursor?: Cursor) => {
    const selected = entries.filter(item => item.conversationId === query.conversationId
      && item.id >= (query.minEntryId ?? 0) && item.id <= (query.maxEntryId ?? Infinity))
      .sort((left, right) => query.order === "ascending" ? left.id - right.id : right.id - left.id);
    const offset = typeof cursor?.offset === "number" ? cursor.offset : 0;
    const end = offset + limit;
    return { items: selected.slice(offset, end), next: end < selected.length ? { offset: end } : undefined };
  },
});
const placed = (input: number): SubmissionRecord => ({ type: "input", status: "placed",
  id: 9 as SubmissionRecord["id"], requestId: "original-operation",
  conversationId: 1 as SubmissionRecord["conversationId"], entry: input as EntryRecord["id"] });
const completed = (input: number, answer: number): SubmissionRecord => ({ type: "input", status: "done",
  id: 9 as SubmissionRecord["id"], requestId: "original-operation",
  conversationId: 1 as SubmissionRecord["conversationId"], entry: input as EntryRecord["id"], answer: answer as EntryRecord["id"] });

const plan = [
  { itemId: "read-a", task: "读取甲文件", required: true },
  { itemId: "read-b", task: "读取乙文件", required: true },
  { itemId: "read-c", task: "读取丙文件", required: true },
  { itemId: "report", task: "生成综合报告", required: true },
  { itemId: "never", task: "等待前置条件", required: false },
];
const result = (itemId: string, extra: Record<string, unknown>) => ({ subagentId: itemId,
  task: plan.find(item => item.itemId === itemId)!.task, workspace: { cwd: root, kind: "shared" as const }, ...extra });
const runningEntries = [
  userEntry(10),
  entry(11, 1, [assistant([{ type: "toolCall", id: "subagent-1", name: "subagent", arguments: { items: plan.map(item => item.itemId) } }], "toolUse")]),
  entry(12, 1, [{ role: "toolResult", toolCallId: "subagent-1", toolName: "subagent", content: [], isError: false, timestamp: 12,
    details: { plan, results: [
      result("read-a", { status: "completed", exitCode: 0, artifactRefs: [fileA],
        messages: [{ role: "assistant", content: [{ type: "text", text: "已读取甲文件，结论 A 可用" }] }] }),
      result("read-b", { status: "completed", exitCode: 0, artifactRefs: [fileB],
        messages: [{ role: "assistant", content: [{ type: "text", text: "已读取乙文件，结论 B 可用" }] }] }),
      result("read-c", { status: "failed", exitCode: 1, errorMessage: "读取丙文件失败：没有读取权限" }),
      result("report", { status: "running", exitCode: 0 }),
    ] } } as never]),
];
const completedEntries = [
  userEntry(10),
  entry(11, 1, [assistant([{ type: "toolCall", id: "subagent-1", name: "subagent", arguments: { items: plan.map(item => item.itemId) } }], "toolUse")]),
  entry(12, 1, [{ role: "toolResult", toolCallId: "subagent-1", toolName: "subagent", content: [], isError: false, timestamp: 12,
    details: { plan, results: [
      result("read-a", { status: "completed", exitCode: 0, artifactRefs: [fileA],
        messages: [{ role: "assistant", content: [{ type: "text", text: "已读取甲文件，结论 A 可用" }] }] }),
      result("read-b", { status: "completed", exitCode: 0, artifactRefs: [fileB],
        messages: [{ role: "assistant", content: [{ type: "text", text: "已读取乙文件，结论 B 可用" }] }] }),
      result("read-c", { status: "failed", exitCode: 1, errorMessage: "读取丙文件失败：没有读取权限" }),
      result("report", { status: "completed", exitCode: 0, artifactRefs: [fileC],
        messages: [{ role: "assistant", content: [{ type: "text", text: "综合报告草稿已生成" }] }] }),
    ] } } as never]),
  entry(20, 1, [assistant([{ type: "text", text: "全部子项已返回：甲、乙可用，丙失败，综合报告草稿已生成" }])]),
];

try {
  const source = messages.accept(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID, requestId: "source", text: "后台执行，并先把能用的部分给我" });
  messages.update(source.assistantMessageId, "completed", "已开始处理");
  const created = unwrap(works.createWork(user, { operationId: operation(), title: "里程碑回流", ownerBotId: DEFAULT_BOT_ID,
    inputSnapshotId: "input-A", conversationId: source.conversationId, sourceMessageId: source.userMessageId,
    authorization: DESKTOP_USER_GRANTS, criteria: [{ id: "verified", text: "成果已核验" }] }));
  messages.linkWork(messages.receipt(LOCAL_USER_ID, DEFAULT_BOT_ID, "source")!, created.workId);
  const taskId = operation();
  const dispatched = unwrap(works.dispatchExecution(user, { operationId: operation(), workId: created.workId, botId: DEFAULT_BOT_ID,
    taskId, durableStoreKey: `store:${taskId}`, conversationId: `native:${taskId}`, workspaceBinding: root }));
  const binding = works.repo.getBinding(dispatched.activeExecutionIds.at(-1)!)!;
  works.transaction(() => works.generatedArtifacts.record(binding, [
    { path: fileA, snapshotPath: snapshotA, digest: "a".repeat(64), sizeBytes: 12, registeredAt: 1, sourceEntryId: 12 },
    { path: fileB, digest: "b".repeat(64), sizeBytes: 12, registeredAt: 1, sourceEntryId: 12 },
    { path: fileC, snapshotPath: snapshotC, digest: "c".repeat(64), sizeBytes: 18, registeredAt: 1, sourceEntryId: 12 },
  ]));
  const receipt: AgentSubmissionReceipt = { taskId: binding.taskId, operationId: binding.operationId, submissionId: 1, status: "placed" };

  // (a) A still-queued root input exposes its verified subitems, with stable ids.
  const running = await readDurableWorkExecution(persisted(runningEntries), placed(10), root);
  assert.equal(running.status, "running");
  if (running.status !== "running") throw new Error("expected a running observation");
  assert.deepEqual(running.subitems?.map(item => item.itemId),
    ["subagent-1:read-a", "subagent-1:read-b", "subagent-1:read-c"], "only terminal item outcomes become in-flight facts");
  assert.deepEqual(running.subitems?.map(item => item.outcome), ["completed", "completed", "failed"]);
  assert.deepEqual(running.subitems?.[0].artifactRefs, [fileA]);
  const replay = await readDurableWorkExecution(persisted(runningEntries), placed(10), root);
  assert.deepEqual(replay.status === "running" ? replay.subitems : undefined, running.subitems, "re-polling yields the same facts, not new ones");

  // The bounded window keeps the newest completions instead of starving them.
  const capPlan = Array.from({ length: 50 }, (_, index) => ({ itemId: `item-${index}`, task: `任务 ${index}` }));
  const capResults = capPlan.map((item, index) => ({ subagentId: item.itemId, status: index < 45 ? "completed" : "running", exitCode: 0 }));
  const capEntries = [userEntry(100), entry(101, 1, [assistant([{ type: "toolCall", id: "cap", name: "subagent", arguments: {} }], "toolUse")]),
    entry(102, 1, [{ role: "toolResult", toolCallId: "cap", toolName: "subagent", content: [], isError: false, timestamp: 102,
      details: { plan: capPlan, results: capResults } } as never])];
  const capped = await readDurableWorkExecution(persisted(capEntries), placed(100));
  assert.equal(capped.status, "running");
  if (capped.status !== "running") throw new Error("expected a running observation");
  assert.equal(capped.subitems?.length, 40, "in-flight subitems stay bounded");
  assert.deepEqual(capped.subitems?.map(item => item.itemId), capPlan.slice(5, 45).map(item => `cap:${item.itemId}`),
    "the newest verified window is kept and unknown/not_started outcomes are excluded");

  // (b) The existing ingest chain persists those items and the projection reads them back.
  assert.deepEqual(works.nativeResults.receive(binding, receipt, running), []);
  assert.equal(works.repo.getBinding(binding.bindingId)?.status, "running");
  assert.equal(works.repo.listDeliverables(created.workId).filter(item => item.deliverableId.startsWith("partial:")).length, 2,
    "each verified completed item has one partial deliverable fact");
  const projection = works.getProjection(created.workId)!;
  const milestones = projection.phase3?.milestones;
  assert(milestones, "the detail projection exposes milestones");
  if (!milestones) throw new Error("expected milestones");
  assert.equal(milestones.intentRevision, projection.intentRevision);
  assert.equal(milestones.inputSnapshotId, projection.inputSnapshotId);
  assert.deepEqual(milestones.ready.map(item => item.itemId).sort(), ["subagent-1:read-a", "subagent-1:read-b"]);
  assert.equal(milestones.covered.length, 2);
  assert.deepEqual(milestones.openGaps.map(item => [item.itemId, item.outcome]), [["subagent-1:read-c", "failed"]]);
  assert.match(milestones.nextStep, /1 项必要缺口/);
  assert.equal(milestones.requiresUserInput, false);
  for (const milestone of milestones.ready) {
    assert.match(milestone.milestoneId, /^milestone:[a-f0-9]{64}$/);
    assert.equal(milestone.bindingId, binding.bindingId);
    assert.ok(milestone.deliverableId?.startsWith("partial:"));
    assert.ok(milestone.summary.includes("结论"));
  }
  const milestoneA = milestones.ready.find(item => item.itemId === "subagent-1:read-a")!;
  assert.deepEqual(milestoneA.files, [{ ref: snapshotA, name: "read-a.v1.txt", openPath: snapshotA, digest: "a".repeat(64), immutable: true }],
    "a registered immutable snapshot is opened by its stored version");
  const milestoneB = milestones.ready.find(item => item.itemId === "subagent-1:read-b")!;
  assert.deepEqual(milestoneB.files, [{ ref: fileB, name: "read-b.txt", openPath: fileB, digest: "b".repeat(64), immutable: false }],
    "an unregistered-version file is still shown but not claimed immutable");
  assert.equal(projection.phase3?.subitems.filter(item => item.outcome === "completed").length, 2);
  assert.equal(projection.generatedArtifacts?.length, 3, "registered files remain the same evidence");

  // A foreground-style work_query_status detail read sees exactly the same facts.
  const detailRequest = messages.accept(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID, requestId: "detail-read", text: "现在先给我已经确认的" });
  const tools = botForegroundTools({ db: db.connection, userId: LOCAL_USER_ID, botId: DEFAULT_BOT_ID,
    conversationId: detailRequest.conversationId, bots, messages, works, isAuthority: () => true,
    schedule: () => { throw new Error("a read must not dispatch work"); }, wake: () => {}, memorySearch: () => [] });
  const detailTool = tools.find(item => item.name === "work_query_status")!;
  const detailResult = await detailTool.execute({ view: "detail", workId: created.workId } as never,
    { callId: "call-detail", taskId: "task-detail", memo: async () => detailRequest.requestId } as unknown as ToolExecutionApi, BACKGROUND_CONTEXT);
  const detailText = detailResult.output?.find(block => block.type === "text");
  assert(detailText?.type === "text");
  const detail = JSON.parse(detailText.text)[0];
  assert.deepEqual(detail.phase3.milestones.ready, JSON.parse(JSON.stringify(milestones.ready)),
    "work_query_status detail and the proactive layer read one milestone truth");
  assert.deepEqual(detail.phase3.milestones.openGaps, JSON.parse(JSON.stringify(milestones.openGaps)));

  // (c) Multiple verified items become one merged progress message; replay adds none.
  assert.equal(feedback.drain(created.workId), 1);
  assert.equal(feedback.drain(created.workId), 0, "replaying the same milestone digest sends nothing");
  const history = () => messages.history(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID, conversationId: source.conversationId });
  const milestoneMessages = () => history().messages.filter(message => message.workFeedback?.eventId === `milestone:${binding.bindingId}`);
  assert.equal(milestoneMessages().length, 1);
  const merged = milestoneMessages()[0]!;
  assert.equal(merged.workFeedback?.category, "progress");
  assert.equal(merged.workFeedback?.kind, "binding");
  assert.equal(merged.workFeedback?.executionId, binding.bindingId);
  assert(merged.text.includes("已核实 2 项子步骤成果"), "several items are merged into one milestone message");
  assert(merged.text.includes("读取甲文件") && merged.text.includes("读取乙文件"));
  assert(merged.text.includes("已读取甲文件，结论 A 可用"));
  assert(merged.text.includes("不代表整体目标已完成"), "in-flight milestones never claim the goal is done");
  assert(merged.text.includes("仍有 1 项必要缺口待核对"));
  assert(merged.text.includes(snapshotA) && merged.text.includes(fileB), "openable registered versions are reported");
  assert.equal(history().messages.filter(message => message.workFeedback?.eventId?.startsWith("result:partial:")).length, 0,
    "no one-message-per-subitem delivery");
  assert.equal(works.getProjection(created.workId)?.lifecycle, "active");

  // Restart keeps the same digest, so a replay after restart still sends nothing.
  const digestBefore = milestones.digest;
  const messageCount = history().messages.length;
  db.close();
  db = new AppDatabase(dbPath);
  ({ bots, works, messages, feedback } = open());
  assert.equal(feedback.drain(created.workId), 0, "persisted milestone version dedupes across restart");
  assert.equal(messages.history(LOCAL_USER_ID, { botId: DEFAULT_BOT_ID, conversationId: source.conversationId }).messages.length, messageCount);
  const restored = works.getProjection(created.workId)!.phase3!.milestones!;
  assert.equal(restored.digest, digestBefore, "the same facts produce the same digest after restart");
  assert.equal(restored.ready.length, 2);

  // (d) Completion still delivers the whole final result; the milestone stays partial history.
  const finished = await readDurableWorkExecution(persisted(completedEntries), completed(10, 20), root);
  assert.equal(finished.status, "completed");
  if (finished.status !== "completed") throw new Error("expected a completed observation");
  const currentBinding = works.repo.getBinding(binding.bindingId)!;
  assert.deepEqual(works.nativeResults.receive(currentBinding,
    { taskId: currentBinding.taskId, operationId: currentBinding.operationId, submissionId: 2, status: "done" }, finished), []);
  assert.equal(works.repo.getBinding(binding.bindingId)?.status, "completed");
  const after = works.getProjection(created.workId)!.phase3!.milestones!;
  assert.equal(after.ready.length, 3, "the newly verified final item is a milestone fact too");
  assert.notEqual(after.digest, digestBefore);
  assert.equal(after.openGaps.length, 1);
  // The finished once-Work is handed to the result lane; feedback must not re-send partials.
  assert.equal(feedback.drain(created.workId), 0);
  assert.equal(milestoneMessages().length, 1, "completion does not repeat the in-flight milestone message");
  assert.equal(feedback.deliverCompletion({ bindingId: binding.bindingId, eventId: `completion:${binding.bindingId}`,
    category: "result", text: finished.summary }), true);
  const finalMessages = history().messages.filter(message => message.workFeedback?.eventId === `completion:${binding.bindingId}`);
  assert.equal(finalMessages.length, 1, "the full final result is delivered exactly once");
  const finalMessage = finalMessages[0]!;
  assert.equal(finalMessage.workFeedback?.category, "result");
  assert.equal(finalMessage.workFeedback?.kind, "result");
  assert.equal(finalMessage.workFeedback?.report?.summary, finished.summary);
  assert(finalMessage.text.includes(finished.summary));
  assert(finalMessage.workFeedback?.report?.artifactRefs.includes(snapshotA), "the final result still carries the registered versions");
  assert.equal(milestoneMessages().length, 1);
  assert.equal(milestoneMessages()[0]!.workFeedback?.category, "progress", "an in-flight item is never relabelled as the completed goal");
  assert.equal(milestoneMessages()[0]!.workFeedback?.kind, "binding");
  assert.equal(works.getWork(created.workId)?.criteria[0].status, "pending", "verified subitems do not attest acceptance criteria");
  // The projection reports the real user-input gate without inventing new facts.
  works.repo.insertBlocker({ blockerId: "milestone-input", workId: created.workId, reason: "需要确认交付范围",
    kind: "operational", status: "open", waitingForUserInput: true, createdAt: Date.now() });
  const waiting = works.getProjection(created.workId)!.phase3!.milestones!;
  assert.equal(waiting.requiresUserInput, true);
  assert(waiting.ready.every(item => item.requiresUserInput), "a waiting Work is never presented as needing nothing");
  assert.equal(waiting.digest, after.digest, "the user-input gate is not a new milestone fact");
  console.log("PASS running Work milestones: bounded in-flight subitems, one shared projection for proactive return and work_query_status detail, one merged progress message, dedupe across replay/restart, full final result without goal overclaim");
} finally {
  db.close();
  rmSync(root, { recursive: true, force: true });
}