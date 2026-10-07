import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Models, Message, AssistantMessage } from "@earendil-works/pi-ai";
import {
  Harness, createRegistry, defineExtension, section, AgentDoc, hook, GenerationTask, defineDoc,
  type Conversation, type ConversationWatch, type ConversationView, type EntryRecord,
  type LiveState, type InboxState, type Storage, type ToolRegistration, type UserInput, type Cursor, type UsageState, type Submission,
} from "@earendil-works/pi-durable";
import { CodingTools, createPowerShellTool } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import { openNodeJsonlStorage } from "@earendil-works/pi-durable/storage/jsonl/node";
import type { CodemodeSandboxOptions } from "@earendil-works/pi-codemode";
import type { ChatMessageDto } from "../../../shared/agent-ipc";
import type { BotToolMode, DurableBotSnapshot } from "../../../shared/durable-bot";
import { createDurableCodeMode } from "./DurableCodeMode";
import { durableCompletedTurns } from "./DurableTurnProjection";
import { withDurableImageRead } from "./DurableImages";

type BotInputMetadata = { text: string; displayText: string; attachments: Array<{ name: string; path: string }> };
const InputMetadata = defineDoc({ kind: "mybuddy.inputs", version: 1, scope: "conversation", history: "latest", fork: "current",
  initial: () => ({ requests: {} as Record<string, BotInputMetadata> }),
});
// Display telemetry lives with Durable, never in the task scheduler or renderer clock.
const ResponseTiming = defineDoc({ kind: "mybuddy.response-timing", version: 1, scope: "conversation", history: "latest", fork: "current",
  initial: () => ({ completed: {} as Record<string, number> }),
});

export interface DurableBotOptions {
  directory: string;
  cwd: string;
  models: Models;
  model?: { provider: string; modelId: string };
  toolMode: BotToolMode;
  instructions: () => string;
  evidence?: (messages: readonly Message[]) => string;
  onTurns?: (turns: ReturnType<typeof durableCompletedTurns>) => void;
  onEntries?: (entries: readonly EntryRecord[]) => void;
  taskId?: string;
  tools?: readonly ToolRegistration[];
  assets?: Pick<CodemodeSandboxOptions, "wasm" | "workerUrl">;
  onSnapshot: (snapshot: DurableBotSnapshot) => void;
  /** Only for isolated tests; production always opens its own durable JSONL directory. */
  storage?: Storage;
}

/** A product adapter, with no scheduler, retry loop, continuation prompt or in-memory execution queue. */
export class DurableBotRuntime {
  private watch!: ConversationWatch;
  private revision = 0;
  private readonly epoch = randomUUID();
  private latest!: DurableBotSnapshot;
  private closed = false;
  private projection: Promise<void> = Promise.resolve();
  private nativeTools: ToolRegistration[] = [];
  private codemode!: ToolRegistration;
  private registry!: ReturnType<typeof createRegistry>;
  private storage!: Storage;
  private readonly children = new Map<number, ConversationWatch>();
  private constructor(readonly harness: Harness, readonly conversation: Conversation, private readonly options: DurableBotOptions) {}

  static async open(options: DurableBotOptions): Promise<DurableBotRuntime> {
    options = { ...options, models: legacyCompatibleModels(options.models) };
    const registry = createRegistry();
    const native = [...codingTools(), ...(options.tools ?? [])];
    const codemode = createDurableCodeMode(() => native, options.assets, join(options.directory, "images"));
    let runtime: DurableBotRuntime | undefined;
    registry.install(botExtension(options, native, codemode, (id, message) => runtime?.recordResponse(id, message)));
    const storage = options.storage ?? await openNodeJsonlStorage(options.directory, ctx, { fsync: true });
    let harness: Harness | undefined;
    try {
      harness = await Harness.open(storage, {
        models: options.models, registry,
        env: ({ cwd }) => {
          // Never fall back to process.cwd() after a workspace disappears or changes.
          if (!cwd || resolve(cwd) !== resolve(options.cwd) || !statSync(cwd).isDirectory()) throw new Error("Bot 工作目录失效，请修复项目目录后继续");
          return new NodeExecutionEnv({ cwd });
        },
      }, ctx);
      const conversation = await harness.root(ctx, { agent: { cwd: options.cwd, model: options.model } });
      runtime = new DurableBotRuntime(harness, conversation, options);
      runtime.storage = storage;
      runtime.registry = registry;
      runtime.nativeTools = native;
      runtime.codemode = codemode;
      const bound = await conversation.agent(ctx);
      if (bound.cwd && resolve(bound.cwd) !== resolve(options.cwd)) throw new Error("Bot 已绑定的工作目录与当前项目不一致");
      // Stored agent choices win on reopen, including an unfinished Code Mode call.
      const configured = await conversation.commit(async tx => Boolean((await tx.doc(AgentDoc, conversation.id)).tools), ctx);
      if (configured) options.toolMode = bound.tools.some(tool => tool.name === "codemode") ? "codemode" : "native";
      else await runtime.configure(options.model, options.toolMode);
      runtime.watch = await conversation.watch(ctx);
      await runtime.refresh();
      runtime.watch.start(async () => { await runtime!.refresh(); });
      return runtime;
    } catch (error) {
      if (harness) await harness.close(ctx); else await storage.close(ctx);
      throw error;
    }
  }

