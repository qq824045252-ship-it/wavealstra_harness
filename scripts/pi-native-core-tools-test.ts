import assert from "node:assert/strict";
import { getCurrentTools } from "@earendil-works/pi-ai";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createAssistantMessageEventStream, type AssistantMessage, type Model } from "@earendil-works/pi-ai/compat";
import {
  createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager,
  createReadToolDefinition, createWriteToolDefinition, createEditToolDefinition, createBashToolDefinition,
  type AgentSession, type InlineExtension, type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { SessionExtensionAssembler } from "../src/main/agent/SessionExtensionAssembler";
import { TaskFileAccessPolicy } from "../src/main/security/TaskFileAccessPolicy";
import { DEFAULT_BUILTIN_CAPABILITIES_CONFIG } from "../src/shared/builtin-capabilities";

// Only the provider and unrelated product services are controlled fixtures. The production
// assembler, installed Pi session, final tool registry, native tools and disk/shell are real.
const root = await mkdtemp(join(tmpdir(), "mybuddy-pi-native-core-"));
const cwd = join(root, "task");
const external = join(root, "outside-task");
await mkdir(cwd); await mkdir(external);
const names = ["read", "write", "edit", "bash"] as const;
const model: Model<any> = { id: "native-core-fixture", provider: "fixture", api: "openai-completions",
  name: "Local native core fixture", baseUrl: "http://invalid.invalid", reasoning: false, input: ["text"],
  contextWindow: 128000, maxTokens: 4096, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
type Desired = { name: string; arguments: Record<string, unknown>; id: string; requests: number };
let desired: Desired | undefined;
const runtime = {
  hasConfiguredAuth: () => true, getAuth: async () => ({ auth: { apiKey: "local-fixture-only" } }),
  getModel: () => model, getModels: () => [model], getAvailable: () => [model],
  streamSimple: () => {
    assert(desired, "a concrete fixture request must be set");
    assert(++desired.requests <= 2, "Pi must settle without a host-injected extra turn");
    const content: AssistantMessage["content"] = desired.requests === 1
      ? [{ type: "toolCall", id: desired.id, name: desired.name, arguments: desired.arguments }]
      : [{ type: "text", text: "NATIVE_CORE_SETTLED" }];
    const stopReason = desired.requests === 1 ? "toolUse" : "stop";
    const response: AssistantMessage = { role: "assistant", content, stopReason,
      api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
      usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
    const stream = createAssistantMessageEventStream();
    stream.push({ type: "start", partial: response });
    stream.push({ type: "done", reason: stopReason, message: response }); stream.end(); return stream;
  },
} as unknown as ModelRuntime;
let hostCalls = 0;
const forbidden = () => { hostCalls++; throw Error("Pi core must not consult MyBuddy execution policy or records"); };
const records = new Proxy({}, { get: () => forbidden });
const config = structuredClone(DEFAULT_BUILTIN_CAPABILITIES_CONFIG);
for (const value of Object.values(config)) if (value && typeof value === "object" && "enabled" in value) value.enabled = false;
const assembler = new SessionExtensionAssembler({
  db: { getTask: () => ({ id: "native-core", projectId: null, spaceId: null }) },
  memory: records, project: records,
  libraryWorkspace: { library: () => records, resourceLocator: () => records },
  conversationInteractions: records, conversationGoals: records,
  executionAttempts: records, executionFailures: records,
  mcpRuntime: { getInlineExtensions: () => [] },
} as any);
const factories = await assembler.build({
  taskId: "native-core", taskRoot: cwd, welcomeMode: "coding", memoryEnabled: false, subagentEnabled: false,
  // Full access exposes the Pi core; unavailable host execution records must not participate.
  sessionPolicy: new TaskFileAccessPolicy({ taskId: "native-core", taskRoot: cwd }),
  getPermissionMode: () => { hostCalls++; return "auto"; }, requestExternalWriteApproval: forbidden, requestApproval: forbidden,
  resolveConversationContext: () => { hostCalls++; return undefined; }, resolveModePresetId: () => null,
  builtinCapability: { runtime: { config: () => config }, browser: { available: false }, ui: { available: false },
    computer: { available: false }, getProducerMessageId: forbidden, artifactService: records, markArtifactEmitted: forbidden },
  mcp: { providerIds: [], ensureRuntimeReady: forbidden }, gadgetService: null,
} as any);

async function makeSession(extensionFactories: InlineExtension[]): Promise<AgentSession> {
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0 } });
  const loader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, extensionFactories });
  await loader.reload();
  assert.equal(loader.getExtensions().errors.length, 0, "all actual production factories must load");
  const { session } = await createAgentSession({ cwd, agentDir: cwd, model, modelRuntime: runtime,
    settingsManager: settings, sessionManager: SessionManager.inMemory(cwd), resourceLoader: loader, tools: [...names] });
  await session.bindExtensions({ mode: "rpc" });
  return session;
}
const results: Array<{ name: string; passed: boolean; details?: unknown; error?: string }> = [];
const spoolFiles = new Set<string>();
async function test(name: string, run: () => unknown | Promise<unknown>) {
  try { const details = await run(); results.push({ name, passed: true, details }); console.log("PASS " + name); }
  catch (error) { results.push({ name, passed: false, error: error instanceof Error ? error.stack : String(error) }); console.error("FAIL " + name + ": " + String(error)); }
}
function normalizeResult(result: any) {
  const text = (result.content ?? []).map((part: any) => part.text ?? "").join("\n");
  const match = text.match(/Full output: (?:"([^"\n]+)"|([^\n\]]+))/);
  if (match) spoolFiles.add((match[1] ?? match[2]).trim());
  return { content: result.content, details: result.details, isError: result.isError };
}
async function invoke(session: AgentSession, name: string, arguments_: Record<string, unknown>, suffix: string) {
  desired = { name, arguments: arguments_, id: suffix, requests: 0 };
  await session.prompt("Execute this exact controlled native tool request: " + suffix);
  const result = session.messages.findLast((entry: any) => entry.role === "toolResult" && entry.toolCallId === suffix);
  assert(result, "Pi must persist its actual tool result");
  assert.equal(desired.requests, 2);
  return normalizeResult(result);
}
let native: AgentSession | undefined;
let production: AgentSession | undefined;
try {
  native = await makeSession([]); production = await makeSession(factories);
  await test("restored session keeps native persisted active tools over settings.defaultTools (Pi 1.3.0 semantics)", async () => {
    const sessionDir = join(root, "restore-sessions");
    const manager = SessionManager.create(cwd, sessionDir);
    const historicalTools = [createReadToolDefinition(cwd), createWriteToolDefinition(cwd), createEditToolDefinition(cwd), createBashToolDefinition(cwd)]
      .map(({ name, description, parameters }) => ({ name, description, parameters }));
    manager.appendMessage({ role: "system", content: "Native persisted tool selection fixture", toolsAdded: historicalTools, timestamp: Date.now() });
    manager.appendMessage({ role: "user", content: "Historical native session", timestamp: Date.now() });
    manager.appendMessage({ role: "assistant", content: [{ type: "text", text: "Historical native reply" }],
      stopReason: "stop", api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(),
      usage: { input: 100, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 110,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
    const sessionFile = manager.getSessionFile(); assert(sessionFile);
    const restoredManager = SessionManager.open(sessionFile, sessionDir);
    const historicalNames = getCurrentTools(restoredManager.buildSessionContext().messages).map((tool) => tool.name);
    assert.deepEqual(historicalNames, [...names], "the actual reopened SDK transcript contains all four historical tools");
    const settings = SettingsManager.inMemory({ defaultTools: ["read"], compaction: { enabled: false }, retry: { enabled: false, maxRetries: 0 } });
    const loader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager: settings,
      noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, extensionFactories: [] });
    await loader.reload();
    // Intentionally omit tools, noTools and excludeTools: this checks the published SDK's
    // concrete default selection, not another session created from the same patched SDK.
    const options = { cwd, agentDir: cwd, model, modelRuntime: runtime, settingsManager: settings,
      sessionManager: restoredManager, resourceLoader: loader };
    assert(!("tools" in options) && !("noTools" in options) && !("excludeTools" in options));
    const { session: restored } = await createAgentSession(options);
    try {
      await restored.bindExtensions({ mode: "rpc" });
      assert.deepEqual(restored.getActiveToolNames(), [...names], "Pi 1.3.0 restores the session-level active tools instead of taking settings.defaultTools");
      assert.deepEqual(getCurrentTools(restoredManager.buildSessionContext().messages).map((tool) => tool.name), [...names],
        "the assertion does not erase history to manufacture the selected tool set");
      return { historicalTools: historicalNames, defaultTools: settings.getDefaultTools(),
        explicitTools: false, explicitNoTools: false, explicitExcludeTools: false, activeTools: restored.getActiveToolNames(),
        fixture: "real persisted Pi SessionManager reopened with SessionManager.open" };
    } finally { restored.dispose(); }
  });
  await test("production registry and final execute are Pi builtins for all four core tools", () => {
    const fresh = [createReadToolDefinition(cwd), createWriteToolDefinition(cwd), createEditToolDefinition(cwd), createBashToolDefinition(cwd)];
    for (const name of names) {
      const info = production!.getAllTools().find((tool) => tool.name === name)!;
      assert.equal(info.sourceInfo.source, "builtin", name);
      assert.equal(info.sourceInfo.path, "builtin:" + name, name);
      const definition = production!.getToolDefinition(name)!;
      const expected = fresh.find((tool) => tool.name === name)!;
      assert.equal(definition.execute.toString(), expected.execute.toString(), name + " definition uses installed native implementation");
      assert.equal(definition.description, expected.description, name + " native description is unchanged");
      assert.deepEqual(definition.promptGuidelines, expected.promptGuidelines, name + " no MyBuddy tool instructions");
      const final = production!.agent.state.tools.find((tool) => tool.name === name)!;
      const upstream = native!.agent.state.tools.find((tool) => tool.name === name)!;
      assert.equal(final.execute.toString(), upstream.execute.toString(), name + " final execute uses Pi's own adapter");
    }
    assert(!production!.extensionRunner.getAllRegisteredTools().some((tool) => names.includes(tool.definition.name as any)));
    const registered = production!.extensionRunner.getAllRegisteredTools().map(tool => tool.definition.name);
    assert(!registered.some(name => /^conversation_(?:todo|plan|finding)_/.test(name)), "retired chat controls must not be exposed in a real Pi session");
    for (const name of ["request_user_input", "conversation_goal_get", "conversation_goal_create", "conversation_goal_update", "conversation_goal_propose_complete"])
      assert(registered.includes(name), "retained conversation tool: " + name);
    return production!.getAllTools().filter((tool) => names.includes(tool.name as any)).map((tool) => ({ name: tool.name, source: tool.sourceInfo }));
  });
  const file = join(external, "result.txt");
  for (const [name, args, reset] of [
    ["write", { path: file, content: "ORIGINAL 中文\n" }, async () => rm(file, { force: true })],
    ["read", { path: file }, async () => writeFile(file, "ORIGINAL 中文\n")],
    ["edit", { path: file, oldText: "ORIGINAL", newText: "EDITED" }, async () => writeFile(file, "ORIGINAL 中文\n")],
    ["bash", { command: "printf 'NATIVE_BASH_OK\\n'", timeout: 10 }, async () => undefined],
  ] as const) {
    await test(name + " output equals pure Pi while host context and permissions are unavailable", async () => {
      await reset(); const expected = await invoke(native!, name, args, "oracle-" + name);
      await reset(); const actual = await invoke(production!, name, args, "production-" + name);
      assert.deepEqual(actual, expected); assert.equal(hostCalls, 0);
      if (name === "write" || name === "edit") assert.equal(await readFile(file, "utf8"), name === "write" ? "ORIGINAL 中文\n" : "EDITED 中文\n");
      assert(!JSON.stringify(actual).includes("executionVerification"));
    });
  }
  for (const [name, args] of [
    ["read", { path: join(external, "missing.txt") }],
    ["write", { path: external, content: "cannot write a directory" }],
    ["edit", { path: file, oldText: "MISSING_TEXT", newText: "replacement" }],
    ["bash", { command: "printf 'NATIVE_NONZERO\\n'; exit 7", timeout: 10 }],
  ] as const) {
    await test(name + " error equals pure Pi and remains a tool error", async () => {
      const expected = await invoke(native!, name, args, "oracle-error-" + name);
      const actual = await invoke(production!, name, args, "production-error-" + name);
      assert.equal(actual.isError, true); assert.deepEqual(actual, expected); assert.equal(hostCalls, 0);
    });
  }
  for (const [name, args] of [
    ["read", { path: file }],
    ["write", { path: file, content: "CANCEL_FIXTURE" }],
    ["edit", { path: file, oldText: "ORIGINAL", newText: "EDITED" }],
    ["bash", { command: "printf 'CANCEL_FIXTURE\\n'", timeout: 10 }],
  ] as const) {
    await test(name + " pre-aborted signal behavior matches pure Pi's final execute", async () => {
      const execute = async (session: AgentSession) => {
        await writeFile(file, "ORIGINAL 中文\n");
        const controller = new AbortController(); controller.abort();
        try {
          const result = await session.agent.state.tools.find((tool) => tool.name === name)!.execute(
            "already-cancelled-" + name, args as any, controller.signal);
          return { result: normalizeResult(result), file: await readFile(file, "utf8") };
        } catch (error) {
          return { error: error instanceof Error ? { name: error.name, message: error.message } : String(error),
            file: await readFile(file, "utf8") };
        }
      };
      assert.deepEqual(await execute(production!), await execute(native!)); assert.equal(hostCalls, 0);
    });
  }
  await test("Bash keeps native 50KB tail truncation and native complete-output file", async () => {
    const actual = await invoke(production!, "bash", { command: "for ((i=0;i<2000;i++)); do printf 'NATIVE_LONG_%04d %070d\\n' \"$i\" 0; done", timeout: 10 }, "long-bash");
    const text = actual.content.map((part: any) => part.text ?? "").join("\n");
    assert(text.includes("NATIVE_LONG_1999")); assert(text.includes("Full output:"));
    assert(Buffer.byteLength(text) > 8192 && Buffer.byteLength(text) <= 51_200 + 1024);
    assert(spoolFiles.size); const output = [...spoolFiles].at(-1)!;
    assert((await readFile(output, "utf8")).includes("NATIVE_LONG_0000"));
    assert(!dirname(output).includes("mybuddy-pi-shell")); assert.equal(hostCalls, 0);
  });
  await test("actual Bash cancellation matches pure Pi and stops the pending command", async () => {
    const cancel = async (session: AgentSession, id: string) => {
      desired = { name: "bash", arguments: { command: "printf 'CANCEL_STARTED\\n'; sleep 10; printf 'SHOULD_NOT_FINISH\\n'", timeout: 15 }, id, requests: 0 };
      let abortPromise: Promise<void> | undefined;
      const unsubscribe = session.subscribe((event: any) => {
        if (event.type === "tool_execution_update" && JSON.stringify(event).includes("CANCEL_STARTED") && !abortPromise)
          abortPromise = Promise.resolve().then(() => session.abort());
      });
      try {
        await session.prompt("Execute the controlled cancellation fixture");
        assert(abortPromise, "the command really started before cancellation"); await abortPromise;
        const result: any = session.messages.findLast((entry: any) => entry.role === "toolResult" && entry.toolCallId === id);
        assert(result); assert.equal(result.isError, true);
        assert(!JSON.stringify(result).includes("SHOULD_NOT_FINISH"));
        assert.equal(session.isStreaming, false);
        return { result: normalizeResult(result), requests: desired.requests };
      } finally { unsubscribe(); }
    };
    const expected = await cancel(native!, "oracle-cancel-bash");
    const actual = await cancel(production!, "production-cancel-bash");
    // 取消时机本身有竞争：CANCEL_STARTED 是否已经跟进最终 toolResult，取决于 abort 与
    // 输出缓冲谁先到（CI 上慢机器会两边不同）。断言不变量而不是逐字节文本：
    // provider 调度次数一致、都以 "Command aborted" 收尾、都没有执行到 SHOULD_NOT_FINISH。
    const textOf = (out: { result: unknown }): string =>
      JSON.stringify((out.result as { content?: { text?: string }[] }).content?.map((part) => part.text ?? "") ?? "");
    assert.equal(actual.requests, expected.requests, "cancellation 后的 provider 调度次数与纯 Pi 一致");
    assert.match(textOf(actual), /Command aborted/);
    assert.match(textOf(expected), /Command aborted/);
    assert.doesNotMatch(textOf(actual), /SHOULD_NOT_FINISH/);
    assert.doesNotMatch(textOf(expected), /SHOULD_NOT_FINISH/);
    assert.equal(hostCalls, 0);
  });
  assert.equal(hostCalls, 0, "no core tool consulted product context, approvals or execution records");
} finally {
  native?.dispose(); production?.dispose();
  for (const file of spoolFiles) await rm(file, { force: true });
  await rm(root, { recursive: true, force: true });
  const target = resolve("artifacts/pi-native-core-tools"); await mkdir(target, { recursive: true });
  await writeFile(join(target, "results.json"), JSON.stringify({ at: new Date().toISOString(), passed: results.length > 0 && results.every((item) => item.passed), hostCalls, results }, null, 2));
}
process.exitCode = results.every((item) => item.passed) ? 0 : 1;
