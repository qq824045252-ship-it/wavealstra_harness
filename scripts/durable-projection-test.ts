import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { createModels, type AssistantMessage, type Message, type Models } from "@earendil-works/pi-ai";
import { AgentDoc, defineTool, type EntryRecord, type Storage } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { DurableBotRuntime } from "../src/main/agent/durable/DurableBotRuntime";
import { DurableHistoryProjection, DURABLE_HISTORY_ENTRY_LIMIT } from "../src/main/agent/durable/DurableHistoryProjection";
import { CONTEXT_LEDGER_VERSION } from "../src/main/agent/EphemeralContextProjection";
import { resolveDurableBranch, captureDurableBranch } from "../src/main/agent/durable/DurableTaskBranch";
import { openDurableStorage } from "../src/main/agent/durable/DurableStorage";
import { findDurableUserEntry } from "../src/main/agent/durable/DurableConversationBranch";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { durableTaskStatus } from "../src/shared/durable-bot";
import { MemoryService } from "../src/main/memory/MemoryService";
import { MemorySemanticProvider } from "../src/main/memory/MemorySemanticProvider";
import { SEMANTIC_DIMENSION } from "../src/main/retrieval/SemanticModelManager";
import { getSemanticRuntime, SemanticUnavailableError } from "../src/main/retrieval/SemanticRuntime";
import type { AutomaticRecallReceipt } from "../src/shared/memory-kernel";
import { WorkMemoryCapture } from "../src/main/memory/WorkMemoryCapture";
import { BotRegistry } from "../src/main/agent/work/BotRegistry";
import { WorkService, DESKTOP_USER_GRANTS } from "../src/main/agent/work/WorkService";
import { DEFAULT_BOT_ID, LOCAL_USER_ID, type WorkControlResult } from "../src/shared/bot-work";
import { DurableConsultIdentity } from "../src/main/agent/durable/DurableConsultSession";
import { resolveDotsMemoryLimits } from "../src/shared/dots-limits";

