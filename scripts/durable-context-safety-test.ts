/** Issue #26 regression tests: production manager/tools, fault-injected durable transactions. No network. */
import assert from "node:assert/strict";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import { estimateTextTokens, estimateMessageTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { EntryRecord } from "@earendil-works/pi-durable";
import { DurableContextManager, splitByTokens, splitByText } from "../src/main/agent/durable/context/DurableContextManager";
import { DurableContextSessionDoc, emptyPersistedState } from "../src/main/agent/durable/context/DurableContextState";
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
  const identity = { sessionId: "safety-fixture-session" };
  let entries = history();
  let head: { id: number } | undefined;
  let rejectWrites = false;
  let summaries = 0;
  let summaryError: Error | undefined;
  const archive = new Map<number, EntryRecord>(entries.map(entry => [entry.id, entry]));
  const summaryRequests: readonly Message[][] = [];
  const model = { id: "fixture", provider: "fixture", contextWindow: 128_000, maxTokens: 4096 };
  const models = {
    getModel: () => model,
    completeSimple: async (_model: unknown, input: { messages: Message[] }) => {
      summaries++;
      (summaryRequests as Message[][]).push(input.messages);
      if (summaryError) throw summaryError;
      return assistant("Earlier notes covered exact paths and versions. Original details remain retrievable.", summaries);
    },
  };
  const conversation = {
    id: 1,
    context: async () => ({ head, entries, messages: entries.flatMap(e => e.model ?? []) }),
    agent: async () => ({ model: { provider: "fixture", modelId: "fixture" } }),
    commit: async (fn: (tx: { doc: () => Promise<typeof doc> }) => unknown) => {
      const next = structuredClone(doc);
      const result = await fn({ doc: async (token: unknown) => token === DurableContextSessionDoc ? identity : next,
        latestHeadMarker: async () => head, latestEntryId: async () => entries.at(-1)?.id } as never);
      if (rejectWrites && JSON.stringify(next) !== JSON.stringify(doc)) throw new Error("injected disk full");
      doc = next;
      return result;
    },
  };
  const manager = new DurableContextManager({ conversation: conversation as never, models: models as never,
    policy: () => ({ ratio: 0.8, absoluteTokens: null }), contextWindow: () => model.contextWindow, outputReserveTokens: () => model.maxTokens });
  return { manager, models, summaryRequests, setOutputLimit: (tokens: number) => { model.maxTokens = tokens; },
    setSummaryError: (error?: Error) => { summaryError = error; },
    doc: () => structuredClone(doc),
    messages: () => entries.flatMap(e => e.model ?? []),
    setRejectWrites: (value: boolean) => { rejectWrites = value; },
    setView: (next: EntryRecord[], headId: number | null) => { entries = next; head = headId === null ? undefined : { id: headId }; for (const entry of next) archive.set(entry.id, entry); },
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
  model: [{ role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: `exact result ${id} ` + "archived tool observation. ".repeat(200) }], isError: false, timestamp: 103 + index }] };
