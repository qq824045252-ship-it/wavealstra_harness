/**
 * ArtifactService — V3.5 Wave 2（§8/§9-13/§21-23/§68-69）
 *
 * Main 唯一业务 façade。Renderer 不直接访问 Repository/Storage/Registry。
 *
 * 注册事务（§9-13）：
 *   Step A materialize source
 *   Step B validate materialized result
 *   Step C write metadata transaction  ← COMMIT POINT（§10）
 *   Step D update Registry（失败不回滚 DB，log + 下次 hydrate 重建）
 *   Step E broadcast artifact event（失败不回滚 DB，snapshot 可恢复）
 *
 * hydrate 语义（§21-23）：active task 启动 hydrate；其他 task lazy hydrate on demand。
 * Service 提供能力，不内置 prefetch N（§24：recent N 不是 Domain contract）。
 */
import { existsSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  previewWorkspaceFile,
  workspaceImageVariant,
} from "../workspace/WorkspaceService";
import { artifactImageUrl } from "../../shared/artifact-ipc";
import { chatUploadName } from "../../shared/chat-upload";
import {
  isPathInsideOrEqual,
  MANIFEST_FILENAME,
  MANIFEST_TMP_SUFFIX,
  normalizePathForComparison,
} from "../task/TaskExecutionWorkspace";
import type {
  ArtifactCreatedEvent,
  ArtifactDescriptor,
  ArtifactFileDependency,
  ArtifactMessageRef,
  ArtifactMessageRelation,
  ArtifactRegistration,
  ArtifactRemovedEvent,
  ArtifactSnapshot,
  ArtifactUpdatedEvent,
  WorkspaceChangedEvent,
  ArtifactLoadState,
} from "../../shared/artifact-types";
import { ArtifactStorage } from "./ArtifactStorage";
import { ArtifactRepository, artifactFromRow, artifactToRow, type ArtifactRow, type StoredArtifactSnapshot } from "./ArtifactRepository";
import type { RuntimeArtifactContent, RuntimeArtifactMutation, RuntimeAuditReader, RuntimeGadgetArtifactSource } from "../platform/runtime-audit";
import { ArtifactRegistry } from "./ArtifactRegistry";
import { inspectArtifactFolderRelocation, type ArtifactFolderChange } from "./ArtifactFolderRelocation";

/** 位图走协议 URL（SVG 是文本，仍走原 content 契约） */
const INLINE_IMAGE_EXTENSIONS = new Set([
  ".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif", ".avif", ".ico",
]);

function isPptdProjectDependency(manifestPath: string, candidatePath: string): boolean {
  if (extname(manifestPath).toLowerCase() !== ".pptd") return false;
  const manifest = resolve(manifestPath).replace(/\\/g, "/").toLowerCase();
  const candidate = resolve(candidatePath).replace(/\\/g, "/").toLowerCase();
  const slash = manifest.lastIndexOf("/");
  const projectDir = slash >= 0 ? manifest.slice(0, slash) : manifest;
  return candidate.startsWith(`${projectDir}/pages/`) || candidate.startsWith(`${projectDir}/media/`);
}

function isChatUpload(path: string): boolean {
  return Boolean(chatUploadName(path)) &&
    normalizePathForComparison(dirname(path)) === normalizePathForComparison(join(homedir(), ".mybuddy", "uploads"));
}

function isOutputArtifact({ source }: ArtifactDescriptor): boolean {
  return source.type !== "workspace-file" || !isChatUpload(source.entryFile);
}

export interface ArtifactEventSink {
  created?(event: ArtifactCreatedEvent): void;
  updated?(event: ArtifactUpdatedEvent): void;
  removed?(event: ArtifactRemovedEvent): void;
}

interface GadgetHtmlSource {
  source: RuntimeGadgetArtifactSource;
  readOnHost(): string;
}

