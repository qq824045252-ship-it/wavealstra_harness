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
import { gadgetBackendSchema, type GadgetJson } from "../../shared/gadget-backend";
import { saveGadgetToTaskDirectory } from "./saveGadgetToTaskDirectory";
import type { GadgetSaveToTaskDirectoryRequest, GadgetSaveToTaskDirectoryResult } from "../../shared/gadget-ipc";
import type { GadgetListRequest } from "../../shared/gadget-ipc";
import type { GadgetChangedEvent } from "../../shared/gadget-ipc";
import type { GadgetRepository } from "./GadgetRepository";
import type { GadgetRegistry } from "./GadgetRegistry";
import type { GadgetRuntime } from "./GadgetRuntime";
import type { GadgetStorage } from "./GadgetStorage";
import type { RuntimeGadgetArtifactSource, RuntimeGadgetPatch } from "../platform/runtime-audit";

export interface GadgetArtifactReader {
  read(artifactId: string): Promise<{ taskId: string; title: string; kind: string; content: string } | null>;
  write(input: { taskId: string; title: string; content: string }): Promise<{ artifactId: string }>;
  writeFromGadget?(
    input: { taskId: string; title: string; source: RuntimeGadgetArtifactSource }, readOnHost: () => string,
  ): Promise<{ artifactId: string }>;
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
  resolveTaskDirectoryAsync?(id: string): Promise<string>;
  workspaceAncestors(id: string): string[];
  artifacts?: GadgetArtifactReader;
  onChanged?(event: GadgetChangedEvent): void;
}

export interface GadgetBrowserPreview {
  gadgetId: string;
  url: string;
  previousUrl?: string;
  revision: string;
  runtime: GadgetRuntimeState;
}

export class GadgetPreviewUnavailableError extends Error {
  constructor(public readonly gadgetId: string, public readonly runtime: GadgetRuntimeState) {
    super(`Gadget 预览无法启动：${runtime.error ?? runtime.status}`);
    this.name = "GadgetPreviewUnavailableError";
  }
}

export interface BlueprintGadgetPlan {
  descriptor: GadgetDescriptor;
  manifest: GadgetManifest;
  files?: GadgetSourceFile[];
}

export class GadgetService {
  /** Only origins actually issued by this process are recoverable. Ambiguous
   * recycled ports fail closed instead of opening another Gadget. */
  private readonly previewOwners = new Map<string, string | null>();
  private readonly mutations = new Map<string, Promise<void>>();
  private readonly deleting = new Set<string>();
  constructor(private readonly deps: GadgetServiceDependencies) {}

  recoverStorage(): Promise<void> {
    return this.deps.storage.recover(() => this.deps.repository.storageIds());
  }

  create(request: GadgetCreateRequest): GadgetDescriptor {
    const { descriptor, manifest } = this.planCreate(request);
    this.deps.storage.create(descriptor.id, manifest, request.files);
    try {
      return this.created(this.deps.repository.create(descriptor));
    } catch (error) {
      return this.rollbackNewGadget(descriptor.id, error);
    }
  }

  async createAsync(request: GadgetCreateRequest): Promise<GadgetDescriptor> {
    const { descriptor, manifest } = this.planCreate(request, this.deps.repository.usesCore);
    return this.mutate(descriptor.id, async () => {
      if (await this.deps.storage.createNative(descriptor, manifest, { files: request.files })) {
        return this.created(descriptor);
      }
      if (this.deps.repository.usesCore) throw new Error("Gadget 存储创建未获 Rust Core 确认");
      this.deps.storage.create(descriptor.id, manifest, request.files);
      try {
        return this.created(await this.deps.repository.createAsync(descriptor, { kind: "generated" }));
      } catch (error) {
        return this.rollbackNewGadget(descriptor.id, error);
      }
    });
  }

