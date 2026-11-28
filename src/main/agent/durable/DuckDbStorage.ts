import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { Context, JsonValue } from "@earendil-works/chord";
import { apply, type Op } from "@earendil-works/chord/delta";
import {
  StorageRequestError,
  type CommitResult,
  type ConversationId,
  type ConversationQuery,
  type ConversationRecord,
  type Cursor,
  type DocumentAddress,
  type DocumentId,
  type DocumentPoint,
  type DocumentQuery,
  type DocumentRecord,
  type EntryId,
  type EntryQuery,
  type EntryRecord,
  type Id,
  type JsonObject,
  type Page,
  type Seq,
  type Storage,
  type StorageWrite,
  type StoredDocument,
  type SubmissionId,
  type SubmissionQuery,
  type SubmissionRecord,
  type TaskId,
  type TaskQuery,
  type TaskRecord,
} from "@earendil-works/pi-durable";
import { RuntimeAuditUnknownOperationError, type PiStorageClient } from "../../platform/runtime-audit";
import { DurableStorageOwnedError } from "./DurableStorageLease";

export class StorageFencedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StorageFencedError";
  }
}

export interface DuckDbStoreInfo {
  exists: boolean;
  storeId: string;
  format?: string;
  nextId?: number;
  commitSeq?: number;
  writerEpoch?: number;
  hostGeneration?: string | null;
  leaseHolder?: string | null;
  leaseExpiresAtMs?: number | null;
  retired: boolean;
  createdAtMs?: number;
  updatedAtMs?: number;
  incarnationKey?: string;
}

export interface DuckDbWriterOptions {
  hostGeneration?: string;
  leaseHolder?: string;
  leaseTtlMs?: number;
  forceTakeover?: boolean;
  expectedWriterEpoch?: number;
  /**
   * 一次向 Core 预留多少个 id 并在内存里发号。缺省 1（每条 id 一趟往返），生产写者传
   * `DuckDbStorage.ID_BLOCK`；只有空闲到每毫秒都计较的路径才需要它。
   */
  idBlock?: number;
}

interface PiStorageEnvelope<T> {
  ok: boolean;
  data?: T;
  kind?: "request_error" | "owned" | "fenced" | "fatal";
  message?: string;
  detail?: Record<string, unknown>;
}

const resolvedStoreIdCache = new Map<string, string>();

// JavaScript strings may contain isolated UTF-16 surrogates. Rust JSON and DuckDB
// require valid Unicode. Escape the marker itself to preserve every string identity.
function encodePiString(value: string): string {
  return value.replace(/[\ud800-\udfff\ue000]/gu, character => {
    const unit = character.charCodeAt(0);
    return "\ue000" + (unit === 0xe000 ? character : String.fromCharCode(unit + 0x801));
  });
}

export function decodePiStorageText(value: string): string {
  return value.replace(/\ue000([\ue000-\ue800])/gu, (_, character: string) => {
    const unit = character.charCodeAt(0);
    return unit === 0xe000 ? character : String.fromCharCode(unit - 0x801);
  });
}

function mapPiStrings(value: unknown, map: (value: string) => string): unknown {
  if (typeof value === "string") return map(value);
  if (Array.isArray(value)) return value.map(item => mapPiStrings(item, map));
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [map(key), mapPiStrings(item, map)]));
}

function throwIfAborted(context?: Context): void {
  const signal = context?.abortSignal;
  if (signal?.aborted) {
    throw (signal.reason instanceof Error ? signal.reason : new Error(String(signal.reason ?? "Aborted")));
  }
}

function unwrapEnvelope<T>(
  raw: PiStorageEnvelope<T> | undefined,
  action: string,
  storeId: string,
): T {
  if (!raw) {
    throw new Error(`PiStorage IPC (${action}) returned no response (core unavailable)`);
  }
  if (raw.ok) {
    return raw.data as T;
  }
  const msg = raw.message || `PiStorage error in ${action}`;
  switch (raw.kind) {
    case "request_error":
      throw new StorageRequestError(msg);
    case "owned":
      throw new DurableStorageOwnedError(
        {
          pid: typeof raw.detail?.pid === "number" ? raw.detail.pid : 0,
          host: String(raw.detail?.holder ?? "unknown"),
          startedAt: typeof raw.detail?.startedAt === "number" ? raw.detail.startedAt : 0,
        },
        storeId,
      );
    case "fenced":
      throw new StorageFencedError(msg);
    case "fatal":
    default:
      throw new Error(msg);
  }
}

