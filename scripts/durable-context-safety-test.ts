/** Issue #26 regression tests: production manager/tools, fault-injected durable transactions. No network. */
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { estimateTextTokens, estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { DurableContextManager, splitByTokens, splitByText } from "../src/main/agent/durable/context/DurableContextManager";
import { emptyPersistedState } from "../src/main/agent/durable/context/DurableContextState";
import { searchOriginalEntries, createDurableContextTools, isDurableContextToolName } from "../src/main/agent/durable/context/DurableContextTools";

function assistant(text: string, at: number): AssistantMessage {
  return { role: "assistant", content: [{ type: "text", text }], stopReason: "stop", timestamp: at,
    api: "openai-completions", model: "fixture", provider: "fixture",
    usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
function history(base = 1, size = 10, chars = 14_000): EntryRecord[] {
  return Array.from({ length: size }, (_, index) => {
    const text = `Original ${base + index} exact path /tmp/context-${base + index}.txt version v4.7 ERROR_26.\n` + "archive observation ".repeat(Math.ceil(chars / 20));
    const message: Message = index % 2 ? assistant(text, base + index) : { role: "user", content: text, timestamp: base + index };
    return { id: base + index, conversationId: 1, kind: message.role === "assistant" ? "pi.assistant" : "pi.user", model: [message] } as unknown as EntryRecord;
  });
}
function fixture() {
  let doc = emptyPersistedState();
  let entries = history();
  let head: { id: number } | undefined;
  let rejectWrites = false;
  let summaries = 0;
  const archive = new Map<number, EntryRecord>(entries.map(entry => [entry.id, entry]));
  const summaryRequests: readonly Message[][] = [];
  const model = { id: "fixture", provider: "fixture", contextWindow: 128_000, maxTokens: 4096 };
  const models = {
    getModel: () => model,
    completeSimple: async (_model: unknown, input: { messages: Message[] }) => {
      summaries++;
      (summaryRequests as Message[][]).push(input.messages);
      return assistant("Earlier notes covered exact paths and versions. Original details remain retrievable.", summaries);
    },
  };
  const conversation = {
    id: 1,
    context: async () => ({ head, entries, messages: entries.flatMap(e => e.model ?? []) }),
    agent: async () => ({ model: { provider: "fixture", modelId: "fixture" } }),
    commit: async (fn: (tx: { doc: () => Promise<typeof doc> }) => unknown) => {
      const next = structuredClone(doc);
      const result = await fn({ doc: async () => next });
      if (rejectWrites && JSON.stringify(next) !== JSON.stringify(doc)) throw new Error("injected disk full");
      doc = next;
      return result;
    },
  };
  const manager = new DurableContextManager({ conversation: conversation as never, models: models as never,
    policy: () => ({ ratio: 0.8, absoluteTokens: null }), contextWindow: () => model.contextWindow });
  return { manager, models, summaryRequests,
    doc: () => structuredClone(doc),
    messages: () => entries.flatMap(e => e.model ?? []),
    setRejectWrites: (value: boolean) => { rejectWrites = value; },
    setView: (next: EntryRecord[], headId: number) => { entries = next; head = { id: headId }; for (const entry of next) archive.set(entry.id, entry); },
    read: async (id: number) => archive.get(id),
    prepare: () => manager.beforeRequest(entries.flatMap(e => e.model ?? []), { models } as never, ctx),
  };
}

// 1. A single oversized message, including CJK/emoji, must be split without dropping a character.
for (const text of ["A".repeat(220_000), "请保留原文路径和错误。🧭".repeat(18_000)]) {
  const chunks = splitByText(text, 2000);
  assert(chunks.length > 1);
  assert.equal(chunks.join(""), text);
  assert(chunks.every(chunk => estimateTextTokens(chunk) <= 2000));
  const messages = splitByTokens([{ role: "user", content: text, timestamp: 1 }], 2000);
  assert(messages.every(chunk => estimateTextTokens(chunk) <= 2000));
  assert.equal(messages.join(""), `user: ${text}`);
}
console.log("PASS oversized single-message chunks preserve exact text and token bounds");

// The foreground policy admits exactly the registered context namespace.
const contextTools = createDurableContextTools({ manager: async () => undefined });
for (const tool of contextTools) assert.equal(isDurableContextToolName(tool.name), true);
assert.equal(isDurableContextToolName("acp_untrusted_extension"), false);

// 2. Assistant .t/.cN raw IDs must resolve to their durable entry instead of Number('0.t') => NaN.
const first = fixture();
await first.prepare();
await first.manager.flush(ctx);
const assistantRefs = first.manager.refsForEntry(2);
assert(assistantRefs.length > 0, "assistant must receive retrievable refs");
const recovered = await first.manager.retrieveOriginal({ ref: assistantRefs[0], limit: 400 }, { entry: first.read }, ctx);
assert(recovered.text.includes("Original 2 exact path /tmp/context-2.txt version v4.7 ERROR_26."));
console.log("PASS assistant refs recover exact original text");

// Text and parallel call slots share a provider message and cannot be folded independently.
const paired = fixture();
const pairRows = history(101, 7, 8000);
const call = assistant("Inspect both records. " + "parallel inspection context. ".repeat(250), 102);
call.content.push({ type: "toolCall", id: "call-a", name: "read", arguments: { path: "/tmp/a.txt" } },
  { type: "toolCall", id: "call-b", name: "read", arguments: { path: "/tmp/b.txt" } });
call.stopReason = "toolUse";
pairRows[1] = { ...pairRows[1]!, model: [call] };
for (const [index, id] of [[2, "call-a"], [3, "call-b"]] as const) pairRows[index] = { ...pairRows[index]!, kind: "pi.tool-result",
  model: [{ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: `exact result ${id}` }], isError: false, timestamp: 103 + index }] };
paired.setView(pairRows, 100);
await paired.prepare();
await paired.manager.flush(ctx);
assert.equal(paired.manager.refsForEntry(102).length, 3, "text and both call slots have original locators");
for (const ref of paired.manager.refsForEntry(102)) {
  const original = await paired.manager.retrieveOriginal({ ref, limit: 12000 }, { entry: paired.read }, ctx);
  assert(original.text.includes('/tmp/a.txt') && original.text.includes('/tmp/b.txt'));
}
const partialBefore = paired.doc();
try {
  const partial = await paired.manager.applyModelCompression({ startRef: paired.manager.refsForEntry(102)[0]!,
    endRef: paired.manager.refsForEntry(102)[0]!, summary: "A partial range must not remove sibling calls." }, ctx);
  assert.equal(partial.ok, false);
} catch (error) { assert.match(String(error), /拆分|范围|tool|protected/); }
assert.deepEqual(paired.doc(), partialBefore, "rejected partial coverage cannot commit a new view");
const completePair = await paired.manager.applyModelCompression({ startRef: paired.manager.refsForEntry(101)[0]!,
  endRef: paired.manager.refsForEntry(104)[0]!, summary: "Two local records were read and both completed successfully. Exact original calls and results remain retrievable." }, ctx);
assert.equal(completePair.ok, true, completePair.message);
const pairedProjection = await paired.prepare();
assert(pairedProjection);
assert(!pairedProjection.messages.some(message => message.role === "toolResult" && ["call-a", "call-b"].includes(message.toolCallId)));
console.log("PASS parallel tool-call refs and atomic full-exchange coverage");

// 3. A durable commit failure must not report or retain applied coverage.
const before = first.doc();
first.setRejectWrites(true);
const failed = await first.manager.compressNow(ctx);
assert.equal(failed.applied, false);
assert.match(failed.skippedReason ?? "", /未保存|disk full/);
assert.equal(first.manager.statusSnapshot().phase, "failed");
assert.deepEqual(first.doc(), before);
assert.equal((await first.manager.readState(ctx))?.blocks.length ?? 0, 0);
first.setRejectWrites(false);
console.log("PASS disk-write failure rejects success and discards uncommitted coverage");

// 4. Successful summaries have bounded provider payloads, including one joined original range.
const compact = await first.manager.compressNow(ctx);
assert.equal(compact.applied, true, JSON.stringify(compact));
assert(first.summaryRequests.length > 1, "long range must use more than one bounded summary request");
for (const request of first.summaryRequests) {
  const tokens = request.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
  assert(tokens < 26_000, `summary request ${tokens} must remain bounded`);
}
console.log("PASS range summarization sends bounded provider inputs");

// 5. A changed native head must not reissue refs/block IDs, and old originals remain available.
const oldRef = assistantRefs[0]!;
const oldBlock = first.doc().summaries[0]!;
const previousMax = Math.max(...Object.keys(first.doc().refs).map(ref => Number(ref.slice(1))));
first.setView(history(2001, 10, 1000), 2000);
await first.prepare();
const newRefs = first.manager.refsForEntry(2002);
assert(newRefs.length > 0);
assert(newRefs.every(ref => Number(ref.slice(1)) > previousMax));
const oldAgain = await first.manager.retrieveOriginal({ ref: oldRef, limit: 400 }, { entry: first.read }, ctx);
assert(oldAgain.text.includes("Original 2 exact path"));
const blockAgain = await first.manager.retrieveOriginal({ blockId: oldBlock.blockId, limit: 400 }, { entry: first.read }, ctx);
assert(blockAgain.text.includes("Original 1 exact path"));
console.log("PASS native head changes preserve old ref/block identity and original retrieval");

// 6. Block reads fetch only the page's entries; cursor pages concatenate to the original prefix.
let reads = 0;
const reader = { entry: async (id: number) => { reads++; return first.read(id); } };
const page1 = await first.manager.retrieveOriginal({ blockId: oldBlock.blockId, limit: 500 }, reader, ctx);
assert.equal(reads, 1);
assert(page1.page?.nextCursor);
const page2 = await first.manager.retrieveOriginal({ blockId: oldBlock.blockId, limit: 500, cursor: page1.page.nextCursor }, reader, ctx);
assert.equal(reads, 2);
const prefix = await first.manager.retrieveOriginal({ blockId: oldBlock.blockId, limit: 1000 }, { entry: first.read }, ctx);
assert.equal(page1.text + page2.text, prefix.text);
await assert.rejects(first.manager.retrieveOriginal({ entryId: 2002, cursor: page1.page.nextCursor }, reader, ctx), /不一致/);
console.log("PASS bounded retrieval and target-bound continuation cursors");

// 7. The 401st old record is discoverable without lying that the first 400 are the whole archive.
const records = history(1, 650, 40).map(entry => ({ ...entry, model: [{ role: "user", content: entry.id === 2 ? "needle beyond first search page" : "haystack", timestamp: entry.id }] })) as EntryRecord[];
const api = { conversationId: 1, commit: async (fn: (tx: { scanEntries: (filter: { maxEntryId?: number }, limit: number) => unknown }) => unknown) => fn({
  scanEntries: (filter, limit) => {
    const visible = records.filter(record => filter.maxEntryId === undefined || record.id <= filter.maxEntryId).reverse();
    return { items: visible.slice(0, limit), next: visible.length > limit ? "more" : undefined };
  },
}) };
const search1 = await searchOriginalEntries(api as never, "needle", 8, ctx);
assert.equal(search1.hits.length, 0);
assert.equal(search1.scanned, 400);
assert(search1.nextBeforeEntryId !== undefined);
const search2 = await searchOriginalEntries(api as never, "needle", 8, ctx, search1.nextBeforeEntryId);
assert.equal(search2.hits[0]?.entryId, 2);
assert.equal(search2.nextBeforeEntryId, undefined);
console.log("PASS original searches resume beyond the old 400-record cutoff");

// 8. Oversized protected current input is rejected, never silently sent as a raw fallback.
const over = fixture();
over.setView(history(5001, 1, 600_000), 5000);
await assert.rejects(over.prepare(), /超过当前模型安全输入上限/);
console.log("PASS oversized protected input cannot escape via raw fallback");

console.log("durable context safety tests passed (8 behavior groups)");