paired.setView(pairRows, 100);
// Regression: kernel recommendations operate on .t/.cN pieces, not native
// messages. A text+parallel-call assistant must be closed into one safe batch
// before invoking the (mocked) summarizer, not rejected after paying for it.
await paired.manager.ensureReady(ctx);
{
  const manager = paired.manager as any;
  const build = manager.buildCoreMessages(paired.messages(), pairRows);
  const turn = manager.core.processTurn({ messages: build.messages, state: manager.kernelState,
    config: manager.buildConfig(128_000, build.protectedIds), tokenCount: 1, tokenCountSource: "estimate", renderTags: "none" });
  const refs = turn.state.messageRefs.byRaw;
  const startRef = refs["e102:0.c0"], endRef = refs["e104:0"];
  assert(startRef && endRef);
  const range = { startRef, endRef, count: 4, tokens: 4000, toolPct: 100, textPct: 0 };
  const closed = manager.safeAutomaticRanges([range], build, turn.state, 128_000);
  const debugTrial = manager.core.applyCompression({ ranges: [{ startRef: refs["e102:0.t"], endRef, summary: "Range validation placeholder describing a complete historical exchange." }], messages: build.messages, state: turn.state, config: manager.buildConfig(128_000, build.protectedIds) });
  assert.equal(closed.length, 1, `valid complete parallel batch must remain compressible: ${JSON.stringify(debugTrial.result)}`);
  assert.equal(closed[0].startRef, refs["e102:0.t"], "include assistant text sibling");
  assert.equal(closed[0].endRef, refs["e104:0"]);
  assert.equal(paired.summaryRequests.length, 0, "planning must never invoke a model");
  const trial = manager.core.applyCompression({ ranges: [{ ...range, summary: "Earlier parallel tool inspection completed successfully for both records." }],
    messages: build.messages, state: turn.state, config: manager.buildConfig(128_000, build.protectedIds) });
  assert.throws(() => manager.renderProjected(build, trial.state), /同一条原生消息/, "old unclosed range reproduces screenshot failure");
  const applied = manager.core.applyCompression({ ranges: [{ ...closed[0], summary: "Earlier parallel tool inspection completed successfully for both records." }],
    messages: build.messages, state: turn.state, config: manager.buildConfig(128_000, build.protectedIds) });
  assert.doesNotThrow(() => manager.renderProjected(build, applied.state));
  const projected = manager.renderProjected(build, applied.state).messages as Message[];
  const beforeTokens = paired.messages().reduce((sum, message) => sum + estimateMessageTokens(message), 0);
  const afterTokens = projected.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
  assert(afterTokens < beforeTokens - 2000, "safe batch must materially reduce actual projected input");
  assert.equal(manager.safeAutomaticRanges([range, range], build, turn.state, 128_000).length, 1,
    "overlapping atomic closures must merge into one summary");
  const recent = { ...range, startRef: refs["e106:0.t"], endRef: refs["e107:0"] };
  assert.equal(manager.safeAutomaticRanges([recent], build, turn.state, 128_000).length, 0,
    "kernel recent protection remains authoritative");
  const originalSnapshot = JSON.stringify(pairRows);
  build.protectedIds.add("e102:0.t");
  assert.equal(manager.safeAutomaticRanges([range], build, turn.state, 128_000).length, 0,
    "atomic closure must not cross protected content");
  assert.equal(paired.summaryRequests.length, 0, "unsafe ranges must cost zero model calls");
  assert.equal(JSON.stringify(pairRows), originalSnapshot, "planning and projection leave original history untouched");
  console.log(`PASS automatic range closure reproduces native split; projected tokens ${beforeTokens} -> ${afterTokens}, planning model calls=0`);
}
await paired.prepare();
await paired.manager.flush(ctx);
// Drive the actual automatic request path with a deterministic kernel nudge.
// The model remains the local fixture; no provider/network call is made.
for (const onlyRecent of [false, true]) {
  const automatic = fixture();
  automatic.setView(pairRows, 100);
  const manager = automatic.manager as any;
  const processTurn = manager.core.processTurn.bind(manager.core);
  manager.core.processTurn = (input: unknown) => {
    const turn = processTurn(input);
    const refs = turn.state.messageRefs.byRaw;
    turn.nudge = { ...turn.nudge, shouldInject: true, compressibleRanges: [{
      startRef: refs[onlyRecent ? "e106:0.t" : "e102:0.c0"],
      endRef: refs[onlyRecent ? "e107:0" : "e104:0"], count: 4, tokens: 5000, toolPct: 100, textPct: 0,
    }] };
    return turn;
  };
  const before = JSON.stringify(pairRows);
  const projected = await automatic.prepare();
  assert.equal(JSON.stringify(pairRows), before, "automatic maintenance preserves cold originals");
  assert.equal(automatic.summaryRequests.length, onlyRecent ? 0 : 1,
    "automatic path summarizes only a preflight-valid complete batch");
  if (!onlyRecent) {
    assert(projected);
    const input = automatic.summaryRequests[0]!.map(message => JSON.stringify(message.content)).join("\n");
    assert(input.includes("Inspect both records") && input.includes("exact result call-a") && input.includes("exact result call-b"),
      "summarizer receives the closed native message and both results");
    for (const id of ["call-a", "call-b"]) {
      assert(input.includes(`[tool-call read (${id})]`), "summary input retains each tool's name and call id");
      assert(input.includes(`[tool-result read (${id}) status=ok]`), "summary input pairs each result with its call and status");
    }
    assert(!projected.messages.some(message => message.role === "toolResult" && ["call-a", "call-b"].includes(message.toolCallId)));
    assert.equal(automatic.doc().stats.folds, 1);
    const recovered = await automatic.manager.retrieveOriginal({ entryId: 102, limit: 12000 }, { entry: automatic.read }, ctx);
    assert(recovered.text.includes('/tmp/a.txt') && recovered.text.includes('/tmp/b.txt'));
  } else assert.equal(automatic.doc().stats.folds, 0);
}
console.log("PASS automatic beforeRequest uses closed batch with one mock summary; protected recent batch uses zero");
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

