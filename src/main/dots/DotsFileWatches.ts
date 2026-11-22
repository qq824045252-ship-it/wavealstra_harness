import { DOTS_NO_CHANGE } from "../../shared/dots";
import { followupInstructions } from "./DotsFollowup";
import { createHash } from "node:crypto";
import { watch, type FSWatcher } from "node:fs";
import { lstat, realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import type { AppDatabase } from "../db/AppDatabase";
import type { AgentPromptRequest, AgentPromptResult } from "../../shared/agent-ipc";
import { DotsIntentChanged } from "./DotsNativeIntent";
import { resolvedPathKey } from "../platform/paths";

interface FileWatch {
  id: string; task_id: string; space_id: string; root: string; file: string; instruction: string; source: string;
  baseline: string; input_version: string; state: "watching" | "sending" | "paused" | "dispatched" | "cancelled" | "expired"; note: string;
}
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
  notify?(event: { id: string; revision: string; taskId: string; file: string }): void;
}
const active = (row: FileWatch) => row.state === "watching" || row.state === "sending";
const operation = (id: string) => "dots-input-file-" + id;
const contained = (root: string, path: string) => {
  const ref = relative(root, path);
  return ref !== ".." && !ref.startsWith(".." + sep) && !isAbsolute(ref);
};
async function revision(root: string, file: string) {
  const target = resolve(root, file);
  const parent = await realpath(dirname(target));
  if (!contained(root, parent) || resolvedPathKey(parent) !== resolvedPathKey(dirname(target)))
    throw new DotsIntentChanged("订阅文件的目录链接或归属已变化");
  try {
    const entry = await lstat(target, { bigint: true });
    if (!entry.isFile()) throw new DotsIntentChanged("订阅对象已不是普通文件");
    return [entry.dev, entry.ino, entry.size, entry.mtimeNs, entry.ctimeNs].join(":");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
    throw error;
  }
}

/** One-shot workspace file events. Metadata is the revision, including create, replace and delete.
 * The native watcher is a wake-up hint. SQLite retains the original baseline across downtime. */
export class DotsFileWatches {
  private readonly handles = new Map<string, FSWatcher>();
  private readonly flights = new Map<string, Promise<void>>();
  private readonly dirty = new Set<string>();
  private timer?: ReturnType<typeof setInterval>;
  private started = false;

  constructor(private readonly db: AppDatabase, private readonly host: Host) {
    db.connection.exec(`CREATE TABLE IF NOT EXISTS dots_file_watches(
      id TEXT PRIMARY KEY,task_id TEXT NOT NULL,space_id TEXT NOT NULL,root TEXT NOT NULL,file TEXT NOT NULL,
      instruction TEXT NOT NULL,source TEXT NOT NULL,baseline TEXT NOT NULL,input_version TEXT NOT NULL,
      state TEXT NOT NULL,note TEXT NOT NULL DEFAULT '');
      CREATE TABLE IF NOT EXISTS dots_file_watch_notices(watch_id TEXT NOT NULL,revision TEXT NOT NULL,PRIMARY KEY(watch_id,revision))`);
  }

  private get(id: string) {
    return this.db.connection.prepare("SELECT * FROM dots_file_watches WHERE id=?").get(id) as FileWatch | undefined;
  }

  private project(row: FileWatch) {
    return { id: row.id, taskId: row.task_id, spaceId: row.space_id, file: row.file, instruction: row.instruction,
      state: row.state, note: row.note, operationId: row.state === "dispatched" ? operation(row.id) : undefined };
  }

  list(taskId?: string) {
    const rows = this.db.connection.prepare("SELECT * FROM dots_file_watches WHERE (? IS NULL OR task_id=?) ORDER BY rowid DESC").all(taskId ?? null, taskId ?? null) as FileWatch[];
    return rows.map(row => this.project(row));
  }

