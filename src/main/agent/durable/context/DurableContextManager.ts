import { createHash } from "node:crypto";
import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/chord/context";
import type { AssistantMessage, Message, Models } from "@earendil-works/pi-ai";
import { estimateContextTokens, estimateMessageTokens, estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { CompactionReason, Conversation, ContextView, DocumentReader, EntryRecord, HookApi } from "@earendil-works/pi-durable";
import { DurableContextRefArchive, DurableContextBlockArchive } from "./DurableContextArchive";
import {
  activeBlocks, blockDocs, collectBlockContent, createCore, createInitialState, defaultConfig,
  isSummaryMessageId, searchBlocks, SUMMARY_HEADER,
  type CompressibleRange, type CompressionBlock, type CompressionCore, type CompressionState, type Config,
  type CoreMessage,
} from "../../../../../vendor/acp-kernel/src/index.ts";
import type {
  ContextManagementEngine, ContextManagementReason, ContextManagementStatusDto, ContextManagementSummaryDto,
} from "../../../../shared/context-management";
import {
  contextConfigDigest, DurableContextStateDoc, DurableContextSessionDoc, emptyPersistedState, mergeRefLocators, parseKernelState,
  normalizePersisted, persistedContextStatus, matchesNativeContextCommit, nativeSummaryDigest,
  serializeKernelState, summaryRefSpan,
  type DurableContextPersistedState, type DurableContextRefLocator, type DurableContextLastOperation,
} from "./DurableContextState";
import type { DurableCompactionOutcome, ProductCompactionSettings } from "./types";

/** 压缩摘要的来源标记；测试与 UI 用它区分“原文”与“摘要”。 */
export const SUMMARY_MARKER = "[Compressed conversation section]";

const SUMMARIZER_SYSTEM = `You compress conversation history for another AI assistant.
Preserve every fact the assistant may need later: exact file paths, version numbers, error codes, commands, API and schema details, decisions and their reasons, outstanding tasks, current state, and the user's explicit instructions and corrections.
Remove redundancy, raw tool output and chatter, but never invent, summarize away, or reword exact quotes that may be retrieved later.
Write in the language of the conversation. Output only the summary, with no preamble.`;

const EMPTY_KERNEL_VERSION = "0.0.195";
/** 每 N 轮落盘一次；摘要/边界变化立即落盘（崩溃后 refs 可由消息顺序确定性重建）。 */
const SAVE_INTERVAL_ROUNDS = 8;
/** 持久 refs 上限与“最近窗口”保留量，避免长历史把 state 文档无限放大。 */
const MAX_PERSISTED_REFS = 20_000;
const RECENT_REF_WINDOW = 2_000;

export interface DurableContextManagerHost {
  conversation: Conversation;
  models: Models;
  /** 当前引擎：`billion-context`（分层摘要）或 `native`（Pi 原生按比例压缩）；每次使用重新读取。 */
  engine?: () => ContextManagementEngine;
  /** 同步读取产品阈值；每次使用重新读取。 */
  policy: () => ProductCompactionSettings;
  /** 当前模型窗口；模型切换后由运行时更新。 */
  contextWindow: () => number;
  modelKey?: () => string | undefined;
  toolEstimateTokens?: () => number;
  /** Current model output ceiling, independent of the soft compaction trigger. */
  outputReserveTokens?: () => number | undefined;
  onStatus?: (status: ContextManagementStatusDto) => void;
  log?: (message: string, error?: unknown) => void;
  /** Passive snapshot from the owning Harness; constructing a manager performs no maintenance. */
  initialState?: DurableContextPersistedState;
  initialStatus?: ContextManagementStatusDto;
  /** Official indexed document reads; absent in legacy hosts, which retain their old in-document maps. */
  archiveReader?: DocumentReader;
}

/** 一条 provider 消息与其 Durable 位置（未匹配到 entry 的临时证据消息没有 locator）。 */
interface MessageMapping {
  message: Message;
  coreIds: string[];
  locator?: { entryId: number; slot: number };
}

interface CoreBuild {
  messages: CoreMessage[];
  mappings: MessageMapping[];
  protectedIds: Set<string>;
}

interface TurnOutcome {
  state: CompressionState;
  projected: readonly Message[];
  /** 至少有一条历史消息被摘要覆盖：即使本轮没有新摘要，也必须把投影发给 provider。 */
  projectedApplied: boolean;
  folds: number;
  blocks: number;
  beforeTokens: number;
  afterTokens: number;
  reason?: ContextManagementReason;
  skippedReason?: string;
}
type OperationSource = DurableContextLastOperation["source"];

/**
 * Durable 会话的上下文管理协调点。
 * 内核只做纯数据变换；摘要由本类调用当前模型生成；原文始终留在 Durable entry 中。
 */
export class DurableContextManager {
  private readonly core: CompressionCore = createCore({});
  private persisted: DurableContextPersistedState = emptyPersistedState();
  private kernelState?: CompressionState;
  private loaded = false;
  /** Only durable snapshots may be reused after a failed commit. */
  private committed = emptyPersistedState();
  private loading?: Promise<void>;
  private headEntryId: number | null = null;
  private rebaseNeeded = true;
  private consecutiveFailures = 0;
  private disposed = false;
  private status: ContextManagementStatusDto;
  private lastPublished = 0;
  private activeOperation?: DurableContextLastOperation;
  /** Synchronous admission, before any await: no two callbacks may stage the same manager's state. */
  private mutating = false;
  /** 手动整理的取消句柄；取消只停止本次维护，不影响任务停止语义。 */
  private manualAbort?: AbortController;
  private pendingArchive?: { refs: Record<string, DurableContextRefLocator[]>; blocks: Record<string, number[]> };

  constructor(private readonly host: DurableContextManagerHost) {
    this.status = {
      engine: "billion-context",
      enabled: true,
      phase: "idle",
      automatic: true,
      contextWindow: 0,
      triggerTokens: 0,
      estimated: true,
      summaries: [],
      revision: 0,
      updatedAt: Date.now(),
    };
    if (host.initialState) {
      this.persisted = normalizePersisted(structuredClone(host.initialState));
      this.committed = structuredClone(this.persisted);
      this.status = host.initialStatus ?? persistedContextStatus(this.persisted);
    }
  }

  get conversationId(): number { return this.host.conversation.id; }

  /** 产品设置里的引擎选择；native 时本协调器不投影、不触发压缩（交给 Pi 原生按比例压缩）。 */
  private get engine(): ContextManagementEngine {
    return this.host.engine?.() === "native" ? "native" : "billion-context";
  }

  private get healthy(): boolean { return this.consecutiveFailures < 2; }

  private log(message: string, error?: unknown): void {
    this.host.log?.(message, error);
  }

  /** 产品阈值换算成当前窗口的触发线/预留；无效窗口返回保守值。 */
  resolvePolicy(): { window: number; triggerTokens: number; reserveTokens: number } {
    const window = this.host.contextWindow();
    if (!Number.isSafeInteger(window) || window < 2) {
      return { window: 0, triggerTokens: 0, reserveTokens: 16_384 };
    }
    const product = this.host.policy();
    const ratio = Number.isFinite(product.ratio) ? Math.min(0.9, Math.max(0.1, product.ratio)) : 0.8;
    const ratioTokens = Math.floor(window * ratio);
    const absolute = product.absoluteTokens;
    const triggerTokens = absolute !== null && absolute > 0 ? Math.min(ratioTokens, absolute) : ratioTokens;
    return { window, triggerTokens, reserveTokens: Math.max(1_024, window - triggerTokens) };
  }

  statusSnapshot(): ContextManagementStatusDto {
    const policy = this.resolvePolicy();
    const engine = this.engine;
    const visible = this.mutating || this.loading ? this.committed : this.persisted;
    const kernel = this.mutating || this.loading ? parseKernelState(this.committed) : this.kernelState;
    return {
      ...this.status,
      engine,
      enabled: engine === "billion-context" && this.status.enabled && this.healthy && !this.disposed,
      contextWindow: policy.window,
      triggerTokens: policy.triggerTokens,
      configDigest: this.configDigest(),
      blocks: kernel ? countTopLevelBlocks(kernel) : this.status.blocks ?? 0,
      summaries: visible.summaries.slice(-5).map(toSummaryDto),
      updatedAt: this.status.updatedAt,
    };
  }

  /** 原生压缩边界变化（或首次打开）后重建内核 state；旧 ref 映射归档，原文仍可回查。 */
  async ensureReady(ctx: Context): Promise<void> {
    if (this.disposed) return;
    if (this.loading) return this.loading;
    if (this.loaded) return;
    this.loading = (async () => {
      try {
        const view = await this.host.conversation.context(ctx);
        const currentHead = view.head?.id ?? null;
        // tx.doc 返回的是绑定该事务的 chord overlay：必须在 commit 回调内取值并转成纯 JSON，
        // 事务结束后再读会抛 “Cannot use a settled overlay”。
        const record = await this.host.conversation.commit(async tx => {
          const doc = await tx.doc(DurableContextStateDoc, this.host.conversation.id);
          // tx.doc 返回事务 overlay（proxy），离开 commit 后不可读、也不可 structuredClone；
          // 在事务内转成纯 JSON 再返回。
          return JSON.parse(JSON.stringify({
            schemaVersion: doc.schemaVersion, kernelVersion: doc.kernelVersion, configDigest: doc.configDigest,
            headEntryId: doc.headEntryId, watermarkEntryId: doc.watermarkEntryId, epoch: doc.epoch,
            refs: doc.refs, archivedRefs: doc.archivedRefs, stateJson: doc.stateJson,
            summaries: doc.summaries, stats: doc.stats, lastOperation: doc.lastOperation,
            revision: doc.revision, sessionId: (await tx.doc(DurableContextSessionDoc)).sessionId,
          })) as DurableContextPersistedState;
        }, ctx);
        this.persisted = normalizePersisted(record);
        if (typeof this.persisted.sessionId !== "string" || !this.persisted.sessionId) throw new Error("持久会话身份无效，原始记录已保留");
        this.committed = structuredClone(this.persisted);
        this.status = persistedContextStatus(this.persisted);
        this.headEntryId = currentHead;
        if (this.persisted.headEntryId === currentHead) {
          const parsed = parseKernelState(this.persisted);
          if (parsed) {
            this.kernelState = parsed;
            this.rebaseNeeded = false;
          }
        }
        if (!this.kernelState) await this.rebase(currentHead, ctx, "boundary");
        const unfinished = this.persisted.lastOperation;
        if (unfinished && (unfinished.phase === "summarizing" || unfinished.phase === "applying")) {
          this.persisted.lastOperation = { ...unfinished, phase: "failed", interrupted: true,
            message: "上次上下文整理被中断，已保留原文和已提交摘要；未自动重放", lastError: "维护进程在提交终态前结束", at: Date.now() };
          await this.save(ctx, true);
        }
        this.loaded = true;
      } catch (error) {
        this.log("[Context] 无法恢复上下文管理状态，等待下一次重建", error);
        this.rebaseNeeded = true;
        throw error;
      } finally {
        this.loading = undefined;
      }
    })();
    return this.loading;
  }

  /** 原生压缩已改变 context head：清空当前内核 state 并从新边界重建，旧摘要 ref 归档。 */
  private async rebase(headEntryId: number | null, ctx: Context, reason: "boundary" | "native-fallback"): Promise<void> {
    const previous = this.kernelState ?? parseKernelState(this.persisted);
    if (previous && this.host.archiveReader) {
      const refs: Record<string, DurableContextRefLocator[]> = {};
      for (const map of [this.persisted.refs, ...this.persisted.archivedRefs.map(item => item.refs)]) {
        for (const [ref, locator] of Object.entries(map)) (refs[ref] ??= []).push(locator);
      }
      for (const [ref, rawId] of Object.entries(previous.messageRefs.byRef)) {
        const locator = this.locatorOfRawId(rawId);
        if (locator) (refs[ref] ??= []).push(locator);
      }
      const blocks = Object.fromEntries(this.persisted.summaries.map(item => [item.blockId, item.entryIds]));
      for (const block of previous.blocks) blocks[block.blockId] = this.blockEntryIds(block);
      this.pendingArchive = { refs, blocks };
    }
    if (previous) {
      const previousEpoch = this.persisted.epoch;
      if (Object.keys(this.persisted.refs).length) {
        this.persisted.archivedRefs.push({ epoch: previousEpoch, refs: this.persisted.refs });
        if (this.persisted.archivedRefs.length > 8) this.persisted.archivedRefs.splice(0, this.persisted.archivedRefs.length - 8);
      }
      this.persisted.epoch = previousEpoch + 1;
    }
    this.kernelState = createInitialState();
    // Retire coverage, not identities: stale mNNNNN/bN must never point at a new message/block.
    if (previous) {
      if (!this.host.archiveReader) this.kernelState.messageRefs = structuredClone(previous.messageRefs);
      this.kernelState.nextBlockId = Math.max(previous.nextBlockId,
        ...this.persisted.summaries.map(item => Number(item.blockId.slice(1)) + 1).filter(Number.isSafeInteger));
      // Older adapter versions may have retired refs beyond the latest epoch's map.
      const retired = [...Object.keys(previous.messageRefs.byRef), ...Object.keys(this.persisted.refs), ...this.persisted.archivedRefs.flatMap(item => Object.keys(item.refs))];
      const highest = retired.reduce((max, ref) => Math.max(max, refIndex(ref) ?? 0), 0);
      if (highest > 0) {
        const ref = `m${String(highest).padStart(5, "0")}`;
        if (!this.kernelState.messageRefs.byRef[ref]) {
          const retiredId = `retired:${this.persisted.epoch}:${highest}`;
          this.kernelState.messageRefs.byRef[ref] = retiredId;
          this.kernelState.messageRefs.byRaw[retiredId] = ref;
        }
      }
      this.kernelState.nextRunId = previous.nextRunId;
    }
    if (this.host.archiveReader) {
      this.persisted.archivedRefs = [];
      // UI mirrors are not the archive. The transaction below preserves every retired block by stable key.
      this.persisted.summaries = this.persisted.summaries.slice(-5);
    }
    this.persisted.refs = {};
    this.persisted.headEntryId = headEntryId;
    this.headEntryId = headEntryId;
    this.rebaseNeeded = false;
    this.consecutiveFailures = 0;
    this.persisted.kernelVersion = EMPTY_KERNEL_VERSION;
    const operation = this.persisted.lastOperation;
    if (operation?.phase === "applying" && operation.source.headEntryId !== headEntryId) {
      const head = (await this.host.conversation.context(ctx)).head;
      // A reset/rewind/unrelated compaction is not proof that our native fallback was placed.
      const matched = await matchesNativeContextCommit(operation, head, requestId => this.host.conversation.commit(
        tx => tx.submissionByRequest(this.host.conversation.id, requestId), ctx));
      this.persisted.lastOperation = { ...operation, phase: matched ? "completed" : "failed", at: Date.now(),
        interrupted: !matched, message: matched ? "原生压缩边界已提交" : "原生边界已变化，但无法验证本次摘要提交，原文与已提交记录保留" };
    }
    await this.save(ctx, true);
    this.log(`[Context] 上下文 state 从边界重建（${reason}）`);
  }

  /** 持久化节流：refs/统计每轮都变，但只有摘要/边界变化才必须立即落盘；崩溃后可确定性重建。 */
  private roundsSinceSave = 0;
  private async save(ctx: Context, force = false, expectedOperation?: DurableContextLastOperation,
    expectedSource = expectedOperation?.source, expectedConfig = expectedOperation?.configDigest): Promise<void> {
    if (!this.kernelState) return;
    if (!force && this.roundsSinceSave < SAVE_INTERVAL_ROUNDS) { this.roundsSinceSave += 1; return; }
    this.roundsSinceSave = 0;
    this.persisted.stateJson = serializeKernelState(this.kernelState);
    this.persisted.kernelVersion = EMPTY_KERNEL_VERSION;
    // Durable documents are strict JSON: optional diagnostic fields must be absent, not undefined.
    const snapshot = JSON.parse(JSON.stringify(this.persisted)) as DurableContextPersistedState;
    const expectedRevision = this.committed.revision ?? 0;
    if (expectedRevision >= Number.MAX_SAFE_INTEGER) throw new Error("上下文状态修订序列已耗尽");
    snapshot.revision = expectedRevision + 1;
    if (snapshot.lastOperation) snapshot.lastOperation.revision = snapshot.revision;
    try {
      await this.host.conversation.commit(async tx => {
        const doc = await tx.doc(DurableContextStateDoc, this.host.conversation.id);
        if ((doc.revision ?? 0) !== expectedRevision
          || (expectedOperation && doc.lastOperation?.operationId !== expectedOperation.operationId)) {
          throw new StaleContextOperation(normalizePersisted(JSON.parse(JSON.stringify(doc))));
        }
        if (expectedOperation) {
          if (this.disposed || this.activeOperation?.operationId !== expectedOperation.operationId
            || this.configDigest() !== expectedOperation.configDigest) throw new Error("上下文整理的操作或配置已变化，请重试");
        }
        if (expectedConfig !== undefined && this.configDigest() !== expectedConfig) throw new Error("上下文整理的配置已变化，请重试");
        if (expectedSource) {
          const [head, tail] = await Promise.all([tx.latestHeadMarker(this.host.conversation.id), tx.latestEntryId(this.host.conversation.id)]);
          if ((head?.id ?? null) !== expectedSource.headEntryId || (tail ?? 0) !== expectedSource.watermarkEntryId
            || this.persisted.epoch !== expectedSource.epoch) throw new Error("上下文整理的原始视图已变化，请重试");
        }
        if (this.pendingArchive) {
          for (const [ref, locators] of Object.entries(this.pendingArchive.refs)) {
            const archived = await tx.doc(DurableContextRefArchive, this.host.conversation.id, ref, []);
            for (const locator of locators) if (!archived.locators.some(item => item.entryId === locator.entryId && item.slot === locator.slot)) {
              archived.locators.push(locator);
            }
          }
          for (const [blockId, entryIds] of Object.entries(this.pendingArchive.blocks)) {
            const archived = await tx.doc(DurableContextBlockArchive, this.host.conversation.id, blockId, entryIds);
            if (JSON.stringify(archived.entryIds) !== JSON.stringify(entryIds)) throw new Error("历史摘要标识冲突，未替换原始记录定位");
          }
        }
        for (const key of Object.keys(doc)) Reflect.deleteProperty(doc, key);
        Object.assign(doc, snapshot);
      }, ctx);
      this.committed = snapshot;
      this.pendingArchive = undefined;
      this.persisted = structuredClone(snapshot);
      this.status = { ...this.status, ...persistedContextStatus(snapshot, false) };
    } catch (error) {
      this.pendingArchive = undefined;
      if (error instanceof StaleContextOperation) this.committed = error.current;
      this.persisted = structuredClone(this.committed);
      this.kernelState = parseKernelState(this.committed);
      this.headEntryId = this.committed.headEntryId;
      this.rebaseNeeded = !this.kernelState;
      this.loaded = Boolean(this.kernelState);
      this.status = persistedContextStatus(this.committed, !this.activeOperation);
      if (error instanceof StaleContextOperation) throw error;
      throw new Error(`上下文管理状态未保存，已放弃未提交的摘要：${errorText(error)}`);
    }
  }

  private configDigest(): string {
    const policy = this.resolvePolicy();
    return contextConfigDigest({ contextWindow: policy.window, triggerTokens: policy.triggerTokens,
      keepRecentTokens: 20_000, modelKey: this.host.modelKey?.(), outputReserveTokens: this.requestReserve(policy.window), engine: this.engine });
  }

  private operationSource(view: ContextView): OperationSource {
    return { headEntryId: view.head?.id ?? null, watermarkEntryId: highestEntryId(view.entries), epoch: this.persisted.epoch,
      viewDigest: viewDigest(view.messages) };
  }

  private async beginOperation(ctx: Context, reason: ContextManagementReason, automatic: boolean, beforeTokens?: number, expectedSource?: OperationSource): Promise<DurableContextLastOperation> {
    if (this.activeOperation) throw new Error("已有一次上下文整理正在进行");
    const view = await this.host.conversation.context(ctx);
    const observed = this.operationSource(view);
    if (expectedSource !== undefined && JSON.stringify(observed) !== JSON.stringify(expectedSource)) throw new Error("上下文整理的原始视图已变化，请重试");
    const policy = this.resolvePolicy();
    const sourceRevision = this.committed.revision ?? 0;
    const operation: DurableContextLastOperation = {
      operationId: `${this.persisted.sessionId}:${this.conversationId}:${sourceRevision + 1}`,
      revision: sourceRevision + 1, sourceRevision, sessionId: this.persisted.sessionId!, conversationId: this.conversationId,
      source: expectedSource ?? observed,
      configDigest: this.configDigest(), contextWindow: policy.window, triggerTokens: policy.triggerTokens,
      phase: "summarizing", reason, engine: this.engine, automatic, estimated: true, beforeTokens, at: Date.now(),
    };
    this.persisted.lastOperation = operation;
    await this.save(ctx, true, undefined, operation.source, operation.configDigest);
    this.activeOperation = operation;
    this.publish(this.status);
    return operation;
  }

  private async finishOperation(operation: DurableContextLastOperation, outcome: Partial<DurableContextLastOperation>, ctx: Context): Promise<void> {
    if (this.disposed || this.activeOperation !== operation) throw new StaleContextOperation(this.committed);
    const view = await this.host.conversation.context(ctx);
    if (viewDigest(view.messages) !== operation.source.viewDigest) throw new Error("上下文整理的原始视图已变化，请重试");
    this.persisted.lastOperation = { ...operation, ...outcome, at: Date.now() };
    await this.save(ctx, true, operation);
    if (this.activeOperation === operation) this.activeOperation = undefined;
    this.publish(this.status);
  }

  private async rejectOperation(operation: DurableContextLastOperation, error: unknown): Promise<void> {
    if (this.activeOperation !== operation) return;
    this.activeOperation = undefined;
    // A newer manager's state wins. An old callback may not write a failure over its result.
    if (this.committed.lastOperation?.operationId !== operation.operationId || error instanceof StaleContextOperation || this.disposed) return;
    this.persisted = structuredClone(this.committed);
    this.kernelState = parseKernelState(this.committed);
    const cancelled = this.manualAbort?.signal.aborted || isAbortError(error);
    this.persisted.lastOperation = { ...operation, phase: cancelled ? "cancelled" : "failed", at: Date.now(),
      message: cancelled ? "已取消" : "上下文整理失败", lastError: cancelled ? undefined : errorText(error) };
    try { await this.save(BACKGROUND_CONTEXT, true); this.publish(this.status); }
    catch (writeError) { this.fail("上下文整理失败，终态未能保存", writeError); }
  }

  /**
   * 每次 provider 请求前：把已提交历史投影成内核视图，必要时自动摘要，再把投影还原成真实消息。
   * 失败时只在原始消息仍可容纳时回退；不可容纳则明确失败，禁止发送超限输入。
   */
  async beforeRequest(messages: readonly Message[], api: HookApi, ctx: Context): Promise<{ messages: readonly Message[] } | undefined> {
    if (this.mutating) { this.assertRequestFits(messages); return undefined; }
    this.mutating = true;
    try { return await this.prepareRequest(messages, api, ctx); }
    finally { this.mutating = false; }
  }

  private async prepareRequest(messages: readonly Message[], api: HookApi, ctx: Context): Promise<{ messages: readonly Message[] } | undefined> {
    if (this.disposed || this.engine !== "billion-context") return undefined;
    try {
      await this.ensureReady(ctx);
      if (!this.kernelState) return undefined;
      const view = await this.host.conversation.context(ctx);
      const headEntryId = view.head?.id ?? null;
      if (headEntryId !== this.headEntryId || this.rebaseNeeded) {
        this.rebaseNeeded = true;
        await this.rebase(headEntryId, ctx, "boundary");
      }
      if (!this.healthy) { this.assertRequestFits(messages); return undefined; }
      const outcome = await this.maintainAndProject(messages, view.entries, api.models, ctx, { automatic: true, source: this.operationSource(view) });
      this.assertRequestFits(outcome.projected);
      this.consecutiveFailures = 0;
      this.publish({ ...this.status, estimatedInputTokens: outcome.beforeTokens, blocks: outcome.blocks,
        processedMessages: outcome.folds > 0 ? outcome.processed : 0 });
      return outcome.projectedApplied ? { messages: outcome.projected } : undefined;
    } catch (error) {
      this.consecutiveFailures++;
      this.fail("自动上下文整理失败", error);
      this.assertRequestFits(messages);
      return undefined;
    }
  }

  /** Never send an oversized raw fallback after maintenance failed or protected input could not shrink. */
  private requestReserve(window: number): number {
    const declared = this.host.outputReserveTokens?.();
    // Missing metadata keeps a conservative nonzero fallback; it is never interpreted as free output.
    const fallback = Math.min(16_384, Math.max(1_024, Math.floor(window * 0.1)));
    const output = Number.isSafeInteger(declared) && declared! > 0 ? declared! : fallback;
    return Math.max(fallback, output) + 1_024;
  }

  private assertRequestFits(messages: readonly Message[]): void {
    const { window } = this.resolvePolicy();
    if (!window) throw new Error("当前模型窗口未知，无法安全发送上下文");
    const input = messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
      + Math.max(0, this.host.toolEstimateTokens?.() ?? 0);
    const reserve = this.requestReserve(window);
    if (input + reserve > window) {
      throw new Error(`上下文超过当前模型安全输入上限（估算 ${input}，上限 ${Math.max(0, window - reserve)} tokens）。原始记录仍保留；请拆分过大的输入，或切换更大窗口模型后重试。`);
    }
  }

  /**
   * 原生压缩前的协调点：
   * - BC 健康且是阈值压缩：仅对可证明完整、安全的文本前缀返回 BC 摘要，由 SDK 提交 head；
   *   固定 cut 包含受保护内容时 decline，保留原有逐块投影，不声称该路径有界；
   * - 其他情况（原生手动/溢出/BC 故障）：若原生输入可能撑爆窗口，用自己的有界摘要替代，
   *   保证 fallback 的摘要请求本身一定装得下；否则沿用原生行为。
   */
  async beforeCompact(input: { reason: CompactionReason; messages: readonly Message[]; entries?: readonly EntryRecord[]; firstKept?: number }, api: HookApi, ctx: Context): Promise<{ decline: true } | { summary: string } | undefined> {
    if (this.mutating) return { decline: true };
    this.mutating = true;
    try { return await this.prepareNativeCompact(input, api, ctx); }
    finally { this.mutating = false; }
  }

  private async prepareNativeCompact(input: { reason: CompactionReason; messages: readonly Message[]; entries?: readonly EntryRecord[]; firstKept?: number }, api: HookApi, ctx: Context): Promise<{ decline: true } | { summary: string } | undefined> {
    // 用户显式选择“按比例压缩（Pi 原生）”时，不参与原生压缩协调，完全沿用 Pi 行为。
    if (this.engine !== "billion-context") return undefined;
    const policy = this.resolvePolicy();
    let operation: DurableContextLastOperation | undefined;
    try {
      // prepare 阶段会先跑阈值压缩、再跑 beforeRequest；若这里不先加载 state，
      // 重启后的第一次请求会误走 fallback，重复生成已经存在的摘要。
      await this.ensureReady(ctx);
      if (input.reason === "threshold" && this.healthy && this.kernelState) {
        // Only the official compaction task may advance a busy conversation's head. A summary-only
        // hook cannot carry protected media/signatures across that boundary, so refuse those cuts.
        if (!input.entries || input.firstKept === undefined) return { decline: true };
        const view = await this.host.conversation.context(ctx);
        const prefixIds = new Set<number>(input.entries.map(entry => entry.id));
        const cut = view.entries.findIndex(entry => entry.id === input.firstKept);
        if (cut < 1 || JSON.stringify(view.entries.slice(0, cut).map(entry => entry.id)) !== JSON.stringify(input.entries.map(entry => entry.id))) return { decline: true };
        const recent = view.entries.filter(entry => entry.model?.length).slice(-3);
        if (recent.some(entry => prefixIds.has(entry.id)) || !safeSummaryPrefix(input.entries)) return { decline: true };
        // Existing BC blocks are indivisible too. Compose wholly-contained committed summaries;
        // never summarize the raw originals of a block that straddles the SDK's fixed boundary.
        for (const block of topLevelBlocks(this.kernelState)) {
          const ids = this.blockEntryIds(block);
          if (ids.some(id => prefixIds.has(id)) && ids.some(id => !prefixIds.has(id))) return { decline: true };
        }
        const build = this.buildCoreMessages(input.messages, input.entries);
        const projected = this.renderProjected(build, this.kernelState).messages;
        const beforeTokens = projected.reduce((sum, message) => sum + estimateMessageTokens(message), 0);
        operation = await this.beginOperation(ctx, "threshold", true, beforeTokens, this.operationSource(view));
        const model = await this.resolveModel(api.models, ctx);
        const text = await this.summarizeMessages(projected, Math.max(4_096, Math.floor(policy.window * 0.45)), model, api.models, ctx);
        const summary = `${SUMMARY_MARKER}\n${text}\n\n[Original records remain available through acp_search (scope=originals) and acp_retrieve (entryId/ref/blockId).]`;
        const afterTokens = estimateTextTokens(summary);
        if (afterTokens >= beforeTokens) throw new Error("前缀摘要没有减少实际输入，未提交原生边界");
        await this.finishOperation(operation, { phase: "applying", engine: "billion-context",
          nativeCommit: { taskId: api.taskId, firstKept: input.firstKept, summaryDigest: nativeSummaryDigest(summary) },
          afterTokens, message: "BC 前缀摘要已准备，等待原生边界提交" }, ctx);
        this.rebaseNeeded = true;
        return { summary };
      }
      const budget = Math.max(4_096, Math.floor(policy.window * 0.45));
      const inputTokens = Math.max(estimateMessages(input.messages), input.messages.reduce((total, message) => total + estimateMessageTokens(message), 0));
      this.rebaseNeeded = true;
      if (inputTokens <= budget) return undefined;
      operation = await this.beginOperation(ctx, input.reason === "manual" ? "manual" : "fallback", input.reason !== "manual", inputTokens);
      const model = await this.resolveModel(api.models, ctx);
      const summary = await this.summarizeMessages(input.messages, budget, model, api.models, ctx);
      // The native task has not committed its head yet. Do not publish completed from a before hook.
      await this.finishOperation(operation, { phase: "applying", engine: "native",
        ...(input.firstKept !== undefined ? { nativeCommit: { taskId: api.taskId, firstKept: input.firstKept,
          summaryDigest: nativeSummaryDigest(summary) } } : {}),
        afterTokens: estimateTextTokens(summary), message: "有界摘要已准备，等待原生压缩边界提交" }, ctx);
      return { summary };
    } catch (error) {
      if (operation) await this.rejectOperation(operation, error);
      this.fail("原生压缩兜底摘要失败", error);
      return { decline: true };
    }
  }

  /** 手动“立即整理上下文”。成功/无内容都返回真实结果，不伪报节省。 */
  async compressNow(ctx: Context): Promise<DurableCompactionOutcome> {
    if (this.mutating) return { applied: false, engine: "billion-context", estimated: true, skippedReason: "已有一次上下文整理正在进行" };
    this.mutating = true;
    try { return await this.runManualCompression(ctx); }
    finally { this.mutating = false; }
  }

  private async runManualCompression(ctx: Context): Promise<DurableCompactionOutcome> {
    if (this.disposed) return { applied: false, engine: "billion-context", estimated: true, skippedReason: "上下文管理已停用" };
    if (this.engine !== "billion-context") return { applied: false, engine: "native", estimated: true,
      skippedReason: "当前设置为按比例压缩（Pi 原生），未启用 billion-context 分层摘要" };
    if (this.manualAbort) return { applied: false, engine: "billion-context", estimated: true, skippedReason: "已有一次上下文整理正在进行" };
    const controller = new AbortController();
    this.manualAbort = controller;
    try {
      await this.ensureReady(ctx);
      if (!this.kernelState) return { applied: false, engine: "billion-context", estimated: true, skippedReason: "上下文状态尚未就绪" };
      const view = await this.host.conversation.context(ctx);
      const headEntryId = view.head?.id ?? null;
      if (headEntryId !== this.headEntryId || this.rebaseNeeded) await this.rebase(headEntryId, ctx, "boundary");
      const outcome = await this.maintainAndProject(view.messages, view.entries, this.host.models, ctx, { automatic: false, force: true, source: this.operationSource(view) });
      this.consecutiveFailures = 0;
      const result: DurableCompactionOutcome = outcome.folds > 0
        ? { applied: true, engine: "billion-context", beforeTokens: outcome.beforeTokens, afterTokens: outcome.afterTokens, estimated: true, blocks: outcome.blocks }
        : { applied: false, engine: "billion-context", beforeTokens: outcome.beforeTokens, estimated: true,
            skippedReason: outcome.skippedReason ?? "没有可整理的历史" };
      this.publish({ ...this.status, estimatedInputTokens: outcome.beforeTokens, blocks: outcome.blocks });
      return result;
    } catch (error) {
      const cancelled = controller.signal.aborted || isAbortError(error);
      if (cancelled) {
        // 取消是一个明确的终态，不是失败：保留已提交状态，只释放本次维护。
        if (this.status.phase !== "cancelled") this.publish({ ...this.status, phase: "cancelled", automatic: false, reason: "manual", message: "已取消", durable: false });
      } else {
        this.consecutiveFailures++;
        this.fail("手动上下文整理失败", error);
      }
      return { applied: false, engine: "billion-context", estimated: true,
        skippedReason: cancelled ? "已取消" : `整理失败：${errorText(error)}` };
    } finally {
      if (this.manualAbort === controller) this.manualAbort = undefined;
    }
  }

  /** 用户取消手动整理：只中止本次摘要模型调用，不伪装成完成。 */
  cancelMaintenance(): boolean {
    if (!this.manualAbort) return false;
    this.manualAbort.abort();
    return true;
  }

  private maintenanceSignal(ctx: Context): AbortSignal | undefined {
    const base = ctx.abortSignal;
    if (!this.manualAbort) return base;
    return base ? AbortSignal.any([base, this.manualAbort.signal]) : this.manualAbort.signal;
  }

  /** 关闭前强制落盘一次；失败必须向调用者报告，不能伪造跨重启恢复成功。 */
  async flush(ctx: Context): Promise<void> {
    if (this.mutating) return; // An unfinished operation already has a durable start; never flush staged coverage.
    this.mutating = true;
    try { await this.loading; await this.save(ctx, true); }
    finally { this.mutating = false; }
  }

  /** 原生压缩结束后通知管理器：下一次请求必须按新边界重建。 */
  markNativeCompaction(): void { this.rebaseNeeded = true; }

  async nativeCompactionCommitted(ctx: Context): Promise<void> {
    if (!this.loaded || this.mutating) return;
    this.mutating = true;
    try {
      const view = await this.host.conversation.context(ctx);
      if ((view.head?.id ?? null) !== this.headEntryId) await this.rebase(view.head?.id ?? null, ctx, "native-fallback");
    } finally { this.mutating = false; }
  }

  /** 某个原始 entry 当前代次/历史代次里的 ref，供模型引用。 */
  refsForEntry(entryId: number): string[] {
    const visible = this.mutating || this.loading ? this.committed : this.persisted;
    const refs = new Set<string>();
    for (const [ref, locator] of Object.entries(visible.refs)) if (locator.entryId === entryId) refs.add(ref);
    for (const archived of visible.archivedRefs) {
      for (const [ref, locator] of Object.entries(archived.refs)) if (locator.entryId === entryId) refs.add(ref);
    }
    return [...refs].sort();
  }

  /** 模型主动调用 compress 时的应用路径：摘要由模型给出，内核负责范围校验与分层。 */
  async applyModelCompression(
    input: { startRef: string; endRef: string; summary: string; topic?: string; expectedRevision?: number; expectedConfigDigest?: string },
    ctx: Context,
  ): Promise<{ ok: boolean; message: string }> {
    if (this.mutating) return { ok: false, message: "已有一次上下文整理正在进行，请稍后重试" };
    this.mutating = true;
    try { return await this.runModelCompression(input, ctx); }
    finally { this.mutating = false; }
  }

  private async runModelCompression(
    input: { startRef: string; endRef: string; summary: string; topic?: string; expectedRevision?: number; expectedConfigDigest?: string }, ctx: Context,
  ): Promise<{ ok: boolean; message: string }> {
    if (this.engine !== "billion-context") return { ok: false, message: "当前设置为按比例压缩（Pi 原生），未启用 billion-context" };
    await this.ensureReady(ctx);
    const view = await this.host.conversation.context(ctx);
    if ((view.head?.id ?? null) !== this.headEntryId || this.rebaseNeeded) await this.rebase(view.head?.id ?? null, ctx, "boundary");
    if ((input.expectedRevision !== undefined && input.expectedRevision !== (this.committed.revision ?? 0))
      || (input.expectedConfigDigest !== undefined && input.expectedConfigDigest !== this.configDigest())) {
      return { ok: false, message: "上下文视图或配置版本已变化，请先调用 acp_status 重新读取 revision/configDigest 后重试" };
    }
    const state = this.kernelState;
    if (!state) return { ok: false, message: "上下文状态尚未就绪，请稍后重试" };
    const build = this.buildCoreMessages(view.messages, view.entries);
    const config = this.buildConfig(this.resolvePolicy().window, build.protectedIds);
    const applied = this.core.applyCompression({
      ranges: [{ startRef: input.startRef, endRef: input.endRef, summary: input.summary, ...(input.topic ? { topic: input.topic } : {}) }],
      messages: build.messages, state, config,
    });
    const result = applied.result;
    if (result.blocksCreated === 0) {
      return { ok: false, message: result.noop ? "该范围已被摘要覆盖（no-op），无需重复压缩" : `没有折叠任何范围：${result.errors.join("；") || "范围不可压缩"}` };
    }
    const projected = this.renderProjected(build, applied.state);
    if (projected.messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0)
      >= view.messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0)) {
      return { ok: false, message: "摘要没有减少实际输入，未提交压缩结果" };
    }
    const operation = await this.beginOperation(ctx, "manual", false, view.messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0), this.operationSource(view));
    try {
      this.kernelState = applied.state;
      this.indexRefs(applied.state);
      this.recordSummaries(applied.state);
      await this.finishOperation(operation, { phase: "completed", blocks: countTopLevelBlocks(applied.state),
        afterTokens: projected.messages.reduce((sum, message) => sum + estimateMessageTokens(message), 0),
        message: `模型压缩：${result.blocksCreated} 个摘要块` }, ctx);
    } catch (error) { await this.rejectOperation(operation, error); throw error; }
    return { ok: true, message: `已创建 ${result.blocksCreated} 个摘要块（压缩 ${result.tokensCompressed} tokens）${result.warnings.length ? `；提示：${result.warnings.join("；")}` : ""}` };
  }

  /** 内核状态与原文的只读查询，供 acp_status / acp_search / acp_retrieve 使用。 */
  async readState(ctx: Context): Promise<CompressionState | undefined> {
    await this.ensureReady(ctx);
    return this.mutating ? parseKernelState(this.committed) : this.kernelState;
  }

  /** Status inspection is passive, even before the manager has performed its first maintenance. */
  readStatusSnapshot(): { status: ContextManagementStatusDto; state: CompressionState | undefined } {
    return { status: this.statusSnapshot(), state: this.mutating || this.loading ? parseKernelState(this.committed) : this.kernelState ?? parseKernelState(this.persisted) };
  }

  async searchSummaries(query: string, limit: number, ctx: Context): Promise<Array<{ blockId: string; refs: string; topic?: string; summary: string; entryIds: number[] }>> {
    const state = await this.readState(ctx);
    if (!state) return [];
    const results = searchBlocks(blockDocs(state), query, { limit: Math.min(20, Math.max(1, limit)) });
    return results.map(result => {
      const blockId = result.blockId ?? (result.ref.startsWith("b") ? result.ref : undefined);
      const block = blockId ? state.blocks.find(item => item.blockId === blockId) : undefined;
      return {
        blockId: blockId ?? result.ref,
        refs: block ? this.blockRefSpan(block) : result.ref,
        ...(block?.topic ? { topic: block.topic } : {}),
        summary: block?.summary ?? result.preview,
        entryIds: block ? this.blockEntryIds(block) : [],
      };
    });
  }

  /** 通过 ref / blockId / entryId 取回原始 entry 文本，分页且有上限。 */
  async retrieveOriginal(input: { ref?: string; blockId?: string; entryId?: number; offset?: number; limit?: number; cursor?: string }, api: ToolReader, ctx: Context): Promise<{ text: string; entryIds: number[]; page?: { offset: number; total?: number; nextCursor?: string } }> {
    await this.ensureReady(ctx);
    const entryIds = await this.resolveEntryIds(input, ctx);
    const target = JSON.stringify([this.persisted.sessionId, this.conversationId, input.ref, input.blockId, input.entryId, entryIds]);
    let index = 0;
    let skip = Math.max(0, Math.floor(input.offset ?? 0));
    let offset = skip;
    if (input.cursor) {
      let cursor: { version: number; target: string; index: number; skip: number; offset: number };
      try { cursor = JSON.parse(Buffer.from(input.cursor, "base64url").toString("utf8")); }
      catch { throw new Error("原文分页 cursor 无效，请重新读取第一页"); }
      if (!cursor || cursor.version !== 2 || cursor.target !== target || ![cursor.index, cursor.skip, cursor.offset].every(n => Number.isSafeInteger(n) && n >= 0) || cursor.index >= entryIds.length) {
        throw new Error("原文分页 cursor 已失效或与会话/查询目标不一致，请重新读取第一页");
      }
      ({ index, skip, offset } = cursor);
    }
    if (!entryIds.length) return { text: "", entryIds: [] };
    const limit = Math.min(12_000, Math.max(200, Math.floor(input.limit ?? 8_000)));
    const parts: string[] = [];
    const readIds: number[] = [];
    let length = 0;
    let scanned = 0;
    for (; index < entryIds.length && length < limit && scanned < 16; index++) {
      const entry = await api.entry(entryIds[index]!, ctx);
      scanned++;
      if (!entry) continue;
      readIds.push(entry.id);
      const full = `${index ? "\n\n" : ""}[entry ${entry.id} · ${entry.kind}]\n${entryText(entry)}`;
      if (skip >= full.length) { skip -= full.length; continue; }
      const text = full.slice(skip, skip + limit - length);
      parts.push(text);
      length += text.length;
      skip += text.length;
      if (skip < full.length) break;
      skip = 0;
    }
    const nextCursor = index < entryIds.length
      ? Buffer.from(JSON.stringify({ version: 2, target, index, skip, offset: offset + length })).toString("base64url")
      : undefined;
    return { text: parts.join(""), entryIds: readIds, page: { offset,
      ...(nextCursor ? { nextCursor } : { total: offset + length }) } };
  }

  private async resolveEntryIds(input: { ref?: string; blockId?: string; entryId?: number }, ctx: Context): Promise<number[]> {
    if (input.entryId !== undefined) return [input.entryId];
    const state = await this.readState(ctx);
    if (!state) return [];
    if (input.blockId) {
      const block = state.blocks.find(item => item.blockId === input.blockId);
      const visible = this.mutating ? this.committed : this.persisted;
      if (block) return this.blockEntryIds(block);
      const mirror = visible.summaries.find(item => item.blockId === input.blockId);
      if (mirror) return mirror.entryIds;
      return [...(await this.host.archiveReader?.snapshot(DurableContextBlockArchive, this.host.conversation.id, input.blockId, ctx))?.entryIds ?? []];
    }
    if (input.ref) {
      const locator = await this.lookupRef(input.ref, ctx);
      if (locator) return [locator.entryId];
      // block 级 ref（m00012–m00020）或未知 ref：在摘要块覆盖范围内回退。
      const block = state.blocks.find(item => this.blockRefSpan(item) === input.ref);
      return block ? this.blockEntryIds(block) : [];
    }
    return [];
  }

  private async lookupRef(ref: string, ctx: Context): Promise<DurableContextRefLocator | undefined> {
    const visible = this.mutating ? this.committed : this.persisted;
    const kernel = this.mutating ? parseKernelState(this.committed) : this.kernelState;
    const rawId = kernel?.messageRefs.byRef[ref];
    const archived = await this.host.archiveReader?.snapshot(DurableContextRefArchive, this.host.conversation.id, ref, ctx);
    const candidates = [rawId ? this.locatorOfRawId(rawId) : undefined, visible.refs[ref], ...visible.archivedRefs.map(item => item.refs[ref]), ...archived?.locators ?? []]
      .filter((item): item is DurableContextRefLocator => Boolean(item));
    const first = candidates[0];
    if (first && candidates.some(item => item.entryId !== first.entryId || item.slot !== first.slot)) {
      throw new Error("该旧 ref 在历史代次中有歧义，请用 acp_search 查得明确 entryId 后回查原文");
    }
    return first;
  }

  private blockEntryIds(block: CompressionBlock): number[] {
    const ids = new Set<number>();
    for (const rawId of block.effectiveMessageIds) {
      const locator = this.locatorOfRawId(rawId);
      if (locator) ids.add(locator.entryId);
    }
    return [...ids].sort((a, b) => a - b);
  }

  private blockRefSpan(block: CompressionBlock, state = this.kernelState): string {
    if (!state) return "";
    const refs = block.effectiveMessageIds.map(id => state.messageRefs.byRaw[id]).filter((ref): ref is string => Boolean(ref));
    if (!refs.length) return "";
    return summaryRefSpan(refs[0]!, refs[refs.length - 1]!);
  }

  private locatorOfRawId(rawId: string): DurableContextRefLocator | undefined {
    if (!rawId.startsWith("e")) return undefined;
    const match = /^e(\d+):(\d+)(?:\.(?:t|c\d+))?$/.exec(rawId);
    if (!match) return undefined;
    const entryId = Number(match[1]);
    const slot = Number(match[2]);
    if (!Number.isSafeInteger(entryId) || !Number.isSafeInteger(slot)) return undefined;
    return { entryId, slot, role: "unknown" };
  }

  /** @internal 投影 + 自动整理主流程。 */
  private async maintainAndProject(
    messages: readonly Message[],
    entries: readonly EntryRecord[],
    models: Models,
    ctx: Context,
    options: { automatic: boolean; force?: boolean; source?: OperationSource },
  ): Promise<TurnOutcome & { processed: number }> {
    if (!this.kernelState) throw new Error("上下文状态尚未初始化");
    const policy = this.resolvePolicy();
    const build = this.buildCoreMessages(messages, entries);
    const measured = estimateContextTokens(messages);
    const toolTokens = this.host.toolEstimateTokens?.() ?? 0;
    // 分支/复制历史里的 assistant usage 描述的是源会话当时的投影，不是本分支的当前输入：
    // 取「最近 usage」与「逐条消息独立估算」的较大值，避免用过期 usage 低估真实出站体积。
    const estimatedMessages = messages.reduce((total, message) => total + estimateMessageTokens(message), 0);
    const beforeTokens = Math.max(measured.tokens, estimatedMessages) + toolTokens;
    if (!build.messages.length) {
      if (options.force) {
        const operation = await this.beginOperation(ctx, "manual", false, beforeTokens, options.source);
        try { await this.finishOperation(operation, { phase: "skipped", message: "没有可整理的历史", blocks: 0 }, ctx); }
        catch (error) { await this.rejectOperation(operation, error); throw error; }
      }
      return {
        state: this.kernelState, projected: messages, projectedApplied: false, folds: 0,
        blocks: countTopLevelBlocks(this.kernelState), beforeTokens, afterTokens: beforeTokens,
        processed: 0, skippedReason: "没有可整理的历史",
      };
    }
    let state = this.kernelState;
    const turn = this.core.processTurn({
      messages: build.messages,
      state,
      config: this.buildConfig(policy.window, build.protectedIds),
      tokenCount: beforeTokens,
      tokenCountSource: measured.lastUsageIndex !== null && measured.tokens >= estimatedMessages ? "usage" : "estimate",
      renderTags: "none",
    });
    state = turn.state;
    let folds = 0;
    let tokensCompressed = 0;
    const ranges = turn.nudge?.compressibleRanges ?? [];
    const safeTrigger = Math.min(policy.triggerTokens, Math.max(0, policy.window - this.requestReserve(policy.window)));
    const pressure = beforeTokens > safeTrigger;
    const knownGrowth = Boolean(turn.nudge?.shouldInject);
    const reason = options.force ? "manual" : pressure ? "threshold" : "growth";
    const operation = options.force || (ranges.length > 0 && (pressure || knownGrowth))
      ? await this.beginOperation(ctx, reason, options.automatic, beforeTokens, options.source) : undefined;
    try {
    let skippedReason: string | undefined;
    if (!ranges.length) {
      skippedReason = this.describeNothingToCompress(turn.state, build.messages.length);
    } else if (pressure || knownGrowth || options.force) {
      const target = Math.max(2_048, Math.floor(safeTrigger * 0.7));
      const chosen = selectRanges(ranges, target);
      const model = await this.resolveModel(models, ctx);
      const appliedRanges: Array<{ startRef: string; endRef: string; summary: string; topic?: string }> = [];
      for (const range of chosen) {
        const text = this.rangeText(range, turn.state, build.messages);
        if (!text.trim()) continue;
        const summary = await this.summarizeMessages([
          { role: "user", content: text, timestamp: Date.now() } as Message,
        ], Math.max(6_000, Math.floor(policy.window * 0.3)), model, models, ctx);
        const topic = firstLine(text).slice(0, 120);
        appliedRanges.push({ startRef: range.startRef, endRef: range.endRef, summary, ...(topic ? { topic } : {}) });
      }
      if (appliedRanges.length) {
        const applied = this.core.applyCompression({ ranges: appliedRanges, messages: build.messages, state, config: this.buildConfig(policy.window, build.protectedIds) });
        state = applied.state;
        folds = applied.result.blocksCreated;
        // applyCompression 已经产出新 state；不需要第二次 processTurn 重新跑完整管线。
        tokensCompressed = applied.result.tokensCompressed;
      } else {
        skippedReason = "推荐范围没有可读原文";
      }
    } else {
      skippedReason = beforeTokens <= policy.triggerTokens ? "尚未达到整理阈值" : undefined;
    }
    const rendered = this.renderProjected(build, state);
    const afterTokens = rendered.messages.reduce((total, message) => total + estimateMessageTokens(message), 0) + toolTokens;
    if (folds > 0 && afterTokens >= estimatedMessages + toolTokens) throw new Error("摘要没有减少实际输入，未提交压缩结果");
    this.kernelState = state;
    this.persisted.stats.folds += folds;
    this.persisted.stats.tokensCompressed += tokensCompressed;
    this.persisted.watermarkEntryId = Math.max(this.persisted.watermarkEntryId, highestEntryId(entries));
    this.indexRefs(state);
    this.recordSummaries(state);
    this.persisted.headEntryId = this.headEntryId;
    this.persisted.configDigest = this.configDigest();
    this.persisted.stats.rounds += 1;
    if (folds > 0 || options.force) {
      this.persisted.stats.lastBeforeTokens = beforeTokens;
      this.persisted.stats.lastAfterTokens = afterTokens;
    }
    if (operation) {
      await this.finishOperation(operation, { phase: folds > 0 ? "completed" : "skipped",
        beforeTokens, afterTokens: folds > 0 ? afterTokens : undefined, blocks: countTopLevelBlocks(state),
        message: skippedReason }, ctx);
    } else await this.save(ctx, folds > 0);
    return {
      state, projected: rendered.messages, projectedApplied: rendered.applied, folds, blocks: countTopLevelBlocks(state),
      beforeTokens, afterTokens, processed: build.messages.length,
      reason: folds > 0 ? (options.force ? "manual" : pressure ? "threshold" : "growth") : undefined,
      skippedReason,
    };
    } catch (error) {
      if (operation) await this.rejectOperation(operation, error);
      throw error;
    }
  }

  private describeNothingToCompress(state: CompressionState, messageCount: number): string {
    if (messageCount <= 4) return "历史太短，没有可整理内容";
    if (countTopLevelBlocks(state) > 0) return "当前历史都已被摘要覆盖";
    return "没有可整理的历史";
  }

  private buildCoreMessages(messages: readonly Message[], entries: readonly EntryRecord[]): CoreBuild {
    const locators = new Map<string, Array<{ entryId: number; slot: number }>>();
    for (const entry of entries) {
      for (let slot = 0; slot < (entry.model?.length ?? 0); slot++) {
        const message = entry.model![slot]!;
        const key = JSON.stringify(message);
        const list = locators.get(key) ?? [];
        list.push({ entryId: entry.id, slot });
        locators.set(key, list);
      }
    }
    const out: CoreMessage[] = [];
    const mappings: MessageMapping[] = [];
    const protectedIds = new Set<string>();
    let ephemeral = 0;
    for (const message of messages) {
      const key = JSON.stringify(message);
      const list = locators.get(key);
      const locator = list?.shift();
      const baseId = locator ? `e${locator.entryId}:${locator.slot}` : `x${ephemeral++}`;
      const coreIds: string[] = [];
      const emit = (id: string, role: CoreMessage["role"], contentType: CoreMessage["contentType"], text: string, extra?: Partial<CoreMessage>) => {
        out.push({
          id, role, contentType, text,
          ts: typeof message.timestamp === "number" ? message.timestamp : undefined,
          ...extra,
        } as CoreMessage);
        coreIds.push(id);
      };
      if (message.role === "user") {
        emit(baseId, "user", "text", flattenContent(message.content));
        if (!locator) protectedIds.add(baseId);
      } else if (message.role === "assistant") {
        const parts = message.content as Array<{ type: string; text?: string; thinking?: string; redactedThinking?: string }>;
        const textParts = parts.filter(part => part.type === "text").map(part => part.text ?? "");
        const thinkingParts = parts.filter(part => part.type === "thinking" || part.type === "redactedThinking")
          .map(part => part.thinking ?? part.redactedThinking ?? "");
        const calls = message.content.filter((part): part is Extract<typeof part, { type: "toolCall" }> => part.type === "toolCall");
        const thinkingTokens = thinkingParts.length ? estimateTextTokens(thinkingParts.join("\n")) : 0;
        if (textParts.length || !calls.length) {
          emit(`${baseId}.t`, "assistant", "text", textParts.join("\n"), thinkingTokens > 0 ? { thinkingTokens } : undefined);
        }
        calls.forEach((call, index) => emit(`${baseId}.c${index}`, "assistant", "tool-call", JSON.stringify(call.arguments ?? {}), {
          toolName: call.name, toolCallId: call.id,
        }));
        if (!textParts.length && calls.length && thinkingTokens > 0) {
          // thinking 载荷随原消息重放；挂到其中一个 core 上只用于计量，不参与折叠渲染。
          const first = out[out.length - calls.length];
          if (first) first.thinkingTokens = thinkingTokens;
        }
      } else if (message.role === "toolResult") {
        const text = flattenContent(message.content);
        emit(baseId, "tool", "tool-result", text, { toolName: message.toolName, toolCallId: message.toolCallId });
        if (message.content.some(part => part.type === "image")) protectedIds.add(baseId);
      } else {
        emit(baseId, "system", "text", flattenContent(message.content));
        protectedIds.add(baseId);
      }
      if (!locator || (message.role === "user" && Array.isArray(message.content) && message.content.some(part => part.type === "image"))) {
        for (const id of coreIds) protectedIds.add(id);
      }
      mappings.push({ message, coreIds, ...(locator ? { locator } : {}) });
    }
    const resultIds = new Set(out.filter(message => message.contentType === "tool-result").map(message => message.toolCallId));
    for (const mapping of mappings) {
      if (mapping.message.role !== "assistant") continue;
      const calls = mapping.message.content.filter(part => part.type === "toolCall");
      if (calls.some(call => !resultIds.has(call.id))) for (const id of mapping.coreIds) protectedIds.add(id);
    }
    return { messages: out, mappings, protectedIds };
  }

  private buildConfig(window: number, protectedIds: Set<string>): Config {
    const config = defaultConfig(window > 1 ? window : 100_000);
    config.preserveRecentMessages = 3;
    config.modelContextLimit = window > 1 ? window : 100_000;
    config.isMessageProtected = message => protectedIds.has(message.id) || message.role === "system";
    return config;
  }

  private indexRefs(state: CompressionState): void {
    const additions: Record<string, DurableContextRefLocator> = {};
    for (const [ref, rawId] of Object.entries(state.messageRefs.byRef)) {
      const locator = this.locatorOfRawId(rawId);
      if (locator) additions[ref] = locator;
    }
    mergeRefLocators(this.persisted.refs, additions);
    this.pruneRefs();
  }

  /** refs 只服务摘要/回查：长期保留会无界增长；保留摘要覆盖的 entry 与最近窗口，其余可丢弃。 */
  private pruneRefs(): void {
    const total = Object.keys(this.persisted.refs).length;
    if (total <= MAX_PERSISTED_REFS) return;
    const keepEntries = new Set<number>();
    for (const summary of this.persisted.summaries) for (const id of summary.entryIds) keepEntries.add(id);
    const recentFloor = this.persisted.watermarkEntryId - RECENT_REF_WINDOW;
    for (const [ref, locator] of Object.entries(this.persisted.refs)) {
      if (keepEntries.has(locator.entryId) || locator.entryId > recentFloor) continue;
      delete this.persisted.refs[ref];
    }
  }

  private recordSummaries(state: CompressionState): void {
    const known = new Set(this.persisted.summaries.map(item => item.blockId));
    for (const block of state.blocks) {
      if (!block.active || known.has(block.blockId)) continue;
      const refs = block.effectiveMessageIds
        .map(id => state.messageRefs.byRaw[id])
        .filter((ref): ref is string => Boolean(ref));
      this.persisted.summaries.push({
        blockId: block.blockId,
        refs: refs.length ? summaryRefSpan(refs[0]!, refs[refs.length - 1]!) : "",
        entryIds: this.blockEntryIds(block),
        tokens: Math.max(0, block.compressedTokens ?? 0),
        createdAt: block.createdAt ?? Date.now(),
        ...(block.topic ? { topic: block.topic } : {}),
        tier: block.tier,
        epoch: this.persisted.epoch,
      });
    }
    if (this.persisted.summaries.length > 200) this.persisted.summaries.splice(0, this.persisted.summaries.length - 200);
  }

  /** 把内核覆盖关系还原成真实 provider 消息：只替换被覆盖的原消息，证据注入保持原样。 */
  private renderProjected(build: CoreBuild, state: CompressionState): { messages: readonly Message[]; applied: boolean } {
    const top = topLevelBlocks(state);
    const blockByCoreId = new Map<string, CompressionBlock>();
    for (const block of top) {
      for (const id of block.effectiveMessageIds) blockByCoreId.set(id, block);
    }
    // A provider message is indivisible: partial coverage must never drop sibling tool calls,
    // thinking/signature parts, or leave a result without its call.
    const invalid = new Set<string>();
    for (const mapping of build.mappings) {
      const covered = mapping.coreIds.map(id => blockByCoreId.get(id));
      const block = covered.find(Boolean);
      if (block && covered.some(item => item?.blockId !== block.blockId)) invalid.add(block.blockId);
    }
    if (invalid.size) throw new Error("摘要范围拆分了同一条原生消息，请使用包含完整消息与工具批次的范围");
    const rendered: Message[] = [];
    const emitted = new Set<string>();
    for (const mapping of build.mappings) {
      const block = mapping.coreIds.map(id => blockByCoreId.get(id)).find((item): item is CompressionBlock => Boolean(item));
      if (!block) { rendered.push(mapping.message); continue; }
      if (emitted.has(block.blockId)) continue;
      emitted.add(block.blockId);
      rendered.push(this.summaryMessage(block, state));
    }
    const visibleCalls = new Set(rendered.flatMap(message => message.role === "assistant"
      ? message.content.flatMap(part => part.type === "toolCall" ? [part.id] : []) : []));
    const originalCalls = new Set(build.mappings.flatMap(mapping => mapping.message.role === "assistant"
      ? mapping.message.content.flatMap(part => part.type === "toolCall" ? [part.id] : []) : []));
    for (const message of rendered) {
      if (message.role === "toolResult" && originalCalls.has(message.toolCallId) && !visibleCalls.has(message.toolCallId)) {
        throw new Error("摘要范围拆分了工具调用与结果，未提交压缩结果");
      }
    }
    const visibleResults = new Set(rendered.flatMap(message => message.role === "toolResult" ? [message.toolCallId] : []));
    const originalResults = new Set(build.mappings.flatMap(mapping => mapping.message.role === "toolResult" ? [mapping.message.toolCallId] : []));
    for (const id of visibleCalls) if (originalResults.has(id) && !visibleResults.has(id)) {
      throw new Error("摘要范围拆分了工具调用与结果，未提交压缩结果");
    }
    return { messages: rendered, applied: emitted.size > 0 };
  }

  private summaryMessage(block: CompressionBlock, state: CompressionState): Message {
    const refs = this.blockRefSpan(block, state);
    const entryIds = this.blockEntryIds(block);
    const where = [
      refs ? `refs ${refs}` : undefined,
      entryIds.length ? `original entries ${entryIds.join(", ")}` : undefined,
    ].filter(Boolean).join("; ");
    const text = `${SUMMARY_MARKER} — ${block.topic ?? block.blockId}\n${block.summary}\n\n`
      + `[block ${block.blockId}${where ? `; ${where}` : ""}; this is a summary. Use acp_retrieve (ref/blockId) or acp_search (scope=originals) to read exact original text.]`;
    return { role: "user", content: text, timestamp: block.createdAt ?? Date.now() } as Message;
  }

  private rangeText(range: CompressibleRange, state: CompressionState, messages: readonly CoreMessage[]): string {
    const start = refIndex(range.startRef);
    const end = refIndex(range.endRef);
    if (start === undefined || end === undefined) return "";
    const byId = new Map(messages.map(message => [message.id, message]));
    const parts: string[] = [];
    for (let index = start; index <= end; index++) {
      const ref = `m${String(index).padStart(5, "0")}`;
      const rawId = state.messageRefs.byRef[ref];
      const message = rawId ? byId.get(rawId) : undefined;
      if (message?.text) parts.push(`${message.role}: ${message.text}`);
    }
    return parts.join("\n\n");
  }

  /** 有界摘要：单次输入超过 chunkBudget 时分块滚动摘要，合并请求本身也受窗口约束。 */
  private async summarizeMessages(
    messages: readonly Message[],
    chunkBudget: number,
    model: unknown,
    models: Models,
    ctx: Context,
  ): Promise<string> {
    const window = this.resolvePolicy().window;
    const budget = Math.min(chunkBudget, 24_000, window - 1_500 - estimateTextTokens(SUMMARIZER_SYSTEM) - 1_024);
    if (budget < 256) throw new Error("当前模型窗口不足以执行有界摘要");
    const chunks = splitByTokens(messages, budget);
    const summaries: string[] = [];
    for (const chunk of chunks) {
      summaries.push(await this.callSummarizer(chunk, model, models, ctx));
    }
    if (summaries.length === 1) return summaries[0]!;
    let merged = summaries.join("\n\n---\n\n");
    for (let round = 0; round < 6; round++) {
      if (estimateTextTokens(merged) <= budget) return this.callSummarizer(merged, model, models, ctx, true);
      const parts: string[] = [];
      for (const chunk of splitByText(merged, budget)) parts.push(await this.callSummarizer(chunk, model, models, ctx, true));
      const reduced = parts.join("\n\n");
      if (estimateTextTokens(reduced) >= estimateTextTokens(merged)) throw new Error("摘要合并没有减少输入，已停止重试");
      merged = reduced;
    }
    throw new Error("摘要合并达到安全重试上限");
  }

  private async callSummarizer(input: string, model: unknown, models: Models, ctx: Context, merge = false): Promise<string> {
    const prompt = merge
      ? `Merge these partial summaries into one coherent summary. Keep every concrete detail (paths, versions, errors, decisions, open tasks) and output only the merged summary.\n\n${input}`
      : `<conversation>\n${input}\n</conversation>\n\nSummarize this section so another assistant can continue the task without re-reading it.`;
    const signal = this.maintenanceSignal(ctx);
    signal?.throwIfAborted();
    const result = await models.completeSimple(model as never, {
      messages: [
        { role: "system", content: SUMMARIZER_SYSTEM, timestamp: Date.now() },
        { role: "user", content: prompt, timestamp: Date.now() },
      ],
    }, {
      maxTokens: 1_500,
      cacheRetention: "none",
      signal,
    }) as AssistantMessage;
    signal?.throwIfAborted();
    const text = result.content.flatMap(part => part.type === "text" ? [part.text] : []).join("\n").trim();
    if (result.stopReason !== "stop" || !text) {
      throw new Error(`摘要模型没有返回有效摘要（${result.stopReason ?? "unknown"}）`);
    }
    return text;
  }

  private async resolveModel(models: Models, ctx: Context): Promise<unknown> {
    const agent = await this.host.conversation.agent(ctx);
    const ref = agent.model;
    if (!ref) throw new Error("当前会话没有可用模型");
    const model = models.getModel(ref.provider, ref.modelId);
    if (!model) throw new Error(`找不到当前模型 ${ref.provider}/${ref.modelId}`);
    return model;
  }

  private publish(status: ContextManagementStatusDto): void {
    // Pressure telemetry is ephemeral. It must not invent a revision or erase the durable terminal result.
    this.status = { ...status, revision: this.committed.revision ?? status.revision ?? 0 };
    const now = Date.now();
    if (now - this.lastPublished < 300 && status.phase === "idle") return;
    this.lastPublished = now;
    try { this.host.onStatus?.(this.statusSnapshot()); }
    catch (error) { this.log("[Context] 状态回调失败", error); }
  }

  private fail(message: string, error: unknown): void {
    if (error instanceof StaleContextOperation || this.disposed) return;
    this.log(`[Context] ${message}`, error);
    if ((this.status.phase === "failed" || this.status.phase === "cancelled") && this.status.durable
      && this.committed.lastOperation?.phase === this.status.phase) return;
    this.publish({ ...this.status, phase: "failed", lastError: errorText(error), message, durable: false });
  }

  dispose(): void { this.disposed = true; this.manualAbort?.abort(); }
}

