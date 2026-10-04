/** Real downloader, Python, uv.lock, console entry point, native execution and rebuild. */
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PythonRuntimeService } from "../src/main/runtime/PythonRuntimeService";
import { UvToolchain } from "../src/main/runtime/UvToolchain";
import { executePython } from "../src/main/runtime/PythonExecutor";
import { createBuiltinCapabilityExtension } from "../src/main/capabilities/builtin-capability-extension";
import { BuiltinCapabilityRuntime } from "../src/main/capabilities/BuiltinCapabilityRuntime";
import { DEFAULT_BUILTIN_CAPABILITIES_CONFIG } from "../src/shared/builtin-capabilities";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const electronApp = process.versions.electron ? (await import("electron")).app : undefined;
if (electronApp) await electronApp.whenReady();

const root = mkdtempSync(join(tmpdir(), "mybuddy-live 中文 "));
const dirs = Object.fromEntries(["environments", "manifests", "staging", "interpreters", "cache", "toolchain"].map(k => [k + "Dir", join(root, k)]));
const uv = new UvToolchain({ ...dirs, env: { ...process.env, MYBUDDY_UV_PATH: "", VIRTUAL_ENV: "Z:/invalid", PYTHONHOME: "Z:/invalid" } });
const service = new PythonRuntimeService({ ...dirs, runtimeDir: root, uv });
service.on("progress", event => console.log(event.phase, event.detail));
console.log("ISOLATED_ROOT", root);
try {
  const spec = { python: "3.12", dependencies: ["wheel==0.45.1"] };
  const result = await service.prepare(spec);
  assert.equal(result.ok, true, JSON.stringify(result));
  const path = result.pythonPath!;
  const workspace = join(root, "task 中文"); mkdirSync(workspace);
  writeFileSync(join(workspace, "pyproject.toml"), '[project]\nname="unrelated"\nversion="1"\n');
  const script = join(root, "probe.py");
  writeFileSync(script, 'import sys, wheel, subprocess\nprint(sys.executable)\nprint(wheel.__version__)\nsubprocess.run(["wheel", "version"], check=True)\nprint("真实执行完成", flush=True)\n');
  const executed = await executePython({ pythonPath: path, scriptPath: script, cwd: workspace });
  assert.equal(executed.exitCode, 0, executed.text);
  assert.match(executed.text, /真实执行完成/);
  assert.deepEqual(readdirSync(workspace), ["pyproject.toml"]);
  const tools = new Map<string, { name: string; execute: (...args: any[]) => Promise<any> }>();
  const runtime = new BuiltinCapabilityRuntime({ store: { read: () => structuredClone(DEFAULT_BUILTIN_CAPABILITIES_CONFIG), write: next => structuredClone(next) } as never });
  createBuiltinCapabilityExtension({
    taskId: "live-python", taskRoot: workspace, runtime, browser: {} as never,
    artifactService: () => null, getProducerMessageId: () => "live-message", getIsolationLevel: () => "guarded",
    pythonRuntime: service,
  })({ registerTool: (tool: { name: string; execute: (...args: any[]) => Promise<any> }) => tools.set(tool.name, tool), on: () => {} } as unknown as ExtensionAPI);
  const toolResult = await tools.get("execute_code")!.execute("live-call", {
    language: "python", code: '# mybuddy-python: 3.12\n# mybuddy-deps: wheel==0.45.1\nimport wheel\nprint("native-tool-ok")',
  });
  assert.equal(toolResult.isError, false, JSON.stringify(toolResult));
  assert.equal(toolResult.details.environmentId, result.environmentId);
  assert.match(toolResult.content[0].text, /native-tool-ok/);
  assert.equal(service.store.list().find(item => item.id === result.environmentId)?.inUse, false);
  assert.deepEqual(readdirSync(service.executionDir), []);
  assert.deepEqual(readdirSync(workspace), ["pyproject.toml"]);
  const restartedUv = new UvToolchain({ ...dirs, env: { ...process.env, MYBUDDY_UV_PATH: "" }, fetchImpl: async () => { throw new Error("offline"); } });
  assert.equal((await restartedUv.ensure()).available, true);
  const lockBefore = readFileSync(join(dirs.manifestsDir, result.environmentId, "uv.lock"), "utf8");
  assert.equal(service.removeEnvironment(result.environmentId).ok, true);
  const rebuilt = await service.prepare(spec);
  assert.equal(rebuilt.ok, true, JSON.stringify(rebuilt));
  assert.equal(readFileSync(join(dirs.manifestsDir, result.environmentId, "uv.lock"), "utf8"), lockBefore);
  assert.equal(rebuilt.pythonVersion, result.pythonVersion);
  writeFileSync(script, 'import time\nprint("started", flush=True)\ntime.sleep(30)\n');
  const timeout = await executePython({ pythonPath: path, scriptPath: script, cwd: workspace, timeoutSeconds: 0.2 });
  assert.equal(timeout.timedOut, true);
  const controller = new AbortController();
  const stopped = await executePython({ pythonPath: path, scriptPath: script, cwd: workspace, signal: controller.signal, onOutput: () => controller.abort() });
  assert.equal(stopped.cancelled, true);
  console.log("python runtime LIVE PASS: download, restart, imports, console script, clean workspace, locked rebuild, timeout, cancel");
} finally {
  // root is created above by this test, never user-supplied.
  rmSync(root, { recursive: true, force: true });
  electronApp?.quit();
}