  async configure(model: DurableBotOptions["model"], toolMode: BotToolMode, thinkingLevel?: import("@earendil-works/pi-ai").ModelThinkingLevel, extensions?: readonly ToolRegistration[]): Promise<void> {
    if (extensions) {
      this.nativeTools = [...codingTools(), ...extensions];
      const available = this.nativeTools;
      this.codemode = createDurableCodeMode(() => available, this.options.assets, join(this.options.directory, "images"));
      this.registry.install(botExtension(this.options, available, this.codemode, (id, message) => this.recordResponse(id, message)));
    }
    this.options.toolMode = toolMode;
    const tools = toolMode === "codemode" ? [this.codemode] : this.nativeTools;
    await this.conversation.configure({
      ...(model ? { model } : {}), ...(thinkingLevel ? { thinkingLevel } : {}),
      tools,
    }, ctx);
  }

  resume(): void { this.harness.resume(); }
  get snapshot(): DurableBotSnapshot { return this.latest; }

  private async recordResponse(taskId: number, message: AssistantMessage): Promise<void> {
    const completedAt = Date.now();
    await this.conversation.commit(async tx => {
      const timing = await tx.doc(ResponseTiming, this.conversation.id);
      timing.completed[`${taskId}:${message.timestamp}`] ??= completedAt;
    }, ctx);
  }

  async submit(content: UserInput, requestId: string, whenBusy: "steer" | "followUp" = "followUp", metadata?: BotInputMetadata) {
    if (metadata) await this.conversation.commit(async tx => {
      const doc = await tx.doc(InputMetadata, this.conversation.id);
      doc.requests[requestId] ??= metadata;
    }, ctx);
    const submission = await this.conversation.submit({ type: "input", content, requestId, whenBusy }, ctx);
    await this.refresh();
    return submission;
  }

  async refresh(): Promise<DurableBotSnapshot> {
    // Serialize presentation reads only. Durable alone schedules execution.
    const projection = this.projection.then(async () => {
      if (this.closed) return;
      const view = await this.conversation.watch(ctx);
      try { await this.project(view.value); }
      finally { await view.stop(); }
    });
    this.projection = projection.catch(() => {});
    await projection;
    return this.latest;
  }

  /** The answer belongs to this receipt even if another turn has already started or failed. */
  async reply(submission: Submission): Promise<string> {
    const settled = await submission.wait(ctx);
    if (settled.status === "unanswered") {
      throw new Error(settled.reason === "aborted" ? "任务已取消" : `Durable 未完成回复：${typeof settled.detail === "string" ? settled.detail : settled.reason}`);
    }
    if (settled.type !== "input") throw new Error("Gateway 需要用户输入回执");
    const record = await this.storage.entry(this.conversation.id, settled.answer, ctx);
    const message = record?.entry.model?.find(item => item.role === "assistant");
    if (!message) throw new Error("Durable 回复记录不存在");
    if (message.stopReason === "error" || message.stopReason === "aborted" || message.stopReason === "length") {
      throw new Error(message.errorMessage || `Durable 回复未完成：${message.stopReason}`);
    }
    return contentText(message.content).trim() || "任务已处理，但未产生文本回复。";
  }

