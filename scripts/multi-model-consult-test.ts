import { getEventListeners } from "node:events";
/** Offline contract/security tests. Live provider/UI acceptance is a separate script. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { SessionManager, type AgentSession, type AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { createConsultReadTools, runMultiModelConsult, consultToolResult } from "../src/main/capabilities/MultiModelConsult";
import { TaskFileAccessPolicy } from "../src/main/security/TaskFileAccessPolicy";
import { mapPiEventToPatches } from "../src/shared/pi-event-mapper";
import { loadTaskHistoryFromSession } from "../src/main/agent/session-history";
import { BuiltinCapabilityStore } from "../src/main/capabilities/BuiltinCapabilityStore";
import { DEFAULT_BUILTIN_CAPABILITIES_CONFIG } from "../src/shared/builtin-capabilities";
import { CONSULT_MAX_PARALLEL, CONSULT_MAX_TOOL_BUDGET, CONSULT_DEFAULT_TOOL_CALLS, DEFAULT_MULTI_MODEL_CONSULT_CONFIG, consultDistinctModelCount, consultParticipantKey, normalizeConsultConfig, requestConsultForMessage, type MultiModelConsultConfig, type MultiModelConsultReport } from "../src/shared/multi-model-consult";

const checks: string[] = [];
const check = (name: string, fn: () => void) => { fn(); checks.push(name); };
const config: MultiModelConsultConfig = { ...DEFAULT_MULTI_MODEL_CONSULT_CONFIG, enabled: true, participants: [{ modelId: "provider/a" }, { modelId: "provider/b" }], maxParallel: 2 };
const root = mkdtempSync(join(tmpdir(), "mybuddy-consult-unit-"));
const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
let created = 0, disposed = 0, active = 0, peak = 0;
const prompts: string[] = [];
function sessionFixture(id: string, options: { error?: boolean; delayed?: number; long?: boolean } = {}): AgentSession {
  created++;
  let listener: ((event: AgentSessionEvent) => void) | undefined;
  let release: (() => void) | undefined;
  let aborted = false;
  const emit = (event: unknown) => listener?.(event as AgentSessionEvent);
  return {
    model: { name: id }, thinkingLevel: "off",
    subscribe: (fn: (event: AgentSessionEvent) => void) => { listener = fn; return () => { listener = undefined; }; },
    prompt: async (text: string) => {
      prompts.push(text); active++; peak = Math.max(peak, active);
      try {
        emit({ type: "message_start", message: { role: "assistant" } });
        await Promise.race([wait(options.delayed ?? 15), new Promise<void>((resolve) => { release = resolve; })]);
        if (aborted) return;
        emit({ type: "tool_execution_start", toolCallId: id + "-read", toolName: "read", args: { path: "sample.txt" } });
        emit({ type: "tool_execution_end", toolCallId: id + "-read", toolName: "read", result: { content: [{ type: "text", text: "actual unit file contents" }] }, isError: false });
        const answer = options.long ? id + ":" + "独立原始答案".repeat(2500) : id + " independent answer";
        emit({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: answer } });
        emit({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: answer }], stopReason: options.error ? "error" : "stop", errorMessage: options.error ? "provider refused" : undefined } });
      } finally { active--; }
    },
    abort: async () => { aborted = true; release?.(); },
    dispose: () => { disposed++; },
    getSessionStats: () => ({ tokens: { input: 10, output: 20, cacheRead: 0, cacheWrite: 0 } }),
  } as unknown as AgentSession;
}

try {
  check("legacy config defaults to disabled and no auto-selected models", () => assert.deepEqual(normalizeConsultConfig(undefined), DEFAULT_MULTI_MODEL_CONSULT_CONFIG));
  check("normalization deduplicates identities and bounds resource settings", () => {
    const normalized = normalizeConsultConfig({ enabled: true, participants: [{ modelId: " p/a " }, { modelId: "p/a" }], maxParallel: 999, timeoutSeconds: -3 });
    assert.equal(normalized.participants.length, 1); assert.equal(normalized.maxParallel, CONSULT_MAX_PARALLEL); assert.equal(normalized.timeoutSeconds, 10);
    assert.equal(normalized.maxToolCalls, CONSULT_DEFAULT_TOOL_CALLS);
  });
  check("participant count has no product limit and the tail is never dropped", () => {
    const many = normalizeConsultConfig({ enabled: true, participants: Array.from({ length: 12 }, (_, i) => ({ modelId: `p/m${i}` })) });
    assert.equal(many.participants.length, 12);
    assert.equal(normalizeConsultConfig({ enabled: true, participants: [{ modelId: "p/a" }], maxToolCalls: 0 }).maxToolCalls, 0);
  });
  check("one model may take part at several thinking levels, exact duplicates still collapse", () => {
    const levels = normalizeConsultConfig({ enabled: true, participants: [{ modelId: "p/a", thinkingLevel: "high" }, { modelId: "p/a", thinkingLevel: "max" }, { modelId: "p/a", thinkingLevel: "max" }] });
    assert.equal(levels.participants.length, 2);
    assert.equal(consultDistinctModelCount(levels.participants), 1);
    assert.deepEqual(levels.participants.map((p) => consultParticipantKey(p)), ["p/a::high", "p/a::max"]);
  });
  const storePath = join(root, "capabilities.json");
  const store = new BuiltinCapabilityStore(storePath);
  const legacy = structuredClone(DEFAULT_BUILTIN_CAPABILITIES_CONFIG) as Partial<typeof DEFAULT_BUILTIN_CAPABILITIES_CONFIG>;
  delete legacy.multiModelConsult;
  writeFileSync(storePath, JSON.stringify(legacy));
  check("existing capability file gains safe defaults", () => assert.equal(store.read().multiModelConsult.enabled, false));
  store.write({ ...store.read(), multiModelConsult: config });
  check("participant configuration persists without changing other capabilities", () => { assert.deepEqual(store.read().multiModelConsult, config); assert.equal(store.read().vision.enabled, true); });
  const run = (overrides: Partial<Parameters<typeof runMultiModelConsult>[0]> = {}) => runMultiModelConsult({ id: "unit", taskId: "task", input: { task: "Analyze the same problem", context: "Shared facts, no model opinions." }, config, createSession: async (p) => sessionFixture(p.modelId), ...overrides });
  await assert.rejects(run({ config: { ...config, enabled: false } }), /关闭/);
  await assert.rejects(run({ config: { ...config, participants: [config.participants[0]!] } }), /至少 2 个/);
  await assert.rejects(run({ config: { ...config, participants: [config.participants[0]!, config.participants[0]!] } }), /至少 2 个/);
  await assert.rejects(run({ config: { ...config, participants: [{ modelId: "p/a", thinkingLevel: "high" }, { modelId: "p/a", thinkingLevel: "high" }] } }), /至少 2 个/);
  await assert.rejects(run({ config: { ...config, maxParallel: 0 } }), /配置无效/);
  await assert.rejects(run({ config: { ...config, timeoutSeconds: Number.NaN } }), /配置无效/);
  await assert.rejects(run({ config: { ...config, maxToolCalls: -1 } }), /配置无效/);
  await assert.rejects(run({ config: { ...config, maxToolCalls: 1.5 } }), /配置无效/);
  await assert.rejects(run({ config: { ...config, maxToolCalls: CONSULT_MAX_TOOL_BUDGET + 1 } }), /配置无效/);
  check("disabled/invalid consultations make zero model calls", () => assert.equal(created, 0));

  const snapshots: MultiModelConsultReport[] = [];
  const report = await run({ onUpdate: (snapshot) => snapshots.push(snapshot), createSession: async (p) => sessionFixture(p.modelId, { long: true }) });
  check("both independently configured models complete", () => { assert.equal(report.status, "complete"); assert.equal(report.succeeded, 2); });
  check("parallel calls use identical explicit task/evidence only", () => { assert.equal(new Set(prompts).size, 1); assert.equal(prompts[0]?.includes("independent answer"), false); assert.equal(peak, 2); });
  check("worker sessions are disposed", () => assert.equal(created, disposed));
  check("progress snapshots are immutable", () => { assert.equal(snapshots[0]!.workers[0]!.status, "queued"); assert.equal(snapshots.at(-1)!.status, "complete"); });
  check("raw answers are not truncated or replaced with judge prose", () => { assert(report.workers[0]!.answer.length > 4000); assert(consultToolResult(report).content[0]!.text.includes(report.workers[1]!.answer)); });
  check("actual tool identities/arguments/results are recorded", () => { assert.equal(report.workers[0]!.tools[0]!.name, "read"); assert.equal(report.workers[0]!.tools[0]!.status, "success"); });

  const one = await run({ createSession: async (p) => { if (p.modelId.endsWith("/b")) throw new Error("unavailable"); return sessionFixture(p.modelId); } });
  check("one successful model is degraded, never full verification", () => { assert.equal(one.status, "degraded"); assert.equal(one.succeeded, 1); assert.equal(one.workers[1]!.error, "unavailable"); });
  const failed = await run({ createSession: async (p) => sessionFixture(p.modelId, { error: true }) });
  check("provider failures with partial prose are still failures", () => { assert.equal(failed.status, "failed"); assert.equal(consultToolResult(failed).isError, true); });
  const partial = await run({ config: { ...config, participants: [...config.participants, { modelId: "provider/c" }] }, createSession: async (p) => { if (p.modelId.endsWith("/c")) throw Error("offline"); return sessionFixture(p.modelId); } });
  check("two of three is explicitly partial", () => assert.equal(partial.status, "partial"));
  const wideConfig = { ...config, participants: Array.from({ length: 9 }, (_, i) => ({ modelId: `provider/w${i}` })) };
  const wide = await run({ config: wideConfig });
  check("more than six configured models all run without a count cap", () => {
    assert.equal(wide.expected, 9); assert.equal(wide.succeeded, 9); assert.equal(wide.status, "complete");
    assert.equal(new Set(wide.workers.map((w) => w.modelId)).size, 9);
  });
  const sameModelConfig = { ...config, participants: [{ modelId: "provider/a", thinkingLevel: "high" }, { modelId: "provider/a", thinkingLevel: "max" }] };
  const dispatched: Array<{ modelId: string; thinkingLevel?: string }> = [];
  const sameModel = await run({ config: sameModelConfig, createSession: async (p) => { dispatched.push({ modelId: p.modelId, thinkingLevel: p.thinkingLevel }); return sessionFixture(p.modelId); } });
  check("one model at two thinking levels runs twice and is labelled as such", () => {
    assert.equal(sameModel.status, "complete"); assert.equal(sameModel.expected, 2); assert.equal(sameModel.succeeded, 2);
    assert.deepEqual(dispatched.map((p) => p.thinkingLevel), ["high", "max"]);
    assert.deepEqual(sameModel.workers.map((w) => w.modelId), ["provider/a", "provider/a"]);
    assert.equal(consultDistinctModelCount(sameModel.workers), 1);
    const text = consultToolResult(sameModel).content[0]!.text;
    assert.match(text, /同一模型的不同思考等级是同一模型的两个样本/);
  });

  const cancelled = new AbortController();
  const beforeCancel = created;
  const cancelRun = run({ signal: cancelled.signal, config: { ...config, maxParallel: 1 }, createSession: async (p) => sessionFixture(p.modelId, { delayed: 1000 }) });
  setTimeout(() => cancelled.abort(), 20);
  const cancellation = await cancelRun;
  check("cancel stops the active worker and never starts queued workers", () => { assert.equal(cancellation.status, "cancelled"); assert.equal(created - beforeCancel, 1); assert(cancellation.workers.every((w) => w.status === "cancelled")); assert.equal(created, disposed); });
  const timed = await run({ config: { ...config, timeoutSeconds: 0.02 }, createSession: async (p) => { await wait(50); return sessionFixture(p.modelId); } });
  await wait(80); // Creation may finish after the cancelled consultation has already returned.
  check("late-created sessions after timeout are disposed", () => { assert(timed.workers.every((w) => w.status === "timeout")); assert.equal(created, disposed); });

  const stalledSignals: AbortSignal[] = [];
  const stalledStarted = Date.now();
  const stalled = await run({ config: { ...config, timeoutSeconds: 0.02 }, createSession: async (_participant, signal) => { stalledSignals.push(signal); return new Promise<AgentSession>(() => {}); } });
  check("hung session creation does not block timeout", () => { assert.equal(stalled.status, "failed"); assert(stalled.workers.every((w) => w.status === "timeout")); assert(Date.now() - stalledStarted < 1000); });
  check("timed-out hung operations detach their cancellation listeners", () => assert(stalledSignals.every((signal) => getEventListeners(signal, "abort").length === 0)));
  const stubbornStarted = Date.now();
  const stubborn = await run({ config: { ...config, timeoutSeconds: 0.02 }, createSession: async (p) => {
    const value = sessionFixture(p.modelId); value.prompt = async () => new Promise<void>(() => {}); return value;
  } });
  check("a prompt ignoring abort cannot trap the fan-in", () => { assert.equal(stubborn.status, "failed"); assert(Date.now() - stubbornStarted < 1000); assert.equal(created, disposed); });

  // --- Direct per-participant terminate: one stuck/looping model must not force an idle wait. ---
  const loopingStops: Array<Parameters<NonNullable<Parameters<typeof runMultiModelConsult>[0]["onControls"]>>[0]> = [];
  const loopingStarted = Date.now();
  const looping = run({
    config: { ...config, timeoutSeconds: 600 },
    onControls: (controls) => loopingStops.push(controls),
    createSession: async (p) => {
      if (!p.modelId.endsWith("/b")) return sessionFixture(p.modelId, { delayed: 30 });
      const value = sessionFixture(p.modelId);
      value.prompt = async () => new Promise<void>(() => {}); // ignores abort: an unbounded model loop
      return value;
    },
  });
  // Controls must exist before any participant starts, otherwise the UI cannot reach a live worker.
  check("live terminate controls exist before the first participant starts", () => assert.equal(loopingStops.length, 1));
  setTimeout(() => loopingStops[0]!.stopWorker(1), 40);
  const loopingStopped = await looping;
  check("a looping participant is terminated directly without waiting for its timeout", () => {
    assert.equal(loopingStopped.workers[1]!.status, "cancelled");
    assert.match(loopingStopped.workers[1]!.error ?? "", /用户终止/);
    assert.equal(Date.now() - loopingStarted < 1000, true, "terminate must not wait for the 600s timeout");
  });
  check("terminating one participant keeps its siblings and the report usable", () => {
    assert.equal(loopingStopped.workers[0]!.status, "complete");
    assert.equal(loopingStopped.succeeded, 1);
    assert.equal(loopingStopped.status, "degraded");
    assert.equal(loopingStops[0]!.stopWorker(1), false, "an already terminated participant cannot be terminated twice");
    assert.equal(created, disposed);
  });

  const queuedStops: typeof loopingStops = [];
  const queuedStarted: string[] = [];
  const queuedRun = run({
    config: { ...config, participants: [{ modelId: "provider/q1" }, { modelId: "provider/q2" }], maxParallel: 1, timeoutSeconds: 600 },
    onControls: (controls) => queuedStops.push(controls),
    createSession: async (p) => {
      queuedStarted.push(p.modelId);
      const value = sessionFixture(p.modelId);
      value.prompt = async () => new Promise<void>(() => {});
      return value;
    },
  });
  setTimeout(() => queuedStops[0]!.stopWorker(1), 40);
  setTimeout(() => queuedStops[0]!.stopWorker(0), 90);
  const queuedStopped = await queuedRun;
  check("a terminate request on a still-queued participant prevents it from ever starting", () => {
    assert.deepEqual(queuedStarted, ["provider/q1"]);
    assert.equal(queuedStopped.workers[1]!.status, "cancelled");
    assert.match(queuedStopped.workers[1]!.error ?? "", /用户终止/);
    assert.equal(queuedStopped.status, "failed");
    assert.equal(created, disposed);
  });

  const settledStops: typeof loopingStops = [];
  const settled = await run({ onControls: (controls) => settledStops.push(controls) });
  const settledSnapshot = JSON.stringify(settled.workers);
  check("terminating an already settled participant is a no-op and never rewrites the report", () => {
    assert.equal(settledStops[0]!.stopWorker(0), false);
    assert.equal(settledStops[0]!.stopWorker(99), false);
    assert.equal(JSON.stringify(settled.workers), settledSnapshot);
    assert.equal(settled.status, "complete");
  });

  const hangingDisposeStarted = Date.now();
  const hangingDispose = await run({
    config: { ...config, timeoutSeconds: 0.02 },
    createSession: async (p) => {
      const value = sessionFixture(p.modelId);
      value.prompt = async () => new Promise<void>(() => {});
      const dispose = value.dispose.bind(value);
      // Disposal counts as attempted but never converges: the fan-in must still return.
      value.dispose = () => { dispose(); return new Promise<void>(() => {}); };
      return value;
    },
  });
  check("a cleanup that never converges is bounded and reported instead of holding the UI", () => {
    assert.equal(hangingDispose.status, "failed");
    assert(hangingDispose.workers.every((w) => w.endedAt && /清理异常/.test(w.error ?? "")));
    assert(Date.now() - hangingDisposeStarted < 6000, "bounded cleanup must return quickly");
    assert.equal(created, disposed);
  });
  const observer = await run({ onUpdate: () => { throw Error("detached renderer"); } });
  check("observer failure cannot break collection or session disposal", () => { assert.equal(observer.status, "complete"); assert.equal(created, disposed); });
  const badCleanup = await run({ createSession: async (p) => { const value = sessionFixture(p.modelId); const dispose = value.dispose.bind(value); value.dispose = () => { dispose(); throw Error("disposal failed"); }; return value; } });
  check("dispose exceptions become terminal worker errors, not orphaned running reports", () => { assert.equal(badCleanup.status, "failed"); assert(badCleanup.workers.every((w) => w.endedAt && w.error?.includes("清理异常"))); assert.equal(created, disposed); });
  const completionAbort = new AbortController();
  const completedBeforeCancel = await run({ signal: completionAbort.signal, onUpdate: (snapshot) => { if (snapshot.workers.every((w) => w.status === "complete")) completionAbort.abort(); } });
  check("completed work is not relabeled cancelled by a late abort", () => assert.equal(completedBeforeCancel.status, "complete"));

  const mapperContext = { taskId: "task", messageId: "message", startedAt: Date.now() };
  const update = mapPiEventToPatches({ type: "tool_execution_update", toolCallId: "unit", toolName: "multi_model_consult", partialResult: consultToolResult(report) } as never, mapperContext);
  check("live report bypasses generic 2000-character tool preview", () => { const p = update[0] as { consult: MultiModelConsultReport }; assert.equal(p.consult.workers[0]!.answer, report.workers[0]!.answer); });
  const ended = mapPiEventToPatches({ type: "tool_execution_end", toolCallId: "unit", toolName: "multi_model_consult", result: consultToolResult(report), isError: false } as never, mapperContext);
  check("terminal report carries structured details", () => assert.equal((ended[0] as { consult: MultiModelConsultReport }).consult.status, "complete"));

  const workspace = join(root, "workspace"); mkdirSync(workspace);
  writeFileSync(join(workspace, "sample.txt"), "real fixture content");
  writeFileSync(join(root, "outside.txt"), "must not read");
  const controller = new AbortController(); let limited = false;
  const policy = new TaskFileAccessPolicy({ taskId: "task", taskRoot: workspace });
  const tools = createConsultReadTools({ cwd: workspace, policy, signal: controller.signal, onToolLimit: () => { limited = true; controller.abort(); }, isEnabled: () => true, maxToolCalls: CONSULT_DEFAULT_TOOL_CALLS });
  check("native child surface is exactly read/grep/find/ls", () => assert.deepEqual(tools.map((t) => t.name), ["read", "grep", "find", "ls"]));
  const read = tools[0]!;
  const readResult = await read.execute("read", { path: "sample.txt" }, undefined, undefined, { cwd: workspace } as never);
  check("native read tool executes against the real filesystem", () => assert(JSON.stringify(readResult).includes("real fixture content")));
  await assert.rejects(read.execute("outside", { path: "../outside.txt" }, undefined, undefined, { cwd: workspace } as never), /taskRoot|路径/);
  checks.push("outside reads are rejected by parent's file policy");
  const outsideDir = join(root, "outside-dir"); mkdirSync(outsideDir); writeFileSync(join(outsideDir, "secret.txt"), "not authorized");
  symlinkSync(outsideDir, join(workspace, "escape"), "junction");
  await assert.rejects(read.execute("link", { path: "escape/secret.txt" }, undefined, undefined, { cwd: workspace } as never), /taskRoot|路径/);
  checks.push("junction escape outside task is rejected");
  for (let i = 0; i < CONSULT_DEFAULT_TOOL_CALLS; i++) {
    try { await read.execute(String(i), { path: "sample.txt" }, undefined, undefined, { cwd: workspace } as never); } catch { break; }
  }
  check("native read budget stops instead of recurring forever", () => assert.equal(limited, true));
  // The budget is a user setting now: a smaller value stops earlier, and 0 removes the budget entirely.
  let smallBudgetHit = false;
  const smallBudget = createConsultReadTools({ cwd: workspace, policy, signal: new AbortController().signal, onToolLimit: () => { smallBudgetHit = true; }, isEnabled: () => true, maxToolCalls: 2 });
  const smallRead = smallBudget[0]!;
  await smallRead.execute("b1", { path: "sample.txt" }, undefined, undefined, { cwd: workspace } as never);
  await smallRead.execute("b2", { path: "sample.txt" }, undefined, undefined, { cwd: workspace } as never);
  await assert.rejects(smallRead.execute("b3", { path: "sample.txt" }, undefined, undefined, { cwd: workspace } as never), /2 次只读工具预算/);
  check("a configured tool budget stops the model exactly at the user value", () => assert.equal(smallBudgetHit, true));
  let unlimitedHit = false;
  const unlimited = createConsultReadTools({ cwd: workspace, policy, signal: new AbortController().signal, onToolLimit: () => { unlimitedHit = true; }, isEnabled: () => true, maxToolCalls: 0 });
  const unlimitedRead = unlimited[0]!;
  for (let i = 0; i < CONSULT_DEFAULT_TOOL_CALLS + 6; i++) await unlimitedRead.execute(String(i), { path: "sample.txt" }, undefined, undefined, { cwd: workspace } as never);
  check("budget 0 means no call limit instead of stopping the model", () => assert.equal(unlimitedHit, false));

  const readCancellation = new AbortController();
  const sdkCancellation = new AbortController();
  const cancellingTools = createConsultReadTools({ cwd: workspace, policy, signal: readCancellation.signal, onToolLimit: () => undefined, isEnabled: () => true, maxToolCalls: CONSULT_DEFAULT_TOOL_CALLS });
  const inFlightGrep = cancellingTools.find((tool) => tool.name === "grep")!.execute("cancel-grep", { pattern: "nonexistent", path: "sample.txt" }, sdkCancellation.signal, undefined, { cwd: workspace } as never);
  readCancellation.abort();
  await assert.rejects(inFlightGrep);
  check("consult cancellation reaches a real native tool independently of the SDK signal", () => assert.equal(sdkCancellation.signal.aborted, false));

  const sm = SessionManager.create(workspace, join(root, "sessions"));
  const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
  const assistant = (content: unknown, stopReason: string) => ({ role: "assistant", content, api: "openai-completions", provider: "unit", model: "unit", usage, stopReason, timestamp: Date.now() });
  sm.appendMessage({ role: "user", content: "test", timestamp: Date.now() });
  sm.appendMessage(assistant([{ type: "toolCall", id: "unit", name: "multi_model_consult", arguments: { task: "review" } }], "toolUse") as never);
  sm.appendMessage({ role: "toolResult", toolCallId: "unit", toolName: "multi_model_consult", ...consultToolResult(report), timestamp: Date.now() } as never);
  sm.appendMessage(assistant([{ type: "text", text: "Main synthesis" }], "stop") as never);
  const history = loadTaskHistoryFromSession(sm.getSessionFile()!, workspace);
  const historyTool = history.messages.flatMap((m) => m.tools ?? []).find((t) => t.id === "unit");
  check("Pi session replay preserves full raw answers and traces", () => { assert(historyTool?.consult); assert.equal(historyTool.consult.workers[0]!.answer, report.workers[0]!.answer); assert.equal(historyTool.consult.workers[0]!.tools.length, 1); });
  check("UI request is explicit and scoped to one message", () => { assert.match(requestConsultForMessage("original task"), /仅本条消息/); assert(requestConsultForMessage("original task").endsWith("original task")); });
  // A delayed artifact projection must not settle or rename a later native turn.
  const previousHome = process.env.HOME;
  const previousProfile = process.env.USERPROFILE;
  process.env.HOME = root; process.env.USERPROFILE = root;
  const { AppDatabase } = await import("../src/main/db/AppDatabase");
  const { createAgentDurableFixture } = await import("./agent-durable-fixture");
  const db = new AppDatabase(join(root, "lifecycle.db"));
  const fixture = await createAgentDurableFixture(root, db);
  let releaseArtifacts: () => void = () => {};
  const blockedArtifacts = new Promise<void>(resolve => { releaseArtifacts = resolve; });
  let artifactStarted: () => void = () => {};
  const started = new Promise<void>(resolve => { artifactStarted = resolve; });
  const artifactMessages: string[] = [];
  const terminalMessages: string[] = [];
  let resolveSettledTurns: () => void = () => {};
  const settledTurns = new Promise<void>(resolve => { resolveSettledTurns = resolve; });
  const assistantIds: string[] = [];
  const unsubscribe = fixture.agent.onPatch(patch => {
    if (patch.taskId !== "lifecycle") return;
    const rows = patch.type === "durable_snapshot" ? patch.snapshot.messages : patch.type === "durable_delta" ? patch.delta.upserts : [];
    for (const row of rows) if (row.role === "assistant" && row.entryId && !assistantIds.includes(row.id)) assistantIds.push(row.id);
  });
  const submit = async (text: string) => {
    const accepted = await fixture.agent.prompt({ taskId: "lifecycle", text, userMessageId: `${text}-user`, assistantMessageId: `${text}-answer`, modelId: "fixture/model" });
    assert(accepted.receipt);
    assert.equal((await fixture.agent.waitForSubmission(accepted.receipt)).receipt?.status, "done");
  };
  const projection = fixture.agent as unknown as { emitChangedArtifacts(taskId: string, messageId: string, cwd: string, before: Map<string, string>): Promise<void> };
  const emitArtifacts = projection.emitChangedArtifacts.bind(fixture.agent);
  projection.emitChangedArtifacts = async (taskId, messageId, cwd, before) => {
    artifactMessages.push(messageId);
    if (artifactMessages.length === 1) { artifactStarted(); await blockedArtifacts; }
    await emitArtifacts(taskId, messageId, cwd, before);
  };
  fixture.agent.setTaskLifecycleListener(event => {
    if (event.kind === "completed" || event.kind === "failed") {
      terminalMessages.push(event.assistantMessageId);
      if (terminalMessages.length === 2) resolveSettledTurns();
    }
  });
  try {
    db.upsertTask({ id: "lifecycle", title: "Lifecycle", updatedAt: 1, welcomeMode: "coding" });
    await submit("first");
    await started;
    await submit("second");
    await settledTurns;
    releaseArtifacts();
    await fixture.agent.releaseDurableTask("lifecycle");
    assert.equal(assistantIds.length, 2);
    check("late native artifact projection keeps each original message identity", () => assert.deepEqual(artifactMessages, assistantIds));
    check("native lifecycle settles each receipt once independently of artifact delays", () => assert.deepEqual(terminalMessages, assistantIds));
  } finally {
    unsubscribe(); releaseArtifacts(); await fixture.close(); db.close();
    if (previousHome === undefined) delete process.env.HOME; else process.env.HOME = previousHome;
    if (previousProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = previousProfile;
  }
  console.log(JSON.stringify({ suite: "multi-model-consult-offline", result: "PASS", checks: checks.length, passed: checks }, null, 2));
} finally { rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
