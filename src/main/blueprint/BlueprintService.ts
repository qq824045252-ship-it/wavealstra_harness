import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { AppDatabase } from "../db/AppDatabase";
import type { BlueprintGadgetPlan, GadgetService } from "../gadget/GadgetService";
import { MemoryService } from "../memory/MemoryService";
import type { WorkspaceLibraryBindingService } from "../workspace/WorkspaceLibraryBindingService";
import type {
  BlueprintCaptureOptions,
  BlueprintCreateRequest,
  BlueprintDefinition,
  BlueprintDescriptor,
  BlueprintGadgetDefinition,
  BlueprintInstantiateRequest,
  BlueprintInstantiationPlan,
  BlueprintInstantiationResult,
  BlueprintUpdateRequest,
  GadgetBlueprintDefinition,
  ResolvedBlueprint,
  WorkspaceBlueprintNode,
} from "../../shared/blueprint-types";
import {
  BLUEPRINT_DEFINITION_SCHEMA_VERSION,
  BLUEPRINT_MAX_CONTEXT_CHARS,
  BLUEPRINT_MAX_FILES,
  BLUEPRINT_MAX_FILE_BYTES,
  BLUEPRINT_MAX_TOTAL_FILE_BYTES,
} from "../../shared/blueprint-types";
import { normalizeBlueprintDefinition } from "../../shared/blueprint-types";
import type { GadgetDescriptor, GadgetScope } from "../../shared/gadget-types";
import type { MemoryRecordDto } from "../../shared/memory-kernel";
import { BLUEPRINT_CAPTURE_DENY_PATTERN, isBlueprintSensitivePath, redactBlueprintSecrets } from "../../shared/blueprint-secret-policy";
import { decodeBlueprintFile } from "./capture-file";
import type { BlueprintRepository } from "./BlueprintRepository";
import type { BlueprintResolver } from "./BlueprintResolver";
import type { BlueprintInstantiationPlanner } from "./BlueprintInstantiationPlanner";
import type { BlueprintChangedEvent } from "../../shared/blueprint-ipc";
import { gadgetInsertValues } from "../gadget/GadgetRepository";
import { BlueprintCommitUnconfirmed, writeBlueprintInstance, type RuntimeBlueprintInstance } from "./BlueprintInstanceWrite";

const CAPTURE_EXCLUDED = new Set(["node_modules", "cache", ".cache", ".next", "dist", "build", ".mybuddy-task.json"]);

export interface BlueprintServiceDependencies {
  repository: BlueprintRepository;
  resolver: BlueprintResolver;
  planner: BlueprintInstantiationPlanner;
  db: AppDatabase;
  gadgetService: GadgetService;
  libraryBindings: WorkspaceLibraryBindingService;
  /** Shared production Memory Kernel; tests/standalone callers may omit (semantic disabled fallback). */
  memoryService?: MemoryService;
  librarySpaceExists(id: string): boolean;
  workspaceInstancesRoot: string;
  onChanged?(event: BlueprintChangedEvent): void;
}

export class BlueprintService {
  private readonly memory: MemoryService;
  constructor(private readonly deps: BlueprintServiceDependencies) {
    this.memory = deps.memoryService ?? new MemoryService(deps.db, { semantic: false });
    mkdirSync(deps.workspaceInstancesRoot, { recursive: true });
  }

  async recoverStorage(): Promise<void> {
    const reader = this.deps.db.runtimeAuditReader;
    const rustRequired = Boolean(reader?.supervised || this.deps.db.readonly);
    const failures = reader ? await reader.reconcileBlueprintStorage(resolve(this.deps.workspaceInstancesRoot)) : "needsHost";
    if (failures === "needsHost") {
      if (rustRequired) {
        console.warn("[BlueprintService] Rust Core 将在下次启动重试孤立实例目录清理");
        return;
      }
      this.reconcileWorkspaceInstances();
    } else if (failures) {
      for (const error of failures) console.warn("[BlueprintService] 无法清理 orphan instance", error);
    } else {
      console.warn("[BlueprintService] 孤立实例目录将在下次启动清理");
    }
  }