/** A text prefix may retire only complete original exchanges. Synthetic missing results in a
 * ContextView do not prove completion, so inspect the original entry payloads, not repaired messages. */
function safeSummaryPrefix(entries: readonly EntryRecord[]): boolean {
  const calls = new Set<string>();
  const results = new Set<string>();
  for (const entry of entries) for (const message of entry.model ?? []) {
    if (Array.isArray(message.content)) for (const part of message.content) {
      if (part.type !== "text" && part.type !== "toolCall") return false;
      if (part.type === "toolCall") {
        if (calls.has(part.id)) return false;
        calls.add(part.id);
      }
    }
    if (message.role === "toolResult") {
      if (results.has(message.toolCallId)) return false;
      results.add(message.toolCallId);
    }
  }
  return [...calls].every(id => results.has(id)) && [...results].every(id => calls.has(id));
}

export interface ToolReader {
  entry(id: number, ctx: Context): Promise<EntryRecord | undefined>;
}

class StaleContextOperation extends Error {
  constructor(readonly current: DurableContextPersistedState) { super("上下文整理操作已过期，较新状态已保留，请重试"); }
}

function viewDigest(messages: readonly Message[]): string {
  return createHash("sha256").update(JSON.stringify(messages)).digest("hex");
}

function toSummaryDto(record: DurableContextPersistedState["summaries"][number]): ContextManagementSummaryDto {
  return { blockId: record.blockId, refs: record.refs, entryIds: record.entryIds, tokens: record.tokens,
    createdAt: record.createdAt, ...(record.topic ? { topic: record.topic } : {}) };
}

