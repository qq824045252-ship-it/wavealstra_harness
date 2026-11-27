import { randomUUID } from "node:crypto";
import { isAbsolute } from "node:path";
import {
  ARCHIVED_PROJECT_WRITE_GUIDANCE,
  DEFAULT_PROJECT_RESOURCE_BUDGET_CHARS,
  MAX_PROJECT_RESOURCE_BUDGET_CHARS,
  MIN_PROJECT_RESOURCE_BUDGET_CHARS,
  PROJECT_MEMORY_CONTENT_MAX_CHARS,
  PROJECT_MEMORY_KINDS,
  PROJECT_MEMORY_MAX_TAGS,
  PROJECT_MEMORY_STATUSES,
  PROJECT_MEMORY_TAG_MAX_CHARS,
  PROJECT_MEMORY_TITLE_MAX_CHARS,
  PROJECT_CONTEXT_GOAL_MAX_CHARS,
  PROJECT_CONTEXT_STAGE_MAX_CHARS,
  PROJECT_REVIEW_NOTE_MAX_CHARS,
  PROJECT_TODO_TITLE_MAX_CHARS,
  emptyProjectPolicies,
  formatPlanLocalDate,
  type ProjectContextPinDto,
  type ProjectContextPinRequest,
  type ProjectContextUnpinRequest,
  type ProjectCreateRequest,
  type ProjectDetailsDto,
  type ProjectDuplicateRequest,
  type ProjectDto,
  type ProjectMemoryCreateRequest,
  type ProjectMemoryDeleteRequest,
  type ProjectMemoryEvidenceDto,
  type ProjectMemoryItemDto,
  type ProjectMemoryKind,
  type ProjectMemorySource,
  type ProjectMemoryStatus,
  type ProjectMemoryUpdateRequest,
  type ProjectNextActionDto,
  type ProjectPoliciesDto,
  type ProjectResourceCreateRequest,
  type ProjectResourceDto,
  type ProjectPostCreateRequest,
  type ProjectPostDto,
  type ProjectEventDto,
  type ProjectEventPromotedBy,
  type ProjectEventPromoteResultDto,
  type ProjectEventPromotionDto,
  type ProjectEventPromotionTargetKind,
  type ProjectEventTriageStatus,
  type ProjectReviewDto,
  type ProjectSharedContextSummary,
  type ProjectStatusIssueDto,
  type ProjectActionProposalDto,
  type ProjectStatusSnapshotDto,
  type ProjectTodoCreateRequest,
  type ProjectTodoPriority,
  type ProjectTodoDto,
  type ProjectTodoStatus,
  type ProjectTodoUpdateRequest,
  type ProjectResourceUpdateRequest,
  type ProjectUpdateRequest,
} from "../../shared/project-domain";
import { ProjectRepository, type ProjectWriteInputs, type ProjectWriteReader, type ProjectStatusFact } from "./ProjectRepository";
import type { MemoryService } from "../memory/MemoryService";
import { memoryWithdrawalTargets } from "../memory/MemoryForgetWatermarks";
import type { MemoryCreateRequest, MemoryRecordDto, MemorySearchRequest, MemoryUpdateRequest } from "../../shared/memory-kernel";
import type { ProjectMemoryEdit, ProjectMemoryProjection, ProjectMemoryWrite, ProjectMutation, ProjectWriteStatus } from "./ProjectMutation";

function statusIssue(fact: ProjectStatusFact): ProjectStatusIssueDto {
  const issue = { refId: fact.refId, title: fact.title };
  switch (fact.kind) {
    case "blockingOverdue":
      return { ...issue, source: "plan", reason: `高优先级进行中计划已逾期（截止 ${formatPlanLocalDate(fact.dueAt!)}）` };
    case "overdue":
      return { ...issue, source: "plan", reason: `计划项已逾期（截止 ${formatPlanLocalDate(fact.dueAt!)}）` };
    case "nearDue":
      return { ...issue, source: "plan", reason: `计划项 3 天内到期（截止 ${formatPlanLocalDate(fact.dueAt!)}）` };
    case "staleTask":
      return { ...issue, source: "task", reason: "任务 7 天无更新" };
    case "activeRisk":
      return { ...issue, source: "memory", reason: "项目记忆中的 active 风险" };
    case "importantQuestion":
      return { ...issue, source: "memory", reason: "高重要度待确认问题" };
  }
}

