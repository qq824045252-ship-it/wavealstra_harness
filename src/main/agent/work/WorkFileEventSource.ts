import { createHash } from "node:crypto";
import { constants, watch, type FSWatcher } from "node:fs";
import { open } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { watchTimeExpired } from "../../../shared/work-watch-expiry";
import type { WorkDto, WorkGoalSourceDto, WorkSubscriptionDto } from "../../../shared/bot-work";
import type { WorkService } from "./WorkService";

export const MAX_WORK_FILE_BYTES = 4 * 1024 * 1024;
export const MAX_WORK_FILE_WATCHES = 64;

/** A configured path, never a path supplied by an event. No directories/FIFOs or unbounded reads. */
export async function readWorkFileSource(path: string): Promise<WorkGoalSourceDto> {
  if (!isAbsolute(path) || resolve(path) !== path) throw Error("文件事件目标必须是规范的绝对文件路径");
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await file.stat();
    if (!before.isFile()) throw Error("文件事件只支持常规文件");
    if (before.size > MAX_WORK_FILE_BYTES) throw Error(`文件事件读取上限为 ${MAX_WORK_FILE_BYTES} 字节`);
    const content = Buffer.alloc(Math.min(before.size + 1, MAX_WORK_FILE_BYTES + 1));
    let length = 0;
    while (length < content.length) {
      const { bytesRead } = await file.read(content, length, content.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    const after = await file.stat();
    if (length !== before.size || after.size !== before.size || after.mtimeMs !== before.mtimeMs || after.ctimeMs !== before.ctimeMs)
      throw Error("文件读取期间发生变化，等待稳定后重新读取");
    return { sourceType: "file", sourceRef: path,
      inputSnapshotId: `sha256:${createHash("sha256").update(content.subarray(0, length)).digest("hex")}`, observedAt: Date.now() };
  } finally { await file.close(); }
}

type Entry = { subscription: WorkSubscriptionDto; target: string; signature: string; watcher?: FSWatcher;
  timer?: ReturnType<typeof setTimeout>; reading?: Promise<void>; dirty: boolean; detached: boolean; retryAt?: number };

/** Real fs.watch receiver, reconciled by the existing dispatch queue (no second scheduler). */
export class WorkFileEventSource {
  private readonly entries = new Map<string, Entry>();
  private closed = false;
  constructor(private readonly works: WorkService, private readonly isAuthority: () => boolean,
    private readonly wake: () => void, private readonly maxWatches = MAX_WORK_FILE_WATCHES) {
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
      const signature = JSON.stringify([target, subscription.configRevision ?? 1, work.ownerEpoch, work.intentRevision]);
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
          await this.inspect(entry, true);
        } else if (entry.retryAt) await this.inspect(entry, false);
      } catch (error) { if (entry) this.detach(entry); this.block(work.workId, subscription.subscriptionId, error); }
    }
    for (const [id, entry] of this.entries) if (!active.has(id)) this.detach(entry);
  }

  private validate(work: WorkDto, subscription: WorkSubscriptionDto): void {
    const target = subscription.sourceTarget;
    if (!target || !isAbsolute(target) || resolve(target) !== target || work.watchRule?.eventSource !== "file"
      || work.watchRule.eventTarget !== target) throw Error("文件事件缺少与 Work 一致的绝对文件目标");
    if (subscription.catchUpPolicy === "each") throw Error("文件事件不能保证每一次写入历史；请选择 latest 或 skip");
    if (work.goalSources.length !== 1 || work.goalSources[0].sourceType !== "file"
      || work.goalSources[0].sourceRef !== target || !work.goalSources[0].inputSnapshotId.startsWith("sha256:"))
      throw Error("文件事件尚未绑定可信的文件内容基线，请重新配置文件事件目标");
  }

  private current(entry: Entry): WorkDto | undefined {
    if (this.closed || entry.detached || !this.isAuthority()) { this.detach(entry); return; }
    const work = this.works.getWork(entry.subscription.workId);
    const subscription = this.works.repo.getSubscription(entry.subscription.subscriptionId);
    if (!work || work.lifecycle !== "active" || watchTimeExpired(work, Date.now()) || !subscription || subscription.stoppedAt !== undefined
      || JSON.stringify([subscription.sourceTarget, subscription.configRevision ?? 1, work.ownerEpoch, work.intentRevision]) !== entry.signature) {
      this.detach(entry); return;
    }
    this.validate(work, subscription);
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
    entry.dirty = false;
    entry.reading = (async () => {
      try {
        const before = this.current(entry); if (!before) return;
        const source = await readWorkFileSource(entry.target);
        const current = this.current(entry); if (!current) return;
        if (current.stateVersion !== before.stateVersion || current.inputSnapshotId !== before.inputSnapshotId) {
          entry.dirty = true; return;
        }
        this.works.transaction(() => {
          if (!this.current(entry)) return;
          const id = entry.subscription.subscriptionId;
          const cursor = this.works.ingress.cursor(id, "file", entry.target);
          const baseline = cursor?.enumerationWatermark ?? before.goalSources[0].inputSnapshotId;
          if (baseline !== source.inputSnapshotId) {
            const sequence = Number(cursor?.replayCursor ?? 0) + 1;
            const result = this.works.ingestSourceEvent({ source: "file", sourceEventId: `${id}:${sequence}:${source.inputSnapshotId}`,
              eventType: "file.changed", sourceVersion: source.inputSnapshotId, workId: before.workId, subscriptionId: id,
              timestamp: Date.now(), payload: { target: entry.target, authoritativeReadbackRequired: true,
                observation: offline ? "current-state-catch-up" : "fs-watch", historyAvailable: false } }, { hostOnline: !offline });
            if (!result.acknowledged || !result.outcomes.length) throw Error("文件事件队列暂未接纳，保留基线并稍后重试");
            this.works.ingress.setCursor(id, "file", entry.target, { replayCursor: String(sequence) });
          }
          this.works.ingress.setCursor(id, "file", entry.target, { enumerationWatermark: source.inputSnapshotId });
          entry.retryAt = undefined;
          this.clear(before.workId, id);
        });
        this.wake();
      } catch (error) { this.fail(entry, error); }
    })().finally(() => {
      entry.reading = undefined;
      if (entry.dirty && !entry.detached) this.changed(entry);
    });
    return entry.reading;
  }

  private fail(entry: Entry, error: unknown): void {
    if (entry.detached || this.closed || !this.isAuthority()) return;
    entry.retryAt = Date.now() + 10_000;
    this.block(entry.subscription.workId, entry.subscription.subscriptionId, error);
  }
  private block(workId: string, subscriptionId: string, error: unknown): void {
    this.works.transaction(() => {
      if (this.closed || !this.isAuthority()) return;
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
    if (entry.timer) clearTimeout(entry.timer);
    entry.watcher?.close();
    if (this.entries.get(entry.subscription.subscriptionId) === entry) this.entries.delete(entry.subscription.subscriptionId);
  }
  private detachAll(): void { for (const entry of this.entries.values()) this.detach(entry); }
  async close(): Promise<void> {
    this.closed = true;
    this.works.ingress.setReceiverAvailable("file", false);
    const reads = [...this.entries.values()].map(entry => entry.reading);
    this.detachAll();
    await Promise.all(reads);
  }
}
