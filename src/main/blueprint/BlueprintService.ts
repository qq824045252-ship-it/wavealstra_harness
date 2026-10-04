import { randomUUID } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { AppDatabase } from "../db/AppDatabase";
import type { GadgetService } from "../gadget/GadgetService";
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
import type { GadgetScope } from "../../shared/gadget-types";
import { isBlueprintSensitivePath, redactBlueprintSecrets } from "../../shared/blueprint-secret-policy";
import type { BlueprintRepository } from "./BlueprintRepository";
import type { BlueprintResolver } from "./BlueprintResolver";
import type { BlueprintInstantiationPlanner } from "./BlueprintInstantiationPlanner";
import type { BlueprintChangedEvent } from "../../shared/blueprint-ipc";

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
    this.reconcileWorkspaceInstances();
  }

  create(request: BlueprintCreateRequest): BlueprintDescriptor {
    const created = this.deps.repository.create(request);
    this.emitChanged({ type: "created", blueprintId: created.id });
    return created;
  }

  list(): BlueprintDescriptor[] {
    return this.deps.repository.list();
  }

  get(id: string): BlueprintDescriptor | null {
    return this.deps.repository.get(id);
  }

  update(request: BlueprintUpdateRequest): BlueprintDescriptor {
    const updated = this.deps.repository.update(request);
    this.emitChanged({ type: "updated", blueprintId: updated.id });
    return updated;
  }

  resolve(id: string, registries?: BlueprintInstantiateRequest["registries"]): ResolvedBlueprint {
    return this.deps.resolver.resolve(this.require(id).definition, registries);
  }

  plan(id: string, registries?: BlueprintInstantiateRequest["registries"]): BlueprintInstantiationPlan {
    return this.deps.planner.build(this.resolve(id, registries));
  }

  async instantiate(request: BlueprintInstantiateRequest): Promise<BlueprintInstantiationResult> {
    const blueprint = this.require(request.blueprintId);
    const plan = this.deps.planner.build(this.deps.resolver.resolve(blueprint.definition, request.registries));
    const warnings = [...plan.warnings];
    const workspaceIdsByKey: Record<string, string> = {};
    const taskIdsByKey: Record<string, string> = {};
    const gadgetIdsByKey: Record<string, string> = {};
    const createdGadgets: string[] = [];
    const createdMemoryIds: string[] = [];
    const pendingContexts: Array<{ workspaceId: string; content: string }> = [];
    let generatedRoot: string | null = null;
    let rootWorkspaceId: string | null = null;

    try {
      this.deps.db.transaction(() => {
        if (plan.workspaces.length) {
          const first = plan.workspaces[0];
          const rootName = request.rootName?.trim() || first.name;
          if (rootName.length > 240) throw new Error("Blueprint instance Workspace 名称不能超过 240 字符");
          const base = resolve(this.deps.workspaceInstancesRoot, `bp-${randomUUID()}`);
          generatedRoot = base;
          mkdirSync(base, { recursive: true });
          const workspacePaths = new Set<string>();
          for (const item of plan.workspaces) {
            const parentId = item.parentKey ? workspaceIdsByKey[item.parentKey] : null;
            const name = item === first ? rootName : item.name;
            const parentPath = item.parentKey
              ? this.deps.db.getSpace(parentId!)?.path ?? base
              : dirname(base);
            const workspacePath = item === first ? base : join(parentPath, safeName(name));
            const pathKey = resolve(workspacePath).toLocaleLowerCase();
            if (workspacePaths.has(pathKey)) throw new Error(`Blueprint Workspace 目录冲突：${workspacePath}`);
            workspacePaths.add(pathKey);
            if (item !== first) ensureSafeDirectory(base, workspacePath);
            const created = this.deps.db.createSpace({ name, parentId, path: workspacePath });
            workspaceIdsByKey[item.key] = created.id;
            if (!rootWorkspaceId) rootWorkspaceId = created.id;
            if (item.defaultContext) {
              pendingContexts.push({ workspaceId: created.id, content: item.defaultContext });
            }
          }
          for (const task of plan.tasks) {
            const id = `task-${randomUUID()}`;
            taskIdsByKey[task.key] = id;
            this.deps.db.upsertTask({
              id,
              title: task.title,
              spaceId: workspaceIdsByKey[task.workspaceKey],
              status: task.status ?? "pending",
              updatedAt: Date.now(),
              ...(task.welcomeMode ? { welcomeMode: task.welcomeMode } : {}),
            });
          }
          for (const binding of plan.libraryBindings) {
            if (!this.deps.librarySpaceExists(binding.librarySpaceId)) {
              if (binding.optional === false) throw new Error(`必需资料库 ${binding.librarySpaceId} 不存在`);
              warnings.push(`资料库 ${binding.librarySpaceId} 不存在，已跳过绑定`);
              continue;
            }
            this.deps.libraryBindings.bind(workspaceIdsByKey[binding.workspaceKey], binding.librarySpaceId);
          }
          for (const context of pendingContexts) {
            const memory = this.memory.create({
              kind: "constraint",
              title: "Blueprint default context",
              content: context.content,
              scopeType: "workspace", scopeId: context.workspaceId,
              sourceType: "import", explicit: true, confidence: 1, importance: 1,
              metadata: { blueprintId: request.blueprintId, source: "blueprint-default-context" },
            });
            createdMemoryIds.push(memory.id);
          }
          for (const file of plan.files) {
            const root = this.deps.db.getSpace(workspaceIdsByKey[file.workspaceKey])?.path;
            if (!root) {
              warnings.push(`Workspace ${file.workspaceKey} 未绑定目录，文件 ${file.path} 已跳过`);
              continue;
            }
            writeSeedFile(root, file.path, file.content, file.encoding, base);
          }
        }

        for (const gadget of plan.gadgets) {
          const scope = this.resolveGadgetScope(gadget, request.gadgetScope, workspaceIdsByKey, taskIdsByKey);
          const created = this.deps.gadgetService.createFromBlueprint({
            name: gadget.name,
            description: gadget.description,
            scope,
            entry: gadget.manifest.entry,
            files: gadget.sourceFiles,
            defaultConfig: gadget.manifest.defaultConfig,
            metadata: gadget.metadata,
            blueprintId: blueprint.id,
          });
          createdGadgets.push(created.id);
          gadgetIdsByKey[gadget.key] = created.id;
        }
      });

      return { blueprintId: blueprint.id, workspaceIdsByKey, taskIdsByKey, gadgetIdsByKey, warnings, missing: plan.missing };
    } catch (error) {
      for (const id of createdGadgets.reverse()) {
        try { await this.deps.gadgetService.rollbackCreate(id); } catch { /* coordinated rollback best effort */ }
      }
      for (const id of createdMemoryIds.reverse()) {
        try { this.memory.forget(id); } catch { /* newly created L1 rollback */ }
      }
      for (const id of Object.values(taskIdsByKey)) {
        try { this.deps.db.deleteTask(id); } catch { /* newly created task rollback */ }
      }
      if (rootWorkspaceId) {
        try { this.deps.db.deleteSpaceTree(rootWorkspaceId); } catch { /* newly created tree rollback */ }
      }
      if (generatedRoot && isInside(this.deps.workspaceInstancesRoot, generatedRoot)) {
        try { rmSync(generatedRoot, { recursive: true, force: true }); }
        catch (cleanupError) { console.warn(`[BlueprintService] 无法清理失败实例目录 ${generatedRoot}`, cleanupError); }
      }
      throw error;
    }
  }

  captureDefinition(workspaceId: string, options: BlueprintCaptureOptions, confirmedDefinition?: BlueprintDefinition): BlueprintDescriptor {
    // Keep origin validation even when committing an exact preview supplied by the capture dialog.
    if (!this.deps.db.getSpace(workspaceId)) throw new Error(`工作空间不存在：${workspaceId}`);
    const definition = confirmedDefinition
      ? normalizeBlueprintDefinition(confirmedDefinition)
      : this.previewCaptureDefinition(workspaceId, options);
    return this.create({ name: options.name, description: options.description, definition });
  }

  previewCaptureDefinition(workspaceId: string, options: BlueprintCaptureOptions): BlueprintDefinition {
    const root = this.deps.db.getSpace(workspaceId);
    if (!root) throw new Error(`工作空间不存在：${workspaceId}`);
    const selected = new Map<string, string>();
    for (const item of options.selectedFiles ?? []) {
      const normalized = normalizeCapturePath(item);
      selected.set(normalized.toLocaleLowerCase(), normalized);
    }
    if (selected.size > BLUEPRINT_MAX_FILES) throw new Error(`Blueprint 选择文件不能超过 ${BLUEPRINT_MAX_FILES} 个`);
    const captureBudget = { totalBytes: 0 };
    const capturedWorkspaceIds = new Set<string>();
    let workspaceSequence = 0;
    let taskSequence = 0;
    let gadgetSequence = 0;
    const captureNode = (id: string): WorkspaceBlueprintNode => {
      if (capturedWorkspaceIds.has(id)) throw new Error(`Workspace 树存在循环或重复引用：${id}`);
      capturedWorkspaceIds.add(id);
      const workspace = this.deps.db.getSpace(id);
      if (!workspace) throw new Error(`工作空间不存在：${id}`);
      const workspaceKey = `workspace:${++workspaceSequence}`;
      const node: WorkspaceBlueprintNode = { key: workspaceKey, name: workspace.name };
      if (options.includeContext === true) {
        const manualContext = this.memory.search({
          workspaceId: id, scopeTypes: ["workspace"], includeInherited: false, statuses: ["active"], limit: 500,
        })
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
      if (options.includeTasks !== false) {
        const tasks = this.deps.db.listTasks().filter((task) => task.spaceId === id && !task.archived);
        if (tasks.length) node.tasks = tasks.map((task) => ({
          key: `task:${++taskSequence}`,
          title: task.title,
          ...(task.welcomeMode ? { welcomeMode: task.welcomeMode } : {}),
        }));
      }
      if (options.includeGadgets !== false) {
        const gadgets = this.deps.gadgetService.list({ scope: { type: "workspace", workspaceId: id } });
        if (gadgets.length) node.gadgets = gadgets.map((item) => this.gadgetDefinition(item.id, workspaceKey, `gadget:${++gadgetSequence}`));
      }
      if (id === workspaceId && selected.size && workspace.path) {
        node.files = [...selected.values()].map((path) => captureSelectedFile(workspace.path!, path, captureBudget));
      }
      if (options.includeChildren !== false) {
        const children = this.deps.db.getSpaceChildren(id).filter((space) => !space.effectiveArchived);
        if (children.length) node.children = children.map((child) => captureNode(child.id));
      }
      return node;
    };
    const workspace = captureNode(workspaceId);
    const hasGadgets = hasWorkspaceGadgets(workspace);
    const definition: BlueprintDefinition = hasGadgets
      ? { schemaVersion: BLUEPRINT_DEFINITION_SCHEMA_VERSION, kind: "composite", workspace }
      : { schemaVersion: BLUEPRINT_DEFINITION_SCHEMA_VERSION, kind: "workspace", workspace };
    return normalizeBlueprintDefinition(definition);
  }

  captureGadget(gadgetId: string, input: { name?: string; description?: string } = {}): BlueprintDescriptor {
    const captured = this.deps.gadgetService.captureSource(gadgetId);
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

  delete(id: string): void {
    if (!this.deps.repository.delete(id)) throw new Error(`Blueprint 不存在：${id}`);
    this.emitChanged({ type: "deleted", blueprintId: id });
  }

  private gadgetDefinition(id: string, workspaceKey?: string, key = "gadget:root"): BlueprintGadgetDefinition {
    const captured = this.deps.gadgetService.captureSource(id);
    return {
      key,
      name: captured.descriptor.name,
      description: captured.descriptor.description,
      manifest: captured.manifest,
      sourceFiles: captured.sourceFiles,
      metadata: sanitizeBlueprintMetadata(captured.descriptor.metadata),
      ...(workspaceKey ? { workspaceKey, scopeType: "workspace" as const } : {}),
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

  private require(id: string): BlueprintDescriptor {
    const blueprint = this.deps.repository.get(id);
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
