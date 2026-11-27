import { DOTS_NO_CHANGE } from "../../shared/dots";
import { followupInstructions } from "./DotsFollowup";
import { createHash } from "node:crypto";
import { watch } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { AppDatabase } from "../db/AppDatabase";
import type { AgentPromptRequest, AgentPromptResult } from "../../shared/agent-ipc";
import { DotsIntentChanged } from "./DotsNativeIntent";
import { resolvedPathKey } from "../platform/paths";
import { RuntimeAuditUnknownOperationError } from "../platform/runtime-audit";

interface FileWatch {
  id: string; task_id: string; space_id: string; root: string; file: string; instruction: string; source: string;
  baseline: string; input_version: string; state: "watching" | "sending" | "paused" | "dispatched" | "cancelled" | "expired"; note: string;
}
type FollowupMode = "paused" | "notify" | "continue";
type WatchScope = { root: string; held: boolean; controlled: boolean };
interface Host {
  root(taskId: string, spaceId: string): string;
  inputVersion(taskId: string): Promise<string>;
  find(taskId: string, operationId: string): Promise<AgentPromptResult | undefined>;
  send(request: AgentPromptRequest, source: string): Promise<AgentPromptResult>;
  failed(taskId: string, operationId: string, reason: string): void;
  changed(): void;
  proactivePaused(spaceId: string): boolean;
  pathAllowed?(path: string): boolean;
  mayNotify?(spaceId: string): boolean;
  notify?(event: { id: string; revision: string; taskId: string; file: string }): void | Promise<unknown>;
}
const active = (row: FileWatch) => row.state === "watching" || row.state === "sending";
const operation = (id: string) => "dots-input-file-" + id;
const contained = (root: string, path: string) => {
  const ref = relative(root, path);
  return ref !== ".." && !ref.startsWith(".." + sep) && !isAbsolute(ref);
};
const REVISION_REJECTIONS = {
  rootChanged: "空间目录已替换为链接",
  parentChanged: "订阅文件的目录链接或归属已变化",
  notFile: "订阅对象已不是普通文件",
} as const;