function estimateMessages(messages: readonly Message[]): number {
  return estimateContextTokens(messages).tokens;
}

function flattenContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(part => {
    if (!part || typeof part !== "object") return "";
    const typed = part as { type?: string; text?: string; name?: string; arguments?: unknown; thinking?: string };
    if (typed.type === "text") return typed.text ?? "";
    if (typed.type === "thinking") return `[thinking] ${typed.thinking ?? ""}`;
    if (typed.type === "image") return "[image attachment]";
    if (typed.type === "toolCall") return `[tool ${typed.name ?? ""} ${JSON.stringify(typed.arguments ?? {})}]`;
    return "";
  }).join("\n");
}

export function entryText(entry: EntryRecord): string {
  return (entry.model ?? []).map(message => {
    const content = flattenContent(message.content);
    if (message.role === "assistant") return `assistant: ${content}`;
    if (message.role === "toolResult") return `tool ${message.toolName} (${message.toolCallId}): ${content}`;
    return `${message.role}: ${content}`;
  }).join("\n\n");
}

function highestEntryId(entries: readonly EntryRecord[]): number {
  let max = 0;
  for (const entry of entries) if (entry.id > max) max = entry.id;
  return max;
}

export function activeTopLevelBlocks(state: CompressionState): CompressionBlock[] { return topLevelBlocks(state); }