function kernelMemoryToProject(item: ProjectMemoryProjection, projectId: string): ProjectMemoryItemDto {
  const kernelKind = ["fact", "decision", "constraint", "risk", "open_question", "progress"].includes(item.kind)
    ? item.kind as ProjectMemoryKind
    : "fact";
  const kernelStatus = item.status === "invalid" ? "superseded" : item.status as ProjectMemoryStatus;
  const tags = Array.isArray(item.metadata.tags) ? item.metadata.tags.filter((x): x is string => typeof x === "string") : [];
  const evidence = item.evidence.flatMap((ev): ProjectMemoryEvidenceDto[] => {
    const kind = ev.evidenceKind === "library_item" || ev.evidenceKind === "library_chunk"
      ? "library"
      : ev.evidenceKind === "project_event"
        ? "event"
        : ev.evidenceKind === "artifact"
          ? "artifact"
          : ev.evidenceKind === "task"
            ? "task"
            : null;
    if (!kind) return [];
    return [{ id: ev.id, memoryId: item.id, evidenceKind: kind, refId: ev.refId, refTitle: ev.refTitle ?? undefined, createdAt: ev.createdAt }];
  });
  return {
    id: item.id,
    projectId,
    kind: kernelKind,
    title: item.title,
    content: item.content,
    status: kernelStatus,
    tags,
    importance: item.importance,
    sourceType: item.sourceType === "agent" ? "agent" : "manual",
    sourceTaskId: item.sourceTaskId ?? undefined,
    evidence,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

function normalizeList(values: string[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of values ?? []) {
    const id = value.trim();
    const key = id.toLowerCase();
    if (!id || seen.has(key)) continue;
    seen.add(key);
    out.push(id);
  }
  return out;
}

function withoutClaimed(values: string[], claimed: Set<string>): string[] {
  return values.filter((value) => {
    const key = value.toLowerCase();
    if (claimed.has(key)) return false;
    claimed.add(key);
    return true;
  });
}

function normalizePolicies(input?: Partial<ProjectPoliciesDto>, base = emptyProjectPolicies()): ProjectPoliciesDto {
  const expertClaimed = new Set<string>();
  const expertDeny = withoutClaimed(normalizeList(input?.expert?.deny ?? base.expert.deny), expertClaimed);
  const expertAllow = withoutClaimed(normalizeList(input?.expert?.allow ?? base.expert.allow), expertClaimed);
  const expertRecommended = withoutClaimed(normalizeList(input?.expert?.recommended ?? base.expert.recommended), expertClaimed);
  const skillClaimed = new Set<string>();
  const skillHide = withoutClaimed(normalizeList(input?.skill?.hide ?? base.skill.hide), skillClaimed);
  const skillAllow = withoutClaimed(normalizeList(input?.skill?.allow ?? base.skill.allow), skillClaimed);
  const skillPrefer = withoutClaimed(normalizeList(input?.skill?.prefer ?? base.skill.prefer), skillClaimed);
  const skillDemote = withoutClaimed(normalizeList(input?.skill?.demote ?? base.skill.demote), skillClaimed);
  const connectorClaimed = new Set<string>();
  const connectorDeny = withoutClaimed(normalizeList(input?.connector?.deny ?? base.connector.deny), connectorClaimed);
  const connectorAllow = withoutClaimed(normalizeList(input?.connector?.allow ?? base.connector.allow), connectorClaimed);
  const connectorRecommended = withoutClaimed(normalizeList(input?.connector?.recommended ?? base.connector.recommended), connectorClaimed);
  const mcpClaimed = new Set<string>();
  const mcpDeny = withoutClaimed(normalizeList(input?.mcp?.deny ?? base.mcp.deny), mcpClaimed);
  const mcpAllow = withoutClaimed(normalizeList(input?.mcp?.allow ?? base.mcp.allow), mcpClaimed);
  return {
    expert: {
      allow: expertAllow,
      deny: expertDeny,
      recommended: expertRecommended,
    },
    skill: {
      prefer: skillPrefer,
      demote: skillDemote,
      hide: skillHide,
      allow: skillAllow,
    },
    connector: {
      allow: connectorAllow,
      deny: connectorDeny,
      recommended: connectorRecommended,
    },
    mcp: {
      mode: input?.mcp?.mode === "soft" ? "soft" : input?.mcp?.mode === "hard" ? "hard" : base.mcp.mode,
      allow: mcpAllow,
      deny: mcpDeny,
    },
  };
}

function cleanOptional(value: string | null | undefined): string | undefined {
  const cleaned = value?.trim();
  return cleaned || undefined;
}

function normalizeResourceBudget(value: number | undefined, fallback = DEFAULT_PROJECT_RESOURCE_BUDGET_CHARS): number {
  if (value === undefined) return fallback;
  if (!Number.isFinite(value)) throw new Error("Project Resource 预算必须是数字");
  const rounded = Math.round(value);
  if (rounded < MIN_PROJECT_RESOURCE_BUDGET_CHARS || rounded > MAX_PROJECT_RESOURCE_BUDGET_CHARS) {
    throw new Error(`Project Resource 预算必须在 ${MIN_PROJECT_RESOURCE_BUDGET_CHARS} 到 ${MAX_PROJECT_RESOURCE_BUDGET_CHARS} 字符之间`);
  }
  return rounded;
}

function validateResourceValue(kind: ProjectResourceDto["kind"], rawTitle: string, rawValue: string): {
  title: string;
  value: string;
} {
  const title = rawTitle.trim();
  const value = kind === "text" ? rawValue : rawValue.trim();
  if (!title) throw new Error("资源名称不能为空");
  if (kind === "folder") return { title, value: value || title };
  if (!value.trim()) throw new Error("资源内容不能为空");
  if (kind === "file") {
    if (!isAbsolute(value)) throw new Error("文件资源必须使用绝对路径");
    if (value.length > 4096) throw new Error("文件路径过长");
  }
  if (kind === "url") {
    let url: URL;
    try { url = new URL(value); } catch { throw new Error("URL 格式无效"); }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("URL 资源仅支持 http(s)");
  }
  return { title, value };
}

function orderResourcesForInsert(resources: readonly ProjectResourceDto[]): ProjectResourceDto[] {
  const byId = new Map(resources.map((resource) => [resource.id, resource]));
  const ordered: ProjectResourceDto[] = [];
  const seen = new Set<string>();
  const visit = (resource: ProjectResourceDto): void => {
    if (seen.has(resource.id)) return;
    if (resource.parentId) {
      const parent = byId.get(resource.parentId);
      if (parent) visit(parent);
    }
    seen.add(resource.id);
    ordered.push(resource);
  };
  for (const resource of resources) visit(resource);
  return ordered;
}

function resolveResourceParent(
  resources: readonly ProjectResourceDto[],
  parentId?: string | null,
  selfId?: string,
): string | undefined {
  const id = parentId?.trim();
  if (!id) return undefined;
  if (selfId && id === selfId) throw new Error("不能把资料放进自己");
  const parent = resources.find((resource) => resource.id === id);
  if (!parent) throw new Error("文件夹不存在");
  if (parent.kind !== "folder") throw new Error("只能放进文件夹");
  let cursor = parent.parentId;
  const seen = new Set<string>([id]);
  while (cursor) {
    if (selfId && cursor === selfId) throw new Error("不能把文件夹放进自己的子目录");
    if (seen.has(cursor)) break;
    seen.add(cursor);
    cursor = resources.find((resource) => resource.id === cursor)?.parentId;
  }
  return id;
}

type PreparedProjectWrite<T> = { mutation: ProjectMutation; result: () => T | Promise<T> } | { unchanged: T };
type ProjectWriteActor = { taskId: string; projectId: string };
const SHARED_MEMORY_EDIT_GUIDANCE = "该记忆已共享到其他作用域，不能从项目页直接修改；请在统一记忆治理中修订";

function todoWriteValues({ tags, ...todo }: ProjectTodoDto) {
  return { ...todo, tagsJson: JSON.stringify(tags) };
}

function memoryWriteValues({ id, kind, title, content, status, importance, confidence, explicit, sourceType,
  sourceTaskId, contentHash, createdAt, evidence, metadata }: MemoryRecordDto): ProjectMemoryWrite {
  return { id, kind, title, content, status, importance, confidence, explicit, sourceType, sourceTaskId,
    contentHash, createdAt, evidence, metadataJson: JSON.stringify(metadata),
    scopeRowId: randomUUID(), revisionId: randomUUID() };
}

function memoryEditValues({ id, kind, title, content, status, importance,
  contentHash, updatedAt, metadata }: MemoryRecordDto, expectedRevision: number): ProjectMemoryEdit {
  return { id, kind, title, content, status, importance,
    contentHash, updatedAt, metadataJson: JSON.stringify(metadata), expectedRevision, revisionId: randomUUID() };
}

function assertProjectMemoryWritten(status: ProjectWriteStatus, projectId: string, eventId?: string): void {
  if (status === "changed") return;
  if (status === "scopeChanged") throw new Error("任务的项目归属已变化，请重新读取");
  if (status === "archived") throw new Error(ARCHIVED_PROJECT_WRITE_GUIDANCE);
  if (status === "missingEvent") throw new Error(`事件不存在：${eventId}`);
  if (status === "missing") throw new Error(`项目不存在：${projectId}`);
  if (status === "invalidEvidence") throw new Error("记忆证据已删除或项目归属已变化，请重新选择");
  if (status === "missingMemory") throw new Error("记忆条目不存在");
  if (status === "sharedMemory") throw new Error(SHARED_MEMORY_EDIT_GUIDANCE);
  throw new Error("项目记忆写入失败");
}

export class ProjectService {
  constructor(
    private readonly repository: ProjectRepository,
    private readonly memoryService: MemoryService,
    private readonly onPlanChanged?: (projectId: string) => void,
  ) {}

  private requireProject(projectId: string, reader: ProjectWriteReader = this.repository): ProjectDetailsDto {
    const project = reader.get(projectId);
    if (!project) throw new Error(`项目不存在：${projectId}`);
    return project;
  }

  private requireWritableProject(projectId: string, reader: ProjectWriteReader = this.repository): ProjectDetailsDto {
    const project = this.requireProject(projectId, reader);
    if (project.archived) throw new Error(ARCHIVED_PROJECT_WRITE_GUIDANCE);
    return project;
  }

  list(includeArchived = false): ProjectDto[] {
    return this.repository.list(includeArchived);
  }

  readList(includeArchived = false): Promise<ProjectDto[]> {
    return this.repository.readList(includeArchived);
  }

  get(id: string): ProjectDetailsDto | undefined {
    return this.repository.get(id);
  }

  readDetails(id: string): Promise<ProjectDetailsDto | undefined> { return this.repository.readDetails(id); }

  private async readSavedProject(id: string): Promise<ProjectDetailsDto> {
    const project = await this.readDetails(id);
    if (!project) throw new Error(`项目不存在：${id}`);
    return project;
  }

  create(request: ProjectCreateRequest): ProjectDetailsDto {
    const { project, policies } = this.prepareCreate(request);
    return this.repository.create(project, policies);
  }

  createAsync(request: ProjectCreateRequest): Promise<ProjectDetailsDto> {
    return this.commitProjectWrite(() => this.create(request), { names: true }, reader => {
      const { project, policies } = this.prepareCreate(request, reader);
      return {
        mutation: { kind: "create", project, policiesJson: JSON.stringify(policies), resources: [] },
        result: () => ({ ...project, policies, resources: [] }),
      };
    });
  }

  private prepareCreate(request: ProjectCreateRequest, reader: ProjectWriteReader = this.repository) {
    const name = request.name.trim();
    if (!name) throw new Error("项目名称不能为空");
    if (reader.findByName(name)) throw new Error(`项目名称已存在：${name}`);
    const now = Date.now();
    const project: ProjectDto = {
      id: `proj_${randomUUID()}`,
      name,
      description: cleanOptional(request.description),
      instructions: cleanOptional(request.instructions),
      goal: cleanOptional(request.goal),
      currentStage: cleanOptional(request.currentStage),
      templateId: cleanOptional(request.templateId),
      createdAt: now,
      updatedAt: now,
      archived: false,
      resourceBudgetChars: normalizeResourceBudget(request.resourceBudgetChars),
    };
    return { project, policies: normalizePolicies(request.policies) };
  }

  update(request: ProjectUpdateRequest): ProjectDetailsDto {
    const { project, policies } = this.prepareUpdate(request);
    return this.repository.update(project, policies);
  }

  updateAsync(request: ProjectUpdateRequest): Promise<ProjectDetailsDto> {
    return this.commitProjectWrite(() => this.update(request), { projectId: request.id, spaceId: request.defaultSpaceId ?? undefined, names: true }, reader => {
      const { project, policies, defaultSpacePath, expectedUpdatedAt } = this.prepareUpdate(request, reader);
      return {
        mutation: { kind: "edit", project, expectedUpdatedAt, defaultSpacePath, policiesJson: policies ? JSON.stringify(policies) : undefined },
        result: () => this.readSavedProject(project.id),
      };
    });
  }

  private prepareUpdate(request: ProjectUpdateRequest, reader: ProjectWriteReader = this.repository) {
    const current = this.requireWritableProject(request.id, reader);
    const name = request.name === undefined ? current.name : request.name.trim();
    if (!name) throw new Error("项目名称不能为空");
    const duplicate = reader.findByName(name);
    if (duplicate && duplicate.id !== request.id) throw new Error(`项目名称已存在：${name}`);
    const defaultSpacePath = request.defaultSpaceId == null ? undefined : reader.validatedDefaultSpacePath(request.defaultSpaceId);
    const project: ProjectDto = {
      ...current,
      defaultSpaceId: request.defaultSpaceId === undefined ? current.defaultSpaceId : request.defaultSpaceId ?? undefined,
      name,
      description:
        request.description === undefined ? current.description : cleanOptional(request.description),
      instructions:
        request.instructions === undefined ? current.instructions : cleanOptional(request.instructions),
      goal: request.goal === undefined ? current.goal : cleanOptional(request.goal),
      currentStage:
        request.currentStage === undefined ? current.currentStage : cleanOptional(request.currentStage),
      updatedAt: Math.max(Date.now(), current.updatedAt + 1),
      resourceBudgetChars: normalizeResourceBudget(request.resourceBudgetChars, current.resourceBudgetChars),
    };
    const policies = request.policies ? normalizePolicies(request.policies, current.policies) : undefined;
    return { project, policies, defaultSpacePath, expectedUpdatedAt: current.updatedAt };
  }

  duplicate(request: ProjectDuplicateRequest): ProjectDetailsDto {
    const { project, policies, resources } = this.prepareDuplicate(request);
    return this.repository.createWithResources(project, policies, resources);
  }

  duplicateAsync(request: ProjectDuplicateRequest): Promise<ProjectDetailsDto> {
    return this.commitProjectWrite(() => this.duplicate(request), { projectId: request.sourceId, names: true }, reader => {
      const { project, policies, resources, source } = this.prepareDuplicate(request, reader);
      return {
        mutation: { kind: "create", project, policiesJson: JSON.stringify(policies), resources, source },
        result: () => ({ ...project, policies, resources }),
      };
    });
  }

  private prepareDuplicate(request: ProjectDuplicateRequest, reader: ProjectWriteReader = this.repository) {
    const source = reader.get(request.sourceId);
    if (!source) throw new Error(`项目不存在：${request.sourceId}`);
    const requestedName = request.name?.trim();
    let name = requestedName || `${source.name} 副本`;
    if (!requestedName) {
      let suffix = 2;
      while (reader.findByName(name)) name = `${source.name} 副本 ${suffix++}`;
    } else if (reader.findByName(name)) {
      throw new Error(`项目名称已存在：${name}`);
    }
    const now = Date.now();
    const project: ProjectDto = {
      id: `proj_${randomUUID()}`,
      name,
      description: source.description,
      instructions: source.instructions,
      goal: source.goal,
      templateId: source.templateId,
      createdAt: now,
      updatedAt: now,
      archived: false,
      resourceBudgetChars: source.resourceBudgetChars,
    };
    const idMap = new Map(source.resources.map((resource) => [resource.id, `pres_${randomUUID()}`]));
    const remapped: ProjectResourceDto[] = source.resources.map((resource, index) => ({
      ...resource,
      id: idMap.get(resource.id) ?? `pres_${randomUUID()}`,
      projectId: project.id,
      parentId: resource.parentId ? idMap.get(resource.parentId) : undefined,
      createdAt: now + index,
      updatedAt: now + index,
    }));
    const resources = orderResourcesForInsert(remapped);
    return { project, policies: normalizePolicies(source.policies), resources, source: { id: source.id, updatedAt: source.updatedAt } };
  }

  archive(id: string, archived: boolean): ProjectDetailsDto {
    const current = this.requireProject(id);
    const project = this.repository.archive(
      id,
      archived,
      Math.max(Date.now(), current.updatedAt + 1),
    );
    if (!project) throw new Error(`项目不存在：${id}`);
    return project;
  }

  async archiveAsync(id: string, archived: boolean): Promise<ProjectDetailsDto> {
    if (!await this.repository.supportsNativeWrites("project")) {
      if (this.repository.requiresRustWrites) throw new Error("项目数据库当前仅允许 Rust 核心写入");
      return this.archive(id, archived);
    }
    const status = await this.repository.writeProject({ kind: "archive", id, archived, updatedAt: Date.now() });
    if (status === "missing") throw new Error(`项目不存在：${id}`);
    if (status !== "changed") throw new Error("Core 未确认归档状态");
    return this.readSavedProject(id);
  }

  delete(id: string): void {
    this.memoryService.detachAllInScope("project", id);
    this.repository.delete(id);
  }

  createResource(request: ProjectResourceCreateRequest): ProjectResourceDto {
    return this.repository.createResource(this.prepareResourceCreate(request).resource);
  }

  createResourceAsync(request: ProjectResourceCreateRequest): Promise<ProjectResourceDto> {
    return this.commitProjectWrite(() => this.createResource(request), { projectId: request.projectId }, reader => {
      const { resource, expectedUpdatedAt } = this.prepareResourceCreate(request, reader);
      return { mutation: { kind: "saveResource", resource, expectedUpdatedAt, create: true }, result: () => resource };
    });
  }

  private prepareResourceCreate(request: ProjectResourceCreateRequest, reader: ProjectWriteReader = this.repository) {
    const project = this.requireWritableProject(request.projectId, reader);
    const { title, value } = validateResourceValue(request.kind, request.title, request.value);
    const parentId = resolveResourceParent(project.resources, request.parentId);
    const now = Math.max(Date.now(), project.updatedAt + 1);
    const resource: ProjectResourceDto = {
      id: `pres_${randomUUID()}`,
      projectId: project.id,
      kind: request.kind,
      title,
      value,
      enabled: true,
      sortOrder: project.resources.reduce((max, resource) => Math.max(max, resource.sortOrder), -1) + 1,
      parentId,
      createdAt: now,
      updatedAt: now,
    };
    return { resource, expectedUpdatedAt: project.updatedAt };
  }

  updateResource(request: ProjectResourceUpdateRequest): ProjectResourceDto {
    return this.repository.updateResource(this.prepareResourceUpdate(request).resource);
  }

  updateResourceAsync(request: ProjectResourceUpdateRequest): Promise<ProjectResourceDto> {
    return this.commitProjectWrite(() => this.updateResource(request), { resourceId: request.id }, reader => {
      const { resource, expectedUpdatedAt } = this.prepareResourceUpdate(request, reader);
      return { mutation: { kind: "saveResource", resource, expectedUpdatedAt, create: false }, result: () => resource };
    });
  }

  private prepareResourceUpdate(request: ProjectResourceUpdateRequest, reader: ProjectWriteReader = this.repository) {
    const current = reader.getResource(request.id);
    if (!current) throw new Error(`项目资源不存在：${request.id}`);
    const project = this.requireWritableProject(current.projectId, reader);
    const { title, value } = validateResourceValue(
      current.kind,
      request.title ?? current.title,
      request.value ?? current.value,
    );
    const parentId = request.parentId === undefined
      ? current.parentId
      : resolveResourceParent(project.resources, request.parentId, current.id);
    const updatedAt = Math.max(Date.now(), current.updatedAt + 1, project.updatedAt + 1);
    const sortOrder = request.sortOrder === undefined ? current.sortOrder : Math.max(0, Math.round(request.sortOrder));
    if (!Number.isSafeInteger(sortOrder)) throw new Error("资料排序无效");
    const resource: ProjectResourceDto = {
      ...current,
      title,
      value,
      enabled: request.enabled ?? current.enabled,
      sortOrder,
      parentId,
      updatedAt,
    };
    return { resource, expectedUpdatedAt: project.updatedAt };
  }

  deleteResource(id: string): void {
    const current = this.repository.getResource(id);
    if (!current) return;
    const project = this.requireWritableProject(current.projectId);
    const updatedAt = Math.max(Date.now(), (project?.updatedAt ?? current.updatedAt) + 1);
    this.repository.deleteResource(id, current.projectId, updatedAt);
  }

  deleteResourceAsync(id: string): Promise<void> {
    return this.commitProjectWrite(() => this.deleteResource(id), { resourceId: id }, reader => {
      const resource = reader.getResource(id);
      if (!resource) return { unchanged: undefined };
      const project = this.requireWritableProject(resource.projectId, reader);
      return {
        mutation: { kind: "deleteResource", id, projectId: project.id, expectedUpdatedAt: project.updatedAt,
          updatedAt: Math.max(Date.now(), project.updatedAt + 1) },
        result: () => undefined,
      };
    });
  }

  private async commitProjectWrite<T>(fallback: () => T, input: ProjectWriteInputs, prepare: (reader: ProjectWriteReader) => PreparedProjectWrite<T>, domain: "project" | "todo" = "project"): Promise<T> {
    if (!await this.repository.supportsNativeWrites(domain)) {
      if (this.repository.requiresRustWrites) throw new Error("项目数据库当前仅允许 Rust 核心写入");
      return fallback();
    }
    // Rebuild the patch against a fresh project and resources if another write wins first.
    for (let attempt = 0; attempt < 8; attempt++) {
      const prepared = prepare(await this.repository.readWriteContext(input));
      if ("unchanged" in prepared) return prepared.unchanged;
      const status = await this.repository.writeProject(prepared.mutation);
      switch (status) {
        case "changed": return prepared.result();
        case "archived": throw new Error(ARCHIVED_PROJECT_WRITE_GUIDANCE);
        case "invalidSpace": throw new Error("项目文件夹已移动、归档或解除关联，请重新选择");
        case "invalidParent": throw new Error("资料的目标文件夹已变化，请刷新后重试");
        case "scopeChanged": throw new Error("任务的项目归属已变化，请重新读取");
        case "missingEvent": case "existingPromotion": throw new Error("项目写入返回了意外状态");
        case "stale": case "missing": case "nameTaken": break;
      }
    }
    throw new Error("项目正在被其他操作修改，请刷新后重试");
  }

  async listPosts(projectId: string): Promise<ProjectPostDto[]> {
    const result = await this.repository.requestProjectPosts({ kind: "list", projectId });
    if (result?.status === "listed") return result.posts;
    if (result?.status === "rejected") throw new Error(result.message);
    return this.repository.readWriteSnapshot(() => {
      if (!this.repository.getSummary(projectId)) throw new Error(`项目不存在：${projectId}`);
      return this.repository.listPosts(projectId);
    });
  }

  async createPost(request: ProjectPostCreateRequest): Promise<ProjectPostDto> {
    const post = {
      id: `ppost_${randomUUID()}`,
      projectId: request.projectId,
      body: typeof request.body === "string" ? request.body.trim() : request.body,
      createdAt: Date.now(),
    };
    const result = await this.repository.requestProjectPosts({ kind: "create", post });
    if (result?.status === "needsHost") return this.repository.commitWriteOnHost(() => {
      const project = this.requireWritableProjectSummary(post.projectId);
      if (!request.body.trim()) throw new Error("留言不能为空");
      return this.repository.createPost({ ...post, projectId: project.id });
    });
    if (result?.status === "saved" || (!result && this.repository.getPost(post.id))) return post;
    if (result?.status === "archived") throw new Error(ARCHIVED_PROJECT_WRITE_GUIDANCE);
    if (result?.status === "rejected") throw new Error(result.message);
    throw new Error("留言保存未确认，请刷新后重试");
  }

  async deletePost(id: string): Promise<void> {
    const result = await this.repository.requestProjectPosts({ kind: "delete", id });
    if (result?.status === "needsHost") return this.repository.commitWriteOnHost(() => {
      const post = this.repository.getPost(id);
      if (!post) return;
      this.requireWritableProjectSummary(post.projectId);
      this.repository.deletePost(id);
    });
    if (result?.status === "saved" || (!result && !this.repository.getPost(id))) return;
    if (result?.status === "archived") throw new Error(ARCHIVED_PROJECT_WRITE_GUIDANCE);
    if (result?.status === "rejected") throw new Error(result.message);
    throw new Error("留言删除未确认，请刷新后重试");
  }

  /* ---------------- Project Events（外部输入审计层；非业务真源） ---------------- */

  /** 事件列表（created_at DESC；limit 有界；含提升审计链接） */
  listProjectEvents(projectId: string, limit = 50): ProjectEventDto[] {
    if (!this.repository.get(projectId)) throw new Error(`项目不存在：${projectId}`);
    return this.repository.listProjectEvents(projectId, limit);
  }

  async readProjectEvents(projectId: string, limit?: number): Promise<ProjectEventDto[]> {
    const events = await this.repository.readProjectEvents(projectId, limit);
    if (!events) throw new Error(`项目不存在：${projectId}`);
    return events;
  }

  /** 按 id 读取事件（作用域校验由调用方按 event.projectId 执行） */
  getProjectEvent(eventId: string): ProjectEventDto | undefined {
    return this.repository.getProjectEventById(eventId);
  }

  writeDocumentEvent(input: import("./ProjectRepository").DocumentEventInput) {
    return this.repository.writeDocumentEvent(input);
  }

  readProjectEvent(eventId: string): Promise<ProjectEventDto | undefined> {
    return this.repository.readProjectEventById(eventId);
  }

  /** triage 状态（工作流元数据，不参与派生）：dismiss = 标记已处理（幂等）；reopen 恢复待判断 */
  private setEventTriage(projectId: string, eventId: string, status: ProjectEventTriageStatus): ProjectEventDto {
    this.requireWritableProject(projectId);
    const ok = this.repository.setProjectEventTriage(projectId, eventId, status);
    if (!ok) throw new Error(`事件不存在或不属于该项目：${eventId}`);
    return this.repository.getProjectEventById(eventId)!;
  }

  dismissProjectEvent(projectId: string, eventId: string): ProjectEventDto {
    return this.setEventTriage(projectId, eventId, "dismissed");
  }

  reopenProjectEvent(projectId: string, eventId: string): ProjectEventDto {
    return this.setEventTriage(projectId, eventId, "open");
  }

  async writeProjectEventTriage(projectId: string, eventId: string, status: ProjectEventTriageStatus): Promise<ProjectEventDto> {
    const reply = await this.repository.writeProjectEventTriage(projectId, eventId, status);
    if (typeof reply === "object") return reply;
    if (reply === "needsHost") {
      return this.repository.commitWriteOnHost(() => this.setEventTriage(projectId, eventId, status));
    }
    if (reply === "missingProject") throw new Error(`项目不存在：${projectId}`);
    if (reply === "missingEvent") throw new Error(`事件不存在或不属于该项目：${eventId}`);
    if (reply === "archived") throw new Error(ARCHIVED_PROJECT_WRITE_GUIDANCE);
    throw new Error("事件处理状态未确认，请刷新后重试");
  }

  /** ingest 落库（校验在 ProjectEventIngestor；此处为薄透传） */
  insertProjectEvent(event: ProjectEventDto): ProjectEventDto {
    this.requireWritableProject(event.projectId);
    return this.repository.insertProjectEvent(event);
  }

  /** 同 (project, source, ref) 幂等查找（ingest 去重用） */
  findProjectEventByRef(projectId: string, source: string, ref: string): ProjectEventDto | undefined {
    return this.repository.findProjectEventByRef(projectId, source, ref);
  }

  /** 提升审计链接：幂等插入（UNIQUE 冲突返回已存在） */
  insertProjectEventPromotion(promotion: ProjectEventPromotionDto): ProjectEventPromotionDto {
    this.requireWritableProject(promotion.projectId);
    return this.repository.insertProjectEventPromotion(promotion);
  }

  readEventPromotion(projectId: string, eventId: string, targetKind: ProjectEventPromotionTargetKind) {
    return this.repository.readEventPromotion(projectId, eventId, targetKind);
  }

  findProjectEventPromotion(
    projectId: string,
    eventId: string,
    targetKind: ProjectEventPromotionTargetKind,
  ): ProjectEventPromotionDto | undefined {
    return this.repository.findProjectEventPromotion(projectId, eventId, targetKind);
  }

  /** 按名称精确解析项目（projects.name 唯一；gateway 投递指令用） */
  resolveProjectByName(name: string): ProjectDto | undefined {
    const target = name.trim();
    if (!target) return undefined;
    return this.repository.list(true).find((project) => project.name === target);
  }

  listTodos(projectId: string): ProjectTodoDto[] {
    if (!this.repository.get(projectId)) throw new Error(`项目不存在：${projectId}`);
    return this.repository.listTodos(projectId);
  }

  async readTodos(projectId: string): Promise<ProjectTodoDto[]> {
    const todos = await this.repository.readTodos(projectId);
    if (!todos) throw new Error(`项目不存在：${projectId}`);
    return todos;
  }

  getTodo(id: string): ProjectTodoDto | undefined {
    return this.repository.getTodo(id);
  }

  readTodo(id: string): Promise<ProjectTodoDto | undefined> { return this.repository.readTodo(id); }

  readNextCadenceBoundary(projectId: string, now: number): Promise<number | null | undefined> | undefined {
    return this.repository.readNextCadenceBoundary(projectId, now);
  }

  private assertProjectActor(projectId: string, actor?: ProjectWriteActor, reader: ProjectWriteReader = this.repository): void {
    if (actor && (actor.projectId !== projectId || !reader.isTaskInProject(actor.taskId, projectId))) {
      throw new Error("任务的项目归属已变化，请重新读取");
    }
  }

  private requireWritableProjectSummary(projectId: string, actor?: ProjectWriteActor, reader: ProjectWriteReader = this.repository): ProjectDto {
    this.assertProjectActor(projectId, actor, reader);
    const project = reader.getSummary(projectId);
    if (!project) throw new Error(`项目不存在：${projectId}`);
    if (project.archived) throw new Error(ARCHIVED_PROJECT_WRITE_GUIDANCE);
    return project;
  }

  private publishPlanChange(projectId: string): void {
    try { this.onPlanChanged?.(projectId); }
    catch (error) { console.warn("[ProjectService] plan refresh failed", error); }
  }

  createTodo(request: ProjectTodoCreateRequest): ProjectTodoDto {
    return this.repository.createTodo(this.prepareTodoCreate(request));
  }

  createTodoAsync(request: ProjectTodoCreateRequest, actor?: ProjectWriteActor): Promise<ProjectTodoDto> {
    const finish = (todo: ProjectTodoDto) => { this.publishPlanChange(todo.projectId); return todo; };
    return this.commitProjectWrite(() => finish(this.repository.createTodo(this.prepareTodoCreate(request, actor))), { projectId: request.projectId, taskId: actor?.taskId }, reader => {
      const todo = this.prepareTodoCreate(request, actor, reader);
      return {
        mutation: { kind: "saveTodo", todo: todoWriteValues(todo), sourceTaskId: actor?.taskId },
        result: () => finish(todo),
      };
    }, "todo");
  }

  private prepareTodoCreate(request: ProjectTodoCreateRequest, actor?: ProjectWriteActor, reader: ProjectWriteReader = this.repository): ProjectTodoDto {
    const project = this.requireWritableProjectSummary(request.projectId, actor, reader);
    const title = normalizeTodoTitle(request.title);
    const now = Date.now();
    return {
      id: `ptodo_${randomUUID()}`,
      projectId: project.id,
      title,
      description: cleanOptional(request.description),
      status: parseTodoStatus(request.status),
      assignee: cleanOptional(request.assignee),
      priority: request.priority,
      tags: (request.tags ?? []).map((tag) => tag.trim()).filter(Boolean),
      startAt: request.startAt,
      dueAt: request.dueAt,
      createdAt: now,
      updatedAt: now,
    };
  }

  updateTodo(request: ProjectTodoUpdateRequest): ProjectTodoDto {
    const { todo, unchanged } = this.prepareTodoUpdate(request);
    return unchanged ? todo : this.repository.updateTodo(todo);
  }

  updateTodoAsync(request: ProjectTodoUpdateRequest, actor?: ProjectWriteActor): Promise<ProjectTodoDto> {
    const finish = (todo: ProjectTodoDto) => { this.publishPlanChange(todo.projectId); return todo; };
    return this.commitProjectWrite<ProjectTodoDto>(() => {
      const { todo, unchanged } = this.prepareTodoUpdate(request, actor);
      return unchanged ? todo : finish(this.repository.updateTodo(todo));
    }, { todoId: request.id, taskId: actor?.taskId }, reader => {
      const { todo, unchanged, expectedUpdatedAt } = this.prepareTodoUpdate(request, actor, reader);
      if (unchanged) return { unchanged: todo };
      return {
        mutation: { kind: "saveTodo", todo: todoWriteValues(todo), expectedUpdatedAt, sourceTaskId: actor?.taskId },
        result: () => finish(todo),
      };
    }, "todo");
  }

  private prepareTodoUpdate(request: ProjectTodoUpdateRequest, actor?: ProjectWriteActor, reader: ProjectWriteReader = this.repository) {
    const current = reader.getTodo(request.id);
    if (!current) throw new Error("待办不存在");
    this.requireWritableProjectSummary(current.projectId, actor, reader);
    const title = request.title === undefined ? current.title : normalizeTodoTitle(request.title);
    // 规范化后的目标值（不设新 updatedAt）：与现值完全一致时判定为 no-op，
    // 不写 DB、不 bump projects.updated_at / ProjectContext version。
    const next: ProjectTodoDto = {
      ...current,
      title,
      description: request.description === undefined ? current.description : cleanOptional(request.description ?? undefined),
      status: request.status ?? current.status,
      assignee: request.assignee === undefined ? current.assignee : cleanOptional(request.assignee ?? undefined),
      priority: request.priority === undefined ? current.priority : (request.priority ?? undefined),
      tags: request.tags ?? current.tags,
      startAt: request.startAt === undefined ? current.startAt : (request.startAt ?? undefined),
      dueAt: request.dueAt === undefined ? current.dueAt : (request.dueAt ?? undefined),
      updatedAt: current.updatedAt,
    };
    const unchanged =
      next.title === current.title &&
      next.description === current.description &&
      next.status === current.status &&
      next.assignee === current.assignee &&
      next.priority === current.priority &&
      JSON.stringify(next.tags) === JSON.stringify(current.tags) &&
      next.startAt === current.startAt &&
      next.dueAt === current.dueAt;
    const todo = unchanged ? current : { ...next, updatedAt: Math.max(Date.now(), current.updatedAt + 1) };
    return { todo, unchanged, expectedUpdatedAt: current.updatedAt };
  }

  deleteTodo(id: string): void {
    const current = this.repository.getTodo(id);
    if (!current) return;
    this.requireWritableProjectSummary(current.projectId);
    this.repository.deleteTodo(id);
  }

  deleteTodoAsync(id: string): Promise<void> {
    return this.commitProjectWrite(() => {
      const todo = this.repository.getTodo(id);
      if (!todo) return;
      this.requireWritableProjectSummary(todo.projectId);
      this.repository.deleteTodo(id);
      this.publishPlanChange(todo.projectId);
    }, { todoId: id }, reader => {
      const todo = reader.getTodo(id);
      if (!todo) return { unchanged: undefined };
      this.requireWritableProjectSummary(todo.projectId, undefined, reader);
      return {
        mutation: { kind: "deleteTodo", id, projectId: todo.projectId, updatedAt: Date.now() },
        result: () => this.publishPlanChange(todo.projectId),
      };
    }, "todo");
  }

  async promoteEventToTodo(
    event: ProjectEventDto,
    request: Omit<ProjectTodoCreateRequest, "projectId">,
    promotedBy: ProjectEventPromotedBy,
    createdAt: number,
    actor?: ProjectWriteActor,
  ): Promise<ProjectEventPromoteResultDto> {
    const projectId = event.projectId;
    this.requireWritableProjectSummary(projectId, actor);
    const current = this.repository.findProjectEventPromotion(projectId, event.id, "todo");
    if (current) return this.todoPromotionResult(current, true);
    if (!request.title.trim()) throw new Error("提升为计划项必须显式指定标题");

    const native = await this.repository.supportsNativeWrites("eventTodoPromotion");
    if (!native && this.repository.requiresRustWrites) throw new Error("项目事件提升为计划项仅允许通过 Rust 核心写入");
    const todo = this.prepareTodoCreate({ ...request, projectId }, actor);
    const draft: ProjectEventPromotionDto = {
      id: `pepr_${randomUUID()}`, projectId, eventId: event.id, eventTitle: event.title,
      targetKind: "todo", targetId: todo.id, targetTitle: todo.title, promotedBy, createdAt,
    };
    const status = native ? await this.repository.writeProject({
      kind: "promoteEventToTodo", todo: todoWriteValues(todo), eventId: event.id, promotionId: draft.id,
      promotedBy, createdAt, sourceTaskId: actor?.taskId,
    }) : this.repository.insertTodoPromotionOnHost(todo, draft, actor?.taskId);
    if (status === "scopeChanged") throw new Error("任务的项目归属已变化，请重新读取");
    if (status === "archived") throw new Error(ARCHIVED_PROJECT_WRITE_GUIDANCE);
    if (status === "missingEvent") throw new Error(`事件不存在：${event.id}`);
    if (status === "missing") throw new Error(`项目不存在：${projectId}`);
    if (status !== "changed" && status !== "existingPromotion") throw new Error("项目事件与计划项的关联写入失败");

    if (status === "changed") this.publishPlanChange(projectId);
    this.assertProjectActor(projectId, actor);
    const actual = this.repository.findProjectEventPromotion(projectId, event.id, "todo");
    if (!actual) throw new Error("项目事件与计划项的关联已被移除");
    return this.todoPromotionResult(actual, status === "existingPromotion");
  }

  private todoPromotionResult(promotion: ProjectEventPromotionDto, reused: boolean): ProjectEventPromoteResultDto {
    const result: ProjectEventPromoteResultDto = {
      promotion, targetKind: "todo", targetId: promotion.targetId, targetTitle: promotion.targetTitle, reused,
    };
    if (reused) result.targetMissing = this.repository.getTodo(promotion.targetId)?.projectId !== promotion.projectId;
    return result;
  }

  /* ---------------- Project Memory ---------------- */

  listMemory(projectId: string): ProjectMemoryItemDto[] {
    if (!this.repository.get(projectId)) throw new Error(`项目不存在：${projectId}`);
    return this.memoryService
      .listExactScope("project", projectId, ["active", "superseded", "resolved"], 2000)
      .map((item) => kernelMemoryToProject(item, projectId));
  }

  async readMemoryList(projectId: string): Promise<ProjectMemoryItemDto[]> {
    const rows = await this.repository.readMemoryList(projectId);
    if (rows === null) throw new Error(`项目不存在：${projectId}`);
    return rows?.map(item => kernelMemoryToProject(item, projectId)) ?? this.listMemory(projectId);
  }

  getMemory(projectId: string, id: string): ProjectMemoryItemDto | undefined {
    const item = this.memoryService.get(id);
    return item?.scopes.some((scope) => scope.scopeType === "project" && scope.scopeId === projectId)
      ? kernelMemoryToProject(item, projectId)
      : undefined;
  }

  /**
   * 创建 Memory 条目（数据边界在此强制，UI/IPC/Agent 工具任何入口不可绕过）。
   * source 由主进程注入：Agent 工具自动带 sourceType=agent + sourceTaskId，
   * 不接受 Agent 在请求里伪造；UI/IPC 默认 manual。
   * evidence（结构化证据）：library 条目必须属于 personal 或当前 project（跨项目拒绝）；
   * task/artifact id 仅记录引用，不校验存在性（删除后为 evidence missing，memory 保留）。
   */
  createMemory(
    request: ProjectMemoryCreateRequest,
    source?: ProjectMemorySource,
  ): ProjectMemoryItemDto {
    return kernelMemoryToProject(this.memoryService.create(this.prepareMemoryRequest(request, source)), request.projectId);
  }

  async createMemoryAsync(request: ProjectMemoryCreateRequest, source?: ProjectMemorySource): Promise<ProjectMemoryItemDto> {
    const { projectId } = request;
    const actor = source?.sourceType === "agent" && source.sourceTaskId ? { taskId: source.sourceTaskId, projectId } : undefined;
    const native = await this.repository.supportsNativeWrites("memory");
    this.assertProjectActor(projectId, actor);
    if (!native) return this.createMemory(request, source);
    const record = this.memoryService.prepareCreation(this.prepareMemoryRequest(request, source));
    const status = await this.repository.writeProject({
      kind: "createMemory", projectId, memory: memoryWriteValues(record), actorTaskId: actor?.taskId,
    });
    assertProjectMemoryWritten(status, projectId);
    return this.publishProjectMemory(projectId, record.id);
  }

  async promoteEventToMemory(
    event: ProjectEventDto,
    request: () => ProjectMemoryCreateRequest,
    source: ProjectMemorySource,
    promotedBy: ProjectEventPromotedBy,
    createdAt: number,
  ): Promise<ProjectEventPromoteResultDto> {
    const projectId = event.projectId;
    const actor = source.sourceTaskId ? { taskId: source.sourceTaskId, projectId } : undefined;
    this.requireWritableProjectSummary(projectId, actor);
    const existing = this.repository.findProjectEventPromotion(projectId, event.id, "memory");
    if (existing) return this.memoryPromotionResult(existing, true);

    const native = await this.repository.supportsNativeWrites("memory");
    const input = request();
    const record = this.memoryService.prepareCreation(this.prepareMemoryRequest(input, source));
    const draft: ProjectEventPromotionDto = {
      id: `pepr_${randomUUID()}`, projectId, eventId: event.id, eventTitle: event.title, targetKind: "memory",
      targetId: record.id, targetTitle: record.title, promotedBy, createdAt,
    };
    const status = native ? await this.repository.writeProject({
      kind: "createMemory", projectId, memory: memoryWriteValues(record), actorTaskId: actor?.taskId,
      promotion: { id: draft.id, eventId: event.id, promotedBy, createdAt },
    }) : this.repository.insertPromotionOnHost(draft, () => {
      this.memoryService.persistPreparedCreation(record);
    }, actor?.taskId);
    if (status !== "existingPromotion") {
      assertProjectMemoryWritten(status, projectId, event.id);
      this.publishProjectMemory(projectId, record.id);
    }
    this.assertProjectActor(projectId, actor);
    const actual = this.repository.findProjectEventPromotion(projectId, event.id, "memory");
    if (!actual) throw new Error("项目事件与记忆的关联已被移除");
    return this.memoryPromotionResult(actual, status === "existingPromotion");
  }

  private memoryPromotionResult(promotion: ProjectEventPromotionDto, reused: boolean): ProjectEventPromoteResultDto {
    const result: ProjectEventPromoteResultDto = {
      promotion, targetKind: "memory", targetId: promotion.targetId, targetTitle: promotion.targetTitle, reused,
    };
    if (reused) result.targetMissing = !this.getMemory(promotion.projectId, promotion.targetId);
    return result;
  }

  private publishProjectMemory(projectId: string, id: string): ProjectMemoryItemDto {
    const stored = this.memoryService.get(id);
    if (!stored?.scopes.some(scope => scope.scopeType === "project" && scope.scopeId === projectId)) {
      throw new Error("已保存的项目记忆已被移除");
    }
    this.memoryService.publishCreatedMemory(stored);
    return kernelMemoryToProject(stored, projectId);
  }

  private prepareMemoryRequest(request: ProjectMemoryCreateRequest, source?: ProjectMemorySource): MemoryCreateRequest {
    const project = this.requireWritableProjectSummary(request.projectId);
    const kind = normalizeMemoryKind(request.kind);
    const title = normalizeMemoryTitle(request.title);
    const content = normalizeMemoryContent(request.content ?? "");
    const status = request.status === undefined ? undefined : normalizeMemoryStatus(request.status);
    const validatedEvidence = this.normalizeEvidence(request, project.id, Date.now());
    const evidence = validatedEvidence.map((ev) => ({
      evidenceKind: ev.evidenceKind === "library" ? "library_item" as const
        : ev.evidenceKind === "event" ? "project_event" as const
          : ev.evidenceKind,
      refId: ev.refId,
      refTitle: ev.refTitle,
    }));
    return {
      kind, title, content, status,
      importance: request.importance, confidence: source?.sourceType === "agent" ? 0.82 : 1,
      explicit: source?.sourceType !== "agent", sourceType: source?.sourceType === "agent" ? "agent" : "manual",
      sourceTaskId: source?.sourceTaskId, scopeType: "project", scopeId: request.projectId,
      metadata: { tags: normalizeMemoryTags(request.tags) }, evidence,
    };
  }

  /**
   * 单项结构化更新（字段级比较，no-op 不写 DB、不 bump 版本）；
   * 真实变化经 Memory Kernel 落库，并同步推进 Project activity/version clock。
   */
  updateMemory(request: ProjectMemoryUpdateRequest): ProjectMemoryItemDto {
    const { update } = this.prepareProjectMemoryUpdate(request);
    return kernelMemoryToProject(this.memoryService.update(update), request.projectId);
  }

  async updateMemoryAsync(request: ProjectMemoryUpdateRequest, actor?: ProjectWriteActor): Promise<ProjectMemoryItemDto> {
    const { projectId, id } = request;
    if (!await this.repository.supportsNativeWrites("memoryEdits")) {
      this.assertProjectActor(projectId, actor);
      return this.updateMemory(request);
    }
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const draft = this.repository.readWriteSnapshot(() => {
        const { current, update } = this.prepareProjectMemoryUpdate(request, actor);
        const next = this.memoryService.prepareUpdate(current, update);
        return next ? { edit: memoryEditValues(next, this.repository.memoryRevision(id)) } : { unchanged: current };
      });
      if (draft.unchanged) return kernelMemoryToProject(draft.unchanged, projectId);
      const status = await this.repository.writeProject({ kind: "editMemory", projectId, edit: draft.edit, actorTaskId: actor?.taskId });
      if (status === "stale") continue;
      assertProjectMemoryWritten(status, projectId);
      const saved = this.memoryService.get(id);
      if (!saved?.scopes.some(scope => scope.scopeType === "project" && scope.scopeId === projectId)) {
        throw new Error("记忆条目不存在");
      }
      this.memoryService.indexSavedMemory(saved);
      return kernelMemoryToProject(saved, projectId);
    }
    throw new Error("项目记忆仍在更新，请刷新后重试");
  }

  private prepareProjectMemoryUpdate(request: ProjectMemoryUpdateRequest, actor?: ProjectWriteActor): {
    current: MemoryRecordDto;
    update: MemoryUpdateRequest;
  } {
    this.requireWritableProjectSummary(request.projectId, actor);
    const current = this.memoryService.get(request.id);
    const exactScope = current?.scopes.some(
      (scope) => scope.scopeType === "project" && scope.scopeId === request.projectId,
    );
    if (!current || !exactScope) throw new Error("记忆条目不存在");
    if (current.scopes.some((scope) => scope.scopeType !== "project" || scope.scopeId !== request.projectId)) {
      throw new Error(SHARED_MEMORY_EDIT_GUIDANCE);
    }
    const kind = request.kind === undefined ? undefined : normalizeMemoryKind(request.kind);
    const title = request.title === undefined ? undefined : normalizeMemoryTitle(request.title);
    const content = request.content === undefined
      ? undefined
      : normalizeMemoryContent(request.content ?? "");
    const status = request.status === undefined ? undefined : normalizeMemoryStatus(request.status);
    const tags = request.tags === undefined
      ? (Array.isArray(current.metadata.tags) ? current.metadata.tags : [])
      : normalizeMemoryTags(request.tags);
    const update: MemoryUpdateRequest = {
      id: request.id, kind, title, content,
      status, importance: request.importance, metadata: { ...current.metadata, tags },
      changedBy: "manual", changeReason: "project UI update",
    };
    return { current, update };
  }

  /** 人手删除（UI/IPC）；Agent 工具不暴露 delete，过时用 superseded/resolved。缺省 id 幂等。 */
  deleteMemory(request: ProjectMemoryDeleteRequest): void {
    this.requireWritableProjectSummary(request.projectId);
    const current = this.memoryService.get(request.id);
    if (!current?.scopes.some((scope) => scope.scopeType === "project" && scope.scopeId === request.projectId)) return;
    this.memoryService.detachScope(request.id, "project", request.projectId);
  }

  async deleteMemoryAsync(request: ProjectMemoryDeleteRequest): Promise<void> {
    if (!await this.repository.supportsNativeWrites("memoryEdits")) return this.deleteMemory(request);
    const { projectId, id } = request;
    this.requireWritableProjectSummary(projectId);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const snapshot = await this.repository.readMemoryWithdrawal(projectId, id);
      if (!snapshot) throw new Error("项目记忆读取失败，请重试");
      const status = await this.repository.writeProject({
        kind: "detachMemory", projectId, id,
        withdrawal: { signature: snapshot.signature, cutoffAt: Date.now(), targets: memoryWithdrawalTargets(snapshot.records) },
      });
      if (status === "stale") continue;
      if (status === "unchanged") return;
      assertProjectMemoryWritten(status, projectId);
      return;
    }
    throw new Error("项目记忆仍在更新，请稍后重试删除");
  }

  searchMemory(projectId: string, query: string, limit = 20): ProjectMemoryItemDto[] {
    return this.memoryService.search(this.memorySearchRequest(projectId, query, limit))
      .map(hit => kernelMemoryToProject(hit.memory, projectId));
  }

  async searchMemoryAsync(projectId: string, query: string, limit = 20): Promise<ProjectMemoryItemDto[]> {
    const hits = await this.memoryService.searchLexical(this.memorySearchRequest(projectId, query, limit));
    return hits.map(hit => kernelMemoryToProject(hit.memory, projectId));
  }

  private memorySearchRequest(projectId: string, query: string, limit: number): MemorySearchRequest {
    if (!this.repository.getSummary(projectId)) throw new Error(`项目不存在：${projectId}`);
    return { projectId, scopeTypes: ["project"], includeInherited: false, query, statuses: ["active"], limit };
  }

  /** 项目任务（cadence/派生共用；status/updatedAt/archived） */
  listTasksByProject(projectId: string): Array<{ id: string; title: string; status: string | null; updated_at: number; archived: number }> {
    return this.repository.listTasksByProject(projectId);
  }

  /* ---------------- Project Shared Context：pinned library refs ---------------- */

  /** 固定 Library 条目到项目上下文（只引用不复制）。personal 或本项目条目可 pin；跨项目拒绝。 */
  pinProjectItem(request: ProjectContextPinRequest): ProjectContextPinDto {
    const project = this.requireWritableProject(request.projectId);
    const existing = this.repository.listPins(request.projectId).find((p) => p.itemId === request.itemId);
    if (existing) return existing;
    const scope = this.repository.getLibraryItemScope(request.itemId);
    if (!scope) throw new Error("资料条目不存在");
    if (scope.projectId !== null && scope.projectId !== project.id) {
      throw new Error("不能固定其他项目的资料（跨项目隔离）");
    }
    const item = this.repository.getLibraryItemTitle(request.itemId);
    const pin: ProjectContextPinDto = {
      id: `ppin_${randomUUID()}`,
      projectId: project.id,
      itemId: request.itemId,
      itemTitle: item?.title,
      itemKind: item?.kind,
      note: request.note?.trim() || undefined,
      createdBy: this.ownerName(),
      createdAt: Date.now(),
    };
    this.repository.insertPin(pin);
    return this.repository.listPins(project.id).find((p) => p.itemId === request.itemId) ?? pin;
  }

  async pinProjectItemAsync(request: ProjectContextPinRequest): Promise<ProjectContextPinDto> {
    const result = await this.repository.requestProjectPins({
      kind: "pin",
      projectId: request.projectId,
      itemId: request.itemId,
      id: `ppin_${randomUUID()}`,
      note: typeof request.note === "string" ? request.note.trim() || undefined : request.note,
      createdAt: Date.now(),
    });
    if (result?.status === "pinned") return result.pin;
    if (result?.status === "needsHost") return this.repository.commitWriteOnHost(() => this.pinProjectItem(request));
    if (result?.status === "archived") throw new Error(ARCHIVED_PROJECT_WRITE_GUIDANCE);
    if (result?.status === "rejected") throw new Error(result.message);
    throw new Error("固定资料未确认，请刷新后重试");
  }

  unpinProjectItem(request: ProjectContextUnpinRequest): void {
    this.requireWritableProject(request.projectId);
    this.repository.deletePin(request.projectId, request.itemId);
  }

  async unpinProjectItemAsync(request: ProjectContextUnpinRequest): Promise<void> {
    const result = await this.repository.requestProjectPins({ kind: "unpin", projectId: request.projectId, itemId: request.itemId });
    if (result?.status === "removed") return;
    if (result?.status === "needsHost") return this.repository.commitWriteOnHost(() => this.unpinProjectItem(request));
    if (result?.status === "archived") throw new Error(ARCHIVED_PROJECT_WRITE_GUIDANCE);
    if (result?.status === "rejected") throw new Error(result.message);
    throw new Error("解除固定未确认，请刷新后重试");
  }

  listProjectPins(projectId: string): ProjectContextPinDto[] {
    return this.repository.listPins(projectId);
  }

  async listProjectPinsAsync(projectId: string): Promise<ProjectContextPinDto[]> {
    const result = await this.repository.requestProjectPins({ kind: "list", projectId });
    if (result?.status === "listed") return result.pins;
    if (result?.status === "rejected") throw new Error(result.message);
    return this.listProjectPins(projectId);
  }

  /* ---------------- Project Shared Context：结构化读取/局部更新 ---------------- */

  /** 读取 Shared Context 结构化字段 + pinned refs（runtime/工具/UI 共用） */
  getSharedContext(projectId: string): ProjectSharedContextSummary {
    const project = this.repository.get(projectId);
    if (!project) throw new Error(`项目不存在：${projectId}`);
    return {
      projectId,
      goal: project.goal?.trim() || null,
      currentStage: project.currentStage?.trim() || null,
      instructions: project.instructions?.trim() || null,
      pinned: this.repository.listPins(projectId),
    };
  }

  /**
   * 局部更新 Shared Context（goal/currentStage；instructions 由项目设置维护，不在 Agent 工具面）。
   * 字段长度上限与 prompt 预算一致（goal≤300/currentStage≤200），超限拒绝；
   * 真实变化经 updateProject 落库并单调 bump projects.updated_at（版本/审计语义）。
   */
  updateSharedContext(
    projectId: string,
    patch: { goal?: string | null; currentStage?: string | null },
  ): ProjectSharedContextSummary {
    const current = this.requireWritableProject(projectId);
    const update: ProjectUpdateRequest = { id: projectId };
    if (patch.goal !== undefined) {
      const goal = cleanOptional(patch.goal);
      if (goal && goal.length > PROJECT_CONTEXT_GOAL_MAX_CHARS) {
        throw new Error(`项目目标不能超过 ${PROJECT_CONTEXT_GOAL_MAX_CHARS} 字符`);
      }
      update.goal = goal ?? null;
    }
    if (patch.currentStage !== undefined) {
      const stage = cleanOptional(patch.currentStage);
      if (stage && stage.length > PROJECT_CONTEXT_STAGE_MAX_CHARS) {
        throw new Error(`当前阶段不能超过 ${PROJECT_CONTEXT_STAGE_MAX_CHARS} 字符`);
      }
      update.currentStage = stage ?? null;
    }
    if (update.goal === undefined && update.currentStage === undefined) {
      return this.getSharedContext(projectId); // 空 patch：no-op
    }
    this.update(update);
    return this.getSharedContext(projectId);
  }

  private normalizeEvidence(
    request: ProjectMemoryCreateRequest,
    projectId: string,
    now: number,
  ): ProjectMemoryEvidenceDto[] {
    const out: ProjectMemoryEvidenceDto[] = [];
    for (const itemId of request.evidenceItemIds ?? []) {
      if (!itemId?.trim()) continue;
      const scope = this.repository.getLibraryItemScope(itemId.trim());
      if (!scope) throw new Error(`证据资料不存在：${itemId}`);
      if (scope.projectId !== null && scope.projectId !== projectId) {
        throw new Error(`证据属于其他项目，拒绝引用：${itemId}`);
      }
      const item = this.repository.getLibraryItemTitle(itemId.trim());
      out.push({
        id: `pev_${randomUUID()}`,
        memoryId: "",
        evidenceKind: "library",
        refId: itemId.trim(),
        refTitle: item?.title ?? undefined,
        createdAt: now,
      });
    }
    if (request.evidenceTaskId?.trim()) {
      const taskScope = this.repository.getTaskProjectScope(request.evidenceTaskId.trim());
      if (!taskScope) throw new Error(`证据任务不存在：${request.evidenceTaskId.trim()}`);
      if (taskScope.projectId !== null && taskScope.projectId !== projectId) {
        throw new Error("证据任务属于其他项目，拒绝引用");
      }
      out.push({
        id: `pev_${randomUUID()}`,
        memoryId: "",
        evidenceKind: "task",
        refId: request.evidenceTaskId.trim(),
        refTitle: undefined,
        createdAt: now,
      });
    }
    for (const artifactId of request.evidenceArtifactIds ?? []) {
      if (!artifactId?.trim()) continue;
      const artifactScope = this.repository.getArtifactProjectScope(artifactId.trim());
      if (!artifactScope) throw new Error(`证据产物不存在：${artifactId.trim()}`);
      if (artifactScope.projectId !== null && artifactScope.projectId !== projectId) {
        throw new Error("证据产物属于其他项目，拒绝引用");
      }
      out.push({
        id: `pev_${randomUUID()}`,
        memoryId: "",
        evidenceKind: "artifact",
        refId: artifactId.trim(),
        refTitle: undefined,
        createdAt: now,
      });
    }
    // 证据：项目事件（提升溯源；必须属于当前 project；事件淘汰后证据保留，refTitle 快照降级）
    if (request.evidenceEventId?.trim()) {
      const eventScope = this.repository.getProjectEventScope(request.evidenceEventId.trim());
      if (!eventScope) throw new Error(`证据事件不存在：${request.evidenceEventId.trim()}`);
      if (eventScope !== projectId) throw new Error("证据事件属于其他项目，拒绝引用");
      out.push({
        id: `pev_${randomUUID()}`,
        memoryId: "",
        evidenceKind: "event",
        refId: request.evidenceEventId.trim(),
        refTitle: this.repository.getProjectEventTitle(request.evidenceEventId.trim()),
        createdAt: now,
      });
    }
    return out;
  }

  private ownerName(): string {
    try {
      return this.repository.getSoulName() ?? "我";
    } catch {
      return "我";
    }
  }

  /* ---------------- Project Autopilot：派生运行状态快照（非真源，源变化即重算） ---------------- */

  /**
   * 构建项目运行状态快照：全部从现有源（project/tasks/todos/memory/reviews）现读派生，
   * 无缓存、无模型猜测；now 可注入（测试确定性）。规则确定：
   * - blockers：高优先级且已开始的计划逾期；
   * - atRisks：其它逾期/临期计划项 + 停滞 doing 任务 + active risk + 高重要度 open_question；
   * - nextActions：计划 doing（优先级/截止排序）与任务 doing（最近更新）各取有界前几条；
   * - health：blockers>0 → red；atRisks>0 → yellow；否则 green。
   */
  buildStatusSnapshot(projectId: string, now = Date.now()): ProjectStatusSnapshotDto {
    return this.summarizeStatus(this.statusSources(projectId), now);
  }

  async readStatusSnapshot(projectId: string, now = Date.now()): Promise<ProjectStatusSnapshotDto> {
    return (await this.readStatusWithProposalCounts(projectId, now)).snapshot;
  }

  async readStatusWithProposalCounts(projectId: string, now: number): Promise<{
    snapshot: ProjectStatusSnapshotDto;
    proposalCounts?: { needsConfirmation: number; proposalsTotal: number };
  }> {
    const native = await this.repository.readStatus(projectId, now);
    if (native === null) throw new Error(`项目不存在：${projectId}`);
    if (!native) return { snapshot: this.buildStatusSnapshot(projectId, now) };
    const { status, needsConfirmation, proposalsTotal } = native;
    return {
      snapshot: {
        ...status,
        blockers: status.blockers.map(statusIssue),
        atRisks: status.atRisks.map(statusIssue),
        nextActions: status.nextActions.map(action => action.source === "plan"
          ? { ...action, dueAt: action.dueAt ?? undefined }
          : { source: action.source, refId: action.refId, title: action.title }),
      },
      proposalCounts: { needsConfirmation, proposalsTotal },
    };
  }

  private statusSources(projectId: string) {
    const project = this.repository.getSummary(projectId);
    if (!project) throw new Error(`项目不存在：${projectId}`);
    return {
      project,
      tasks: this.repository.listTasksByProject(projectId),
      todos: this.repository.listTodos(projectId),
      memory: this.repository.listStatusMemories(projectId),
    };
  }

  private summarizeStatus(
    { project, tasks, todos, memory }: ReturnType<ProjectService["statusSources"]>, now: number,
  ): ProjectStatusSnapshotDto {
    const projectId = project.id;
    const staleAfter = now - 7 * 24 * 3600 * 1000;
    const reviews = this.repository.listReviews(projectId, 1);

    const activeTasks = tasks.filter((t) => !t.archived && t.status !== "completed" && t.status !== "failed");
    const doingTasks = tasks.filter((t) => !t.archived && t.status === "in_progress");
    const staleDoing = doingTasks.filter((t) => t.updated_at < staleAfter);

    const doingTodos = todos.filter((t) => t.status === "doing");
    const overdueTodos = todos.filter((t) => t.status !== "done" && t.dueAt !== undefined && t.dueAt < now);
    const nearDueTodos = todos.filter(
      (t) => t.status !== "done" && t.dueAt !== undefined && t.dueAt >= now && t.dueAt < now + 3 * 24 * 3600 * 1000,
    );

    const activeMemory = memory.filter((m) => m.status === "active");
    const risks = activeMemory.filter((m) => m.kind === "risk");
    const openQuestions = activeMemory.filter((m) => m.kind === "open_question");
    const topRisks = [...risks]
      .sort((a, b) => b.importance - a.importance || b.updatedAt - a.updatedAt)
      .slice(0, 3);
    const importantOpen = openQuestions.filter((m) => m.importance >= 2).slice(0, 3);
    const isBlocking = (todo: ProjectTodoDto) => todo.status === "doing" && todo.priority === "high";
    const blockingOverdue = overdueTodos.filter(isBlocking);
    const attentionOverdue = overdueTodos.filter(todo => !isBlocking(todo));

    const blockers: ProjectStatusIssueDto[] = [
      ...blockingOverdue.slice(0, 5).map((t) => ({
        source: "plan" as const,
        refId: t.id,
        title: t.title,
        reason: `高优先级进行中计划已逾期（截止 ${formatPlanLocalDate(t.dueAt!)}）`,
      })),
    ].slice(0, 8);

    const atRisks: ProjectStatusIssueDto[] = [
      ...attentionOverdue.slice(0, 5).map((t) => ({
        source: "plan" as const,
        refId: t.id,
        title: t.title,
        reason: `计划项已逾期（截止 ${formatPlanLocalDate(t.dueAt!)}）`,
      })),
      ...nearDueTodos.slice(0, 5).map((t) => ({
        source: "plan" as const,
        refId: t.id,
        title: t.title,
        reason: `计划项 3 天内到期（截止 ${formatPlanLocalDate(t.dueAt!)}）`,
      })),
      ...staleDoing.slice(0, 3).map((t) => ({
        source: "task" as const,
        refId: t.id,
        title: t.title,
        reason: "任务 7 天无更新",
      })),
      ...topRisks.map((m) => ({
        source: "memory" as const,
        refId: m.id,
        title: m.title,
        reason: "项目记忆中的 active 风险",
      })),
      ...importantOpen.map((m) => ({
        source: "memory" as const,
        refId: m.id,
        title: m.title,
        reason: "高重要度待确认问题",
      })),
    ].slice(0, 8);

    const planRank: Record<ProjectTodoPriority | "none", number> = { high: 0, medium: 1, low: 2, none: 3 };
    const nextActions: ProjectNextActionDto[] = [
      ...doingTodos
        .sort((a, b) => planRank[a.priority ?? "none"] - planRank[b.priority ?? "none"] || (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity))
        .slice(0, 4)
        .map((t) => ({ source: "plan" as const, refId: t.id, title: t.title, dueAt: t.dueAt })),
      ...doingTasks
        .sort((a, b) => b.updated_at - a.updated_at)
        .slice(0, 4)
        .map((t) => ({ source: "task" as const, refId: t.id, title: t.title })),
    ].slice(0, 8);

    const latestTask = tasks.reduce((latest, task) => Math.max(latest, task.updated_at), project.updatedAt);
    const latestTodo = todos.reduce((latest, todo) => Math.max(latest, todo.updatedAt), latestTask);
    const lastActivityAt = memory.reduce((latest, record) => Math.max(latest, record.updatedAt), latestTodo);

    return {
      projectId,
      projectName: project.name,
      goal: project.goal ?? null,
      currentStage: project.currentStage ?? null,
      archived: Boolean(project.archived),
      health: blockers.length > 0 ? "red" : atRisks.length > 0 ? "yellow" : "green",
      generatedAt: now,
      lastActivityAt,
      lastReviewedAt: reviews[0]?.reviewedAt ?? null,
      tasks: { total: tasks.length, active: activeTasks.length, doing: doingTasks.length, stale: staleDoing.length },
      plan: { total: todos.length, doing: doingTodos.length, overdue: overdueTodos.length },
      memory: { openQuestions: openQuestions.length, risks: risks.length },
      blockers,
      atRisks,
      nextActions,
    };
  }

  /** 记录一次项目 review（审计/派生标记：只影响 lastReviewedAt，不影响派生计算） */
  recordReview(projectId: string, note: string | undefined, createdBy: string, actor?: ProjectWriteActor): ProjectReviewDto {
    return this.repository.commitWriteOnHost(() => {
      this.requireWritableProjectSummary(projectId, actor);
      const review = this.prepareReview(projectId, note, createdBy);
      this.repository.insertReview(review);
      return review;
    });
  }

  async recordReviewAsync(projectId: string, note: string | undefined, createdBy: string, actor?: ProjectWriteActor): Promise<ProjectReviewDto> {
    if (actor && actor.projectId !== projectId) throw new Error("任务的项目归属已变化，请重新读取");
    const wireStrings = [projectId, createdBy, ...(note === undefined ? [] : [note]), ...(actor ? [actor.taskId] : [])];
    const native = await this.repository.supportsNativeWrites("review");
    if (wireStrings.some(value => typeof value !== "string" || /[\uD800-\uDFFF]/u.test(value))
        || (note?.trim().length ?? 0) > PROJECT_REVIEW_NOTE_MAX_CHARS
        || !native) {
      if (this.repository.requiresRustWrites) {
        throw new Error("项目评审写入失败：受监督模式下仅允许合法 UTF-8 通过 Rust 核心保存");
      }
      return this.recordReview(projectId, note, createdBy, actor);
    }
    const review = this.prepareReview(projectId, note, createdBy);
    const status = await this.repository.writeProject({ kind: "recordReview", review, actorTaskId: actor?.taskId });
    if (status === "changed") return review;
    if (status === "scopeChanged") throw new Error("任务的项目归属已变化，请重新读取");
    if (status === "archived") throw new Error(ARCHIVED_PROJECT_WRITE_GUIDANCE);
    if (status === "missing") throw new Error(`项目不存在：${projectId}`);
    throw new Error("项目评审写入失败，请重试");
  }

  private prepareReview(projectId: string, note: string | undefined, createdBy: string): ProjectReviewDto {
    const cleanNote = note?.trim();
    if (cleanNote && cleanNote.length > PROJECT_REVIEW_NOTE_MAX_CHARS) {
      throw new Error(`review 备注不能超过 ${PROJECT_REVIEW_NOTE_MAX_CHARS} 字符`);
    }
    return {
      id: `prev_${randomUUID()}`,
      projectId,
      reviewedAt: Date.now(),
      note: cleanNote || undefined,
      createdBy,
    };
  }

  listReviews(projectId: string, limit = 5): ProjectReviewDto[] {
    return this.repository.listReviews(projectId, limit);
  }

  /* ---------------- Project Action Proposals：把状态转成受控建议/动作（非真源） ---------------- */

  /**
   * 从状态快照生成建议动作（确定性规则，无模型猜测）：
   * - 逾期计划项 → locate_plan（时间不能证明事项已经开始，绝不自动改状态）；
   * - 停滞 doing 任务 → locate_task；
   * - active risk 记忆 / 高重要度 open_question → needs_confirmation（仅建议）；
   * 指纹幂等（不堆重复）；已 applied 不复活；源不再匹配的旧建议 → stale/obsolete。
   */
  generateActionProposals(projectId: string, now = Date.now()): ProjectActionProposalDto[] {
    const sources = this.statusSources(projectId);
    if (sources.project.archived) return this.repository.listActionProposals(projectId);
    const snapshot = this.summarizeStatus(sources, now);
    const owner = this.ownerName();
    const proposals: ProjectActionProposalDto[] = [];
    const { todos, tasks, memory } = sources;

    // 逾期计划项：只定位/提示，不从时间推断业务状态。
    for (const item of todos.filter((todo) => todo.status !== "done" && todo.dueAt !== undefined && todo.dueAt < now)) {
      const rationale = `计划项已逾期（截止 ${formatPlanLocalDate(item.dueAt!)}）`;
      proposals.push({
        id: `pact_${randomUUID()}`,
        projectId,
        actionType: "locate_plan",
        title: `定位逾期计划项「${item.title}」`,
        rationale,
        sourceRefs: [{ source: "plan", refId: item.id, title: item.title }],
        executable: false,
        targetRef: item.id,
        status: "proposed",
        createdAt: now,
        updatedAt: now,
      });
    }
    // 停滞任务
    for (const task of snapshot.atRisks.filter((risk) => risk.source === "task")) {
      proposals.push({
        id: `pact_${randomUUID()}`,
        projectId,
        actionType: "locate_task",
        title: `定位停滞任务「${task.title}」`,
        rationale: task.reason,
        sourceRefs: [{ source: "task", refId: task.refId, title: task.title }],
        executable: false,
        targetRef: task.refId,
        status: "proposed",
        createdAt: now,
        updatedAt: now,
      });
    }
    // 风险/待确认（仅建议，不伪造事实）
    for (const open of snapshot.atRisks.filter((risk) => risk.source === "memory")) {
      const source = memory.find((item) => item.id === open.refId);
      const isRisk = source?.kind === "risk";
      proposals.push({
        id: `pact_${randomUUID()}`,
        projectId,
        actionType: "needs_confirmation",
        title: `${isRisk ? "风险需确认" : "待确认问题"}：「${open.title}」`,
        rationale: `${open.reason}；需要补充信息后再推进，不自动修改业务状态。`,
        sourceRefs: [{ source: "memory", refId: open.refId, title: open.title }],
        executable: false,
        targetRef: open.refId,
        status: "proposed",
        createdAt: now,
        updatedAt: now,
      });
    }

    // 指纹 upsert（幂等去重；applied 不复活）
    const existing = this.repository.listActionProposals(projectId);
    for (const proposal of proposals) {
      this.repository.upsertActionProposal({
        ...proposal,
        fingerprint: `${proposal.actionType}:${proposal.targetRef ?? ""}`,
        createdBy: owner,
      });
    }
    // stale/obsolete 收敛：源不再匹配的建议标记失效（不悬空）
    const validFingerprints = new Set(proposals.map((p) => `${p.actionType}:${p.targetRef ?? ""}`));
    const todoIds = new Set(todos.map((t) => t.id));
    const taskIds = new Set(tasks.filter((t) => !t.archived).map((t) => t.id));
    const memoryIds = new Set(memory.map((m) => m.id));
    for (const item of existing) {
      if (item.status === "applied") continue; // 已执行保留审计
      const stillValid = validFingerprints.has(`${item.actionType}:${item.targetRef ?? ""}`);
      const refAlive =
        item.targetRef &&
        (item.actionType.startsWith("locate_plan") || item.actionType === "update_plan_status"
          ? todoIds.has(item.targetRef)
          : item.actionType === "locate_task"
            ? taskIds.has(item.targetRef)
            : memoryIds.has(item.targetRef));
      const targetStatus = item.status;
      if (!stillValid && targetStatus !== "obsolete" && targetStatus !== "stale") {
        this.repository.updateActionProposalStatus(projectId, item.id, refAlive ? "stale" : "obsolete");
      }
    }
    return this.repository.listActionProposals(projectId);
  }

  listActionProposals(projectId: string): ProjectActionProposalDto[] {
    return this.repository.listActionProposals(projectId);
  }

}