  private planCreate(request: GadgetCreateRequest, scopeIsStaged = false): { descriptor: GadgetDescriptor; manifest: GadgetManifest } {
    const name = request.name.trim();
    if (!name) throw new Error("Gadget 名称不能为空");
    if (name.length > 120) throw new Error("Gadget 名称不能超过 120 字符");
    if ((request.description?.length ?? 0) > 2_000) throw new Error("Gadget 描述不能超过 2000 字符");
    assertGadgetScope(request.scope);
    if (!scopeIsStaged) this.assertScopeTarget(request.scope);
    const createdByTaskId = request.createdByTaskId?.trim() || (request.scope.type === "task" ? request.scope.taskId : undefined);
    if (createdByTaskId && !scopeIsStaged && !this.deps.taskExists(createdByTaskId)) throw new Error(`创建来源任务不存在：${createdByTaskId}`);
    if (request.scope.type === "task" && createdByTaskId !== request.scope.taskId) {
      throw new Error("Task Gadget 的创建来源必须是同一任务");
    }
    if (!scopeIsStaged && request.scope.type === "workspace" && createdByTaskId && this.deps.taskWorkspaceId(createdByTaskId) !== request.scope.workspaceId) {
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
      ...(request.backend === undefined ? {} : { backend: gadgetBackendSchema.parse(request.backend) }),
    };
    const paths = this.deps.storage.paths(id);
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
    return { descriptor, manifest };
  }

  private created(descriptor: GadgetDescriptor): GadgetDescriptor {
    this.emitChanged({ type: "created", gadgetId: descriptor.id });
    return descriptor;
  }

  private rollbackNewGadget(id: string, error: unknown): never {
    try { this.deps.storage.delete(id); } catch { /* startup reconciliation retries cleanup */ }
    throw error;
  }

  private mutate<T>(id: string, apply: () => Promise<T>): Promise<T> {
    const pending = (this.mutations.get(id) ?? Promise.resolve()).then(apply);
    const settled = pending.then(() => undefined, () => undefined).finally(() => {
      if (this.mutations.get(id) === settled) this.mutations.delete(id);
    });
    this.mutations.set(id, settled);
    return pending;
  }

  get(id: string): GadgetListItem | null {
    const descriptor = this.deps.repository.get(id);
    return descriptor ? { ...descriptor, runtime: this.deps.registry.runtime(id) } : null;
  }

  async read(id: string): Promise<GadgetListItem | null> {
    const descriptor = await this.deps.repository.read(id);
    return descriptor ? { ...descriptor, runtime: this.deps.registry.runtime(id) } : null;
  }

  update(request: GadgetUpdateRequest): GadgetDescriptor {
    const edit = this.prepareUpdate(request, this.require(request.gadgetId));
    try {
      if (edit.manifestChanged) this.deps.storage.writeManifest(edit.updated.id, edit.nextManifest);
      return this.updated(this.deps.repository.update(edit.updated), request.defaultConfig !== undefined);
    } catch (error) {
      return this.rollbackManifest(edit, error);
    }
  }

  async updateAsync(request: GadgetUpdateRequest): Promise<GadgetDescriptor> {
    return this.mutate(request.gadgetId, async () => {
      const current = await this.readRequired(request.gadgetId);
      const nativeManifest = await this.deps.storage.readManifestNative(current.id);
      if (!nativeManifest && this.deps.repository.usesCore) throw new Error("Gadget 配置未获 Rust Core 确认");
      const edit = this.prepareUpdate(request, current, nativeManifest?.manifest);
      if (edit.manifestChanged && nativeManifest &&
          await this.deps.storage.saveManifestNative(edit.updated, edit.nextManifest, nativeManifest.token, edit.patch)) {
        return this.updated(await this.readRequired(current.id), request.defaultConfig !== undefined);
      }
      if (this.deps.repository.usesCore && edit.manifestChanged) throw new Error("Gadget 配置写入未获 Rust Core 确认");
      try {
        if (edit.manifestChanged) this.deps.storage.writeManifest(edit.updated.id, edit.nextManifest);
        return this.updated(await this.deps.repository.updateAsync(edit.updated, edit.patch), request.defaultConfig !== undefined);
      } catch (error) {
        return this.rollbackManifest(edit, error);
      }
    });
  }