  async create(input: {taskId: string; spaceId: string; file: string; instruction: string; source: string}) {
    const {taskId, spaceId, file, instruction, source} = input;
    const id = createHash("sha256").update(JSON.stringify([source, taskId, spaceId, file, instruction])).digest("hex");
    const found = this.get(id);
    if (found) return this.project(found);
    const root = await realpath(this.host.root(taskId, spaceId));
    const target = resolve(root, file);
    if (isAbsolute(file) || !contained(root, target) || target === root) throw new Error("请选择绑定空间内的相对文件路径");
    if (this.host.pathAllowed?.(target) === false) throw new Error("文件属于未授权给 Dots 的空间");
    const local = relative(root, target);
    const baseline = await revision(root, local);
    const version = await this.host.inputVersion(taskId);
    if (resolvedPathKey(this.host.root(taskId, spaceId)) !== resolvedPathKey(root)) throw new Error("订阅时空间绑定已变化");
    this.db.connection.prepare(`INSERT OR IGNORE INTO dots_file_watches
      (id,task_id,space_id,root,file,instruction,source,baseline,input_version,state) VALUES(?,?,?,?,?,?,?,?,?,'watching')`)
      .run(id, taskId, spaceId, root, local, instruction, source, baseline, version);
    this.wake(id);
    return this.project(this.get(id)!);
  }

  async cancel(id: string, expectedTaskId: string) {
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
    const rows = this.db.connection.prepare("SELECT * FROM dots_file_watches WHERE task_id=? AND state IN ('watching','sending','paused')").all(taskId) as FileWatch[];
    for (const row of rows) this.update(row.id, action === "pause" ? "paused" : "cancelled", action === "pause" ? "原事项已暂停" : "原事项已停止");
  }

  resumeTarget(taskId: string, inputVersion: string) {
    const rows = this.db.connection.prepare("SELECT id FROM dots_file_watches WHERE task_id=? AND state='paused'").all(taskId) as {id:string}[];
    this.db.connection.prepare("UPDATE dots_file_watches SET state='watching',note='',input_version=? WHERE task_id=? AND state='paused'").run(inputVersion,taskId);
    for (const row of rows) this.wake(row.id);
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

  private validateRoot(row: FileWatch) {
    if (resolvedPathKey(this.host.root(row.task_id, row.space_id)) !== resolvedPathKey(row.root))
      throw new DotsIntentChanged("空间已改绑，文件订阅已失效");
  }

  refresh() {
    const rows = this.db.connection.prepare("SELECT id FROM dots_file_watches WHERE state IN ('watching','sending')").all() as {id: string}[];
    for (const row of rows) this.wake(row.id);
  }

  start() {
    if (this.started) return;
    this.started = true;
    this.timer = setInterval(() => this.refresh(), 30_000);
    this.timer.unref();
    this.refresh();
  }

  async close() {
    this.started = false;
    clearInterval(this.timer);
    for (const handle of this.handles.values()) handle.close();
    this.handles.clear();
    this.dirty.clear();
    await Promise.all(this.flights.values());
  }

  private update(id: string, state: FileWatch["state"], note: string) {
    const result = this.db.connection.prepare("UPDATE dots_file_watches SET state=?, note=? WHERE id=? AND (state<>? OR note<>?)").run(state, note, id, state, note);
    if (state !== "watching" && state !== "sending") {
      this.handles.get(id)?.close();
      this.handles.delete(id);
    }
    if (result.changes) this.host.changed();
  }

  private arm(row: FileWatch) {
    if (this.handles.has(row.id)) return;
    const path = resolve(row.root, row.file);
    const handle = watch(dirname(path), { persistent: false }, (_event, name) => {
      if (!name || resolvedPathKey(resolve(dirname(path), name)) === resolvedPathKey(path)) this.wake(row.id);
    });
    handle.on("error", () => {
      handle.close();
      this.handles.delete(row.id);
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
    if (resolvedPathKey(await realpath(row.root)) !== resolvedPathKey(row.root)) throw new DotsIntentChanged("空间目录已替换为链接");
    const current = await revision(row.root, row.file);
    if (!this.started || !active(this.get(id)!)) return;
    try { this.arm(row); }
    catch (error) {
      // Some filesystems support stat but not native notifications. The ordinary
      // reconciliation scan still compares their recorded file revisions.
      this.update(id, row.state, "正在定期核对文件版本：" + String(error));
    }
    // Close the registration gap: re-read after installing the native watcher.
    const observed = current === row.baseline ? await revision(row.root, row.file) : current;
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
    const request: AgentPromptRequest = { taskId: row.task_id, spaceId: row.space_id,
      userMessageId: operation(id), assistantMessageId: "dots-file-reply-" + id, streamingBehavior: "followUp",
      text: row.instruction + "\n\n已订阅的文件发生变化：" + row.file + "。\n" + followupInstructions
        + "\n若此项检查确无实质变化，只返回 " + DOTS_NO_CHANGE,
      displayText: row.instruction, dotsFileWatch: { id, inputVersion: row.input_version } };
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
}
