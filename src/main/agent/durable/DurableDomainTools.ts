import { AsyncLocalStorage } from "node:async_hooks";
import { ModelRegistry, type ModelRuntime, type ExtensionAPI, type ExtensionContext, type ToolDefinition, type InlineExtension } from "@earendil-works/pi-coding-agent";
import { defineEntry, type ToolRegistration, type Cursor, type EntryRecord, type ConversationId } from "@earendil-works/pi-durable";
import { bindNativeSummaryRuntime } from "../../capabilities/web-access/summary-model-scope";
import { storeResult, type StoredSearchData } from "../../capabilities/web-access/storage";

type NativeApi = Parameters<ToolRegistration["execute"]>[1];
type NativeContext = Parameters<ToolRegistration["execute"]>[2];
interface CapabilityContext { cwd: string; models: ModelRuntime }

/** Reuse domain operations, not AgentSession. This bridge cannot install policy/event hooks. */
export async function durableDomainTools(factories: readonly InlineExtension[], capabilities?: CapabilityContext): Promise<ToolRegistration[]> {
  const tools: ToolRegistration[] = [];
  const invocation = new AsyncLocalStorage<{ native: NativeApi; context: NativeContext; conversationId: ConversationId; writes: Promise<unknown>[] }>();
  const api = new Proxy({
    registerTool(tool: ToolDefinition) {
      tools.push({ name: tool.name, description: tool.description, parameters: tool.parameters,
        // Data writes must never be repeated after a crash with an unknown outcome.
        replay: "unsafe",
        execute: async (args, native, context) => {
          const conversationId = await presentationConversation(native, context);
          return invocation.run({ native, context, conversationId, writes: [] }, async () => {
            const extensionContext = capabilities ? await capabilityContext(native, context, capabilities, conversationId) : undefined;
            try {
              const result = await tool.execute(native.callId, args, context.abortSignal,
                update => { for (const block of update.content ?? []) if (block.type === "text") native.output(block.text); },
                extensionContext as Parameters<typeof tool.execute>[4]);
              return { output: result.content, isError: result.isError, details: result.details === undefined ? undefined : JSON.parse(JSON.stringify(result.details)) };
            } finally { await Promise.all(invocation.getStore()!.writes); }
          });
        },
      });
    },
  }, { get(target, key) {
    if (key === "registerTool") return target.registerTool;
    if (capabilities) {
      // TUI commands/widgets are not a second workflow in Bot. Tool results are rendered from Durable.
      if (key === "registerShortcut" || key === "registerCommand") return () => {};
      if (key === "on") return (event: string) => {
        if (!["session_start", "session_tree", "session_shutdown"].includes(event)) throw new Error(`Unsupported execution hook: ${event}`);
      };
      if (key === "appendEntry") return (kind: string, data: unknown) => {
        const current = invocation.getStore();
        if (!current) throw new Error("Durable metadata must belong to a tool invocation");
        current.writes.push(current.native.commit(tx => tx.appendEntry(defineEntry(`mybuddy.${kind}`), current.conversationId,
          { data: JSON.parse(JSON.stringify(data)) }), current.context));
      };
    }
    throw new Error(`Durable domain extensions cannot use AgentSession API: ${String(key)}`);
  } }) as unknown as ExtensionAPI;
  for (const factory of factories) await (typeof factory === "function" ? factory : factory.factory)(api);
  return tools;
}

/** Code Mode's private tool conversations share presentation data through their native owner chain. */
async function presentationConversation(native: NativeApi, context: NativeContext): Promise<ConversationId> {
  return native.commit(async tx => {
    let id = native.conversationId;
    for (;;) {
      const conversation = await tx.conversation(id);
      if (!conversation?.owner) return id;
      id = conversation.owner.conversationId;
    }
  }, context);
}

async function capabilityContext(native: NativeApi, context: NativeContext, options: CapabilityContext, conversationId: ConversationId): Promise<ExtensionContext> {
  const agent = await native.agent(context);
  const entries: EntryRecord[] = [];
  let cursor: Cursor | undefined;
  do {
    const page = await native.commit(tx => tx.scanEntries({ conversationId }, 500, cursor), context);
    entries.push(...page.items); cursor = page.next;
  } while (cursor);
  const branch = entries.filter(entry => entry.kind.startsWith("mybuddy.")).map(entry => ({
    type: "custom", id: String(entry.id), customType: entry.kind.slice(8), data: entry.data,
  }));
  for (const entry of branch) if (entry.customType === "web-search-results") {
    const data = entry.data as unknown as StoredSearchData;
    if (data?.id) storeResult(data.id, data);
  }
  const reader = { getBranch: () => branch, getSessionId: () => String(conversationId), getCwd: () => options.cwd };
  bindNativeSummaryRuntime(reader, options.models);
  return { cwd: options.cwd, hasUI: false,
    model: agent.model ? options.models.getModel(agent.model.provider === "azure-openai-responses" ? "azure" : agent.model.provider, agent.model.modelId) : undefined,
    modelRegistry: new ModelRegistry(options.models), sessionManager: reader,
    isProjectTrusted: () => true,
    ui: { notify: (message: string) => native.output(message), setWidget: () => {} },
  } as unknown as ExtensionContext;
}