// 9. Actual model output ceiling participates in the hard input guard, even below the soft trigger.
const outputLimited = fixture();
outputLimited.setView(history(6001, 1, 250_000), 6000);
outputLimited.setOutputLimit(64_000);
await assert.rejects(outputLimited.prepare(), /超过当前模型安全输入上限/);
outputLimited.setOutputLimit(4_096);
await outputLimited.prepare();
console.log("PASS actual output ceiling and hot model-budget changes constrain protected input");
// Maintenance failures must not discard previously committed projection, even when raw history no longer fits.
for (const failures of [0, 2]) {
  const retained = fixture();
  await retained.prepare();
  await retained.manager.flush(ctx);
  const seeded = await retained.manager.applyModelCompression({ startRef: retained.manager.refsForEntry(1)[0]!,
    endRef: retained.manager.refsForEntry(4)[0]!,
    summary: "COMMITTED_CONTEXT: earlier inspections completed; exact paths and records remain retrievable." }, ctx);
  assert.equal(seeded.ok, true, seeded.message);
  retained.setSummaryError(new Error("isolated summary provider failure"));
  for (let attempt = 0; attempt < failures; attempt++) assert.equal((await retained.manager.compressNow(ctx)).applied, false);
  const rows = history(1, 11);
  rows[10] = { ...rows[10]!, model: [
    { role: "user", content: "CURRENT_PROTECTED_REQUEST " + "p".repeat(300_000), timestamp: 11 },
  ] };
  retained.setView(rows, null);
  const beforeCalls = retained.summaryRequests.length;
  const projection = await retained.prepare();
  assert(projection, "failed maintenance must replay the committed summary instead of oversized raw history");
  const text = JSON.stringify(projection.messages);
  assert(text.includes("COMMITTED_CONTEXT"));
  assert(!text.includes("Original 1 exact path"));
  assert(text.includes("CURRENT_PROTECTED_REQUEST"));
  if (failures === 2) assert.equal(retained.summaryRequests.length, beforeCalls, "circuit breaker pauses only new summaries");
  assert.equal(retained.manager.statusSnapshot().phase, "failed", "projection does not falsely report maintenance recovery");
}
console.log("PASS summary failure and circuit breaker preserve committed projection when raw history exceeds the window");

// The real kernel chooses T2/T3 under pressure. The host must consume that plan and summarize only the resident view.
const hierarchy = fixture();
await hierarchy.prepare();
await hierarchy.manager.flush(ctx);
for (const [start, end, label] of [[1, 4, "A"], [5, 6, "B"]] as const) {
  const result = await hierarchy.manager.applyModelCompression({ startRef: hierarchy.manager.refsForEntry(start)[0]!,
    endRef: hierarchy.manager.refsForEntry(end)[0]!,
    summary: `COMMITTED_SUMMARY_${label}: exact archived details remain retrievable. `.repeat(280) }, ctx);
  assert.equal(result.ok, true, result.message);
}
const hierarchyRows = history(1, 11);
hierarchyRows[10] = { ...hierarchyRows[10]!, model: [
  { role: "user", content: "CURRENT_HIERARCHY_REQUEST " + "p".repeat(280_000), timestamp: 11 },
] };
hierarchy.setView(hierarchyRows, null);
// Respect the kernel's bounded wait for a usage sample before estimate-driven pressure nudges.
for (let round = 0; round < 3; round++) {
  assert(await hierarchy.prepare());
  if ((await hierarchy.manager.readState(ctx))?.blocks.some(block => block.active && block.tier === 2)) break;
}
const hierarchyState = await hierarchy.manager.readState(ctx);
const tier2 = hierarchyState?.blocks.find(block => block.active && block.tier === 2);
assert(tier2, "the real T2 kernel nudge must eventually distill resident T1 blocks");
assert(tier2.directBlockIds.includes("b1") && tier2.directBlockIds.includes("b2"));
const hierarchyInput = JSON.stringify(hierarchy.summaryRequests);
assert(hierarchyInput.includes("COMMITTED_SUMMARY_A") && hierarchyInput.includes("COMMITTED_SUMMARY_B"));
assert(!hierarchyInput.includes("Original 1 exact path"), "tier distillation must not reload already-folded raw originals");
assert(!hierarchyInput.includes("CURRENT_HIERARCHY_REQUEST"), "current protected work cannot enter distillation");
const originalAfterMerge = await hierarchy.manager.retrieveOriginal({ blockId: tier2.blockId, limit: 12000 }, { entry: hierarchy.read }, ctx);
assert(originalAfterMerge.text.includes("Original 1 exact path"));

