/** Controlled transport replay; this does not measure provider latency or whole-app rendering. */
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { cpus, tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { BACKGROUND_CONTEXT as context } from "@earendil-works/chord/context";
import { createModels, type AssistantMessage, type Message } from "@earendil-works/pi-ai";
import type { Storage } from "@earendil-works/pi-durable";
import { DurableBotRuntime } from "../src/main/agent/durable/DurableBotRuntime";
import { openDurableStorage } from "../src/main/agent/durable/DurableStorage";
import { applyDurableDelta, durableDelta } from "../shared/src/durable-sync";
import type { DurableBotDelta, DurableBotSnapshot, DurableBotState } from "../src/shared/durable-bot";
import type { ChatMessageDto } from "../src/shared/agent-ipc";

const turns = 1_000, updates = 100, repetitions = 5;
const directory = await mkdtemp(join(tmpdir(), "mybuddy-durable-sync-measure-"));
const cwd = join(directory, "workspace"); await mkdir(cwd);
const source = "Measurement record: verify workspace inputs, preserve completed tool receipts, and explain the observed result. ".repeat(10);
const usage: AssistantMessage["usage"] = { input: 1200, output: 300, cacheRead: 900, cacheWrite: 0, totalTokens: 2400,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
const history: Message[] = Array.from({ length: turns }, (_, index): Message[] => [
  { role: "user", timestamp: index * 2 + 1, content: `Request ${index}\n${source}` },
  { role: "assistant", timestamp: index * 2 + 2, model: "fixture", provider: "fixture", api: "openai-completions", stopReason: "stop", usage,
    content: [{ type: "text", text: `Result ${index}\n${source}` }] },
]).flat();
let scans = { entries: 0, submissions: 0 };
const handle = await openDurableStorage(join(directory, "state"), context);
const storage = new Proxy(handle.storage, { get(target, key) {
  if (key === "scanEntries") return (...args: Parameters<Storage["scanEntries"]>) => { scans.entries++; return target.scanEntries(...args); };
  if (key === "scanSubmissions") return (...args: Parameters<Storage["scanSubmissions"]>) => { scans.submissions++; return target.scanSubmissions(...args); };
  const value = Reflect.get(target, key, target);
  return typeof value === "function" ? value.bind(target) : value;
} });
const runtime = await DurableBotRuntime.open({ directory: join(directory, "state"), cwd, storage, models: createModels(), toolMode: "native",
  initialHistory: { messages: history, context: [] }, instructions: () => "offline measurement", onSnapshot: () => {} });
const quantiles = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return { totalMs: values.reduce((sum, value) => sum + value, 0), p50Ms: sorted[Math.floor((sorted.length - 1) * 0.5)], p95Ms: sorted[Math.floor((sorted.length - 1) * 0.95)] };
};
try {
  while (runtime.snapshot.historyBefore !== undefined) await runtime.loadEarlier();
  assert.equal(runtime.snapshot.messages.length, turns * 2);
  const commonProjectionMs: number[] = [];
  scans = { entries: 0, submissions: 0 };
  for (let index = 0; index < updates; index++) {
    const started = performance.now(); await runtime.refresh(); commonProjectionMs.push(performance.now() - started);
  }
  const refreshScans = { ...scans };
  const base = runtime.snapshot;
  const frames: DurableBotSnapshot[] = Array.from({ length: updates }, (_, index) => ({ ...base, revision: base.revision + index + 1, busy: true, status: "running", outcome: undefined,
    messages: [...base.messages, { id: "active-replay", role: "assistant", createdAt: turns * 2 + 1, text: "streamed output ".repeat(index + 1), streaming: true }] }));
  const measure = (method: "full" | "delta") => {
    let previous = base, receiver = base, bytes = 0;
    const senderMs: number[] = [], receiverMs: number[] = [];
    const before = { ...scans };
    for (const frame of frames) {
      const started = performance.now();
      const { messages: _messages, epoch: _epoch, revision: _revision, ...state } = frame;
      const wire = JSON.stringify(method === "full" ? { type: "durable_snapshot", taskId: "measure", snapshot: frame }
        : { type: "durable_delta", taskId: "measure", delta: durableDelta<ChatMessageDto, DurableBotState>(previous, frame, state) });
      senderMs.push(performance.now() - started); bytes += Buffer.byteLength(wire);
      const receiving = performance.now();
      if (method === "full") {
        const decoded: { snapshot: DurableBotSnapshot } = JSON.parse(wire);
        receiver = decoded.snapshot;
      } else {
        const decoded: { delta: DurableBotDelta } = JSON.parse(wire);
        const applied = applyDurableDelta<ChatMessageDto, DurableBotState>(receiver, decoded.delta);
        assert.equal(applied.kind, "applied");
        if (applied.kind === "applied") receiver = applied.snapshot;
      }
      receiverMs.push(performance.now() - receiving); previous = frame;
    }
    assert.deepEqual(JSON.parse(JSON.stringify(receiver)), JSON.parse(JSON.stringify(frames.at(-1))));
    return { method, bytes, sender: quantiles(senderMs), receiver: quantiles(receiverMs),
      storageScans: { entries: scans.entries - before.entries, submissions: scans.submissions - before.submissions } };
  };
  measure("full"); measure("delta"); // Equal warm-up, excluded from the report.
  const runs = Array.from({ length: repetitions }, (_, index) => (index % 2 ? ["delta", "full"] as const : ["full", "delta"] as const).map(measure));
  const report = { recordedAt: new Date().toISOString(), node: process.version, platform: process.platform, cpu: cpus()[0]?.model,
    fixture: { turns, loadedMessages: base.messages.length, updates, repetitions, initialSnapshotBytes: Buffer.byteLength(JSON.stringify(base)) },
    commonRuntimeProjection: { ...quantiles(commonProjectionMs), storageScans: refreshScans }, runs,
    scope: "Both transport variants replay exactly the same 100 growing active-message frames over the same fully loaded 2,000-message history. They share the current runtime projection. Sender timing includes delta construction where applicable and JSON serialization; receiver timing includes JSON parsing and delta application. Initial full sync is measured separately. This is neither a comparison to an old runtime build nor a GUI/provider benchmark. Zero storage scans alone implies no latency multiplier." };
  const outputDirectory = join(process.cwd(), "artifacts", "durable-unification"); await mkdir(outputDirectory, { recursive: true });
  const output = join(outputDirectory, "sync-benchmark.json");
  await writeFile(output, JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ output, fixture: report.fixture, commonRuntimeProjection: report.commonRuntimeProjection, runs }, null, 2));
} finally { await runtime.close(); handle.lease.release(); }