process.env.MYBUDDY_CACHE_TRACE = "0";
const directory = await mkdtemp(join(tmpdir(), "mybuddy-durable-projection-"));
const cwd = join(directory, "workspace"); await mkdir(cwd);
const model = { id: "fixture", name: "fixture", provider: "fixture", api: "openai-completions", baseUrl: "https://fixture.invalid", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as const;
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const answer = (text: string, timestamp: number): AssistantMessage => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", api: model.api, model: model.id, provider: model.provider, timestamp, usage });
const history: Message[] = Array.from({ length: 65 }, (_, i) => [{ role: "user", content: `old question ${i}`, timestamp: i * 2 + 1 } satisfies Message, answer(`old answer ${i}`, i * 2 + 2)]).flat();

console.log("== 孤立工具结果：调用行滚出窗口后结果不许丢 ==");
{
  const callId = "call-subagent-8";
  const subagentCall = (id: number): EntryRecord => ({ id, kind: "pi.generation", byTaskId: 1, model: [{
    role: "assistant", content: [{ type: "toolCall", id: callId, name: "subagent", arguments: { tasks: [{ agent: "worker", task: "审计" }] } }],
    stopReason: "toolUse", api: model.api, model: model.id, provider: model.provider, timestamp: id, usage }] }) as unknown as EntryRecord;
  const subagentResult = (id: number): EntryRecord => ({ id, kind: "pi.tool-result", byTaskId: 1, model: [{
    role: "toolResult", toolCallId: callId, toolName: "subagent", isError: false,
    content: [{ type: "text", text: "Parallel: 8/8 succeeded" }],
    details: { mode: "parallel", plan: [{ itemId: "durable-1-0", displayName: "妙蛙种子" }],
      results: [{ subagentId: "durable-1-0", status: "completed" }] }, timestamp: id }] }) as unknown as EntryRecord;

  // 窗口里只有结果行：调用行（对话开头那条 assistant）已被挤出窗口。
  const window = new DurableHistoryProjection();
  window.merge([subagentResult(465)], new Map(), {});
  assert.equal(window.messages.length, 0, "owner 不在窗口里时不产生半截消息");
  assert.deepEqual(window.orphanToolCalls(), [{ callId, entryId: 465 }], "孤立结果必须被点名，供运行时补回调用行");

  // 运行时补回调用行后，结果与详情落到位（顶栏子代理面板就是从这里读 records）。
  window.merge([subagentCall(19)], new Map(), {});
  const mended = window.messages[0]?.tools?.[0];
  assert.equal(window.orphanToolCalls().length, 0, "补回调用行后不再是孤立结果");
  assert.equal(mended?.tool, "subagent");
  assert.equal(mended?.status, "success", "结果状态回填到调用行");
  assert.match(mended?.detail ?? "", /"subagentId":"durable-1-0"/, "结果详情必须保留在 tool.detail 上");

  // 裁剪不得驱逐「有结果的调用行」，否则那次调用会跟着结果一起消失。
  const crowded = new DurableHistoryProjection();
  const filler = Array.from({ length: DURABLE_HISTORY_ENTRY_LIMIT + 5 }, (_, index) => ({
    id: 100 + index, kind: "pi.generation", byTaskId: 1, model: [answer(`filler ${index}`, 100 + index)] })) as unknown as EntryRecord[];
  crowded.merge([subagentCall(19), subagentResult(465), ...filler], new Map(), {});
  crowded.trim();
  assert.equal(crowded.messages.flatMap(message => message.tools ?? []).find(tool => tool.id === callId)?.status, "success",
    "结果所属的调用行必须留在窗口里");
}

let revision = 1;
let waitingForInput = false;
let historyLoads = 0;
let requestIndex = 0;
const requests: Message[][] = [];
const provider: Pick<Models, "getModel" | "getAuth" | "streamSimple" | "completeSimple"> = {
  getModel: () => ({ ...model, input: ["text"] }),
  getAuth: async () => undefined,
  streamSimple: (_model, input) => {
    requests.push(structuredClone([...input.messages]));
    const stream = createAssistantMessageEventStream();
    const number = ++requestIndex;
    queueMicrotask(() => {
      const response: AssistantMessage = number === 1
        ? { ...answer("", Date.now()), stopReason: "toolUse", content: [{ type: "toolCall", id: "echo-one", name: "fixture_echo", arguments: {} }] }
        : answer(`answer ${number}`, Date.now());
      stream.push({ type: "done", reason: number === 1 ? "toolUse" : "stop", message: response }); stream.end();
    });
    return stream;
  },
  completeSimple: async () => answer("summary", Date.now()),
};
const api: Models = Object.assign(createModels(), provider);
const handle = await openDurableStorage(join(directory, "state"), context);
let entryScans = 0, submissionScans = 0, projectedEntries = 0, completedTurns = 0, responses = 0;
const storage = new Proxy(handle.storage, { get(target, key) {
  if (key === "scanEntries") return (...args: Parameters<Storage["scanEntries"]>) => { entryScans++; return target.scanEntries(...args); };
  if (key === "scanSubmissions") return (...args: Parameters<Storage["scanSubmissions"]>) => { submissionScans++; return target.scanSubmissions(...args); };
  const value = Reflect.get(target, key, target);
  return typeof value === "function" ? value.bind(target) : value;
} });
const options = { directory: join(directory, "state"), cwd, model: { provider: model.provider, modelId: model.id }, models: api,
  toolMode: "native" as const, instructions: () => "fixture", onSnapshot: () => {},
  onEntries: (entries: readonly unknown[]) => { projectedEntries += entries.length; },
  onTurns: (turns: readonly unknown[]) => { completedTurns += turns.length; },
  onResponse: () => { responses++; },
  waitingForInput: () => waitingForInput,
  evidenceProjection: { enabled: () => false, scope: () => ({ taskId: "fixture" }), supplementalEvidence: () => [{ id: "fixture-source", kind: "project" as const,
    revision: String(revision), text: `source revision ${revision}`, validate: () => {}, access: { kind: "project-note" as const, projectId: "fixture-project" } }], validateEvidenceAccess: () => {} },
  tools: [defineTool({ name: "fixture_echo", description: "fixture", parameters: Type.Object({}), replay: "safe", execute: async () => { revision = 2; return { output: [{ type: "text", text: "echo" }] }; } })],
};
let runtime = await DurableBotRuntime.open({ ...options, storage, initialHistory: async () => { historyLoads++; return { messages: history, context: history }; } });
try {
  assert.equal(historyLoads, 1);
  assert(runtime.snapshot.messages.length < history.length, "opening a long transcript loads the native window only");
  assert(runtime.snapshot.historyBefore !== undefined);
  assert.equal(projectedEntries, 0, "imported records cannot bill again");
  const stable = runtime.snapshot.messages.at(-1);
  const scans = { entryScans, submissionScans };
  for (let i = 0; i < 20; i++) await runtime.refresh();
  assert.deepEqual({ entryScans, submissionScans }, scans, "observation refresh must not rescan history/submissions");
  assert.equal(runtime.snapshot.messages.at(-1), stable, "committed DTOs are cached by entry ID");
  waitingForInput = true;
  assert.equal((await runtime.refresh()).status, "waiting_input", "persistent approvals update even without a native watch revision");
  assert.equal(durableTaskStatus(runtime.snapshot), "pending", "waiting for input belongs in the pending task filter");
  waitingForInput = false;
  assert.notEqual((await runtime.refresh()).status, "waiting_input");
  let pages = 0;
  const visible = runtime.snapshot;
  const allMessages = new Map(visible.messages.map(message => [message.id, message]));
  let before = visible.historyBefore;
  while (before !== undefined) {
    const page = await runtime.loadHistoryBlock(before);
    for (const message of page.messages) allMessages.set(message.id, message);
    before = page.before; pages++; assert(pages < 10);
    assert.equal(runtime.snapshot, visible, "paging never changes the live snapshot or another observer");
  }
  assert.equal(allMessages.size, history.length);
  assert([...allMessages.values()].some(message => message.text === "old question 0"));
  const submission = await runtime.submit("new question", "input-one", "followUp", { text: "new question", displayText: "visible question", attachments: [] });
  assert.equal((await submission.wait(context)).status, "done");
  await runtime.conversation.waitForIdle(context);
  await runtime.refresh();
  assert.equal(runtime.snapshot.messages.filter(message => message.role === "user").at(-1)?.text, "visible question");
  assert.equal(runtime.snapshot.status, "completed");
  assert.equal(completedTurns, 1);
  assert.equal(responses, 2);
  const withTool = runtime.snapshot.messages.find(message => message.tools?.some(tool => tool.id === "echo-one"));
  assert(withTool?.entryId);
  const toolPage = await runtime.loadHistoryBlock(Number(withTool.entryId), 1);
  assert.equal(toolPage.messages[0]?.tools?.find(tool => tool.id === "echo-one")?.status, "success", "page boundaries retain later tool results");
  const firstCapsule = requests[0].filter(message => message.role === "user" && typeof message.content === "string" && message.content.includes("source revision"));
  assert.equal(firstCapsule.length, 1);
  assert.deepEqual(requests[1].slice(0, requests[0].length), requests[0], "tool continuation keeps the complete earlier request prefix");
  await (await runtime.submit("next question", "input-two")).wait(context);
  await runtime.refresh();
  assert.deepEqual(requests[2].slice(0, requests[1].length), requests[1], "a new evidence revision appends at the next user's anchor");
  assert(requests[2].some(message => message.role === "user" && typeof message.content === "string" && message.content.includes("source revision 2")));
  const consumed = { projectedEntries, completedTurns, responses };
  for (let i = 0; i < 10; i++) await runtime.refresh();
  assert.deepEqual({ projectedEntries, completedTurns, responses }, consumed, "projection consumers see only new records");
} finally { await runtime.close(); handle.lease.release(); }

runtime = await DurableBotRuntime.open({ ...options, initialHistory: async () => { throw new Error("old source history is no longer available"); } });
try {
  assert(runtime.snapshot.historyBefore !== undefined);
  assert.equal(runtime.snapshot.messages.filter(message => message.role === "user").find(message => message.text === "visible question")?.text, "visible question", "display metadata survives reopen without submission joins");
  await (await runtime.submit("after restart", "input-three")).wait(context);
  await runtime.conversation.waitForIdle(context);
  assert.equal((await runtime.refresh()).status, "completed", "the shared ledger records a restart boundary for nonversioned evidence");
} finally { await runtime.close(); }
console.log("PASS Durable history window, pagination, immutable projection, receipt metadata, incremental consumers and shared evidence prefix/restart");

let effects = 0, holds = 0;
let entered!: () => void;
const holding = new Promise<void>(resolve => { entered = resolve; });
const codeModels: Models = { ...api, streamSimple: (_model, input) => {
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => {
    const done = input.messages.at(-1)?.role === "toolResult";
    const message: AssistantMessage = done ? answer("code completed", Date.now()) : { ...answer("", Date.now()), stopReason: "toolUse",
      content: [{ type: "toolCall", id: "native-code", name: "codemode", arguments: { code: "const first = await tools.effect({}); const second = await tools.hold({}); text(first, second);" } }] };
    stream.push({ type: "done", reason: done ? "stop" : "toolUse", message }); stream.end();
  });
  return stream;
} };
const lazyEffect = defineTool({ name: "effect", description: "one external effect", parameters: Type.Object({}), replay: "unsafe", execute: async () => {
  effects++; return { output: [{ type: "text", text: "receipt-one" }] };
} });
const codeOptions = { ...options, directory: join(directory, "codemode"), models: codeModels, toolMode: "codemode" as const, evidenceProjection: undefined,
  prepareCodeMode: async (code: string) => code.includes("effect") ? [lazyEffect] : [],
  tools: [
    defineTool({ name: "hold", description: "safe checkpoint", parameters: Type.Object({}), replay: "safe", execute: async (_args, _api, callContext) => {
      if (++holds === 1) {
        entered();
        await new Promise<void>((_resolve, reject) => {
          const stopped = () => reject(new Error("host closed"));
          assert(callContext.abortSignal);
          if (callContext.abortSignal.aborted) stopped(); else callContext.abortSignal.addEventListener("abort", stopped, { once: true });
        });
      }
      return { output: [{ type: "text", text: "resumed" }] };
    } }),
  ],
};
runtime = await DurableBotRuntime.open(codeOptions);
let receiptId: number;
try {
  receiptId = (await runtime.submit("run code", "code-restart")).id;
  await Promise.race([holding, runtime.conversation.waitForIdle(context).then(async () => { throw new Error(`native CodeMode ended before hold: ${JSON.stringify((await runtime.refresh()).messages)}`); })]);
} finally { await runtime.close(); }
assert.equal(effects, 1);
runtime = await DurableBotRuntime.open(codeOptions);
try {
  const receipt = await runtime.harness.submission(receiptId! as Parameters<typeof runtime.harness.submission>[0], context);
  assert(receipt);
  assert.equal((await receipt.wait(context)).status, "done");
  await runtime.conversation.waitForIdle(context);
  assert.equal((await runtime.refresh()).messages.at(-1)?.text, "code completed");
  assert.equal(effects, 1, "native CodeMode journal reuses a completed unsafe nested effect after restart");
  assert.equal(holds, 2, "only the interrupted replay-safe nested call resumes");
} finally { await runtime.close(); }
console.log("PASS native CodeMode discovers lazy tools and resumes across restart without repeating a completed effect");