/**
 * `MYBUDDY_ADMISSION_TRACE=1` 时记录每次 piStorage 往返（只记录动作名与耗时，不记录内容）。
 *
 * 准入阶段的一次 `submit` 会穿过多个存储读与一次提交，逐个动作的实际往返次数是判断
 * 「该合并成复合命令」还是「该减少读」的唯一依据，因此保留这条极轻的计数通道。
 */
export const piStorageTrace = {
  enabled: process.env.MYBUDDY_ADMISSION_TRACE === "1",
  calls: [] as { action: string; ms: number; detail?: string; t: number }[],
  startedAt: 0,
  reset(): void {
    this.calls.length = 0;
    this.startedAt = performance.now();
  },
  /** 按发生顺序返回，`t` 是相对 reset() 的毫秒偏移。 */
  order(): { action: string; detail?: string; t: number; ms: number }[] {
    return this.calls.map(call => ({ action: call.action, detail: call.detail, t: Math.round(call.t * 10) / 10, ms: Math.round(call.ms * 10) / 10 }));
  },
  summary(): Record<string, { n: number; ms: number }> {
    const out: Record<string, { n: number; ms: number }> = {};
    for (const call of this.calls) {
      const key = call.detail === undefined ? call.action : `${call.action}:${call.detail}`;
      const row = out[key] ?? { n: 0, ms: 0 };
      row.n += 1;
      row.ms = Math.round((row.ms + call.ms) * 10) / 10;
      out[key] = row;
    }
    return out;
  },
};

async function callPiStorage<T>(
  client: PiStorageClient,
  command: Record<string, unknown> & { action: string },
  storeId: string,
  context?: Context,
  detail?: string,
): Promise<T> {
  throwIfAborted(context);
  const encoded = command.action === "resolveStoreId" ? command :
    mapPiStrings(command, encodePiString) as typeof command;
  const hasReceipt = command.action === "commit" || command.action === "mintId";
  const request = hasReceipt ? { ...encoded, operationId: randomUUID() } : encoded;
  let raw: PiStorageEnvelope<T> | undefined;
  const tracedAt = piStorageTrace.enabled ? performance.now() : 0;
  try {
    raw = await client.piStorage<PiStorageEnvelope<T>>(request, context?.abortSignal);
  } catch (error) {
    if (!hasReceipt || !(error instanceof RuntimeAuditUnknownOperationError) || context?.abortSignal?.aborted) throw error;
    try {
      raw = await client.piStorage<PiStorageEnvelope<T>>(request, context?.abortSignal);
    } catch {
      throw error;
    }
    if (!raw?.ok) throw error;
  }
  if (tracedAt) piStorageTrace.calls.push({ action: command.action, ms: performance.now() - tracedAt, detail, t: tracedAt - piStorageTrace.startedAt });
  if (!hasReceipt) throwIfAborted(context);
  return unwrapEnvelope(mapPiStrings(raw, decodePiStorageText) as typeof raw, command.action, storeId);
}

export async function resolveStoreId(client: PiStorageClient, directory: string): Promise<string> {
  const normalized = resolve(directory);
  const cached = resolvedStoreIdCache.get(normalized);
  if (cached) return cached;
  const res = await callPiStorage<{ storeId: string }>(
    client,
    { action: "resolveStoreId", directory: normalized },
    normalized,
  );
  resolvedStoreIdCache.set(normalized, res.storeId);
  return res.storeId;
}

export async function duckDbStoreInfo(
  client: PiStorageClient,
  storeId: string,
): Promise<DuckDbStoreInfo> {
  return await callPiStorage<DuckDbStoreInfo>(
    client,
    { action: "storeInfo", storeId },
    storeId,
  );
}

export async function purgeDuckDbStore(
  client: PiStorageClient,
  storeId: string,
  expectedWriterEpoch?: number,
): Promise<void> {
  await callPiStorage<{ purged: boolean }>(
    client,
    {
      action: "purgeStore",
      storeId,
      ...(expectedWriterEpoch !== undefined ? { expectedWriterEpoch } : {}),
    },
    storeId,
  );
}

export class DuckDbStorage implements Storage {
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private inFlight = 0;
  private drainWaiters: Array<() => void> = [];