  async create(request: BlueprintCreateRequest): Promise<BlueprintDescriptor> {
    const created = await this.deps.repository.create(request);
    this.emitChanged({ type: "created", blueprintId: created.id });
    return created;
  }

  list(): BlueprintDescriptor[] {
    return this.deps.repository.list();
  }

  readList(): Promise<BlueprintDescriptor[]> {
    return this.deps.repository.readList();
  }

  get(id: string): Promise<BlueprintDescriptor | null> {
    return this.deps.repository.read(id);
  }

  async update(request: BlueprintUpdateRequest): Promise<BlueprintDescriptor> {
    const updated = await this.deps.repository.update(request);
    this.emitChanged({ type: "updated", blueprintId: updated.id });
    return updated;
  }

  async resolve(id: string, registries?: BlueprintInstantiateRequest["registries"]): Promise<ResolvedBlueprint> {
    return this.deps.resolver.resolve((await this.readRequired(id)).definition, registries);
  }

  async plan(id: string, registries?: BlueprintInstantiateRequest["registries"]): Promise<BlueprintInstantiationPlan> {
    return this.deps.planner.build(await this.resolve(id, registries));
  }

  async instantiate(request: BlueprintInstantiateRequest): Promise<BlueprintInstantiationResult> {
    const blueprint = await this.readRequired(request.blueprintId);
    const plan = this.deps.planner.build(this.deps.resolver.resolve(blueprint.definition, request.registries));
    const warnings = [...plan.warnings];
    const workspaceIdsByKey = Object.fromEntries(plan.workspaces.map(item => [item.key, `sp-${randomUUID()}`]));
    const taskIdsByKey = Object.fromEntries(plan.tasks.map(item => [item.key, `task-${randomUUID()}`]));
    const pathsByKey = new Map<string, string>();
    const contexts: MemoryRecordDto[] = [];
    const gadgets: Array<BlueprintGadgetPlan & { key: string }> = [];
    const hostGadgets: GadgetDescriptor[] = [];
    let generatedRoot: string | null = null;
    let hostRoot: string | null = null;
    const materializeOnHost = () => {
      if (generatedRoot) {
        mkdirSync(generatedRoot);
        hostRoot = generatedRoot;
        for (const path of pathsByKey.values()) if (path !== hostRoot) ensureSafeDirectory(hostRoot, path);
        for (const file of plan.files) {
          writeSeedFile(pathsByKey.get(file.workspaceKey)!, file.path, file.content, file.encoding, hostRoot);
        }
      }
      for (const gadget of gadgets) {
        this.deps.gadgetService.materializeBlueprintGadget(gadget);
        hostGadgets.push(gadget.descriptor);
      }
    };

    try {
      const workspaces: RuntimeBlueprintInstance["workspaces"] = [];
      const first = plan.workspaces[0];
      if (first) {
        const rootName = request.rootName?.trim() || first.name;
        if (rootName.length > 240) throw new Error("Blueprint instance Workspace 名称不能超过 240 字符");
        const base = resolve(this.deps.workspaceInstancesRoot, `bp-${randomUUID()}`);
        generatedRoot = base;
        const workspacePaths = new Set<string>();
        for (const item of plan.workspaces) {
          const id = workspaceIdsByKey[item.key];
          const parentId = item.parentKey ? workspaceIdsByKey[item.parentKey] : null;
          const name = item === first ? rootName : item.name;
          const path = item.parentKey ? join(pathsByKey.get(item.parentKey)!, safeName(name)) : base;
          const pathKey = resolve(path).toLocaleLowerCase();
          if (workspacePaths.has(pathKey)) throw new Error(`Blueprint Workspace 目录冲突：${path}`);
          workspacePaths.add(pathKey);
          workspaces.push({ id, name, parentId, path });
          pathsByKey.set(item.key, path);
          if (item.defaultContext) contexts.push(this.memory.prepareBlueprintContext(id, item.defaultContext, blueprint.id));
        }
      }

      const planned = { workspaces: new Set(Object.values(workspaceIdsByKey)), tasks: new Set(Object.values(taskIdsByKey)) };
      for (const gadget of plan.gadgets) {
        const scope = this.resolveGadgetScope(gadget, request.gadgetScope, workspaceIdsByKey, taskIdsByKey);
        const plannedGadget = this.deps.gadgetService.planBlueprintGadget({
          name: gadget.name, description: gadget.description, scope, entry: gadget.manifest.entry,
          files: gadget.sourceFiles, defaultConfig: gadget.manifest.defaultConfig, backend: gadget.manifest.backend,
          metadata: gadget.metadata, blueprintId: blueprint.id,
        }, planned);
        gadgets.push({ key: gadget.key, ...plannedGadget });
      }

      const instance: RuntimeBlueprintInstance = {
        blueprintId: blueprint.id, createdAt: Date.now(), workspaces,
        tasks: plan.tasks.map(task => ({ id: taskIdsByKey[task.key], workspaceId: workspaceIdsByKey[task.workspaceKey],
          title: task.title, status: task.status ?? "pending", welcomeMode: task.welcomeMode })),
        libraryBindings: plan.libraryBindings.map(binding => ({ workspaceId: workspaceIdsByKey[binding.workspaceKey],
          librarySpaceId: binding.librarySpaceId, optional: binding.optional !== false })),
        contexts: contexts.map(context => ({ id: context.id, workspaceId: context.scopes[0].scopeId!,
          scopeId: randomUUID(), revisionId: randomUUID(), content: context.content, title: context.title,
          contentHash: context.contentHash, metadataJson: JSON.stringify(context.metadata), createdAt: context.createdAt })),
        gadgets: gadgets.map(gadget => gadgetInsertValues(gadget.descriptor)),
      };
      const nativeFiles = await this.deps.db.runtimeAuditReader?.supportsManagedStorage();
      if (!nativeFiles && this.deps.db.runtimeAuditReader?.supervised) throw new Error("蓝图存储未获 Rust Core 确认");
      if (nativeFiles) {
        instance.storage = {
          workspaceInstancesRoot: resolve(this.deps.workspaceInstancesRoot),
          seeds: plan.files.map(file => ({
            workspaceId: workspaceIdsByKey[file.workspaceKey], path: normalizeCapturePath(file.path),
            base64: file.encoding === "base64" ? file.content : Buffer.from(file.content, "utf8").toString("base64"),
          })),
          gadgets: gadgets.map(gadget => this.deps.gadgetService.blueprintGadgetFiles(gadget)),
        };
      } else {
        materializeOnHost();
      }
      const status = await writeBlueprintInstance(this.deps.db, instance);
      let skippedLibraries: string[];
      if (!status) {
        if (nativeFiles) materializeOnHost();
        skippedLibraries = this.insertOnHost(instance, contexts, gadgets.map(gadget => gadget.descriptor));
      } else {
        switch (status.kind) {
          case "committed": skippedLibraries = status.skippedLibraries; break;
          case "missingBlueprint": throw new Error(`Blueprint 不存在：${blueprint.id}`);
          case "missingLibrary": throw new Error(`必需资料库 ${status.id} 不存在`);
          case "duplicateWorkspace": throw new Error(`工作空间名称重复：${status.name}`);
          case "scopeChanged": throw new Error("Blueprint 的目标作用域已变化，请刷新后重试");
          case "failed": throw new Error(`蓝图实例数据库写入失败：${status.message}`);
        }
      }
      warnings.push(...skippedLibraries.map(id => `资料库 ${id} 不存在，已跳过绑定`));
    } catch (error) {
      if (error instanceof BlueprintCommitUnconfirmed) throw error;
      for (const descriptor of hostGadgets.reverse()) {
        try { this.deps.gadgetService.discardBlueprintGadget(descriptor.id); }
        catch (cleanupError) { console.warn(`[BlueprintService] 无法清理失败组件 ${descriptor.id}`, cleanupError); }
      }
      if (hostRoot && isInside(this.deps.workspaceInstancesRoot, hostRoot)) {
        try { rmSync(hostRoot, { recursive: true, force: true }); }
        catch (cleanupError) { console.warn(`[BlueprintService] 无法清理失败实例目录 ${hostRoot}`, cleanupError); }
      }
      throw error;
    }

    for (const { descriptor } of gadgets) this.deps.gadgetService.publishBlueprintGadget(descriptor);
    for (const context of contexts) this.memory.indexSavedMemory(context);
    const gadgetIdsByKey = Object.fromEntries(gadgets.map(({ key, descriptor }) => [key, descriptor.id]));
    return { blueprintId: blueprint.id, workspaceIdsByKey, taskIdsByKey, gadgetIdsByKey, warnings, missing: plan.missing };
  }