const forkOptions = { ...options, directory: join(directory, "regeneration"), evidenceProjection: undefined };
runtime = await DurableBotRuntime.open(forkOptions);
let originalConversationId: typeof runtime.conversation.id;
try {
  await runtime.conversation.configure({ modelTools: [] }, context);
  await (await runtime.submit("original first", "original-first")).wait(context);
  await (await runtime.submit("original second", "original-second")).wait(context);
  await runtime.conversation.waitForIdle(context);
  originalConversationId = runtime.conversation.id;
  const target = await findDurableUserEntry(runtime.conversation, { userMessageIndex: 1 }, context);
  await runtime.configure({ provider: model.provider, modelId: "new-selection" }, "native");
  await runtime.forkForRegeneration(target.previous?.id, { operationId: "regenerate-one", content: "replacement", metadata: { text: "replacement", displayText: "edited replacement", attachments: [] } });
  assert.equal((await runtime.regeneration())?.kind, "pending");
} finally { await runtime.close(); }
runtime = await DurableBotRuntime.open(forkOptions);
let regenerationReceipt = 0;
try {
  assert.notEqual(runtime.conversation.id, originalConversationId!);
  assert.equal((await runtime.harness.snapshot(AgentDoc, runtime.conversation.id, context))?.model?.modelId, "new-selection", "the new branch retains the host's latest model selection rather than its historical checkpoint");
  assert.equal((await runtime.harness.snapshot(AgentDoc, runtime.conversation.id, context))?.modelTools, undefined, "cleared current settings cannot return from the fork's historical configuration");
  const receipt = await runtime.resumeRegeneration(); assert(receipt);
  regenerationReceipt = receipt.id;
  assert.equal((await receipt.wait(context)).status, "done");
  await runtime.conversation.waitForIdle(context);
  const snapshot = await runtime.refresh();
  assert.deepEqual(snapshot.messages.filter(message => message.role === "user").map(message => message.text), ["original first", "edited replacement"]);
  assert.equal((await runtime.resumeRegeneration())?.id, regenerationReceipt, "regeneration retries reuse the native receipt");
  const original = await runtime.harness.conversation(originalConversationId!, context); assert(original);
  assert((await original.entries({}, 100, undefined, context)).items.some(entry => entry.model?.some(message => message.role === "user" && message.content === "original second")), "forking preserves the original audit history");
} finally { await runtime.close(); }
const callsBeforeReopen = requestIndex;
runtime = await DurableBotRuntime.open(forkOptions);
try {
  assert.equal((await runtime.resumeRegeneration())?.id, regenerationReceipt);
  assert.equal(requestIndex, callsBeforeReopen, "an already admitted regeneration cannot start another model call on reopen");
} finally { await runtime.close(); }
console.log("PASS regeneration intent survives a crash after fork, retains configured model and admits once on reopen");

