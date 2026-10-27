import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { createBashToolDefinition, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getAgentBashShellPath } from "../agent-shell-settings";
import { DEFAULT_BUILTIN_CAPABILITIES_CONFIG } from "../../shared/builtin-capabilities";
import type { PythonRuntimeService } from "../runtime/PythonRuntimeService";
import { executePython } from "../runtime/PythonExecutor";
import { createBuiltinCapabilityExtension } from "./builtin-capability-extension";
import { BuiltinCapabilityRuntime, type LocalCapabilityCheckResult } from "./BuiltinCapabilityRuntime";
import type { BrowserAutomationService } from "./BrowserAutomationService";
import { uiAutomationService } from "./UiAutomationService";
import { computerAutomationService } from "./ComputerAutomationService";
import { runtimeProbeService } from "./RuntimeProbeService";
import { resolveBuiltinSubagentInvocation } from "./subagent/index";
import { getMyBuddyDir } from "../paths";
import { platformShellLanguageIds } from "../platform/shell-tools";
import { computerUseToolCopy } from "../platform/computer-use/support";
import { currentPlatformId } from "../platform";

const execFileAsync = promisify(execFile);
type RegisteredTool = Parameters<ExtensionAPI["registerTool"]>[0];

function output(result: { content: Array<{ type: string; text?: string }>; isError?: boolean }): string {
  return result.content.map((part) => part.text ?? "").join("\n");
}

/** Checks run fixed, read-only snippets in disposable directories, without model calls or installs. */
export async function checkLocalExecution(kind: "terminal" | "code-execution", python: PythonRuntimeService): Promise<LocalCapabilityCheckResult> {
  const root = await mkdtemp(join(tmpdir(), "mybuddy-capability-check-"));
  try {
    const tools = new Map<string, RegisteredTool>();
    const api = { registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool), on: () => undefined } as unknown as ExtensionAPI;
    const marker = `MYBUDDY_CHECK_${randomUUID().replaceAll("-", "")}`;
    if (kind === "terminal") {
      const tool = createBashToolDefinition(root, { shellPath: getAgentBashShellPath(root, getMyBuddyDir()) });
      const result = await tool.execute(marker, { command: `printf '%s' '${marker}'`, timeout: 5 }, undefined, undefined, undefined as never);
      if (result.isError || !output(result).includes(marker)) throw new Error(`命令执行实测失败：${output(result)}`);
      return { state: "ready", detail: "已实际执行 Bash 探测命令；使用 Pi 原生工具及其默认 Shell 解析。" };
    }

    const config = structuredClone(DEFAULT_BUILTIN_CAPABILITIES_CONFIG);
    config.web.enabled = config.vision.enabled = config.imageGeneration.enabled = config.videoGeneration.enabled = false;
    config.speechToText.enabled = config.textToSpeech.enabled = config.browser.enabled = false;
    config.diagnostics = { enabled: false };
    config.multiModelConsult.enabled = false;
    createBuiltinCapabilityExtension({
      taskId: "capability-check", taskRoot: root,
      runtime: { config: () => config } as BuiltinCapabilityRuntime,
      browser: { available: false } as BrowserAutomationService,
      artifactService: () => null, getProducerMessageId: () => undefined, getIsolationLevel: () => "guarded",
    })(api);
    const successes: string[] = [], failures: string[] = [];
    const codeTool = tools.get("execute_code")!;
    for (const language of ["javascript", ...platformShellLanguageIds()]) {
      try {
        const code = language === "javascript" ? `console.log('${marker}')` : `Write-Output '${marker}'`;
        const result = await codeTool.execute(marker, { language, code, timeout: 5 } as never, undefined, undefined, undefined as never);
        if (result.isError || !output(result).includes(marker)) throw new Error(output(result));
        successes.push(language === "javascript" ? "JavaScript" : "PowerShell");
      } catch (error) { failures.push(`${language}：${error instanceof Error ? error.message : String(error)}`); }
    }
    const managed = python.store.resolve(undefined);
    if (managed.ok && managed.pythonPath) {
      try {
        const scriptPath = join(root, "check.py");
        await writeFile(scriptPath, `print('${marker}')`, "utf8");
        const result = await executePython({ pythonPath: managed.pythonPath, scriptPath, cwd: root, timeoutSeconds: 5, isolationLevel: "guarded" });
        if (result.exitCode !== 0 || !result.text.includes(marker)) throw new Error(result.text);
        successes.push("受管 Python");
      } catch (error) { failures.push(`Python：${error instanceof Error ? error.message : String(error)}`); }
    } else failures.push("受管 Python 环境尚未准备；可在 Python 设置中准备，检查不会下载安装");
    if (!successes.length) throw new Error(failures.join("；"));
    return { state: failures.length ? "degraded" : "ready", detail: `实际执行通过：${successes.join("、")}。${failures.join("；")}` };
  } finally { await rm(root, { recursive: true, force: true }); }
}

