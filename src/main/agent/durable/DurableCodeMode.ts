import { randomUUID } from "node:crypto";
import { Type, type AssistantMessage } from "@earendil-works/pi-ai";
import { CodemodeSandbox, renderDeclarations, type CodemodeTool, type CodemodeSandboxOptions, type CodemodeJsonSchema } from "@earendil-works/pi-codemode";
import { withAbortSignal } from "@earendil-works/chord/context";
import {
  AssistantEntry, ToolTask, ToolResultEntry, configure, defineDoc, defineTool,
  type ToolRegistration, type JsonObject,
} from "@earendil-works/pi-durable";
import { persistDurableImages } from "./DurableImages";

const Store = defineDoc({ kind: "mybuddy.codemode-store", version: 1, scope: "conversation", history: "latest", fork: "current", initial: () => ({ values: {} as JsonObject }) });

/** Code is never replayed wholesale. Every nested call is a real Pi ToolTask with its own intent and hooks. */
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
    execute: async ({ code }, api, context) => {
      const declared = tools();
      const names = new Set(declared.map(tool => tool.name));
      const available = [...declared, ...(await prepareTools?.(code, context) ?? []).filter(tool => !names.has(tool.name))];
      const child = await api.commit(async tx => {
        const conversation = await tx.createConversation({ ownership: { kind: "task", taskId: api.taskId } });
        await configure(tx, conversation.id, { tools: available });
        return conversation.id;
      }, context);
      await api.details({ conversationId: child }, context);
      const nested: CodemodeTool[] = available.map(tool => ({
        name: tool.name, description: tool.description, inputSchema: tool.parameters as CodemodeJsonSchema,
        execute: async (args, { signal }) => {
          const callContext = withAbortSignal(signal, context);
          const callId = randomUUID();
          const taskId = await api.commit(async tx => {
            // This private task-owned transcript is not part of the parent model context.
            const message: AssistantMessage = {
              role: "assistant", provider: "mybuddy", model: "codemode", api: "openai-completions",
              content: [{ type: "toolCall", id: callId, name: tool.name, arguments: args as JsonObject }],
              stopReason: "toolUse", timestamp: Date.now(),
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
            };
            const entry = await tx.appendEntry(AssistantEntry, child, { model: [message] });
            // The conversation belongs to this Code Mode task; its tasks belong to that conversation.
            return tx.createTask(ToolTask, { assistant: entry.id, callId }, { conversationId: child, ownership: { kind: "conversation" } });
          }, callContext);
          const settled = await api.waitForTask(taskId, callContext);
          if (settled.state.outcome.status !== "completed") throw new Error(`Nested tool ${tool.name}: ${settled.state.outcome.status}`);
          const resultId = settled.state.outcome.result.entryId;
          const entry = await api.commit(tx => tx.entry(ToolResultEntry, resultId), callContext);
          const result = entry?.model?.[0];
          if (!result || result.role !== "toolResult") throw new Error(`Missing durable result: ${tool.name}`);
          if (result.isError) throw new Error(result.content.filter(x => x.type === "text").map(x => x.text).join("\n"));
          return { content: result.content };
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
        if (persistedOutput.paths.length) await api.details({ conversationId: child, imagePaths: persistedOutput.paths }, context);
        const content = persistedOutput.content;
        if (result.ok && result.value !== undefined) content.push({ type: "text", text: JSON.stringify(result.value) });
        if (!result.ok) content.push({ type: "text", text: result.error.stack ?? result.error.message });
        return { content, isError: !result.ok };
      } finally {
        await sandbox.close();
        // End unawaited calls through Durable. Shutdown itself leaves recovery to the owner task.
        if (!context.abortSignal?.aborted) await (await api.conversation(child, context))?.abort(context, { background: true });
      }
    },
  });
}