export class ArtifactService {
  private writeTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly storage: ArtifactStorage,
    private readonly repository: ArtifactRepository,
    private readonly registry: ArtifactRegistry,
    private readonly eventSink?: ArtifactEventSink,
    private readonly runtimeAuditReader?: RuntimeAuditReader,
  ) {}

  runWithArtifactWrites<T>(write: () => T | Promise<T>): Promise<T> {
    const result = this.writeTail.then(write);
    this.writeTail = result.then(() => undefined, () => undefined);
    return result;
  }

  async flushWrites(): Promise<void> {
    await this.writeTail;
  }

  private async writeArtifact<T>(taskId: string, mutation: RuntimeArtifactMutation, writeOnHost: () => T): Promise<T> {
    const reader = this.runtimeAuditReader;
    if (!reader || this.repository.inTransaction) return writeOnHost();
    const operationId = randomUUID();
    const result = await reader.writeArtifact<T>(taskId, operationId, mutation);
    return result ?? this.repository.getWriteReceipt<T>(taskId, operationId) ?? writeOnHost();
  }

  inspectFolderRelocation(oldRoot: string, newRoot: string, taskIds: ReadonlySet<string>): ArtifactFolderChange[] {
    return inspectArtifactFolderRelocation(this.repository, oldRoot, newRoot, taskIds);
  }

  /** Caller owns the outer SQLite transaction containing the project bindings. */
  applyFolderRelocation(changes: ArtifactFolderChange[]): ArtifactUpdatedEvent[] {
    if (!this.repository.inTransaction) throw new Error("产物目录更新必须在项目事务内执行");
    return changes.map((change) => {
      const descriptor = { ...change.before, source: change.source, version: change.before.version + 1, updatedAt: Date.now() };
      this.repository.update(descriptor);
      this.repository.replaceFileDependencies(descriptor.id, change.dependencies);
      const revision = this.repository.bumpTaskRevision(descriptor.taskId);
      return { artifactId: descriptor.id, taskId: descriptor.taskId, version: descriptor.version, revision, descriptor };
    });
  }

  /** Only after the outer transaction commits; rollback must never leak to caches or events. */
  publishFolderRelocation(events: ArtifactUpdatedEvent[]): void {
    for (const event of events) {
      try { this.registry.upsert(event.descriptor); }
      catch (error) { this.registry.invalidateTask(event.taskId); console.error("Artifact relocation cache refresh failed", error); }
      try { this.eventSink?.updated?.(event); }
      catch (error) { console.error("Artifact relocation notification failed", error); }
    }
  }

  // ---------- 注册事务（§9-13） ----------

  /**
   * 注册 Artifact。ArtifactRegistration（可含 raw content / workspace file）
   * → ArtifactDescriptor（持久对象不含 content）。
   * 失败矩阵：
   *   materialize fail → 抛错，无 DB row
   *   DB fail → attempt 删除已 materialize 内容；删除失败 → orphan（GC 清理）
   *   registry/event fail → DB 保留，不回滚（§12/§13）
   */
  register(registration: ArtifactRegistration): Promise<ArtifactDescriptor> {
    return this.runWithArtifactWrites(() => this.registerArtifact(registration));
  }

  registerGadgetHtml(taskId: string, title: string, gadget: GadgetHtmlSource): Promise<ArtifactDescriptor> {
    return this.runWithArtifactWrites(() => this.registerArtifact({ taskId, kind: "html", title }, gadget));
  }

  registerWorkspaceOutput(registration: ArtifactRegistration & Required<Pick<ArtifactRegistration, "workspaceFile">>): Promise<ArtifactDescriptor> {
    return this.runWithArtifactWrites(() => {
      const existing = this.findByEntryFile(registration.taskId, registration.workspaceFile.entryFile);
      if (!existing) return this.registerArtifact(registration);
      if (registration.producerMessageId) {
        try { this.addMessageRef({ taskId: existing.taskId, messageId: registration.producerMessageId,
          artifactId: existing.id, relation: "updated", toolCallId: registration.producerToolCallId }); }
        catch (error) { console.warn("[ArtifactService] workspace output reference failed", error); }
      }
      return existing;
    });
  }

  private async registerArtifact(registration: ArtifactRegistration, gadget?: GadgetHtmlSource): Promise<ArtifactDescriptor> {
    if (!registration.taskId || !registration.kind) {
      throw new Error("ArtifactRegistration 必须包含 taskId 与 kind");
    }
    // 重复 ID 冲突（§W2.2②）：register 不是 upsert；在 materialize 之前拦截 → 不产生 orphan 文件
    if (registration.id) {
      if (this.repository.get(registration.id)) {
        throw new Error(`Artifact ID 已存在（register 不做 upsert，请用 update）: ${registration.id}`);
      }
    }
    const now = Date.now();
    const id = registration.id ?? `art-${Buffer.from(`${registration.taskId}:${now}:${Math.random().toString(36).slice(2, 8)}`).toString("base64url")}`;

    let source: ArtifactDescriptor["source"];
    if (registration.workspaceFile) {
      if (isChatUpload(registration.workspaceFile.entryFile)) throw new Error("聊天上传附件不能登记为任务产物");
      source = {
        type: "workspace-file",
        entryFile: registration.workspaceFile.entryFile,
        rootDir: registration.workspaceFile.rootDir,
      };
    } else if (gadget || registration.content !== undefined) {
      if (!gadget && (typeof registration.content !== "string" || registration.content.length === 0)) {
        throw new Error("managed-content 注册必须提供非空 content");
      }
      source = {
        type: "managed-content",
        storagePath: this.storage.pathFor(registration.taskId, id, registration.kind),
        rootDir: this.storage.root,
      };
    } else {
      throw new Error("ArtifactRegistration 必须提供 workspaceFile 或 content 之一");
    }

    // Step B：validate（source 完整性）
    if (source.type === "workspace-file" && !source.entryFile) {
      throw new Error("workspace-file source 必须提供 entryFile");
    }
    // P0 §10.2：workspace-file 的 entryFile 必须位于它声明的 rootDir 内（词法校验；
    // realpath/Junction 由 AgentService ingest 层对 canonical taskRoot 再保证）
    if (source.type === "workspace-file") {
      if (!isPathInsideOrEqual(source.rootDir, source.entryFile)) {
        throw new Error(
          `workspace-file entryFile 必须位于 rootDir 内：${source.entryFile} ∉ ${source.rootDir}`,
        );
      }
    }

    const producerMessageId = registration.producerMessageId?.trim() || undefined;
    const producerToolCallId = registration.producerToolCallId?.trim() || undefined;

    const descriptor: ArtifactDescriptor = {
      id,
      taskId: registration.taskId,
      spaceId: registration.spaceId,
      kind: registration.kind,
      source,
      version: 1,
      capabilities: registration.capabilities ?? {},
      title: registration.title,
      mimeType: registration.mimeType,
      // P1 §14：首次创建者；历史调用不传则保持 undefined（NULL）
      createdByMessageId: producerMessageId,
      createdByToolCallId: producerToolCallId,
      createdAt: now,
      updatedAt: now,
    };

    const revision = source.type === "managed-content"
      ? await this.registerManagedContent(descriptor, registration.content, gadget)
      : await this.registerMetadata(descriptor);

    // Step D：Registry（失败不回滚 metadata，§12）
    try {
      this.registry.upsert(descriptor);
    } catch (error) {
      console.error("[ArtifactService] Registry 更新失败（DB 保留，下次 hydrate 重建）:", error);
    }

    // Step E：broadcast（失败不回滚，§13）
    const createdEvent: ArtifactCreatedEvent = {
      artifactId: descriptor.id,
      taskId: descriptor.taskId,
      version: descriptor.version,
      revision,
      descriptor,
    };
    try {
      this.eventSink?.created?.(createdEvent);
    } catch (error) {
      console.error("[ArtifactService] artifact 事件广播失败（snapshot 可恢复）:", error);
    }

    return descriptor;
  }

  private async registerManagedContent(descriptor: ArtifactDescriptor, text: string | undefined, gadget?: GadgetHtmlSource): Promise<number> {
    const content: RuntimeArtifactContent = gadget ? { kind: "gadget", ...gadget.source } : { kind: "text", content: text! };
    const revision = await this.writeManagedArtifact(descriptor, content);
    if (revision !== undefined) return revision;

    const hostContent = gadget ? gadget.readOnHost() : text!;
    if (!hostContent.length) throw new Error("managed-content 注册必须提供非空 content");
    let storagePath: string;
    try {
      storagePath = this.runtimeAuditReader
        ? await this.storage.materializeAsync(descriptor.taskId, descriptor.id, hostContent, descriptor.kind)
        : this.storage.materialize(descriptor.taskId, descriptor.id, hostContent, descriptor.kind);
    } catch (error) {
      throw new Error(`materialize 失败: ${error instanceof Error ? error.message : String(error)}`);
    }
    descriptor.source = { type: "managed-content", storagePath, rootDir: this.storage.root };
    try {
      return await this.registerMetadata(descriptor);
    } catch (error) {
      if ((await this.removeManagedContents([storagePath])).length) {
        console.error("[ArtifactService] DB 失败且内容删除失败（orphan 待 GC）:", storagePath);
      }
      throw error;
    }
  }

  private async writeManagedArtifact(descriptor: ArtifactDescriptor, content: RuntimeArtifactContent): Promise<number | undefined> {
    const reader = this.runtimeAuditReader;
    if (!reader || this.repository.inTransaction || !isAbsolute(this.storage.root)) return undefined;
    const taskId = descriptor.taskId;
    const operationId = randomUUID();
    const row = artifactToRow(descriptor);
    const operation = () => reader.writeManagedArtifact(taskId, operationId, row, content);
    const result = await operation();
    if (result === "needsHost") return undefined;
    if (result?.status === "saved") return result.revision;
    if (result?.status === "failed") throw new Error(result.message);
    const receipt = this.repository.getWriteReceipt<{ revision: number }>(taskId, operationId);
    if (receipt) return receipt.revision;
    const retry = await operation();
    if (retry && retry !== "needsHost") {
      if (retry.status === "failed") throw new Error(retry.message);
      return retry.revision;
    }
    const saved = this.repository.getWriteReceipt<{ revision: number }>(taskId, operationId);
    if (saved) return saved.revision;
    throw new Error("成果登记结果未确认，请刷新列表");
  }

  private async registerMetadata(descriptor: ArtifactDescriptor): Promise<number> {
    try {
      const result = await this.writeArtifact(descriptor.taskId, { kind: "register", row: artifactToRow(descriptor) },
        () => this.repository.transaction(() => {
          this.repository.insert(descriptor);
          if (descriptor.createdByMessageId) {
            this.repository.addMessageRef({
              taskId: descriptor.taskId,
              messageId: descriptor.createdByMessageId,
              artifactId: descriptor.id,
              relation: "created",
              toolCallId: descriptor.createdByToolCallId,
            });
          }
          return { revision: this.repository.bumpTaskRevision(descriptor.taskId) };
        }));
      return result.revision;
    } catch (error) {
      throw new Error(`metadata 写入失败（已回滚内容）: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  private async readManagedContent(storagePath: string, inlineRaster = false): Promise<{ content: string } | { raster: true } | null> {
    const reader = this.runtimeAuditReader;
    const result = await reader?.readManagedArtifact(this.storage.root, storagePath, inlineRaster);
    if (result?.status === "content") return { content: result.content };
    if (result?.status === "raster") return { raster: true };
    if (result?.status === "missing") return null;
    if (result?.status === "failed") throw new Error(result.message);
    const content = reader ? await this.storage.readAsync(storagePath) : this.storage.read(storagePath);
    return content === null ? null : { content };
  }

  private async removeManagedContents(paths: string[]): Promise<string[]> {
    if (!paths.length) return [];
    const reader = this.runtimeAuditReader;
    if (reader && !this.repository.inTransaction && isAbsolute(this.storage.root)) {
      const cleaned = await reader.cleanupArtifactFiles(this.storage.root, { kind: "selected", paths });
      if (cleaned !== "needsHost") return cleaned?.failed ?? paths;
    }
    const failed: string[] = [];
    for (const storagePath of paths) {
      const removed = reader ? await this.storage.removeAsync(storagePath) : this.storage.remove(storagePath);
      if (!removed) failed.push(storagePath);
    }
    return failed;
  }

  // ---------- 查询 ----------

  get(id: string): ArtifactDescriptor | null {
    const artifact = this.registry.get(id) ?? this.repository.get(id);
    return artifact && isOutputArtifact(artifact) ? artifact : null;
  }

  listByTask(taskId: string): ArtifactDescriptor[] {
    if (this.registry.hasTask(taskId)) return this.registry.listByTask(taskId);
    const artifacts = this.repository.listByTask(taskId).filter(isOutputArtifact);
    this.registry.replaceTask(taskId, artifacts);
    return artifacts;
  }

  /**
   * 返回 artifact 的本地入口文件绝对路径（供受控的系统打开等主进程能力使用）。
   * workspace-file 复用与 readContent 相同的 root 边界；managed-content 仅允许 Storage.resolve 解析。
   */
  entryPathOf(artifactId: string): string | null {
    const descriptor = this.get(artifactId);
    if (!descriptor) return null;
    if (descriptor.source.type === "managed-content") {
      if (!this.storage.exists(descriptor.source.storagePath)) return null;
      return this.storage.resolve(descriptor.source.storagePath);
    }
    const root = resolve(descriptor.source.rootDir);
    const target = resolve(descriptor.source.entryFile);
    const rel = relative(root, target);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) || !existsSync(target)) {
      return null;
    }
    return target;
  }

  /** Local visual-editor commits update both managed and workspace-backed aliases. */
  notifyHtmlSaved(path: string): Promise<void> {
    return this.runWithArtifactWrites(async () => {
      const normalized = normalizePathForComparison(path);
      const matches = new Map<string, string[]>();
      for (const descriptor of this.repository.listAll()) {
        const entry = this.entryPathOf(descriptor.id);
        if (!entry || normalizePathForComparison(entry) !== normalized) continue;
        const ids = matches.get(descriptor.taskId) ?? [];
        ids.push(descriptor.id);
        matches.set(descriptor.taskId, ids);
      }
      for (const [taskId, ids] of matches) await this.refreshArtifacts(taskId, ids);
    });
  }

  /**
   * 内容解析 root 边界（V3.5 §17/4B WebArtifactRuntime 安全 contract）：
   * workspace-file → source.rootDir；managed-content → storage 目录（入口文件所在目录）。
   * 未知 id → null。
   */
  rootOf(artifactId: string): string | null {
    const descriptor = this.get(artifactId);
    if (!descriptor) return null;
    if (descriptor.source.type === "workspace-file") return descriptor.source.rootDir;
    // managed-content：storagePath = <taskId>/<artifactId>/index.<ext>（相对 storage root）
    const idx = Math.max(
      descriptor.source.storagePath.lastIndexOf("/"),
      descriptor.source.storagePath.lastIndexOf("\\"),
    );
    if (idx < 0) return this.storage.root;
    return join(this.storage.root, descriptor.source.storagePath.slice(0, idx));
  }

  // ---------- 更新 / 删除 ----------

  /**
   * 元数据更新（title/mime/capabilities）；version 不 bump（T14 冻结：内容变化走 markFilesChanged）。
   * task revision 照常 ++ 并广播 updated（Renderer projection 需要感知 descriptor 变化）。
   */
  update(id: string, patch: Partial<Pick<ArtifactDescriptor, "title" | "mimeType" | "spaceId" | "capabilities">>): ArtifactDescriptor | null {
    const existing = this.repository.get(id);
    if (!existing) return null;
    const next: ArtifactDescriptor = {
      ...existing,
      ...patch,
      updatedAt: Date.now(),
    };
    let revision = 0;
    this.repository.transaction(() => {
      this.repository.update(next);
      revision = this.repository.bumpTaskRevision(next.taskId);
    });
    this.registry.upsert(next);
    const evt: ArtifactUpdatedEvent = {
      artifactId: next.id,
      taskId: next.taskId,
      version: next.version,
      revision,
      descriptor: next,
    };
    try {
      this.eventSink?.updated?.(evt);
    } catch (error) {
      console.error("[ArtifactService] updated 事件广播失败:", error);
    }
    return next;
  }

  /** 删除（§W2.2④ 冻结顺序）：Repository delete = COMMIT POINT → Registry remove → broadcast removed
   *  → managed storage cleanup。storage 删除失败不阻塞已提交的删除；文件残留 → orphan（后续 GC）。 */
  remove(id: string): Promise<boolean> {
    return this.runWithArtifactWrites(async () => {
      const descriptor = this.repository.get(id);
      if (!descriptor) {
        this.registry.remove(id);
        return false;
      }
      return (await this.removeArtifacts(descriptor.taskId, id, false)).removed > 0;
    });
  }

  // ---------- hydrate（§21-23/§25） ----------

  async readTaskSnapshots(taskIds: readonly string[]): Promise<StoredArtifactSnapshot[]> {
    if (taskIds.length === 0) return [];
    const ids = [...new Set(taskIds)];
    const native = await this.runtimeAuditReader?.artifactSnapshots(ids);
    return (native ?? this.repository.readSnapshots(ids)).map(snapshot => ({
      ...snapshot, artifacts: snapshot.artifacts.filter(isOutputArtifact),
    }));
  }

  /**
   * task 级 lazy hydrate：repository → registry → snapshot。
   * 调用方决定时机（启动 active task / task switch / idle prefetch）。
   */
  hydrateTask(taskId: string): ArtifactSnapshot {
    try {
      const artifacts = this.repository.listByTask(taskId).filter(isOutputArtifact);
      const revision = this.repository.getTaskRevision(taskId);
      this.registry.replaceTask(taskId, artifacts);
      return { taskId, artifacts, revision, state: "ready" };
    } catch (error) {
      // hydrate 失败（§W2.2⑤）：task cache 必须 invalidate（不残留半份/旧数据），下一次允许重试
      this.registry.invalidateTask(taskId);
      return {
        taskId,
        artifacts: [],
        revision: 0,
        state: "error",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  getSnapshot(taskId: string): ArtifactSnapshot {
    const artifacts = this.listByTask(taskId);
    return {
      taskId,
      artifacts,
      revision: this.repository.getTaskRevision(taskId),
      state: artifacts.length ? "ready" : "unloaded",
    };
  }

  // ---------- P1 消息溯源 / 依赖（§14-15） ----------

  /**
   * 幂等写入消息引用（created/updated/referenced）。
   * task-scoped：artifact 必须属于 taskId；重复 (task,message,artifact,relation) 忽略。
   */
  addMessageRef(input: {
    taskId: string;
    messageId: string;
    artifactId: string;
    relation: ArtifactMessageRelation;
    toolCallId?: string;
  }): boolean {
    return this.repository.addMessageRef(input);
  }

  /** task-scoped 查询 refs；重启后消息卡片可从持久 refs 恢复 */
  listMessageRefs(
    taskId: string,
    filter?: { messageId?: string; artifactId?: string },
  ): ArtifactMessageRef[] {
    return this.repository.listMessageRefs(taskId, filter);
  }

  /**
   * 设置多文件 Artifact 的显式依赖（P1 §15）。
   * 每条路径必须位于 artifact 的 rootDir（workspace-file）或 taskRoot 内；
   * 不在边界内的路径被拒绝，不写半份依赖。
   */
  setFileDependencies(
    artifactId: string,
    filePaths: string[],
    dependencyKind = "runtime",
  ): ArtifactFileDependency[] {
    const descriptor = this.get(artifactId);
    if (!descriptor) throw new Error(`setFileDependencies: artifact 不存在 ${artifactId}`);
    if (descriptor.source.type !== "workspace-file") {
      throw new Error("setFileDependencies 仅支持 workspace-file artifact");
    }
    const root = descriptor.source.rootDir;
    const normalized: Array<{ filePath: string; dependencyKind?: string }> = [];
    for (const raw of filePaths) {
      const abs = resolve(raw);
      if (!isPathInsideOrEqual(root, abs)) {
        throw new Error(`依赖路径必须位于 artifact rootDir 内：${abs} ∉ ${root}`);
      }
      normalized.push({ filePath: abs, dependencyKind });
    }
    this.repository.transaction(() => {
      this.repository.replaceFileDependencies(artifactId, normalized);
      this.repository.bumpTaskRevision(descriptor.taskId);
    });
    return this.repository.listFileDependencies(artifactId);
  }

  listFileDependencies(artifactId: string): ArtifactFileDependency[] {
    return this.repository.listFileDependencies(artifactId);
  }

  // ---------- Refresh（§68-69 / P1 §15 精确刷新） ----------

  /**
   * WorkspaceChangedEvent → 受影响的 artifact version++ → artifact:updated。
   * P1 精确匹配：
   *   - 单文件：changedFile 规范化后 == entryFile
   *   - 多文件：changedFile 命中 artifact_file_dependencies 中任一条
   *   - 不再把「rootDir 下任意文件」当作依赖（P0 临时规则废止）
   * version++ 由 Repository transaction 完成（重启后正确）。
   * 同回合多个依赖仍只 +1（每个 artifact 最多一次 markChanged）。
   */
  markFilesChanged(event: WorkspaceChangedEvent): Promise<ArtifactUpdatedEvent[]> {
    return this.runWithArtifactWrites(() => this.markAffectedArtifacts(event));
  }

  private async markAffectedArtifacts(event: WorkspaceChangedEvent): Promise<ArtifactUpdatedEvent[]> {
    // P0 §10.2：taskId/cwd 非空；changedFiles 必须位于 event.cwd 内；manifest/内部临时文件不参与刷新
    if (!event.taskId || !event.cwd || !Array.isArray(event.changedFiles)) return [];
    const changed = event.changedFiles.filter((f) => {
      const base = basename(f.replace(/\\/g, "/"));
      if (base === MANIFEST_FILENAME || f.endsWith(MANIFEST_TMP_SUFFIX)) return false;
      return isPathInsideOrEqual(event.cwd, f);
    });
    const changedNorm = new Set(changed.map((f) => normalizePathForComparison(f)));
    // §10.2/§10.3：旧共享 root Artifact 不被新 canonical task event 刷新
    const eventRoot = normalizePathForComparison(event.cwd);
    const messageId = event.messageId?.trim() || undefined;
    const toolCallId = event.toolCallId?.trim() || undefined;
    const affected: string[] = [];
    for (const descriptor of this.listByTask(event.taskId)) {
      if (descriptor.source.type !== "workspace-file") continue;
      if (normalizePathForComparison(descriptor.source.rootDir) !== eventRoot) continue;
      if (messageId && descriptor.createdByMessageId === messageId) continue;

      const entryFile = descriptor.source.entryFile;
      const entryHit = changedNorm.has(normalizePathForComparison(entryFile));
      let depHit = false;
      if (!entryHit) {
        const deps = this.repository.listFileDependencies(descriptor.id);
        depHit = deps.some((d) => changedNorm.has(normalizePathForComparison(d.filePath)));
      }
      const pptdProjectHit = !entryHit && !depHit && changed.some((filePath) =>
        isPptdProjectDependency(entryFile, filePath),
      );
      if (!entryHit && !depHit && !pptdProjectHit) continue;

      affected.push(descriptor.id);
    }
    return this.refreshArtifacts(event.taskId, affected, messageId, toolCallId);
  }

  private async refreshArtifacts(taskId: string, ids: string[], messageId?: string, toolCallId?: string): Promise<ArtifactUpdatedEvent[]> {
    if (!ids.length) return [];
    const result = await this.writeArtifact<{ items: Array<{ row: ArtifactRow; revision: number }> }>(taskId, {
      kind: "refresh", ids, messageId, toolCallId, at: Date.now(),
    }, () => this.repository.transaction(() => {
      const items: Array<{ row: ArtifactRow; revision: number }> = [];
      for (const id of ids) {
        const next = this.repository.markChanged(id);
        if (!next) continue;
        if (messageId) this.repository.addMessageRef({ taskId, messageId, artifactId: id, relation: "updated", toolCallId });
        items.push({ row: artifactToRow(next), revision: this.repository.bumpTaskRevision(taskId) });
      }
      return { items };
    }));
    return result.items.map(({ row, revision }) => {
      const next = artifactFromRow(row);
      this.registry.upsert(next);
      const evt: ArtifactUpdatedEvent = {
        artifactId: next.id,
        taskId: next.taskId,
        version: next.version,
        revision,
        descriptor: next,
      };
      try {
        this.eventSink?.updated?.(evt);
      } catch (error) {
        console.error("[ArtifactService] updated 事件广播失败:", error);
      }
      return evt;
    });
  }

  // ---------- Task 生命周期（3B.6） ----------

  /**
   * 删除 task 的全部 Artifact（冻结顺序）：DB delete = COMMIT POINT → Registry invalidateTask
   * → removed 事件广播 → managed storage cleanup。storage 失败 → orphan（GC 后续清理）。
   * removed 事件共享同一次 bump 的 revision（reducer 对 removed 允许 >= guard，批量幂等）。
   */
  removeByTask(taskId: string, options?: { requireTrashed?: boolean }): Promise<{ removed: number; orphaned: number }> {
    return this.runWithArtifactWrites(() => this.removeArtifacts(taskId, undefined, options?.requireTrashed ?? false));
  }

  private async removeArtifacts(taskId: string, id: string | undefined, requireTrashed: boolean): Promise<{ removed: number; orphaned: number }> {
    const result = await this.writeArtifact<{ allowed: boolean; revision: number | null; items: Array<{ id: string; storagePath: string | null }> }>(
      taskId, { kind: "remove", id, requireTrashed }, () => this.repository.transaction(() => {
        if (requireTrashed && !this.repository.canPurge(taskId)) return { allowed: false, revision: null, items: [] };
        const descriptor = id ? this.repository.get(id) : undefined;
        if (id && (!descriptor || descriptor.taskId !== taskId)) return { allowed: true, revision: null, items: [] };
        const descriptors = descriptor ? [descriptor] : this.repository.listByTask(taskId);
        if (id) this.repository.remove(id);
        else this.repository.removeByTask(taskId);
        return { allowed: true, revision: this.repository.bumpTaskRevision(taskId), items: descriptors.map(item => ({
          id: item.id, storagePath: item.source.type === "managed-content" ? item.source.storagePath : null,
        })) };
      }),
    );
    if (!result.allowed) throw new Error(`成果清理中止：任务已离开回收区：${taskId}`);
    if (id) this.registry.remove(id);
    else this.registry.invalidateTask(taskId);
    if (result.revision === null) return { removed: 0, orphaned: 0 };
    for (const item of result.items) {
      const evt: ArtifactRemovedEvent = { artifactId: item.id, taskId, revision: result.revision };
      try {
        this.eventSink?.removed?.(evt);
      } catch (error) {
        console.error("[ArtifactService] removed 事件广播失败:", error);
      }
    }
    const failed = await this.removeManagedContents(result.items.flatMap(item => item.storagePath === null ? [] : [item.storagePath]));
    if (id && failed.length) console.error("[ArtifactService] 内容删除失败（orphan 待 GC）:", failed[0]);
    if (requireTrashed) this.repository.clearWriteReceipt(taskId);
    return { removed: result.items.length, orphaned: failed.length };
  }

  // ---------- Legacy Migration（3B.2-3.4） ----------

  /** 是否已执行过 legacy artifact 迁移（0 artifact 也算完成，M3） */
  isLegacyMigrated(taskId: string): boolean {
    return this.repository.isLegacyMigrated(taskId);
  }

  /**
   * 一次性 legacy artifact 迁移：把旧数据源（artifact-index / session jsonl）的 artifact
   * 提升为正式 Domain artifact。
   * - path 存在 → workspace-file（entryFile=path；rootDir=task cwd 内则 cwd，否则文件目录）
   * - 否则 content 非空 → managed-content（materialize，ArtifactStorage 落盘）
   * - 单条失败跳过不阻塞整体（partially broken legacy，M5）；
   *   全部完成即标记 migrated（0 条也标记，M3）——迁移只运行一次（M4/M7）
   * - 调用方拿不到 legacy 数据（本方法未执行）→ 不标记，下次 hydrate 重试（M6）
   */
  async registerLegacy(
    taskId: string,
    legacy: LegacyArtifactInput[],
    cwd?: string,
  ): Promise<{ registered: number; failed: number }> {
    let registered = 0;
    let failed = 0;
    for (const item of legacy) {
      try {
        const kind = normalizeLegacyKind(item.kind);
        const path = item.path?.trim();
        if (path && existsSync(path)) {
          const p = path.replace(/\\/g, "/");
          const base = cwd?.replace(/\\/g, "/") ?? "";
          const rootDir = base && p.startsWith(base) ? cwd! : dirname(path);
          await this.register({
            taskId,
            kind,
            title: item.name,
            capabilities: { originalKind: item.kind },
            workspaceFile: { entryFile: path, rootDir },
          });
        } else if (typeof item.content === "string" && item.content.trim()) {
          await this.register({ taskId, kind, title: item.name, capabilities: { originalKind: item.kind }, content: item.content });
        } else {
          failed += 1;
          continue;
        }
        registered += 1;
      } catch {
        failed += 1;
      }
    }
    this.repository.markLegacyMigrated(taskId);
    return { registered, failed };
  }

  // ---------- 内容读取（3C：渲染/content 解析，workspace-file 走 root 安全边界） ----------

  /**
   * workspace-file 的 root 边界校验：readContent 与图片协议共用同一道门。
   * 3C：协议层永远不能借 artifactId 读 root 外的任意磁盘文件。
   */
  private workspaceTarget(id: string): string | null {
    const descriptor = this.get(id);
    if (!descriptor || descriptor.source.type !== "workspace-file") return null;
    const root = descriptor.source.rootDir;
    const target = descriptor.source.entryFile;
    const rel = relative(resolve(root), resolve(target));
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      console.error("[ArtifactService] 拒绝 root 外路径:", target);
      return null;
    }
    return existsSync(target) ? target : null;
  }

  async readImageVariant(
    id: string,
    variant: "thumb" | "full",
  ): Promise<{ data: Buffer; mimeType: string; version: number } | null> {
    const image = await this.openImageVariant(id, variant);
    if (!image?.data) return null;
    const { mimeType, version } = image;
    if (Buffer.isBuffer(image.data)) return { data: image.data, mimeType, version };
    try {
      const data = Buffer.from(await new Response(image.data as BodyInit).arrayBuffer());
      return { data, mimeType, version };
    } catch {
      return null;
    }
  }

  /** mybuddy-artifact:// 的原图按需读取，避免在主进程拼出整张图。 */
  async openImageVariant(
    id: string,
    variant: "thumb" | "full",
    { head = false, signal }: { head?: boolean; signal?: AbortSignal } = {},
  ): Promise<{ data: Buffer | ReadableStream<Uint8Array> | null; mimeType: string; version: number; bytes?: number } | null> {
    const descriptor = this.get(id);
    if (!descriptor) return null;
    const version = descriptor.version;
    if (descriptor.source.type === "managed-content") {
      const image = await this.runtimeAuditReader?.openManagedArtifactImage(
        this.storage.root, descriptor.source.storagePath, { head, signal },
      );
      if (image?.status === "missing" || image?.status === "failed") return null;
      if (image?.status === "imageOpened") {
        if (this.get(id)?.version !== version) {
          await image.body?.cancel().catch(() => {});
          return null;
        }
        return { data: image.body, mimeType: image.mimeType, version };
      }
      // Older readers and non-base64 data URIs use the existing decoding path.
      const managed = await this.readManagedContent(descriptor.source.storagePath);
      if (!managed || !("content" in managed) || this.get(id)?.version !== version) return null;
      try {
        const match = /^data:([^;,]+)?(;base64)?,([\s\S]*)$/i.exec(managed.content.trim());
        if (!match) return null;
        const mimeType = match[1] ?? "application/octet-stream";
        const raw = match[3] ?? "";
        const data = match[2]
          ? Buffer.from(raw, "base64")
          : Buffer.from(decodeURIComponent(raw), "utf-8");
        void variant;
        return { data, mimeType, version };
      } catch {
        return null;
      }
    }
    const { entryFile, rootDir } = descriptor.source;
    const root = resolve(rootDir);
    const source = await this.runtimeAuditReader?.openWorkspaceArtifact(root, relative(root, entryFile), {
      head: head && variant === "full", signal,
    });
    if (source && source.status !== "opened") return null;
    const target = source ? entryFile : this.workspaceTarget(id);
    if (!target) return null;
    const image = await workspaceImageVariant(target, variant, rootDir, source);
    if (this.get(id)?.version !== version) {
      if (image?.data instanceof ReadableStream) await image.data.cancel().catch(() => {});
      return null;
    }
    if (!image) return null;
    return { ...image, version, ...(source && image.data === source.body ? { bytes: source.bytes } : {}) };
  }

  /**
   * 按 id 读取 artifact 内容：
   * - managed-content → ArtifactStorage.read
   * - workspace-file → fs 读取（entryFile 必须在 rootDir 内，防任意磁盘读取）
   * - 位图（png/jpg/webp/gif/bmp/avif/ico）→ 只回协议 URL + 尺寸元数据 + path，
   *   content 是 ?variant=full 的 URL 而非原始字节；原图仅"查看原图"时由协议投递。
   * kind 细分（docx/xlsx/image/pdf 等）由 capabilities.originalKind 提供。
   */
  async readContent(id: string, options?: { inline?: boolean }): Promise<{
    content: string;
    artifactVersion: number;
    language?: string;
    kind?: string;
    path?: string;
    width?: number;
    height?: number;
    thumbnail?: import("../../shared/agent-ipc").WorkspaceFileThumbnailDto;
    bytes?: number;
  } | null> {
    const descriptor = this.get(id);
    if (!descriptor) return null;
    if (descriptor.source.type === "managed-content") {
      const inlineRaster = options?.inline === true && descriptor.kind === "image";
      const managed = await this.readManagedContent(descriptor.source.storagePath, inlineRaster);
      if (!managed || this.get(id)?.version !== descriptor.version) return null;
      if ("raster" in managed || (inlineRaster && /^data:image\/(?:png|jpeg|gif|webp|bmp|avif|x-icon);base64,/i.test(managed.content))) {
        return { content: artifactImageUrl(id, "full", { version: descriptor.version }), kind: "image", artifactVersion: descriptor.version };
      }
      return { content: managed.content, kind: (descriptor.capabilities?.originalKind as string | undefined) ?? descriptor.kind, artifactVersion: descriptor.version };
    }
    const target = this.workspaceTarget(id);
    if (!target) return null;
    // 只有 renderer IPC（inline）走协议 URL；main 内部的 PromptContext / Gadget /
    // 预览宿主仍按旧契约拿 data URI，避免改变喂给模型或其它服务的内容语义。
    const inlineImage = Boolean(options?.inline) && INLINE_IMAGE_EXTENSIONS.has(extname(target).toLowerCase());
    // SVG / 文本 / Office 走原契约（content 是文本或 data URI）；位图一律不生成 base64
    const preview = await previewWorkspaceFile(target, {
      // main 内部调用方（PromptContext/Gadget/预览宿主）不需要缩略图，别让它们等 resize
      thumbnail: Boolean(options?.inline),
      inlineImage,
      workspace: this.runtimeAuditReader ? { root: descriptor.source.rootDir, reader: this.runtimeAuditReader } : undefined,
    });
    if (this.get(id)?.version !== descriptor.version) return null;
    const kind = (descriptor.capabilities?.originalKind as string | undefined) ?? preview.kind;
    if (!inlineImage) {
      return {
        content: preview.content,
        artifactVersion: descriptor.version,
        language: preview.language,
        kind,
        path: preview.path,
        bytes: preview.bytes,
        ...(preview.width ? { width: preview.width, height: preview.height } : {}),
        ...(preview.thumbnail ? { thumbnail: preview.thumbnail } : {}),
      };
    }
    const bytes = preview.bytes ?? 0;
    // 图片字节永不过 IPC：content 只是带版本的协议 URL，体积/尺寸只做元数据。
    return {
      artifactVersion: descriptor.version,
      content: artifactImageUrl(id, "full", {
        mime: preview.mimeType,
        version: descriptor.version,
        bytes,
        ...(preview.width ? { width: preview.width, height: preview.height } : {}),
      }),
      language: preview.language,
      kind,
      path: preview.path,
      bytes,
      ...(preview.width ? { width: preview.width, height: preview.height } : {}),
      ...(preview.thumbnail
        ? {
            thumbnail: {
              ...preview.thumbnail,
              url: artifactImageUrl(id, "thumb", { version: descriptor.version }),
            },
          }
        : {}),
    };
  }

  /** 按 entryFile 精确查找已注册的 workspace-file artifact（3C refresh 判断新/旧文件用） */
  findByEntryFile(taskId: string, filePath: string): ArtifactDescriptor | null {
    const norm = filePath.replace(/\\/g, "/").toLowerCase();
    for (const d of this.listByTask(taskId)) {
      if (d.source.type === "workspace-file" && d.source.entryFile.replace(/\\/g, "/").toLowerCase() === norm) {
        return d;
      }
    }
    return null;
  }

  // ---------- 对话分支克隆（实施规划 §9.2） ----------

  /**
   * 克隆「分支点之前」的 parent artifacts 到 child task scope。
   * - 剪裁判定只由主进程按 Pi active path 的 entry 顺序完成（§9.2 评审裁决）：
   *   调用方传入继承段 tool call id 集合，本方法只做"createdByToolCallId ∈ 继承段"过滤；
   * - workspace-file：shared_space 指向同一真实文件；current_snapshot/conversation_only
   *   映射 child root 相对路径，文件不存在则跳过并告警；
   * - managed-content：读取源内容在 child storage 重新 materialize；
   * - 新 descriptor：新 id、taskId=child、capabilities 记录 branchedFromArtifactId/TaskId、
   *   createdByMessageId 清空（无稳定映射）、createdByToolCallId 保留（entry 已复制）；
   * - 无 provenance（legacy）产物不自动复制，返回 warning（§9.2-8）。
   * 任何单项失败都不阻断整体；返回计数给 UI 展示。
   */
  async cloneForConversationBranch(input: {
    parentTaskId: string;
    childTaskId: string;
    /** 继承段全部 producerToolCallId（分支点之前） */
    inheritedToolCallIds: ReadonlySet<string>;
    strategy: "shared_space" | "current_snapshot" | "conversation_only";
    /** workspace-file 克隆解析根：shared_space = 源 root；否则 = child canonical cwd */
    targetRoot: string;
  }): Promise<{ inheritedCount: number; skippedCount: number; warnings: string[] }> {
    const result = { inheritedCount: 0, skippedCount: 0, warnings: [] as string[] };
    const sourceArtifacts = this.listByTask(input.parentTaskId);
    for (const descriptor of sourceArtifacts) {
      const toolCallId = descriptor.createdByToolCallId;
      if (!toolCallId) {
        // legacy 无 provenance：不自动复制（不越权借 parent scope）
        result.skippedCount++;
        result.warnings.push(
          `产物「${descriptor.title || descriptor.id}」缺少创建溯源，未随分支复制。`,
        );
        continue;
      }
      if (!input.inheritedToolCallIds.has(toolCallId)) continue; // 分支点之后 → 不继承
      try {
        await this.cloneOneArtifact(descriptor, input, result);
        result.inheritedCount++;
      } catch (err) {
        result.skippedCount++;
        result.warnings.push(
          `产物「${descriptor.title || descriptor.id}」复制失败：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return result;
  }

  private async cloneOneArtifact(
    descriptor: ArtifactDescriptor,
    input: {
      childTaskId: string;
      strategy: "shared_space" | "current_snapshot" | "conversation_only";
      targetRoot: string;
    },
    result: { warnings: string[] },
  ): Promise<void> {
    const capabilities = { ...(descriptor.capabilities ?? {}) };
    capabilities.branchedFromArtifactId = descriptor.id;
    let registration: ArtifactRegistration;

    if (descriptor.source.type === "managed-content") {
      const managed = await this.readManagedContent(descriptor.source.storagePath);
      if (!managed || !("content" in managed)) {
        throw new Error("源内容不可读");
      }
      registration = {
        taskId: input.childTaskId,
        kind: descriptor.kind,
        content: managed.content,
        title: descriptor.title,
        mimeType: descriptor.mimeType,
        producerToolCallId: descriptor.createdByToolCallId,
        // createdByMessageId 无稳定映射 → 清空（§9.2-6）
        capabilities,
      };
    } else {
      // workspace-file
      const { entryFile, rootDir } = descriptor.source;
      let targetEntry: string;
      let targetRoot: string;
      if (input.strategy === "shared_space") {
        targetEntry = entryFile;
        targetRoot = rootDir;
      } else {
        const rel = relative(resolve(rootDir), resolve(entryFile));
        if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
          throw new Error("源文件越界 root，拒绝克隆");
        }
        targetEntry = join(input.targetRoot, rel);
        targetRoot = input.targetRoot;
        if (!existsSync(targetEntry)) {
          throw new Error("快照中没有对应文件（文件可能产生于分支点之后或未复制）");
        }
      }
      registration = {
        taskId: input.childTaskId,
        kind: descriptor.kind,
        workspaceFile: { entryFile: targetEntry, rootDir: targetRoot },
        title: descriptor.title,
        mimeType: descriptor.mimeType,
        producerToolCallId: descriptor.createdByToolCallId,
        capabilities,
      };
    }

    const cloned = await this.register(registration);
    // 文件依赖重新映射（§9.2-7）：相对 rootDir 的依赖按同一映射规则落到 targetRoot
    const deps = this.repository.listFileDependencies(descriptor.id);
    if (deps.length > 0 && descriptor.source.type === "workspace-file") {
      const { rootDir } = descriptor.source;
      const mappedDeps = deps.map((d) => {
        try {
          const rel = relative(resolve(rootDir), resolve(d.filePath));
          if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
            return { filePath: d.filePath, dependencyKind: d.dependencyKind }; // 越界依赖原样保留
          }
          return {
            filePath:
              input.strategy === "shared_space" ? d.filePath : join(input.targetRoot, rel),
            dependencyKind: d.dependencyKind,
          };
        } catch {
          return { filePath: d.filePath, dependencyKind: d.dependencyKind };
        }
      });
      this.repository.replaceFileDependencies(
        cloned.id,
        mappedDeps.map((d) => ({ filePath: d.filePath, dependencyKind: d.dependencyKind })),
      );
    }
  }

  // ---------- Startup Orphan GC（§14） ----------

  /** 扫描 storage root vs repository rows；孤儿默认删除，删除失败 log，下次启动重试。不阻塞。 */
  orphanGC(): Promise<{ removed: string[]; failed: string[] }> {
    return this.runWithArtifactWrites(async () => {
      if (this.runtimeAuditReader && !this.repository.inTransaction && isAbsolute(this.storage.root)) {
        const report = await this.runtimeAuditReader.cleanupArtifactFiles(this.storage.root, { kind: "orphans" });
        if (report === undefined) throw new Error("Rust 成果清理未返回结果");
        if (report !== "needsHost") return report;
      }
      const candidates = this.storage.orphanCandidates(this.repository.managedPaths());
      const removed: string[] = [];
      const failed: string[] = [];
      for (const rel of candidates) {
        if (this.storage.remove(rel)) removed.push(rel);
        else failed.push(rel);
      }
      return { removed, failed };
    });
  }

  /** 从 Repository 全量重建 Registry（启动时） */
  rebuildRegistry(): void {
    this.registry.rebuild(this.repository.listAll().filter(isOutputArtifact));
  }
}

export type { ArtifactLoadState };

/** 旧数据源 artifact 输入（3B.3：workspace-file / raw content 二选一） */
export interface LegacyArtifactInput {
  name?: string;
  kind: string;
  content?: string;
  /** 真实 workspace 文件路径（存在 → workspace-file，不复制内容） */
  path?: string;
}

/** renderer ArtifactKind（含 table/docx/xlsx/pptx）→ Domain ArtifactKind */
function normalizeLegacyKind(kind: string): ArtifactDescriptor["kind"] {
  switch (kind) {
    case "markdown":
    case "code":
    case "html":
    case "svg":
    case "image":
    case "video":
    case "audio":
    case "pdf":
      return kind;
    case "docx":
    case "xlsx":
    case "pptx":
    case "drawio":
      return "office";
    case "table":
    default:
      return "markdown";
  }
}
