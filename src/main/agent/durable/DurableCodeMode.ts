import { CodemodeSandbox, type CodemodeSandboxOptions } from "@earendil-works/pi-codemode";
import { createCodemodeTool } from "@earendil-works/pi-durable/codemode";
import type { ToolRegistration } from "@earendil-works/pi-durable";
import { persistDurableImages } from "./DurableImages";

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
    try {
      const result = await createCodemodeTool({ sandbox, models: false }).execute({ code: args.code }, api, context);
      if (!imageDirectory || !result.output?.some(item => item.type === "image")) return result;
      const images = await persistDurableImages(result.output, imageDirectory);
      const details = result.details && typeof result.details === "object" && !Array.isArray(result.details) ? result.details : {};
      return { ...result, output: images.content, details: { ...details, imagePaths: images.paths } };
    } finally {
      await sandbox.close();
    }
  } };
}