  private constructor(
    private readonly client: PiStorageClient,
    readonly storeId: string,
    readonly readOnly: boolean,
    readonly writerEpoch: number | undefined,
    readonly hostGeneration: string | undefined,
    readonly incarnationKey: string | undefined,
    private readonly leaseHolder: string | undefined,
    private readonly leaseTtlMs: number | undefined,
    private readonly idBlock: number | undefined,
  ) {}

  /**
   * 单写者租约内的读缓存。
   *
   * 一次发送里 `document(6)` 与 `findDocument(pi.agent)` 各被读 4 次，每次是一趟 5–8 ms 的
   * Core 往返，读出来的内容在宿主下一次 `commit` 之前不可能变化——宿主持有这份 store 的
   * 排他 `writerEpoch`，没有第二个写者。所以按「读点 + id/address」记住**原始回包**，
   * commit 成功后整体失效，下一次读再回填。
   *
   * 只缓存原始回包、不缓存物化后的 `value`：物化仍然每次新建对象（按 delta 逐条 apply），
   * 调用方拿到的结果与未命中时完全一致，避免把可变文档对象共享出去。
   */
  private readonly readCache = new Map<string, unknown>();

  private static readonly READ_CACHE_LIMIT = 32;

  /**
   * id 块预分配。
   *
   * 一次发送要 3 个 id（entry、submission、文档 change），每个都是一趟 8–13 ms 的 Core 事务。
   * 写者在租约内一次领一整块、随后在内存里发号：`next_id` 是这份 store 自己的单调计数，
   * 多领的号即使没用上也只是在账本上留空洞，唯一性和单调性都不受影响。换代（新实例）时
   * 池子自然作废，不会重发已经用掉的号。
   */
  private readonly idPool: number[] = [];

  static readonly ID_BLOCK = 64;

  private cachedRead<T>(key: string): T | undefined {
    return this.readCache.get(key) as T | undefined;
  }

  private rememberRead(key: string, value: unknown): void {
    if (this.readCache.size >= DuckDbStorage.READ_CACHE_LIMIT && !this.readCache.has(key)) {
      const oldest = this.readCache.keys().next();
      if (!oldest.done) this.readCache.delete(oldest.value);
    }
    this.readCache.set(key, value);
  }

  static async openWriter(
    client: PiStorageClient,
    storeId: string,
    options: DuckDbWriterOptions = {},
  ): Promise<DuckDbStorage> {
    const info = await callPiStorage<DuckDbStoreInfo>(
      client,
      {
        action: "openWriter",
        storeId,
        ...(options.hostGeneration !== undefined ? { hostGeneration: options.hostGeneration } : {}),
        ...(options.leaseHolder !== undefined ? { leaseHolder: options.leaseHolder } : {}),
        ...(options.leaseTtlMs !== undefined ? { leaseTtlMs: options.leaseTtlMs } : {}),
        ...(options.expectedWriterEpoch !== undefined ? { expectedWriterEpoch: options.expectedWriterEpoch } : {}),
        ...(options.forceTakeover !== undefined ? { forceTakeover: options.forceTakeover } : {}),
      },
      storeId,
    );
    return new DuckDbStorage(
      client,
      storeId,
      false,
      info.writerEpoch,
      options.hostGeneration,
      info.incarnationKey,
      options.leaseHolder,
      options.leaseTtlMs,
      options.idBlock === undefined ? undefined : Math.max(1, Math.floor(options.idBlock)),
    );
  }

  static async openReadOnly(
    client: PiStorageClient,
    storeId: string,
  ): Promise<DuckDbStorage> {
    const info = await callPiStorage<DuckDbStoreInfo>(
      client,
      { action: "openReadOnly", storeId },
      storeId,
    );
    if (!info.exists || !info.incarnationKey) {
      throw new StorageFencedError("Durable store is unavailable");
    }
    return new DuckDbStorage(
      client,
      storeId,
      true,
      undefined,
      undefined,
      info.incarnationKey,
      undefined,
      undefined,
      undefined,
    );
  }