function topLevelBlocks(state: CompressionState): CompressionBlock[] {
  const active = activeBlocks(state);
  const nested = new Set<string>();
  for (const block of active) for (const child of block.directBlockIds) nested.add(child);
  return active.filter(block => !nested.has(block.blockId)).sort((a, b) => {
    const aRef = minRefIndex(a);
    const bRef = minRefIndex(b);
    return (aRef ?? 0) - (bRef ?? 0);
  });
}

function minRefIndex(block: CompressionBlock): number | undefined {
  let min: number | undefined;
  for (const ref of [...(block.startRef ? [block.startRef] : []), ...block.effectiveMessageIds.filter(id => id.startsWith("m"))]) {
    const index = refIndex(ref);
    if (index !== undefined && (min === undefined || index < min)) min = index;
  }
  return min;
}

export function refIndex(ref: string): number | undefined {
  const match = /^m(\d{1,7})$/.exec(ref);
  if (!match) return undefined;
  const value = Number(match[1]);
  return Number.isSafeInteger(value) ? value : undefined;
}

function countTopLevelBlocks(state: CompressionState): number { return topLevelBlocks(state).length; }

function selectRanges(ranges: readonly CompressibleRange[], targetTokens: number): CompressibleRange[] {
  const chosen: CompressibleRange[] = [];
  let saved = 0;
  for (const range of ranges.slice(0, 6)) {
    chosen.push(range);
    saved += Math.max(0, range.tokens - 200);
    if (saved >= targetTokens) break;
  }
  return chosen.slice(0, 3);
}