  private insertOnHost(instance: RuntimeBlueprintInstance, contexts: MemoryRecordDto[], gadgets: GadgetDescriptor[]): string[] {
    return this.deps.db.transaction(() => {
      if (!this.deps.repository.get(instance.blueprintId)) throw new Error(`Blueprint 不存在：${instance.blueprintId}`);
      for (const workspace of instance.workspaces) this.deps.db.createSpace(workspace);
      for (const task of instance.tasks) {
        this.deps.db.upsertTask({ id: task.id, title: task.title, status: task.status as import("../../shared/agent-ipc").TaskDto["status"],
          spaceId: task.workspaceId, welcomeMode: task.welcomeMode, updatedAt: instance.createdAt });
      }
      const skipped: string[] = [];
      for (const binding of instance.libraryBindings) {
        if (!this.deps.librarySpaceExists(binding.librarySpaceId)) {
          if (!binding.optional) throw new Error(`必需资料库 ${binding.librarySpaceId} 不存在`);
          skipped.push(binding.librarySpaceId);
          continue;
        }
        this.deps.libraryBindings.bind(binding.workspaceId, binding.librarySpaceId);
      }
      for (const context of contexts) this.memory.insertBlueprintContext(context);
      for (const gadget of gadgets) this.deps.gadgetService.insertBlueprintGadget(gadget);
      return skipped;
    });
  }

