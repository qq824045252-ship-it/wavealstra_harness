import { createHash } from "node:crypto";
import { constants, watch, type FSWatcher } from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { watchTimeExpired } from "../../../shared/work-watch-expiry";
import type { WorkDto, WorkGoalSourceDto, WorkSubscriptionDto } from "../../../shared/bot-work";
import type { WorkService } from "./WorkService";

export const MAX_WORK_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_WORK_FILE_WATCHES = 64;
export const WORK_SOURCE_READ_TIMEOUT_MS = 30_000;

export interface WorkSourceReadOptions {
  signal?: AbortSignal;
  timeoutMs?: number;
  /** A caller with its own cancellation fence retains the physical I/O slot. */
  awaitSettlement?: boolean;
}

/** End the caller's wait even when an OS operation cannot be interrupted. The
 * continuation still checks the signal before using its result or opening more I/O. */
export async function withWorkSourceRead<T>(read: (signal: AbortSignal) => Promise<T>, options: WorkSourceReadOptions = {}): Promise<T> {
  options.signal?.throwIfAborted();
  const timeout = options.timeoutMs ?? WORK_SOURCE_READ_TIMEOUT_MS;
  if (!Number.isFinite(timeout) || timeout <= 0) throw Error("来源读取截止时间必须为有限正数");
  const controller = new AbortController();
  const signal = options.signal ? AbortSignal.any([options.signal, controller.signal]) : controller.signal;
  const timer = setTimeout(() => controller.abort(new Error(`来源读取超过 ${timeout} 毫秒，保留原事件等待重试`)), timeout);
  timer.unref?.();
  if (options.awaitSettlement) {
    try { const result = await read(signal); signal.throwIfAborted(); return result; }
    finally { clearTimeout(timer); }
  }
  let onAbort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try {
    const result = await Promise.race([Promise.resolve().then(() => { signal.throwIfAborted(); return read(signal); }), aborted]);
    signal.throwIfAborted(); return result;
  }
  finally { clearTimeout(timer); signal.removeEventListener("abort", onAbort); }
}

/** A configured path, never a path supplied by an event. No directories/FIFOs or unbounded reads. */
export function readWorkFileSource(path: string, options: WorkSourceReadOptions = {}): Promise<WorkGoalSourceDto> {
  return withWorkSourceRead(signal => readBoundedFileSource(path, signal), options);
}

