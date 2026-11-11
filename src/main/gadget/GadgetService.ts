import { randomUUID } from "node:crypto";
import type {
  GadgetCreateRequest,
  GadgetDescriptor,
  GadgetListItem,
  GadgetManifest,
  GadgetRuntimeState,
  GadgetScope,
  GadgetSourceFile,
  GadgetUpdateRequest,
  GadgetSourceSnapshot,
  GadgetSourceUpdateRequest,
} from "../../shared/gadget-types";
import { assertGadgetScope, GADGET_MANIFEST_SCHEMA_VERSION, normalizeJsonRecord } from "../../shared/gadget-types";
import { saveGadgetToTaskDirectory } from "./saveGadgetToTaskDirectory";
import type { GadgetSaveToTaskDirectoryRequest, GadgetSaveToTaskDirectoryResult } from "../../shared/gadget-ipc";
import type { GadgetListRequest } from "../../shared/gadget-ipc";
import type { GadgetChangedEvent } from "../../shared/gadget-ipc";
import type { GadgetRepository } from "./GadgetRepository";
import type { GadgetRegistry } from "./GadgetRegistry";
import type { GadgetRuntime } from "./GadgetRuntime";
import type { GadgetStorage } from "./GadgetStorage";

export interface GadgetArtifactReader {
  read(artifactId: string): Promise<{ taskId: string; title: string; kind: string; content: string } | null>;
  write(input: { taskId: string; title: string; content: string }): Promise<{ artifactId: string }>;
}

export interface GadgetServiceDependencies {
  repository: GadgetRepository;
  storage: GadgetStorage;
  registry: GadgetRegistry;
  runtime: GadgetRuntime;
  workspaceExists(id: string): boolean;
  workspaceEffectiveArchived(id: string): boolean;
  taskExists(id: string): boolean;
  taskWorkspaceId(id: string): string | null;
  resolveTaskDirectory?(id: string): string;
  workspaceAncestors(id: string): string[];
  artifacts?: GadgetArtifactReader;
  onChanged?(event: GadgetChangedEvent): void;
}

export class GadgetService {
  constructor(private readonly deps: GadgetServiceDependencies) {
    const descriptors = deps.repository.list();
    deps.storage.reconcile(new Set(descriptors.map((item) => item.id)));
    deps.registry.rebuild(descriptors);
  }

  create(request: GadgetCreateRequest): GadgetDescriptor {
    const name = request.name.trim();
    if (!name) throw new Error("Gadget 名称不能为空");
    if (name.length > 120) throw new Error("Gadget 名称不能超过 120 字符");
    if ((request.description?.length ?? 0) > 2_000) throw new Error("Gadget 描述不能超过 2000 字符");
    assertGadgetScope(request.scope);
    this.assertScopeTarget(request.scope);
    const createdByTaskId = request.createdByTaskId?.trim() || (request.scope.type === "task" ? request.scope.taskId : undefined);
    if (createdByTaskId && !this.deps.taskExists(createdByTaskId)) throw new Error(`创建来源任务不存在：${createdByTaskId}`);
    if (request.scope.type === "task" && createdByTaskId !== request.scope.taskId) {
      throw new Error("Task Gadget 的创建来源必须是同一任务");
    }
    if (request.scope.type === "workspace" && createdByTaskId && this.deps.taskWorkspaceId(createdByTaskId) !== request.scope.workspaceId) {
      throw new Error("Workspace Gadget 的创建来源任务不属于目标工作空间");
    }
    const metadata = request.metadata === undefined ? {} : normalizeJsonRecord(request.metadata, "Gadget metadata");
    const id = `gdt-${randomUUID()}`;
    const entry = (request.entry ?? "index.html").replaceAll("\\", "/");
    const manifest: GadgetManifest = {
      schemaVersion: GADGET_MANIFEST_SCHEMA_VERSION,
      name,
      type: "web",
      entry,
      ...(request.defaultConfig ? { defaultConfig: request.defaultConfig } : {}),
    };
    const paths = this.deps.storage.create(id, manifest, request.files);
    const now = Date.now();
    const descriptor: GadgetDescriptor = {
      id,
      name,
      description: request.description?.trim() || undefined,
      scope: request.scope,
      type: "web",
      manifestPath: paths.manifestPath,
      sourcePath: paths.sourcePath,
      createdByTaskId,
      blueprintId: request.blueprintId,
      metadata,
      createdAt: now,
      updatedAt: now,
    };
    try {
      const created = this.deps.repository.create(descriptor);
      this.deps.registry.upsert(created);
      this.emitChanged({ type: "created", gadgetId: created.id });
      return created;
    } catch (error) {
      this.deps.storage.delete(id);
      throw error;
    }
  }

