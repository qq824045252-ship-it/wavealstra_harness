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
  PROJECT_PINS_MAX,
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
import { ProjectRepository } from "./ProjectRepository";
import type { MemoryService } from "../memory/MemoryService";
import type { MemoryRecordDto } from "../../shared/memory-kernel";

function kernelMemoryToProject(item: MemoryRecordDto, projectId: string): ProjectMemoryItemDto {
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
    return [{ id: ev.id, memoryId: item.id, evidenceKind: kind, refId: ev.refId, refTitle: ev.refTitle, createdAt: ev.createdAt }];
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
    sourceTaskId: item.sourceTaskId,
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
  const value = rawValue.trim();
  if (!title) throw new Error("资源名称不能为空");
  if (title.length > 120) throw new Error("资源名称不能超过 120 字符");
  if (kind === "folder") return { title, value: value || title };
  if (!value) throw new Error("资源内容不能为空");
  if (kind === "file") {
    if (!isAbsolute(value)) throw new Error("文件资源必须使用绝对路径");
    if (value.length > 4096) throw new Error("文件路径过长");
  }
  if (kind === "url") {
    if (value.length > 4096) throw new Error("URL 过长");
    let url: URL;
    try { url = new URL(value); } catch { throw new Error("URL 格式无效"); }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("URL 资源仅支持 http(s)");
  }
  if (kind === "text" && value.length > 64_000) throw new Error("文本资源不能超过 64000 字符");
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

export class ProjectService {
  constructor(private readonly repository: ProjectRepository, private readonly memoryService: MemoryService) {}

  private requireWritableProject(projectId: string): ProjectDetailsDto {
    const project = this.repository.get(projectId);
    if (!project) throw new Error(`项目不存在：${projectId}`);
    if (project.archived) throw new Error(ARCHIVED_PROJECT_WRITE_GUIDANCE);
    return project;
  }

  list(includeArchived = false): ProjectDto[] {
    return this.repository.list(includeArchived);
  }

  get(id: string): ProjectDetailsDto | undefined {
    return this.repository.get(id);
  }

  create(request: ProjectCreateRequest): ProjectDetailsDto {
    const name = request.name.trim();
    if (!name) throw new Error("项目名称不能为空");
    if (this.repository.findByName(name)) throw new Error(`项目名称已存在：${name}`);
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
    return this.repository.create(project, normalizePolicies(request.policies));
  }

  update(request: ProjectUpdateRequest): ProjectDetailsDto {
    const current = this.requireWritableProject(request.id);
    const name = request.name === undefined ? current.name : request.name.trim();
    if (!name) throw new Error("项目名称不能为空");
    const duplicate = this.repository.findByName(name);
    if (duplicate && duplicate.id !== request.id) throw new Error(`项目名称已存在：${name}`);
    const project: ProjectDto = {
      ...current,
      defaultSpaceId: request.defaultSpaceId === undefined ? current.defaultSpaceId
        : request.defaultSpaceId === null ? undefined : this.repository.validateDefaultSpace(request.defaultSpaceId),
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
    return this.repository.update(
      project,
      request.policies ? normalizePolicies(request.policies, current.policies) : undefined,
    );
  }

  duplicate(request: ProjectDuplicateRequest): ProjectDetailsDto {
    const source = this.repository.get(request.sourceId);
    if (!source) throw new Error(`项目不存在：${request.sourceId}`);
    const requestedName = request.name?.trim();
    let name = requestedName || `${source.name} 副本`;
    if (!requestedName) {
      let suffix = 2;
      while (this.repository.findByName(name)) name = `${source.name} 副本 ${suffix++}`;
    } else if (this.repository.findByName(name)) {
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
    return this.repository.createWithResources(
      project,
      normalizePolicies(source.policies),
      resources,
    );
  }

  archive(id: string, archived: boolean): ProjectDetailsDto {
    const current = this.repository.get(id);
    if (!current) throw new Error(`项目不存在：${id}`);
    const project = this.repository.archive(
      id,
      archived,
      Math.max(Date.now(), current.updatedAt + 1),
    );
    if (!project) throw new Error(`项目不存在：${id}`);
    return project;
  }

  delete(id: string): void {
    this.memoryService.detachAllInScope("project", id);
    this.repository.delete(id);
  }

  createResource(request: ProjectResourceCreateRequest): ProjectResourceDto {
    const project = this.requireWritableProject(request.projectId);
    const { title, value } = validateResourceValue(request.kind, request.title, request.value);
    const parentId = resolveResourceParent(project.resources, request.parentId);
    const now = Math.max(Date.now(), project.updatedAt + 1);
    return this.repository.createResource({
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
    });
  }

  updateResource(request: ProjectResourceUpdateRequest): ProjectResourceDto {
    const current = this.repository.getResource(request.id);
    if (!current) throw new Error(`项目资源不存在：${request.id}`);
    const project = this.requireWritableProject(current.projectId);
    const { title, value } = validateResourceValue(
      current.kind,
      request.title ?? current.title,
      request.value ?? current.value,
    );
    const parentId = request.parentId === undefined
      ? current.parentId
      : resolveResourceParent(project.resources, request.parentId, current.id);
    const updatedAt = Math.max(Date.now(), current.updatedAt + 1, project.updatedAt + 1);
    return this.repository.updateResource({
      ...current,
      title,
      value,
      enabled: request.enabled ?? current.enabled,
      sortOrder: request.sortOrder === undefined ? current.sortOrder : Math.max(0, Math.round(request.sortOrder)),
      parentId,
      updatedAt,
    });
  }

  deleteResource(id: string): void {
    const current = this.repository.getResource(id);
    if (!current) return;
    const project = this.requireWritableProject(current.projectId);
    const updatedAt = Math.max(Date.now(), (project?.updatedAt ?? current.updatedAt) + 1);
    this.repository.deleteResource(id, current.projectId, updatedAt);
  }

  listPosts(projectId: string): ProjectPostDto[] {
    if (!this.repository.get(projectId)) throw new Error(`项目不存在：${projectId}`);
    return this.repository.listPosts(projectId);
  }

  createPost(request: ProjectPostCreateRequest): ProjectPostDto {
    const project = this.requireWritableProject(request.projectId);
    const body = request.body.trim();
    if (!body) throw new Error("留言不能为空");
    return this.repository.createPost({
      id: `ppost_${randomUUID()}`,
      projectId: project.id,
      body,
      createdAt: Date.now(),
    });
  }

  deletePost(id: string): void {
    const post = this.repository.getPost(id);
    if (!post) return;
    this.requireWritableProject(post.projectId);
    this.repository.deletePost(id);
  }

  /* ---------------- Project Events（外部输入审计层；非业务真源） ---------------- */

  /** 事件列表（created_at DESC；limit 有界；含提升审计链接） */
  listProjectEvents(projectId: string, limit = 50): ProjectEventDto[] {
    if (!this.repository.get(projectId)) throw new Error(`项目不存在：${projectId}`);
    return this.repository.listProjectEvents(projectId, limit);
  }

  /** 按 id 读取事件（作用域校验由调用方按 event.projectId 执行） */
  getProjectEvent(eventId: string): ProjectEventDto | undefined {
    return this.repository.getProjectEventById(eventId);
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

  getTodo(id: string): ProjectTodoDto | undefined {
    return this.repository.getTodo(id);
  }

  createTodo(request: ProjectTodoCreateRequest): ProjectTodoDto {
    const project = this.requireWritableProject(request.projectId);
    const title = normalizeTodoTitle(request.title);
    const now = Date.now();
    return this.repository.createTodo({
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
    });
  }

  updateTodo(request: ProjectTodoUpdateRequest): ProjectTodoDto {
    const current = this.repository.getTodo(request.id);
    if (!current) throw new Error("待办不存在");
    this.requireWritableProject(current.projectId);
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
    if (unchanged) return current;
    return this.repository.updateTodo({ ...next, updatedAt: Date.now() });
  }

  deleteTodo(id: string): void {
    const current = this.repository.getTodo(id);
    if (!current) return;
    this.requireWritableProject(current.projectId);
    this.repository.deleteTodo(id);
  }

  /* ---------------- Project Memory ---------------- */

  listMemory(projectId: string): ProjectMemoryItemDto[] {
    if (!this.repository.get(projectId)) throw new Error(`项目不存在：${projectId}`);
    return this.memoryService
      .listExactScope("project", projectId, ["active", "superseded", "resolved"], 2000)
      .map((item) => kernelMemoryToProject(item, projectId));
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
    const project = this.requireWritableProject(request.projectId);
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
    return kernelMemoryToProject(this.memoryService.create({
      kind, title, content, status,
      importance: request.importance, confidence: source?.sourceType === "agent" ? 0.82 : 1,
      explicit: source?.sourceType !== "agent", sourceType: source?.sourceType === "agent" ? "agent" : "manual",
      sourceTaskId: source?.sourceTaskId, scopeType: "project", scopeId: request.projectId,
      metadata: { tags: normalizeMemoryTags(request.tags) }, evidence,
    }), request.projectId);
  }

  /**
   * 单项结构化更新（字段级比较，no-op 不写 DB、不 bump 版本）；
   * 真实变化经 Memory Kernel 落库，并同步推进 Project activity/version clock。
   */
  updateMemory(request: ProjectMemoryUpdateRequest): ProjectMemoryItemDto {
    this.requireWritableProject(request.projectId);
    const current = this.memoryService.get(request.id);
    const exactScope = current?.scopes.some(
      (scope) => scope.scopeType === "project" && scope.scopeId === request.projectId,
    );
    if (!current || !exactScope) throw new Error("记忆条目不存在");
    if (current.scopes.some((scope) => scope.scopeType !== "project" || scope.scopeId !== request.projectId)) {
      throw new Error("该记忆已共享到其他作用域，不能从项目页直接修改；请在统一记忆治理中修订");
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
    return kernelMemoryToProject(this.memoryService.update({
      id: request.id, kind, title, content,
      status, importance: request.importance, metadata: { ...current.metadata, tags },
      changedBy: "manual", changeReason: "project UI update",
    }), request.projectId);
  }

  /** 人手删除（UI/IPC）；Agent 工具不暴露 delete，过时用 superseded/resolved。缺省 id 幂等。 */
  deleteMemory(request: ProjectMemoryDeleteRequest): void {
    this.requireWritableProject(request.projectId);
    const current = this.memoryService.get(request.id);
    if (!current?.scopes.some((scope) => scope.scopeType === "project" && scope.scopeId === request.projectId)) return;
    this.memoryService.detachScope(request.id, "project", request.projectId);
  }

  searchMemory(projectId: string, query: string, limit = 20): ProjectMemoryItemDto[] {
    if (!this.repository.get(projectId)) throw new Error(`项目不存在：${projectId}`);
    return this.memoryService.search({
      projectId, scopeTypes: ["project"], includeInherited: false, query, statuses: ["active"], limit,
    }).map((hit) => kernelMemoryToProject(hit.memory, projectId));
  }

  /** 项目任务（cadence/派生共用；status/updatedAt/archived） */
  listTasksByProject(projectId: string): Array<{ id: string; title: string; status: string | null; updated_at: number; archived: number }> {
    return this.repository.listTasksByProject(projectId);
  }

  /* ---------------- Project Shared Context：pinned library refs ---------------- */

  /** 固定 Library 条目到项目上下文（只引用不复制）。personal 或本项目条目可 pin；跨项目拒绝。 */
  pinProjectItem(request: ProjectContextPinRequest): ProjectContextPinDto {
    const project = this.requireWritableProject(request.projectId);
    const existingPins = this.repository.listPins(request.projectId);
    if (existingPins.some((p) => p.itemId === request.itemId)) {
      return existingPins.find((p) => p.itemId === request.itemId)!;
    }
    if (existingPins.length >= PROJECT_PINS_MAX) {
      throw new Error(`项目固定资料已达上限（${PROJECT_PINS_MAX} 条），请先解除部分固定`);
    }
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

  unpinProjectItem(request: ProjectContextUnpinRequest): void {
    this.requireWritableProject(request.projectId);
    this.repository.deletePin(request.projectId, request.itemId);
  }

  listProjectPins(projectId: string): ProjectContextPinDto[] {
    return this.repository.listPins(projectId);
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
    const project = this.repository.get(projectId);
    if (!project) throw new Error(`项目不存在：${projectId}`);
    const staleAfter = now - 7 * 24 * 3600 * 1000;
    const tasks = this.repository.listTasksByProject(projectId);
    const todos = this.repository.listTodos(projectId);
    const memory = this.listMemory(projectId);
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
    const blockingOverdue = overdueTodos.filter((todo) => todo.status === "doing" && todo.priority === "high");
    const attentionOverdue = overdueTodos.filter((todo) => !blockingOverdue.some((blocking) => blocking.id === todo.id));

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

    const lastActivityAt = Math.max(
      project.updatedAt,
      ...tasks.map((t) => t.updated_at),
      ...todos.map((t) => t.updatedAt),
      ...memory.map((m) => m.updatedAt),
    );

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
  recordReview(projectId: string, note: string | undefined, createdBy: string): ProjectReviewDto {
    this.requireWritableProject(projectId);
    const cleanNote = note?.trim();
    if (cleanNote && cleanNote.length > PROJECT_REVIEW_NOTE_MAX_CHARS) {
      throw new Error(`review 备注不能超过 ${PROJECT_REVIEW_NOTE_MAX_CHARS} 字符`);
    }
    const review: ProjectReviewDto = {
      id: `prev_${randomUUID()}`,
      projectId,
      reviewedAt: Date.now(),
      note: cleanNote || undefined,
      createdBy,
    };
    this.repository.insertReview(review);
    return review;
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
    const snapshot = this.buildStatusSnapshot(projectId, now);
    if (snapshot.archived) return this.repository.listActionProposals(projectId);
    const owner = this.ownerName();
    const proposals: ProjectActionProposalDto[] = [];
    const todos = this.repository.listTodos(projectId);
    const tasks = this.repository.listTasksByProject(projectId);
    const memory = this.listMemory(projectId);

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
