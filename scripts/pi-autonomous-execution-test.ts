import assert from "node:assert/strict";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { mkdtemp, writeFile, readFile, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createAssistantMessageEventStream, type AssistantMessage, type Context, type Model,
} from "@earendil-works/pi-ai/compat";
import {
  createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager,
  type ModelRuntime, type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { EphemeralContextProjection } from "../src/main/agent/EphemeralContextProjection";

// A local scripted provider exercises Pi's REAL agent loop and REAL Bash/read/edit
// tools. It requires no API key or user intervention and never touches user files.
const root = await mkdtemp(join(tmpdir(), "mybuddy-pi-autonomous-"));
const logs = new Set<string>();
const model: Model<any> = {
  id: "autonomous-fixture", provider: "fixture", api: "openai-completions",
  name: "Autonomous fixture", baseUrl: "http://invalid.invalid", reasoning: false,
  input: ["text"], contextWindow: 272_000, maxTokens: 4096,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
};
function text(message: any): string {
  return typeof message?.content === "string" ? message.content
    : (message?.content ?? []).map((part: any) => part.type === "text" ? part.text : "").join("\n");
}
function results(context: Context): any[] { return context.messages.filter((m) => m.role === "toolResult"); }
function tool(id: string, name: string, args: Record<string, unknown>): AssistantMessage["content"][number] {
  return { type: "toolCall", id, name, arguments: args };
}

async function runCase(name: string, steps: (request: number, context: Context) => AssistantMessage["content"],
  extra: ExtensionFactory[] = [], options: { secondPrompt?: boolean; beforeProjection?: ExtensionFactory[] } = {}) {
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0 } });
  const manager = SessionManager.inMemory(root);
  const requests: Context[] = [];
  let providerFailure: unknown;
  let captureGuard: (() => () => void) | undefined;
  let turnStart = 0;
  const projection = new EphemeralContextProjection({
    enabled: () => false,
    scope: () => ({ taskId: name }),
    execution: () => ({ executionId: `${name}-execution`, userTurnId: `${name}-user`, query: name }),
    supplementalEvidence: () => [{ id: "fixture-source", kind: "project", revision: "1", text: "EPHEMERAL_ONLY_CONTEXT", validate() {} }],
    registerRequestGuard: (_session, capture) => { captureGuard = capture; },
    log: () => undefined,
  });
  const runtime = {
    hasConfiguredAuth: () => true,
    getAuth: async () => ({ auth: { apiKey: "local-fixture-only" } }),
    getModel: () => model,
    streamSimple: (_model: Model<any>, context: Context) => {
      const stream = createAssistantMessageEventStream();
      let content: AssistantMessage["content"];
      try {
        captureGuard?.()();
        requests.push({ ...context, messages: structuredClone(context.messages) });
        if (requests.length > turnStart + 1) {
          const previous = requests.at(-2)!.messages;
          assert.deepEqual(context.messages.slice(0, previous.length), previous,
            "each request in the same user turn must preserve the preceding request as a prefix");
        }
        if (requests.length > 8) throw new Error("Unexpected autonomous loop; fixture safety bound exceeded");
        content = steps(requests.length, context);
      } catch (error) {
        providerFailure = error;
        content = [{ type: "text", text: "FIXTURE_ASSERTION_FAILED" }];
      }
      const stopReason = content.some((part) => part.type === "toolCall") ? "toolUse" as const : "stop" as const;
      const response: AssistantMessage = {
        role: "assistant", content, stopReason, api: model.api, provider: model.provider, model: model.id,
        timestamp: Date.now(), usage: { input: 1000, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 1010,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
      };
      stream.push({ type: "start", partial: response });
      stream.push({ type: "done", reason: stopReason, message: response }); stream.end();
      return stream;
    },
  } as unknown as ModelRuntime;
  const loader = new DefaultResourceLoader({
    cwd: root, agentDir: root, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true,
    extensionFactories: [...(options.beforeProjection ?? []), projection.extension, ...extra],
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd: root, agentDir: root, model, modelRuntime: runtime, settingsManager: settings,
    sessionManager: manager, resourceLoader: loader, tools: ["read", "write", "edit", "bash"],
  });
  const originalFinishTurn = session.agent.finishTurn;
  projection.attach(session);
  assert.strictEqual(session.agent.finishTurn, originalFinishTurn, "MyBuddy must not replace Pi finishTurn");
  await session.bindExtensions({ mode: "rpc" });
  try {
    await session.prompt(name);
    if (providerFailure) throw providerFailure;
    assert(!session.state.errorMessage, session.state.errorMessage);
    if (options.secondPrompt) {
      turnStart = requests.length;
      await session.prompt(`${name}-next-user`);
      if (providerFailure) throw providerFailure;
      assert(!session.state.errorMessage, session.state.errorMessage);
      for (const request of requests) {
        assert.equal(request.messages.filter((message) => text(message).includes("EPHEMERAL_ONLY_CONTEXT")).length, 1,
          "each request contains exactly one request-only capsule across user turns");
      }
    }
    const branch = manager.getBranch();
    const userInputs = branch.filter((entry) => entry.type === "message" && entry.message.role === "user").length;
    assert.equal(userInputs, options.secondPrompt ? 2 : 1,
      "each execution has exactly one user message");
    assert(!branch.some((entry) => entry.type === "context_edit"), "no MyBuddy tool-output history rewrite");
    assert(!JSON.stringify(branch).includes("EPHEMERAL_ONLY_CONTEXT"), "supplement remains request-only");
    assert(!requests.some((r) => JSON.stringify(r.messages).includes("本轮资料获取已达到预算边界")));
    const active = session.agent.state.tools.map((t) => t.name);
    assert(active.includes("bash") && active.includes("read") && active.includes("edit"), "native tools stay active");
    console.log(`PASS ${name}: ${requests.length} provider requests, ${userInputs} user input(s), native Pi loop retained`);
    return { requests, sessionMessages: structuredClone(session.messages) };
  } catch (error) {
    const failurePath = join(tmpdir(), `mybuddy-pi-autonomous-${name}-failure.json`);
    // This provider and filesystem contain only synthetic fixtures, never user credentials.
    await writeFile(failurePath, JSON.stringify(manager.getBranch().filter(
      (entry) => entry.type === "message" && entry.message.role === "toolResult",
    ), null, 2));
    console.error("Raw fixture toolResults:", failurePath);
    throw error;
  } finally {
    for (const entry of manager.getBranch()) {
      if (entry.type !== "message" || entry.message.role !== "toolResult") continue;
      const detailPath = (entry.message.details as any)?.fullOutputPath;
      if (detailPath) logs.add(detailPath);
    }
    session.dispose();
  }
}