  get(id: string): GadgetListItem | null {
    const descriptor = this.deps.repository.get(id);
    return descriptor ? { ...descriptor, runtime: this.deps.registry.runtime(id) } : null;
  }

  update(request: GadgetUpdateRequest): GadgetDescriptor {
    const current = this.require(request.gadgetId);
    const name = request.name === undefined ? current.name : request.name.trim();
    if (!name) throw new Error("Gadget 名称不能为空");
    if (name.length > 120) throw new Error("Gadget 名称不能超过 120 字符");
    if ((request.description?.length ?? 0) > 2_000) throw new Error("Gadget 描述不能超过 2000 字符");
    const oldManifest = this.deps.storage.readManifest(current.id);
    const manifestChanged = request.name !== undefined || request.defaultConfig !== undefined;
    const nextManifest: GadgetManifest = {
      ...oldManifest,
      name,
      ...(request.defaultConfig === undefined
        ? {}
        : request.defaultConfig === null
          ? { defaultConfig: undefined }
          : { defaultConfig: request.defaultConfig }),
    };
    const updated: GadgetDescriptor = {
      ...current,
      name,
      description: request.description === undefined ? current.description : request.description?.trim() || undefined,
      metadata: request.metadata === undefined ? current.metadata : normalizeJsonRecord(request.metadata, "Gadget metadata"),
      updatedAt: Date.now(),
    };
    try {
      if (manifestChanged) this.deps.storage.writeManifest(current.id, nextManifest);
      const saved = this.deps.repository.update(updated);
      this.deps.registry.upsert(saved);
      this.emitChanged({ type: "updated", gadgetId: saved.id });
      return saved;
    } catch (error) {
      if (manifestChanged) {
        try { this.deps.storage.writeManifest(current.id, oldManifest); } catch { /* preserve original failure */ }
      }
      throw error;
    }
  }

  list(request: GadgetListRequest = {}): GadgetListItem[] {
    const direct = this.deps.repository.list(request.scope).map((descriptor) => ({
      ...descriptor,
      runtime: this.deps.registry.runtime(descriptor.id),
    }));
    if (!request.includeInherited || !request.scope || request.scope.type === "global") return direct;
    const inherited: GadgetListItem[] = [];
    const workspaceIds = request.scope.type === "workspace"
      ? this.deps.workspaceAncestors(request.scope.workspaceId)
      : this.visibleWorkspaceIds(request.scope.taskId);
    for (const workspaceId of workspaceIds) {
      for (const descriptor of this.deps.repository.list({ type: "workspace", workspaceId })) {
        inherited.push({
          ...descriptor,
          runtime: this.deps.registry.runtime(descriptor.id),
          inherited: true,
          inheritedFromWorkspaceId: workspaceId,
        });
      }
    }
    if (request.scope.type === "task") {
      for (const descriptor of this.deps.repository.list({ type: "global" })) {
        inherited.push({ ...descriptor, runtime: this.deps.registry.runtime(descriptor.id), inherited: true });
      }
    }
    return [...direct, ...inherited];
  }

  getForTask(id: string, taskId: string): GadgetListItem {
    const gadget = this.get(id);
    if (!gadget) throw new Error(`Gadget 不存在：${id}`);
    this.assertVisibleToTask(gadget, taskId);
    return gadget;
  }

  readSource(id: string): GadgetSourceSnapshot {
    this.require(id);
    return this.deps.storage.readSource(id);
  }

  updateSource(request: GadgetSourceUpdateRequest): GadgetSourceSnapshot {
    const current = this.require(request.gadgetId);
    const updated = { ...current, updatedAt: Date.now() };
    const snapshot = this.deps.storage.updateSource(request, () => this.deps.repository.update(updated));
    this.deps.registry.upsert(updated);
    this.emitChanged({ type: "updated", gadgetId: current.id });
    return snapshot;
  }

  async openForTask(id: string, taskId: string): Promise<GadgetRuntimeState> {
    this.getForTask(id, taskId);
    const state = await this.start(id);
    if (state.status === "running") {
      this.getForTask(id, taskId);
      this.emitChanged({ type: "open-requested", gadgetId: id, taskId });
    }
    return state;
  }