  async abort(): Promise<void> {
    await this.conversation.abort(ctx, { background: true });
    await this.refresh();
  }

  async compact(): Promise<void> {
    const id = await this.conversation.compact(undefined, ctx);
    const result = await this.harness.waitForTask(id, ctx);
    if (result.state.outcome.status !== "completed") throw new Error(`Durable 压缩${result.state.outcome.status}`);
    const submissionId = result.state.outcome.result.submissionId;
    if (submissionId) await (await this.harness.submission(submissionId, ctx))?.wait(ctx);
    await this.refresh();
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.watch?.stop();
    await Promise.all([...this.children.values()].map(watch => watch.stop()));
    await this.projection;
    // close checkpoints pending work; abort would permanently cancel it.
    await this.harness.close(ctx);
  }

  private async project(value: ConversationView): Promise<void> {
    if (this.closed) return;
    // Include full history across compactions/resets. These are immutable entries, not model context.
    let cursor: Cursor | undefined;
    const entries: EntryRecord[] = [];
    const tail = value.entries.at(-1)?.id;
    if (tail !== undefined) do {
      const page = await this.conversation.entries({ maxEntryId: tail }, 500, cursor, ctx);
      entries.push(...page.items);
      cursor = page.next;
    } while (cursor);
    const live = (value.docs["pi.live"] ?? {}) as LiveState;
    const timing = await this.harness.snapshot(ResponseTiming, this.conversation.id, ctx);
    const metadata = await this.harness.snapshot(InputMetadata, this.conversation.id, ctx);
    const inputMetadata = new Map<number, BotInputMetadata>();
    if (metadata) {
      let next: Cursor | undefined;
      do {
        const page = await this.storage.scanSubmissions({ conversationId: this.conversation.id }, 500, next, ctx);
        for (const receipt of page.items) {
          const input = receipt.requestId && metadata.requests[receipt.requestId];
          if (receipt.entry && input) inputMetadata.set(receipt.entry, input);
        }
        next = page.next;
      } while (next);
    }
    const messages: ChatMessageDto[] = [];
    const tools = new Map<string, NonNullable<ChatMessageDto["tools"]>[number]>();
    const childIds = new Map<string, number>();
    const nestedEntries = new Map<number, EntryRecord[]>();
    let error: string | undefined;
    let outcome: DurableBotSnapshot["outcome"];
    let turnStartedAt: number | undefined;
    const append = (entry: Pick<EntryRecord, "id" | "kind" | "model" | "byTaskId">, streaming = false, id = `durable-${entry.id}`) => {
      for (const message of entry.model ?? []) {
        if (message.role === "user" && entry.kind === "pi.user") {
          const input = inputMetadata.get(entry.id);
          messages.push({ id, role: "user", text: input?.displayText ?? contentText(message.content), attachments: input?.attachments, createdAt: message.timestamp });
          outcome = undefined;
          turnStartedAt = message.timestamp;
        } else if (message.role === "assistant") {
          const calls = message.content.filter(x => x.type === "toolCall").map(call => {
            const tool = { id: call.id, tool: call.name, summary: JSON.stringify(call.arguments), status: "running" as const };
            tools.set(call.id, tool);
            return tool;
          });
          const completedAt = timing?.completed[`${entry.byTaskId}:${message.timestamp}`];
          const startedAt = turnStartedAt ?? message.timestamp;
          messages.push({ id, role: "assistant",
            presentationKey: entry.byTaskId ? `durable-generation-${entry.byTaskId}${message.stopReason === "aborted" ? `-${entry.id}` : ""}` : id,
            durationMs: completedAt !== undefined ? Math.max(0, completedAt - startedAt) : undefined,
            generationStats: { phase: streaming ? "generating" : "complete", startedAt, updatedAt: completedAt ?? message.timestamp,
              tps: null, estimated: false, outputTokens: message.usage.output, ttftMs: null,
              ...(!streaming ? { outcome: message.stopReason === "aborted" ? "aborted" as const : message.stopReason === "error" || message.stopReason === "length" ? "error" as const : "completed" as const } : {}),
            },
            text: contentText(message.content) + (message.errorMessage ? `\n${message.errorMessage}` : ""),
            thinking: message.content.filter(x => x.type === "thinking").map(x => x.thinking).join(""),
            tools: calls, modelName: message.model, createdAt: message.timestamp, streaming,
          });
          error = message.stopReason === "error" ? message.errorMessage : undefined;
          outcome = message.stopReason === "stop" ? "completed" : message.stopReason === "aborted" ? "aborted" : message.stopReason === "error" || message.stopReason === "length" ? "failed" : undefined;
        } else if (message.role === "toolResult") {
          const tool = tools.get(message.toolCallId);
          if (tool) { tool.status = message.isError ? "error" : "success"; tool.output = contentText(message.content); }
          const child = (message.details as { conversationId?: number } | undefined)?.conversationId;
          if (child && tool?.tool === "codemode") childIds.set(message.toolCallId, child);
          const images = (message.details as { imagePaths?: string[] } | undefined)?.imagePaths;
          const owner = messages.find(row => row.tools?.some(call => call.id === message.toolCallId));
          if (images?.length && owner) owner.artifacts = [...owner.artifacts ?? [], ...images.map(path => ({
            id: `${message.toolCallId}:${path}`, name: basename(path), kind: "image" as const, path, content: "",
          }))];
        }
      }
    };
    for (const entry of entries.sort((a,b) => a.id - b.id)) append(entry);
    if (live.run && live.generation?.message) append({ id: live.run.taskId as unknown as EntryRecord["id"], byTaskId: live.run.taskId, kind: "pi.assistant", model: [live.generation.message] }, true, `durable-live-${live.run.taskId}`);
    if (live.run) {
      const key = `durable-generation-${live.run.taskId}`;
      let current = messages.find(message => message.presentationKey === key);
      if (!current) {
        current = { id: `durable-live-${live.run.taskId}`, presentationKey: key, role: "assistant", text: "", createdAt: turnStartedAt ?? 0 };
        messages.push(current);
      }
      current.streaming = true;
      current.durationMs = undefined;
      current.generationStats = { phase: live.generation?.retry ? "retrying" : live.compactions?.some(item => item.blocking) ? "compacting" : live.tools?.length ? "tools" : live.generation?.message ? "generating" : "waiting",
        startedAt: turnStartedAt ?? current.createdAt, updatedAt: current.createdAt, tps: null, estimated: false, outputTokens: null, ttftMs: null };
    }
    for (const slot of live.tools ?? []) {
      const tool = tools.get(slot.callId);
      if (tool) { tool.output = slot.output ?? tool.output; if (slot.status !== "done") tool.status = "running"; }
      const child = (slot.details as { conversationId?: number } | undefined)?.conversationId;
      if (child && slot.name === "codemode") childIds.set(slot.callId, child);
    }
    for (const [parentId, childId] of childIds) {
      const owner = messages.find(message => message.tools?.some(tool => tool.id === parentId));
      if (!owner) continue;
      const child = await this.harness.conversation(childId as Conversation["id"], ctx);
      if (!child) continue;
      const view = await child.watch(ctx);
      try {
        let next: Cursor | undefined;
        const nested: EntryRecord[] = [];
        do { const page = await child.entries({}, 500, next, ctx); nested.push(...page.items); next = page.next; } while (next);
        nestedEntries.set(childId, nested);
        for (const entry of nested.sort((a,b) => a.id - b.id)) for (const message of entry.model ?? []) {
          if (message.role === "assistant") for (const call of message.content) {
            if (call.type !== "toolCall") continue;
            const tool: NonNullable<ChatMessageDto["tools"]>[number] = { id: call.id, parentToolCallId: parentId, tool: call.name, summary: JSON.stringify(call.arguments), status: "running" };
            tools.set(call.id, tool); owner.tools!.push(tool);
          }
          if (message.role === "toolResult") {
            const tool = tools.get(message.toolCallId);
            if (tool) { tool.status = message.isError ? "error" : "success"; tool.output = contentText(message.content); }
          }
        }
        if (tools.get(parentId)?.status === "running" && !this.children.has(childId)) {
          const watch = await child.watch(ctx); this.children.set(childId, watch);
          watch.start(async () => { await this.refresh(); });
        }
      } finally { await view.stop(); }
      if (tools.get(parentId)?.status !== "running") {
        await this.children.get(childId)?.stop(); this.children.delete(childId);
      }
    }
    const inbox = value.docs["pi.inbox"] as InboxState | undefined;
    const busy = Boolean(live.run || live.compactions?.length);
    const agent = await this.conversation.agent(ctx);
    const model = agent.model && this.options.models.getModel(agent.model.provider, agent.model.modelId);
    const ledger = value.docs["pi.usage"] as UsageState | undefined;
    const totals = Object.values(ledger?.models ?? {}).reduce((sum, usage) => ({
      input: sum.input + usage.input, output: sum.output + usage.output,
      cacheRead: sum.cacheRead + usage.cacheRead, cacheWrite: sum.cacheWrite + usage.cacheWrite,
    }), { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    const active = await this.conversation.context(ctx);
    const last = [...active.entries].reverse().find(entry => entry.kind === "pi.assistant" && entry.id > (active.head?.id ?? 0));
    const assistant = last?.model?.find(message => message.role === "assistant");
    const usedTokens = assistant?.role === "assistant" ? assistant.usage.input + assistant.usage.cacheRead + assistant.usage.cacheWrite + assistant.usage.output : null;
    const denominator = totals.input + totals.cacheRead + totals.cacheWrite;
    const snapshot: DurableBotSnapshot = { backend: "pi-durable", epoch: this.epoch, revision: ++this.revision,
      conversationId: String(this.conversation.id), toolMode: this.options.toolMode,
      busy, queued: inbox?.items?.length ?? 0, messages, ...(error ? { error } : {}),
      pendingInputs: (inbox?.items ?? []).flatMap(item => item.mode === "write" ? [] : [{ id: String(item.id), mode: item.mode, text: contentText(item.content) }]),
      retry: live.generation?.retry, compacting: Boolean(live.compactions?.length),
      outcome: busy ? undefined : outcome,
      ...(model ? { contextUsage: { usedTokens, estimated: usedTokens !== null, contextWindow: model.contextWindow,
        percent: usedTokens === null ? null : usedTokens / model.contextWindow * 100,
        cacheHitRate: denominator ? totals.cacheRead / denominator : null,
        inputTokens: totals.input, outputTokens: totals.output, cacheReadTokens: totals.cacheRead } } : {}),
    };
    this.latest = snapshot;
    this.options.onSnapshot(snapshot);
    try { this.options.onEntries?.(entries); }
    catch (error) { console.warn("[Durable] Usage projection failed", error); }
    if (this.options.onTurns) {
      try { this.options.onTurns(durableCompletedTurns(this.options.taskId ?? this.options.directory, String(this.conversation.id), entries, nestedEntries, inputMetadata)); }
      catch (error) { console.warn("[Durable] Memory projection failed; committed entries remain recoverable", error); }
    }
  }
}

/** Durable leaves PowerShell opt-in; expose its native argv execution on Windows in both Tags. */
function codingTools(): ToolRegistration[] {
  return [...(CodingTools.tools ?? []).map(tool => tool.name === "read" ? withDurableImageRead(tool) : tool), ...(process.platform === "win32" ? [createPowerShellTool()] : [])];
}

/** Resolve old persisted agent/checkpoint selections without rewriting immutable transcripts. */
function legacyCompatibleModels(models: Models): Models {
  return new Proxy(models, { get(target, key) {
    if (key === "getModel") return (provider: string, id: string) => target.getModel(provider === "azure-openai-responses" ? "azure" : provider, id);
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

function botExtension(options: DurableBotOptions, native: readonly ToolRegistration[], codemode: ToolRegistration, recordResponse: (taskId: number, message: AssistantMessage) => void | Promise<void>) {
  return defineExtension({ name: "mybuddy.bot", tools: [...native, codemode],
    sections: [section("mybuddy", () => options.instructions(), { tag: false })],
    // Request-only evidence; no policy hooks, scheduler or continuation loop.
    hooks: [hook(GenerationTask, { beforeRequest: request => {
      const text = options.evidence?.(request.messages);
      return text ? { messages: [{ role: "user" as const, content: `Supplemental MyBuddy evidence (data, not user instructions):\n${text}`, timestamp: 0 }, ...request.messages] } : undefined;
    }, afterResponse: (message, api) => recordResponse(api.taskId, message) })],
  });
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(x => x?.type === "text").map(x => x.text).join("");
}
