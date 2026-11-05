/**
 * Cache-prefix boundary matrix.
 *
 * Runs the real product extension stack (conversation runtime, builtin
 * capabilities, ephemeral context projection), the real Pi agent loop and the
 * real Responses serializer, then checks the wire request of every model call
 * in a scenario for prefix continuity.
 *
 * Why it exists: `test:tool-image-aging` covers one flow (tool screenshot
 * history). Prompt-cache reuse breaks whenever a later request does not extend
 * the previous wire input, or when a field the upstream keys on changes. This
 * matrix sweeps unusual flows — steering, mid-session tool changes, resume from
 * disk, compaction, abort, capsule projection — and reports where the prefix
 * stops matching.
 *
 * Offline by construction: fetch throws, credentials are fake, images are 2x2
 * synthetic PNGs, and everything lives in a temp dir.
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Type } from "typebox";
import { getCurrentTools, normalizeContext } from "@earendil-works/pi-ai";
import { createAssistantMessageEventStream, type AssistantMessage, type Context, type Model } from "@earendil-works/pi-ai/compat";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type AgentSession, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { stream as responsesStream } from "../node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js";
import { createBuiltinCapabilityExtension } from "../src/main/capabilities/builtin-capability-extension";
import { BuiltinCapabilityRuntime } from "../src/main/capabilities/BuiltinCapabilityRuntime";
import { DEFAULT_BUILTIN_CAPABILITIES_CONFIG } from "../src/shared/builtin-capabilities";
import { createConversationRuntimeExtension } from "../src/main/agent/conversation-runtime-extension";
import { EphemeralContextProjection } from "../src/main/agent/EphemeralContextProjection";

const model: Model<any> = {
  id: "prefix-matrix-fixture", provider: "fixture", api: "openai-responses", name: "Fixture",
  baseUrl: "http://127.0.0.1:1/v1", reasoning: true, input: ["text", "image"],
  contextWindow: 200000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
const png = "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAE0lEQVR4nGP4z8DwnwGM/zMwAAAf7gP9NRsAMwAAAABJRU5ErkJggg==";
const PNG_IMAGE = { type: "image" as const, data: png, mimeType: "image/png" };

type Step = { kind: "tool" } | { kind: "text"; text: string };
interface Capture {
  turn: number;
  call: number;
  input: unknown[];
  base: Record<string, unknown>;
  context: Context;
}

let failure: unknown;
let captures: Capture[] = [];
let turn = 1;
let callIndex = 0;
let plan: (call: number) => Step = () => ({ kind: "text", text: "done" });
const toolLoop = (tools: number): ((call: number) => Step) => call =>
  call < tools ? { kind: "tool" } : { kind: "text", text: "done" };
let toolRuns = 0;
let withImages = false;
let onToolExecute: (() => void) | undefined;
let summaryCalls = 0;
let sessionId = "";
let transportCalls = 0;

const response = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage => ({
  role: "assistant", content, stopReason, api: model.api, provider: model.provider, model: model.id,
  timestamp: Date.now(), usage: { input: 1000, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 1010,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});

async function serialize(context: Context): Promise<{ input: unknown[]; base: Record<string, unknown> }> {
  let payload: any;
  await responsesStream(model, normalizeContext(context), {
    apiKey: "offline-fixture", sessionId,
    onPayload: (value: unknown) => { payload = value; throw new Error("OFFLINE_CAPTURE"); },
    fetch: async () => { transportCalls++; throw new Error("NETWORK_FORBIDDEN"); },
  }).result();
  assert(payload, "must reach the real Responses serializer");
  const { input, ...base } = payload;
  return { input, base };
}

const runtime = {
  hasConfiguredAuth: () => true,
  getAuth: async () => ({ auth: { apiKey: "local-fixture-only" } }),
  getModel: () => model,
  streamSimple: (_model: Model<any>, context: Context) => {
    const output = createAssistantMessageEventStream();
    void (async () => {
      try {
        let message: AssistantMessage;
        if (!getCurrentTools(context.messages).length) {
          summaryCalls++;
          message = response([{ type: "text", text: "Earlier context summarized. Continue the task." }], "stop");
        } else {
          const step = callIndex > 24 ? { kind: "text" as const, text: "fixture cap" } : plan(callIndex);
          const { input, base } = await serialize(context);
          captures.push({ turn, call: callIndex, input, base, context: structuredClone(context) });
          callIndex++;
          message = step.kind === "tool"
            ? response([{ type: "toolCall", id: `call-${turn}-${callIndex}`, name: "fixture_screenshot", arguments: {} }], "toolUse")
            : response([{ type: "text", text: step.text }], "stop");
        }
        output.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
      } catch (error) {
        failure = error;
        output.push({ type: "done", reason: "stop", message: response([{ type: "text", text: "FIXTURE_FAILED" }], "stop") });
      }
      output.end();
    })();
    return output;
  },
} as unknown as ModelRuntime;

const toolScreenshot = {
  name: "fixture_screenshot", label: "Screenshot fixture", description: "Synthetic screenshot only",
  parameters: Type.Object({}),
  execute: async () => {
    toolRuns++;
    onToolExecute?.();
    const content: any[] = [{ type: "text", text: `Screenshot ${toolRuns}. ` + "Fixture evidence. ".repeat(60) }];
    if (withImages) content.push({ type: "image", data: png, mimeType: "image/png" });
    return { content, details: {} };
  },
};
const toolText = {
  name: "fixture_text", label: "Text tool", description: "Plain text fixture tool",
  parameters: Type.Object({}),
  execute: async () => {
    toolRuns++;
    onToolExecute?.();
    return { content: [{ type: "text", text: `Ran the text tool ${toolRuns}.` }], details: {} };
  },
};

function capabilityRuntime(): BuiltinCapabilityRuntime {
  const config = structuredClone(DEFAULT_BUILTIN_CAPABILITIES_CONFIG);
  for (const value of Object.values(config)) {
    if (value && typeof value === "object" && "enabled" in value) (value as { enabled: boolean }).enabled = false;
  }
  config.execution = { terminalEnabled: false, codeExecutionEnabled: false };
  return new BuiltinCapabilityRuntime({
    store: { read: () => structuredClone(config), write: (next) => structuredClone(next) },
    credentials: { has: () => false, get: () => null, set: () => undefined, clear: () => undefined },
  });
}

interface Booted {
  session: AgentSession;
  manager: SessionManager;
  projection?: EphemeralContextProjection;
  loader: DefaultResourceLoader;
  root: string;
}

interface BootOptions {
  root: string;
  sessionDir: string;
  resumeFrom?: string;
  projection?: EphemeralContextProjection;
}

async function boot(options: BootOptions): Promise<Booted> {
  const settings = SettingsManager.inMemory({
    compaction: { enabled: true, reserveTokens: 16384, keepRecentTokens: 512 },
    retry: { enabled: true, maxRetries: 2 },
  });
  const manager = options.resumeFrom ? SessionManager.open(options.resumeFrom) : SessionManager.create(options.root, options.sessionDir);
  sessionId = manager.getSessionId();
  const loader = new DefaultResourceLoader({
    cwd: options.root, agentDir: options.root, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [
      createConversationRuntimeExtension({ resolveContext: () => undefined, interaction: {} as never, goal: {} as never }),
      createBuiltinCapabilityExtension({ taskId: "prefix-matrix", taskRoot: options.root,
        runtime: capabilityRuntime(), browser: { available: false } as never, artifactService: () => null,
        getProducerMessageId: () => undefined, getIsolationLevel: () => "guarded" }),
      ...(options.projection ? [options.projection.extension] : []),
    ],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({
    cwd: options.root, agentDir: options.root, model, modelRuntime: runtime, settingsManager: settings,
    sessionManager: manager, resourceLoader: loader, noTools: "builtin",
    customTools: [toolScreenshot as never, toolText as never],
  });
  options.projection?.attach(session);
  await session.bindExtensions({ mode: "rpc" });
  return { session, manager, projection: options.projection, loader, root: options.root };
}

function describeItem(item: any): string {
  if (item === undefined) return "<missing>";
  const text = typeof item.content === "string" ? item.content
    : Array.isArray(item.content) ? item.content.map((p: any) => p.type === "text" ? p.text : `<${p.type}>`).join("|") : "";
  return `${item.type ?? item.role ?? "?"}[${String(text).replace(/\s+/g, " ").slice(0, 64)}]`;
}

interface Continuity {
  from: number;
  to: number;
  prefixOk: boolean;
  divergeAt: number;
  prevItem?: string;
  nextItem?: string;
  baseChanged: string[];
  lengths: [number, number];
}

function continuity(list: Capture[]): Continuity[] {
  const out: Continuity[] = [];
  for (let i = 1; i < list.length; i++) {
    const a = list[i - 1], b = list[i];
    let divergeAt = -1;
    const limit = Math.min(a.input.length, b.input.length);
    for (let k = 0; k < limit; k++) {
      if (JSON.stringify(a.input[k]) !== JSON.stringify(b.input[k])) { divergeAt = k; break; }
    }
    if (divergeAt === -1 && b.input.length < a.input.length) divergeAt = b.input.length;
    const baseChanged: string[] = [];
    for (const key of new Set([...Object.keys(a.base), ...Object.keys(b.base)])) {
      if (JSON.stringify((a.base as any)[key]) !== JSON.stringify((b.base as any)[key])) baseChanged.push(key);
    }
    out.push({
      from: i - 1, to: i, prefixOk: divergeAt === -1, divergeAt,
      prevItem: divergeAt >= 0 ? describeItem(a.input[divergeAt]) : undefined,
      nextItem: divergeAt >= 0 ? describeItem(b.input[divergeAt]) : undefined,
      baseChanged, lengths: [a.input.length, b.input.length],
    });
  }
  return out;
}

interface ScenarioReport {
  scenario: string;
  capsuleIndexes?: number[];
  requests: number;
  images: number;
  breaks: number;
  continuity: Continuity[];
  baseChanges: string[];
  note?: string;
}

const results: ScenarioReport[] = [];
let scenarioStart = 0;

function report(scenario: string, note?: string): ScenarioReport {
  const rows = captures.slice(scenarioStart);
  scenarioStart = captures.length;
  const series = continuity(rows);
  const breaks = series.filter(row => !row.prefixOk).length;
  const baseChanges = [...new Set(series.flatMap(row => row.baseChanged))];
  const last = rows.at(-1);
  const images = last
    ? last.input.reduce<number>((n, item: any) => n + (Array.isArray(item.content)
      ? item.content.filter((part: any) => part.type === "input_image").length : 0), 0)
    : 0;
  const entry: ScenarioReport = { scenario, requests: rows.length, images, breaks, continuity: series, baseChanges, note };
  results.push(entry);
  const head = breaks === 0
    ? `OK    ${scenario}: ${rows.length} requests, append-only`
    : `BREAK ${scenario}: ${breaks}/${series.length} continuations diverge`;
  const detail = breaks > 0
    ? ` (first at item ${series.find(r => !r.prefixOk)!.divergeAt}: ${series.find(r => !r.prefixOk)!.prevItem} -> ${series.find(r => !r.prefixOk)!.nextItem})`
    : baseChanges.length ? ` [base changed: ${baseChanges.join(", ")}]` : "";
  console.log(head + detail);
  assert.equal(rows.length > 0, true, `${scenario} must issue at least one request`);
  return entry;
}

function resetTurn(): void { callIndex = 0; }

async function main() {
  const root = mkdtempSync(join(tmpdir(), "mybuddy-prefix-matrix-"));
  const sessionDir = join(root, "sessions");
  mkdirSync(sessionDir);
  writeFileSync(join(root, "AGENTS.md"), "Fixture project notes. Stable across the run.\n");

  // 1. Baseline: a plain tool loop inside one user turn.
  {
    const booted = await boot({ root, sessionDir });
    plan = toolLoop(3);
    resetTurn();
    await booted.session.prompt("Baseline tool loop.");
    if (failure) throw failure;
    assert.equal(callIndex, 4);
    report("baseline-tool-loop", "three tool calls in one turn");
    booted.session.dispose();
  }

  // 2. Screenshots across three user turns (regression control).
  {
    withImages = true;
    const booted = await boot({ root, sessionDir });
    plan = toolLoop(2);
    for (turn = 1; turn <= 3; turn++) {
      resetTurn();
      await booted.session.prompt(`Screenshot round ${turn}.`, { images: [PNG_IMAGE] });
      if (failure) throw failure;
    }
    assert.equal(booted.manager.getBranch().filter(e => e.type === "message" && e.message.role === "toolResult").length, 6);
    report("screenshots-across-turns", "six tool screenshots plus three user images");
    booted.session.dispose();
    withImages = false;
    turn = 1;
  }

  // 3. Steering message delivered mid-turn.
  {
    const booted = await boot({ root, sessionDir });
    plan = toolLoop(3);
    let steered = false;
    onToolExecute = () => {
      if (steered) return;
      steered = true;
      void booted.session.steer("Also check the second file.");
    };
    resetTurn();
    await booted.session.prompt("Steer me mid-turn.");
    onToolExecute = undefined;
    if (failure) throw failure;
    assert.equal(steered, true, "steer must be queued while the tool ran");
    report("steer-mid-turn", "user message queued while tools run");
    booted.session.dispose();
  }

  // 4. Abort in the middle of a tool loop, then continue.
  {
    const booted = await boot({ root, sessionDir });
    plan = toolLoop(12);
    resetTurn();
    const prompting = booted.session.prompt("Start a long loop, then abort.");
    await new Promise<void>(resolve => setTimeout(resolve, 25));
    await booted.session.abort();
    await prompting.catch(() => undefined);
    failure = undefined;
    plan = () => ({ kind: "text", text: "continued" });
    resetTurn();
    await booted.session.prompt("Continue after the abort.");
    if (failure) throw failure;
    report("abort-then-continue", "aborted turn followed by a new prompt");
    booted.session.dispose();
  }

  // 5. Explicit compaction boundary.
  {
    const booted = await boot({ root, sessionDir });
    plan = toolLoop(3);
    resetTurn();
    await booted.session.prompt("Collect evidence before compaction.");
    if (failure) throw failure;
    await booted.session.compact();
    assert(summaryCalls > 0, "compaction must summarize");
    plan = toolLoop(2);
    resetTurn();
    turn = 2;
    await booted.session.prompt("Continue after compaction.");
    if (failure) throw failure;
    report("compaction", "explicit compaction between user turns");
    booted.session.dispose();
    turn = 1;
  }

  // 6. Mid-session activation of a second tool.
  {
    const booted = await boot({ root, sessionDir });
    plan = () => ({ kind: "text", text: "ok" });
    booted.session.setActiveToolsByName(booted.session.getActiveToolNames().filter(name => name !== "fixture_text"));
    const before = booted.session.getActiveToolNames().length;
    resetTurn();
    await booted.session.prompt("Before activation.");
    booted.session.setActiveToolsByName([...booted.session.getActiveToolNames(), "fixture_text"]);
    const after = booted.session.getActiveToolNames().length;
    assert.equal(after, before + 1, "the fixture tool must be activated");
    resetTurn();
    await booted.session.prompt("After activation.");
    if (failure) throw failure;
    resetTurn();
    await booted.session.prompt("Still after activation.");
    if (failure) throw failure;
    report("tool-activation-mid-session", `active tools ${before} -> ${after}`);
    booted.session.dispose();
  }

  // 7. Thinking-level change between turns.
  {
    const booted = await boot({ root, sessionDir });
    plan = () => ({ kind: "text", text: "ok" });
    resetTurn();
    await booted.session.prompt("Turn with the default effort.");
    booted.session.setThinkingLevel("high");
    resetTurn();
    await booted.session.prompt("Turn with high effort.");
    if (failure) throw failure;
    report("thinking-level-change", "reasoning effort changed between turns");
    booted.session.dispose();
  }

  // 8. Resume the session from disk after a full dispose.
  {
    const first = await boot({ root, sessionDir });
    plan = toolLoop(3);
    resetTurn();
    await first.session.prompt("Work before the restart.");
    if (failure) throw failure;
    const file = first.manager.getSessionFile();
    assert(file, "session must persist to disk");
    first.session.dispose();
    failure = undefined;
    const resumed = await boot({ root, sessionDir, resumeFrom: file });
    plan = toolLoop(2);
    resetTurn();
    turn = 2;
    await resumed.session.prompt("Continue after the restart.");
    if (failure) throw failure;
    report("resume-from-disk", "session reloaded from its JSONL file");
    resumed.session.dispose();
    turn = 1;
  }

  // 9. Memory capsule projection across two user turns.
  {
    const projection = new EphemeralContextProjection({
      enabled: () => true, scope: () => ({ taskId: "prefix-matrix" }),
      supplementalEvidence: () => [{ id: "project", revision: "7", kind: "project", text: "STABLE_PROJECT_EVIDENCE", validate() {} }],
      registerRequestGuard: () => {}, log: () => {},
    });
    const booted = await boot({ root, sessionDir, projection });
    plan = toolLoop(2);
    resetTurn();
    await booted.session.prompt("First turn with the memory capsule.");
    if (failure) throw failure;
    resetTurn();
    turn = 2;
    await booted.session.prompt("Second turn with the memory capsule.");
    if (failure) throw failure;
    const start = scenarioStart;
    const entry = report("capsule-across-turns", "stable evidence retained at its original anchor; each turn appends a manifest");
    const rows = captures.slice(start);
    const capsuleIndex = rows.map(row => row.input.findIndex((item: any) => JSON.stringify(item).includes("STABLE_PROJECT_EVIDENCE")));
    entry.capsuleIndexes = capsuleIndex;
    console.log(`      capsule item index per request: ${capsuleIndex.join(", ")} (input lengths ${rows.map(r => r.input.length).join(", ")})`);
    const capsuleItem = rows.at(-1)!.input.find((item: any) => JSON.stringify(item).includes("STABLE_PROJECT_EVIDENCE"));
    console.log(`      capsule wire item: ${JSON.stringify(capsuleItem).slice(0, 220)}`);
    assert.equal(capsuleIndex.at(-1)! >= 0, true, "the capsule must reach the wire");
    booted.session.dispose();
    turn = 1;
  }

  // 10. Serialization determinism: the same context twice must hash the same.
  {
    const sample = captures.at(-1)!;
    const first = await serialize(sample.context);
    await new Promise<void>(resolve => setTimeout(resolve, 120));
    const second = await serialize(sample.context);
    assert.deepEqual(second.input, first.input, "serializing one context twice must not change the input");
    assert.deepEqual(second.base, first.base, "serializing one context twice must not change request options");
    console.log("OK    serialization-determinism: repeated serialization is time-invariant");
  }

  assert.equal(transportCalls, 0, "no network");

  // Contracts this matrix protects. Flows that only append history must never
  // rewrite an earlier request; the two known boundaries must stay single,
  // explainable breaks instead of recurring per-request rewrites.
  const expectations: Record<string, (row: ScenarioReport) => void> = {
    "baseline-tool-loop": row => assert.equal(row.breaks, 0, "plain tool loop must stay append-only"),
    "screenshots-across-turns": row => assert.equal(row.breaks, 0, "tool screenshots must not rewrite history"),
    "steer-mid-turn": row => assert.equal(row.breaks, 0, "a steering message must append, not rewrite"),
    "abort-then-continue": row => assert.equal(row.breaks, 0, "aborting and continuing must append"),
    "thinking-level-change": row => assert.equal(row.breaks, 0, "effort changes must not touch the input prefix"),
    "resume-from-disk": row => assert.equal(row.breaks, 0, "reopening a session must extend its prefix"),
    "tool-activation-mid-session": row => {
      assert.equal(row.breaks, 0, "tool activation must append (the tools field is the separate boundary)");
      assert(row.baseChanges.includes("tools"), "tool activation must be visible as a tools-field change");
      assert.equal(row.baseChanges.length, 1, "tool activation must change only the tools field");
    },
    compaction: row => {
      assert(row.breaks >= 1, "compaction must rewrite history once");
      for (const item of row.continuity.filter(entry => !entry.prefixOk)) {
        assert(item.divergeAt <= 1, `compaction must rewrite from the head, saw item ${item.divergeAt}`);
      }
    },
    "capsule-across-turns": row => {
      assert.equal(row.breaks, 0, "unchanged evidence stays at its original anchor across user turns");
    },
  };
  for (const row of results) {
    const check = expectations[row.scenario];
    assert(check, `no contract declared for scenario ${row.scenario}`);
    check(row);
  }
  console.log(`OK    contracts: ${results.length} scenarios match their declared cache-prefix contract`);

  const breaks = results.filter(row => row.breaks > 0);
  console.log(`\nScenarios: ${results.length}; with prefix breaks: ${breaks.length}`);
  for (const row of breaks) {
    const first = row.continuity.find(item => !item.prefixOk)!;
    console.log(`- ${row.scenario}: ${row.breaks} break(s); first at item ${first.divergeAt} of ${first.lengths[0]}` +
      ` (${first.prevItem} -> ${first.nextItem})${row.baseChanges.length ? `; base: ${row.baseChanges.join(",")}` : ""}`);
  }
  const outDir = join(process.cwd(), "out", "diagnostics", "cache-boundaries");
  mkdirSync(outDir, { recursive: true });
  writeFileSync(join(outDir, "prefix-matrix.json"),
    JSON.stringify({ generatedAt: new Date().toISOString(), scenarios: results, transportCalls }, null, 2));
  console.log(`report: ${join(outDir, "prefix-matrix.json")}`);
}

main()
  .then(() => { for (const dir of []) rmSync(dir, { recursive: true, force: true }); })
  .catch(error => { console.error(error); process.exitCode = 1; });
