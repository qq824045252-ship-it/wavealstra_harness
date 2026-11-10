import { withWorkShellRead } from "../src/main/agent/work/WorkShellRead";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { ensureWhisperRuntime } from "../src/main/voice/whisperAsr";
import { venvPythonRelativePath } from "../src/main/platform/runtime";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_BUILTIN_CAPABILITIES_CONFIG } from "../src/shared/builtin-capabilities";
import { BuiltinCapabilityRuntime } from "../src/main/capabilities/BuiltinCapabilityRuntime";
import { BuiltinCapabilityStore } from "../src/main/capabilities/BuiltinCapabilityStore";
import { activateResolvedSessionTools, resolveDurableToolSelection, resolveSessionToolSelection } from "../src/main/agent/PromptAssembly";
import { checkLocalExecution } from "../src/main/capabilities/LocalCapabilityChecks";
import type { PythonRuntimeService } from "../src/main/runtime/PythonRuntimeService";
import { createBuiltinCapabilityExtension } from "../src/main/capabilities/builtin-capability-extension";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";

const root = await mkdtemp(join(tmpdir(), "mybuddy-local-capabilities-test-"));
try {
  let shellFallbacks = 0, readOnlyShell = true;
  const shell = withWorkShellRead({ name: "bash", execute: async () => { shellFallbacks++; return {}; } } as unknown as ToolRegistration, () => readOnlyShell);
  let output = "";
  const readApi = { env: new NodeExecutionEnv({ cwd: root }), output: (value: string) => { output += value; } } as unknown as Parameters<ToolRegistration["execute"]>[1];
  await shell.execute({ command: "pwd" }, readApi, BACKGROUND_CONTEXT);
  assert.equal(output.trim(), root);
  for (const command of ["touch forbidden", "echo x > forbidden", "pwd\ntouch forbidden", "ls; touch forbidden", "find . -exec touch forbidden ;", "pwd $(touch forbidden)"]) {
    await assert.rejects(() => shell.execute({ command }, readApi, BACKGROUND_CONTEXT), /只读任务仅支持/);
  }
  assert.equal(shellFallbacks, 0, "readonly executor must never enter shell even without policy hooks");
  readOnlyShell = false;
  await shell.execute({ command: "unclassified" }, readApi, BACKGROUND_CONTEXT);
  assert.equal(shellFallbacks, 1, "non-readonly behavior is unchanged");
  assert.equal(venvPythonRelativePath("linux"), join("bin", "python"));
  assert.equal(venvPythonRelativePath("win32"), join("Scripts", "python.exe"));
  const previousWhisper = process.env.MYBUDDY_WHISPER_DIR;
  process.env.MYBUDDY_WHISPER_DIR = join(root, "missing-whisper");
  try {
    const absent = await ensureWhisperRuntime();
    assert.equal(absent.available, false);
    assert.equal(absent.pythonSource, "none");
    assert.match(absent.detail, /transcribe_wav.py/);
    assert.match(absent.detail, /未准备环境或启动转写/);
  } finally {
    if (previousWhisper === undefined) delete process.env.MYBUDDY_WHISPER_DIR;
    else process.env.MYBUDDY_WHISPER_DIR = previousWhisper;
  }
  let config = structuredClone(DEFAULT_BUILTIN_CAPABILITIES_CONFIG);
  const runtime = new BuiltinCapabilityRuntime({
    store: { read: () => structuredClone(config), write: (next) => (config = structuredClone(next)) },
    credentials: { has: () => false, get: () => null, set: () => undefined, clear: () => undefined },
  });
  const state = (id: string) => runtime.snapshot().capabilities.find((item) => item.id === id)!;
  assert.equal(state("terminal").state, "unchecked");
  assert.equal(state("code-execution").state, "unchecked");
  assert.equal((await runtime.test("terminal")).ok, false, "unwired checks must not report success");
  let attempts = 0;
  runtime.registerLocalCheck("terminal", async () => { attempts++; if (attempts === 1) throw new Error("spawn failed"); return { state: "ready", detail: "real probe passed" }; });
  assert.equal((await runtime.test("terminal")).state, "offline");
  assert.equal(state("terminal").state, "offline", "failed checks remain visible after refresh");
  assert.equal((await runtime.test("terminal")).ok, true, "failed checks can be retried");
  assert.equal(state("terminal").state, "ready");

  runtime.registerLocalCheck("browser", async () => ({ state: "degraded", detail: "UI works, browser unmounted" }), () => ({ available: true, tools: ["ui_exec"] }));
  runtime.setBrowserAvailable(false);
  assert.deepEqual(state("browser").tools, ["ui_exec"]);
  assert.equal(state("browser").state, "unchecked", "UI can be checked without a mounted browser");
  assert.equal((await runtime.test("browser")).state, "degraded");

  let complete!: () => void;
  runtime.registerLocalCheck("terminal", async () => { await new Promise<void>((resolve) => { complete = resolve; }); return { state: "ready", detail: "late result" }; });
  const pending = runtime.test("terminal");
  config.execution.terminalEnabled = false;
  runtime.saveConfig(config);
  complete();
  assert.equal((await pending).state, "unchecked", "late checks cannot validate a changed configuration");
  assert.equal(state("terminal").state, "disabled");

  const selection = resolveSessionToolSelection("auto", { mode: "hard", prefer: [], demote: [], deny: ["write"] }, config);
  assert(selection.excludeTools?.includes("bash"));
  assert(selection.excludeTools?.includes("powershell"));
  assert(selection.excludeTools?.includes("write"));
  let active = ["read", "bash", "powershell", "write"];
  activateResolvedSessionTools({ getActiveToolNames: () => active, getAllTools: () => active.map((name) => ({ name })), setActiveToolsByName: (names) => { active = names; } }, selection);
  assert.deepEqual(active, ["read"], "post-bind activation must not re-enable excluded tools");
  const readonly = resolveSessionToolSelection("readonly", { mode: "soft", prefer: [], demote: [], deny: [] }, config);
  assert(readonly.excludeTools?.includes("bash"));
  assert(readonly.excludeTools?.includes("execute_code"));

  const soft = { mode: "soft" as const, prefer: [], demote: [], deny: [] };
  const durableReadonly = resolveDurableToolSelection("readonly", soft);
  assert(!durableReadonly.excludeTools?.includes("bash"));
  for (const name of ["write", "edit", "powershell", "execute_code"]) assert(durableReadonly.excludeTools?.includes(name));
  assert(resolveSessionToolSelection("readonly", soft).excludeTools?.includes("bash"));
  assert(resolveDurableToolSelection("readonly", soft, config).excludeTools?.includes("bash"));
  assert(resolveDurableToolSelection("readonly", { ...soft, mode: "hard", deny: ["BASH"] }).excludeTools?.includes("bash"));
  const path = join(root, "capabilities.json");
  const store = new BuiltinCapabilityStore(path);
  await writeFile(path, JSON.stringify({ schemaVersion: 1, browser: { enabled: false } }));
  assert.equal(store.read().diagnostics?.enabled, false, "legacy disabled browser must not turn diagnostics on");
  await writeFile(path, JSON.stringify({ schemaVersion: 1, browser: { enabled: true }, diagnostics: { enabled: false } }));
  assert.equal(store.read().diagnostics?.enabled, false);

  const probeConfig = structuredClone(DEFAULT_BUILTIN_CAPABILITIES_CONFIG);
  probeConfig.web.enabled = probeConfig.vision.enabled = probeConfig.imageGeneration.enabled = probeConfig.videoGeneration.enabled = false;
  probeConfig.speechToText.enabled = probeConfig.textToSpeech.enabled = probeConfig.browser.enabled = false;
  probeConfig.execution.codeExecutionEnabled = false;
  probeConfig.multiModelConsult.enabled = false;
  probeConfig.diagnostics = { enabled: true };
  const tools: string[] = [];
  createBuiltinCapabilityExtension({ taskId: "diagnostic-test", taskRoot: root, runtime: { config: () => probeConfig } as BuiltinCapabilityRuntime, browser: { available: false } as never, artifactService: () => null, getProducerMessageId: () => undefined, getIsolationLevel: () => "guarded" })({ registerTool: (tool: { name: string }) => tools.push(tool.name) } as unknown as ExtensionAPI);
  assert.deepEqual(tools, ["runtime_probe"], "diagnostics registration is independent of UI control");

  const model = { id: "capability-fixture", provider: "fixture", api: "openai-completions", name: "Capability fixture", baseUrl: "http://invalid.invalid", reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 2048, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
  for (const enabled of [false, true]) {
    const cwd = join(root, enabled ? "enabled" : "disabled");
    await mkdir(cwd);
    const sessionConfig = structuredClone(probeConfig);
    sessionConfig.execution.terminalEnabled = enabled;
    const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false }, defaultTools: process.platform === "win32" ? ["read", "write", "edit", "bash", "powershell"] : ["read", "write", "edit", "bash"] });
    const loader = new DefaultResourceLoader({ cwd, agentDir: cwd, settingsManager, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, extensionFactories: [
      createBuiltinCapabilityExtension({ taskId: "native-capability-fixture", taskRoot: cwd, runtime: { config: () => sessionConfig } as BuiltinCapabilityRuntime, browser: { available: false } as never, artifactService: () => null, getProducerMessageId: () => undefined, getIsolationLevel: () => "guarded" }),
    ] });
    await loader.reload();
    const nativeSelection = resolveSessionToolSelection("auto", { mode: "soft", prefer: [], demote: [], deny: [] }, sessionConfig);
    const created = await createAgentSession({ cwd, agentDir: cwd, model: model as never, modelRuntime: { getModel: () => model, hasConfiguredAuth: () => true, getAuth: async () => ({ auth: { apiKey: "fixture-only" } }), streamSimple: () => { throw new Error("No model inference allowed"); } } as never, settingsManager, sessionManager: SessionManager.create(cwd, cwd), resourceLoader: loader, excludeTools: nativeSelection.excludeTools });
    try {
      await created.session.bindExtensions({ mode: "rpc" });
      activateResolvedSessionTools(created.session, nativeSelection);
      assert.equal(created.session.getActiveToolNames().includes("bash"), enabled, "actual Pi session must honor the command switch after binding");
      if (process.platform === "win32") assert.equal(created.session.getActiveToolNames().includes("powershell"), enabled, "configured native PowerShell must honor the same command switch");
      if (enabled) assert.equal(created.session.getAllTools().find((tool) => tool.name === "bash")?.sourceInfo.source, "builtin", "bash must remain the Pi builtin");
      assert(!created.session.getAllTools().some((tool) => tool.name === "terminal"), "actual Pi registry must not contain the duplicate alias");
      assert(created.session.getActiveToolNames().includes("runtime_probe"), "diagnostics remains independently active");
    } finally { created.session.dispose(); }
  }

  const noPython = { store: { resolve: () => ({ ok: false }) } } as unknown as PythonRuntimeService;
  assert.equal((await checkLocalExecution("terminal", noPython)).state, "ready", "Bash check must actually execute");
  const codeCheck = await checkLocalExecution("code-execution", noPython);
  assert.equal(codeCheck.state, "degraded", "missing Python is partial availability, not full readiness");
  assert.match(codeCheck.detail, /JavaScript/);
  if (process.platform === "win32") assert.match(codeCheck.detail, /PowerShell/);
  assert.match(codeCheck.detail, /Python.*尚未准备/);
  console.log("local capability checks: PASS (real Bash/JavaScript/PowerShell, native Pi session exclusions, no Python install, failed check retry, stale result, legacy config, independent diagnostics)");
} finally { await rm(root, { recursive: true, force: true }); }