async function hostRevision(root: string, file: string, verifyRoot: boolean) {
  if (verifyRoot && resolvedPathKey(await realpath(root)) !== resolvedPathKey(root))
    throw new DotsIntentChanged(REVISION_REJECTIONS.rootChanged);
  const target = resolve(root, file);
  const parent = await realpath(dirname(target));
  if (!contained(root, parent) || resolvedPathKey(parent) !== resolvedPathKey(dirname(target)))
    throw new DotsIntentChanged(REVISION_REJECTIONS.parentChanged);
  try {
    const entry = await lstat(target, { bigint: true });
    if (!entry.isFile()) throw new DotsIntentChanged(REVISION_REJECTIONS.notFile);
    return [entry.dev, entry.ino, entry.size, entry.mtimeNs, entry.ctimeNs].join(":");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

/** One-shot workspace file events. The persisted baseline survives restarts. */
export class DotsFileWatches {
  private readonly handles = new Map<string, { close(): void }>();
  private readonly flights = new Map<string, Promise<void>>();
  private readonly dirty = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  private started = false;
  private closed = false;
  private writeTail = Promise.resolve();
  private pendingWriteCount = 0;
  private coreCycle?: Promise<void>;
  private readonly pendingRows = new Map<string, FileWatch>();

  constructor(private readonly db: AppDatabase, private readonly host: Host) {
    if (!db.readonly) {
      db.connection.exec(`CREATE TABLE IF NOT EXISTS dots_file_watches(
        id TEXT PRIMARY KEY,task_id TEXT NOT NULL,space_id TEXT NOT NULL,root TEXT NOT NULL,file TEXT NOT NULL,
        instruction TEXT NOT NULL,source TEXT NOT NULL,baseline TEXT NOT NULL,input_version TEXT NOT NULL,
        state TEXT NOT NULL,note TEXT NOT NULL DEFAULT '');
        CREATE TABLE IF NOT EXISTS dots_file_watch_notices(watch_id TEXT NOT NULL,revision TEXT NOT NULL,PRIMARY KEY(watch_id,revision))`);
    }
  }

  private get requiresRustWrites(): boolean {
    return this.db.readonly || Boolean(this.db.runtimeAuditReader?.supervised);
  }

  private get core() {
    const reader = this.db.runtimeAuditReader;
    return reader?.supervised && !this.db.fixtureConnection ? reader : undefined;
  }

  flushWrites(): Promise<void> {
    return this.writeTail;
  }

  private enqueue(request: Record<string, unknown>, label: string): void {
    const reader = this.db.runtimeAuditReader;
    if (!reader) throw new Error(`只读模式下缺少 Dots 文件订阅 Rust 写入通道: ${label}`);
    this.pendingWriteCount += 1;
    this.writeTail = this.writeTail.then(() => reader.batch4aWrite(request)).then(() => undefined, error => {
      console.warn(`[DotsFileWatches] ${label} failed`, error);
    }).finally(() => {
      this.pendingWriteCount -= 1;
      if (this.pendingWriteCount === 0) this.pendingRows.clear();
    });
  }

  private get(id: string) {
    return this.pendingRows.get(id) ?? (this.db.connection.prepare("SELECT * FROM dots_file_watches WHERE id=?").get(id) as FileWatch | undefined);
  }

  private async revision(root: string, file: string, verifyRoot = false): Promise<string> {
    const result = await this.db.runtimeAuditReader?.dotsFileRevision(root, file);
    if (result?.status === "observed") return result.value;
    if (result?.status === "rejected") throw new DotsIntentChanged(REVISION_REJECTIONS[result.reason]);
    return hostRevision(root, file, verifyRoot);
  }

  private async coreRead<T>(query: Record<string, unknown>): Promise<T> {
    const reply = await this.core?.readDotsFileWatchData<T>(query);
    if (reply === undefined) throw new Error("Core 未确认 Dots 文件订阅读取");
    return reply;
  }

  private async coreWrite<T>(command: Record<string, unknown>): Promise<T> {
    const write = () => this.core?.writeDotsFileWatchData<T>(command);
    const reply = await write()?.catch(error => {
      if (error instanceof RuntimeAuditUnknownOperationError) return write();
      throw error;
    });
    if (reply === undefined) throw new Error("Core 未确认 Dots 文件订阅写入");
    return reply;
  }

  private async *coreRows(taskId: string | undefined, activeOnly: boolean): AsyncGenerator<FileWatch> {
    let afterId: string | undefined;
    for (;;) {
      const page = await this.coreRead<{ rows: FileWatch[]; next: string | null }>({ kind: "list", taskId, afterId, activeOnly });
      yield* page.rows;
      if (page.next === null) return;
      if (afterId !== undefined && page.next <= afterId) throw new Error("Core 文件订阅列表无法继续分页");
      afterId = page.next;
    }
  }

  private async coreWatch(id: string): Promise<FileWatch | null> {
    return (await this.coreRead<{ watch: FileWatch | null }>({ kind: "watch", id })).watch;
  }

  private async coreScope(taskId: string, spaceId: string, spaceIds: readonly string[] | null): Promise<WatchScope> {
    if (spaceIds !== null && !spaceIds.includes(spaceId)) throw new DotsIntentChanged("原工作空间已撤回 Dots 授权");
    const { scope } = await this.coreRead<{ scope: WatchScope | null }>({ kind: "scope", taskId, spaceId });
    if (!scope) throw new DotsIntentChanged("原任务已暂停、停止或工作空间已变化");
    return scope;
  }

  private async coreFileAllowed(root: string, file: string, spaceIds: readonly string[] | null): Promise<boolean> {
    const target = resolve(root, file);
    if (target === root || !contained(root, target)) return false;
    if (spaceIds === null) return true;
    // The file can have been deleted. Native metadata already validates the physical parent.
    const parent = await realpath(dirname(target));
    const physical = resolvedPathKey(resolve(parent, relative(dirname(target), target)));
    const owners: { depth: number; allowed: boolean }[] = [];
    for (const space of await this.db.readSpaces()) {
      if (!space.path || !isAbsolute(space.path)) continue;
      const owner = await realpath(space.path).catch(() => undefined);
      if (!owner) continue;
      const ownerKey = resolvedPathKey(owner);
      if (contained(ownerKey, physical)) owners.push({ depth: ownerKey.length, allowed: !space.effectiveArchived && spaceIds.includes(space.id) });
    }
    const deepest = Math.max(...owners.map(owner => owner.depth));
    return owners.length > 0 && owners.filter(owner => owner.depth === deepest).every(owner => owner.allowed);
  }

  private async transition(row: FileWatch, state: FileWatch["state"], note: string) {
    const { changed } = await this.coreWrite<{ changed: boolean }>({ kind: "transition", id: row.id, taskId: row.task_id,
      expectedState: row.state, inputVersion: row.input_version, state, note });
    if (changed) this.host.changed();
    return changed;
  }

  private project(row: FileWatch) {
    return { id: row.id, taskId: row.task_id, spaceId: row.space_id, file: row.file, instruction: row.instruction,
      state: row.state, note: row.note, operationId: row.state === "dispatched" ? operation(row.id) : undefined };
  }

  list(taskId?: string) {
    const rows = this.db.connection.prepare("SELECT * FROM dots_file_watches WHERE (? IS NULL OR task_id=?) ORDER BY rowid DESC").all(taskId ?? null, taskId ?? null) as FileWatch[];
    const byId = new Map(rows.map(r => [r.id, r]));
    for (const [id, pending] of this.pendingRows) {
      if (!taskId || pending.task_id === taskId) byId.set(id, pending);
    }
    return [...byId.values()].map(row => this.project(row));
  }

  async readList(taskId?: string) {
    if (!this.core) return this.list(taskId);
    const result: ReturnType<DotsFileWatches["project"]>[] = [];
    for await (const row of this.coreRows(taskId, false)) result.push(this.project(row));
    return result;
  }

  async create(input: {taskId: string; spaceId: string; file: string; instruction: string; source: string}, spaceIds?: readonly string[] | null) {
    const {taskId, spaceId, file, instruction, source} = input;
    const id = createHash("sha256").update(JSON.stringify([source, taskId, spaceId, file, instruction])).digest("hex");
    if (this.core) {
      if (spaceIds === undefined) throw new DotsIntentChanged("Core 未确认 Dots 文件订阅的授权范围");
      const scope = await this.coreScope(taskId, spaceId, spaceIds);
      if (scope.controlled) throw new DotsIntentChanged("原任务已暂停或停止");
      const root = await realpath(scope.root);
      const target = resolve(root, file);
      if (isAbsolute(file) || !contained(root, target) || target === root) throw new Error("请选择绑定空间内的相对文件路径");
      const local = relative(root, target);
      const baseline = await this.revision(root, local, true);
      if (!await this.coreFileAllowed(root, local, spaceIds)) throw new Error("文件属于未授权给 Dots 的空间");
      const version = await this.host.inputVersion(taskId);
      const reply = await this.coreWrite<{ status: "saved"; watch: FileWatch } | { status: "scopeChanged" }>({ kind: "create", watch: {
        id, task_id: taskId, space_id: spaceId, root, file: local, instruction, source, baseline, input_version: version,
      } });
      if (reply.status !== "saved") throw new DotsIntentChanged("订阅时空间绑定已变化");
      this.host.changed();
      return this.project(reply.watch);
    }
    const found = this.get(id);
    if (found) return this.project(found);
    const root = await realpath(this.host.root(taskId, spaceId));
    const target = resolve(root, file);
    if (isAbsolute(file) || !contained(root, target) || target === root) throw new Error("请选择绑定空间内的相对文件路径");
    if (this.host.pathAllowed?.(target) === false) throw new Error("文件属于未授权给 Dots 的空间");
    const local = relative(root, target);
    const baseline = await this.revision(root, local);
    const version = await this.host.inputVersion(taskId);
    if (resolvedPathKey(this.host.root(taskId, spaceId)) !== resolvedPathKey(root)) throw new Error("订阅时空间绑定已变化");
    if (this.requiresRustWrites) {
      const row: FileWatch = { id, task_id: taskId, space_id: spaceId, root, file: local, instruction, source, baseline, input_version: version, state: "watching", note: "" };
      this.pendingRows.set(id, row);
      this.enqueue({
        kind: "dotsFileWatchCreate",
        id,
        taskId,
        spaceId,
        root,
        file: local,
        instruction,
        source,
        baseline,
        inputVersion: version,
      }, "create");
      this.wake(id);
      return this.project(this.get(id)!);
    }
    this.db.connection.prepare(`INSERT OR IGNORE INTO dots_file_watches
      (id,task_id,space_id,root,file,instruction,source,baseline,input_version,state) VALUES(?,?,?,?,?,?,?,?,?,'watching')`)
      .run(id, taskId, spaceId, root, local, instruction, source, baseline, version);
    this.wake(id);
    return this.project(this.get(id)!);
  }

  async cancel(id: string, expectedTaskId: string) {
    if (this.core) {
      const row = await this.coreWatch(id);
      if (!row || row.task_id !== expectedTaskId) throw new Error("找不到此任务的 Dots 文件订阅");
      if (active(row) || row.state === "paused") {
        await this.transition(row, "cancelled", "用户已取消后续触发");
        if (row.state === "sending" && (await this.host.find(row.task_id, operation(id)))?.receipt) {
          const current = await this.coreWatch(id);
          if (current?.state === "cancelled") await this.transition(current, "dispatched", "原任务已接收该触发");
        }
      }
      return this.project(await this.coreWatch(id) ?? row);
    }
    const row = this.get(id);
    if (!row || row.task_id !== expectedTaskId) throw new Error("找不到此任务的 Dots 文件订阅");
    if (active(row) || row.state === "paused") {
      this.update(id, "cancelled", "用户已取消后续触发");
      if (row.state === "sending" && (await this.host.find(row.task_id, operation(id)))?.receipt)
        this.update(id, "dispatched", "原任务已接收该触发");
    }
    return this.project(this.get(id)!);
  }

  controlTarget(taskId: string, action: "pause" | "stop") {
    for (const projected of this.list(taskId)) {
      if (projected.state === "watching" || projected.state === "sending" || projected.state === "paused") {
        this.update(projected.id, action === "pause" ? "paused" : "cancelled", action === "pause" ? "原事项已暂停" : "原事项已停止");
      }
    }
  }

  resumeTarget(taskId: string, inputVersion: string) {
    const ids = this.list(taskId).filter(row => row.state === "paused").map(row => row.id);
    if (this.requiresRustWrites) {
      for (const id of ids) {
        const cur = this.get(id);
        if (cur && cur.state === "paused") this.pendingRows.set(id, { ...cur, state: "watching", note: "", input_version: inputVersion });
      }
      if (ids.length) {
        this.enqueue({
          kind: "dotsFileWatchUpdate",
          id: null,
          taskId,
          state: "watching",
          note: "",
          inputVersion,
          resumePaused: true,
        }, "resumeTarget");
      }
      for (const id of ids) this.wake(id);
      return;
    }
    this.db.connection.prepare("UPDATE dots_file_watches SET state='watching',note='',input_version=? WHERE task_id=? AND state='paused'").run(inputVersion, taskId);
    for (const id of ids) this.wake(id);
  }

  validate(request: AgentPromptRequest) {
    const token = request.dotsFileWatch;
    if (!token) return;
    const row = this.get(token.id);
    if (!row || row.state !== "sending" || row.task_id !== request.taskId || row.space_id !== request.spaceId ||
      operation(row.id) !== request.userMessageId || token.inputVersion !== row.input_version)
      throw new DotsIntentChanged("文件订阅已取消或已变化");
    if (this.host.proactivePaused(row.space_id)) throw new DotsIntentChanged("主动跟进已暂停");
    if (this.host.pathAllowed?.(resolve(row.root,row.file)) === false)
      throw new DotsIntentChanged("订阅文件不在 Dots 已授权的空间内");
    this.validateRoot(row);
  }

  async validateForSubmit(request: AgentPromptRequest, spaceIds: readonly string[] | null): Promise<void> {
    if (!this.core) { this.validate(request); return; }
    const token = request.dotsFileWatch;
    if (!token) return;
    const row = await this.coreWatch(token.id);
    if (!row || row.state !== "sending" || row.task_id !== request.taskId || row.space_id !== request.spaceId
        || operation(row.id) !== request.userMessageId || token.inputVersion !== row.input_version) {
      throw new DotsIntentChanged("文件订阅已取消或已变化");
    }
    const scope = await this.coreScope(row.task_id, row.space_id, spaceIds);
    if (scope.held) throw new DotsIntentChanged("主动跟进已暂停");
    if (resolvedPathKey(scope.root) !== resolvedPathKey(row.root)) throw new DotsIntentChanged("空间已改绑，文件订阅已失效");
    await this.revision(row.root, row.file, true);
    if (!await this.coreFileAllowed(row.root, row.file, spaceIds)) throw new DotsIntentChanged("订阅文件不在 Dots 已授权的空间内");
  }

  private validateRoot(row: FileWatch) {
    if (resolvedPathKey(this.host.root(row.task_id, row.space_id)) !== resolvedPathKey(row.root))
      throw new DotsIntentChanged("空间已改绑，文件订阅已失效");
  }

  refresh() {
    if (this.core) return;
    const rows = this.db.connection.prepare("SELECT id FROM dots_file_watches WHERE state IN ('watching','sending')").all() as {id: string}[];
    for (const row of rows) this.wake(row.id);
  }

  start() {
    if (this.started) return;
    this.closed = false;
    this.started = true;
    if (!this.db.runtimeAuditReader?.supervised) {
      this.timer = setInterval(() => this.refresh(), 30_000);
      this.timer.unref();
    }
    this.refresh();
  }

  runCoreCycle(spaceIds: readonly string[] | null, mode: FollowupMode): Promise<void> {
    if (!this.core) throw new Error("文件订阅的监督周期需要 Core");
    if (this.closed) return Promise.resolve();
    if (this.coreCycle) return this.coreCycle;
    this.started = true;
    this.coreCycle = this.checkCoreWatches(spaceIds, mode).finally(() => { this.coreCycle = undefined; });
    return this.coreCycle;
  }

  private async checkCoreWatches(spaceIds: readonly string[] | null, mode: FollowupMode) {
    let failure: { error: unknown } | undefined;
    for await (const row of this.coreRows(undefined, true)) {
      if (!this.started) return;
      try {
        await this.checkCoreWatch(row, spaceIds, mode);
      } catch (error) {
        if (!(error instanceof DotsIntentChanged)) {
          failure ??= { error };
        } else if (await this.transition(row, "expired", error.message)) {
          this.host.failed(row.task_id, operation(row.id), error.message);
        }
      }
    }
    if (failure) throw failure.error;
  }

  private async checkCoreWatch(row: FileWatch, spaceIds: readonly string[] | null, mode: FollowupMode) {
    if (row.state === "sending" && (await this.host.find(row.task_id, operation(row.id)))?.receipt) {
      await this.transition(row, "dispatched", "原任务已接收该触发");
      return;
    }
    if (mode === "paused" || (spaceIds !== null && !spaceIds.includes(row.space_id))) return;
    const scope = await this.coreScope(row.task_id, row.space_id, spaceIds);
    if (scope.held) return;
    if (resolvedPathKey(scope.root) !== resolvedPathKey(row.root)) throw new DotsIntentChanged("空间已改绑，文件订阅已失效");
    const revision = await this.revision(row.root, row.file, true);
    if (revision === row.baseline && row.state === "watching" || !this.started || !await this.coreFileAllowed(row.root, row.file, spaceIds)) return;
    if (mode === "notify") {
      if (row.state === "watching" && this.host.notify) {
        const identity = { id: row.id, taskId: row.task_id, inputVersion: row.input_version, revision };
        const { pending } = await this.coreRead<{ pending: boolean }>({ kind: "noticePending", ...identity });
        if (pending) {
          const receipt = this.host.notify({ ...identity, file: row.file });
          if (!receipt) throw new Error("Core 文件订阅通知需等待保存回执");
          await receipt;
          await this.coreWrite({ kind: "notice", ...identity });
        }
      }
      return;
    }
    if (row.state === "watching" && !await this.transition(row, "sending", "已观察到文件版本变化")) return;
    const sending = await this.coreWatch(row.id);
    if (sending?.state !== "sending" || sending.input_version !== row.input_version || !this.started) return;
    const request = this.fileRequest(sending);
    await this.validateForSubmit(request, spaceIds);
    const result = await this.host.send(request, row.source);
    if (result.receipt) {
      const current = await this.coreWatch(row.id);
      if (current && current.state !== "dispatched" && current.input_version === row.input_version) {
        await this.transition(current, "dispatched", "原任务已接收该触发");
      }
    } else if (result.error || result.cancelled) {
      const reason = result.error?.message ?? "任务执行已取消";
      if (await this.transition(sending, "expired", reason)) this.host.failed(row.task_id, operation(row.id), reason);
    }
  }

  async close() {
    this.started = false;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const handle of this.handles.values()) handle.close();
    this.handles.clear();
    this.dirty.clear();
    await Promise.all(this.flights.values());
    await this.coreCycle;
  }

  private update(id: string, state: FileWatch["state"], note: string) {
    let changed = false;
    if (this.requiresRustWrites) {
      const current = this.get(id);
      changed = Boolean(current && (current.state !== state || current.note !== note));
      if (current && changed) this.pendingRows.set(id, { ...current, state, note });
      this.enqueue({
        kind: "dotsFileWatchUpdate",
        id,
        taskId: null,
        state,
        note,
        inputVersion: null,
        resumePaused: false,
      }, "update");
    } else {
      const result = this.db.connection.prepare("UPDATE dots_file_watches SET state=?, note=? WHERE id=? AND (state<>? OR note<>?)").run(state, note, id, state, note);
      changed = result.changes > 0;
    }
    if (state !== "watching" && state !== "sending") {
      this.handles.get(id)?.close();
      this.handles.delete(id);
    }
    if (changed) this.host.changed();
  }

  private async arm(row: FileWatch) {
    if (this.handles.has(row.id)) return;
    let native: { close(): void } | undefined;
    native = await this.db.runtimeAuditReader?.watchDotsFile(row.root, row.file, () => this.wake(row.id), () => {
      if (native && this.handles.get(row.id) === native) {
        this.handles.delete(row.id);
        this.wake(row.id);
      }
    });
    const current = this.get(row.id);
    if (!this.started || !current || !active(current)) {
      native?.close();
      return;
    }
    if (native) {
      this.handles.set(row.id, native);
      return;
    }
    const path = resolve(row.root, row.file);
    const handle = watch(dirname(path), { persistent: false }, (_event, name) => {
      if (!name || resolvedPathKey(resolve(dirname(path), name)) === resolvedPathKey(path)) this.wake(row.id);
    });
    handle.on("error", () => {
      handle.close();
      if (this.handles.get(row.id) === handle) this.handles.delete(row.id);
    });
    this.handles.set(row.id, handle);
  }

  private wake(id: string) {
    if (!this.started) return;
    if (this.flights.has(id)) { this.dirty.add(id); return; }
    const flight = this.check(id).catch(error => {
      const row = this.get(id);
      if (!row || !active(row)) return;
      const message = error instanceof Error ? error.message : String(error);
      this.update(id, error instanceof DotsIntentChanged ? "expired" : row.state, message);
      if (error instanceof DotsIntentChanged) this.host.failed(row.task_id, operation(id), message);
    }).finally(() => {
      this.flights.delete(id);
      if (this.dirty.delete(id)) this.wake(id);
    });
    this.flights.set(id, flight);
  }

  private async check(id: string) {
    const row = this.get(id);
    if (!row || !active(row) || this.host.proactivePaused(row.space_id) && !this.host.mayNotify?.(row.space_id)) return;
    if (this.host.pathAllowed?.(resolve(row.root,row.file)) === false) return;
    if (row.state === "sending") {
      const previous = await this.host.find(row.task_id, operation(id));
      if (previous?.receipt) { this.update(id, "dispatched", "原任务已接收该触发"); return; }
    }
    this.validateRoot(row);
    const current = await this.revision(row.root, row.file, true);
    if (!this.started || !active(this.get(id)!)) return;
    try { await this.arm(row); }
    catch (error) {
      // Some filesystems support stat but not native notifications. The ordinary
      // reconciliation scan still compares their recorded file revisions.
      const current = this.get(id);
      if (!this.started || !current || !active(current)) return;
      this.update(id, current.state, "正在定期核对文件版本：" + String(error));
    }
    // Close the registration gap: re-read after installing the native watcher.
    const observed = current === row.baseline ? await this.revision(row.root, row.file) : current;
    if (!this.started || !active(this.get(id)!) || (observed === row.baseline && row.state === "watching")
      || this.host.pathAllowed?.(resolve(row.root,row.file)) === false) return;
    if (this.host.proactivePaused(row.space_id)) {
      if (this.host.mayNotify?.(row.space_id) && this.host.notify) {
        this.db.connection.transaction(() => {
          if (this.db.connection.prepare("INSERT OR IGNORE INTO dots_file_watch_notices VALUES (?,?)").run(id, observed).changes) {
            this.host.notify?.({id,revision:observed,taskId:row.task_id,file:row.file});
          }
        })();
      }
      return;
    }
    this.update(id, "sending", "已观察到文件版本变化");
    const request = this.fileRequest(row);
    const accepted = await this.host.send(request, row.source);
    if (accepted.error || accepted.cancelled) {
      if ((this.host.proactivePaused(row.space_id) || this.host.pathAllowed?.(resolve(row.root,row.file)) === false) && active(this.get(id)!)) {
        this.update(id, "watching", "主动跟进已暂停"); return;
      }
      const reason = accepted.error?.message ?? "任务执行已取消";
      this.host.failed(row.task_id, operation(id), reason);
      if (active(this.get(id)!)) this.update(id, "expired", reason);
    } else if (accepted.receipt) this.update(id, "dispatched", "原任务已接收该触发");
  }

  private fileRequest(row: FileWatch): AgentPromptRequest {
    return { taskId: row.task_id, spaceId: row.space_id,
      userMessageId: operation(row.id), assistantMessageId: "dots-file-reply-" + row.id, streamingBehavior: "followUp",
      text: row.instruction + "\n\n已订阅的文件发生变化：" + row.file + "。\n" + followupInstructions
        + "\n若此项检查确无实质变化，只返回 " + DOTS_NO_CHANGE,
      displayText: row.instruction, dotsFileWatch: { id: row.id, inputVersion: row.input_version } };
  }
}