  async captureDefinition(workspaceId: string, options: BlueprintCaptureOptions, confirmedDefinition?: BlueprintDefinition): Promise<BlueprintDescriptor> {
    // Keep origin validation even when committing an exact preview supplied by the capture dialog.
    if (!this.deps.db.getSpace(workspaceId)) throw new Error(`工作空间不存在：${workspaceId}`);
    const definition = confirmedDefinition
      ? normalizeBlueprintDefinition(confirmedDefinition)
      : await this.previewCaptureDefinition(workspaceId, options);
    return this.create({ name: options.name, description: options.description, definition });
  }

  async previewCaptureDefinition(workspaceId: string, options: BlueprintCaptureOptions): Promise<BlueprintDefinition> {
    const root = this.deps.db.getSpace(workspaceId);
    if (!root) throw new Error(`工作空间不存在：${workspaceId}`);
    const selected = new Map<string, string>();
    for (const item of options.selectedFiles ?? []) {
      const normalized = normalizeCapturePath(item);
      selected.set(normalized.toLocaleLowerCase(), normalized);
    }
    if (selected.size > BLUEPRINT_MAX_FILES) throw new Error(`Blueprint 选择文件不能超过 ${BLUEPRINT_MAX_FILES} 个`);
    const tasks = options.includeTasks !== false ? this.deps.db.listTasks() : [];
    const capturedWorkspaceIds = new Set<string>();
    let workspaceSequence = 0;
    let taskSequence = 0;
    let gadgetSequence = 0;
    const captureNode = async (id: string): Promise<WorkspaceBlueprintNode> => {
      if (capturedWorkspaceIds.has(id)) throw new Error(`Workspace 树存在循环或重复引用：${id}`);
      capturedWorkspaceIds.add(id);
      const workspace = this.deps.db.getSpace(id);
      if (!workspace) throw new Error(`工作空间不存在：${id}`);
      const workspaceKey = `workspace:${++workspaceSequence}`;
      const node: WorkspaceBlueprintNode = { key: workspaceKey, name: workspace.name };
      if (options.includeContext === true) {
        const manualContext = (await this.memory.searchLexical({
          workspaceId: id, scopeTypes: ["workspace"], includeInherited: false, statuses: ["active"], limit: 500,
        }))
          .map(({ memory }) => memory)
          .filter((memory) => memory.sourceType !== "agent")
          .map((memory) => redactBlueprintSecrets((memory.content ? `${memory.title} — ${memory.content}` : memory.title).trim()))
          .filter(Boolean);
        const bounded: string[] = [];
        let chars = 0;
        for (const item of manualContext) {
          const separator = bounded.length ? 2 : 0;
          if (chars + separator + item.length > BLUEPRINT_MAX_CONTEXT_CHARS) break;
          bounded.push(item);
          chars += separator + item.length;
        }
        if (bounded.length) node.defaultContext = bounded.join("\n\n");
      }
      const bindings = this.deps.libraryBindings.listByWorkspace(id);
      if (bindings.length) node.libraryBindings = bindings.map((librarySpaceId) => ({ librarySpaceId, optional: true }));
      const workspaceTasks = tasks.filter(task => task.spaceId === id && !task.archived);
      if (workspaceTasks.length) node.tasks = workspaceTasks.map((task) => ({
        key: `task:${++taskSequence}`,
        title: task.title,
        ...(task.welcomeMode ? { welcomeMode: task.welcomeMode } : {}),
      }));
      if (options.includeGadgets !== false) {
        const gadgets = await this.deps.gadgetService.readList({ scope: { type: "workspace", workspaceId: id } });
        if (gadgets.length) {
          node.gadgets = [];
          for (const gadget of gadgets) {
            node.gadgets.push(await this.gadgetDefinition(gadget.id, id, workspaceKey, `gadget:${++gadgetSequence}`));
          }
        }
      }
      if (id === workspaceId && selected.size && workspace.path) {
        node.files = await this.captureWorkspaceFiles(id, workspace.path, [...selected.values()]);
      }
      if (options.includeChildren !== false) {
        const children = this.deps.db.getSpaceChildren(id).filter((space) => !space.effectiveArchived);
        if (children.length) {
          node.children = [];
          for (const child of children) node.children.push(await captureNode(child.id));
        }
      }
      return node;
    };
    const workspace = await captureNode(workspaceId);
    const hasGadgets = hasWorkspaceGadgets(workspace);
    const definition: BlueprintDefinition = hasGadgets
      ? { schemaVersion: BLUEPRINT_DEFINITION_SCHEMA_VERSION, kind: "composite", workspace }
      : { schemaVersion: BLUEPRINT_DEFINITION_SCHEMA_VERSION, kind: "workspace", workspace };
    return normalizeBlueprintDefinition(definition);
  }