const childUsage: string[] = [];
const diagnosticOptions = { ...forkOptions, directory: join(directory, "child-diagnostics"),
  onEntries: (entries: readonly { id: number }[], identity: { conversationId: string; sourceKind: "main" | "subagent" }) => {
    if (identity.sourceKind === "subagent") childUsage.push(...entries.map(entry => `${identity.conversationId}:${entry.id}`));
  } };
runtime = await DurableBotRuntime.open(diagnosticOptions);
try {
  const child = await runtime.harness.createConversation({ ownership: { kind: "ownerless" }, agent: { cwd, model: { provider: model.provider, modelId: model.id }, tools: [] },
    init: async (tx, id) => { (await tx.doc(DurableConsultIdentity, id)).key = "diagnostic-child"; } }, context);
  await (await child.submit({ type: "input", content: "child work", requestId: "child-input" }, context)).wait(context);
  await child.waitForIdle(context);
  assert(childUsage.length > 0, "a completed child run supplies committed records to the shared usage consumer");
} finally { await runtime.close(); }
const originalUsageIds = [...childUsage]; childUsage.length = 0;
runtime = await DurableBotRuntime.open(diagnosticOptions);
try { assert.deepEqual(childUsage, originalUsageIds, "reopening replays the same child record identities for idempotent usage repair"); }
finally { await runtime.close(); }
console.log("PASS child usage projection and recovery retain stable committed record identities");

let summaryStarted!: () => void;
const summarizing = new Promise<void>(resolve => { summaryStarted = resolve; });
const compactionModels: Models = { ...api, completeSimple: async (_model, _input, settings) => {
  summaryStarted();
  return new Promise<AssistantMessage>((_resolve, reject) => {
    const stop = () => reject(new Error("summary cancelled"));
    if (settings?.signal?.aborted) stop(); else settings?.signal?.addEventListener("abort", stop, { once: true });
  });
} };
const longHistory = history.map(message => message.role === "user" ? { ...message, content: String(message.content).repeat(300) } : message);
runtime = await DurableBotRuntime.open({ ...forkOptions, directory: join(directory, "compaction"), models: compactionModels, initialHistory: { messages: longHistory, context: [] } });
try {
  const compacting = runtime.compact();
  const settled = compacting.then(() => "completed", error => error instanceof Error ? error.message : String(error));
  await Promise.race([summarizing, settled.then(result => { throw new Error(`Compaction finished before cancellation: ${result}`); })]);
  assert.equal(await runtime.abortCompaction(), true);
  assert.match(await settled, /aborted/);
  assert.equal(await runtime.abortCompaction(), false, "manual cancellation leaves no pending compaction task");
} finally { await runtime.close(); }
console.log("PASS manual compaction cancellation targets its native task");

// Copy actual generated ledgers, then continue and revoke in the child's scope.
let branchCalls = 0;
const branchApi: Models = { ...api, streamSimple: () => {
  branchCalls++;
  const stream = createAssistantMessageEventStream();
  queueMicrotask(() => { stream.push({ type: "done", reason: "stop", message: answer("branch answer", Date.now()) }); stream.end(); });
  return stream;
} };
let revoked = false;
const accessScopes: string[] = [];
const branchOptions = (taskId: string) => ({ ...options, models: branchApi, directory: join(directory, taskId),
  evidenceProjection: { ...options.evidenceProjection, scope: () => ({ taskId }),
    supplementalEvidence: () => options.evidenceProjection.supplementalEvidence().map(item => ({ ...item, validate: () => { if (revoked) throw new Error("child evidence revoked"); } })),
    validateEvidenceAccess: () => { accessScopes.push(taskId); if (revoked) throw new Error("child evidence revoked"); } } });
