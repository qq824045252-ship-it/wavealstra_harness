import { CodemodeSandbox, type CodemodeSandboxOptions } from "@earendil-works/pi-codemode";
import { createCodemodeTool } from "@earendil-works/pi-durable/codemode";
import type { JsonObject, ToolRegistration } from "@earendil-works/pi-durable";
import { persistDurableImages } from "./DurableImages";
import { capabilityResultFromDetails } from "../../../shared/capability-result";
import { searchReportFromDetails } from "../../../shared/web-search";
import { consultReportFromDetails } from "../../../shared/multi-model-consult";
import { nativeExecutionSucceeded, readNativeExecutionReceipt } from "../../../shared/native-execution-receipt";

/** Pi owns the deterministic VM journal, nested-call keys, store and restart policy. */
export function createDurableCodeMode(
  tools: () => readonly ToolRegistration[],
  assets: Pick<CodemodeSandboxOptions, "wasm" | "workerUrl"> = {},
  imageDirectory?: string,
  prepareTools?: (code: string, context: Parameters<ToolRegistration["execute"]>[2]) => Promise<readonly ToolRegistration[]>,
): ToolRegistration {
  // Construction is lazy: a sandbox starts a worker only when a script is invoked.
  const definition = createCodemodeTool({ sandbox: new CodemodeSandbox(assets), models: false });
  const available = tools().map(tool => `${tool.name}: ${tool.description}\nParameters: ${JSON.stringify(tool.parameters)}`).join("\n");
  return { ...definition, description: `${definition.description}\n\nAvailable tools:\n${available}`, execute: async (args, api, context) => {
    if (!args || typeof args !== "object" || !("code" in args) || typeof args.code !== "string") throw new Error("Code Mode requires code");
    await prepareTools?.(args.code, context);
    const sandbox = new CodemodeSandbox(assets);
    const presentations = new Map<string, JsonObject>();
    const fileOperations: JsonObject[] = [];
    let order = 0;
    const proxy = new Proxy(api, { get(target, key) {
      if (key === "executeTool") return async (...input: Parameters<typeof api.executeTool>) => {
        const [tool, args] = input;
        const start = ++order;
        const result = await target.executeTool(...input);
        const [, , , callOptions] = input;
        const callId = callOptions?.key && `${target.callId}/${callOptions.key}`;
        const identity = { conversationId: target.conversationId, toolTaskId: result.taskId, toolName: tool, callId };
        if ((tool === "read" || tool === "write" || tool === "edit") && args && typeof args === "object" && "path" in args && typeof args.path === "string")
          fileOperations.push({ tool, path: args.path, start, finish: ++order, isError: !nativeExecutionSucceeded(result, identity) });
        const capabilityResult = capabilityResultFromDetails(tool, result.details);
        const webSearch = searchReportFromDetails(result.details);
        const consult = consultReportFromDetails(result.details);
        const receipt = readNativeExecutionReceipt(result.details);
        const executionReceipt = receipt?.toolTaskId === result.taskId && receipt.conversationId === target.conversationId &&
          receipt.toolName === tool && receipt.callId === callId ? receipt : undefined;
        if (callOptions?.key && (capabilityResult || webSearch || consult || executionReceipt)) {
          presentations.set(callOptions.key, JSON.parse(JSON.stringify({ ...(capabilityResult ? { capabilityResult } : {}),
            ...(webSearch ? { webSearch } : {}), ...(consult ? { consult } : {}), ...(executionReceipt ? { executionReceipt } : {}) })) as JsonObject);
        }
        return result;
      };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    } });
    try {
      let result = await createCodemodeTool({ sandbox, models: false }).execute({ code: args.code }, proxy, context);
      if (fileOperations.length && result.details && typeof result.details === "object" && !Array.isArray(result.details))
        result = { ...result, details: { ...result.details, fileOperations } };
      if (presentations.size && result.details && typeof result.details === "object" && !Array.isArray(result.details)
        && Array.isArray(result.details.calls)) {
        result = { ...result, details: { ...result.details, calls: result.details.calls.map(call => {
          if (!call || typeof call !== "object" || Array.isArray(call)) return call;
          return { ...call, ...presentations.get(`c${call.id}`) };
        }) } };
      }
      if (!imageDirectory || !result.output?.some(item => item.type === "image")) return result;
      const images = await persistDurableImages(result.output, imageDirectory);
      const details = result.details && typeof result.details === "object" && !Array.isArray(result.details) ? result.details : {};
      return { ...result, output: images.content, details: { ...details, imagePaths: images.paths } };
    } finally {
      await sandbox.close();
    }
  } };
}