export function registerLocalCapabilityChecks(runtime: BuiltinCapabilityRuntime, browser: BrowserAutomationService, python: PythonRuntimeService): void {
  runtime.registerLocalCheck("terminal", () => checkLocalExecution("terminal", python));
  runtime.registerLocalCheck("code-execution", () => checkLocalExecution("code-execution", python));
  runtime.registerLocalCheck("browser", async () => {
    const passed: string[] = [], failed: string[] = [];
    const probes: Array<[string, boolean, () => Promise<unknown>]> = [
      ["浏览器", browser.available, () => browser.execute({ action: "read", maxChars: 1_000 })],
      ["应用界面", uiAutomationService.anyAvailable(), () => uiAutomationService.execute({ action: "snapshot", target: uiAutomationService.available("app") ? "app" : uiAutomationService.available("browser") ? "browser" : "artifact", maxChars: 1_000 })],
      [computerUseToolCopy(currentPlatformId).desktopLabel, computerAutomationService.available, () => computerAutomationService.execute({ action: "list_windows" })],
    ];
    for (const [name, available, probe] of probes) {
      if (!available) { failed.push(`${name}未挂载或平台不支持`); continue; }
      try { await probe(); passed.push(name); } catch (error) { failed.push(`${name}：${error instanceof Error ? error.message : String(error)}`); }
    }
    if (!passed.length) throw new Error(failed.join("；"));
    return { state: failed.length ? "degraded" : "ready", detail: `实际读取通过：${passed.join("、")}。${failed.join("；")}` };
  }, () => {
    const tools = [browser.available ? "browser_exec" : "", uiAutomationService.anyAvailable() ? "ui_exec" : "", computerAutomationService.available ? "computer_exec" : ""].filter(Boolean);
    return { available: tools.length > 0, tools, detail: tools.length ? `已接入 ${tools.length} 项界面能力；点击检查验证实际读取。` : "浏览器、应用界面和桌面运行组件均不可用。" };
  });
  runtime.registerLocalCheck("runtime-diagnostics", async () => {
    const result = await runtimeProbeService.execute({ action: "status" });
    const available = result.states?.filter((state) => state.available && !state.crashed) ?? [];
    if (!available.length) throw new Error("没有可读取的运行目标，或渲染进程已崩溃。");
    return { state: "ready", detail: `已实际读取运行状态：${available.map((state) => state.target).join("、")}。` };
  }, () => ({ available: runtimeProbeService.anyAvailable() }));
  runtime.registerLocalCheck("subagent", async () => {
    const invocation = resolveBuiltinSubagentInvocation();
    if (!invocation) throw new Error("无法定位子代理 Node / Pi Runtime。");
    const result = await execFileAsync(invocation.command, [...invocation.args, "--version"], { timeout: 10_000, windowsHide: true, maxBuffer: 32_768 });
    if (!result.stdout.trim()) throw new Error("子代理 Runtime 未返回版本信息。");
    return { state: "ready", detail: `子代理入口已实际启动并返回版本 ${result.stdout.trim().slice(0, 80)}；未调用模型，模型登录在委派时验证。` };
  });
}
