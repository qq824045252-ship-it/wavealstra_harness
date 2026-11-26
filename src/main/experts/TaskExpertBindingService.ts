import { createHash, randomUUID } from "node:crypto";
import { cpSync, existsSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import type { TaskExpertBindingDto, TaskExpertBindingSaveRequest, TaskExpertSnapshot } from "../../shared/expert-binding";
import { normalizeWelcomeMode, type WelcomeMode } from "../../shared/mode-profile";
import type { AppDatabase } from "../db/AppDatabase";
import { getMyBuddyDir } from "../paths";
import type { ExpertService } from "./ExpertService";
import { copyExpertPackages } from "./ExpertSnapshotFiles";

interface SkillCopy { id: string; relativePath: string; origin: "private" | "global" }
/** Stay well below SQLite's bound-variable limit for one list query. */
const TASK_BINDING_BATCH = 400;
interface BindingRow {
  task_id: string;
  desired_json: string | null;
  active_json: string | null;
  desired_skills_json: string;
  active_skills_json: string;
  warnings_json: string;
}
export interface RuntimeTaskExpertBindingState {
  expertId: string | null;
  welcomeMode: string | null;
  binding: BindingRow | null;
}
export interface RuntimeTaskExpertBindingMutation {
  taskId: string;
  expectedDesiredJson: string | null;
  desiredJson: string | null;
  desiredSkillsJson: string;
  expertId: string | null;
  at: number;
}
export type RuntimeTaskExpertBindingWriteReply =
  | { status: "saved"; state: RuntimeTaskExpertBindingState }
  | { status: "stale" | "missing" | "needsHost" }
  | { status: "rejected"; message: string };
interface BindingSettings {
  binding: TaskExpertBindingDto;
  welcomeMode: WelcomeMode | null;
}
export interface TaskExpertBindingOptions {
  rootDir?: string;
  resolveSkillDirectory?: (id: string) => string | undefined;
  /** Only a global disable removes a copied global skill; private packages remain task owned. */
  isSkillEnabled?: (id: string, taskId: string) => boolean;
}

const parseSnapshot = (value: string | null): TaskExpertSnapshot | null => value ? JSON.parse(value) : null;
const revision = (value: TaskExpertSnapshot | null) => value?.revision ?? null;
function ids(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || value.length > 256) throw new Error(`${label} 必须是最多 256 项的列表`);
  return [...new Set(value.map(item => {
    if (typeof item !== "string" || !item.trim() || item.length > 200 || /[\\/\x00-\x1f]/.test(item) || item === "." || item === "..") {
      throw new Error(`${label} 含有无效标识`);
    }
    return item.trim();
  }))];
}
function text(value: unknown, label: string, max: number): string {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${label} 不能为空，且不能超过 ${max} 字符`);
  return value.trim();
}

/** A task owns its identity and files. Templates are only sources for explicit saves. */
export class TaskExpertBindingService {
  private readonly root: string;
  private writeTail: Promise<void> = Promise.resolve();
  constructor(private readonly db: AppDatabase, private readonly experts: ExpertService, private readonly options: TaskExpertBindingOptions = {}) {
    this.root = resolve(options.rootDir ?? join(getMyBuddyDir(), "task-expert-bindings"));
    if (!db.connection.readonly) {
      db.connection.exec(`CREATE TABLE IF NOT EXISTS task_expert_bindings (
        task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE CASCADE,
        desired_json TEXT, active_json TEXT,
        desired_skills_json TEXT NOT NULL DEFAULT '[]', active_skills_json TEXT NOT NULL DEFAULT '[]',
        warnings_json TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL)`);
    }
    db.setTaskExpertBindingReader(taskId => this.get(taskId));
    db.setTaskExpertBindingBatchReader(taskIds => this.list(taskIds));
  }

  private get requiresRustWrites(): boolean {
    return Boolean(this.db.connection.readonly || this.db.runtimeAuditReader?.supervised);
  }

  async flush(): Promise<void> {
    await this.writeTail;
  }

  private enqueueBatch2(context: string, request: Record<string, unknown>): Promise<void> {
    const reader = this.db.runtimeAuditReader;
    if (!reader) throw new Error(`${context}：Rust 写入核心未就绪`);
    const op = this.writeTail.then(async () => {
      const res = await reader.batch2Write(request);
      if (res === undefined) throw new Error(`${context}：Rust 核心未响应`);
    });
    this.writeTail = op.then(() => undefined, () => undefined);
    return op;
  }

  private row(taskId: string): BindingRow | undefined {
    return this.db.connection.prepare("SELECT * FROM task_expert_bindings WHERE task_id = ?").get(taskId) as BindingRow | undefined;
  }
  /** Pure table read: also used by AppDatabase.mapTaskRow, so it must not call getTask. */
  get(taskId: string): TaskExpertBindingDto | null {
    const row = this.row(taskId);
    return row ? this.decode(row) : null;
  }

  /**
   * List projection: one query per chunk instead of one per task. Ids without a row decode to
   * null so a task list keeps its "no binding" shape.
   */
  list(taskIds: readonly string[]): Map<string, TaskExpertBindingDto | null> {
    const unique = [...new Set(taskIds)];
    const result = new Map<string, TaskExpertBindingDto | null>();
    for (let offset = 0; offset < unique.length; offset += TASK_BINDING_BATCH) {
      const chunk = unique.slice(offset, offset + TASK_BINDING_BATCH);
      const rows = this.db.connection
        .prepare(`SELECT * FROM task_expert_bindings WHERE task_id IN (${chunk.map(() => "?").join(",")})`)
        .all(...chunk) as BindingRow[];
      for (const row of rows) result.set(row.task_id, this.decode(row));
    }
    for (const taskId of unique) if (!result.has(taskId)) result.set(taskId, null);
    return result;
  }

  private decode(row: BindingRow): TaskExpertBindingDto {
    const desired = parseSnapshot(row.desired_json), active = parseSnapshot(row.active_json);
    const warnings: string[] = JSON.parse(row.warnings_json);
    return { taskId: row.task_id, desired, active, pending: revision(desired) !== revision(active), ...(warnings.length ? { warnings } : {}) };
  }
  active(taskId: string): TaskExpertSnapshot | null { return this.get(taskId)?.active ?? null; }

  /** Install the immutable Work binding, never re-read its editable template. */
  installFrozen(taskId: string, snapshot: TaskExpertSnapshot, packages: Array<{ id: string; directory: string; origin?: "private" | "global" }>): void {
    if (!this.db.getTask(taskId)) throw new Error("任务不存在");
    if (this.active(taskId)?.revision === snapshot.revision) return;
    if (snapshot.skillIds.some(id => !packages.some(pkg => pkg.id === id))) throw new Error("专家技能快照不完整");
    const directory = this.ownedPath(taskId, `work-${randomUUID()}`);
    try {
      const copies = copyExpertPackages(directory, packages);
      const owned: SkillCopy[] = copies.map(copy => ({ id: copy.id,
        relativePath: copy.directory.slice(this.taskRoot(taskId).length + 1), origin: copy.origin ?? "private" }));
      const desiredJson = JSON.stringify(snapshot);
      const skillsJson = JSON.stringify(owned);
      const updatedAt = Date.now();
      if (this.requiresRustWrites) {
        void this.enqueueBatch2("安装冻结专家", {
          kind: "taskExpertInstallFrozen",
          taskId,
          desiredJson,
          activeJson: desiredJson,
          desiredSkillsJson: skillsJson,
          activeSkillsJson: skillsJson,
          updatedAt,
        }).catch((err) => {
          console.warn("[TaskExpertBindingService] installFrozen Rust 写入失败", err);
        });
        return;
      }
      this.db.connection.transaction(() => {
        this.db.connection.prepare(`INSERT INTO task_expert_bindings(task_id,desired_json,active_json,desired_skills_json,active_skills_json,warnings_json,updated_at)
        VALUES (?,?,?,?,?,'[]',?) ON CONFLICT(task_id) DO UPDATE SET desired_json=excluded.desired_json,
        active_json=excluded.active_json,desired_skills_json=excluded.desired_skills_json,
        active_skills_json=excluded.active_skills_json,warnings_json='[]',updated_at=excluded.updated_at`)
        .run(taskId, desiredJson, desiredJson, skillsJson, skillsJson, updatedAt);
      })();
    } catch (error) {
      if (dirname(directory) === this.taskRoot(taskId)) rmSync(directory, { recursive: true, force: true });
      throw error;
    }
  }

  private taskRoot(taskId: string): string {
    return join(this.root, createHash("sha256").update(taskId).digest("hex"));
  }
  private ownedPath(taskId: string, relativePath: string): string {
    const taskRoot = this.taskRoot(taskId), path = resolve(taskRoot, relativePath);
    if (!path.startsWith(taskRoot + sep)) throw new Error("任务专家文件路径无效");
    return path;
  }
  activeSkillDirectories(taskId: string): string[] {
    return this.activeSkillPackages(taskId)
      .filter(copy => copy.origin !== "global" || this.options.isSkillEnabled?.(copy.id, taskId) !== false)
      .map(copy => copy.directory).filter(path => existsSync(path));
  }
  /** Host-owned package identities remain available for revocation checks after disable. */
  activeSkillPackages(taskId: string): Array<{ id: string; directory: string; origin: "private" | "global" }> {
    const row = this.row(taskId);
    const copies: SkillCopy[] = row ? JSON.parse(row.active_skills_json) : [];
    return copies.map(copy => ({ id: copy.id, directory: this.ownedPath(taskId, copy.relativePath), origin: copy.origin }));
  }
  activePrivateSkillsDir(taskId: string): string | undefined {
    const directories = this.activeSkillDirectories(taskId);
    return directories[0] ? dirname(directories[0]) : undefined;
  }

  /** One-time adoption of old task.expertId. Missing templates become an explicit cleared binding. */
  ensureLegacy(taskId: string): TaskExpertBindingDto | null {
    const existing = this.get(taskId);
    if (existing) return existing;
    const task = this.db.getTask(taskId);
    if (!task) throw new Error("任务不存在");
    if (!task.expertId) return null;
    if (this.requiresRustWrites) {
      let revisionDir: string | undefined;
      try {
        const prepared = this.prepareSave({ taskId, expertId: task.expertId, expectedRevision: null }, undefined);
        revisionDir = prepared.revisionDir;
        const { mutation } = prepared;
        void this.enqueueBatch2("迁移任务专家", {
          kind: "taskExpertWriteDesired",
          taskId,
          expectedDesiredJson: mutation.expectedDesiredJson,
          desiredJson: mutation.desiredJson,
          desiredSkillsJson: mutation.desiredSkillsJson,
          updatedAt: mutation.at,
        }).then(() => this.enqueueBatch2("激活迁移专家", {
          kind: "taskExpertPromote", taskId, updatedAt: Date.now(),
        })).catch((err) => {
          console.warn("[TaskExpertBindingService] ensureLegacy Rust 写入失败", err);
        });
        const snapshot = parseSnapshot(mutation.desiredJson);
        return { taskId, desired: snapshot, active: snapshot, pending: false };
      } catch (error) {
        this.discardRevision(taskId, revisionDir);
        const warning = `原专家无法迁移，已解除旧引用：${error instanceof Error ? error.message : String(error)}`;
        void this.enqueueBatch2("记录任务专家迁移失败", {
          kind: "taskExpertWriteLegacyFailure",
          taskId,
          warningsJson: JSON.stringify([warning]),
          updatedAt: Date.now(),
        }).catch((err) => {
          console.warn("[TaskExpertBindingService] ensureLegacy failure Rust 写入失败", err);
        });
        return { taskId, desired: null, active: null, pending: false, warnings: [warning] };
      }
    }
    try {
      const result = this.save({ taskId, expertId: task.expertId, expectedRevision: null });
      this.promote(taskId);
      return this.get(taskId) ?? result;
    } catch (error) {
      const warning = `原专家无法迁移，已解除旧引用：${error instanceof Error ? error.message : String(error)}`;
      this.db.connection.transaction(() => {
        this.db.connection.prepare(`INSERT INTO task_expert_bindings(task_id, desired_json, active_json, warnings_json, updated_at)
          VALUES (?, NULL, NULL, ?, ?)`).run(taskId, JSON.stringify([warning]), Date.now());
        this.db.setTaskExpertId(taskId, null);
      })();
      return this.get(taskId);
    }
  }

  private async ensureLegacyAsync(taskId: string): Promise<void> {
    if (!this.requiresRustWrites) {
      this.ensureLegacy(taskId);
      return;
    }
    const existing = this.get(taskId);
    if (existing) return;
    const task = this.db.getTask(taskId);
    if (!task) throw new Error("任务不存在");
    if (!task.expertId) return;
    let revisionDir: string | undefined;
    try {
      const prepared = this.prepareSave({ taskId, expertId: task.expertId, expectedRevision: null }, undefined);
      revisionDir = prepared.revisionDir;
      const { mutation } = prepared;
      await this.enqueueBatch2("迁移任务专家", {
        kind: "taskExpertWriteDesired",
        taskId,
        expectedDesiredJson: mutation.expectedDesiredJson,
        desiredJson: mutation.desiredJson,
        desiredSkillsJson: mutation.desiredSkillsJson,
        updatedAt: mutation.at,
      });
      await this.enqueueBatch2("激活迁移专家", { kind: "taskExpertPromote", taskId, updatedAt: Date.now() });
    } catch (error) {
      this.discardRevision(taskId, revisionDir);
      const warning = `原专家无法迁移，已解除旧引用：${error instanceof Error ? error.message : String(error)}`;
      await this.enqueueBatch2("记录任务专家迁移失败", {
        kind: "taskExpertWriteLegacyFailure",
        taskId,
        warningsJson: JSON.stringify([warning]),
        updatedAt: Date.now(),
      });
    }
  }

  private hostState(taskId: string): RuntimeTaskExpertBindingState {
    const task = this.db.getTask(taskId);
    if (!task) throw new Error("任务不存在");
    return { expertId: task.expertId ?? null, welcomeMode: task.welcomeMode ?? null, binding: this.row(taskId) ?? null };
  }

  private async settingsState(taskId: string): Promise<RuntimeTaskExpertBindingState> {
    const native = this.db.connection.inTransaction ? undefined : await this.db.runtimeAuditReader?.readTaskExpertBinding(taskId);
    if (native === null) throw new Error("任务不存在");
    const state = native ?? this.hostState(taskId);
    if (state.binding || !state.expertId) return state;
    await this.ensureLegacyAsync(taskId);
    const refreshed = this.db.connection.inTransaction ? undefined : await this.db.runtimeAuditReader?.readTaskExpertBinding(taskId);
    return refreshed ?? this.hostState(taskId);
  }

  private settings(taskId: string, state: RuntimeTaskExpertBindingState): BindingSettings {
    return {
      welcomeMode: normalizeWelcomeMode(state.welcomeMode),
      binding: state.binding ? this.decode(state.binding) : { taskId, desired: null, active: null, pending: false },
    };
  }

  async readSettings(taskId: string): Promise<BindingSettings> {
    return this.settings(taskId, await this.settingsState(taskId));
  }

  save(request: TaskExpertBindingSaveRequest): TaskExpertBindingDto {
    if (!this.db.getTask(request.taskId)) throw new Error("任务不存在");
    const { mutation, revisionDir } = this.prepareSave(request, this.row(request.taskId));
    if (this.requiresRustWrites) {
      try {
        void this.enqueueBatch2("保存任务专家配置", {
          kind: "taskExpertWriteDesired",
          taskId: mutation.taskId,
          expectedDesiredJson: mutation.expectedDesiredJson,
          desiredJson: mutation.desiredJson,
          desiredSkillsJson: mutation.desiredSkillsJson,
          updatedAt: mutation.at,
        }).catch((err) => {
          console.warn("[TaskExpertBindingService] save Rust 写入失败", err);
        });
        const existing = this.get(request.taskId);
        const desired = parseSnapshot(mutation.desiredJson);
        const active = existing?.active ?? null;
        return { taskId: request.taskId, desired, active, pending: revision(desired) !== revision(active) };
      } catch (error) {
        this.discardRevision(request.taskId, revisionDir);
        throw error;
      }
    }
    try {
      return this.db.connection.transaction(() => {
        this.writeDesired(mutation);
        return this.get(request.taskId)!;
      }).immediate();
    } catch (error) {
      this.discardRevision(request.taskId, revisionDir);
      throw error;
    }
  }

  async saveSettings(request: TaskExpertBindingSaveRequest): Promise<BindingSettings> {
    const native = this.db.connection.inTransaction ? undefined : this.db.runtimeAuditReader;
    if (this.requiresRustWrites && !native) {
      throw new Error("保存任务专家设置：Rust 写入核心未就绪");
    }
    const before = await this.settingsState(request.taskId);
    const { mutation, revisionDir } = this.prepareSave(request, before.binding);
    // Keep copied skills when transport fails after submission. The commit may already reference them.
    const reply = native ? await native.writeTaskExpertBinding(mutation) : { status: "needsHost" as const };
    if (!reply) throw new Error("无法确认人设保存结果，请刷新查看");
    if (reply.status === "saved") return this.settings(request.taskId, reply.state);
    let state: RuntimeTaskExpertBindingState;
    try {
      if (reply.status === "stale") throw new Error("人设已被修改，请刷新后重试");
      if (reply.status === "missing") throw new Error("任务不存在");
      if (reply.status === "rejected") throw new Error(reply.message);
      if (this.requiresRustWrites) throw new Error("人设保存无法回退到宿主 SQLite");
      state = this.db.connection.transaction(() => {
        if (!this.db.getTask(request.taskId)) throw new Error("任务不存在");
        this.writeDesired(mutation);
        this.db.connection.prepare("UPDATE tasks SET expert_id=?, updated_at=MAX(updated_at, ?) WHERE id=?")
          .run(mutation.expertId, mutation.at, request.taskId);
        return this.hostState(request.taskId);
      }).immediate();
    } catch (error) {
      this.discardRevision(request.taskId, revisionDir);
      throw error;
    }
    return this.settings(request.taskId, state);
  }

  private prepareSave(request: TaskExpertBindingSaveRequest, before: BindingRow | null | undefined) {
    const prior = before && parseSnapshot(before.desired_json);
    if (request.expectedRevision !== undefined && request.expectedRevision !== revision(prior ?? null)) {
      throw new Error("人设已被修改，请刷新后重试");
    }
    if (request.custom && request.expertId !== undefined) throw new Error("不能同时设置模板和自定义人设");
    let snapshot: TaskExpertSnapshot | null = null;
    let privateRoot: string | null = null;
    if (request.custom) {
      snapshot = {
        revision: randomUUID(), ...(prior?.sourceExpertId ? { sourceExpertId: prior.sourceExpertId, sourceRevision: prior.sourceRevision } : {}),
        name: text(request.custom.name, "人设名称", 200), instructions: text(request.custom.instructions, "人设说明", 120_000),
        skillIds: ids(request.custom.skillIds, "技能"), mcpIds: ids(request.custom.mcpIds, "MCP"), connectorIds: ids(request.custom.connectorIds, "连接器"),
      };
    } else if (typeof request.expertId === "string" && request.expertId.trim()) {
      const detail = this.experts.getDetail(request.expertId);
      if (!detail.enabled) throw new Error(`专家「${detail.name}」已停用`);
      snapshot = { revision: randomUUID(), sourceExpertId: detail.id, sourceRevision: detail.revision,
        name: text(detail.name, "人设名称", 200), instructions: text(detail.instructions, "人设说明", 120_000),
        skillIds: ids(detail.skills ?? [], "技能"), mcpIds: ids(detail.mcpIds, "MCP"), connectorIds: ids(detail.connectorIds, "连接器") };
      privateRoot = this.experts.getPrivateSkillsDir(detail.id);
    } else if (request.expertId !== null) throw new Error("请选择专家、提供人设内容或明确解除绑定");

    const copies: SkillCopy[] = [];
    const revisionDir = snapshot ? this.ownedPath(request.taskId, snapshot.revision) : undefined;
    try {
      if (snapshot && revisionDir) {
        const retained: SkillCopy[] = before ? JSON.parse(before.desired_skills_json) : [];
        for (const [index, id] of snapshot.skillIds.entries()) {
          const old = request.custom ? retained.find(copy => copy.id === id) : undefined;
          const privateCandidate = privateRoot ? resolve(privateRoot, id) : undefined;
          const privateSource = privateCandidate && privateCandidate.startsWith(resolve(privateRoot!) + sep) && existsSync(privateCandidate)
            ? privateCandidate : privateRoot && existsSync(join(privateRoot, "SKILL.md")) && snapshot.skillIds.length === 1 ? privateRoot : undefined;
          const source = old ? this.ownedPath(request.taskId, old.relativePath) : privateSource ?? this.options.resolveSkillDirectory?.(id);
          if (!source || !existsSync(source)) throw new Error(`技能「${id}」的完整包不可用，请重新选择`);
          const relativePath = join(snapshot.revision, "skills", `${index}-${createHash("sha256").update(id).digest("hex").slice(0, 16)}`);
          const destination = this.ownedPath(request.taskId, relativePath);
          mkdirSync(dirname(destination), { recursive: true });
          cpSync(source, destination, { recursive: true, errorOnExist: true, force: false, filter: path => {
            const stat = lstatSync(path);
            if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory())) throw new Error(`技能包不允许链接或特殊文件：${id}`);
            return true;
          } });
          copies.push({ id, relativePath, origin: old?.origin ?? (privateSource ? "private" : "global") });
        }
      }
      const mutation: RuntimeTaskExpertBindingMutation = {
        taskId: request.taskId,
        expectedDesiredJson: before?.desired_json ?? null,
        desiredJson: snapshot ? JSON.stringify(snapshot) : null,
        desiredSkillsJson: JSON.stringify(copies),
        expertId: snapshot?.sourceExpertId ?? null,
        at: Date.now(),
      };
      return { mutation, revisionDir };
    } catch (error) {
      this.discardRevision(request.taskId, revisionDir);
      throw error;
    }
  }

  private writeDesired(mutation: RuntimeTaskExpertBindingMutation): void {
    const current = this.row(mutation.taskId);
    if ((current?.desired_json ?? null) !== mutation.expectedDesiredJson) throw new Error("人设已被修改，请刷新后重试");
    this.db.connection.prepare(`INSERT INTO task_expert_bindings(task_id, desired_json, active_json, desired_skills_json, active_skills_json, warnings_json, updated_at)
      VALUES (?, ?, NULL, ?, '[]', '[]', ?) ON CONFLICT(task_id) DO UPDATE SET
      desired_json=excluded.desired_json, desired_skills_json=excluded.desired_skills_json, warnings_json='[]', updated_at=excluded.updated_at`)
      .run(mutation.taskId, mutation.desiredJson, mutation.desiredSkillsJson, mutation.at);
  }

  private discardRevision(taskId: string, revisionDir?: string): void {
    if (revisionDir && dirname(revisionDir) === this.taskRoot(taskId)) rmSync(revisionDir, { recursive: true, force: true });
  }

  /** Caller must establish a safe idle boundary; this never schedules or interrupts work. */
  promote(taskId: string): TaskExpertBindingDto | null {
    const updatedAt = Date.now();
    if (this.requiresRustWrites) {
      const current = this.get(taskId);
      void this.enqueueBatch2("激活任务专家配置", { kind: "taskExpertPromote", taskId, updatedAt }).catch((err) => {
        console.warn("[TaskExpertBindingService] promote Rust 写入失败", err);
      });
      return current ? { ...current, active: current.desired, pending: false } : null;
    }
    this.db.connection.prepare(`UPDATE task_expert_bindings SET active_json=desired_json,
      active_skills_json=desired_skills_json, updated_at=? WHERE task_id=?`).run(updatedAt, taskId);
    return this.get(taskId);
  }
  purge(taskId: string): void {
    if (this.db.getTask(taskId)) throw new Error("只能清理已永久删除任务的人设文件");
    const directory = resolve(this.taskRoot(taskId));
    if (dirname(directory) !== this.root) throw new Error("任务专家清理路径无效");
    rmSync(directory, { recursive: true, force: true });
  }
}