  get isClosed(): boolean {
    return this.closed;
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new Error("DuckDbStorage is closed");
    }
  }

  private assertWritable(): number {
    this.assertOpen();
    if (this.readOnly || this.writerEpoch === undefined) {
      throw new Error("DuckDbStorage is read-only");
    }
    return this.writerEpoch;
  }

  private async runTracked<T>(context: Context | undefined, fn: () => Promise<T>): Promise<T> {
    this.assertOpen();
    throwIfAborted(context);
    this.inFlight += 1;
    try {
      return await fn();
    } finally {
      this.inFlight -= 1;
      if (this.inFlight === 0 && this.drainWaiters.length > 0) {
        const waiters = this.drainWaiters.splice(0);
        for (const wake of waiters) wake();
      }
    }
  }

  async heartbeatLease(): Promise<number> {
    const writerEpoch = this.assertWritable();
    const res = await callPiStorage<{ leaseExpiresAtMs: number }>(
      this.client,
      {
        action: "heartbeatLease",
        storeId: this.storeId,
        writerEpoch,
        ...(this.hostGeneration !== undefined ? { hostGeneration: this.hostGeneration } : {}),
        ...(this.leaseHolder !== undefined ? { leaseHolder: this.leaseHolder } : {}),
        ...(this.leaseTtlMs !== undefined ? { leaseTtlMs: this.leaseTtlMs } : {}),
      },
      this.storeId,
    );
    return res.leaseExpiresAtMs;
  }

  async commit(
    batches: readonly (readonly StorageWrite[])[],
    receive: (index: number, seq: Seq) => void,
    context: Context,
  ): Promise<CommitResult> {
    return await this.runTracked(context, async () => {
      const writerEpoch = this.assertWritable();
      const res = await callPiStorage<{ stored: number; seqs: number[]; refused?: string }>(
        this.client,
        {
          action: "commit",
          storeId: this.storeId,
          writerEpoch,
          ...(this.hostGeneration !== undefined ? { hostGeneration: this.hostGeneration } : {}),
          batches,
        },
        this.storeId,
        context,
        batches.map(batch => batch.map(write => write.type === "document.change" ? `document.change:${write.id}` : write.type).join("|")).join("+") || "empty",
      );
      // 自己写完就把读缓存整体作废：文档、回执与任务行都可能刚落盘。
      if (res.stored > 0) this.readCache.clear();
      for (let i = 0; i < res.seqs.length; i += 1) {
        receive(i, res.seqs[i] as Seq);
      }
      return res.refused !== undefined
        ? { stored: res.stored, refused: new Error(res.refused) }
        : { stored: res.stored };
    });
  }

  async mintId<I extends Id<string>>(): Promise<I> {
    return await this.runTracked(undefined, async () => {
      const writerEpoch = this.assertWritable();
      if (this.idBlock === undefined) {
        const res = await callPiStorage<{ id: number }>(
          this.client,
          {
            action: "mintId",
            storeId: this.storeId,
            writerEpoch,
            ...(this.hostGeneration !== undefined ? { hostGeneration: this.hostGeneration } : {}),
          },
          this.storeId,
        );
        return res.id as I;
      }
      const pooled = this.idPool.shift();
      if (pooled !== undefined) return pooled as I;
      const res = await callPiStorage<{ id: number; count?: number }>(
        this.client,
        {
          action: "mintId",
          storeId: this.storeId,
          writerEpoch,
          ...(this.hostGeneration !== undefined ? { hostGeneration: this.hostGeneration } : {}),
          count: this.idBlock,
        },
        this.storeId,
      );
      const count = res.count ?? 1;
      for (let offset = 1; offset < count; offset += 1) this.idPool.push(res.id + offset);
      return res.id as I;
    });
  }

  private query<T>(command: Record<string, unknown> & { action: string }, context: Context, detail?: string): Promise<T> {
    return callPiStorage<T>(this.client, {
      ...command,
      storeId: this.storeId,
      expectedIncarnation: this.incarnationKey,
    }, this.storeId, context, detail);
  }

  async conversation(id: ConversationId, context: Context): Promise<ConversationRecord | undefined> {
    return await this.runTracked(context, async () => {
      const res = await this.query<ConversationRecord | null>(
        { action: "conversation", id },
        context,
      );
      return res ?? undefined;
    });
  }

  async scanConversations(
    query: ConversationQuery,
    limit: number,
    cursor: Cursor | undefined,
    context: Context,
  ): Promise<Page<ConversationRecord, Cursor>> {
    return await this.runTracked(context, async () => {
      return await this.query<Page<ConversationRecord, Cursor>>(
        {
          action: "scanConversations",
          ...(query.ownerConversationId !== undefined ? { ownerConversationId: query.ownerConversationId } : {}),
          ...(query.ownerTaskId !== undefined ? { ownerTaskId: query.ownerTaskId } : {}),
          ...(query.order !== undefined ? { order: query.order } : {}),
          limit,
          ...(cursor !== undefined ? { cursor } : {}),
        },
        context,
      );
    });
  }

  async entry(id: EntryId, context: Context): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
  async entry(
    conversationId: ConversationId,
    id: EntryId,
    context: Context,
  ): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined>;
  async entry(
    idOrConversationId: EntryId | ConversationId,
    idOrContext: EntryId | Context,
    maybeContext?: Context,
  ): Promise<{ readonly entry: EntryRecord; readonly commitSeq: Seq } | undefined> {
    const hasConversation = typeof idOrContext === "number";
    const conversationId = hasConversation ? (idOrConversationId as ConversationId) : undefined;
    const id = hasConversation ? (idOrContext as EntryId) : (idOrConversationId as EntryId);
    const context = (hasConversation ? maybeContext : idOrContext) as Context;
    return await this.runTracked(context, async () => {
      const res = await this.query<{ entry: EntryRecord; commitSeq: number } | null>(
        {
          action: "entry",
          id,
          ...(conversationId !== undefined ? { conversationId } : {}),
        },
        context,
      );
      return res ? { entry: res.entry, commitSeq: res.commitSeq as Seq } : undefined;
    });
  }

  async findLatestHeadMarker(
    conversationId: ConversationId,
    atOrBeforeEntryId: EntryId | undefined,
    context: Context,
  ): Promise<(EntryRecord & { readonly head: EntryId }) | undefined> {
    return await this.runTracked(context, async () => {
      const res = await this.query<(EntryRecord & { readonly head: EntryId }) | null>(
        {
          action: "findLatestHeadMarker",
          conversationId,
          ...(atOrBeforeEntryId !== undefined ? { atOrBeforeEntryId } : {}),
        },
        context,
      );
      return res ?? undefined;
    });
  }

  async scanEntries(
    query: EntryQuery,
    limit: number,
    cursor: Cursor | undefined,
    context: Context,
  ): Promise<Page<EntryRecord, Cursor>> {
    return await this.runTracked(context, async () => {
      return await this.query<Page<EntryRecord, Cursor>>(
        {
          action: "scanEntries",
          conversationId: query.conversationId,
          ...(query.minEntryId !== undefined ? { minEntryId: query.minEntryId } : {}),
          ...(query.maxEntryId !== undefined ? { maxEntryId: query.maxEntryId } : {}),
          ...(query.order !== undefined ? { order: query.order } : {}),
          limit,
          ...(cursor !== undefined ? { cursor } : {}),
        },
        context,
      );
    });
  }

  async task(id: TaskId, context: Context): Promise<TaskRecord<JsonValue, JsonValue, JsonValue> | undefined> {
    return await this.runTracked(context, async () => {
      const res = await this.query<TaskRecord<JsonValue, JsonValue, JsonValue> | null>(
        { action: "task", id },
        context,
      );
      return res ?? undefined;
    });
  }

  async scanTasks(
    query: TaskQuery,
    limit: number,
    cursor: Cursor | undefined,
    context: Context,
  ): Promise<Page<TaskRecord<JsonValue, JsonValue, JsonValue>, Cursor>> {
    return await this.runTracked(context, async () => {
      return await this.query<Page<TaskRecord<JsonValue, JsonValue, JsonValue>, Cursor>>(
        {
          action: "scanTasks",
          ...(query.conversationId !== undefined ? { conversationId: query.conversationId } : {}),
          ...(query.kind !== undefined ? { kind: query.kind } : {}),
          ...(query.status !== undefined ? { status: query.status } : {}),
          ...(query.abortRequested !== undefined ? { abortRequested: query.abortRequested } : {}),
          ...(query.background !== undefined ? { background: query.background } : {}),
          ...(query.order !== undefined ? { order: query.order } : {}),
          limit,
          ...(cursor !== undefined ? { cursor } : {}),
        },
        context,
      );
    });
  }

  async submission(id: SubmissionId, context: Context): Promise<SubmissionRecord | undefined> {
    return await this.runTracked(context, async () => {
      const res = await this.query<SubmissionRecord | null>(
        { action: "submission", id },
        context,
      );
      return res ?? undefined;
    });
  }

  async scanSubmissions(
    query: SubmissionQuery,
    limit: number,
    cursor: Cursor | undefined,
    context: Context,
  ): Promise<Page<SubmissionRecord, Cursor>> {
    return await this.runTracked(context, async () => {
      return await this.query<Page<SubmissionRecord, Cursor>>(
        {
          action: "scanSubmissions",
          ...(query.conversationId !== undefined ? { conversationId: query.conversationId } : {}),
          ...(query.status !== undefined ? { status: query.status } : {}),
          ...(query.order !== undefined ? { order: query.order } : {}),
          limit,
          ...(cursor !== undefined ? { cursor } : {}),
        },
        context,
      );
    });
  }

  async submissionByRequest(
    conversationId: ConversationId,
    requestId: string,
    context: Context,
  ): Promise<SubmissionRecord | undefined> {
    return await this.runTracked(context, async () => {
      // 去重探测在同一轮里会被问 3 次；宿主是唯一写者，自己 commit 之前答案不会变。
      const key = `submissionByRequest|${conversationId}|${requestId}`;
      let res: SubmissionRecord | null;
      if (this.readCache.has(key)) {
        res = this.cachedRead<SubmissionRecord | null>(key) ?? null;
      } else {
        res = await this.query<SubmissionRecord | null>(
          { action: "submissionByRequest", conversationId, requestId },
          context,
        );
        this.rememberRead(key, res);
      }
      return res ?? undefined;
    });
  }

  async findDocument(
    address: DocumentAddress,
    at: DocumentPoint,
    context: Context,
  ): Promise<DocumentRecord | undefined> {
    return await this.runTracked(context, async () => {
      const key = `findDocument|${JSON.stringify(address)}|${JSON.stringify(at)}`;
      let res: DocumentRecord | null;
      if (this.readCache.has(key)) {
        res = this.cachedRead<DocumentRecord | null>(key) ?? null;
      } else {
        res = await this.query<DocumentRecord | null>(
          { action: "findDocument", address, at },
          context,
          JSON.stringify(address),
        );
        this.rememberRead(key, res);
      }
      return res ?? undefined;
    });
  }

  async document(
    id: DocumentId,
    at: DocumentPoint,
    context: Context,
  ): Promise<StoredDocument | undefined> {
    return await this.runTracked(context, async () => {
      type RawDocument = {
        record: DocumentRecord;
        version: number;
        baseValue: JsonObject;
        deltas: Op[][];
        deltasSinceBase: number;
      } | null;
      const key = `document|${id}|${JSON.stringify(at)}`;
      let res: RawDocument;
      if (this.readCache.has(key)) {
        res = this.cachedRead<RawDocument>(key) ?? null;
      } else {
        res = await this.query<RawDocument>(
          { action: "document", id, at },
          context,
          String(id),
        );
        this.rememberRead(key, res);
      }
      if (!res) return undefined;
      let value: JsonObject = res.baseValue;
      for (const ops of res.deltas) {
        value = apply(value, ops) as JsonObject;
      }
      return {
        record: res.record,
        version: res.version,
        value,
        deltasSinceBase: res.deltasSinceBase,
      };
    });
  }

  async scanDocuments(
    query: DocumentQuery,
    limit: number,
    cursor: Cursor | undefined,
    context: Context,
  ): Promise<Page<DocumentRecord, Cursor>> {
    return await this.runTracked(context, async () => {
      return await this.query<Page<DocumentRecord, Cursor>>(
        {
          action: "scanDocuments",
          scope: query.scope,
          at: query.at,
          ...(query.kind !== undefined ? { kind: query.kind } : {}),
          limit,
          ...(cursor !== undefined ? { cursor } : {}),
        },
        context,
      );
    });
  }

  async close(_context: Context): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.closePromise = (async () => {
      if (this.inFlight > 0) {
        await new Promise<void>(resolve => this.drainWaiters.push(resolve));
      }
      if (!this.readOnly && this.writerEpoch !== undefined) {
        await callPiStorage(this.client, {
          action: "releaseLease",
          storeId: this.storeId,
          writerEpoch: this.writerEpoch,
          ...(this.leaseHolder !== undefined ? { leaseHolder: this.leaseHolder } : {}),
        }, this.storeId).catch(() => undefined);
      }
    })();
    return this.closePromise;
  }
}
