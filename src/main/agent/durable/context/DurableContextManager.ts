import type { Context } from "@earendil-works/chord/context";
import type { AssistantMessage, Message, Models } from "@earendil-works/pi-ai";
import { estimateContextTokens, estimateMessageTokens, estimateTextTokens } from "@earendil-works/pi-ai/utils/estimate";
import type { CompactionReason, Conversation, EntryRecord, HookApi } from "@earendil-works/pi-durable";
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
  contextConfigDigest, DurableContextStateDoc, emptyPersistedState, mergeRefLocators, parseKernelState,
  serializeKernelState, summaryRefSpan,
  type DurableContextPersistedState, type DurableContextRefLocator,
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
  onStatus?: (status: ContextManagementStatusDto) => void;
  log?: (message: string, error?: unknown) => void;
  /** 只读估算：当前工具 schema 的字符数（避免循环依赖 pi 内部）。 */
  contextId?: string;
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

/**
 * Durable 会话的上下文管理协调点。
 * 内核只做纯数据变换；摘要由本类调用当前模型生成；原文始终留在 Durable entry 中。
 */
export class DurableContextManager {
  private readonly core: CompressionCore = createCore({});
  private persisted: DurableContextPersistedState = emptyPersistedState();
  private kernelState?: CompressionState;
  private loaded = false;
  private loading?: Promise<void>;
  private headEntryId: number | null = null;
  private rebaseNeeded = true;
  private consecutiveFailures = 0;
  private disposed = false;
  private status: ContextManagementStatusDto;
  private lastPublished = 0;
  private operationCounter = 0;
  /** 手动整理的取消句柄；取消只停止本次维护，不影响任务停止语义。 */
  private manualAbort?: AbortController;

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
    return {
      ...this.status,
      engine,
      enabled: engine === "billion-context" && this.status.enabled && !this.disposed,
      contextWindow: policy.window,
      triggerTokens: policy.triggerTokens,
      blocks: this.persisted.summaries.length,
      summaries: this.persisted.summaries.slice(-5).map(toSummaryDto),
      updatedAt: this.status.updatedAt,
    };
  }

  /** 原生压缩边界变化（或首次打开）后重建内核 state；旧 ref 映射归档，原文仍可回查。 */
  async ensureReady(ctx: Context): Promise<void> {
    if (this.disposed) return;
    if (this.loaded || this.kernelState) return;
    if (this.loading) return this.loading;
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
          })) as DurableContextPersistedState;
        }, ctx);
        this.persisted = normalizePersisted(record);
        this.headEntryId = currentHead;
        if (this.persisted.headEntryId === currentHead) {
          const parsed = parseKernelState(this.persisted);
          if (parsed) {
            this.kernelState = parsed;
            this.rebaseNeeded = false;
          }
        }
        if (!this.kernelState) await this.rebase(currentHead, ctx, "boundary");
      } catch (error) {
        this.log("[Context] 无法恢复上下文管理状态，等待下一次重建", error);
        this.rebaseNeeded = true;
      } finally {
        this.loaded = true;
        this.loading = undefined;
      }
    })();
    return this.loading;
  }

  /** 原生压缩已改变 context head：清空当前内核 state 并从新边界重建，旧摘要 ref 归档。 */
  private async rebase(headEntryId: number | null, ctx: Context, reason: "boundary" | "native-fallback"): Promise<void> {
    if (this.kernelState) {
      const previousEpoch = this.persisted.epoch;
      if (Object.keys(this.persisted.refs).length) {
        this.persisted.archivedRefs.push({ epoch: previousEpoch, refs: this.persisted.refs });
        if (this.persisted.archivedRefs.length > 8) this.persisted.archivedRefs.splice(0, this.persisted.archivedRefs.length - 8);
      }
      this.persisted.epoch = previousEpoch + 1;
    }
    this.kernelState = createInitialState();
    this.persisted.refs = {};
    this.persisted.headEntryId = headEntryId;
    this.headEntryId = headEntryId;
    this.rebaseNeeded = false;
    this.persisted.kernelVersion = EMPTY_KERNEL_VERSION;
    await this.save(ctx, true);
    this.log(`[Context] 上下文 state 从边界重建（${reason}）`);
  }

  /** 持久化节流：refs/统计每轮都变，但只有摘要/边界变化才必须立即落盘；崩溃后可确定性重建。 */
  private roundsSinceSave = 0;
  private async save(ctx: Context, force = false): Promise<void> {
    if (!this.kernelState) return;
    if (!force && this.roundsSinceSave < SAVE_INTERVAL_ROUNDS) { this.roundsSinceSave += 1; return; }
    this.roundsSinceSave = 0;
    this.persisted.stateJson = serializeKernelState(this.kernelState);
    this.persisted.kernelVersion = EMPTY_KERNEL_VERSION;
    const snapshot = structuredClone(this.persisted);
    try {
      await this.host.conversation.commit(async tx => {
        const doc = await tx.doc(DurableContextStateDoc, this.host.conversation.id);
        for (const key of Object.keys(doc)) Reflect.deleteProperty(doc, key);
        Object.assign(doc, snapshot);
      }, ctx);
    } catch (error) {
      this.log("[Context] 上下文管理状态提交失败（只影响跨重启恢复）", error);
    }
  }

  /**
   * 每次 provider 请求前：把已提交历史投影成内核视图，必要时自动摘要，再把投影还原成真实消息。
   * 任何失败都返回 undefined，让 Pi 用未投影消息继续；具体错误记录在状态里。
   */
  async beforeRequest(messages: readonly Message[], api: HookApi, ctx: Context): Promise<{ messages: readonly Message[] } | undefined> {
    if (this.disposed || !this.healthy || this.engine !== "billion-context") return undefined;
    try {
      await this.ensureReady(ctx);
      if (!this.kernelState) return undefined;
      const view = await this.host.conversation.context(ctx);
      const headEntryId = view.head?.id ?? null;
      if (headEntryId !== this.headEntryId) {
        this.rebaseNeeded = true;
        await this.rebase(headEntryId, ctx, "boundary");
      }
      const outcome = await this.maintainAndProject(messages, view.entries, api.models, ctx, { automatic: true });
      this.consecutiveFailures = 0;
      this.publish({ ...this.status, phase: outcome.folds > 0 ? "completed" : "idle",
        automatic: true, reason: outcome.reason, beforeTokens: outcome.beforeTokens,
        afterTokens: outcome.afterTokens !== undefined && outcome.folds > 0 ? outcome.afterTokens : undefined,
        estimatedInputTokens: outcome.beforeTokens, blocks: outcome.blocks,
        processedMessages: outcome.folds > 0 ? outcome.processed : 0, estimated: true });
      return outcome.projectedApplied ? { messages: outcome.projected } : undefined;
    } catch (error) {
      this.consecutiveFailures++;
      this.fail("自动上下文整理失败，本轮沿用 Pi 原生上下文", error);
      return undefined;
    }
  }

  /**
   * 原生压缩前的协调点：
   * - BC 健康且是阈值压缩：decline，交给 BC 的请求前投影处理；
   * - 其他情况（原生手动/溢出/BC 故障）：若原生输入可能撑爆窗口，用自己的有界摘要替代，
   *   保证 fallback 的摘要请求本身一定装得下；否则沿用原生行为。
   */
  async beforeCompact(input: { reason: CompactionReason; messages: readonly Message[] }, api: HookApi, ctx: Context): Promise<{ decline: true } | { summary: string } | undefined> {
    // 用户显式选择“按比例压缩（Pi 原生）”时，不参与原生压缩协调，完全沿用 Pi 行为。
    if (this.engine !== "billion-context") return undefined;
    const policy = this.resolvePolicy();
    try {
      // prepare 阶段会先跑阈值压缩、再跑 beforeRequest；若这里不先加载 state，
      // 重启后的第一次请求会误走 fallback，重复生成已经存在的摘要。
      await this.ensureReady(ctx);
      if (input.reason === "threshold" && this.healthy && this.kernelState) {
        this.publish({ ...this.status, phase: "skipped", automatic: true, reason: "threshold",
          message: "billion-context 在请求前自行整理，跳过 Pi 原生阈值压缩" });
        return { decline: true };
      }
      const budget = Math.max(4_096, Math.floor(policy.window * 0.45));
      const inputTokens = estimateMessages(input.messages);
      this.rebaseNeeded = true;
      if (inputTokens <= budget) return undefined;
      const model = await this.resolveModel(api.models, ctx);
      const summary = await this.summarizeMessages(input.messages, budget, model, api.models, ctx);
      this.publish({ ...this.status, phase: "completed", automatic: input.reason !== "manual",
        reason: input.reason === "manual" ? "manual" : "fallback", beforeTokens: inputTokens,
        afterTokens: estimateTextTokens(summary), estimated: true, message: "已用有界摘要接管原生压缩输入" });
      return { summary };
    } catch (error) {
      this.fail("原生压缩兜底摘要失败", error);
      return { decline: true };
    }
  }

  /** 手动“立即整理上下文”。成功/无内容都返回真实结果，不伪报节省。 */
  async compressNow(ctx: Context): Promise<DurableCompactionOutcome> {
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
      const outcome = await this.maintainAndProject(view.messages, view.entries, this.host.models, ctx, { automatic: false, force: true });
      this.consecutiveFailures = 0;
      const result: DurableCompactionOutcome = outcome.folds > 0
        ? { applied: true, engine: "billion-context", beforeTokens: outcome.beforeTokens, afterTokens: outcome.afterTokens, estimated: true, blocks: outcome.blocks }
        : { applied: false, engine: "billion-context", beforeTokens: outcome.beforeTokens, estimated: true,
            skippedReason: outcome.skippedReason ?? "没有可整理的历史" };
      this.publish({ ...this.status, phase: outcome.folds > 0 ? "completed" : "skipped", automatic: false,
        reason: "manual", beforeTokens: outcome.beforeTokens, afterTokens: outcome.afterTokens,
        estimatedInputTokens: outcome.beforeTokens, blocks: outcome.blocks, message: result.skippedReason });
      return result;
    } catch (error) {
      const cancelled = controller.signal.aborted || isAbortError(error);
      if (cancelled) {
        // 取消是一个明确的终态，不是失败：保留已提交状态，只释放本次维护。
        this.publish({ ...this.status, phase: "cancelled", automatic: false, reason: "manual", message: "已取消" });
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
    this.manualAbort = undefined;
    return true;
  }

  private maintenanceSignal(ctx: Context): AbortSignal | undefined {
    const base = ctx.abortSignal;
    if (!this.manualAbort) return base;
    return base ? AbortSignal.any([base, this.manualAbort.signal]) : this.manualAbort.signal;
  }

  /** 关闭前强制落盘一次；失败只影响跨重启恢复，不影响本次状态。 */
  async flush(ctx: Context): Promise<void> { await this.save(ctx, true); }

  /** 原生压缩结束后通知管理器：下一次请求必须按新边界重建。 */
  markNativeCompaction(): void { this.rebaseNeeded = true; }

  /** 某个原始 entry 当前代次/历史代次里的 ref，供模型引用。 */
  refsForEntry(entryId: number): string[] {
    const refs = new Set<string>();
    for (const [ref, locator] of Object.entries(this.persisted.refs)) if (locator.entryId === entryId) refs.add(ref);
    for (const archived of this.persisted.archivedRefs) {
      for (const [ref, locator] of Object.entries(archived.refs)) if (locator.entryId === entryId) refs.add(ref);
    }
    return [...refs].sort();
  }

  /** 模型主动调用 compress 时的应用路径：摘要由模型给出，内核负责范围校验与分层。 */
  async applyModelCompression(
    input: { startRef: string; endRef: string; summary: string; topic?: string },
    ctx: Context,
  ): Promise<{ ok: boolean; message: string }> {
    if (this.engine !== "billion-context") return { ok: false, message: "当前设置为按比例压缩（Pi 原生），未启用 billion-context" };
    await this.ensureReady(ctx);
    const state = this.kernelState;
    if (!state) return { ok: false, message: "上下文状态尚未就绪，请稍后重试" };
    const view = await this.host.conversation.context(ctx);
    const build = this.buildCoreMessages(view.messages, view.entries);
    const config = this.buildConfig(this.resolvePolicy().window, build.protectedIds);
    const applied = this.core.applyCompression({
      ranges: [{ startRef: input.startRef, endRef: input.endRef, summary: input.summary, ...(input.topic ? { topic: input.topic } : {}) }],
      messages: build.messages, state, config,
    });
    this.kernelState = applied.state;
    this.indexRefs(applied.state);
    this.recordSummaries(applied.state);
    await this.save(ctx, true);
    const result = applied.result;
    if (result.blocksCreated === 0) {
      return { ok: false, message: result.noop ? "该范围已被摘要覆盖（no-op），无需重复压缩" : `没有折叠任何范围：${result.errors.join("；") || "范围不可压缩"}` };
    }
    this.publish({ ...this.status, phase: "completed", automatic: false, reason: "manual",
      blocks: countTopLevelBlocks(applied.state), message: `模型压缩：${result.blocksCreated} 个摘要块` });
    return { ok: true, message: `已创建 ${result.blocksCreated} 个摘要块（压缩 ${result.tokensCompressed} tokens）${result.warnings.length ? `；提示：${result.warnings.join("；")}` : ""}` };
  }

  /** 内核状态与原文的只读查询，供 acp_status / acp_search / acp_retrieve 使用。 */
  async readState(ctx: Context): Promise<CompressionState | undefined> {
    await this.ensureReady(ctx);
    return this.kernelState;
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
  async retrieveOriginal(input: { ref?: string; blockId?: string; entryId?: number; offset?: number; limit?: number }, api: ToolReader, ctx: Context): Promise<{ text: string; entryIds: number[]; page?: { offset: number; total: number } }> {
    const entryIds = await this.resolveEntryIds(input, ctx);
    if (!entryIds.length) return { text: "", entryIds: [] };
    const texts: string[] = [];
    for (const entryId of entryIds) {
      const entry = await api.entry(entryId, ctx);
      if (!entry) continue;
      texts.push(`[entry ${entry.id} · ${entry.kind}]\n${entryText(entry)}`);
    }
    const full = texts.join("\n\n");
    const offset = Math.max(0, input.offset ?? 0);
    const limit = Math.min(12_000, Math.max(500, input.limit ?? 8_000));
    const text = full.slice(offset, offset + limit);
    return { text, entryIds, page: { offset, total: full.length } };
  }

  private async resolveEntryIds(input: { ref?: string; blockId?: string; entryId?: number }, ctx: Context): Promise<number[]> {
    if (input.entryId !== undefined) return [input.entryId];
    const state = await this.readState(ctx);
    if (!state) return [];
    if (input.blockId) {
      const block = state.blocks.find(item => item.blockId === input.blockId);
      return block ? this.blockEntryIds(block) : [];
    }
    if (input.ref) {
      const locator = this.lookupRef(input.ref);
      if (locator) return [locator.entryId];
      // block 级 ref（m00012–m00020）或未知 ref：在摘要块覆盖范围内回退。
      const block = state.blocks.find(item => this.blockRefSpan(item).includes(input.ref!));
      return block ? this.blockEntryIds(block) : [];
    }
    return [];
  }

  private lookupRef(ref: string): DurableContextRefLocator | undefined {
    return this.persisted.refs[ref]
      ?? [...this.persisted.archivedRefs].reverse().find(item => item.refs[ref] !== undefined)?.refs[ref];
  }

  private blockEntryIds(block: CompressionBlock): number[] {
    const ids = new Set<number>();
    for (const rawId of block.effectiveMessageIds) {
      const locator = this.locatorOfRawId(rawId);
      if (locator) ids.add(locator.entryId);
    }
    return [...ids].sort((a, b) => a - b);
  }

  private blockRefSpan(block: CompressionBlock): string {
    if (!this.kernelState) return "";
    const refs = block.effectiveMessageIds.map(id => this.kernelState!.messageRefs.byRaw[id]).filter((ref): ref is string => Boolean(ref));
    if (!refs.length) return "";
    return summaryRefSpan(refs[0]!, refs[refs.length - 1]!);
  }

  private locatorOfRawId(rawId: string): DurableContextRefLocator | undefined {
    if (!rawId.startsWith("e")) return undefined;
    const [entryPart, slotPart] = rawId.slice(1).split(":");
    const entryId = Number(entryPart);
    const slot = Number(slotPart ?? 0);
    if (!Number.isSafeInteger(entryId) || !Number.isSafeInteger(slot)) return undefined;
    return { entryId, slot, role: "unknown" };
  }

  /** @internal 投影 + 自动整理主流程。 */
  private async maintainAndProject(
    messages: readonly Message[],
    entries: readonly EntryRecord[],
    models: Models,
    ctx: Context,
    options: { automatic: boolean; force?: boolean },
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
    const ranges = turn.nudge?.compressibleRanges ?? [];
    const pressure = beforeTokens > policy.triggerTokens;
    const knownGrowth = Boolean(turn.nudge?.shouldInject);
    let skippedReason: string | undefined;
    if (!ranges.length) {
      skippedReason = this.describeNothingToCompress(turn.state, build.messages.length);
    } else if (pressure || knownGrowth || options.force) {
      const target = Math.max(2_048, Math.floor(policy.triggerTokens * 0.7));
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
        folds++;
      }
      if (appliedRanges.length) {
        const applied = this.core.applyCompression({ ranges: appliedRanges, messages: build.messages, state, config: this.buildConfig(policy.window, build.protectedIds) });
        state = applied.state;
        // applyCompression 已经产出新 state；不需要第二次 processTurn 重新跑完整管线。
        this.persisted.stats.folds += folds;
        this.persisted.stats.tokensCompressed += applied.result.tokensCompressed;
      } else {
        skippedReason = "推荐范围没有可读原文";
      }
    } else {
      skippedReason = beforeTokens <= policy.triggerTokens ? "尚未达到整理阈值" : undefined;
    }
    this.kernelState = state;
    this.persisted.watermarkEntryId = Math.max(this.persisted.watermarkEntryId, highestEntryId(entries));
    this.indexRefs(state);
    this.recordSummaries(state);
    const rendered = this.renderProjected(build, state);
    const afterTokens = estimateContextTokens(rendered.messages).tokens + toolTokens;
    this.persisted.headEntryId = this.headEntryId;
    this.persisted.configDigest = contextConfigDigest({
      contextWindow: policy.window, triggerTokens: policy.triggerTokens, keepRecentTokens: 20_000,
      modelKey: this.host.modelKey?.(),
    });
    this.persisted.stats.rounds += 1;
    if (folds > 0 || options.force) {
      this.persisted.stats.lastBeforeTokens = beforeTokens;
      this.persisted.stats.lastAfterTokens = afterTokens;
    }
    await this.save(ctx, folds > 0);
    return {
      state, projected: rendered.messages, projectedApplied: rendered.applied, folds, blocks: countTopLevelBlocks(state),
      beforeTokens, afterTokens, processed: build.messages.length,
      reason: folds > 0 ? (options.force ? "manual" : pressure ? "threshold" : "growth") : undefined,
      skippedReason,
    };
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
      mappings.push({ message, coreIds, ...(locator ? { locator } : {}) });
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
    const rendered: Message[] = [];
    const emitted = new Set<string>();
    for (const mapping of build.mappings) {
      const block = mapping.coreIds.map(id => blockByCoreId.get(id)).find((item): item is CompressionBlock => Boolean(item));
      if (!block) { rendered.push(mapping.message); continue; }
      if (emitted.has(block.blockId)) continue;
      emitted.add(block.blockId);
      rendered.push(this.summaryMessage(block));
    }
    return { messages: rendered, applied: emitted.size > 0 };
  }

  private summaryMessage(block: CompressionBlock): Message {
    const refs = this.blockRefSpan(block);
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
    const chunks = splitByTokens(messages, Math.max(2_000, Math.min(chunkBudget, 24_000)));
    const summaries: string[] = [];
    for (const chunk of chunks) {
      summaries.push(await this.callSummarizer(chunk, model, models, ctx));
    }
    if (summaries.length === 1) return summaries[0]!;
    const merged = summaries.join("\n\n---\n\n");
    if (estimateTextTokens(merged) <= chunkBudget) return this.callSummarizer(merged, model, models, ctx, true);
    // 合并摘要仍然过大：按分块预算再滚一轮，最后返回拼接（有界，不会把原文重新塞回窗口）。
    const mergedChunks = splitByText(merged, chunkBudget);
    const final: string[] = [];
    for (const chunk of mergedChunks) final.push(await this.callSummarizer(chunk, model, models, ctx, true));
    return final.join("\n\n");
  }

  private async callSummarizer(input: string, model: unknown, models: Models, ctx: Context, merge = false): Promise<string> {
    const prompt = merge
      ? `Merge these partial summaries into one coherent summary. Keep every concrete detail (paths, versions, errors, decisions, open tasks) and output only the merged summary.\n\n${input}`
      : `<conversation>\n${input}\n</conversation>\n\nSummarize this section so another assistant can continue the task without re-reading it.`;
    const result = await models.completeSimple(model as never, {
      messages: [
        { role: "system", content: SUMMARIZER_SYSTEM, timestamp: Date.now() },
        { role: "user", content: prompt, timestamp: Date.now() },
      ],
    }, {
      maxTokens: 1_500,
      cacheRetention: "none",
      signal: this.maintenanceSignal(ctx),
    }) as AssistantMessage;
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
    this.status = { ...status, revision: ++this.operationCounter, updatedAt: Date.now() };
    const now = Date.now();
    if (now - this.lastPublished < 300 && status.phase === "idle") return;
    this.lastPublished = now;
    try { this.host.onStatus?.(this.statusSnapshot()); }
    catch (error) { this.log("[Context] 状态回调失败", error); }
  }

  private fail(message: string, error: unknown): void {
    this.log(`[Context] ${message}`, error);
    this.publish({ ...this.status, phase: "failed", lastError: errorText(error), message });
  }

  dispose(): void { this.disposed = true; }
}