try {
  await writeFile(join(root, "state.txt"), "broken\n", "utf8");
  await writeFile(join(root, "check.mjs"), [
    'import {readFileSync, appendFileSync} from "node:fs";',
    'if (!process.env.PI_SESSION_ID || process.env.PI_MODEL !== "autonomous-fixture") throw new Error("Pi session metadata not forwarded");',
    'const fixed = readFileSync("state.txt", "utf8").trim() === "fixed";',
    'appendFileSync("runs.txt", "run\\n");',
    'for (let i=1; i<=3500; i++) console.log(i === 100 && !fixed ? "ROOT_CAUSE: state.txt contains broken; change to fixed" : `PROGRESS_${i} ${"x".repeat(85)}`);',
    'console.log(fixed ? "ALL_TESTS_PASSED" : "TESTS_FAILED_READ_LOG_FOR_CAUSE");',
    'process.exitCode = fixed ? 0 : 7;',
  ].join("\n"), "utf8");
  const repaired = await runCase("diagnose-fix-retest", (n, context) => {
    const r = results(context);
    if (n === 1) return [tool("initial-test", "bash", { command: "node check.mjs", timeout: 20 })];
    if (n === 2) {
      assert.equal(r.at(-1)?.isError, true, "Pi must see the failed command");
      assert.match(text(r.at(-1)), /Command exited with code 7/);
      assert(!text(r.at(-1)).includes("ROOT_CAUSE:"), "diagnostic is intentionally outside Pi tail");
      const match = text(r.at(-1)).match(/Full output: (?:"([^"\n]+)"|([^\n\]]+))/);
      assert(match, "failed command must supply a readable log without asking the user");
      const path = (match[1] ?? match[2]).trim(); logs.add(path);
      assert(Buffer.byteLength(text(r.at(-1))) <= 51_200 + 1024, "Pi owns the native 50KB Bash output limit");
      return [tool("read-diagnostic", "read", { path, offset: 92, limit: 18 })];
    }
    if (n === 3) {
      assert.match(text(r.at(-1)), /ROOT_CAUSE: state.txt contains broken/);
      return [tool("repair", "edit", { path: join(root, "state.txt"), oldText: "broken", newText: "fixed" })];
    }
    if (n === 4) {
      assert.equal(r.at(-1)?.isError, false);
      return [tool("retest", "bash", { command: "node check.mjs", timeout: 20 })];
    }
    assert.equal(n, 5);
    assert.equal(r.at(-1)?.isError, false);
    assert.match(text(r.at(-1)), /ALL_TESTS_PASSED/);
    return [{ type: "text", text: "FIXED_AND_VERIFIED" }];
  });
  assert.equal((await readFile(join(root, "runs.txt"), "utf8")).trim().split("\n").length, 2,
    "one failed run plus one retest; never rerun just to recover logs");
  assert.equal((await readFile(join(root, "state.txt"), "utf8")).trim(), "fixed");
  assert.match(text(repaired.sessionMessages.at(-1)), /FIXED_AND_VERIFIED/);

  const readFixture = "NATIVE_READ_EVIDENCE ".repeat(90) + "\nEND_OF_READ_EVIDENCE";
  await writeFile(join(root, "evidence.txt"), readFixture, "utf8");
  await runCase("more-than-48-reads-then-verify", (n, context) => {
    const r = results(context);
    if (n === 1) return Array.from({ length: 52 }, (_, i) => tool(`read-${i}`, "read", { path: join(root, "evidence.txt"), limit: 10 }));
    if (n === 2) {
      assert.equal(r.length, 52);
      assert(r.every((entry) => !entry.isError && text(entry).includes("END_OF_READ_EVIDENCE")), "no 48-call gate or 24KB result clamp");
      assert(Buffer.byteLength(r.map(text).join("")) > 24_000);
      assert(getCurrentTools(context.messages).some((t) => t.name === "bash"), "Pi transcript still exposes Bash");
      return [tool("after-many-reads", "bash", { command: "printf 'AFTER_52_READS_OK\\n'", timeout: 10 })];
    }
    assert.equal(n, 3);
    assert.match(text(r.at(-1)), /AFTER_52_READS_OK/);
    return [{ type: "text", text: "READ_AND_VERIFY_COMPLETED" }];
  });

  await runCase("permission-block-is-preserved", (n, context) => {
    if (n === 1) return [tool("denied", "bash", { command: "printf DENIED_MUTATION > denied.txt", timeout: 10 })];
    assert.equal(n, 2);
    assert.equal(results(context).at(-1)?.isError, true);
    assert.match(text(results(context).at(-1)), /fixture permission denied/);
    return [{ type: "text", text: "DENIED_WITHOUT_EXECUTION" }];
  }, [(pi) => { pi.on("tool_call", (event) => event.toolName === "bash"
    ? { block: true, reason: "fixture permission denied" } : undefined); }]);
  await assert.rejects(access(join(root, "denied.txt")));

  await runCase("native-shell-exit-status-semantics", (n, context) => {
    if (n === 1) return [
      tool("direct-nonzero", "bash", { command: "printf 'NATIVE_NONZERO\\n'; exit 7", timeout: 10 }),
      tool("intentional-mask", "bash", { command: "(exit 7); printf 'INTENTIONAL_DIAGNOSTIC\\n'", timeout: 10 }),
    ];
    assert.equal(n, 2);
    const r = results(context);
    assert.equal(r.find(m => m.toolCallId === "direct-nonzero")?.isError, true);
    assert.equal(r.find(m => m.toolCallId === "intentional-mask")?.isError, false);
    return [{ type: "text", text: "NATIVE_EXIT_STATUS_PRESERVED" }];
  });

  await runCase("new-user-retains-evidence", (n) => {
    if (n === 1 || n === 3) return [tool(`turn-${n}`, "read", { path: join(root, "state.txt") })];
    return [{ type: "text", text: "TURN_DONE" }];
  }, [], { secondPrompt: true });

  await assert.rejects(runCase("missing-anchor-fails-closed", (n) => {
    if (n === 1) return [tool("fallback-read", "read", { path: join(root, "state.txt") })];
    return [{ type: "text", text: "FALLBACK_DONE" }];
  }, [], { beforeProjection: [(pi) => {
    pi.on("context", (event) => ({ messages: event.messages.filter((message) => message.role !== "user") }));
  }] }), /无法定位本轮证据/);

  console.log(`Pi autonomous execution: 6/6 PASS (native Bash/read/edit, no network/model credentials)`);
} finally {
  for (const path of logs) {
    await rm(path, { force: true });
  }
  await rm(root, { recursive: true, force: true });
}