function parseTodoStatus(value: ProjectTodoStatus | undefined): ProjectTodoStatus {
  if (value === "doing" || value === "paused" || value === "done") return value;
  return "todo";
}

/** title 数据边界：trim 后非空且 ≤500 字符（UI/IPC/Agent 工具任何入口统一强制） */
function normalizeTodoTitle(rawTitle: string): string {
  const title = rawTitle.trim();
  if (!title) throw new Error("待办标题不能为空");
  if (title.length > PROJECT_TODO_TITLE_MAX_CHARS) {
    throw new Error(`待办标题不能超过 ${PROJECT_TODO_TITLE_MAX_CHARS} 字符`);
  }
  return title;
}

function normalizeMemoryKind(value: ProjectMemoryKind): ProjectMemoryKind {
  if (!(PROJECT_MEMORY_KINDS as readonly string[]).includes(value)) throw new Error("记忆类型非法");
  return value;
}

function normalizeMemoryStatus(value: ProjectMemoryStatus): ProjectMemoryStatus {
  if (!(PROJECT_MEMORY_STATUSES as readonly string[]).includes(value)) throw new Error("记忆状态非法");
  return value;
}

function normalizeMemoryTitle(rawTitle: string): string {
  const title = rawTitle.trim();
  if (!title) throw new Error("记忆标题不能为空");
  if (title.length > PROJECT_MEMORY_TITLE_MAX_CHARS) {
    throw new Error(`记忆标题不能超过 ${PROJECT_MEMORY_TITLE_MAX_CHARS} 字符`);
  }
  return title;
}

function normalizeMemoryContent(rawContent: string): string {
  const content = rawContent.trim();
  if (content.length > PROJECT_MEMORY_CONTENT_MAX_CHARS) {
    throw new Error(`记忆内容不能超过 ${PROJECT_MEMORY_CONTENT_MAX_CHARS} 字符`);
  }
  return content;
}

function normalizeMemoryTags(rawTags: string[] | undefined): string[] {
  const tags = (rawTags ?? [])
    .map((tag) => tag.trim())
    .filter(Boolean)
    .filter((tag, index, list) => list.indexOf(tag) === index);
  if (tags.some((tag) => tag.length > PROJECT_MEMORY_TAG_MAX_CHARS)) {
    throw new Error(`记忆标签不能超过 ${PROJECT_MEMORY_TAG_MAX_CHARS} 字符`);
  }
  if (tags.length > PROJECT_MEMORY_MAX_TAGS) {
    throw new Error(`记忆标签不能超过 ${PROJECT_MEMORY_MAX_TAGS} 个`);
  }
  return tags;
}