  private async captureWorkspaceFiles(workspaceId: string, root: string, paths: string[]): Promise<NonNullable<WorkspaceBlueprintNode["files"]>> {
    if (this.deps.db.getSpace(workspaceId)?.path !== root) throw new Error("工作空间目录已变化，请重新预览");
    const capture = await this.deps.db.runtimeAuditReader?.captureBlueprintWorkspace(root, paths, BLUEPRINT_CAPTURE_DENY_PATTERN);
    if (this.deps.db.getSpace(workspaceId)?.path !== root) throw new Error("工作空间目录已变化，请重新预览");
    if (capture?.status === "captured") return capture.files.map(decodeBlueprintFile);
    if (capture?.status === "rejected") throw new Error(capture.message);
    const budget = { totalBytes: 0 };
    return paths.map(path => captureSelectedFile(root, path, budget));
  }

  async captureGadget(gadgetId: string, input: { name?: string; description?: string } = {}): Promise<BlueprintDescriptor> {
    const captured = await this.deps.gadgetService.captureSourceAsync(gadgetId);
    const definition: GadgetBlueprintDefinition = {
      schemaVersion: BLUEPRINT_DEFINITION_SCHEMA_VERSION,
      kind: "gadget",
      gadget: {
        key: "gadget:root",
        name: captured.descriptor.name,
        description: captured.descriptor.description,
        manifest: captured.manifest,
        sourceFiles: captured.sourceFiles,
        metadata: sanitizeBlueprintMetadata(captured.descriptor.metadata),
      },
    };
    return this.create({
      name: input.name?.trim() || captured.descriptor.name,
      description: input.description ?? captured.descriptor.description,
      definition,
    });
  }

