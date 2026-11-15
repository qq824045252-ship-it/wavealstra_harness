import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { botCapabilityTaskId } from "../../../shared/bot-conversation";
import type { ArtifactService } from "../../artifact/ArtifactService";
import type { BrowserAutomationService } from "../../capabilities/BrowserAutomationService";
import type { BuiltinCapabilityRuntime } from "../../capabilities/BuiltinCapabilityRuntime";
import { createBuiltinCapabilityExtension } from "../../capabilities/builtin-capability-extension";
import { durableDomainTools } from "../durable/DurableDomainTools";
import { realpath, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { isPathInsideOrEqual } from "../../task/TaskExecutionWorkspace";

async function validateInputFiles(name: string, args: unknown, cwd: string, attachments: readonly string[]): Promise<void> {
  if (!args || typeof args !== "object" || Array.isArray(args) || name === "text_to_speech") return;
  const input = args as Record<string, unknown>;
  const paths = name === "ocr_file" ? [input.file_path, input.image_path] : name === "speech_to_text" ? [input.audio_path] : [];
  const root = await realpath(cwd);
  const allowed = await Promise.all(attachments.map(path => realpath(path).catch(() => undefined)));
  for (const path of paths) {
    if (typeof path !== "string") continue; // The tool's parameter validator reports missing/invalid input.
    const actual = await realpath(resolve(cwd, path));
    if (!isPathInsideOrEqual(root, actual) && !allowed.includes(actual)) throw new Error("只能识别当前工作目录或本轮对话引用的附件文件。");
    if (!(await stat(actual)).isFile()) throw new Error("识别输入必须是文件。");
  }
}

/** Reuse enabled media adapters with one request's artifact/audio identity. */
export async function createBotCapabilityTools(options: {
  cwd: string; messageId: string; models: ModelRuntime; runtime: BuiltinCapabilityRuntime;
  browser: BrowserAutomationService; artifactService: () => ArtifactService | null;
  getIsolationLevel: () => unknown;
  inputFilePaths?: readonly string[];
}) {
  const taskId = botCapabilityTaskId(options.messageId);
  const domain = await durableDomainTools([createBuiltinCapabilityExtension({
    nativeExecution: true, taskId, taskRoot: options.cwd, runtime: options.runtime, browser: options.browser,
    artifactService: options.artifactService, getProducerMessageId: () => options.messageId,
    inputFilePaths: options.inputFilePaths,
    getIsolationLevel: options.getIsolationLevel,
  })], { cwd: options.cwd, models: options.models, taskId });
  const names = new Set(["ocr_file", "speech_to_text", "text_to_speech"]);
  return { ...domain, tools: domain.tools.filter(tool => names.has(tool.name)).map(tool => ({ ...tool,
    execute: async (...input: Parameters<typeof tool.execute>) => {
      input[2].abortSignal?.throwIfAborted();
      await validateInputFiles(tool.name, input[0], options.cwd, options.inputFilePaths ?? []);
      input[2].abortSignal?.throwIfAborted();
      return tool.execute(...input);
    },
  })), contextHooks: [] };
}