const parent = await DurableBotRuntime.open(branchOptions("ledger-parent"));
try {
  await (await parent.submit("parent evidence", "parent-one")).wait(context);
  await parent.conversation.waitForIdle(context);
  await parent.refresh();
  const reply = parent.snapshot.messages.findLast(message => message.role === "assistant");
  assert(reply?.entryId);
  const anchor = await resolveDurableBranch(parent, { sourceTaskId: "parent", entryId: reply.entryId, position: "after_reply", requestId: "branch-ledger" });
  const seed = await captureDurableBranch(parent, anchor);
  assert(seed.entries.some(item => item.entry.kind === "mybuddy.context-ledger"));
  const child = await DurableBotRuntime.open({ ...branchOptions("ledger-child"), initialBranch: seed });
  try {
    const entries = (await child.conversation.entries({ order: "ascending" }, 100, undefined, context)).items;
    const ledger = entries.find(entry => entry.kind === "mybuddy.context-ledger");
    assert(ledger?.data && typeof ledger.data === "object" && !Array.isArray(ledger.data));
    assert.equal(ledger.data.version, CONTEXT_LEDGER_VERSION);
    assert(entries.some(entry => String(entry.id) === String(ledger.data && typeof ledger.data === "object" && !Array.isArray(ledger.data) ? ledger.data.anchor : "") && entry.model?.some(message => message.role === "user")));
    await (await child.submit("child evidence", "child-one")).wait(context);
    await child.conversation.waitForIdle(context);
    assert.equal(branchCalls, 2);
    assert(accessScopes.includes("ledger-child"), "inherited access witnesses are checked in the child's scope");
    revoked = true;
    await (await child.submit("deny revoked evidence", "child-two")).wait(context);
    await child.conversation.waitForIdle(context);
    assert.equal(branchCalls, 2, "hook rejection must block the actual provider");
    revoked = false;
    await child.conversation.commit(tx => tx.appendEntry(child.conversation.id, { kind: "mybuddy.context-ledger", data: { inherited: true } }), context);
    await (await child.submit("deny corrupt evidence", "child-three")).wait(context);
    await child.conversation.waitForIdle(context);
    assert.equal(branchCalls, 2, "a corrupt ledger cannot fall through Pi's swallowed hook exception");
  } finally { await child.close(); }
} finally { await parent.close(); }
console.log("PASS branch evidence provenance, child access checks and fail-closed provider dispatch");

// A persisted v2 ledger could pair an active revision with an older user's quote.
{
  const taskId = "mybuddy-dots";
  const db = new AppDatabase(join(directory, "dots-old-quotes.db"));
  db.openDots();
  const memory = new MemoryService(db, {semantic:false});
  const atom = memory.create({kind:"preference",title:"井边读书会",content:"我一般在周日下午参加井边读书会。",sourceType:"user",scopeType:"task",scopeId:taskId});
  const settings = {...options, directory:join(directory,"dots-legacy-quote"),tools:[],
    evidenceProjection:{memory,enabled:()=>true,scope:()=>({taskId}),supplementalEvidence:()=>[]}};
  let chat = await DurableBotRuntime.open(settings);
  const former = "旧窗口曾把读书会误记为周四清晨";
  try {
    await (await chat.submit(former,"quote-before-restart")).wait(context);
    const entries = (await chat.conversation.entries({order:"ascending"},100,undefined,context)).items;
    const ledger = entries.findLast(e=>e.kind==="mybuddy.context-ledger")!.data as any;
    const stale = structuredClone(ledger);
    const ref = stale.additions.find((r:{id:string})=>r.id===`memory:${atom.id}`);
    assert(ref);
    ref.reference.renderer="dots-memory-l1-v2";
    ref.reference.userQuote={evidenceId:"obsolete-source",start:0,end:2,hash:"0".repeat(64)};
    await chat.conversation.commit(tx=>tx.appendEntry(chat.conversation.id,{kind:"mybuddy.context-ledger",data:stale}),context);
  } finally { await chat.close(); }
  chat = await DurableBotRuntime.open(settings);
  try {
    const before = requests.length;
    await (await chat.submit("我的井边读书会在什么时候？","quote-after-restart")).wait(context);
    assert.equal(requests.length,before+1);
    const request=JSON.stringify(requests.at(-1));
    assert(request.includes(atom.content) && !request.includes("用户原话摘录"));
    assert(!request.includes(former));
    assert(JSON.stringify((await chat.refresh()).messages).includes(former),"native chat bubbles remain available");
    const entries=(await chat.conversation.entries({order:"ascending"},100,undefined,context)).items;
    assert(entries.some(e=>e.kind==="mybuddy.dots-evidence-boundary"));
  } finally {await chat.close();db.close();}
  console.log("PASS Dots reopens a saved wrong-quote ledger, regenerates current evidence and keeps original chat bubbles");
}