  async delete(id: string): Promise<void> {
    if (!await this.deps.repository.delete(id)) throw new Error(`Blueprint 不存在：${id}`);
    this.emitChanged({ type: "deleted", blueprintId: id });
  }

  private async gadgetDefinition(id: string, workspaceId: string, workspaceKey: string, key: string): Promise<BlueprintGadgetDefinition> {
    const captured = await this.deps.gadgetService.captureSourceAsync(id);
    if (captured.descriptor.scope.type !== "workspace" || captured.descriptor.scope.workspaceId !== workspaceId) {
      throw new Error("Gadget 作用域已变化，请重新预览");
    }
    return {
      key,
      name: captured.descriptor.name,
      description: captured.descriptor.description,
      manifest: captured.manifest,
      sourceFiles: captured.sourceFiles,
      metadata: sanitizeBlueprintMetadata(captured.descriptor.metadata),
      workspaceKey,
      scopeType: "workspace",
    };
  }

  private resolveGadgetScope(
    gadget: BlueprintInstantiationPlan["gadgets"][number],
    requested: GadgetScope | undefined,
    workspaceIds: Record<string, string>,
    taskIds: Record<string, string>,
  ): GadgetScope {
    // Standalone Gadget Blueprint may be instantiated directly into any requested scope.
    if (requested && !gadget.workspaceKey && !gadget.taskKey) return requested;
    if (gadget.targetScopeType === "workspace") return { type: "workspace", workspaceId: workspaceIds[gadget.workspaceKey!] };
    if (gadget.targetScopeType === "task") return { type: "task", taskId: taskIds[gadget.taskKey!] };
    return requested ?? { type: "global" };
  }

  private async readRequired(id: string): Promise<BlueprintDescriptor> {
    const blueprint = await this.deps.repository.read(id);
    if (!blueprint) throw new Error(`Blueprint 不存在：${id}`);
    return blueprint;
  }

  private emitChanged(event: BlueprintChangedEvent): void {
    try { this.deps.onChanged?.(event); } catch { /* renderer projection is recoverable via list */ }
  }

  private reconcileWorkspaceInstances(): void {
    const registered = new Set(
      this.deps.db.listSpaces()
        .map((space) => space.path ? resolve(space.path).toLocaleLowerCase() : "")
        .filter(Boolean),
    );
    for (const entry of readdirSync(this.deps.workspaceInstancesRoot, { withFileTypes: true })) {
      if (!/^bp-[a-f0-9-]{36}$/i.test(entry.name)) continue;
      const target = resolve(this.deps.workspaceInstancesRoot, entry.name);
      if (!isInside(this.deps.workspaceInstancesRoot, target) || registered.has(target.toLocaleLowerCase())) continue;
      try {
        const info = lstatSync(target);
        rmSync(target, { recursive: !info.isSymbolicLink(), force: true });
      } catch (error) {
        console.warn(`[BlueprintService] 无法清理 orphan instance ${entry.name}`, error);
      }
    }
  }
}

function safeName(name: string): string {
  return name.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim() || "Workspace";
}

function isInside(root: string, target: string): boolean {
  const base = resolve(root);
  const candidate = resolve(target);
  return candidate === base || candidate.startsWith(base + sep);
}

function normalizeCapturePath(raw: string): string {
  const path = raw.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!path || path.startsWith("/") || path.split("/").some((part) => !part || part === ".." || CAPTURE_EXCLUDED.has(part)) || isBlueprintSensitivePath(path)) {
    throw new Error(`Blueprint 选择文件不在白名单：${raw}`);
  }
  return path;
}