  private prepareUpdate(request: GadgetUpdateRequest, current: GadgetDescriptor, manifest?: GadgetManifest) {
    const name = request.name === undefined ? current.name : request.name.trim();
    if (!name) throw new Error("Gadget 名称不能为空");
    if (name.length > 120) throw new Error("Gadget 名称不能超过 120 字符");
    if ((request.description?.length ?? 0) > 2_000) throw new Error("Gadget 描述不能超过 2000 字符");
    const oldManifest = manifest ?? this.deps.storage.readManifest(current.id);
    const manifestChanged = request.name !== undefined || request.defaultConfig !== undefined;
    const nextManifest: GadgetManifest = {
      ...oldManifest,
      name: request.name === undefined ? oldManifest.name : name,
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
    const patch: RuntimeGadgetPatch = {
      name: request.name === undefined ? undefined : name,
      description: request.description === undefined ? undefined : { value: updated.description ?? null },
      metadataJson: request.metadata === undefined ? undefined : JSON.stringify(updated.metadata),
    };
    return { manifestChanged, oldManifest, nextManifest, updated, patch };
  }

  private rollbackManifest(edit: ReturnType<GadgetService["prepareUpdate"]>, error: unknown): never {
    if (edit.manifestChanged) {
      try { this.deps.storage.writeManifest(edit.updated.id, edit.oldManifest); } catch { /* preserve original failure */ }
    }
    throw error;
  }

  private updated(saved: GadgetDescriptor, configChanged = false): GadgetDescriptor {
    if (configChanged) this.deps.runtime.configurationChanged(saved);
    this.emitChanged({ type: "updated", gadgetId: saved.id });
    return saved;
  }

  list(request: GadgetListRequest = {}): GadgetListItem[] {
    const scopes = this.listScopes(request);
    return this.projectList(this.deps.repository.listScoped(scopes), scopes);
  }

  async readList(request: GadgetListRequest = {}): Promise<GadgetListItem[]> {
    if (this.deps.repository.usesCore && request.includeInherited && request.scope && request.scope.type !== "global") {
      return this.projectList(await this.deps.repository.readInherited(request.scope));
    }
    const scopes = this.listScopes(request);
    const rows = await this.deps.repository.readScoped(scopes);
    if (request.includeInherited && request.scope && request.scope.type !== "global" &&
        JSON.stringify(scopes?.slice(1)) !== JSON.stringify(this.listScopes(request)?.slice(1))) {
      const current = this.listScopes(request);
      return this.projectList(await this.deps.repository.readScoped(current), current);
    }
    return this.projectList(rows, scopes);
  }

  private listScopes({ scope, includeInherited }: GadgetListRequest): GadgetScope[] | undefined {
    if (!scope) return undefined;
    assertGadgetScope(scope);
    if (!includeInherited || scope.type === "global") return [scope];
    const workspaceIds = scope.type === "workspace"
      ? this.deps.workspaceAncestors(scope.workspaceId)
      : this.visibleWorkspaceIds(scope.taskId);
    const scopes: GadgetScope[] = [scope, ...workspaceIds.map(workspaceId => ({ type: "workspace" as const, workspaceId }))];
    if (scope.type === "task") scopes.push({ type: "global" });
    return scopes;
  }

  private projectList(rows: Array<{ descriptor: GadgetDescriptor; scopeIndex: number }>, scopes?: GadgetScope[]): GadgetListItem[] {
    return rows.map(({ descriptor, scopeIndex }) => {
      const scope = scopes?.[scopeIndex] ?? descriptor.scope;
      return {
        ...descriptor,
        runtime: this.deps.registry.runtime(descriptor.id),
        ...(scopeIndex > 0 && {
          inherited: true,
          ...(scope?.type === "workspace" && { inheritedFromWorkspaceId: scope.workspaceId }),
        }),
      };
    });
  }

  getForTask(id: string, taskId: string): GadgetListItem {
    if (this.deleting.has(id)) throw new Error("Gadget 正在删除：" + id);
    const gadget = this.get(id);
    if (!gadget) throw new Error(`Gadget 不存在：${id}`);
    this.assertVisibleToTask(gadget, taskId);
    return gadget;
  }

  async readForTask(id: string, taskId: string): Promise<GadgetListItem> {
    if (!this.deps.repository.usesCore) return this.getForTask(id, taskId);
    const descriptor = await this.deps.repository.readForTask(id, taskId);
    if (!descriptor || this.deleting.has(id)) throw new Error("当前任务不可访问该 Gadget，作用域可能已变化");
    return { ...descriptor, runtime: this.deps.registry.runtime(id) };
  }

  readSource(id: string): GadgetSourceSnapshot {
    this.require(id);
    return this.deps.storage.readSource(id);
  }

  async readSourceAsync(id: string): Promise<GadgetSourceSnapshot> {
    return this.mutate(id, async () => {
      await this.readRequired(id);
      return this.deps.storage.readSourceAsync(id);
    });
  }

  updateSource(request: GadgetSourceUpdateRequest): GadgetSourceSnapshot {
    const current = this.require(request.gadgetId);
    const updated = { ...current, updatedAt: Date.now() };
    const snapshot = this.deps.storage.updateSource(request, () => { this.deps.repository.update(updated); });
    this.sourceUpdated(updated, snapshot);
    return snapshot;
  }

  async updateSourceAsync(request: GadgetSourceUpdateRequest, taskId?: string): Promise<GadgetSourceSnapshot> {
    return this.mutate(request.gadgetId, async () => {
      if (taskId) await this.readForTask(request.gadgetId, taskId);
      const current = await this.readRequired(request.gadgetId);
      const updatedAt = Date.now();
      const nativeSnapshot = await this.deps.storage.updateSourceNative(request, updatedAt, taskId);
      if (nativeSnapshot) {
        this.sourceUpdated(await this.readRequired(current.id), nativeSnapshot);
        return nativeSnapshot;
      }
      if (this.deps.repository.usesCore) throw new Error("Gadget 源码保存未获 Rust Core 确认");
      if (taskId) await this.readForTask(request.gadgetId, taskId);
      let saved = current;
      const snapshot = await this.deps.storage.updateSource(request, async () => {
        saved = await this.deps.repository.touchAsync(current.id, updatedAt);
      });
      this.sourceUpdated(saved, snapshot);
      return snapshot;
    });
  }

  private sourceUpdated(saved: GadgetDescriptor, snapshot: GadgetSourceSnapshot): void {
    this.deps.runtime.sourceChanged(saved, Boolean(snapshot.manifest.backend));
    this.emitChanged({ type: "updated", gadgetId: saved.id, sourceChanged: true });
  }

  async openForTask(id: string, taskId: string): Promise<GadgetRuntimeState> {
    await this.readForTask(id, taskId);
    const state = await this.start(id);
    if (state.status === "running") {
      await this.readForTask(id, taskId);
      this.emitChanged({ type: "open-requested", gadgetId: id, taskId });
    }
    return state;
  }

  async callForTask(id: string, taskId: string, action: string, input: GadgetJson = null, signal?: AbortSignal): Promise<GadgetJson> {
    const gadget = await this.readForTask(id, taskId);
    if (!/^[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/.test(action)) throw new Error("Gadget action 名称无效");
    const result = await this.deps.runtime.request(gadget, `actions/${encodeURIComponent(action)}`, { input }, {
      signal, authorize: async () => { await this.readForTask(id, taskId); },
    });
    await this.readForTask(id, taskId);
    return result;
  }

  async runtimeForTask(id: string, taskId: string, operation: "status" | "stop" | "restart" | "logs"): Promise<unknown> {
    const gadget = await this.readForTask(id, taskId);
    let result: unknown;
    if (operation === "status") result = await this.health(id);
    else if (operation === "stop") result = await this.stop(id);
    else if (operation === "restart") result = await this.restart(id);
    else if (gadget.runtime.status !== "running") result = { runtime: gadget.runtime, logs: [] };
    else result = await this.deps.runtime.request(gadget, "logs", undefined, { start: false,
      authorize: async () => { await this.readForTask(id, taskId); },
    });
    await this.readForTask(id, taskId);
    return result;
  }

  /** Independent source/configuration snapshot. Runtime data and browser sessions are not shared. */
  copyScope(id: string, scope: GadgetScope): GadgetDescriptor {
    assertGadgetScope(scope);
    this.assertScopeTarget(scope);
    const descriptor = this.planCopy(this.require(id), scope);
    this.materializeCopy(id, descriptor);
    try { return this.created(this.deps.repository.create(descriptor)); }
    catch (error) { return this.rollbackNewGadget(descriptor.id, error); }
  }

  async copyScopeAsync(id: string, scope: GadgetScope): Promise<GadgetDescriptor> {
    return this.mutate(id, async () => {
      assertGadgetScope(scope);
      const core = this.deps.repository.usesCore;
      if (!core) this.assertScopeTarget(scope);
      const original = core && scope.type === "task" ? await this.readForTask(id, scope.taskId) : await this.readRequired(id);
      const descriptor = this.planCopy(original, scope, !core);
      const source = await this.deps.storage.inspectNative(id);
      if (source) {
        if (!source.paths.length) throw new Error("Gadget 入口文件不存在，不能保存空源码副本");
        if (await this.deps.storage.createNative(descriptor, source.manifest, { sourceId: id, token: source.token })) {
          return this.created(descriptor);
        }
      }
      if (core) throw new Error("Gadget 源码复制未获 Rust Core 确认");
      this.materializeCopy(id, descriptor);
      try { return this.created(await this.deps.repository.createAsync(descriptor, { kind: "copy", sourceId: id })); }
      catch (error) { return this.rollbackNewGadget(descriptor.id, error); }
    });
  }

  private materializeCopy(id: string, descriptor: GadgetDescriptor): void {
    const snapshot = this.deps.storage.readSource(id);
    if (snapshot.files.length === 0) throw new Error("Gadget 入口文件不存在，不能保存空源码副本");
    this.deps.storage.create(descriptor.id, snapshot.manifest, snapshot.files);
  }

  private planCopy(original: GadgetDescriptor, scope: GadgetScope, checkHostScope = true): GadgetDescriptor {
    // A task destination must already be able to see the source; never copy another task's private tool.
    if (checkHostScope && scope.type === "task") this.assertVisibleToTask(original, scope.taskId);
    const metadata = normalizeJsonRecord(original.metadata, "Gadget metadata");
    const copyId = `gdt-${randomUUID()}`;
    const paths = this.deps.storage.paths(copyId);
    const now = Date.now();
    // createdByTaskId remains origin provenance; visibility and deletion use scope exclusively.
    return {
      ...original,
      id: copyId,
      scope: { ...scope },
      manifestPath: paths.manifestPath,
      sourcePath: paths.sourcePath,
      metadata,
      createdAt: now,
      updatedAt: now,
    };
  }

  moveScope(id: string, scope: GadgetScope): GadgetDescriptor {
    assertGadgetScope(scope);
    this.assertScopeTarget(scope);
    if (!this.deps.repository.get(id)) throw new Error(`Gadget 不存在：${id}`);
    return this.updated(this.deps.repository.moveScope(id, scope));
  }

  async moveScopeAsync(id: string, scope: GadgetScope): Promise<GadgetDescriptor> {
    return this.mutate(id, async () => {
      assertGadgetScope(scope);
      if (!this.deps.repository.usesCore) this.assertScopeTarget(scope);
      await this.readRequired(id);
      return this.updated(await this.deps.repository.moveScopeAsync(id, scope));
    });
  }

  async start(id: string): Promise<GadgetRuntimeState> {
    return this.launch(id, "start");
  }

  /** Resolve only an observed Gadget origin, within the calling task's scope.
   * Used for explicit browser navigation, never for replaying an input or edit. */
  async resolveBrowserPreview(rawUrl: string, taskId: string, explicitGadgetId?: string): Promise<GadgetBrowserPreview | null> {
    const requested = new URL(rawUrl);
    const origin = this.previewOrigin(requested);
    if (explicitGadgetId && (requested.protocol !== "http:" || !["localhost", "127.0.0.1"].includes(requested.hostname))) {
      throw new Error("gadgetId 只能与本机 Gadget 预览 URL 一起使用");
    }
    if (!explicitGadgetId && !this.previewOwners.has(origin)) return null;
    const gadgetId = explicitGadgetId ?? this.previewOwners.get(origin);
    if (!gadgetId) throw new Error("该预览端口曾属于不同 Gadget，无法安全判断目标。请用 gadget_open 取得目标，再为 browser_exec navigate 同时提供 gadgetId 和 URL；不会导航到这个旧端口。");
    await this.readForTask(gadgetId, taskId);
    const runtime = await this.start(gadgetId);
    // Awaited startup may outlive a scope change or deletion.
    await this.readForTask(gadgetId, taskId);
    if (runtime.status !== "running" || !runtime.url) throw new GadgetPreviewUnavailableError(gadgetId, runtime);
    const target = new URL(runtime.url);
    target.pathname = requested.pathname;
    target.search = requested.search;
    target.hash = requested.hash;
    const url = target.href;
    const { revision } = await this.readSourceAsync(gadgetId);
    const current = await this.readForTask(gadgetId, taskId);
    if (current.runtime.status !== "running" || current.runtime.url !== runtime.url || current.runtime.pid !== runtime.pid) {
      throw new GadgetPreviewUnavailableError(gadgetId, current.runtime);
    }
    return { gadgetId, url, ...(url !== requested.href ? { previousUrl: requested.href } : {}), revision, runtime };
  }

  private previewOrigin(url: URL): string {
    // The fixture host accepts both names for its IPv4 listener. Ownership must
    // not disappear merely because a caller uses the other loopback alias.
    if (url.protocol === "http:" && ["localhost", "127.0.0.1"].includes(url.hostname)) {
      return `http://127.0.0.1:${url.port || "80"}`;
    }
    return url.origin;
  }

  private rememberPreview(state: GadgetRuntimeState): void {
    if (state.status !== "running" || !state.url) return;
    const origin = this.previewOrigin(new URL(state.url));
    if (this.previewOwners.has(origin) && this.previewOwners.get(origin) !== state.gadgetId) {
      this.previewOwners.set(origin, null);
    } else this.previewOwners.set(origin, state.gadgetId);
    // Do not evict known origins: an evicted/recycled port must not become an
    // ordinary unscoped URL. Loopback ports bound the map for this app lifetime.
  }

  async health(id: string): Promise<GadgetRuntimeState> {
    await this.readRequired(id);
    const state = await this.deps.runtime.health(id);
    this.rememberPreview(state);
    this.emitChanged({ type: "runtime", gadgetId: id });
    return state;
  }

  async stop(id: string): Promise<GadgetRuntimeState> {
    await this.readRequired(id);
    const state = await this.deps.runtime.stop(id);
    this.emitChanged({ type: "runtime", gadgetId: id });
    return state;
  }

  async restart(id: string): Promise<GadgetRuntimeState> {
    return this.launch(id, "restart");
  }

  private async launch(id: string, action: "start" | "restart"): Promise<GadgetRuntimeState> {
    // Reserve the descriptor read and runtime enqueue together. Startup itself
    // runs on the runtime queue so later stop and delete requests can proceed.
    const { pending } = await this.mutate(id, async () => ({
      pending: this.deps.runtime[action](await this.readRequired(id)),
    }));
    const state = await pending;
    this.rememberPreview(state);
    this.emitChanged({ type: "runtime", gadgetId: id });
    return state;
  }

  async delete(id: string): Promise<void> {
    return this.mutate(id, async () => {
      await this.readRequired(id);
      this.deleting.add(id);
      try {
        await this.deps.runtime.dispose(id);
        if (!await this.deps.repository.deleteAsync(id)) throw new Error(`Gadget 不存在：${id}`);
        this.deps.registry.remove(id);
        this.emitChanged({ type: "deleted", gadgetId: id });
        try { await this.deps.storage.removeUnregistered(id); }
        catch (error) { console.warn(`[GadgetService] Gadget ${id} storage 将在下次启动重试清理`, error); }
      } finally {
        this.deleting.delete(id);
      }
    });
  }

  async deleteByWorkspace(workspaceId: string): Promise<void> {
    const gadgets = await this.deps.repository.readScoped([{ type: "workspace", workspaceId }]);
    for (const { descriptor } of gadgets) await this.delete(descriptor.id);
  }

  async deleteByTask(taskId: string): Promise<void> {
    const gadgets = await this.deps.repository.readScoped([{ type: "task", taskId }]);
    for (const { descriptor } of gadgets) await this.delete(descriptor.id);
  }

  planBlueprintGadget(input: Omit<GadgetCreateRequest, "createdByTaskId">, planned: {
    workspaces: ReadonlySet<string>; tasks: ReadonlySet<string>;
  }): BlueprintGadgetPlan {
    const scope = input.scope;
    const scopeIsStaged = scope.type === "workspace" ? planned.workspaces.has(scope.workspaceId)
      : scope.type === "task" && planned.tasks.has(scope.taskId);
    return { ...this.planCreate(input, scopeIsStaged), files: input.files };
  }

  blueprintGadgetFiles(plan: BlueprintGadgetPlan) {
    return this.deps.storage.blueprintFiles(plan.descriptor.id, plan.manifest, plan.files);
  }

  materializeBlueprintGadget(plan: BlueprintGadgetPlan): void {
    this.deps.storage.create(plan.descriptor.id, plan.manifest, plan.files);
  }

  insertBlueprintGadget(descriptor: GadgetDescriptor): void {
    this.assertScopeTarget(descriptor.scope);
    this.deps.repository.create(descriptor);
  }

  publishBlueprintGadget(descriptor: GadgetDescriptor): void { this.created(descriptor); }

  discardBlueprintGadget(id: string): void { this.deps.storage.delete(id); }

  async convertFromArtifact(input: { artifactId: string; scope: GadgetScope; name?: string; description?: string }): Promise<GadgetDescriptor> {
    if (!this.deps.artifacts) throw new Error("Artifact Domain 尚未连接");
    const artifact = await this.deps.artifacts.read(input.artifactId);
    if (!artifact) throw new Error(`Artifact 不存在：${input.artifactId}`);
    if (artifact.kind !== "html") throw new Error("当前仅支持把 HTML Artifact 转换为 Gadget");
    if (input.scope.type !== "task" || input.scope.taskId !== artifact.taskId) {
      throw new Error("Artifact 只能先转换为其所属任务的 Task Gadget；长期使用请在创建后保存独立副本");
    }
    return this.createAsync({
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
    const artifacts = this.deps.artifacts;
    if (!artifacts) throw new Error("Artifact Domain 尚未连接");
    return this.mutate(input.gadgetId, async () => {
      const gadget = await this.readForTask(input.gadgetId, input.taskId);
      const title = input.title?.trim() || gadget.name;
      const readOnHost = () => {
        this.getForTask(gadget.id, input.taskId);
        const entry = this.deps.storage.readEntry(gadget.id);
        this.assertStandaloneHtml(entry.manifest);
        return entry.content;
      };
      if (artifacts.writeFromGadget) {
        const source = await this.deps.storage.readManifestNative(gadget.id);
        if (source) {
          await this.readForTask(gadget.id, input.taskId);
          this.assertStandaloneHtml(source.manifest);
          return artifacts.writeFromGadget({
            taskId: input.taskId,
            title,
            source: this.deps.storage.artifactSource(gadget.id, source.manifest.entry, source.token),
          }, readOnHost);
        }
      }
      if (this.deps.repository.usesCore) throw new Error("Gadget 成果导出未获 Rust Core 确认");
      return artifacts.write({ taskId: input.taskId, title, content: readOnHost() });
    });
  }

  private assertStandaloneHtml(manifest: GadgetManifest): void {
    if (manifest.backend) throw new Error("这个 Gadget 包含后台，独立 HTML Artifact 无法运行它。请保存到任务目录或另存为 Blueprint；导出报告时请生成不依赖后台的 HTML。");
  }

  /** Only Main resolves the destination; renderer paths and active-task state are not trusted. */
  saveToTaskDirectory(input: GadgetSaveToTaskDirectoryRequest): GadgetSaveToTaskDirectoryResult {
    const gadget = this.getForTask(input.gadgetId, input.taskId);
    if (!this.deps.resolveTaskDirectory) throw new Error("任务工作目录尚未连接");
    const directory = this.deps.resolveTaskDirectory(input.taskId);
    return saveGadgetToTaskDirectory(directory, gadget, this.deps.storage.readSource(gadget.id));
  }

  async saveToTaskDirectoryAsync(input: GadgetSaveToTaskDirectoryRequest): Promise<GadgetSaveToTaskDirectoryResult> {
    return this.mutate(input.gadgetId, async () => {
      await this.readForTask(input.gadgetId, input.taskId);
      const source = await this.deps.storage.inspectNative(input.gadgetId);
      if (!source) {
        if (this.deps.repository.usesCore) throw new Error("Gadget 源码导出未获 Rust Core 确认");
        return this.saveToTaskDirectory(input);
      }
      const gadget = await this.readForTask(input.gadgetId, input.taskId);
      if (!this.deps.resolveTaskDirectoryAsync && !this.deps.resolveTaskDirectory) throw new Error("任务工作目录尚未连接");
      const directory = this.deps.resolveTaskDirectoryAsync
        ? await this.deps.resolveTaskDirectoryAsync(input.taskId)
        : this.deps.resolveTaskDirectory!(input.taskId);
      return this.deps.storage.exportNative(directory, gadget, source, input.taskId);
    });
  }

  async captureSourceAsync(id: string): Promise<{ descriptor: GadgetDescriptor; manifest: GadgetManifest; sourceFiles: GadgetSourceFile[] }> {
    return this.mutate(id, async () => {
      const descriptor = await this.readRequired(id);
      return { descriptor, ...await this.deps.storage.captureSourceAsync(id) };
    });
  }

  async disposeAll(): Promise<void> {
    while (this.mutations.size) await Promise.allSettled(this.mutations.values());
    await this.deps.runtime.disposeAll();
  }

  async dispose(id: string): Promise<void> {
    await this.readRequired(id);
    await this.deps.runtime.dispose(id);
  }

  private require(id: string): GadgetDescriptor {
    if (this.deleting.has(id)) throw new Error(`Gadget 正在删除：${id}`);
    const descriptor = this.deps.repository.get(id);
    if (!descriptor) throw new Error(`Gadget 不存在：${id}`);
    return descriptor;
  }

  private async readRequired(id: string): Promise<GadgetDescriptor> {
    const descriptor = await this.deps.repository.read(id);
    if (this.deleting.has(id)) throw new Error(`Gadget 正在删除：${id}`);
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