async function readBoundedFileSource(path: string, signal: AbortSignal): Promise<WorkGoalSourceDto> {
  signal.throwIfAborted();
  if (!isAbsolute(path) || resolve(path) !== path) throw Error("文件事件目标必须是规范的绝对文件路径");
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  let closing: Promise<void> | undefined;
  const close = () => closing ??= file.close();
  const abort = () => { void close().catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    signal.throwIfAborted();
    const before = await file.stat();
    signal.throwIfAborted();
    if (!before.isFile()) throw Error("文件事件只支持常规文件");
    if (before.size > MAX_WORK_FILE_BYTES) throw Error(`文件事件读取上限为 ${MAX_WORK_FILE_BYTES} 字节`);
    const content = Buffer.alloc(Math.min(before.size + 1, MAX_WORK_FILE_BYTES + 1));
    let length = 0;
    while (length < content.length) {
      signal.throwIfAborted();
      const { bytesRead } = await file.read(content, length, content.length - length, length);
      signal.throwIfAborted();
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await file.stat();
    signal.throwIfAborted();
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
      throw Error("文件读取期间发生变化，等待稳定后重新读取");
    return { sourceType: "file", sourceRef: path,
      inputSnapshotId: `sha256:${createHash("sha256").update(content.subarray(0, length)).digest("hex")}`, observedAt: Date.now() };
  } finally { signal.removeEventListener("abort", abort); await close(); }
}

type Entry = { subscription: WorkSubscriptionDto; target: string; signature: string; watcher?: FSWatcher;
  timer?: ReturnType<typeof setTimeout>; reading?: Promise<void>; controller?: AbortController;
  dirty: boolean; offline?: boolean; detached: boolean; retryAt?: number };

/** Real fs.watch receiver, reconciled by the existing dispatch queue (no second scheduler). */
export class WorkFileEventSource {
  private readonly entries = new Map<string, Entry>();
  private readonly reads = new Set<Promise<void>>();
  // Aborting a consumer does not prove that the OS/provider has finished. Keep
  // these slots across detach/reconfigure until the actual I/O promise settles.
  private readonly physicalReads = new Map<string, { promise?: Promise<WorkGoalSourceDto> }>();
  private closed = false;
  constructor(private readonly works: WorkService, private readonly isAuthority: () => boolean,
    private readonly wake: () => void, private readonly maxWatches = MAX_WORK_FILE_WATCHES,
    private readonly readOptions: { read?: typeof readWorkFileSource; timeoutMs?: number; authorityIdentity?: () => string } = {}) {
    works.ingress.registerAdapter({ source: "file", namespace: "host-file", versionMode: "readback",
      targetKeyOf: input => String(input.payload.target ?? ""), canQueryHistory: false, supportsRetry: true, maxPayloadBytes: 4096 });
    works.ingress.setReceiverAvailable("file", true);
  }

  async reconcile(): Promise<void> {
    if (this.closed) return;
    if (!this.isAuthority()) { this.detachAll(); return; }
    const subscriptions = this.works.repo.listActiveSubscriptions("file");
    const active = new Set<string>();
    for (const subscription of subscriptions) {
      const work = this.works.getWork(subscription.workId);
      if (!work || work.lifecycle !== "active" || watchTimeExpired(work, Date.now())) continue;
      active.add(subscription.subscriptionId);
      const target = subscription.sourceTarget ?? "";
      const signature = this.signature(work, subscription);
      let entry = this.entries.get(subscription.subscriptionId);
      if (entry && entry.signature !== signature) { this.detach(entry); entry = undefined; }
      try {
        this.validate(work, subscription);
        if (!entry) {
          if (this.entries.size >= this.maxWatches) throw Error(`文件事件最多同时监听 ${this.maxWatches} 个订阅，请停止不再需要的监听`);
          entry = { subscription, target, signature, dirty: false, detached: false };
          this.entries.set(subscription.subscriptionId, entry);
        }
        if (entry.retryAt && entry.retryAt > Date.now()) continue;
        if (!entry.watcher) {
          const installed = entry;
          // Watch the parent, not the inode: editors often replace files via atomic rename.
          entry.watcher = watch(dirname(target), { persistent: false }, (_kind, filename) => {
            if (filename === null || String(filename) === basename(target)) this.changed(installed);
          });
          entry.watcher.on("error", error => {
            entry!.watcher?.close(); entry!.watcher = undefined;
            entry!.retryAt = Date.now() + 10_000;
            this.fail(entry!, error);
          });
          // At most one read per configured entry, bounded by maxWatches. A slow
          // filesystem must not hold the reconciliation pass or another source.
          void this.inspect(entry, true);
        } else if (entry.retryAt) void this.inspect(entry, false);
      } catch (error) { if (entry) this.detach(entry); this.block(work.workId, subscription.subscriptionId, error); }
    }
    for (const [id, entry] of this.entries) if (!active.has(id)) this.detach(entry);
  }

  /** Explicit diagnostics barrier; the production reconciliation pass only schedules. */
  async drain(): Promise<void> { await Promise.all([...this.reads]); }

  private validate(work: WorkDto, subscription: WorkSubscriptionDto): void {
    const target = subscription.sourceTarget;
    if (!target || !isAbsolute(target) || resolve(target) !== target || work.watchRule?.eventSource !== "file"
      || work.watchRule.eventTarget !== target) throw Error("文件事件缺少与 Work 一致的绝对文件目标");
    if (subscription.catchUpPolicy === "each") throw Error("文件事件不能保证每一次写入历史；请选择 latest 或 skip");
    if (work.goalSources.length !== 1 || work.goalSources[0].sourceType !== "file"
      || work.goalSources[0].sourceRef !== target || !work.goalSources[0].inputSnapshotId.startsWith("sha256:"))
      throw Error("文件事件尚未绑定可信的文件内容基线，请重新配置文件事件目标");
  }

  private signature(work: WorkDto, subscription: WorkSubscriptionDto): string {
    return JSON.stringify([subscription.sourceTarget, subscription.configRevision ?? 1, work.ownerEpoch,
      work.intentRevision, this.readOptions.authorityIdentity?.()]);
  }

  private current(entry: Entry): WorkDto | undefined {
    if (this.closed || entry.detached || !this.isAuthority()) { this.detach(entry); return; }
    const work = this.works.getWork(entry.subscription.workId);
    const subscription = this.works.repo.getSubscription(entry.subscription.subscriptionId);
    if (!work || work.lifecycle !== "active" || watchTimeExpired(work, Date.now()) || !subscription || subscription.stoppedAt !== undefined
      || this.signature(work, subscription) !== entry.signature) {
      this.detach(entry); return;
    }
    try { this.validate(work, subscription); }
    catch { this.detach(entry); return; }
    return work;
  }

  private changed(entry: Entry): void {
    if (entry.detached || this.closed) return;
    entry.dirty = true;
    if (entry.timer || entry.reading) return;
    entry.timer = setTimeout(() => {
      entry.timer = undefined;
      void this.inspect(entry, false);
    }, 100);
    entry.timer.unref?.();
  }

  private inspect(entry: Entry, offline: boolean): Promise<void> {
    if (entry.reading) { entry.dirty = true; return entry.reading; }
    if (this.physicalReads.has(entry.subscription.subscriptionId) || this.physicalReads.size >= this.maxWatches) {
      entry.dirty = true; entry.offline ||= offline; return Promise.resolve();
    }
    const slot: { promise?: Promise<WorkGoalSourceDto> } = {};
    this.physicalReads.set(entry.subscription.subscriptionId, slot);
    entry.dirty = false;
    offline ||= entry.offline === true;
    entry.offline = undefined;
    // Move offered entries to the tail so pending readers receive freed slots
    // fairly even if one path produces events continuously.
    if (this.entries.get(entry.subscription.subscriptionId) === entry) {
      this.entries.delete(entry.subscription.subscriptionId);
      this.entries.set(entry.subscription.subscriptionId, entry);
    }
    const controller = new AbortController();
    entry.controller = controller;
    // Defer the body until the single-flight promise has been installed. This
    // also prevents synchronous validation errors from racing its finalizer.
    const reading = Promise.resolve().then(async () => {
      let before: WorkDto | undefined;
      try {
        before = this.current(entry); if (!before) return;
        const source = await withWorkSourceRead(signal => {
          const id = entry.subscription.subscriptionId;
          const physical = Promise.resolve().then(() => {
            signal.throwIfAborted();
            return this.readOptions.read
              ? this.readOptions.read(entry.target, { signal, awaitSettlement: true })
              : readBoundedFileSource(entry.target, signal);
          });
          slot.promise = physical;
          void physical.finally(() => {
            if (this.physicalReads.get(id) === slot) this.physicalReads.delete(id);
            this.resumePendingReads();
          }).catch(() => {});
          return physical;
        },
          { signal: controller.signal, timeoutMs: this.readOptions.timeoutMs });
        const current = this.current(entry); if (!current) return;
        if (current.stateVersion !== before.stateVersion || current.inputSnapshotId !== before.inputSnapshotId) {
          entry.dirty = true; return;
        }
        const captured = before;
        this.works.transaction(() => {
          const checked = this.current(entry);
          if (!checked || checked.stateVersion !== captured.stateVersion || checked.inputSnapshotId !== captured.inputSnapshotId) return;
          const id = entry.subscription.subscriptionId;
          const cursor = this.works.ingress.cursor(id, "file", entry.target);
          const baseline = cursor?.enumerationWatermark ?? captured.goalSources[0].inputSnapshotId;
          if (baseline !== source.inputSnapshotId) {
            const sequence = Number(cursor?.replayCursor ?? 0) + 1;
            const result = this.works.ingestSourceEvent({ source: "file", sourceEventId: `${id}:${sequence}:${source.inputSnapshotId}`,
              eventType: "file.changed", sourceVersion: source.inputSnapshotId, workId: captured.workId, subscriptionId: id,
              timestamp: Date.now(), payload: { target: entry.target, authoritativeReadbackRequired: true,
                observation: offline ? "current-state-catch-up" : "fs-watch", historyAvailable: false } }, { hostOnline: !offline });
            if (!result.acknowledged || !result.outcomes.length) throw Error("文件事件队列暂未接纳，保留基线并稍后重试");
            this.works.ingress.setCursor(id, "file", entry.target, { replayCursor: String(sequence) });
          }
          this.works.ingress.setCursor(id, "file", entry.target, { enumerationWatermark: source.inputSnapshotId });
          entry.retryAt = undefined;
          this.clear(captured.workId, id);
        });
        this.wake();
      } catch (error) {
        if (controller.signal.aborted) return;
        // An error belongs to the input that was read, just like a successful
        // snapshot. An amend/owner change must never acquire its stale blocker.
        const current = this.current(entry);
        if (before && current && (current.stateVersion !== before.stateVersion || current.inputSnapshotId !== before.inputSnapshotId)) {
          entry.dirty = true; return;
        }
        this.fail(entry, error, before);
      }
    }).finally(() => {
      entry.reading = undefined;
      entry.controller = undefined;
      this.reads.delete(reading);
      if (!slot.promise && this.physicalReads.get(entry.subscription.subscriptionId) === slot)
        this.physicalReads.delete(entry.subscription.subscriptionId);
      if (entry.dirty && !entry.detached) this.changed(entry);
      this.resumePendingReads();
    });
    entry.reading = reading;
    this.reads.add(reading);
    return reading;
  }

  private resumePendingReads(): void {
    if (this.closed) return;
    for (const entry of [...this.entries.values()]) {
      if (this.physicalReads.size >= this.maxWatches) break;
      if (entry.dirty && !entry.detached && !entry.reading && !entry.timer && !this.physicalReads.has(entry.subscription.subscriptionId))
        void this.inspect(entry, entry.offline === true);
    }
  }

  private fail(entry: Entry, error: unknown, before?: WorkDto): void {
    if (!this.current(entry)) return;
    entry.retryAt = Date.now() + 10_000;
    this.block(entry.subscription.workId, entry.subscription.subscriptionId, error, () => {
      const current = this.current(entry);
      return !!current && (!before || current.stateVersion === before.stateVersion && current.inputSnapshotId === before.inputSnapshotId);
    });
  }
  private block(workId: string, subscriptionId: string, error: unknown, isCurrent: () => boolean = () => true): void {
    if (this.closed || !this.isAuthority()) return;
    this.works.transaction(() => {
      if (this.closed || !this.isAuthority() || !isCurrent()) return;
      const work = this.works.getWork(workId); if (!work || work.lifecycle !== "active") return;
      const blockerId = `file-receiver:${subscriptionId}`;
      const reason = `文件事件来源受阻：${error instanceof Error ? error.message : String(error)}`;
      const prior = this.works.repo.getBlocker(blockerId);
      if (prior?.status === "open") return;
      if (prior) this.works.repo.reopenBlocker(blockerId, workId);
      else this.works.repo.insertBlocker({ blockerId, workId, kind: "operational", reason, waitingForUserInput: true,
        status: "open", createdAt: Date.now() });
      this.works.repo.updateWork({ ...work, stateVersion: work.stateVersion + 1, updatedAt: Date.now() });
      this.works.emitCurrentProjection(workId);
    });
  }
  private clear(workId: string, subscriptionId: string): void {
    const blockerId = `file-receiver:${subscriptionId}`;
    const work = this.works.getWork(workId);
    if (work && this.works.repo.getBlocker(blockerId)?.status === "open") {
      this.works.repo.clearBlocker(blockerId, workId, Date.now());
      this.works.repo.updateWork({ ...work, stateVersion: work.stateVersion + 1, updatedAt: Date.now() });
      this.works.emitCurrentProjection(workId);
    }
  }
  private detach(entry: Entry): void {
    entry.detached = true;
    entry.controller?.abort();
    if (entry.timer) clearTimeout(entry.timer);
    entry.watcher?.close();
    if (this.entries.get(entry.subscription.subscriptionId) === entry) this.entries.delete(entry.subscription.subscriptionId);
  }
  private detachAll(): void { for (const entry of this.entries.values()) this.detach(entry); }
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.works.ingress.setReceiverAvailable("file", false);
    this.detachAll();
    await this.drain();
  }
}
