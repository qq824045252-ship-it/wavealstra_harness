import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Models, Message, AssistantMessage } from "@earendil-works/pi-ai";
import {
  Harness, SessionFailed, StorageRequestError, NestedCallDoc, createRegistry, defineExtension, section, AgentDoc, hook, GenerationTask, defineDoc,
  type Conversation, type ConversationWatch, type ConversationView, type EntryRecord,
  type LiveState, type InboxState, type Storage, type TaskId, type ToolRegistration, type UserInput, type Cursor, type UsageState, type Submission,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { CodemodeSandboxOptions } from "@earendil-works/pi-codemode";
import type { ChatMessageDto } from "../../../shared/agent-ipc";
import type { BotToolMode, DurableBotSnapshot } from "../../../shared/durable-bot";
import { createDurableCodeMode } from "./DurableCodeMode";
import type { DurableLogRepairReport } from "./DurableLogRepair";
import type { DurableContextHook } from "./DurableDomainTools";
import { openDurableStorage } from "./DurableStorage";
import type { DurableStorageLease } from "./DurableStorageLease";
import { durableCompletedTurns } from "./DurableTurnProjection";
import { withDurableImageRead } from "./DurableImages";
import { getAgentBashShellPath } from "../../agent-shell-settings";
import { getMyBuddyDir } from "../../paths";
import { createPlatformShellTools } from "../../platform/shell-tools";

type BotInputMetadata = { text: string; displayText: string; attachments: Array<{ name: string; path: string }> };
const InputMetadata = defineDoc({ kind: "mybuddy.inputs", version: 1, scope: "conversation", history: "latest", fork: "current", checkpointWhen: () => false,
  initial: () => ({ requests: {} as Record<string, BotInputMetadata> }),
});
// Display telemetry lives with Durable, never in the task scheduler or renderer clock.
const ResponseTiming = defineDoc({ kind: "mybuddy.response-timing", version: 1, scope: "conversation", history: "latest", fork: "current", checkpointWhen: () => false,
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
  /** 扩展的 context 钩子（改写每次请求的上下文）；在 beforeRequest 里与 evidence 一起执行。 */
  contextHooks?: readonly DurableContextHook[];
  /** Task-scoped compatibility registrations for stored names, without transport startup. */
  restoreTools?: (names: readonly string[]) => readonly ToolRegistration[];
  prepareCodeMode?: (code: string, context: Parameters<ToolRegistration["execute"]>[2]) => Promise<readonly ToolRegistration[]>;
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
  private failure: unknown = undefined;
  private failed = false;
  private closeBegun = false;
  private readonly failureListeners = new Set<(error: unknown) => void>();
  private projection: Promise<void> = Promise.resolve();
  private nativeTools: ToolRegistration[] = [];
  private compatibilityTools: ToolRegistration[] = [];
  private codemode!: ToolRegistration;
  private registry!: ReturnType<typeof createRegistry>;
  private storage!: Storage;
  /** Cross-process single-writer lease; only present when the runtime opened its own directory. */
  private lease?: DurableStorageLease;
  private repaired?: DurableLogRepairReport;
  private readonly children = new Map<number, ConversationWatch>();
  private constructor(readonly harness: Harness, readonly conversation: Conversation, private readonly options: DurableBotOptions) {
    this.observeSession();
  }

  /** Deterministic recovery of a log that a second writer corrupted; surfaced to the conversation UI. */
  get repairReport(): DurableLogRepairReport | undefined { return this.repaired; }

  /** Whether the underlying Session failed and this runtime must be reopened. */
  isSessionFailed(): boolean { return this.failed; }
  /** The first error that failed the Session, or undefined while healthy. */
  sessionFailure(): unknown { return this.failure; }
  /** Observe the first Session failure; returns an unsubscribe function. */
  onSessionFailed(listener: (error: unknown) => void): () => void {
    if (this.failed) { listener(this.failure); return () => {}; }
    this.failureListeners.add(listener);
    return () => { this.failureListeners.delete(listener); };
  }
  private observeSession(): void {
    this.harness.subscribeClose(() => {
      this.closeBegun = true;
      void this.harness.closed.then(end => { if (end.kind === "failed") this.markFailure(end.error); });
    });
  }
  private markFailure(error: unknown): void {
    if (this.failed || this.closed) return;
    this.failed = true;
    this.failure = error;
    console.warn("[Durable] Session failed; reopening recovers committed content", error);
    for (const listener of [...this.failureListeners]) {
      try { listener(error); }
      catch (listenerError) { console.warn("[Durable] Session failure listener failed", listenerError); }
    }
    this.failureListeners.clear();
  }
  private assertSessionHealthy(): void {
    if (this.failed) throw new SessionFailed(this.failure);
  }
  /** Convert a failed call into the recognizable SessionFailed, preserving the original cause. */
  private async normalizeFailure(error: unknown): Promise<never> {
    if (error instanceof StorageRequestError) throw error;
    if (error instanceof SessionFailed) { this.markFailure(error.cause); throw error; }
    if (this.failed) throw new SessionFailed(this.failure);
    // The first fatal Storage call rethrows its raw error; the Session closes at once.
    // Wait for that close so the failure is recorded and callers always see SessionFailed.
    if (this.closeBegun) {
      const end = await this.harness.closed;
      if (end.kind === "failed") this.markFailure(end.error);
    }
    if (this.failed) throw new SessionFailed(this.failure);
    throw error;
  }

  static async open(options: DurableBotOptions): Promise<DurableBotRuntime> {
    options = { ...options, models: legacyCompatibleModels(options.models) };
    const handle = options.storage ? undefined : await openDurableStorage(options.directory, ctx);
    const storage = options.storage ?? handle!.storage;
    const registry = createRegistry();
    const native = [...codingTools(), ...(options.tools ?? [])];
    let compatibility: ToolRegistration[] = [];
    try {
      if (options.restoreTools) {
        const names = new Set<string>();
        let cursor: Cursor | undefined;
        do {
          const page = await storage.scanConversations({}, 500, cursor, ctx);
          for (const conversation of page.items) {
            const record = await storage.findDocument({ kind: AgentDoc.definition.kind, scope: { kind: "conversation", conversationId: conversation.id } }, "current", ctx);
            const state = record && await storage.document(record.id, "current", ctx);
            if (Array.isArray(state?.value.tools)) for (const name of state.value.tools) if (typeof name === "string") names.add(name);
          }
          cursor = page.next;
        } while (cursor);
        const installed = new Set(native.map(tool => tool.name));
        compatibility = [...options.restoreTools([...names])].filter(tool => !installed.has(tool.name));
        native.push(...compatibility);
      }
    } catch (error) { await storage.close(ctx); handle?.lease.release(); throw error; }
    const codemode = createDurableCodeMode(() => native, options.assets, join(options.directory, "images"), async (code, context) => {
      const tools = await options.prepareCodeMode?.(code, context) ?? [];
      runtime?.installCompatibility(tools);
      return tools;
    });
    let runtime: DurableBotRuntime | undefined;
    registry.install(botExtension(options, native, codemode, (id, message) => runtime?.recordResponse(id, message),
      (code, context) => runtime?.prewarmCodeMode(code, context)));
    let harness: Harness | undefined;
    try {
      harness = await Harness.open(storage, {
        models: options.models, registry,
        env: ({ cwd }) => {
          // Never fall back to process.cwd() after a workspace disappears or changes.
          if (!cwd || resolve(cwd) !== resolve(options.cwd) || !statSync(cwd).isDirectory()) throw new Error("Bot 工作目录失效，请修复项目目录后继续");
          return new NodeExecutionEnv({ cwd, shellPath: getAgentBashShellPath(cwd, getMyBuddyDir()) });
        },
      }, ctx);
      const conversation = await harness.root(ctx, { agent: { cwd: options.cwd, model: options.model } });
      runtime = new DurableBotRuntime(harness, conversation, options);
      runtime.storage = storage;
      runtime.lease = handle?.lease;
      runtime.repaired = handle?.repair;
      runtime.registry = registry;
      runtime.nativeTools = native;
      runtime.compatibilityTools = compatibility;
      runtime.codemode = codemode;
      const bound = await conversation.agent(ctx);
      if (bound.cwd && resolve(bound.cwd) !== resolve(options.cwd)) throw new Error("Bot 已绑定的工作目录与当前项目不一致");
      // Stored agent choices win on reopen, including an unfinished Code Mode call.
      const configured = await conversation.commit(async tx => Boolean((await tx.doc(AgentDoc, conversation.id)).tools), ctx);
      if (configured) {
        options.toolMode = bound.tools.some(tool => tool.name === "codemode") ? "codemode" : "native";
        // Normalize Code Mode sessions persisted before executeTool: scripts may call every registered tool,
        // while the model is still offered only codemode.
        if (options.toolMode === "codemode") await runtime.configure(undefined, "codemode");
      } else await runtime.configure(options.model, options.toolMode);
      runtime.watch = await conversation.watch(ctx);
      await runtime.refresh();
      runtime.watch.start(async () => { await runtime!.refresh(); });
      return runtime;
    } catch (error) {
      if (harness) await harness.close(ctx); else await storage.close(ctx);
      handle?.lease.release();
      throw error;
    }
  }

  async configure(model: DurableBotOptions["model"], toolMode: BotToolMode, thinkingLevel?: import("@earendil-works/pi-ai").ModelThinkingLevel,
    extensions?: readonly ToolRegistration[], contextHooks?: readonly DurableContextHook[]): Promise<void> {
    this.assertSessionHealthy();
    // Request-context hooks come from the same extension factories as the tools; they are re-installed
    // together so a refreshed tool set can never keep a stale (or dropped) context rewrite.
    if (contextHooks) this.options.contextHooks = [...contextHooks];
    if (extensions || contextHooks) {
      if (extensions) this.nativeTools = [...codingTools(), ...extensions];
      const available = this.nativeTools;
      this.codemode = createDurableCodeMode(() => available, this.options.assets, join(this.options.directory, "images"), async (code, context) => {
        const tools = await this.options.prepareCodeMode?.(code, context) ?? [];
        this.installCompatibility(tools);
        return tools;
      });
      // Retain implementations referenced by old in-flight phase agents, without declaring them
      // to new turns. Durable still decides whether an interrupted external call may replay.
      const names = new Set(available.map(tool => tool.name));
      const registered = [...available, ...this.compatibilityTools.filter(tool => !names.has(tool.name))];
      this.registry.install(botExtension(this.options, registered, this.codemode, (id, message) => this.recordResponse(id, message),
        (code, context) => this.prewarmCodeMode(code, context)));
    }
    this.options.toolMode = toolMode;
    await this.conversation.configure({
      ...(model ? { model } : {}), ...(thinkingLevel ? { thinkingLevel } : {}),
      tools: toolMode === "codemode" ? { remove: [] } : this.nativeTools,
      modelTools: toolMode === "codemode" ? [this.codemode] : null,
    }, ctx);
  }

  resume(): void { this.assertSessionHealthy(); this.harness.resume(); }
  private installCompatibility(tools: readonly ToolRegistration[]): void {
    if (!tools.length) return;
    const compatibility = new Map(this.compatibilityTools.map(tool => [tool.name, tool]));
    for (const tool of tools) compatibility.set(tool.name, tool);
    this.compatibilityTools = [...compatibility.values()];
    const names = new Set(this.nativeTools.map(tool => tool.name));
    this.registry.install(botExtension(this.options, [...this.nativeTools, ...this.compatibilityTools.filter(tool => !names.has(tool.name))], this.codemode,
      (id, message) => this.recordResponse(id, message),
      (code, context) => this.prewarmCodeMode(code, context)));
  }
  /** Install Code Mode's dynamically discovered tools before the nested ToolTask freezes its registry snapshot. */
  private async prewarmCodeMode(code: string, context: Parameters<ToolRegistration["execute"]>[2]): Promise<void> {
    const tools = await this.options.prepareCodeMode?.(code, context) ?? [];
    if (tools.length) this.installCompatibility(tools);
  }

  get snapshot(): DurableBotSnapshot { return this.latest; }

  /** Query native state before changing a task identity; UI idle alone is not a boundary. */
  async isIdle(): Promise<boolean> {
    const snapshot = await this.refresh();
    return !snapshot.busy && snapshot.queued === 0;
  }

  private async recordResponse(taskId: number, message: AssistantMessage): Promise<void> {
    const completedAt = Date.now();
    await this.conversation.commit(async tx => {
      const timing = await tx.doc(ResponseTiming, this.conversation.id);
      timing.completed[`${taskId}:${message.timestamp}`] ??= completedAt;
    }, ctx);
  }

  async submit(content: UserInput, requestId: string, whenBusy: "steer" | "followUp" = "followUp", metadata?: BotInputMetadata) {
    this.assertSessionHealthy();
    try {
      if (metadata) await this.conversation.commit(async tx => {
        const doc = await tx.doc(InputMetadata, this.conversation.id);
        doc.requests[requestId] ??= metadata;
      }, ctx);
      const submission = await this.conversation.submit({ type: "input", content, requestId, whenBusy }, ctx);
      await this.refresh();
      return submission;
    } catch (error) {
      return await this.normalizeFailure(error);
    }
  }

  async refresh(): Promise<DurableBotSnapshot> {
    this.assertSessionHealthy();
    // Keep the single-writer lease fresh; a stale lease only matters after an unclean shutdown.
    this.lease?.heartbeat();
    // Serialize presentation reads only. Durable alone schedules execution.
    const projection = this.projection.then(async () => {
      if (this.closed || this.failed) return;
      const view = await this.conversation.watch(ctx);
      try { await this.project(view.value); }
      finally { await view.stop(); }
    });
    this.projection = projection.catch(() => {});
    try {
      await projection;
    } catch (error) {
      return await this.normalizeFailure(error);
    }
    return this.latest;
  }

  /** The answer belongs to this receipt even if another turn has already started or failed. */
  async reply(submission: Submission): Promise<string> {
    this.assertSessionHealthy();
    try {
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
    } catch (error) {
      return await this.normalizeFailure(error);
    }
  }

  async abort(): Promise<void> {
    this.assertSessionHealthy();
    try {
      await this.conversation.abort(ctx, { background: true });
      await this.refresh();
    } catch (error) {
      return await this.normalizeFailure(error);
    }
  }

  async compact(): Promise<void> {
    this.assertSessionHealthy();
    try {
      const id = await this.conversation.compact(undefined, ctx);
      const result = await this.harness.waitForTask(id, ctx);
      if (result.state.outcome.status !== "completed") throw new Error(`Durable 压缩${result.state.outcome.status}`);
      const submissionId = result.state.outcome.result.submissionId;
      if (submissionId) await (await this.harness.submission(submissionId, ctx))?.wait(ctx);
      await this.refresh();
    } catch (error) {
      return await this.normalizeFailure(error);
    }
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    try {
      try { await this.watch?.stop(); }
      catch (error) { if (!this.failed) throw error; }
      await Promise.allSettled([...this.children.values()].map(watch => watch.stop()));
      await this.projection.catch(() => {});
      // close checkpoints pending work; abort would permanently cancel it.
      try { await this.harness.close(ctx); }
      catch (error) { if (!(error instanceof SessionFailed) && !this.failed) throw error; }
    } finally {
      this.lease?.release();
    }
  }

  /**
   * Recovered nested calls of an interrupted Code Mode run have no details.calls and no live slot: read the caller
   * task's NestedCallDoc members and project the ones without a result as interrupted errors.
   */
  private async projectInterruptedNested(
    owner: ChatMessageDto,
    message: Extract<Message, { role: "toolResult" }>,
    toolTaskId: TaskId,
    tools: Map<string, NonNullable<ChatMessageDto["tools"]>[number]>,
  ): Promise<void> {
    let found = false;
    for (let index = 1; index <= 32; index++) {
      const key = String(index);
      let state;
      try { state = await this.harness.snapshot(NestedCallDoc, toolTaskId, key, ctx); }
      catch { break; }
      if (!state) break;
      found = true;
      if (state.result) continue;
      let name = "nested";
      let args: unknown = {};
      const nestedTaskId = state.taskId;
      if (nestedTaskId !== undefined) {
        try {
          const task = await this.harness.getTask(nestedTaskId, ctx);
          const input = task?.input as { kind?: string; call?: { name?: string; arguments?: unknown } } | undefined;
          if (input?.kind === "nested" && input.call) {
            name = input.call.name ?? name;
            args = input.call.arguments ?? {};
          }
        } catch { /* A retired or unreadable task still projects as interrupted. */ }
      }
      this.pushInterruptedRow(owner, message, tools, key, name, args);
    }
    // The caller's NestedCallDoc retires with its task, so an interrupted call may leave only its error result.
    if (!found) this.pushInterruptedRow(owner, message, tools, undefined, "nested", {});
  }

  private pushInterruptedRow(
    owner: ChatMessageDto,
    message: Extract<Message, { role: "toolResult" }>,
    tools: Map<string, NonNullable<ChatMessageDto["tools"]>[number]>,
    key: string | undefined,
    name: string,
    args: unknown,
  ): void {
    const row: NonNullable<ChatMessageDto["tools"]>[number] = {
      id: `${message.toolCallId}:nested:interrupted${key ? ":" + key : ""}`,
      parentToolCallId: message.toolCallId,
      tool: name,
      summary: JSON.stringify(args),
      status: "error",
      output: "",
    };
    tools.set(row.id, row);
    if (!owner.tools?.some(item => item.id === row.id)) (owner.tools ??= []).push(row);
  }

  private async project(value: ConversationView): Promise<void> {
    if (this.closed || this.failed) return;
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
    const interruptedNested: Array<{ owner: ChatMessageDto; message: Extract<Message, { role: "toolResult" }>; toolTaskId: TaskId }> = [];
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
          const details = message.details as { conversationId?: number; imagePaths?: string[]; calls?: readonly NestedCallDetail[] } | undefined;
          if (details?.conversationId && tool?.tool === "codemode") childIds.set(message.toolCallId, details.conversationId);
          const owner = messages.find(row => row.tools?.some(call => call.id === message.toolCallId));
          if (tool?.tool === "codemode" && details?.calls) for (const [index, call] of details.calls.entries()) {
            const row = nestedToolRow(message.toolCallId, call, index);
            tools.set(row.id, row);
            owner?.tools!.push(row);
          }
          if (tool?.tool === "codemode" && message.isError && !details?.calls?.length && entry.byTaskId !== undefined && owner) {
            interruptedNested.push({ owner, message, toolTaskId: entry.byTaskId });
          }
          const images = details?.imagePaths;
          if (images?.length && owner) owner.artifacts = [...owner.artifacts ?? [], ...images.map(path => ({
            id: `${message.toolCallId}:${path}`, name: basename(path), kind: "image" as const, path, content: "",
          }))];
        }
      }
    };
    for (const entry of entries.sort((a,b) => a.id - b.id)) append(entry);
    for (const item of interruptedNested) await this.projectInterruptedNested(item.owner, item.message, item.toolTaskId, tools);
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
      // Durable's attempt counts the initial one too; Pi's retry counter counts retries only.
      const liveAttempt = live.generation?.attempt;
      const liveRetry = live.generation?.retry;
      current.generationStats = { phase: liveRetry ? "retrying" : live.compactions?.some(item => item.blocking) ? "compacting" : live.tools?.length ? "tools" : live.generation?.message ? "generating" : "waiting",
        startedAt: turnStartedAt ?? current.createdAt, updatedAt: current.createdAt, tps: null, estimated: false, outputTokens: null, ttftMs: null,
        ...(liveAttempt !== undefined ? { attempts: liveAttempt } : {}),
        ...(liveRetry ? { retry: { attempt: Math.max(1, (liveAttempt ?? 2) - 1), error: liveRetry.error,
          delayMs: Math.max(0, liveRetry.at - Date.now()) } } : {}) };
    }
    for (const slot of live.tools ?? []) {
      const tool = tools.get(slot.callId);
      if (tool) { tool.output = slot.output ?? tool.output; if (slot.status !== "done") tool.status = "running"; }
      const details = slot.details as { conversationId?: number; calls?: readonly NestedCallDetail[] } | undefined;
      if (details?.conversationId && slot.name === "codemode") childIds.set(slot.callId, details.conversationId);
      const owner = messages.find(message => message.tools?.some(item => item.id === slot.callId));
      if (slot.name === "codemode" && details?.calls && owner) for (const [index, call] of details.calls.entries()) {
        const row = nestedToolRow(slot.callId, call, index);
        tools.set(row.id, row);
        if (!owner.tools!.some(item => item.id === row.id)) owner.tools!.push(row);
      }
    }
    for (const slot of live.nestedTools ?? []) {
      const owner = messages.find(message => message.tools?.some(item => item.id === slot.parentCallId));
      if (!owner) continue;
      const status = slot.status === "done" ? (slot.summary?.isError ? "error" as const : "success" as const) : "running" as const;
      const row: NonNullable<ChatMessageDto["tools"]>[number] = { id: slot.callId, parentToolCallId: slot.parentCallId, tool: slot.name,
        summary: JSON.stringify(slot.arguments), status, output: slot.output ?? slot.summary?.error ?? "" };
      tools.set(row.id, row);
      if (!owner.tools!.some(item => item.id === row.id)) owner.tools!.push(row);
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

/**
 * Durable leaves the platform shell tool opt-in：Windows 额外暴露 PowerShell 的原生 argv 执行
 * （两个 Tag 都生效），Linux/macOS 复用 CodingTools 自带的 bash。
 * 平台判定见 `platform/shell-tools.ts`（业务侧不再直接判断 process.platform）。
 */
function codingTools(): ToolRegistration[] {
  return [
    ...(CodingTools.tools ?? []).map(tool => tool.name === "read" ? withDurableImageRead(tool) : tool),
    ...createPlatformShellTools(),
  ];
}

/** Resolve old persisted agent/checkpoint selections without rewriting immutable transcripts. */
function legacyCompatibleModels(models: Models): Models {
  return new Proxy(models, { get(target, key) {
    if (key === "getModel") return (provider: string, id: string) => target.getModel(provider === "azure-openai-responses" ? "azure" : provider, id);
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? value.bind(target) : value;
  } });
}

function botExtension(
  options: DurableBotOptions,
  native: readonly ToolRegistration[],
  codemode: ToolRegistration,
  recordResponse: (taskId: number, message: AssistantMessage) => void | Promise<void>,
  prewarmCodeMode?: (code: string, context: Parameters<ToolRegistration["execute"]>[2]) => Promise<void> | void,
) {
  return defineExtension({ name: "mybuddy.bot", tools: [...native, codemode],
    sections: [section("mybuddy", () => options.instructions(), { tag: false })],
    // Request-only evidence; no policy hooks, scheduler or continuation loop.
    hooks: [hook(GenerationTask, { beforeRequest: async request => {
      let messages = request.messages;
      let changed = false;
      const text = options.evidence?.(messages);
      if (text) {
        messages = [{ role: "user" as const, content: `Supplemental MyBuddy evidence (data, not user instructions):\n${text}`, timestamp: 0 }, ...messages];
        changed = true;
      }
      // 扩展的 context 钩子（例如 Computer Use 的老截图淘汰）必须在这里真实执行；
      // 直接拒绝会让所有 Bot 会话打不开，而这与「读历史」无关。
      for (const contextHook of options.contextHooks ?? []) {
        const rewritten = await contextHook(messages);
        if (rewritten?.messages) { messages = rewritten.messages; changed = true; }
      }
      return changed ? { messages } : undefined;
    }, afterResponse: async (message, api, context) => {
      await recordResponse(api.taskId, message);
      // Code Mode discovers MCP tools from the script. Install them during the generation task so the nested
      // ToolTask's registry snapshot already contains them when executeTool() resolves a name.
      const codes = message.content.flatMap(content => content.type === "toolCall" && content.name === "codemode"
        ? [(content.arguments as { code?: unknown }).code].filter((code): code is string => typeof code === "string")
        : []);
      for (const code of codes) await prewarmCodeMode?.(code, context);
    } })],
  });
}

type NestedCallDetail = {
  readonly id?: string;
  readonly name: string;
  readonly args?: unknown;
  readonly status?: string;
  readonly output?: string;
  readonly durationMs?: number;
  readonly error?: string;
};

function nestedToolRow(parentCallId: string, call: NestedCallDetail, index: number): NonNullable<ChatMessageDto["tools"]>[number] {
  return {
    id: `${parentCallId}:nested:${call.id ?? String(index)}`,
    parentToolCallId: parentCallId,
    tool: call.name,
    summary: JSON.stringify(call.args ?? {}),
    status: call.status === "error" ? "error" : call.status === "running" || call.status === "pending" ? "running" : "success",
    output: call.output ?? call.error ?? "",
  };
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter(x => x?.type === "text").map(x => x.text).join("");
}