function captureSelectedFile(
  root: string,
  relativePath: string,
  budget: { totalBytes: number },
): { path: string; content: string; encoding: "utf8" | "base64" } {
  const target = resolve(root, ...relativePath.split("/"));
  if (!isInside(root, target) || !existsSync(target)) throw new Error(`Blueprint 模板文件不存在：${relativePath}`);
  const lexicalInfo = lstatSync(target);
  if (lexicalInfo.isSymbolicLink() || !lexicalInfo.isFile()) throw new Error(`Blueprint 模板文件不得是符号链接：${relativePath}`);
  const realRoot = realpathSync(root);
  const realTarget = realpathSync(target);
  if (!isInside(realRoot, realTarget)) throw new Error(`Blueprint 模板文件越出 Workspace：${relativePath}`);
  const buffer = readFileSync(realTarget);
  if (buffer.length > BLUEPRINT_MAX_FILE_BYTES) throw new Error(`Blueprint 模板文件过大：${relativePath}`);
  budget.totalBytes += buffer.length;
  if (budget.totalBytes > BLUEPRINT_MAX_TOTAL_FILE_BYTES) throw new Error("Blueprint 模板文件总大小超过限制");
  const text = buffer.toString("utf8");
  const utf8 = Buffer.from(text, "utf8").equals(buffer);
  return { path: relativePath, content: utf8 ? redactBlueprintSecrets(text) : buffer.toString("base64"), encoding: utf8 ? "utf8" : "base64" };
}

function ensureSafeDirectory(root: string, target: string): void {
  const base = resolve(root);
  const destination = resolve(target);
  if (!isInside(base, destination)) throw new Error(`Blueprint 目录路径越界：${target}`);
  if (!existsSync(base) || lstatSync(base).isSymbolicLink()) throw new Error("Blueprint instance root 不安全");
  const realBase = realpathSync(base);
  const parts = relative(base, destination).split(/[\\/]+/).filter(Boolean);
  let cursor = base;
  for (const part of parts) {
    cursor = join(cursor, part);
    if (existsSync(cursor)) {
      const info = lstatSync(cursor);
      if (info.isSymbolicLink() || !info.isDirectory()) throw new Error(`Blueprint 目录包含符号链接或非目录节点：${cursor}`);
    } else {
      mkdirSync(cursor);
    }
    if (!isInside(realBase, realpathSync(cursor))) throw new Error(`Blueprint 目录符号链接越界：${cursor}`);
  }
}

function writeSeedFile(
  root: string,
  rawPath: string,
  content: string,
  encoding: "utf8" | "base64" | undefined,
  instanceRoot: string,
): void {
  const path = normalizeCapturePath(rawPath);
  const target = resolve(root, ...path.split("/"));
  if (!isInside(root, target)) throw new Error(`Blueprint 文件路径越界：${rawPath}`);
  if (existsSync(target)) throw new Error(`Blueprint seed 文件已存在，拒绝覆盖：${rawPath}`);
  ensureSafeDirectory(instanceRoot, dirname(target));
  const realInstanceRoot = realpathSync(instanceRoot);
  const realParent = realpathSync(dirname(target));
  if (!isInside(realInstanceRoot, realParent)) throw new Error(`Blueprint seed 文件父目录越界：${rawPath}`);
  try {
    writeFileSync(target, encoding === "base64" ? Buffer.from(content, "base64") : content);
  } catch (error) {
    try { rmSync(target, { force: true }); } catch { /* preserve original write failure */ }
    throw error;
  }
}

function hasWorkspaceGadgets(node: WorkspaceBlueprintNode): boolean {
  return Boolean(node.gadgets?.length || node.children?.some(hasWorkspaceGadgets));
}

function sanitizeBlueprintMetadata(value: Record<string, unknown>): Record<string, unknown> {
  const sanitize = (current: unknown): unknown => {
    if (Array.isArray(current)) return current.map(sanitize);
    if (typeof current === "string") {
      if (/^(?:task|sp|proj|gdt|bp|art)-[A-Za-z0-9_-]+$/i.test(current.trim())) return undefined;
      if (/^(?:[a-zA-Z]:[\\/]|\\\\|\/(?:home|Users|tmp|var|etc|opt|root)(?:\/|$))/i.test(current.trim())) return undefined;
      return current;
    }
    if (!current || typeof current !== "object") return current;
    const output: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(current as Record<string, unknown>)) {
      if (/(?:task|workspace|space|project|artifact|gadget|blueprint)(?:_?id)$|(?:source|manifest)?path$|^(?:cwd|rootDir|localRoot|home)$/i.test(key)) continue;
      const sanitized = sanitize(child);
      if (sanitized !== undefined) output[key] = sanitized;
    }
    return output;
  };
  return sanitize(value) as Record<string, unknown>;
}