  /** Independent source/configuration snapshot. Runtime data and browser sessions are not shared. */
  copyScope(id: string, scope: GadgetScope): GadgetDescriptor {
    assertGadgetScope(scope);
    this.assertScopeTarget(scope);
    const original = this.require(id);
    // A task destination must already be able to see the source; never copy another task's private tool.
    if (scope.type === "task") this.assertVisibleToTask(original, scope.taskId);
    const snapshot = this.deps.storage.readSource(id);
    if (snapshot.files.length === 0) throw new Error("Gadget 入口文件不存在，不能保存空源码副本");
    const metadata = normalizeJsonRecord(original.metadata, "Gadget metadata");
    const copyId = `gdt-${randomUUID()}`;
    const paths = this.deps.storage.create(copyId, snapshot.manifest, snapshot.files);
    const now = Date.now();
    // createdByTaskId remains origin provenance; visibility and deletion use scope exclusively.
    const descriptor: GadgetDescriptor = {
      ...original,
      id: copyId,
      scope: { ...scope },
      manifestPath: paths.manifestPath,
      sourcePath: paths.sourcePath,
      metadata,
      createdAt: now,
      updatedAt: now,
    };
    let saved: GadgetDescriptor;
    try {
      saved = this.deps.repository.create(descriptor);
    } catch (error) {
      try { this.deps.storage.delete(copyId); } catch { /* preserve database failure; reconcile retries cleanup */ }
      throw error;
    }
    this.deps.registry.upsert(saved);
    this.emitChanged({ type: "created", gadgetId: saved.id });
    return saved;
  }

  moveScope(id: string, scope: GadgetScope): GadgetDescriptor {
    assertGadgetScope(scope);
    this.assertScopeTarget(scope);
    if (!this.deps.repository.get(id)) throw new Error(`Gadget 不存在：${id}`);
    const moved = this.deps.repository.moveScope(id, scope);
    this.deps.registry.upsert(moved);
    this.emitChanged({ type: "updated", gadgetId: moved.id });
    return moved;
  }

  async start(id: string): Promise<GadgetRuntimeState> {
    const state = await this.deps.runtime.start(this.require(id));
    this.emitChanged({ type: "runtime", gadgetId: id });
    return state;
  }

  async health(id: string): Promise<GadgetRuntimeState> {
    this.require(id);
    const state = await this.deps.runtime.health(id);
    this.emitChanged({ type: "runtime", gadgetId: id });
    return state;
  }

  async stop(id: string): Promise<GadgetRuntimeState> {
    this.require(id);
    const state = await this.deps.runtime.stop(id);
    this.emitChanged({ type: "runtime", gadgetId: id });
    return state;
  }

  async restart(id: string): Promise<GadgetRuntimeState> {
    const state = await this.deps.runtime.restart(this.require(id));
    this.emitChanged({ type: "runtime", gadgetId: id });
    return state;
  }

  async delete(id: string): Promise<void> {
    this.require(id);
    await this.deps.runtime.dispose(id);
    if (!this.deps.repository.delete(id)) throw new Error(`Gadget 不存在：${id}`);
    this.deps.registry.remove(id);
    this.emitChanged({ type: "deleted", gadgetId: id });
    try { this.deps.storage.delete(id); }
    catch (error) { console.warn(`[GadgetService] Gadget ${id} storage 将在下次启动重试清理`, error); }
  }

  async deleteByWorkspace(workspaceId: string): Promise<void> {
    for (const gadget of this.deps.repository.list({ type: "workspace", workspaceId })) await this.delete(gadget.id);
  }

  async deleteByTask(taskId: string): Promise<void> {
    for (const gadget of this.deps.repository.list({ type: "task", taskId })) await this.delete(gadget.id);
  }

  /** Blueprint 外层事务失败时，DB 行可能已回滚；仍需撤销已物化的 runtime/storage/registry。 */
  async rollbackCreate(id: string): Promise<void> {
    await this.deps.runtime.dispose(id);
    this.deps.repository.delete(id);
    this.deps.registry.remove(id);
    try { this.deps.storage.delete(id); }
    finally { this.emitChanged({ type: "deleted", gadgetId: id }); }
  }

  createFromBlueprint(input: {
    name: string;
    description?: string;
    scope: GadgetScope;
    entry: string;
    files: GadgetSourceFile[];
    defaultConfig?: Record<string, unknown>;
    metadata?: Record<string, unknown>;
    blueprintId: string;
  }): GadgetDescriptor {
    return this.create({ ...input, blueprintId: input.blueprintId });
  }

