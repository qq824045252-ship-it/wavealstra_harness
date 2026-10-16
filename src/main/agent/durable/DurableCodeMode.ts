import { Type } from "@earendil-works/pi-ai";
import {
  CodemodeSandbox, renderDeclarations,
  type CodemodeJsonSchema, type CodemodeOutputItem, type CodemodeSandboxOptions, type CodemodeTool,
} from "@earendil-works/pi-codemode";
import { withAbortSignal } from "@earendil-works/chord/context";
import {
  defineDoc, defineTool,
  type JsonObject, type NestedToolExecutionResult, type ToolRegistration,
} from "@earendil-works/pi-durable";
import { persistDurableImages } from "./DurableImages";

const Store = defineDoc({ kind: "mybuddy.codemode-store", version: 1, scope: "conversation", history: "latest", fork: "current", initial: () => ({ values: {} as JsonObject }) });

/** One nested call the UI projects from the Code Mode result details. */
export type CodemodeCallDetail = {
  readonly id: string;
  readonly name: string;
  readonly args: JsonObject;
  readonly status: "ok" | "error";
  readonly output?: string;
  readonly durationMs?: number;
  readonly error?: string;
};

type MutableCallDetail = { -readonly [K in keyof CodemodeCallDetail]: CodemodeCallDetail[K] };

/** The program-visible value pi-durable returns for a schema-less tool: text, one image, `""`, or a content list. */
function contentItems(value: unknown): CodemodeOutputItem[] {
  if (value === undefined || value === null || value === "") return [];
  if (typeof value === "string") return [{ type: "text", text: value }];
  if (Array.isArray(value)) return value.flatMap(item => contentItems(item));
  if (typeof value === "object") {
    const item = value as Record<string, unknown>;
    if (item.type === "image" && typeof item.data === "string" && typeof item.mimeType === "string") {
      return [{ type: "image", data: item.data, mimeType: item.mimeType }];
    }
    if (item.type === "text" && typeof item.text === "string") return [{ type: "text", text: item.text }];
    return [{ type: "text", text: JSON.stringify(value) }];
  }
  return [{ type: "text", text: String(value) }];
}

function outputText(value: unknown): string {
  return contentItems(value)
    .filter((item): item is Extract<CodemodeOutputItem, { type: "text" }> => item.type === "text")
    .map(item => item.text).join("\n");
}

function failureText(result: NestedToolExecutionResult, name: string): string {
  const diagnostics = result.diagnostics.filter(item => item.severity === "error").map(item => item.message).join("\n");
  return diagnostics || outputText(result.structuredOutput) || `Nested tool ${name} failed`;
}

/**
 * Code Mode runs model-written JavaScript and gives each `tools.<name>(args)` call a real, durable nested task
 * through the official `api.executeTool()`. Durable then owns validation, ToolTask hooks, output limits, replay
 * policy, `pi.live.nestedTools` progress and restart abandonment; this tool only maps the nested value to what the
 * script sees and records the call rows the UI projects.
 */
export function createDurableCodeMode(
  tools: () => readonly ToolRegistration[],
  assets: Pick<CodemodeSandboxOptions, "wasm" | "workerUrl"> = {},
  imageDirectory?: string,
  prepareTools?: (code: string, context: Parameters<ToolRegistration["execute"]>[2]) => Promise<readonly ToolRegistration[]>,
): ToolRegistration {
  return defineTool({
    name: "codemode",
    description: "Run JavaScript using await tools.<name>(args), ALL_TOOLS, text(), image(), store()/load(). " +
      "Use code to combine calls and return concise results. Each nested tool runs as a durable child task.\n" +
      renderDeclarations({ tools: tools().map(t => ({ name: t.name, description: t.description, inputSchema: t.parameters as CodemodeJsonSchema, execute: async () => undefined })) }),
    parameters: Type.Object({ code: Type.String() }),
    replay: "unsafe",
    executionMode: "sequential",
    callers: ["model"],
    execute: async ({ code }, api, context) => {
      const declared = tools();
      const names = new Set(declared.map(tool => tool.name));
      const available = [...declared, ...(await prepareTools?.(code, context) ?? []).filter(tool => !names.has(tool.name))];
      const calls: MutableCallDetail[] = [];
      const nested: CodemodeTool[] = available.map(tool => ({
        name: tool.name, description: tool.description, inputSchema: tool.parameters as CodemodeJsonSchema,
        execute: async (args, { signal }) => {
          const callContext = withAbortSignal(signal, context);
          const detail: MutableCallDetail = { id: `${tool.name}:${calls.length}`, name: tool.name, args: (args ?? {}) as JsonObject, status: "ok" };
          calls.push(detail);
          let nestedResult: NestedToolExecutionResult;
          try {
            nestedResult = await api.executeTool(tool.name, (args ?? {}) as JsonObject, callContext);
          } catch (error) {
            detail.status = "error";
            detail.error = error instanceof Error ? error.message : String(error);
            throw error;
          }
          detail.status = nestedResult.isError ? "error" : "ok";
          detail.durationMs = nestedResult.durationMs;
          detail.output = outputText(nestedResult.structuredOutput);
          if (nestedResult.isError) {
            const message = failureText(nestedResult, tool.name);
            detail.error = message;
            throw new Error(message);
          }
          // A schema tool resolves with its validated value; without one the program gets the bounded output as content.
          return tool.structuredOutputSchema === undefined
            ? { content: contentItems(nestedResult.structuredOutput) }
            : { content: nestedResult.structuredOutput };
        },
      }));
      const saved = await api.snapshot(Store, api.conversationId, context);
      const sandbox = new CodemodeSandbox({ ...assets, tools: nested, timeoutMs: Infinity });
      try {
        const result = await sandbox.execute(code, { signal: context.abortSignal, store: saved?.values ?? {} });
        if (result.ok) await api.commit(async tx => {
          const state = await tx.doc(Store, api.conversationId);
          for (const key of result.storeWrites.delete) delete state.values[key];
          Object.assign(state.values, result.storeWrites.set);
        }, context);
        const persistedOutput = imageDirectory ? await persistDurableImages(result.output, imageDirectory) : { content: [...result.output], paths: [] };
        await api.details({
          ...(persistedOutput.paths.length ? { imagePaths: persistedOutput.paths } : {}),
          calls,
        }, context);
        const content = persistedOutput.content;
        if (result.ok && result.value !== undefined) content.push({ type: "text", text: JSON.stringify(result.value) });
        if (!result.ok) content.push({ type: "text", text: result.error.stack ?? result.error.message });
        return { output: content, isError: !result.ok };
      } finally {
        await sandbox.close();
      }
    },
  });
}