export interface ToolReader {
  entry(id: number, ctx: Context): Promise<EntryRecord | undefined>;
}

function normalizePersisted(value: DurableContextPersistedState | undefined): DurableContextPersistedState {
  const base = emptyPersistedState();
  if (!value || typeof value !== "object") return base;
  return {
    ...base,
    ...value,
    refs: value.refs && typeof value.refs === "object" ? value.refs : {},
    archivedRefs: Array.isArray(value.archivedRefs) ? value.archivedRefs : [],
    summaries: Array.isArray(value.summaries) ? value.summaries : [],
    stats: { ...base.stats, ...(value.stats ?? {}) },
  };
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

function splitByTokens(messages: readonly Message[], budget: number): string[] {
  const chunks: string[] = [];
  let current: string[] = [];
  let tokens = 0;
  for (const message of messages) {
    const text = messageTextForSummary(message);
    if (!text) continue;
    const cost = estimateTextTokens(text);
    if (tokens + cost > budget && current.length) {
      chunks.push(current.join("\n\n"));
      current = [];
      tokens = 0;
    }
    current.push(text);
    tokens += cost;
  }
  if (current.length) chunks.push(current.join("\n\n"));
  return chunks;
}

function splitByText(text: string, budget: number): string[] {
  const chunks: string[] = [];
  let start = 0;
  const charsPerToken = 3.5;
  const maxChars = Math.max(1_000, Math.floor(budget * charsPerToken));
  while (start < text.length) {
    chunks.push(text.slice(start, start + maxChars));
    start += maxChars;
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