  async convertFromArtifact(input: { artifactId: string; scope: GadgetScope; name?: string; description?: string }): Promise<GadgetDescriptor> {
    if (!this.deps.artifacts) throw new Error("Artifact Domain 尚未连接");
    const artifact = await this.deps.artifacts.read(input.artifactId);
    if (!artifact) throw new Error(`Artifact 不存在：${input.artifactId}`);
    if (artifact.kind !== "html") throw new Error("当前仅支持把 HTML Artifact 转换为 Gadget");
    if (input.scope.type !== "task" || input.scope.taskId !== artifact.taskId) {
      throw new Error("Artifact 只能先转换为其所属任务的 Task Gadget；长期使用请在创建后保存独立副本");
    }
    return this.create({
      name: input.name?.trim() || artifact.title || "HTML Gadget",
      description: input.description,
      scope: input.scope,
      entry: "index.html",
      files: [{ path: "index.html", content: artifact.content, encoding: "utf8" }],
      createdByTaskId: artifact.taskId,
      metadata: { convertedFromArtifactId: input.artifactId },
    });
  }

  async exportArtifact(input: { gadgetId: string; taskId: string; title?: string }): Promise<{ artifactId: string }> {
    if (!this.deps.artifacts) throw new Error("Artifact Domain 尚未连接");
    if (!this.deps.taskExists(input.taskId)) throw new Error(`任务不存在：${input.taskId}`);
    const gadget = this.require(input.gadgetId);
    this.assertVisibleToTask(gadget, input.taskId);
    const entry = this.deps.storage.readEntry(gadget.id);
    return this.deps.artifacts.write({ taskId: input.taskId, title: input.title?.trim() || gadget.name, content: entry.content });
  }

  /** Only Main resolves the destination; renderer paths and active-task state are not trusted. */
  saveToTaskDirectory(input: GadgetSaveToTaskDirectoryRequest): GadgetSaveToTaskDirectoryResult {
    const gadget = this.getForTask(input.gadgetId, input.taskId);
    if (!this.deps.resolveTaskDirectory) throw new Error("任务工作目录尚未连接");
    const directory = this.deps.resolveTaskDirectory(input.taskId);
    return saveGadgetToTaskDirectory(directory, gadget, this.deps.storage.readSource(gadget.id));
  }

  captureSource(id: string): { descriptor: GadgetDescriptor; manifest: GadgetManifest; sourceFiles: GadgetSourceFile[] } {
    const descriptor = this.require(id);
    return { descriptor, ...this.deps.storage.captureSource(id) };
  }

  async disposeAll(): Promise<void> {
    await this.deps.runtime.disposeAll();
  }

  async dispose(id: string): Promise<void> {
    this.require(id);
    await this.deps.runtime.dispose(id);
  }

  private require(id: string): GadgetDescriptor {
    const descriptor = this.deps.repository.get(id);
    if (!descriptor) throw new Error(`Gadget 不存在：${id}`);
    return descriptor;
  }

  private assertScopeTarget(scope: GadgetScope): void {
    if (scope.type === "workspace") {
      if (!this.deps.workspaceExists(scope.workspaceId)) throw new Error(`工作空间不存在：${scope.workspaceId}`);
      if (this.deps.workspaceEffectiveArchived(scope.workspaceId)) throw new Error(`工作空间已归档，不能作为 Gadget 目标：${scope.workspaceId}`);
    }
    if (scope.type === "task" && !this.deps.taskExists(scope.taskId)) throw new Error(`任务不存在：${scope.taskId}`);
  }

  private assertVisibleToTask(gadget: GadgetDescriptor, taskId: string): void {
    if (!this.deps.taskExists(taskId)) throw new Error(`任务不存在：${taskId}`);
    if (gadget.scope.type === "global") return;
    if (gadget.scope.type === "task") {
      if (gadget.scope.taskId !== taskId) throw new Error("当前任务不可访问其它任务的私有 Gadget");
      return;
    }
    if (!this.visibleWorkspaceIds(taskId).includes(gadget.scope.workspaceId)) {
      throw new Error("目标任务不在该 Workspace Gadget 的可见作用域内");
    }
  }

  private visibleWorkspaceIds(taskId: string): string[] {
    if (!this.deps.taskExists(taskId)) throw new Error(`任务不存在：${taskId}`);
    const id = this.deps.taskWorkspaceId(taskId);
    return id ? [id, ...this.deps.workspaceAncestors(id)] : [];
  }

  private emitChanged(event: GadgetChangedEvent): void {
    try { this.deps.onChanged?.(event); } catch { /* renderer projection is recoverable via list */ }
  }
}