export function splitByTokens(messages: readonly Message[], budget: number): string[] {
  const chunks: string[] = [];
  let current = "";
  for (const message of messages) {
    for (const text of splitByText(messageTextForSummary(message), budget)) {
      const joined = current ? `${current}\n\n${text}` : text;
      if (current && estimateTextTokens(joined) > budget) { chunks.push(current); current = text; }
      else current = joined;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

export function splitByText(text: string, budget: number): string[] {
  if (!Number.isFinite(budget) || budget < 1) throw new Error("Invalid summary chunk budget");
  const chunks: string[] = [];
  let start = 0;
  while (start < text.length) {
    let low = 1;
    let high = Math.min(text.length - start, Math.floor(budget * 4));
    while (low < high) {
      const mid = Math.ceil((low + high) / 2);
      if (estimateTextTokens(text.slice(start, start + mid)) <= budget) low = mid;
      else high = mid - 1;
    }
    // Do not cut a surrogate pair (emoji/non-BMP characters) in half.
    let length = low;
    const last = text.charCodeAt(start + length - 1);
    if (length > 1 && last >= 0xd800 && last <= 0xdbff && start + length < text.length) length--;
    const chunk = text.slice(start, start + length);
    if (estimateTextTokens(chunk) > budget) throw new Error("A summary character exceeds the available budget");
    chunks.push(chunk);
    start += length;
  }
  return chunks;
}

function messageTextForSummary(message: Message): string {
  const text = flattenContent(message.content);
  if (message.role === "assistant") {
    const calls = message.content.flatMap(part => part.type === "toolCall" ? [`[tool ${part.name} ${JSON.stringify(part.arguments ?? {})}]`] : []);
    return [`assistant: ${text}`, ...calls].filter(Boolean).join("\n");
  }
  if (message.role === "toolResult") return `tool ${message.toolName}: ${text}`;
  return `${message.role}: ${text}`;
}

function firstLine(text: string): string {
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed) return trimmed;
  }
  return "";
}

function errorText(error: unknown): string {
  return error instanceof Error ? `${error.name}: ${error.message}` : String(error);
}

function isAbortError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const name = (error as { name?: unknown }).name;
  const code = (error as { code?: unknown }).code;
  return name === "AbortError" || code === "ABORT_ERR";
}
