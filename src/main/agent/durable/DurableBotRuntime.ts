import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { BACKGROUND_CONTEXT as ctx } from "@earendil-works/chord/context";
import type { Models, Message, AssistantMessage } from "@earendil-works/pi-ai";
import {
  Harness, SessionFailed, StorageRequestError, NestedCallDoc, createRegistry, defineExtension, section, AgentDoc, LiveDoc, hook, CompactionTask, GenerationTask, ToolTask, defineDoc,
  type Conversation, type ConversationWatch, type ConversationView, type EntryRecord,
  type LiveState, type InboxState, type Storage, type TaskId, type ToolRegistration, type UserInput, type Cursor, type UsageState, type Submission, type ToolHooks, type EntryId, type HookApi,
} from "@earendil-works/pi-durable";
import { CodingTools } from "@earendil-works/pi-durable/tools";
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import type { CodemodeSandboxOptions } from "@earendil-works/pi-codemode";
import type { ChatMessageDto } from "../../../shared/agent-ipc";
import { summarizeToolInput } from "../../../shared/pi-event-mapper";
import type { BotToolMode, DurableBotSnapshot, DurableHistoryBlock } from "../../../shared/durable-bot";
import { createDurableCodeMode } from "./DurableCodeMode";
import { seedDurableBranch, type DurableBranchSeed } from "./DurableTaskBranch";
import type { DurableLogRepairReport } from "./DurableLogRepair";
import type { DurableContextHook } from "./DurableDomainTools";
import { openDurableStorage } from "./DurableStorage";
import type { DurableStorageLease } from "./DurableStorageLease";
import { durableCompletedTurns } from "./DurableTurnProjection";
import { withDurableImageRead } from "./DurableImages";
import { createAgentSettingsManager, getAgentBashShellPath } from "../../agent-shell-settings";
import { getMyBuddyDir } from "../../paths";
import { createPlatformShellTools } from "../../platform/shell-tools";
import { DurableHistoryProjection, assistantRow, nestedToolRow, durableContentText as contentText, type NestedCallDetail, type DurableInputMetadata } from "./DurableHistoryProjection";
import { identifyModelInvocation, requestTraceBoundary, setRequestTraceBoundary, withModelInvocationSettings } from "../ModelInvocationAdmission";
import type { CacheTraceBoundary, CacheTraceOperation } from "../CacheRequestTracer";
import { DurableSubagentIdentity, resolveDurableExecutionCwd } from "./DurableSubagents";
import { DurableEvidenceProjection, type DurableEvidenceOptions } from "./DurableEvidenceProjection";
import { ActiveDurableConversation, forkDurableConversation, resolveActiveDurableConversation, type DurableRegenerationInput, type DurableRegenerationState } from "./DurableConversationBranch";
import { DurableConsultIdentity } from "./DurableConsultSession";
import type { DiagnosticSource, ToolDiagnosticEvent } from "../../../shared/task-diagnostics";
import { durableInputAuditSchema, type DurableInputAudit } from "./DurableSkillProjection";
import { mergeContextUsage } from "../../usage/context-usage-merge";
import { GenerationTiming, generationContentTokens } from "../../usage/generation-timing";

type BotInputMetadata = DurableInputMetadata;
const AuditReceipts = defineDoc({ kind: "mybuddy.audit-receipts", version: 1, scope: "conversation", history: "latest", fork: "current", checkpointWhen: () => false,
  initial: () => ({ settled: {} as Record<string, number> }),
});

// Display telemetry lives with Durable, never in the task scheduler or renderer clock.
// `completed` keeps the completion clock (durationMs); `speed` keeps the host-measured generation speed
// (tps/ttftMs), keyed by the same `${taskId}:${message.timestamp}` identity.
const ResponseTiming = defineDoc({ kind: "mybuddy.response-timing", version: 1, scope: "conversation", history: "latest", fork: "current", checkpointWhen: () => false,
  initial: () => ({ completed: {} as Record<string, number>, speed: {} as Record<string, { tps: number | null; ttftMs: number | null }> }),
});

