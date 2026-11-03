import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { getCurrentTools, normalizeContext, createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type AgentSession, type ModelRuntime } from "@earendil-works/pi-coding-agent";
import { stream as responsesStream } from "../node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { MemoryService } from "../src/main/memory/MemoryService";
import * as sourceProjection from "../src/main/agent/EphemeralContextProjection";
const { EphemeralContextProjection, CONTEXT_LEDGER_TYPE, CONTEXT_RESET_TYPE } = process.env.MYBUDDY_LEDGER_MODULE
  ? await import(pathToFileURL(process.env.MYBUDDY_LEDGER_MODULE).href) as typeof sourceProjection : sourceProjection;
import { bindSessionModelAdmission, installModelInvocationAdmission, setSessionRequestGuard } from "../src/main/agent/ModelInvocationAdmission";

// Production MemoryService + projection + admission + Pi sessions/compaction + real serializer.
// No user data, credentials or network; fake provider responses only choose native read tools.
const root = mkdtempSync(join(tmpdir(), "mybuddy-context-ledger-"));
const db = new AppDatabase(join(root, "app.db"));
const memory = new MemoryService(db, { semantic: false });
const marker = "PRIVATE_CALIBRATION_SOURCE";
const atom = memory.create({ kind: "constraint", title: "calibration", content: `${marker}_v1 gain=2 offset=7`,
  scopeType: "global", sourceType: "user", explicit: true });