// Dots restores automatic views with their selected L1 versions, then cuts provider
// history after a confirmed withdrawal without deleting the visible conversation.
{
  const taskId = "mybuddy-dots";
  const dbPath = join(directory, "dots-grounded-views.db");
  let db = new AppDatabase(dbPath);
  db.openDots();
  let memory = new MemoryService(db, { semantic: false });
  const preference = "苗圃巡检表总是先记录新芽数量。";
  const source = { messageId: "nursery-user", text: preference, createdAt: Date.now() };
  const atom = memory.createFromTask({ kind: "preference", title: "苗圃巡检表", content: preference,
    scopeType: "task", scopeId: taskId, sourceTaskId: taskId, sourceType: "user" }, source);
  let limits = resolveDotsMemoryLimits({ profileChars: 7 });
  const profileExcerpts = (messages: Message[]) => messages.flatMap(message => typeof message.content === "string"
    ? Array.from(message.content.matchAll(/\[L3 derived:[^\n]+\] Dots 个人画像 — ([\s\S]*?) \(sources:/gu), match => match[1]) : []);
  const settings = () => ({ ...options, directory: join(directory, "dots-grounded-views"), tools: [],
    evidenceProjection: { memory, enabled: () => true, dotsMemoryLimits: () => limits,
      scope: () => ({ taskId }), supplementalEvidence: () => [] } });
  let chat = await DurableBotRuntime.open(settings());
  try {
    await (await chat.submit("今天需要检查些什么？", "profile-first")).wait(context);
    assert.deepEqual(profileExcerpts(requests.at(-1)!), ["长期偏好\n• "]);
  } finally { await chat.close(); db.close(); }
  db = new AppDatabase(dbPath);
  memory = new MemoryService(db, { semantic: false });
  limits = resolveDotsMemoryLimits({ profileChars: 12, quoteBytes: 0 });
  chat = await DurableBotRuntime.open(settings());
  try {
    await (await chat.submit("接着说。", "profile-restored")).wait(context);
    assert.deepEqual(profileExcerpts(requests.at(-1)!), ["长期偏好\n• ", "长期偏好\n• 苗圃巡检表"]);
    const before = (await chat.conversation.entries({ order: "ascending" }, 100, undefined, context)).items;
    assert(!before.some(entry => entry.kind === "mybuddy.dots-evidence-boundary" || entry.kind === "mybuddy.context-reset"));
    memory.forget(atom.id);
    await (await chat.submit("现在还有哪些长期偏好？", "profile-withdrawn")).wait(context);
    assert(!JSON.stringify(requests.at(-1)).includes(preference));
    const after = (await chat.conversation.entries({ order: "ascending" }, 100, undefined, context)).items;
    assert(after.some(entry => entry.kind === "mybuddy.dots-evidence-boundary"));
    assert(JSON.stringify((await chat.refresh()).messages).includes("今天需要检查些什么"));
  } finally { await chat.close(); db.close(); }
  console.log("PASS native Dots restores source-bound personal views and withdrew them from provider history");
}

const bounded = await DurableBotRuntime.open({ ...options, directory: join(directory, "bounded-history"), evidenceProjection: undefined });
try {
  for (let batch = 0; batch < 15; batch++) {
    await bounded.conversation.commit(async tx => {
      for (let i = 0; i < 20; i++) {
        const n = batch * 20 + i;
        await tx.appendEntry(bounded.conversation.id, { kind: "pi.user", model: [{ role: "user", content: `bounded ${n}`, timestamp: n * 2 }] });
        await tx.appendEntry(bounded.conversation.id, { kind: "pi.assistant", model: [answer(`answer ${n}`, n * 2 + 1)] });
      }
    }, context);
    await bounded.refresh();
    assert(bounded.snapshot.messages.length <= DURABLE_HISTORY_ENTRY_LIMIT, "live history residency stays bounded while entries grow");
  }
  const tail = bounded.snapshot;
  const seen = new Set(tail.messages.map(message => message.id));
  let cursor = tail.historyBefore;
  while (cursor !== undefined) {
    const page = await bounded.loadHistoryBlock(cursor);
    assert(page.messages.length <= DURABLE_HISTORY_ENTRY_LIMIT);
    assert(page.before === undefined || page.before < cursor);
    page.messages.forEach(message => seen.add(message.id));
    cursor = page.before;
  }
  assert.equal(seen.size, 600, "every evicted message remains reachable by read-only pages");
  assert.equal(bounded.snapshot, tail);
} finally { await bounded.close(); }
console.log("PASS bounded live history, complete older pagination and observer isolation");


// Real native Durable requests use current L1 state, never the format in old Work reports.
// Provider responses are deterministic; live model semantics are covered by the six-type Watch scenario.
const preferenceDb = new AppDatabase(":memory:");
try {
  const bots = new BotRegistry(preferenceDb.connection); bots.ensureDefaultBot(LOCAL_USER_ID);
  bots.registerBot({botId:"foreign-pref-bot",userId:LOCAL_USER_ID,displayName:"Other"});
  const works = new WorkService(preferenceDb.connection,{bots});
  const actor = {kind:"user" as const,userId:LOCAL_USER_ID,entry:"desktop" as const,grants:DESKTOP_USER_GRANTS};
  const workResult = (result:WorkControlResult) => {assert(result.ok);return result.work;};
  const work = workResult(works.createWork(actor,{operationId:"pref-work",title:"库存 Watch",ownerBotId:DEFAULT_BOT_ID,
    inputSnapshotId:"pref-input",authorization:{allowedScopes:["workspace:read"]}}));
  preferenceDb.upsertTask({id:"pref-worker",title:"Preference worker",updatedAt:Date.now()});
  workResult(works.dispatchExecution(actor,{operationId:"pref-dispatch",workId:work.workId,botId:DEFAULT_BOT_ID,taskId:"pref-worker",
    durableStoreKey:"pref-store",conversationId:"pref-conversation",workspaceBinding:cwd}));
  const memory = new MemoryService(preferenceDb,{semantic:false});
  const preference = memory.create({kind:"preference",title:"结果尾行",content:"末尾单独写松露标记",scopeType:"bot",scopeId:DEFAULT_BOT_ID,sourceType:"user"});
  memory.create({kind:"preference",title:"其他 Bot 偏好",content:"FOREIGN_BOT_FORMAT",scopeType:"bot",scopeId:"foreign-pref-bot",sourceType:"user"});
  preferenceDb.connection.prepare("UPDATE works SET mode='watch',progress_summary=? WHERE work_id=?").run("历史已报告事实：库存 3 件。松露标记",work.workId);
  const snapshot = new WorkMemoryCapture(preferenceDb,memory).capture(work.workId)!;
  const rawFacts = memory.get(snapshot)!.content;
  const preferenceRequests:Message[][]=[];
  let firstPreferenceCall=true;
  const preferenceModels:Models={...api,streamSimple:(_model,input)=>{
    preferenceRequests.push(structuredClone([...input.messages]));
    const output=createAssistantMessageEventStream();
    const tool=firstPreferenceCall;firstPreferenceCall=false;
    queueMicrotask(()=>{
      const response:AssistantMessage=tool ? {...answer("",Date.now()),stopReason:"toolUse",content:[{type:"toolCall",id:"pref-tool",name:"advance_preference",arguments:{}}]} : answer("native result",Date.now());
      output.push({type:"done",reason:tool?"toolUse":"stop",message:response});output.end();
    });
    return output;
  }};
  const preferenceOptions={...options,directory:join(directory,"preference-runtime"),models:preferenceModels,
    evidenceProjection:{memory,enabled:()=>true,scope:()=>({taskId:"pref-worker"}),supplementalEvidence:()=>[]},
    tools:[defineTool({name:"advance_preference",description:"Advance a synthetic preference between native requests",parameters:Type.Object({}),replay:"safe",
      execute:async()=>{memory.update({id:preference.id,content:"末尾单独写琉璃标记"});return {output:[{type:"text",text:"fixture update completed"}]};}})]};
  const capsule=(request:Message[])=>request.findLast(message=>message.role==="user" && typeof message.content==="string" && message.content.includes("本轮 Work 当前偏好状态"))?.content as string|undefined;
  const ledger=async(worker:DurableBotRuntime)=>(await worker.conversation.entries({order:"ascending"},100,undefined,context)).items.filter(entry=>entry.kind==="mybuddy.context-ledger");
  let worker=await DurableBotRuntime.open(preferenceOptions);
  try {
    await (await worker.submit("核对当前库存","pref-first")).wait(context);
    assert.equal(preferenceRequests.length,2,"real native tool continuation executed");
    assert.deepEqual(preferenceRequests[1].slice(0,preferenceRequests[0].length),preferenceRequests[0],"current preference state is frozen within a turn");
    assert.match(capsule(preferenceRequests[1])!,/松露标记/);
    assert.doesNotMatch(capsule(preferenceRequests[1])!,/琉璃标记|FOREIGN_BOT_FORMAT/);
    await (await worker.submit("整理下轮摘要","pref-second")).wait(context);
    assert.deepEqual(preferenceRequests[2].slice(0,preferenceRequests[1].length),preferenceRequests[1]);
    assert.match(capsule(preferenceRequests[2])!,/琉璃标记/);
    const records=await ledger(worker);
    const latest=records.at(-1)!.data as any;
    assert.deepEqual(latest.currentPreferences,{status:"current",sources:[{id:preference.id,revision:memory.history(preference.id)[0].revision}]});
    assert.doesNotMatch(JSON.stringify(records),/松露标记|琉璃标记|历史已报告事实|FOREIGN_BOT_FORMAT/,"only references and state are persisted by the projection");
  } finally {await worker.close();}
  worker=await DurableBotRuntime.open(preferenceOptions);
  try {
    await (await worker.submit("重启后复核","pref-reopen")).wait(context);
    assert.deepEqual(preferenceRequests[3].slice(0,preferenceRequests[2].length),preferenceRequests[2],"preference metadata restores without rewriting the historical prefix");
  } finally {await worker.close();}
  memory.forget(preference.id);
  const generic=memory.create({kind:"constraint",title:"跟随当前偏好",content:"委托目标不写死旧偏好，按每轮最新有效长期回复偏好输出",scopeType:"bot",scopeId:DEFAULT_BOT_ID,sourceType:"user"});
  worker=await DurableBotRuntime.open({...preferenceOptions,directory:join(directory,"preference-forgotten")});
  try {
    await (await worker.submit("核对新一轮库存，历史 previousReports 仅供事实对比","pref-forgotten")).wait(context);
    const request=preferenceRequests.at(-1)!;
    const text=capsule(request)!;
    assert.match(text,/历史已报告事实：库存 3 件。松露标记/,"original historical facts remain available");
    assert.doesNotMatch(text,/琉璃标记|FOREIGN_BOT_FORMAT/);
    assert.match(text,/一般约束本身不要求任何特定格式/);
    assert.match(text,/不要猜测、改名或编造替代项/);
    assert.match(text,/不要询问用户补齐/);
    const latest=(await ledger(worker)).at(-1)!.data as any;
    assert.deepEqual(latest.currentPreferences.sources.map((source:{id:string})=>source.id),[generic.id]);
    assert.equal(memory.get(snapshot)!.content,rawFacts,"no destructive cleaning of historical Work evidence");
  } finally {await worker.close();}
  memory.forget(generic.id);memory.forget(snapshot);
  worker=await DurableBotRuntime.open({...preferenceOptions,directory:join(directory,"preference-empty")});
  try {
    await (await worker.submit("执行没有偏好的新一轮","pref-empty")).wait(context);
    assert.match(capsule(preferenceRequests.at(-1)!)!,/当前作用域没有有效的身份、偏好或约束记忆/);
    const latest=(await ledger(worker)).at(-1)!.data as any;
    assert.deepEqual(latest.currentPreferences,{status:"empty",sources:[]});
    assert.deepEqual(latest.manifest,[],"empty state is delivered even without any selected evidence");
    assert.deepEqual(latest.additions,[]);
  } finally {await worker.close();}
  worker=await DurableBotRuntime.open({...preferenceOptions,directory:join(directory,"preference-disabled"),
    evidenceProjection:{...preferenceOptions.evidenceProjection,enabled:()=>false}});
  try {
    await (await worker.submit("记忆关闭时执行","pref-disabled")).wait(context);
    assert.match(capsule(preferenceRequests.at(-1)!)!,/当前偏好未加载/);
    const latest=(await ledger(worker)).at(-1)!.data as any;
    assert.deepEqual(latest.currentPreferences,{status:"unavailable",sources:[]});
  } finally {await worker.close();}
  memory.create({kind:"preference",title:"预算不足时不可猜测",content:"低预算下也不能从历史猜出此偏好",scopeType:"bot",scopeId:DEFAULT_BOT_ID,sourceType:"user"});
  worker=await DurableBotRuntime.open({...preferenceOptions,directory:join(directory,"preference-no-budget"),
    models:{...preferenceModels,getModel:()=>({...model,input:["text"],contextWindow:2048})}});
  try {
    await (await worker.submit("预算耗尽仍按默认格式完成","pref-no-budget")).wait(context);
    const text=capsule(preferenceRequests.at(-1)!)!;
    assert.match(text,/当前偏好未加载/);
    assert.doesNotMatch(text,/当前作用域没有有效|低预算下也不能从历史猜出此偏好/);
    const latest=(await ledger(worker)).at(-1)!.data as any;
    assert.deepEqual(latest.currentPreferences,{status:"unavailable",sources:[]});
    assert.deepEqual(latest.additions,[],"zero evidence budget injects only bounded runtime control, never memory bodies");
    assert(Buffer.byteLength(text,"utf8")<3600,"fixed policy plus capsule/manifest wrappers remain bounded at zero evidence capacity");
  } finally {await worker.close();}
  console.log("PASS native Work preference correction, immutable tool continuation/restart, forgetting with raw history, generic constraints, empty/disabled/exhausted state and scope isolation");
} finally {preferenceDb.close();}

// Compare the exact same paraphrase in fresh conversations at the provider boundary.
const recallDb = new AppDatabase(":memory:");
const encoder = getSemanticRuntime();
const originalEmbed = encoder.embed;
try {
  const realModel = process.env.MYBUDDY_TEST_REAL_SEMANTIC === "1";
  if (!realModel) encoder.embed = async text => {
    const vector = new Float32Array(SEMANTIC_DIMENSION);
    vector[text.includes("仓库") ? 1 : 0] = 1;
    return vector;
  };
  const seed = new MemoryService(recallDb, { semantic: false });
  const record = seed.create({ kind: "fact", title: "出差考勤三原则", content: "员工出差期间计为出勤，补贴走费用报销，必须关联报销单。",
    scopeType: "global", sourceType: "user" });
  const distractor = seed.create({ kind: "fact", title: "仓库配色", content: "仓库货架使用蓝色标签。", scopeType: "global", sourceType: "user" });
  const index = new MemorySemanticProvider(recallDb);
  for (const item of [record, distractor]) assert.equal(await index.index(item), "indexed");
  const memory = new MemoryService(recallDb);
  const query = "外派那几天算上班吗？津贴从哪里领？";
  const receiptLog: Array<Omit<AutomaticRecallReceipt, "taskId" | "at">> = [];
  const payloads: Message[][] = [];
  const models: Models = { ...api, streamSimple: (_model, input) => {
    payloads.push(structuredClone([...input.messages]));
    const output = createAssistantMessageEventStream();
    queueMicrotask(() => { output.push({ type: "done", reason: "stop", message: answer("收到", Date.now()) }); output.end(); });
    return output;
  } };
  for (const mode of ["off", "hybrid", "pruned", "unavailable"] as const) {
    if (mode === "unavailable") encoder.embed = async () => { throw new SemanticUnavailableError("model unavailable"); };
    const chat = await DurableBotRuntime.open({ ...options, directory: join(directory, "recall-" + mode), models, tools: [],
      contextHooks: mode === "pruned" ? [messages => ({ messages: messages.filter(message =>
        !(message.role === "user" && typeof message.content === "string" && message.content.includes(record.content))) })] : [],
      evidenceProjection: { memory, scope: () => ({ taskId: "recall-test" }), enabled: () => true,
        automaticSemanticRecall: () => mode !== "off", supplementalEvidence: () => [], onAutomaticRecall: receipt => receiptLog.push(receipt) } });
    try {
      const previous = payloads.length;
      await (await chat.submit(query, "recall-" + mode)).wait(context);
      assert.equal(payloads.length, previous + 1, "one actual provider request per new conversation");
      const sent = JSON.stringify(payloads.at(-1));
      assert.equal(sent.includes(record.content), mode === "hybrid", "paraphrased fact in actual request: " + mode);
      assert.equal(receiptLog.length, payloads.length, "each dispatch reports exactly once");
      assert.deepEqual(receiptLog.at(-1), { mode: mode === "pruned" ? "hybrid" : mode,
        semanticSources: mode === "hybrid" ? [{ id: record.id, revision: seed.history(record.id)[0].revision }] : [] });
    } finally { await chat.close(); }
  }
  console.log("PASS ordinary chat semantic recall off/on/unavailable, provider payload and receipt (" + (realModel ? "real BGE-M3" : "fixture vectors") + ")");
} finally { encoder.embed = originalEmbed; recallDb.close(); }