export interface DurableBotOptions {
  directory: string;
  cwd: string;
  models: Models;
  model?: { provider: string; modelId: string };
  toolMode: BotToolMode;
  instructions: () => string;
  evidence?: (messages: readonly Message[]) => string;
  evidenceProjection?: DurableEvidenceOptions;
  onResponse?: (message: AssistantMessage, identity: { conversationId: string; generationTaskId: number; sourceKind: "main" | "subagent" }) => void;
  onRequest?: (identity: { conversationId: string; generationTaskId: number; sourceKind: "main" | "subagent" }) => void;
  executionIdentity?: { taskId?: string; sourceKind: DiagnosticSource; executionScope: string };
  onTool?: (event: ToolDiagnosticEvent) => void;
  observedUsage?: (conversationId: string) => { inputTokens: number | null; outputTokens: number | null; cacheReadTokens: number | null; cacheHitRate: number | null };
  initialHistory?: { messages: readonly Message[]; context: readonly Message[] } | (() => Promise<{ messages: readonly Message[]; context: readonly Message[] } | undefined>);
  initialBranch?: DurableBranchSeed;
  toolHooks?: Partial<ToolHooks>;
  toolAllowed?: (name: string) => boolean;
  waitingForInput?: () => boolean;
  onTurns?: (turns: ReturnType<typeof durableCompletedTurns>) => void;
  onEntries?: (entries: readonly EntryRecord[], identity: { conversationId: string; sourceKind: "main" | "subagent" }) => void;
  projectionAfterEntryId?: number;
  taskId?: string;
  tools?: readonly ToolRegistration[];
  /** 扩展的 context 钩子（改写每次请求的上下文）；在 beforeRequest 里与 evidence 一起执行。 */
  contextHooks?: readonly DurableContextHook[];
  /** Task-scoped compatibility registrations for stored names, without transport startup. */
  restoreTools?: (names: readonly string[]) => readonly ToolRegistration[];
  prepareCodeMode?: (code: string, context: Parameters<ToolRegistration["execute"]>[2]) => Promise<readonly ToolRegistration[]>;
  assets?: Pick<CodemodeSandboxOptions, "wasm" | "workerUrl">;
  onSnapshot: (snapshot: DurableBotSnapshot) => void;
  onProjected?: (snapshot: DurableBotSnapshot) => void;
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
  private readonly history = new DurableHistoryProjection();
  private historyBefore?: EntryId;
  private readonly metadataByEntry = new Map<number, BotInputMetadata>();
  private readonly pendingAuditInputs = new Map<string, DurableInputAudit>();
  private readonly nestedHistory = new Map<number, { entries: EntryRecord[]; newest?: EntryId }>();
  private pendingTurnEntries: EntryRecord[] = [];
  private consumerCursor?: number;
  private contextTokens: number | null = null;
  /** Host-side stream clocks, one per live generation task; pi's `LiveState.generation` carries no timestamps. */
  private readonly generationTimings = new Map<number, { attempt: number; timing: GenerationTiming }>();
  private evidence?: DurableEvidenceProjection;
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
    options = { ...options, models: taskScopedModels(options.models, options.cwd) };
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
    const codemode = createDurableCodeMode(() => native.filter(tool => options.toolAllowed?.(tool.name) !== false), options.assets, join(options.directory, "images"), async (code, context) => {
      const tools = await options.prepareCodeMode?.(code, context) ?? [];
      runtime?.installCompatibility(tools);
      return tools;
    });
    let runtime: DurableBotRuntime | undefined;
    // Recovered generations may enter their hook while the host is still opening.
    let finishOpening!: (projection: DurableEvidenceProjection | undefined) => void;
    const openingEvidence = new Promise<DurableEvidenceProjection | undefined>(resolve => { finishOpening = resolve; });
    registry.install(botExtension(options, native, codemode, (id, message) => runtime?.recordResponse(id, message),
      (code, context, conversationId) => runtime?.prewarmCodeMode(code, context, conversationId), () => options.evidenceProjection ? openingEvidence : undefined, (call, api, context) => runtime?.recordSkillRead(call, api, context)));
    let harness: Harness | undefined;
    try {
      harness = await Harness.open(storage, {
        models: options.models, registry,
        env: async (target, context) => {
          const cwd = await resolveDurableExecutionCwd(target, context, options.cwd);
          if (!statSync(cwd).isDirectory()) throw new Error("任务工作目录失效，请修复项目目录后继续");
          return new NodeExecutionEnv({ cwd, shellPath: getAgentBashShellPath(cwd, getMyBuddyDir()) });
        },
      }, ctx);
      const root = await harness.root(ctx, { agent: { cwd: options.cwd, model: options.model },
        init: async (tx, id) => {
          if (options.initialBranch) return;
          const initialHistory = typeof options.initialHistory === "function" ? await options.initialHistory() : options.initialHistory;
          for (const message of initialHistory?.messages ?? []) await tx.appendEntry(id, {
            kind: message.role === "user" ? "pi.user" : message.role === "assistant" ? "pi.assistant" : "pi.tool-result", model: [message], data: { mybuddyImported: true },
          });
          if (initialHistory?.context.length) await tx.appendEntry(id, { kind: "mybuddy.context-import", head: "self", model: [...initialHistory.context] });
        },
      });
      if (options.initialBranch) await seedDurableBranch(root, options.initialBranch);
      const conversation = await resolveActiveDurableConversation(harness, root, ctx);
      runtime = new DurableBotRuntime(harness, conversation, options);
      if (options.evidenceProjection) runtime.evidence = new DurableEvidenceProjection(options.evidenceProjection, conversation, options.models);
      runtime.storage = storage;
      runtime.lease = handle?.lease;
      runtime.repaired = handle?.repair;
      runtime.registry = registry;
      runtime.nativeTools = native;
      runtime.compatibilityTools = compatibility;
      runtime.codemode = codemode;
      const bound = await conversation.agent(ctx);
      if (bound.cwd && resolve(bound.cwd) !== resolve(options.cwd)) throw new Error("Bot 已绑定的工作目录与当前项目不一致");
      finishOpening(runtime.evidence);
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
      await runtime.replayChildUsage();
      await runtime.resumeRegeneration();
      return runtime;
    } catch (error) {
      finishOpening(undefined);
      if (harness) await harness.close(ctx); else await storage.close(ctx);
      handle?.lease.release();
      throw error;
    }
  }

  async configure(model: DurableBotOptions["model"], toolMode: BotToolMode, thinkingLevel?: import("@earendil-works/pi-ai").ModelThinkingLevel,
    extensions?: readonly ToolRegistration[], contextHooks?: readonly DurableContextHook[], toolHooks?: Partial<ToolHooks>): Promise<void> {
    this.assertSessionHealthy();
    // Request-context hooks come from the same extension factories as the tools; they are re-installed
    // together so a refreshed tool set can never keep a stale (or dropped) context rewrite.
    if (contextHooks) this.options.contextHooks = [...contextHooks];
    if (toolHooks) this.options.toolHooks = toolHooks;
    if (extensions || contextHooks) {
      if (extensions) this.nativeTools = [...codingTools(), ...extensions];
      const available = this.nativeTools;
      this.codemode = createDurableCodeMode(() => available.filter(tool => this.options.toolAllowed?.(tool.name) !== false), this.options.assets, join(this.options.directory, "images"), async (code, context) => {
        const tools = await this.options.prepareCodeMode?.(code, context) ?? [];
        this.installCompatibility(tools);
        return tools;
      });
      // Retain implementations referenced by old in-flight phase agents, without declaring them
      // to new turns. Durable still decides whether an interrupted external call may replay.
      const names = new Set(available.map(tool => tool.name));
      const registered = [...available, ...this.compatibilityTools.filter(tool => !names.has(tool.name))];
      this.registry.install(botExtension(this.options, registered, this.codemode, (id, message) => this.recordResponse(id, message),
        (code, context, conversationId) => this.prewarmCodeMode(code, context, conversationId), () => this.evidence, (call, api, context) => this.recordSkillRead(call, api, context)));
    }
    this.options.toolMode = toolMode;
    await this.conversation.configure({
      ...(model ? { model } : {}), ...(thinkingLevel ? { thinkingLevel } : {}),
      tools: [...this.nativeTools.filter(tool => this.options.toolAllowed?.(tool.name) !== false), ...(toolMode === "codemode" ? [this.codemode] : [])],
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
      (code, context, conversationId) => this.prewarmCodeMode(code, context, conversationId), () => this.evidence, (call, api, context) => this.recordSkillRead(call, api, context)));
  }
  /** Install Code Mode's dynamically discovered tools before the nested ToolTask freezes its registry snapshot. */
  private async prewarmCodeMode(code: string, context: Parameters<ToolRegistration["execute"]>[2], conversationId = this.conversation.id): Promise<void> {
    const tools = await this.options.prepareCodeMode?.(code, context) ?? [];
    if (!tools.length) return;
    this.installCompatibility(tools);
    const conversation = conversationId === this.conversation.id ? this.conversation : await this.harness.conversation(conversationId, context);
    if (!conversation) throw new Error("Code Mode conversation is unavailable");
    const agent = await conversation.agent(context);
    const callable = new Map([...agent.callable, ...agent.tools].map(tool => [tool.name, tool]));
    for (const tool of tools) if (this.options.toolAllowed?.(tool.name) !== false) callable.set(tool.name, tool);
    await conversation.configure({ tools: [...callable.values()] }, context);
  }

  get snapshot(): DurableBotSnapshot { return this.latest; }
  inputMetadata(entryId: number): DurableInputMetadata | undefined { return this.metadataByEntry.get(entryId); }

  /** Query native state before changing a task identity; UI idle alone is not a boundary. */
  async isIdle(): Promise<boolean> {
    const snapshot = await this.refresh();
    return !snapshot.busy && snapshot.queued === 0;
  }

  /**
   * Every terminal provider message: keep its completion clock and, when the stream was observed,
   * settle the host-side generation clock with the authoritative `usage.output`.
   * pi never timestamps `LiveState.generation`, so this observed stream is the only real speed source.
   */
  private async recordResponse(taskId: number, message: AssistantMessage): Promise<void> {
    const completedAt = Date.now();
    const metrics = this.generationTimings.get(taskId)?.timing.finalize(message.usage?.output ?? 0, completedAt);
    this.generationTimings.delete(taskId);
    await this.conversation.commit(async tx => {
      const timing = await tx.doc(ResponseTiming, this.conversation.id);
      const key = `${taskId}:${message.timestamp}`;
      timing.completed[key] ??= completedAt;
      // Nothing measured (never observed, or a failed attempt with no output) → keep the doc honest.
      if (!metrics || (metrics.tps === null && metrics.ttftMs === null)) return;
      timing.speed ??= {};
      // A retried attempt appends its own message with its own timestamp, so this write replaces only
      // a replay of the same terminal message.
      timing.speed[key] = { tps: metrics.tps, ttftMs: metrics.ttftMs };
    }, ctx);
  }

  /**
   * Feed one observed live generation. A generation appears before pi requests the provider
   * (`live.generation = { attempt }`), then its throttled partial arrives on later commits;
   * a retried attempt bumps `attempt`, which restarts the clock.
   */
  private observeGeneration(taskId: number, attempt: number, message: AssistantMessage | undefined, now: number): { attempt: number; timing: GenerationTiming } {
    let entry = this.generationTimings.get(taskId);
    if (!entry || entry.attempt !== attempt) {
      entry = { attempt, timing: new GenerationTiming(now) };
      this.generationTimings.set(taskId, entry);
      // Timings of tasks whose terminal response never reached afterResponse (abort/fault) must not accumulate.
      if (this.generationTimings.size > 4) for (const id of [...this.generationTimings.keys()]) if (id !== taskId) this.generationTimings.delete(id);
    }
    if (message) entry.timing.observe(generationContentTokens(message.content), now);
    return entry;
  }

  private async recordSkillRead(call: Parameters<ToolHooks["afterTool"]>[0], api: HookApi, context: Parameters<ToolRegistration["execute"]>[2]): Promise<void> {
    if (typeof call.arguments.path !== "string") return;
    const path = call.arguments.path;
    const live = await api.snapshot(LiveDoc, api.conversationId, context);
    const userMessageIds: string[] = [];
    for (const id of live?.run?.inputs ?? []) {
      const receipt = await this.storage.submission(id, context);
      const entry = receipt?.entry && await api.entry(receipt.entry, context);
      const data = entry && entry.data;
      const input = data && typeof data === "object" && !Array.isArray(data) ? data.mybuddyInput : undefined;
      const audit = input && typeof input === "object" && !Array.isArray(input) ? durableInputAuditSchema.safeParse(input.audit) : undefined;
      if (audit?.success) userMessageIds.push(audit.data.userMessageId);
    }
    if (!userMessageIds.length) return;
    const conversation = await this.harness.conversation(api.conversationId, context);
    if (conversation) await conversation.commit(tx => tx.appendEntry(api.conversationId, { kind: "mybuddy.skill-read",
      data: { callId: call.id, path, userMessageIds, at: Date.now() } }), context);
  }

  private async reconcileAuditReceipts(): Promise<void> {
    for (const [requestId, audit] of this.pendingAuditInputs) {
      const receipt = await this.storage.submissionByRequest(this.conversation.id, requestId, ctx);
      if (!receipt || (receipt.status !== "done" && receipt.status !== "unanswered")) continue;
      const outcome = receipt.status === "done" ? "completed" : receipt.reason === "aborted" ? "aborted" : "failed";
      await this.conversation.commit(async tx => {
        const state = await tx.doc(AuditReceipts, this.conversation.id);
        if (state.settled[requestId] !== undefined) return;
        const stored = await tx.appendEntry(this.conversation.id, { kind: "mybuddy.input-outcome",
          data: { userMessageId: requestId, assistantMessageId: audit.assistantMessageId, outcome, at: Date.now() } });
        state.settled[requestId] = stored.id;
      }, ctx);
      // The watch consumes this marker after all earlier read evidence. Receipt state may be newer than this view.
      this.pendingAuditInputs.delete(requestId);
    }
  }

  async submit(content: UserInput, requestId: string, whenBusy: "steer" | "followUp" = "followUp", metadata?: BotInputMetadata) {
    this.assertSessionHealthy();
    try {
      const submission = await this.conversation.submit({ type: "input", content, requestId, whenBusy,
        ...(metadata ? { entry: { kind: "mybuddy.user", data: { mybuddyInput: metadata } } } : {}),
      }, ctx);
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
      await this.project(this.watch.value);
    });
    this.projection = projection.catch(() => {});
    try {
      await projection;
    } catch (error) {
      return await this.normalizeFailure(error);
    }
    return this.latest;
  }

  /**
   * 读取一段更早历史的独立块（不改变实时窗口，也不写 latest）。
   *
   * 一页 50 条 entry 里可能有 0 条可见消息（toolResult / context-import / skill-read 都不产行），
   * 所以空页时继续向前读，最多 4 轮；扫到最老仍为空则返回空块与 before=undefined。
   */
  async loadHistoryBlock(beforeEntryId: number, limit = 50): Promise<DurableHistoryBlock> {
    if (!Number.isSafeInteger(beforeEntryId) || beforeEntryId < 1) throw new Error("Invalid history cursor");
    const size = Math.max(1, Math.min(200, Math.floor(limit)));
    await this.projection;
    const metadata = new Map<number, BotInputMetadata>();
    const timing = await this.harness.snapshot(ResponseTiming, this.conversation.id, ctx);
    const history = new DurableHistoryProjection();
    let before: number | undefined = beforeEntryId;
    for (let round = 0; round < 4 && before !== undefined; round++) {
      const page = await this.conversation.entries({ maxEntryId: before as EntryId, order: "descending" }, size + 1, undefined, ctx);
      const entries = page.items.slice(0, size).filter(entry => entry.kind !== "mybuddy.context-import");
      await this.loadInputMetadata(entries, metadata);
      history.merge(entries, metadata, timing?.completed ?? {}, timing?.speed ?? {});
      before = page.items[size]?.id;
      if (history.messages.length) break;
    }
    // 工具结果可能位于块之后，只补齐对应调用，不引入其他消息。
    const unresolved = new Set(history.messages.flatMap(row => (row.tools ?? []).filter(tool => tool.status === "running").map(tool => tool.id)));
    let cursor: Cursor | undefined;
    while (unresolved.size) {
      const later = await this.conversation.entries({ minEntryId: (beforeEntryId + 1) as EntryId, order: "ascending" }, 100, cursor, ctx);
      for (const entry of later.items) {
        const results = entry.model?.filter(message => message.role === "toolResult" && unresolved.has(message.toolCallId));
        if (results?.length) {
          history.merge([{ ...entry, model: results }], metadata, {});
          for (const message of results) if (message.role === "toolResult") unresolved.delete(message.toolCallId);
        }
      }
      if (!later.next) break;
      cursor = later.next;
    }
    return { epoch: this.epoch, before, messages: history.messages };
  }

  /** The service releases and reopens after this atomic branch switch. */
  async forkAt(entryId?: number): Promise<string> {
    if (entryId !== undefined && (!Number.isSafeInteger(entryId) || entryId < 1)) throw new Error("Invalid conversation entry");
    return String((await forkDurableConversation(this.harness, this.conversation, entryId as EntryId | undefined, ctx)).id);
  }

  async regeneration(): Promise<DurableRegenerationState | undefined> {
    return (await this.harness.snapshot(ActiveDurableConversation, ctx))?.regeneration;
  }

  private async replayChildUsage(): Promise<void> {
    if (!this.options.onEntries) return;
    try {
      let cursor: Cursor | undefined;
      do {
        const page = await this.storage.scanConversations({}, 100, cursor, ctx);
        for (const record of page.items) {
          if (!(await this.harness.snapshot(DurableSubagentIdentity, record.id, ctx))?.value && !(await this.harness.snapshot(DurableConsultIdentity, record.id, ctx))?.key) continue;
          const conversation = await this.harness.conversation(record.id, ctx);
          if (!conversation) continue;
          let next: Cursor | undefined;
          do {
            const entries = await conversation.entries({ order: "ascending" }, 500, next, ctx);
            this.options.onEntries(entries.items.filter(entry => entry.byTaskId !== undefined), { conversationId: String(record.id), sourceKind: "subagent" });
            next = entries.next;
          } while (next);
        }
        cursor = page.next;
      } while (cursor);
    } catch (error) { console.warn("[Durable] Child usage recovery failed", error); }
  }

  /** Native fork and the prepared input persist together; reopening admits the input once. */
  async forkForRegeneration(entryId: number | undefined, input: DurableRegenerationInput): Promise<string> {
    if (!input.operationId.trim()) throw new Error("重新生成缺少操作身份");
    if (entryId !== undefined && (!Number.isSafeInteger(entryId) || entryId < 1)) throw new Error("Invalid conversation entry");
    return String((await forkDurableConversation(this.harness, this.conversation, entryId as EntryId | undefined, ctx, input)).id);
  }

  /** Only submission admission is retried, under the original request ID; execution remains native. */
  async resumeRegeneration(): Promise<Submission | undefined> {
    const state = await this.regeneration();
    if (!state) return undefined;
    if (state.kind === "admitted") return this.harness.submission(state.submissionId, ctx);
    const input = state.input;
    const submissionId = await this.conversation.commit(async tx => {
      const active = await tx.doc(ActiveDurableConversation);
      if (active.conversationId !== this.conversation.id || active.regeneration?.kind !== "pending" || active.regeneration.input.operationId !== input.operationId) throw new Error("重新生成输入归属已变化");
      const id = await this.conversation.submit(tx, { type: "input", content: input.content, requestId: input.operationId,
        ...(input.metadata ? { entry: { kind: "mybuddy.user", data: { mybuddyInput: input.metadata } } } : {}),
      });
      active.regeneration = { kind: "admitted", operationId: input.operationId, submissionId: id };
      return id;
    }, ctx);
    const submission = await this.harness.submission(submissionId, ctx);
    if (!submission) throw new Error("重新生成回执不存在");
    await this.refresh();
    return submission;
  }

  private async loadInputMetadata(entries: readonly EntryRecord[], target = this.metadataByEntry): Promise<void> {
    for (const entry of entries) {
      const data = entry.data;
      const input = data && typeof data === "object" && !Array.isArray(data) ? data.mybuddyInput : undefined;
      if (!input || typeof input !== "object" || Array.isArray(input)
        || typeof input.text !== "string" || typeof input.displayText !== "string" || !Array.isArray(input.attachments)) continue;
      const attachments = input.attachments.flatMap(item => item && typeof item === "object" && !Array.isArray(item)
        && typeof item.name === "string" && typeof item.path === "string" ? [{ name: item.name, path: item.path }] : []);
      const audit = durableInputAuditSchema.safeParse(input.audit);
      target.set(entry.id, { text: input.text, displayText: input.displayText, attachments, ...(audit.success ? { audit: audit.data } : {}) });
    }
  }

  private async consumerEntries(value: ConversationView, fresh: readonly EntryRecord[]): Promise<EntryRecord[]> {
    if (!this.options.onEntries && !this.options.onTurns) return [];
    const tail = value.entries.at(-1)?.id;
    if (tail === undefined) return [];
    let entries: EntryRecord[];
    if (this.consumerCursor === undefined) {
      // Projection checkpoints can lag a crash. Catch up consumers once without expanding the visible window.
      entries = [];
      let cursor: Cursor | undefined;
      do {
        const page = await this.conversation.entries({ minEntryId: ((this.options.projectionAfterEntryId ?? 0) + 1) as EntryId, maxEntryId: tail, order: "ascending" }, 500, cursor, ctx);
        entries.push(...page.items); cursor = page.next;
      } while (cursor);
    } else entries = fresh.filter(entry => entry.id > this.consumerCursor!);
    this.consumerCursor = tail;
    return entries.filter(entry => entry.kind !== "mybuddy.context-import"
      && (!entry.data || typeof entry.data !== "object" || Array.isArray(entry.data) || (entry.data.mybuddyImported !== true && entry.data.inherited !== true)));
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

  async abortCompaction(): Promise<boolean> {
    this.assertSessionHealthy();
    const live = await this.harness.snapshot(LiveDoc, this.conversation.id, ctx);
    const manual = live?.compactions?.filter(compaction => compaction.trigger === "manual") ?? [];
    for (const compaction of manual) await this.harness.abortTask(compaction.taskId, ctx);
    await this.refresh();
    return manual.length > 0;
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
      this.evidence?.dispose();
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
      summary: summarizeToolInput(name, args).summary,
      status: "error",
      output: "",
    };
    tools.set(row.id, row);
    if (!owner.tools?.some(item => item.id === row.id)) (owner.tools ??= []).push(row);
  }

  private async project(value: ConversationView): Promise<void> {
    if (this.closed || this.failed) return;
    // One observation clock for this revision: the same `now` feeds the stream clocks and the retry countdown.
    const now = Date.now();
    const entries = value.entries.filter(entry => entry.kind !== "mybuddy.context-import");
    if (this.history.oldest === undefined || !Number.isFinite(this.history.oldest)) this.historyBefore = value.before;
    // A stalled observer may receive a window beyond the last delivered entry. Fill only that gap.
    const newest = this.history.newest;
    if (newest !== undefined && value.before !== undefined && value.before > newest) {
      let cursor: Cursor | undefined;
      do {
        const page = await this.conversation.entries({ minEntryId: (newest + 1) as EntryId, maxEntryId: value.before, order: "ascending" }, 100, cursor, ctx);
        entries.unshift(...page.items.filter(entry => entry.kind !== "mybuddy.context-import")); cursor = page.next;
      } while (cursor);
    }
    const live = (value.docs["pi.live"] ?? {}) as LiveState;
    const timing = entries.some(entry => !this.history.has(entry.id)) ? await this.harness.snapshot(ResponseTiming, this.conversation.id, ctx) : undefined;
    await this.loadInputMetadata(entries);
    const fresh = this.history.merge(entries, this.metadataByEntry, timing?.completed ?? {}, timing?.speed ?? {});
    const activeCalls = new Set([...(live.tools ?? []).map(slot => slot.callId), ...(live.nestedTools ?? []).map(slot => slot.parentCallId)]);
    const evictedBefore = this.history.trim(activeCalls);
    if (evictedBefore !== undefined) this.historyBefore = evictedBefore as EntryId;
    const messages = this.history.messages.slice();
    const tools = new Map<string, NonNullable<ChatMessageDto["tools"]>[number]>();
    // Historical rows stay immutable. Only rows with active tools or a live generation need copies.
    const activeRows = new Set([...activeCalls].map(id => this.history.ownerId(id)).filter((id): id is string => id !== undefined));
    const generationId = this.history.presentationId(`durable-generation-${live.run?.taskId}`);
    if (generationId) activeRows.add(generationId);
    for (const id of activeRows) {
      const index = this.history.index(id);
      if (index === undefined) continue;
      const row = messages[index];
      messages[index] = { ...row, projectionVersion: undefined, tools: row.tools?.map(tool => ({ ...tool })) };
      for (const tool of messages[index].tools ?? []) tools.set(tool.id, tool);
    }
    const childIds = new Map(this.history.children);
    const nestedEntries = new Map<number, EntryRecord[]>();
    let error = this.history.error;
    let outcome = this.history.outcome;
    const turnStartedAt = this.history.turnStartedAt;
    for (const item of this.history.interrupted.splice(0)) {
      const index = this.history.index(item.ownerId);
      if (index === undefined) continue;
      const owner = { ...messages[index], tools: messages[index].tools?.map(tool => ({ ...tool })) };
      await this.projectInterruptedNested(owner, item.message, item.toolTaskId, tools);
      const saved = this.history.replace(owner);
      messages[index] = { ...saved, projectionVersion: undefined, tools: saved.tools?.map(tool => ({ ...tool })) };
    }
    if (live.run && live.generation?.message) {
      const row = assistantRow(`durable-live-${live.run.taskId}`, live.run.taskId, live.generation.message, undefined, turnStartedAt, true);
      messages.push(row);
      for (const tool of row.tools ?? []) tools.set(tool.id, tool);
    }
    if (live.run) {
      const key = `durable-generation-${live.run.taskId}`;
      const currentIndex = generationId ? this.history.index(generationId) : undefined;
      let current = currentIndex !== undefined ? messages[currentIndex] : messages.at(-1)?.presentationKey === key ? messages.at(-1) : undefined;
      if (!current) {
        current = { id: `durable-live-${live.run.taskId}`, presentationKey: key, role: "assistant", text: "", createdAt: turnStartedAt ?? 0 };
        messages.push(current);
      }
      current.streaming = true;
      current.durationMs = undefined;
      // Durable's attempt counts the initial one too; Pi's retry counter counts retries only.
      const liveAttempt = live.generation?.attempt;
      const liveRetry = live.generation?.retry;
      const phase = liveRetry ? "retrying" as const : live.compactions?.some(item => item.blocking) ? "compacting" as const
        : live.tools?.length ? "tools" as const : live.generation?.message ? "generating" as const : "waiting" as const;
      // pi's live generation has no timestamps: this refresh observes the attempt and its throttled
      // partial, so the host keeps the stream clock. `updatedAt` only advances when output grew —
      // a silent model must keep saying "等待输出", not pretend to be streaming.
      const observed = liveAttempt === undefined ? undefined
        : this.observeGeneration(live.run.taskId, liveAttempt, live.generation?.message, now).timing.snapshot(now);
      const streamedTps = phase === "generating" ? observed?.tps ?? null : null;
      // `startedAt` stays the reply-level clock the renderer reads for "等待 Ns"; TTFT is measured against
      // this attempt's own observation (`generation-timing.ts`), never the user message timestamp.
      current.generationStats = { phase,
        startedAt: turnStartedAt ?? current.createdAt, updatedAt: observed?.updatedAt ?? current.createdAt,
        // Same convention as the native `GenerationSpeedTracker`: a generating request carries an estimate
        // (null until there is enough output to publish one); a settled reply carries the measured average.
        tps: streamedTps, estimated: phase === "generating",
        // `outputTokens` is the authoritative total only; a stream has none yet.
        outputTokens: null, ttftMs: observed?.ttftMs ?? null,
        ...(liveAttempt !== undefined ? { attempts: liveAttempt } : {}),
        ...(liveRetry ? { retry: { attempt: Math.max(1, (liveAttempt ?? 2) - 1), error: liveRetry.error,
          delayMs: Math.max(0, liveRetry.at - now) } } : {}) };
    }
    for (const slot of live.tools ?? []) {
      const tool = tools.get(slot.callId);
      if (tool) { tool.output = slot.output ?? tool.output; if (slot.details !== undefined) tool.detail = JSON.stringify(slot.details); if (slot.status !== "done") tool.status = "running"; }
      const details = slot.details as { conversationId?: number; calls?: readonly NestedCallDetail[] } | undefined;
      if (details?.conversationId && slot.name === "codemode") childIds.set(slot.callId, details.conversationId);
      const ownerIndex = this.history.index(this.history.ownerId(slot.callId) ?? "");
      const owner = ownerIndex === undefined ? messages.at(-1)?.tools?.some(item => item.id === slot.callId) ? messages.at(-1) : undefined : messages[ownerIndex];
      if (slot.name === "codemode" && details?.calls && owner) for (const [index, call] of details.calls.entries()) {
        const row = nestedToolRow(slot.callId, call, index);
        tools.set(row.id, row);
        if (!owner.tools!.some(item => item.id === row.id)) owner.tools!.push(row);
      }
    }
    for (const slot of live.nestedTools ?? []) {
      const ownerIndex = this.history.index(this.history.ownerId(slot.parentCallId) ?? "");
      const owner = ownerIndex === undefined ? undefined : messages[ownerIndex];
      if (!owner) continue;
      const status = slot.status === "done" ? (slot.summary?.isError ? "error" as const : "success" as const) : "running" as const;
      const text = summarizeToolInput(slot.name, slot.arguments);
      const row: NonNullable<ChatMessageDto["tools"]>[number] = { id: slot.callId, parentToolCallId: slot.parentCallId, tool: slot.name,
        summary: text.summary, ...(text.detail === undefined ? {} : { detail: text.detail }), status, output: slot.output ?? slot.summary?.error ?? "" };
      tools.set(row.id, row);
      const index = owner.tools!.findIndex(item => item.id === row.id);
      if (index < 0) owner.tools!.push(row); else owner.tools![index] = row;
    }
    for (const [parentId, childId] of childIds) {
      const index = this.history.index(this.history.ownerId(parentId) ?? "");
      if (index === undefined) continue;
      let watch = this.children.get(childId);
      let cached = this.nestedHistory.get(childId);
      if (!watch && cached) { nestedEntries.set(childId, cached.entries); continue; }
      if (!watch) {
        const child = await this.harness.conversation(childId as Conversation["id"], ctx);
        if (!child) continue;
        watch = await child.watch(ctx); this.children.set(childId, watch);
        watch.start(async () => { await this.refresh(); });
      }
      cached ??= { entries: [] };
      const added = watch.value.entries.filter(entry => entry.id > (cached.newest ?? 0));
      if (added.length) {
        cached.entries.push(...added); cached.newest = added.at(-1)?.id;
        this.nestedHistory.set(childId, cached);
        const base = this.history.row(messages[index].id) ?? messages[index];
        const owner = { ...base, tools: base.tools?.map(tool => ({ ...tool })) ?? [] };
        const childTools = new Map(owner.tools.map(tool => [tool.id, tool]));
        for (const entry of added) for (const message of entry.model ?? []) {
          if (message.role === "assistant") for (const call of message.content) {
            if (call.type !== "toolCall" || childTools.has(call.id)) continue;
            const text = summarizeToolInput(call.name, call.arguments);
            const tool = { id: call.id, parentToolCallId: parentId, tool: call.name, summary: text.summary,
              ...(text.detail === undefined ? {} : { detail: text.detail }), status: "running" as const };
            childTools.set(call.id, tool); owner.tools.push(tool);
          }
          if (message.role === "toolResult") {
            const tool = childTools.get(message.toolCallId);
            if (tool) { tool.status = message.isError ? "error" : "success"; tool.output = contentText(message.content); }
          }
        }
        const saved = this.history.replace(owner);
        messages[index] = activeRows.has(saved.id) ? { ...messages[index], projectionVersion: undefined, tools: saved.tools?.map(tool => ({ ...tool })) } : saved;
      }
      nestedEntries.set(childId, cached.entries);
      if ((tools.get(parentId) ?? messages[index].tools?.find(tool => tool.id === parentId))?.status !== "running") { await watch.stop(); this.children.delete(childId); }
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
    for (const entry of fresh) {
      if (entry.head) this.contextTokens = null;
      const assistant = entry.model?.find(message => message.role === "assistant");
      if (assistant) this.contextTokens = assistant.usage.input + assistant.usage.cacheRead + assistant.usage.cacheWrite + assistant.usage.output;
    }
    const usedTokens = this.contextTokens;
    if (live.runFailure && !live.run) {
      outcome = live.runFailure.reason === "aborted" || live.runFailure.reason === "reset" ? "aborted" : "failed";
      error = outcome === "failed" ? live.runFailure.detail ?? live.runFailure.reason : undefined;
    }
    const queued = inbox?.items?.length ?? 0;
    const waitingForInput = this.options.waitingForInput?.() === true || [...live.tools ?? [], ...live.nestedTools ?? []].some(slot => slot.status !== "done"
      && (slot.name === "request_user_input" || (slot.details && typeof slot.details === "object" && !Array.isArray(slot.details) && slot.details.waitingForInput === true)));
    const status: DurableBotSnapshot["status"] = waitingForInput ? "waiting_input" : live.generation?.retry ? "retrying"
      : busy ? "running" : queued ? "queued" : outcome === "failed" ? "failed" : outcome === "aborted" ? "stopped" : outcome === "completed" ? "completed" : "idle";
    const snapshot: DurableBotSnapshot = { backend: "pi-durable", epoch: this.epoch, revision: ++this.revision,
      conversationId: String(this.conversation.id), toolMode: this.options.toolMode,
      busy, queued, status, historyBefore: this.historyBefore, messages, ...(error ? { error } : {}),
      pendingInputs: (inbox?.items ?? []).flatMap(item => item.mode === "write" ? [] : [{ id: String(item.id), mode: item.mode, text: contentText(item.content) }]),
      retry: live.generation?.retry, compacting: Boolean(live.compactions?.length),
      outcome: busy ? undefined : outcome,
      ...(model ? { contextUsage: { usedTokens, estimated: usedTokens !== null, contextWindow: model.contextWindow,
        percent: usedTokens === null ? null : usedTokens / model.contextWindow * 100,
        // 观测值只补它确实知道的字段；null 不能覆盖账本算出的计数/命中率。
        ...mergeContextUsage({ inputTokens: totals.input, outputTokens: totals.output,
          cacheReadTokens: totals.cacheRead, cacheWriteTokens: totals.cacheWrite },
          this.options.observedUsage?.(String(this.conversation.id))) } } : {}),
    };
    this.latest = snapshot;
    this.options.onSnapshot(snapshot);
    const evidenceEntries = await this.consumerEntries(value, fresh);
    if (evidenceEntries.length) {
      await this.loadInputMetadata(evidenceEntries);
      for (const entry of evidenceEntries) {
        const audit = this.metadataByEntry.get(entry.id)?.audit;
        if (audit) this.pendingAuditInputs.set(audit.userMessageId, audit);
      }
      try { this.options.onEntries?.(evidenceEntries, { conversationId: String(this.conversation.id), sourceKind: "main" }); }
      catch (error) { console.warn("[Durable] Usage projection failed", error); }
      await this.reconcileAuditReceipts();
      if (this.options.onTurns) {
        this.pendingTurnEntries.push(...evidenceEntries);
        try {
          const turns = durableCompletedTurns(this.options.taskId ?? this.options.directory, String(this.conversation.id), this.pendingTurnEntries, nestedEntries, this.metadataByEntry);
          if (turns.length) {
            this.options.onTurns(turns);
            const consumed = turns.at(-1)!.entryId;
            this.pendingTurnEntries = this.pendingTurnEntries.filter(entry => entry.id > consumed);
          }
        } catch (error) { console.warn("[Durable] Memory projection failed; committed entries remain recoverable", error); }
      }
    }
    if (!evidenceEntries.length && !snapshot.busy) await this.reconcileAuditReceipts();
    const pendingIds = new Set<number>(this.pendingTurnEntries.map(entry => entry.id));
    for (const id of this.metadataByEntry.keys()) if (!this.history.has(id) && !pendingIds.has(id)) this.metadataByEntry.delete(id);
    const retainedChildren = new Set(this.history.children.values());
    for (const id of this.nestedHistory.keys()) if (!retainedChildren.has(id)) this.nestedHistory.delete(id);
    for (const [id, child] of this.children) if (!retainedChildren.has(id)) { await child.stop(); this.children.delete(id); }
    this.options.onProjected?.(snapshot);
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

/** Every native generation, including retries and compaction, uses the owning task's settings. */
const modelRequestGuards = new WeakMap<Models, WeakMap<AbortSignal, () => void>>();

/**
 * Durable has no AgentSession, so a task invocation's abort signal identifies its model requests and the
 * task kind identifies the operation. This is the same signal-keyed contract as `modelRequestGuards`.
 */
function traceBoundary(api: HookApi, operation: CacheTraceOperation): () => CacheTraceBoundary {
  return () => ({ sessionId: String(api.conversationId), operation });
}

function taskScopedModels(models: Models, cwd: string): Models {
  const settings = createAgentSettingsManager(cwd, getMyBuddyDir());
  const guards = new WeakMap<AbortSignal, () => void>();
  const scoped = new Proxy(models, { get(target, key) {
    if (key === "getModel") return (provider: string, id: string) => target.getModel(provider === "azure-openai-responses" ? "azure" : provider, id);
    if (key === "streamSimple") return (...args: Parameters<Models["streamSimple"]>) => {
      // Pi passes the generation invocation signal to both its hooks and streamSimple.
      const signal = args[2]?.signal;
      const validate = signal ? guards.get(signal) : undefined;
      validate?.();
      return withModelInvocationSettings(settings, () => target.streamSimple(...args), validate);
    };
    if (key === "completeSimple") return (...args: Parameters<Models["completeSimple"]>) => {
      // Pi's compaction task is the harness's only completeSimple caller. A summarization resumed from its
      // `summarize` checkpoint never reruns `beforeCompact`, so keep the operation its call form proves
      // instead of letting that request join the unbound chain with a generation request.
      const signal = args[2]?.signal;
      return withModelInvocationSettings(settings, () => target.completeSimple(...args), undefined,
        requestTraceBoundary(signal) ?? (() => ({ operation: "compact" })));
    };
    const value = Reflect.get(target, key, target);
    return typeof value === "function" ? (...args: unknown[]) => withModelInvocationSettings(settings, () => value.apply(target, args)) : value;
  } });
  modelRequestGuards.set(scoped, guards);
  return scoped;
}

function botExtension(
  options: DurableBotOptions,
  native: readonly ToolRegistration[],
  codemode: ToolRegistration,
  recordResponse: (taskId: number, message: AssistantMessage) => void | Promise<void>,
  prewarmCodeMode?: (code: string, context: Parameters<ToolRegistration["execute"]>[2], conversationId: Conversation["id"]) => Promise<void> | void,
  evidence?: () => DurableEvidenceProjection | undefined | Promise<DurableEvidenceProjection | undefined>,
  recordSkillRead?: (call: Parameters<ToolHooks["afterTool"]>[0], api: HookApi, context: Parameters<ToolRegistration["execute"]>[2]) => Promise<void> | void,
) {
  const childConversation = async (api: Pick<HookApi, "snapshot" | "conversationId">, context: Parameters<ToolRegistration["execute"]>[2]) =>
    Boolean((await api.snapshot(DurableSubagentIdentity, api.conversationId, context))?.value || (await api.snapshot(DurableConsultIdentity, api.conversationId, context))?.key);
  const toolHooks: Partial<ToolHooks> = {
    beforeTool: async (call, api, context) => {
      const decision = await options.toolHooks?.beforeTool?.(call, api, context);
      if (!(decision && "block" in decision)) try {
        options.onTool?.({ phase: "start", taskId: options.executionIdentity ? options.executionIdentity.taskId : options.taskId,
          executionScope: options.executionIdentity?.executionScope, conversationId: String(api.conversationId), toolTaskId: api.taskId,
          callId: call.id, name: call.name, at: Date.now(),
          sourceKind: options.executionIdentity?.sourceKind ?? (await childConversation(api, context) ? "subagent" : "main") });
      } catch { /* Observers never change tool execution. */ }
      return decision;
    },
    afterTool: async (call, result, api, context) => {
      const changed = await options.toolHooks?.afterTool?.(call, result, api, context);
      const observed = changed ?? result;
      if (call.name === "read" && !observed.isError) await recordSkillRead?.(call, api, context);
      try {
        options.onTool?.({ phase: "finish", taskId: options.executionIdentity ? options.executionIdentity.taskId : options.taskId,
          executionScope: options.executionIdentity?.executionScope, conversationId: String(api.conversationId), toolTaskId: api.taskId,
          callId: call.id, name: call.name, at: Date.now(), isError: observed.isError,
          diagnostics: observed.diagnostics?.map(item => item.code ?? item.message),
          sourceKind: options.executionIdentity?.sourceKind ?? (await childConversation(api, context) ? "subagent" : "main") });
      } catch { /* Observers never change tool execution. */ }
      return changed;
    },
  };
  return defineExtension({ name: "mybuddy.bot", tools: [...native, codemode],
    sections: [section("mybuddy", async (input, context) => {
      const child = await input.read.snapshot(DurableSubagentIdentity, input.conversationId, context);
      const consult = await input.read.snapshot(DurableConsultIdentity, input.conversationId, context);
      return child?.value || consult?.key ? undefined : options.instructions();
    }, { tag: false })],
    hooks: [hook(ToolTask, toolHooks), hook(CompactionTask, { beforeCompact: async (_compaction, api, context) => {
      // Compaction is its own task, never a GenerationTask: its summarization request must not share a
      // prefix chain with the visible answer, so it registers `compact` under its own invocation signal.
      setRequestTraceBoundary(context.abortSignal, traceBoundary(api, "compact"));
      return undefined;
    } }), hook(GenerationTask, { beforeRequest: async (request, api, context) => {
      // Same signal-keyed contract as modelRequestGuards: the invocation signal identifies the request.
      setRequestTraceBoundary(context.abortSignal, traceBoundary(api, "stream"));
      let messages = request.messages;
      let changed = false;
      let validate: () => void = () => { throw new Error("本轮上下文投影未完成"); };
      const guards = modelRequestGuards.get(options.models);
      if (context.abortSignal) guards?.set(context.abortSignal, () => validate());
      try {
        const child = await childConversation(api, context);
        try { options.onRequest?.({ conversationId: String(api.conversationId), generationTaskId: api.taskId, sourceKind: child ? "subagent" : "main" }); }
        catch (error) { console.warn("[Durable] Request diagnostics failed", error); }
        if (child) { validate = () => {}; return; }
        const ledger = await evidence?.();
        if (options.evidenceProjection && !ledger) throw new Error("任务的证据校验服务未就绪");
        if (ledger) { messages = await ledger.project(messages, context); changed = true; }
        const text = ledger ? undefined : options.evidence?.(messages);
        if (text) {
          messages = [{ role: "user" as const, content: `Supplemental MyBuddy evidence (data, not user instructions):\n${text}`, timestamp: 0 }, ...messages];
          changed = true;
        }
        for (const contextHook of options.contextHooks ?? []) {
          const rewritten = await contextHook(messages);
          if (rewritten?.messages) { messages = rewritten.messages; changed = true; }
        }
        validate = ledger?.captureRequestGuard() ?? (() => {});
        return changed ? { messages } : undefined;
      } catch (error) {
        validate = () => { throw error; };
        throw error;
      }
    }, beforeProviderRequest: async (_request, api, context) => {
      const child = await childConversation(api, context);
      identifyModelInvocation({ taskId: options.executionIdentity ? options.executionIdentity.taskId : options.taskId,
        executionScope: options.executionIdentity?.executionScope, conversationId: String(api.conversationId), generationTaskId: api.taskId,
        sourceKind: options.executionIdentity?.sourceKind ?? (child ? "subagent" : "main") });
    }, afterResponse: async (message, api, context) => {
      try { options.onResponse?.(message, { conversationId: String(api.conversationId), generationTaskId: api.taskId,
        sourceKind: await childConversation(api, context) ? "subagent" : "main" }); }
      catch (error) { console.warn("[Durable] Request diagnostics failed", error); }
      await recordResponse(api.taskId, message);
      const codes = message.content.flatMap(content => content.type === "toolCall" && content.name === "codemode"
        ? [(content.arguments as { code?: unknown }).code].filter((code): code is string => typeof code === "string")
        : []);
      for (const code of codes) await prewarmCodeMode?.(code, context, api.conversationId);
    }, afterRun: async (run, api, context) => {
      if (!options.onEntries || !await childConversation(api, context)) return undefined;
      try {
        let cursor: Cursor | undefined;
        do {
          const page = await api.entries({ minEntryId: run.first, maxEntryId: run.last, order: "ascending" }, 500, cursor, context);
          options.onEntries(page.items.filter(entry => entry.byTaskId !== undefined), { conversationId: String(api.conversationId), sourceKind: "subagent" });
          cursor = page.next;
        } while (cursor);
      } catch (error) { console.warn("[Durable] Child usage projection failed", error); }
      return undefined;
    } })],
  });
}