writeFileSync(join(root, "input.txt"), "actual native read result\n".repeat(600));
const model: Model<any> = { id: "ledger-test", provider: "fixture", api: "openai-responses", name: "Ledger test",
  baseUrl: "http://127.0.0.1:1/v1", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
const captures: { input: unknown[]; base: unknown; phase: string }[] = [];
let transportCalls = 0, callsInTurn = 0, toolSequence = 0, summaryCalls = 0;
let beforePayload: (() => void) | undefined;
let abortReady: (() => void) | undefined;
let phase = "normal";
let supplementalRevision = 1, supplementalAvailable = true;
let enabled = true;
const response = (content: AssistantMessage["content"], stopReason: AssistantMessage["stopReason"]): AssistantMessage => ({
  role: "assistant", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), content, stopReason,
  usage: { input: 8000, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 8010, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
});

async function boot(file?: string, supplemental = false) {
  const manager = file ? SessionManager.open(file) : SessionManager.create(root, join(root, "sessions"));
  const settings = SettingsManager.inMemory({ compaction: { enabled: false, reserveTokens: 1024, keepRecentTokens: 256 }, retry: { enabled: false } });
  const runtime = {
    hasConfiguredAuth: () => true, getAuth: async () => ({ auth: { apiKey: "offline" } }), getModel: () => model,
    streamSimple: (_model: Model<any>, context: any, options: any) => {
      const output = createAssistantMessageEventStream();
      void (async () => {
        try {
          const mutate = beforePayload; beforePayload = undefined; mutate?.();
          let captured = false;
          const serialized = await responsesStream(model, normalizeContext(context), {
            ...options, apiKey: "offline", sessionId: manager.getSessionId(),
            onPayload: async (payload: any) => {
              await options?.onPayload?.(payload, model);
              const { input, ...base } = payload;
              captures.push({ input: structuredClone(input), base: structuredClone(base), phase });
              captured = true; throw new Error("OFFLINE_CAPTURE");
            },
            fetch: async () => { transportCalls++; throw new Error("NETWORK_FORBIDDEN"); },
          }).result();
          if (!captured) throw new Error(serialized.errorMessage ?? "Request was not admitted");
          if (abortReady) {
            const ready = abortReady; abortReady = undefined; ready();
            await new Promise<void>(resolve => {
              if (options.signal?.aborted) resolve();
              else options.signal.addEventListener("abort", () => resolve(), { once: true });
            });
            output.push({ type: "error", reason: "aborted", error: { ...response([], "aborted"), errorMessage: "ACTUAL_INTERRUPTION" } });
            return;
          }
          let message: AssistantMessage;
          if (!getCurrentTools(context.messages).length) {
            summaryCalls++;
            message = response([{ type: "text", text: `Summary can retain derived facts: ${marker}_v1. Continue calibration.` }], "stop");
          } else if (callsInTurn++ === 0) message = response([{ type: "toolCall", id: `read-${++toolSequence}`, name: "read", arguments: { path: join(root, "input.txt"), limit: 600 } }], "toolUse");
          else message = response([{ type: "text", text: "Calibration file inspected." }], "stop");
          output.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message });
        } catch (error) {
          output.push({ type: "error", reason: "error", error: { ...response([], "error"), errorMessage: String(error) } });
        } finally { output.end(); }
      })();
      return output;
    },
  } as unknown as ModelRuntime;
  runtime.stream = runtime.streamSimple as typeof runtime.stream;
  installModelInvocationAdmission(runtime, () => settings);
  const projection = new EphemeralContextProjection({
    memory: supplemental ? undefined : memory, enabled: () => enabled, scope: () => ({}),
    execution: () => ({ executionId: "execution", query: "calibration" }),
    supplementalEvidence: () => supplemental ? [{ id: "project:calibration", kind: "project", revision: String(supplementalRevision),
      text: `SUPPLEMENT_v${supplementalRevision} ` + "calibration detail ".repeat(500),
      access: { kind: "project", projectId: "calibration", resourceIds: ["original-resource"] },
      validate: () => { if (!supplementalAvailable) throw new Error("SUPPLEMENT_REVOKED"); } }] : [],
    validateEvidenceAccess: access => {
      assert.equal(access.kind, "project");
      if (!supplementalAvailable) throw new Error("SUPPLEMENT_REVOKED");
    },
    registerRequestGuard: setSessionRequestGuard, log: () => {},
  });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
    noContextFiles: true, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true,
    extensionFactories: [projection.extension] });
  await loader.reload(); assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({ cwd: root, agentDir: root, model, modelRuntime: runtime,
    sessionManager: manager, settingsManager: settings, resourceLoader: loader, tools: ["read"] });
  projection.attach(session); bindSessionModelAdmission(session); await session.bindExtensions({ mode: "rpc" });
  return { session, manager };
}
function assertPrefix(previous: typeof captures[number], next: typeof captures[number]) {
  assert.deepEqual(next.input.slice(0, previous.input.length), previous.input, "all previously serialized input items remain an exact prefix");
  assert.deepEqual(next.base, previous.base, "non-input fields stay stable");
}
async function prompt(session: AgentSession, text: string, preservePrevious = true) {
  callsInTurn = 0;
  const start = captures.length;
  await session.prompt(text);
  assert(!session.state.errorMessage, session.state.errorMessage);
  assert.equal(captures.length - start, 2, "native tool execution and continuation occurred");
  assertPrefix(captures[start], captures[start + 1]);
  if (preservePrevious && start) assertPrefix(captures[start - 1], captures[start]);
  return captures[start];
}
function ledgers(manager: SessionManager) { return manager.getBranch().filter(e => e.type === "custom" && e.customType === CONTEXT_LEDGER_TYPE); }
let session: AgentSession | undefined;
try {
  let current = await boot(); session = current.session;
  await prompt(session, "calibration first", false);
  await prompt(session, "calibration unchanged");
  const forkPoint = current.manager.getLeafId()!;
  assert.equal(ledgers(current.manager).length, 2);
  assert.equal((ledgers(current.manager)[1] as any).data.additions.length, 0);
  memory.update({ id: atom.id, content: `${marker}_v2 gain=3 offset=-4` });
  const changed = await prompt(session, "calibration updated");
  assert(JSON.stringify(changed.input).includes(`${marker}_v1`));
  assert(JSON.stringify(changed.input).includes(`${marker}_v2`));
  const file = current.manager.getSessionFile()!;
  assert(!readFileSync(file, "utf8").includes(marker), "version references must not persist source bodies");
  session.dispose(); current = await boot(file); session = current.session;
  await prompt(session, "calibration reopened");
  assert.equal((ledgers(current.manager).at(-1) as any).data.additions.length, 0);
  console.log("PASS stable prefix: unchanged, changed, restart; real Memory history; no source bodies persisted");

  const ready = new Promise<void>(resolve => { abortReady = resolve; });
  callsInTurn = 0;
  const interrupted = session.prompt("calibration interrupted during provider execution");
  await ready; await session.abort(); await interrupted;
  assert(session.messages.some(m => m.role === "assistant" && m.stopReason === "aborted"));
  await prompt(session, "calibration continue after actual interruption");
  const now = Date.now, fixed = now();
  try {
    Date.now = () => fixed;
    await prompt(session, "calibration identical timestamp and content");
    await prompt(session, "calibration identical timestamp and content");
  } finally { Date.now = now; }
  console.log("PASS actual abort/continue and duplicate user timestamps/content preserve anchors");

  // Tree navigation only replays the selected branch, never future evidence from another leaf.
  await session.navigateTree(forkPoint, { summarize: false });
  const forked = await prompt(session, "calibration fork", false);
  assert.equal(JSON.stringify(forked.input).split(`${marker}_v2`).length - 1, 1);
  assert.equal(ledgers(current.manager).length, 3);
  console.log("PASS branch: future ledger entries excluded; one fresh current version");

  phase = "compact";
  await session.compact(); assert(summaryCalls > 0);
  phase = "post-compact";
  const compacted = await prompt(session, "calibration after compaction", false);
  assert(JSON.stringify(compacted.input).includes(`${marker}_v2`), "current evidence re-established after native compaction");
  assert(JSON.stringify(compacted.input).includes(`${marker}_v1`), "a summary may retain derived facts");
  const compactFile = current.manager.getSessionFile()!;
  session.dispose(); current = await boot(compactFile); session = current.session;
  await prompt(session, "calibration compacted and reopened");
  console.log("PASS native compaction and reopen: only retained anchors replay, latest evidence restored");

  // Revocation after initial admission but before payload must be rejected by the real admission hook.
  const before = captures.length;
  beforePayload = () => memory.update({ id: atom.id, status: "invalid" });
  callsInTurn = 0;
  await session.prompt("calibration revoke while awaiting serialization");
  assert.match(session.state.errorMessage ?? "", /撤销|不可见/);
  assert.equal(captures.length, before);
  await assert.rejects(session.compact(), /撤销|不可见|summarization|compaction/i);
  assert.equal(captures.length, before, "native compaction cannot send revoked derivatives");
  console.log("PASS actual guard: revocation between admission and payload, plus summary request, both blocked");
  session.dispose(); memory.update({ id: atom.id, status: "active" });

  current = await boot(); session = current.session;
  await prompt(session, "calibration summary branch base", false);
  const summaryTarget = current.manager.getLeafId()!;
  const future = memory.create({ kind: "constraint", title: "calibration future-only", content: "FUTURE_BRANCH_PRIVATE_FACT", scopeType: "global", sourceType: "user", explicit: true });
  await prompt(session, "calibration future branch");
  await session.navigateTree(summaryTarget, { summarize: true });
  assert(ledgers(current.manager).some(e => (e as any).data.boundary === "summary-lineage"));
  const childFile = current.manager.createBranchedSession(current.manager.getLeafId()!);
  assert(childFile);
  session.dispose(); current = await boot(childFile); session = current.session;
  memory.update({ id: future.id, status: "invalid" });
  const beforeLineage = captures.length;
  await session.prompt("calibration summarized branch after restart");
  assert.match(session.state.errorMessage ?? "", /撤销|不可见/);
  assert.equal(captures.length, beforeLineage);
  console.log("PASS summarized branch and standalone branch copy retain revocation dependencies after restart");
  session.dispose();

  // Non-versioned sources retain exact clipped bytes as budget shrinks, but explicitly rebuild on restart.
  current = await boot(undefined, true); session = current.session;
  await prompt(session, "calibration non-versioned", false);
  model.contextWindow = 18000;
  await prompt(session, "calibration lower budget");
  assert.equal((ledgers(current.manager).at(-1) as any).data.additions.length, 0);
  model.contextWindow = 128000;
  supplementalRevision++;
  await prompt(session, "calibration changed supplement");
  const supplementFile = current.manager.getSessionFile()!;
  assert(!readFileSync(supplementFile, "utf8").includes("SUPPLEMENT_v"));
  session.dispose(); current = await boot(supplementFile, true); session = current.session;
  await prompt(session, "calibration supplement reopened", false);
  assert.equal(current.manager.getBranch().filter(e => e.type === "custom" && e.customType === CONTEXT_RESET_TYPE).length, 1);
  await prompt(session, "calibration stable after rebuild");
  console.log("PASS non-versioned evidence: budget cannot rewrite old bytes; one explicit restart boundary");
  session.dispose(); supplementalAvailable = false;
  current = await boot(supplementFile, true); session = current.session;
  const denied = captures.length;
  await session.prompt("calibration deleted original resource");
  assert.match(session.state.errorMessage ?? "", /SUPPLEMENT_REVOKED/);
  assert.equal(captures.length, denied);
  session.dispose(); supplementalAvailable = true;

  // Damaged references are rejected before source text reaches serialization.
  for (const damage of ["hash", "renderer", "version"] as const) {
    current = await boot(); session = current.session;
    await prompt(session, `calibration damage seed ${damage}`, false);
    const damageFile = current.manager.getSessionFile()!;
    session.dispose();
    const lines = readFileSync(damageFile, "utf8").trim().split("\n").map(line => JSON.parse(line));
    const entry = lines.find(e => e.type === "custom" && e.customType === CONTEXT_LEDGER_TYPE);
    const ref = entry.data.additions[0];
    if (damage === "hash") ref.hash = "0".repeat(64);
    if (damage === "renderer") ref.reference.renderer = "unsupported-renderer";
    if (damage === "version") { ref.reference.revision = 999999; ref.sources[0].revision = 999999; }
    writeFileSync(damageFile, lines.map(line => JSON.stringify(line)).join("\n") + "\n");
    current = await boot(damageFile); session = current.session;
    const count = captures.length;
    await session.prompt("calibration restore corrupted reference");
    assert.match(session.state.errorMessage ?? "", /校验失败|不匹配|不存在/);
    assert.equal(captures.length, count);
    session.dispose();
  }
  assert.equal(transportCalls, 0);
  console.log(`PASS damaged references and restored access witnesses; ${captures.length} serialized requests, no network`);
} finally { session?.dispose(); db.close(); rmSync(root, { recursive: true, force: true }); }