// Replace the T2 summary with a resident long summary through the public compression API, then let the real nudge choose T3.
const longTier2 = await hierarchy.manager.applyModelCompression({ startRef: tier2.blockId, endRef: tier2.blockId,
  summary: "SECOND_TIER_SUMMARY: archived paths, decisions and unfinished work remain retrievable. ".repeat(200) }, ctx);
assert.equal(longTier2.ok, false, "a larger resident summary must not count as successful compression");
console.log("PASS real kernel T2 distillation uses committed summaries, retains originals and rejects resident input growth");

const thirdTier = fixture();
await thirdTier.prepare();
const thirdRows = history(1, 11);
thirdRows[10] = { ...thirdRows[10]!, model: [
  { role: "user", content: "CURRENT_THIRD_TIER_REQUEST", timestamp: 11 },
] };
thirdTier.setView(thirdRows, null);
await thirdTier.prepare();
for (const [start, end, label] of [[1, 2, "A"], [3, 4, "B"], [5, 6, "C"], [7, 8, "D"]] as const) {
  const result = await thirdTier.manager.applyModelCompression({ startRef: thirdTier.manager.refsForEntry(start)[0]!,
    endRef: thirdTier.manager.refsForEntry(end)[0]!, summary: `FIRST_TIER_${label}: archived details. `.repeat(450) }, ctx);
  assert.equal(result.ok, true, result.message);
}
for (const [startRef, endRef, label] of [["b1", "b2", "A"], ["b3", "b4", "B"]] as const) {
  const result = await thirdTier.manager.applyModelCompression({ startRef, endRef,
    summary: `SECOND_TIER_${label}: archived details remain retrievable. `.repeat(350) }, ctx);
  assert.equal(result.ok, true, result.message);
}
thirdRows[10] = { ...thirdRows[10]!, model: [
  { role: "user", content: "CURRENT_THIRD_TIER_REQUEST " + "p".repeat(280_000), timestamp: 11 },
] };
thirdTier.setView(thirdRows, null);
for (let round = 0; round < 3; round++) {
  assert(await thirdTier.prepare());
  if ((await thirdTier.manager.readState(ctx))?.blocks.some(block => block.active && block.tier === 3)) break;
}
const thirdState = await thirdTier.manager.readState(ctx);
const tier3 = thirdState?.blocks.find(block => block.active && block.tier === 3);
assert(tier3, "a real T3 nudge must run even when no uncompressed historical ranges remain");
assert.deepEqual([...tier3.directBlockIds].sort(), ["b5", "b6"]);
const thirdInput = JSON.stringify(thirdTier.summaryRequests);
assert(thirdInput.includes("SECOND_TIER_A") && thirdInput.includes("SECOND_TIER_B"));
assert(!thirdInput.includes("FIRST_TIER_") && !thirdInput.includes("Original 1 exact path"));
assert(!thirdInput.includes("CURRENT_THIRD_TIER_REQUEST"));
const thirdOriginal = await thirdTier.manager.retrieveOriginal({ blockId: tier3.blockId, limit: 12000 }, { entry: thirdTier.read }, ctx);
assert(thirdOriginal.text.includes("Original 1 exact path"));
console.log("PASS real kernel T3 nudge merges T2 summaries with no raw candidates and preserves original retrieval");
console.log("durable context safety tests passed");
