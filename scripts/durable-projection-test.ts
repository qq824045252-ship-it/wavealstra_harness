import assert from "node:assert/strict";
import { mkdtemp, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createAssistantMessageEventStream } from "@earendil-works/pi-ai/compat";
import { createModels, type AssistantMessage, type Message, type Models } from "@earendil-works/pi-ai";
import { AgentDoc, defineTool, type Storage } from "@earendil-works/pi-durable";
import { Type } from "typebox";
import { DurableBotRuntime } from "../src/main/agent/durable/DurableBotRuntime";
import { DURABLE_HISTORY_ENTRY_LIMIT } from "../src/main/agent/durable/DurableHistoryProjection";
import { CONTEXT_LEDGER_VERSION } from "../src/main/agent/EphemeralContextProjection";
import { resolveDurableBranch, captureDurableBranch } from "../src/main/agent/durable/DurableTaskBranch";
import { openDurableStorage } from "../src/main/agent/durable/DurableStorage";
import { findDurableUserEntry } from "../src/main/agent/durable/DurableConversationBranch";
import { DurableConsultIdentity } from "../src/main/agent/durable/DurableConsultSession";

process.env.MYBUDDY_CACHE_TRACE = "0";
const directory = await mkdtemp(join(tmpdir(), "mybuddy-durable-projection-"));
const cwd = join(directory, "workspace"); await mkdir(cwd);
const model = { id: "fixture", name: "fixture", provider: "fixture", api: "openai-completions", baseUrl: "https://fixture.invalid", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 1024,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } } as const;
const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const answer = (text: string, timestamp: number): AssistantMessage => ({ role: "assistant", content: [{ type: "text", text }], stopReason: "stop", api: model.api, model: model.id, provider: model.provider, timestamp, usage });
const history: Message[] = Array.from({ length: 65 }, (_, i) => [{ role: "user", content: `old question ${i}`, timestamp: i * 2 + 1 } satisfies Message, answer(`old answer ${i}`, i * 2 + 2)]).flat();
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
