import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import type { RuntimeAuditReader } from "../platform/runtime-audit";
import type { ProjectMemoryProjection, ProjectMutation, ProjectWriteDomain, ProjectWriteStatus } from "./ProjectMutation";
import {
  emptyProjectPolicies,
  PROJECT_EVENT_LIST_MAX_LIMIT,
  PROJECT_EVENT_RETENTION_PER_PROJECT,
  type ProjectContextPinDto,
  type ProjectDetailsDto,
  type ProjectDto,
  type ProjectActionProposalDto,
  type ProjectActionProposalStatus,
  type ProjectActionType,
  type ProjectPoliciesDto,
  type ProjectPostDto,
  type ProjectEventDto,
  type ProjectEventKind,
  type ProjectEventSource,
  type ProjectEventPromotedBy,
  type ProjectEventPromotionDto,
  type ProjectEventPromotionTargetKind,
  type ProjectEventTriageStatus,
  type ProjectResourceDto,
  type ProjectReviewDto,
  type ProjectStatusSnapshotDto,
  type ProjectTodoDto,
  type ProjectTodoPriority,
  type ProjectTodoStatus,
} from "../../shared/project-domain";

interface ProjectRow {
  id: string;
  name: string;
  description: string | null;
  instructions: string | null;
  goal: string | null;
  current_stage: string | null;
  created_at: number;
  updated_at: number;
  archived: number;
  resource_budget_chars: number;
  template_id: string | null;
  default_space_id: string | null;
}

type EventRow = {
  id: string;
  project_id: string;
  source: string;
  kind: string;
  title: string;
  body: string | null;
  ref: string | null;
  payload_json: string;
  triage_status: string;
  created_at: number;
};

export type RuntimeProjectEventRequest =
  | { kind: "read"; eventId: string }
  | { kind: "triage"; projectId: string; eventId: string; triageStatus: ProjectEventTriageStatus };

export type RuntimeProjectEventReply =
  | { status: "found"; event: EventRow }
  | { status: "missingProject" | "missingEvent" | "archived" | "needsHost" }
  | { status: "rejected"; message: string };

export type RuntimeProjectPostRequest =
  | { kind: "list"; projectId: string }
  | { kind: "create"; post: ProjectPostDto }
  | { kind: "delete"; id: string };

export type RuntimeProjectPostReply =
  | { status: "listed"; posts: ProjectPostDto[] }
  | { status: "saved" | "archived" | "needsHost" }
  | { status: "rejected"; message: string };

export type RuntimeProjectPinRequest =
  | { kind: "list"; projectId: string }
  | { kind: "pin"; projectId: string; itemId: string; id: string; note?: string; createdAt: number }
  | { kind: "unpin"; projectId: string; itemId: string };

export type RuntimeProjectPinReply =
  | { status: "listed"; pins: ProjectContextPinDto[] }
  | { status: "pinned"; pin: ProjectContextPinDto }
  | { status: "removed" | "archived" | "needsHost" }
  | { status: "rejected"; message: string };

export interface ProjectStatusFact {
  kind: "blockingOverdue" | "overdue" | "nearDue" | "staleTask" | "activeRisk" | "importantQuestion";
  refId: string;
  title: string;
  dueAt?: number;
}

export interface ProjectStatusData {
  status: Omit<ProjectStatusSnapshotDto, "blockers" | "atRisks" | "nextActions"> & {
    blockers: ProjectStatusFact[];
    atRisks: ProjectStatusFact[];
    nextActions: Array<Omit<ProjectStatusSnapshotDto["nextActions"][number], "dueAt"> & { dueAt?: number | null }>;
  };
  proposalsTotal: number;
  needsConfirmation: number;
}

interface ProjectResourceRow {
  id: string;
  project_id: string;
  kind: "text" | "file" | "url" | "folder";
  title: string;
  value: string;
  enabled: number;
  sort_order: number;
  parent_id: string | null;
  created_at: number;
  updated_at: number;
}

type ProjectPolicyColumns = Record<
  | "expert_allow" | "expert_deny" | "expert_recommended"
  | "skill_allow" | "skill_prefer" | "skill_demote" | "skill_hide"
  | "connector_allow" | "connector_deny" | "connector_recommended" | "mcp_mode" | "mcp_allow" | "mcp_deny",
  string | null
>;

function mapResourceRow(row: ProjectResourceRow): ProjectResourceDto {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    title: row.title,
    value: row.value,
    enabled: Boolean(row.enabled),
    sortOrder: row.sort_order,
    parentId: row.parent_id ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseTodoStatus(value: string): ProjectTodoStatus {
  if (value === "doing" || value === "paused" || value === "done") return value;
  return "todo";
}

function parseTodoPriority(value: string | null): ProjectTodoPriority | undefined {
  if (value === "low" || value === "medium" || value === "high") return value;
  return undefined;
}

function mapTodoRow(row: {
  id: string;
  project_id: string;
  title: string;
  description: string | null;
  status: string;
  assignee: string | null;
  priority: string | null;
  tags_json: string;
  start_at: number | null;
  due_at: number | null;
  created_at: number;
  updated_at: number;
}): ProjectTodoDto {
  return {
    id: row.id,
    projectId: row.project_id,
    title: row.title,
    description: row.description ?? undefined,
    status: parseTodoStatus(row.status),
    assignee: row.assignee ?? undefined,
    priority: parseTodoPriority(row.priority),
    tags: parseList(row.tags_json),
    startAt: row.start_at ?? undefined,
    dueAt: row.due_at ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function parseList(value: string | null | undefined): string[] {
  if (!value) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: string | null | undefined): Record<string, unknown> {
  if (!value) return {};
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function mapEventRow(row: EventRow): ProjectEventDto {
  return {
    id: row.id,
    projectId: row.project_id,
    source: row.source as ProjectEventSource,
    kind: row.kind as ProjectEventKind,
    title: row.title,
    body: row.body ?? undefined,
    ref: row.ref ?? undefined,
    payload: parseJsonObject(row.payload_json),
    triageStatus: row.triage_status as ProjectEventTriageStatus,
    createdAt: row.created_at,
  };
}

interface PromotionRow {
  id: string;
  project_id: string;
  event_id: string;
  event_title: string;
  target_kind: string;
  target_id: string;
  target_title: string | null;
  promoted_by: string;
  note: string | null;
  created_at: number;
}

function mapPromotionRow(row: PromotionRow): ProjectEventPromotionDto {
  return {
    id: row.id,
    projectId: row.project_id,
    eventId: row.event_id,
    eventTitle: row.event_title,
    targetKind: row.target_kind as ProjectEventPromotionTargetKind,
    targetId: row.target_id,
    targetTitle: row.target_title ?? undefined,
    promotedBy: row.promoted_by as ProjectEventPromotedBy,
    note: row.note ?? undefined,
    createdAt: row.created_at,
  };
}

function mapProject(row: ProjectRow): ProjectDto {
  return {
    id: row.id,
    defaultSpaceId: row.default_space_id ?? undefined,
    name: row.name,
    description: row.description ?? undefined,
    instructions: row.instructions ?? undefined,
    goal: row.goal ?? undefined,
    currentStage: row.current_stage ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archived: Boolean(row.archived),
    templateId: row.template_id ?? undefined,
    resourceBudgetChars: row.resource_budget_chars,
  };
}

type ProjectDetailsRows = { project: ProjectRow & ProjectPolicyColumns; resources: ProjectResourceRow[] };
type ProjectContextRows = ProjectDetailsRows & { todos: Array<Parameters<typeof mapTodoRow>[0]>; pins: ProjectContextPinDto[] };
type ProjectContextSnapshot = { project: ProjectDetailsDto; todos: ProjectTodoDto[]; pins: ProjectContextPinDto[] };

export type ProjectContextWitness = { enabledResourceIds: string[]; pinnedItemIds: string[] };

function mapProjectDetails(data: ProjectDetailsRows): ProjectDetailsDto {
  const row = data.project;
  return {
    ...mapProject(row), resources: data.resources.map(mapResourceRow),
    policies: {
      expert: { allow: parseList(row.expert_allow), deny: parseList(row.expert_deny), recommended: parseList(row.expert_recommended) },
      skill: { allow: parseList(row.skill_allow), prefer: parseList(row.skill_prefer), demote: parseList(row.skill_demote), hide: parseList(row.skill_hide) },
      connector: { allow: parseList(row.connector_allow), deny: parseList(row.connector_deny), recommended: parseList(row.connector_recommended) },
      mcp: { mode: row.mcp_mode === "soft" ? "soft" : "hard", allow: parseList(row.mcp_allow), deny: parseList(row.mcp_deny) },
    },
  };
}

export class ProjectRepository {
  constructor(private readonly fixture: Database.Database | undefined, private readonly runtimeAuditReader?: RuntimeAuditReader) {}

  private get db(): Database.Database {
    if (!this.fixture) throw new Error("此项目操作需要通过 Rust Core 执行");
    return this.fixture;
  }

  validatedDefaultSpacePath(id: string): string {
    if (typeof id !== "string" || !id.trim()) throw new Error("请选择有效的项目文件夹");
    const rows = this.db.prepare(`WITH RECURSIVE chain AS (
      SELECT id, parent_id, archived, path FROM spaces WHERE id = ?
      UNION SELECT s.id, s.parent_id, s.archived, s.path FROM spaces s JOIN chain c ON s.id = c.parent_id
    ) SELECT * FROM chain`).all(id) as Array<{ archived: number; path: string | null }>;
    if (!rows.length || rows.some((row) => row.archived) || !rows[0].path) throw new Error("项目文件夹不存在、已归档或未关联磁盘目录");
    try { if (!statSync(rows[0].path).isDirectory()) throw new Error(); }
    catch { throw new Error("项目文件夹路径不可用，请重新关联目录"); }
    return rows[0].path;
  }

  get requiresRustWrites(): boolean {
    return !this.fixture || Boolean(this.fixture.readonly || this.runtimeAuditReader?.supervised);
  }

  supportsNativeWrites(kind: ProjectWriteDomain = "project"): Promise<boolean> {
    if (!this.runtimeAuditReader) return Promise.resolve(false);
    if (this.fixture?.inTransaction) {
      if (this.requiresRustWrites) return Promise.reject(new Error(`Project write (${kind}) cannot run inside a host SQLite transaction when Rust owns writes`));
      return Promise.resolve(false);
    }
    return this.runtimeAuditReader.supportsProjectWrites(kind);
  }

  readWriteSnapshot<T>(read: () => T): T { return this.db.transaction(read)(); }

  memoryRevision(id: string): number {
    return this.db.prepare("SELECT coalesce(max(revision),0) FROM memory_revisions WHERE memory_id=?").pluck().get(id) as number;
  }

  readMemoryList(projectId: string) {
    return this.runtimeAuditReader?.projectMetadata<ProjectMemoryProjection[] | null>({ kind: "memories", projectId });
  }

  readMemoryWithdrawal(projectId: string, id: string) {
    return this.runtimeAuditReader?.readProjectWithdrawal(projectId, id);
  }

  async writeProject(mutation: ProjectMutation): Promise<ProjectWriteStatus> {
    const operationId = randomUUID();
    const reader = this.runtimeAuditReader;
    if (!reader) throw new Error("项目写入需要 Rust Core");
    try {
      return await reader.writeProject(operationId, mutation);
    } catch (error) {
      const committed = await reader.projectMetadata<boolean>({ kind: "writeReceipt", operationId });
      if (committed) return "changed";
      throw error;
    }
  }

  list(includeArchived = false): ProjectDto[] {
    const rows = this.db
      .prepare(
        `SELECT id, name, description, instructions, goal, current_stage, created_at, updated_at, archived, resource_budget_chars, template_id, default_space_id
         FROM projects
         ${includeArchived ? "" : "WHERE archived = 0"}
         ORDER BY updated_at DESC`,
      )
      .all() as ProjectRow[];
    return rows.map(mapProject);
  }

  async readList(includeArchived = false): Promise<ProjectDto[]> {
    const rows = await this.runtimeAuditReader?.projectMetadata<ProjectRow[]>({ kind: "list", includeArchived });
    if (rows) return rows.map(mapProject);
    if (!this.fixture) throw new Error("项目列表读取未获 Rust Core 确认");
    return this.list(includeArchived);
  }

  readStatus(projectId: string, now: number): Promise<ProjectStatusData | null | undefined> | undefined {
    if (!Number.isSafeInteger(now)) return undefined;
    return this.runtimeAuditReader?.projectMetadata<ProjectStatusData | null>({ kind: "status", projectId, now });
  }

  get(id: string): ProjectDetailsDto | undefined {
    const project = this.getSummary(id);
    return project ? { ...project, policies: this.getPolicies(id), resources: this.listResources(id) } : undefined;
  }

  async readDetails(id: string): Promise<ProjectDetailsDto | undefined> {
    const data = await this.runtimeAuditReader?.projectMetadata<ProjectDetailsRows | null>({ kind: "details", projectId: id });
    if (data === undefined) {
      if (!this.fixture || this.runtimeAuditReader?.supervised) throw new Error("项目详情读取未获 Rust Core 确认");
      return this.get(id);
    }
    return data ? mapProjectDetails(data) : undefined;
  }

  async readContextSnapshot(projectId: string): Promise<ProjectContextSnapshot | null> {
    const data = await this.runtimeAuditReader?.projectMetadata<ProjectContextRows | null>({ kind: "contextSnapshot", projectId });
    if (data !== undefined) {
      return data ? { project: mapProjectDetails(data), todos: data.todos.map(mapTodoRow), pins: data.pins } : null;
    }
    if (!this.fixture || this.runtimeAuditReader?.supervised) throw new Error("项目上下文读取未获 Rust Core 确认");
    return this.readWriteSnapshot(() => {
      const project = this.get(projectId);
      return project ? { project, todos: this.listTodos(projectId), pins: this.listPins(projectId) } : null;
    });
  }

  async readContextWitness(projectId: string): Promise<ProjectContextWitness | null> {
    const data = await this.runtimeAuditReader?.projectMetadata<ProjectContextWitness | null>({ kind: "contextWitness", projectId });
    if (data !== undefined) return data;
    if (!this.fixture || this.runtimeAuditReader?.supervised) throw new Error("项目引用状态读取未获 Rust Core 确认");
    return this.readWriteSnapshot(() => this.getSummary(projectId) ? {
      enabledResourceIds: this.listResources(projectId).filter((resource) => resource.enabled).map((resource) => resource.id),
      pinnedItemIds: this.listPins(projectId).map((pin) => pin.itemId),
    } : null);
  }

  getSummary(id: string): ProjectDto | undefined {
    const row = this.db
      .prepare(
        `SELECT id, name, description, instructions, goal, current_stage, created_at, updated_at, archived, resource_budget_chars, template_id, default_space_id
         FROM projects WHERE id = ?`,
      )
      .get(id) as ProjectRow | undefined;
    return row ? mapProject(row) : undefined;
  }

  findByName(name: string): ProjectDto | undefined {
    const row = this.db
      .prepare(
        `SELECT id, name, description, instructions, goal, current_stage, created_at, updated_at, archived, resource_budget_chars, template_id, default_space_id
         FROM projects WHERE name = ? COLLATE NOCASE LIMIT 1`,
      )
      .get(name) as ProjectRow | undefined;
    return row ? mapProject(row) : undefined;
  }

  create(project: ProjectDto, policies: ProjectPoliciesDto): ProjectDetailsDto {
    return this.createWithResources(project, policies, []);
  }

  createWithResources(
    project: ProjectDto,
    policies: ProjectPoliciesDto,
    resources: ProjectResourceDto[],
  ): ProjectDetailsDto {
    this.db.transaction(() => {
      this.db
        .prepare(
          `INSERT INTO projects
             (id, name, description, instructions, goal, current_stage, created_at, updated_at, archived, resource_budget_chars, template_id, default_space_id)
           VALUES (@id, @name, @description, @instructions, @goal, @currentStage, @createdAt, @updatedAt, @archived, @resourceBudgetChars, @templateId, @defaultSpaceId)`,
        )
        .run({
          id: project.id,
          name: project.name,
          description: project.description ?? null,
          instructions: project.instructions ?? null,
          goal: project.goal ?? null,
          currentStage: project.currentStage ?? null,
          createdAt: project.createdAt,
          updatedAt: project.updatedAt,
          archived: project.archived ? 1 : 0,
          defaultSpaceId: project.defaultSpaceId ?? null,
          resourceBudgetChars: project.resourceBudgetChars,
          templateId: project.templateId ?? null,
        });
      this.writePolicies(project.id, policies);
      const insertResource = this.db.prepare(
        `INSERT INTO project_resources
           (id, project_id, kind, title, value, enabled, sort_order, parent_id, created_at, updated_at)
         VALUES (@id, @projectId, @kind, @title, @value, @enabled, @sortOrder, @parentId, @createdAt, @updatedAt)`,
      );
      resources.forEach((resource) => insertResource.run({
        ...resource,
        enabled: resource.enabled ? 1 : 0,
        parentId: resource.parentId ?? null,
      }));
    })();
    return { ...project, policies, resources };
  }

  update(
    project: ProjectDto,
    policies?: ProjectPoliciesDto,
  ): ProjectDetailsDto {
    this.db.transaction(() => {
      this.db
        .prepare(
          `UPDATE projects
           SET name = @name, description = @description, instructions = @instructions,
               goal = @goal, current_stage = @currentStage,
               updated_at = @updatedAt, archived = @archived,
               default_space_id = @defaultSpaceId, resource_budget_chars = @resourceBudgetChars
           WHERE id = @id`,
        )
        .run({
          id: project.id,
          name: project.name,
          description: project.description ?? null,
          instructions: project.instructions ?? null,
          goal: project.goal ?? null,
          currentStage: project.currentStage ?? null,
          updatedAt: project.updatedAt,
          archived: project.archived ? 1 : 0,
          defaultSpaceId: project.defaultSpaceId ?? null,
          resourceBudgetChars: project.resourceBudgetChars,
        });
      if (policies) this.writePolicies(project.id, policies);
    })();
    return { ...project, policies: policies ?? this.getPolicies(project.id), resources: this.listResources(project.id) };
  }

  archive(id: string, archived: boolean, updatedAt: number): ProjectDetailsDto | undefined {
    this.db
      .prepare("UPDATE projects SET archived = ?, updated_at = ? WHERE id = ?")
      .run(archived ? 1 : 0, updatedAt, id);
    return this.get(id);
  }

  /** Project is context only: deletion unbinds Tasks and never touches their lifecycle data. */
  delete(id: string): void {
    // Capture plan ids before cascade (for work_graph_edges cleanup)
    let planIds: string[] = [];
    try {
      planIds = (this.db.prepare("SELECT id FROM project_todos WHERE project_id = ?").all(id) as Array<{ id: string }>).map((r) => r.id);
    } catch {}
    this.db.transaction(() => {
      this.db.prepare("UPDATE tasks SET project_id = NULL WHERE project_id = ?").run(id);
      this.db.prepare("DELETE FROM project_expert_policy WHERE project_id = ?").run(id);
      this.db.prepare("DELETE FROM project_skill_policy WHERE project_id = ?").run(id);
      this.db.prepare("DELETE FROM project_connector_policy WHERE project_id = ?").run(id);
      this.db.prepare("DELETE FROM project_mcp_policy WHERE project_id = ?").run(id);
      this.db.prepare("DELETE FROM project_resources WHERE project_id = ?").run(id);
      this.db.prepare("DELETE FROM project_posts WHERE project_id = ?").run(id);
      this.db.prepare("DELETE FROM project_todos WHERE project_id = ?").run(id);
      this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
    })();
    try {
      const del = this.db.prepare(`DELETE FROM work_graph_edges WHERE (from_type='plan' AND from_id=?) OR (to_type='plan' AND to_id=?) OR (from_type='project' AND from_id=?) OR (to_type='project' AND to_id=?)`);
      for (const pid of planIds) del.run(pid, pid, id, id);
      // dedup: one extra run for project itself if no planIds
      if (planIds.length === 0) del.run(id, id, id, id);
      // Also cleanup task edges referencing this project's tasks? Those tasks keep their id, scope cleanup handled by deleteTask.
    } catch {}
  }

  getPolicies(projectId: string): ProjectPoliciesDto {
    const fallback = emptyProjectPolicies();
    const expert = this.db
      .prepare("SELECT allow_json, deny_json, recommended_json FROM project_expert_policy WHERE project_id = ?")
      .get(projectId) as { allow_json: string; deny_json: string; recommended_json: string } | undefined;
    const skill = this.db
      .prepare("SELECT prefer_json, demote_json, hide_json, allow_json FROM project_skill_policy WHERE project_id = ?")
      .get(projectId) as { prefer_json: string; demote_json: string; hide_json: string; allow_json: string } | undefined;
    const connector = this.db
      .prepare("SELECT allow_json, deny_json, recommended_json FROM project_connector_policy WHERE project_id = ?")
      .get(projectId) as { allow_json: string; deny_json: string; recommended_json: string } | undefined;
    const mcp = this.db
      .prepare("SELECT mode, allow_json, deny_json FROM project_mcp_policy WHERE project_id = ?")
      .get(projectId) as { mode: string; allow_json: string; deny_json: string } | undefined;
    return {
      expert: expert
        ? {
            allow: parseList(expert.allow_json),
            deny: parseList(expert.deny_json),
            recommended: parseList(expert.recommended_json),
          }
        : fallback.expert,
      skill: skill
        ? {
            prefer: parseList(skill.prefer_json),
            demote: parseList(skill.demote_json),
            hide: parseList(skill.hide_json),
            allow: parseList(skill.allow_json),
          }
        : fallback.skill,
      connector: connector
        ? {
            allow: parseList(connector.allow_json),
            deny: parseList(connector.deny_json),
            recommended: parseList(connector.recommended_json),
          }
        : fallback.connector,
      mcp: mcp
        ? {
            mode: mcp.mode === "soft" ? "soft" : "hard",
            allow: parseList(mcp.allow_json),
            deny: parseList(mcp.deny_json),
          }
        : fallback.mcp,
    };
  }

  listResources(projectId: string): ProjectResourceDto[] {
    const rows = this.db.prepare(
      `SELECT id, project_id, kind, title, value, enabled, sort_order, parent_id, created_at, updated_at
       FROM project_resources WHERE project_id = ? ORDER BY sort_order ASC, created_at ASC, id ASC`,
    ).all(projectId) as ProjectResourceRow[];
    return rows.map(mapResourceRow);
  }

  createResource(resource: ProjectResourceDto): ProjectResourceDto {
    this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO project_resources
           (id, project_id, kind, title, value, enabled, sort_order, parent_id, created_at, updated_at)
         VALUES (@id, @projectId, @kind, @title, @value, @enabled, @sortOrder, @parentId, @createdAt, @updatedAt)`,
      ).run({ ...resource, enabled: resource.enabled ? 1 : 0, parentId: resource.parentId ?? null });
      this.db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(resource.updatedAt, resource.projectId);
    })();
    return resource;
  }

  updateResource(resource: ProjectResourceDto): ProjectResourceDto {
    this.db.transaction(() => {
      this.db.prepare(
        `UPDATE project_resources SET title = @title, value = @value,
         enabled = @enabled, sort_order = @sortOrder, parent_id = @parentId, updated_at = @updatedAt WHERE id = @id`,
      ).run({
        ...resource,
        enabled: resource.enabled ? 1 : 0,
        parentId: resource.parentId ?? null,
      });
      this.db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(resource.updatedAt, resource.projectId);
    })();
    return resource;
  }

  getResource(id: string): ProjectResourceDto | undefined {
    const row = this.db.prepare(
      `SELECT id, project_id, kind, title, value, enabled, sort_order, parent_id, created_at, updated_at
       FROM project_resources WHERE id = ?`,
    ).get(id) as ProjectResourceRow | undefined;
    return row ? mapResourceRow(row) : undefined;
  }

  listPosts(projectId: string): ProjectPostDto[] {
    const rows = this.db.prepare(
      `SELECT id, project_id, body, created_at FROM project_posts
       WHERE project_id = ? ORDER BY created_at DESC, id DESC`,
    ).all(projectId) as Array<{ id: string; project_id: string; body: string; created_at: number }>;
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      body: row.body,
      createdAt: row.created_at,
    }));
  }

  async requestProjectPosts(request: RuntimeProjectPostRequest): Promise<RuntimeProjectPostReply | undefined> {
    const fields = request.kind === "create" ? [request.post.projectId, request.post.body]
      : [request.kind === "list" ? request.projectId : request.id];
    const invalidWire = fields.some(value => typeof value !== "string" || /[\uD800-\uDFFF]/u.test(value));
    if (!this.runtimeAuditReader || this.fixture?.inTransaction || invalidWire) {
      if (request.kind !== "list" && this.requiresRustWrites) {
        return { status: "rejected", message: invalidWire ? "留言内容包含不支持的代理字符，无法保存" : "项目数据库当前仅允许 Rust 写入" };
      }
      return { status: "needsHost" };
    }
    return this.runtimeAuditReader.projectPosts(request);
  }

  commitWriteOnHost<T>(write: () => T): T {
    if (this.requiresRustWrites) throw new Error("Project database writes are owned by the Rust core");
    return this.db.transaction(write).immediate();
  }

  createPost(post: ProjectPostDto): ProjectPostDto {
    this.db.prepare(
      `INSERT INTO project_posts (id, project_id, body, created_at) VALUES (?, ?, ?, ?)`,
    ).run(post.id, post.projectId, post.body, post.createdAt);
    return post;
  }

  getPost(id: string): ProjectPostDto | undefined {
    const row = this.db.prepare(
      "SELECT id, project_id, body, created_at FROM project_posts WHERE id = ?",
    ).get(id) as { id: string; project_id: string; body: string; created_at: number } | undefined;
    return row ? { id: row.id, projectId: row.project_id, body: row.body, createdAt: row.created_at } : undefined;
  }

  deletePost(id: string): void {
    this.db.prepare("DELETE FROM project_posts WHERE id = ?").run(id);
  }

  /* ---------------- Project Events（外部输入审计层；非业务真源） ---------------- */

  listProjectEvents(projectId: string, limit = 50): ProjectEventDto[] {
    const clamped = Math.max(1, Math.min(limit, PROJECT_EVENT_LIST_MAX_LIMIT));
    const rows = this.db.prepare(
      `SELECT id, project_id, source, kind, title, body, ref, payload_json, triage_status, created_at
       FROM project_events WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT ?`,
    ).all(projectId, clamped) as EventRow[];
    return this.mapEventPage(rows, this.listProjectEventPromotions(projectId, rows.map(event => event.id)));
  }

  async readProjectEvents(projectId: string, limit = 50): Promise<ProjectEventDto[] | undefined> {
    const clamped = Math.max(1, Math.min(limit, PROJECT_EVENT_LIST_MAX_LIMIT));
    const native = Number.isSafeInteger(clamped) ? await this.runtimeAuditReader?.projectMetadata<{
      events: EventRow[];
      promotions: Array<Parameters<typeof mapPromotionRow>[0]>;
    } | null>({ kind: "events", projectId, limit: clamped }) : undefined;
    if (native === null) return undefined;
    if (native) return this.mapEventPage(native.events, native.promotions.map(mapPromotionRow));
    return this.getSummary(projectId) ? this.listProjectEvents(projectId, limit) : undefined;
  }

  private mapEventPage(rows: EventRow[], promotions: ProjectEventPromotionDto[]): ProjectEventDto[] {
    const events = rows.map(mapEventRow);
    // 填充提升审计链接（事件 → 已提升真实对象）
    if (promotions.length > 0) {
      const byEvent = new Map<string, ProjectEventPromotionDto[]>();
      for (const promotion of promotions) {
        const entries = byEvent.get(promotion.eventId);
        if (entries) entries.push(promotion);
        else byEvent.set(promotion.eventId, [promotion]);
      }
      for (const event of events) {
        event.promotions = byEvent.get(event.id) ?? [];
      }
    }
    return events;
  }

  /** 同 (project, source, ref) 幂等查找（ingest 去重；ref 可选） */
  findProjectEventByRef(projectId: string, source: string, ref: string): ProjectEventDto | undefined {
    const row = this.db
      .prepare(
        `SELECT id, project_id, source, kind, title, body, ref, payload_json, triage_status, created_at
         FROM project_events WHERE project_id = ? AND source = ? AND ref = ? LIMIT 1`,
      )
      .get(projectId, source, ref) as EventRow | undefined;
    return row && mapEventRow(row);
  }

  /** 事件所属项目（提升/证据作用域校验；无则 undefined） */
  getProjectEventScope(eventId: string): string | undefined {
    const row = this.db.prepare(`SELECT project_id FROM project_events WHERE id = ?`).get(eventId) as
      | { project_id: string }
      | undefined;
    return row?.project_id;
  }

  getProjectEventTitle(eventId: string): string | undefined {
    const row = this.db.prepare(`SELECT title FROM project_events WHERE id = ?`).get(eventId) as
      | { title: string }
      | undefined;
    return row?.title;
  }

  getProjectEventById(eventId: string): ProjectEventDto | undefined {
    const row = this.db
      .prepare(
        `SELECT id, project_id, source, kind, title, body, ref, payload_json, triage_status, created_at
         FROM project_events WHERE id = ? LIMIT 1`,
      )
      .get(eventId) as EventRow | undefined;
    return row && mapEventRow(row);
  }

  async readProjectEventById(eventId: string): Promise<ProjectEventDto | undefined> {
    const reply = await this.requestProjectEvent({ kind: "read", eventId });
    if (reply?.status === "found") return mapEventRow(reply.event);
    if (reply?.status === "missingEvent") return;
    if (reply?.status === "rejected") throw new Error(reply.message);
    return this.getProjectEventById(eventId);
  }

  async writeProjectEventTriage(
    projectId: string,
    eventId: string,
    triageStatus: ProjectEventTriageStatus,
  ): Promise<ProjectEventDto | "missingProject" | "missingEvent" | "archived" | "needsHost" | undefined> {
    const reply = await this.requestProjectEvent({ kind: "triage", projectId, eventId, triageStatus });
    if (reply?.status === "rejected") throw new Error(reply.message);
    return reply?.status === "found" ? mapEventRow(reply.event) : reply?.status;
  }

  private async requestProjectEvent(request: RuntimeProjectEventRequest): Promise<RuntimeProjectEventReply | undefined> {
    const ids = request.kind === "triage" ? [request.projectId, request.eventId] : [request.eventId];
    if (!this.runtimeAuditReader || this.fixture?.inTransaction ||
        ids.some(id => typeof id !== "string" || /[\uD800-\uDFFF]/u.test(id))) {
      if (request.kind === "triage" && this.requiresRustWrites) {
        throw new Error("事件处理状态写入仅允许通过 Rust 核心完成");
      }
      return { status: "needsHost" };
    }
    return this.runtimeAuditReader.projectEventData(request);
  }

  /**
   * triage 状态（工作流元数据；不参与任何派生）：项目作用域内幂等更新。
   * 返回 false 表示事件不存在或不属于该项目。
   */
  setProjectEventTriage(projectId: string, eventId: string, status: ProjectEventTriageStatus): boolean {
    const result = this.db
      .prepare(`UPDATE project_events SET triage_status = ? WHERE id = ? AND project_id = ?`)
      .run(status, eventId, projectId);
    return result.changes > 0;
  }

  /* ---------------- Project Event Promotions（提升审计链接；非业务真源） ---------------- */

  findProjectEventPromotion(
    projectId: string,
    eventId: string,
    targetKind: ProjectEventPromotionTargetKind,
  ): ProjectEventPromotionDto | undefined {
    const row = this.db
      .prepare(
        `SELECT id, project_id, event_id, event_title, target_kind, target_id, target_title, promoted_by, note, created_at
         FROM project_event_promotions WHERE project_id = ? AND event_id = ? AND target_kind = ? LIMIT 1`,
      )
      .get(projectId, eventId, targetKind) as {
      id: string;
      project_id: string;
      event_id: string;
      event_title: string;
      target_kind: string;
      target_id: string;
      target_title: string | null;
      promoted_by: string;
      note: string | null;
      created_at: number;
    } | undefined;
    return row ? mapPromotionRow(row) : undefined;
  }

  /** 幂等插入：UNIQUE(project_id, event_id, target_kind) 冲突时返回已存在行；其他错误如实抛出 */
  insertProjectEventPromotion(promotion: ProjectEventPromotionDto): ProjectEventPromotionDto {
    try {
      this.db
        .prepare(
          `INSERT INTO project_event_promotions
             (id, project_id, event_id, event_title, target_kind, target_id, target_title, promoted_by, note, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          promotion.id,
          promotion.projectId,
          promotion.eventId,
          promotion.eventTitle,
          promotion.targetKind,
          promotion.targetId,
          promotion.targetTitle ?? null,
          promotion.promotedBy,
          promotion.note ?? null,
          promotion.createdAt,
        );
      return promotion;
    } catch (err) {
      // 仅 UNIQUE 冲突（并发/重试已插入同链接）走幂等返回；其余错误不得静默吞掉
      const existing = this.findProjectEventPromotion(promotion.projectId, promotion.eventId, promotion.targetKind);
      if (existing) return existing;
      throw err;
    }
  }

  insertTodoPromotionOnHost(todo: ProjectTodoDto, promotion: ProjectEventPromotionDto, sourceTaskId?: string): ProjectWriteStatus {
    return this.insertPromotionOnHost(promotion, () => this.createTodo(todo), sourceTaskId);
  }

  insertPromotionOnHost(promotion: ProjectEventPromotionDto, createTarget: () => void, sourceTaskId?: string): ProjectWriteStatus {
    const { projectId, targetKind } = promotion;
    return this.db.transaction((): ProjectWriteStatus => {
      if (sourceTaskId && !this.isTaskInProject(sourceTaskId, projectId)) return "scopeChanged";
      const project = this.getSummary(projectId);
      if (!project) return "missing";
      if (project.archived) return "archived";
      const event = this.getProjectEventById(promotion.eventId);
      if (!event || event.projectId !== projectId) return "missingEvent";
      if (this.findProjectEventPromotion(projectId, event.id, targetKind)) return "existingPromotion";
      createTarget();
      this.insertProjectEventPromotion({ ...promotion, eventTitle: event.title });
      if (this.findProjectEventPromotion(projectId, event.id, targetKind)?.id !== promotion.id) {
        throw new Error("项目事件与目标的关联写入失败");
      }
      return "changed";
    }).immediate();
  }

  /** 批量取事件提升链接（事件列表填充用；events 空 → []） */
  listProjectEventPromotions(projectId: string, eventIds: string[]): ProjectEventPromotionDto[] {
    if (eventIds.length === 0) return [];
    const placeholders = eventIds.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `SELECT id, project_id, event_id, event_title, target_kind, target_id, target_title, promoted_by, note, created_at
         FROM project_event_promotions WHERE project_id = ? AND event_id IN (${placeholders})
         ORDER BY created_at ASC`,
      )
      .all(projectId, ...eventIds) as Array<{
      id: string;
      project_id: string;
      event_id: string;
      event_title: string;
      target_kind: string;
      target_id: string;
      target_title: string | null;
      promoted_by: string;
      note: string | null;
      created_at: number;
    }>;
    return rows.map(mapPromotionRow);
  }

  insertProjectEvent(event: ProjectEventDto): ProjectEventDto {
    this.db.prepare(
      `INSERT INTO project_events (id, project_id, source, kind, title, body, ref, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      event.id,
      event.projectId,
      event.source,
      event.kind,
      event.title,
      event.body ?? null,
      event.ref ?? null,
      JSON.stringify(event.payload ?? {}),
      event.createdAt,
    );
    // 容量控制：每项目只保留最近 N 条（审计层，超出淘汰最旧）；
    // 自身插入保护：本次新事件绝不因自己的剪枝被删（时间戳回拨/跨时钟场景下 ingest 仍保证可见）
    this.db
      .prepare(
        `DELETE FROM project_events WHERE project_id = ? AND id != ? AND id NOT IN (
           SELECT id FROM project_events WHERE project_id = ?
           ORDER BY created_at DESC, id DESC LIMIT ?
         )`,
      )
      .run(event.projectId, event.id, event.projectId, PROJECT_EVENT_RETENTION_PER_PROJECT);
    return event;
  }

  listTodos(projectId: string): ProjectTodoDto[] {
    const rows = this.db.prepare(
      `SELECT id, project_id, title, description, status, assignee, priority, tags_json, start_at, due_at, created_at, updated_at
       FROM project_todos WHERE project_id = ? ORDER BY updated_at DESC, id DESC`,
    ).all(projectId) as Array<{
      id: string;
      project_id: string;
      title: string;
      description: string | null;
      status: string;
      assignee: string | null;
      priority: string | null;
      tags_json: string;
      start_at: number | null;
      due_at: number | null;
      created_at: number;
      updated_at: number;
    }>;
    return rows.map(mapTodoRow);
  }

  async readTodos(projectId: string): Promise<ProjectTodoDto[] | undefined> {
    const rows = await this.runtimeAuditReader?.projectMetadata<Array<Parameters<typeof mapTodoRow>[0]> | null>({
      kind: "todos", projectId,
    });
    if (rows === null) return undefined;
    if (rows !== undefined) return rows.map(mapTodoRow);
    if (!this.fixture || this.runtimeAuditReader?.supervised) throw new Error("项目待办读取未获 Rust Core 确认");
    return this.getSummary(projectId) ? this.listTodos(projectId) : undefined;
  }

  getTodo(id: string): ProjectTodoDto | undefined {
    const row = this.db.prepare(
      `SELECT id, project_id, title, description, status, assignee, priority, tags_json, start_at, due_at, created_at, updated_at
       FROM project_todos WHERE id = ?`,
    ).get(id) as Parameters<typeof mapTodoRow>[0] | undefined;
    return row ? mapTodoRow(row) : undefined;
  }

  async readTodo(id: string): Promise<ProjectTodoDto | undefined> {
    const row = await this.runtimeAuditReader?.projectMetadata<Parameters<typeof mapTodoRow>[0] | null>({ kind: "todo", id });
    if (row === undefined) return this.getTodo(id);
    return row ? mapTodoRow(row) : undefined;
  }

  readNextCadenceBoundary(projectId: string, now: number): Promise<number | null | undefined> | undefined {
    return this.runtimeAuditReader?.projectMetadata<number | null>({ kind: "nextBoundary", projectId, now });
  }

  isTaskInProject(taskId: string, projectId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM tasks WHERE id=? AND project_id=?").get(taskId, projectId));
  }

  createTodo(todo: ProjectTodoDto): ProjectTodoDto {
    this.db.transaction(() => {
      const result = this.db.prepare(
        `INSERT INTO project_todos (
           id, project_id, title, description, status, assignee, priority, tags_json, start_at, due_at, created_at, updated_at
         ) VALUES (
           @id, @projectId, @title, @description, @status, @assignee, @priority, @tagsJson, @startAt, @dueAt, @createdAt, @updatedAt
         )`,
      ).run({
        id: todo.id,
        projectId: todo.projectId,
        title: todo.title,
        description: todo.description ?? null,
        status: todo.status,
        assignee: todo.assignee ?? null,
        priority: todo.priority ?? null,
        tagsJson: JSON.stringify(todo.tags),
        startAt: todo.startAt ?? null,
        dueAt: todo.dueAt ?? null,
        createdAt: todo.createdAt,
        updatedAt: todo.updatedAt,
      });
      if (result.changes !== 1) throw new Error("项目计划项写入失败");
      // 计划是项目级共享 Agent 状态：变更必须驱动项目上下文版本（projects.updated_at），
      // 使绑定任务的下次装配重建（assemblyChanged/fingerprint）拿到最新计划摘要。
      this.bumpProjectUpdatedAt(todo.projectId, todo.updatedAt);
    })();
    return todo;
  }

  updateTodo(todo: ProjectTodoDto): ProjectTodoDto {
    this.db.transaction(() => {
      this.db.prepare(
        `UPDATE project_todos SET
           title = @title, description = @description, status = @status, assignee = @assignee,
           priority = @priority, tags_json = @tagsJson, start_at = @startAt, due_at = @dueAt, updated_at = @updatedAt
         WHERE id = @id`,
      ).run({
        id: todo.id,
        title: todo.title,
        description: todo.description ?? null,
        status: todo.status,
        assignee: todo.assignee ?? null,
        priority: todo.priority ?? null,
        tagsJson: JSON.stringify(todo.tags),
        startAt: todo.startAt ?? null,
        dueAt: todo.dueAt ?? null,
        updatedAt: todo.updatedAt,
      });
      this.bumpProjectUpdatedAt(todo.projectId, todo.updatedAt);
    })();
    return todo;
  }

  deleteTodo(id: string): void {
    const row = this.db.prepare("SELECT project_id FROM project_todos WHERE id = ?").get(id) as
      | { project_id: string }
      | undefined;
    if (!row) return;
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM project_todos WHERE id = ?").run(id);
      this.db.prepare(`DELETE FROM work_graph_edges WHERE (from_type='plan' AND from_id=?) OR (to_type='plan' AND to_id=?)`).run(id, id);
      this.bumpProjectUpdatedAt(row.project_id, Date.now());
    })();
  }

  /** 单调递增地 bump 项目 updated_at（并发写也不回退版本） */
  private bumpProjectUpdatedAt(projectId: string, now: number): void {
    this.db
      .prepare("UPDATE projects SET updated_at = MAX(updated_at + 1, ?) WHERE id = ?")
      .run(now, projectId);
  }

  /* ---------------- Project Memory evidence scope validation ---------------- */

  /** 校验 task 存在且其 project 为空或等于目标项目（evidence scope） */
  getTaskProjectScope(taskId: string): { projectId: string | null } | null {
    const row = this.db
      .prepare(`SELECT project_id FROM tasks WHERE id = ?`)
      .get(taskId) as { project_id: string | null } | undefined;
    return row ? { projectId: row.project_id } : null;
  }

  /** 校验 artifact 存在且其 task 的 project 为空或等于目标项目（evidence scope） */
  getArtifactProjectScope(artifactId: string): { projectId: string | null } | null {
    const row = this.db
      .prepare(
        `SELECT t.project_id FROM artifacts a
         LEFT JOIN tasks t ON t.id = a.task_id
         WHERE a.id = ?`,
      )
      .get(artifactId) as { project_id: string | null } | undefined;
    return row ? { projectId: row.project_id } : null;
  }

  /* ---------------- Project Shared Context Pins ---------------- */

  /** 条目所属空间作用域（pin/evidence 校验用：personal 或 projectId 匹配才可引用） */
  getLibraryItemScope(itemId: string): { spaceId: string; projectId: string | null } | null {
    const row = this.db
      .prepare(
        `SELECT i.space_id, s.kind, s.project_id
         FROM library_items i
         LEFT JOIN library_spaces s ON s.id = i.space_id
         WHERE i.id = ?`,
      )
      .get(itemId) as { space_id: string; kind: string; project_id: string | null } | undefined;
    if (!row) return null;
    if (row.kind === "personal") return { spaceId: row.space_id, projectId: null };
    return { spaceId: row.space_id, projectId: row.project_id };
  }

  getLibraryItemTitle(itemId: string): { title: string; kind: string } | null {
    const row = this.db
      .prepare(`SELECT title, kind FROM library_items WHERE id = ?`)
      .get(itemId) as { title: string; kind: string } | undefined;
    return row ?? null;
  }

  getSoulName(): string | null {
    try {
      const row = this.db.prepare(`SELECT name FROM soul WHERE id = 1`).get() as { name: string } | undefined;
      return row?.name ?? null;
    } catch {
      return null;
    }
  }

  /* ---------------- Project Autopilot：派生运行状态的数据源 ---------------- */

  /** 项目绑定的任务（status/updatedAt/archived；派生快照用，非新真源） */
  listTasksByProject(projectId: string): Array<{ id: string; title: string; status: string | null; updated_at: number; archived: number }> {
    return this.db
      .prepare(
        `SELECT id, title, status, updated_at, archived FROM tasks WHERE project_id = ?`,
      )
      .all(projectId) as Array<{ id: string; title: string; status: string | null; updated_at: number; archived: number }>;
  }

  listStatusMemories(projectId: string): Array<{
    id: string; title: string; kind: string; status: string; importance: number; updatedAt: number;
  }> {
    const rows = this.db.prepare(
      `SELECT m.id,m.title,m.kind,m.status,m.importance,m.updated_at AS updatedAt
       FROM memory_records m JOIN memory_scopes s ON s.memory_id=m.id
       WHERE s.scope_type='project' AND s.scope_id=? AND m.status IN ('active','superseded','resolved')
       ORDER BY m.importance DESC,m.explicit DESC,m.updated_at DESC LIMIT 2000`,
    ).all(projectId) as ReturnType<ProjectRepository["listStatusMemories"]>;
    const byId = new Map(rows.map(row => [row.id, row]));
    return [...byId.values()];
  }

  insertReview(review: ProjectReviewDto): void {
    this.db
      .prepare(
        `INSERT INTO project_reviews (id, project_id, reviewed_at, note, created_by)
         VALUES (@id, @projectId, @reviewedAt, @note, @createdBy)`,
      )
      .run({ ...review, note: review.note ?? null });
  }

  listReviews(projectId: string, limit = 5): ProjectReviewDto[] {
    return (
      this.db
        .prepare(
          `SELECT id, project_id, reviewed_at, note, created_by
           FROM project_reviews WHERE project_id = ? ORDER BY reviewed_at DESC LIMIT ?`,
        )
        .all(projectId, limit) as Array<{
        id: string;
        project_id: string;
        reviewed_at: number;
        note: string | null;
        created_by: string;
      }>
    ).map((row) => ({
      id: row.id,
      projectId: row.project_id,
      reviewedAt: row.reviewed_at,
      note: row.note ?? undefined,
      createdBy: row.created_by,
    }));
  }

  /* ---------------- Project Action Proposals（编排层建议持久化；非业务真源） ---------------- */

  listActionProposals(projectId: string): ProjectActionProposalDto[] {
    return (
      this.db
        .prepare(
          `SELECT id, project_id, action_type, title, rationale, source_refs_json, executable, target_ref,
                  status, fingerprint, created_by, created_at, updated_at, applied_at, applied_result
           FROM project_action_proposals WHERE project_id = ?
           ORDER BY CASE status WHEN 'proposed' THEN 0 WHEN 'stale' THEN 1 WHEN 'applied' THEN 2 ELSE 3 END, updated_at DESC`,
        )
        .all(projectId) as Array<{
        id: string;
        project_id: string;
        action_type: string;
        title: string;
        rationale: string;
        source_refs_json: string;
        executable: number;
        target_ref: string | null;
        status: string;
        fingerprint: string;
        created_by: string;
        created_at: number;
        updated_at: number;
        applied_at: number | null;
        applied_result: string | null;
      }>
    ).map((row) => ({
      id: row.id,
      projectId: row.project_id,
      actionType: row.action_type as ProjectActionType,
      title: row.title,
      rationale: row.rationale,
      sourceRefs: parseList(row.source_refs_json) as unknown as ProjectActionProposalDto["sourceRefs"],
      executable: Boolean(row.executable),
      targetRef: row.target_ref ?? undefined,
      status: row.status as ProjectActionProposalStatus,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      appliedAt: row.applied_at ?? undefined,
      appliedResult: row.applied_result ?? undefined,
    }));
  }

  getActionProposal(projectId: string, proposalId: string): ProjectActionProposalDto | null {
    return (
      this.listActionProposals(projectId).find((p) => p.id === proposalId) ?? null
    );
  }

  /** 按指纹幂等 upsert：已 applied 保持 applied（不复活）；proposed/stale/obsolete 按需刷新 */
  upsertActionProposal(proposal: ProjectActionProposalDto): void {
    this.db
      .prepare(
        `INSERT INTO project_action_proposals (
           id, project_id, action_type, title, rationale, source_refs_json, executable, target_ref,
           status, fingerprint, created_by, created_at, updated_at, applied_at, applied_result
         ) VALUES (
           @id, @projectId, @actionType, @title, @rationale, @sourceRefsJson, @executable, @targetRef,
           @status, @fingerprint, @createdBy, @createdAt, @updatedAt, @appliedAt, @appliedResult
         )
         ON CONFLICT(project_id, fingerprint) DO UPDATE SET
           action_type = excluded.action_type,
           title = excluded.title,
           rationale = excluded.rationale,
           source_refs_json = excluded.source_refs_json,
           executable = excluded.executable,
           target_ref = excluded.target_ref,
           status = CASE
             WHEN project_action_proposals.status = 'applied' THEN 'applied'
             ELSE excluded.status
           END,
           updated_at = excluded.updated_at`,
      )
      .run({
        ...proposal,
        executable: proposal.executable ? 1 : 0,
        sourceRefsJson: JSON.stringify(proposal.sourceRefs),
        appliedAt: proposal.appliedAt ?? null,
        appliedResult: proposal.appliedResult ?? null,
      });
  }

  updateActionProposalStatus(projectId: string, proposalId: string, status: ProjectActionProposalStatus, appliedResult?: string): void {
    this.db
      .prepare(
        `UPDATE project_action_proposals SET status = ?, applied_result = ?, applied_at = ?, updated_at = ?
         WHERE id = ? AND project_id = ?`,
      )
      .run(status, appliedResult ?? null, status === "applied" ? Date.now() : null, Date.now(), proposalId, projectId);
  }

  async requestProjectPins(request: RuntimeProjectPinRequest): Promise<RuntimeProjectPinReply | undefined> {
    const fields = [request.projectId];
    if (request.kind !== "list") fields.push(request.itemId);
    if (request.kind === "pin" && request.note !== undefined) fields.push(request.note);
    const invalidWire = fields.some(value => typeof value !== "string" || /[\uD800-\uDFFF]/u.test(value));
    if (!this.runtimeAuditReader || this.fixture?.inTransaction || invalidWire) {
      if (request.kind !== "list" && this.requiresRustWrites) {
        return { status: "rejected", message: invalidWire ? "固定资料内容包含不支持的代理字符，无法保存" : "项目数据库当前仅允许 Rust 写入" };
      }
      return { status: "needsHost" };
    }
    return this.runtimeAuditReader.projectPins(request);
  }

  listPins(projectId: string): ProjectContextPinDto[] {
    return (
      this.db
        .prepare(
          `SELECT p.id, p.project_id, p.item_id, p.note, p.created_by, p.created_at,
                  i.title AS item_title, i.kind AS item_kind
           FROM project_context_pins p
           LEFT JOIN library_items i ON i.id = p.item_id
           WHERE p.project_id = ?
           ORDER BY p.created_at DESC`,
        )
        .all(projectId) as Array<{
        id: string;
        project_id: string;
        item_id: string;
        note: string | null;
        created_by: string;
        created_at: number;
        item_title: string | null;
        item_kind: string | null;
      }>
    ).map((row) => ({
      id: row.id,
      projectId: row.project_id,
      itemId: row.item_id,
      itemTitle: row.item_title ?? undefined,
      itemKind: row.item_kind ?? undefined,
      note: row.note ?? undefined,
      createdBy: row.created_by,
      createdAt: row.created_at,
    }));
  }

  insertPin(pin: {
    id: string;
    projectId: string;
    itemId: string;
    note?: string;
    createdBy: string;
    createdAt: number;
  }): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO project_context_pins (id, project_id, item_id, note, created_by, created_at)
         VALUES (@id, @projectId, @itemId, @note, @createdBy, @createdAt)`,
      )
      .run({ ...pin, note: pin.note ?? null });
  }

  deletePin(projectId: string, itemId: string): void {
    this.db
      .prepare(`DELETE FROM project_context_pins WHERE project_id = ? AND item_id = ?`)
      .run(projectId, itemId);
  }

  deleteResource(id: string, projectId: string, updatedAt: number): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM project_resources WHERE id = ?").run(id);
      this.db.prepare("UPDATE projects SET updated_at = ? WHERE id = ?").run(updatedAt, projectId);
    })();
  }

  private writePolicies(projectId: string, policies: ProjectPoliciesDto): void {
    this.db
      .prepare(
        `INSERT INTO project_expert_policy (project_id, allow_json, deny_json, recommended_json)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET
           allow_json = excluded.allow_json,
           deny_json = excluded.deny_json,
           recommended_json = excluded.recommended_json`,
      )
      .run(projectId, JSON.stringify(policies.expert.allow), JSON.stringify(policies.expert.deny), JSON.stringify(policies.expert.recommended));
    this.db
      .prepare(
        `INSERT INTO project_skill_policy (project_id, prefer_json, demote_json, hide_json, allow_json)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET
           prefer_json = excluded.prefer_json,
           demote_json = excluded.demote_json,
           hide_json = excluded.hide_json,
           allow_json = excluded.allow_json`,
      )
      .run(projectId, JSON.stringify(policies.skill.prefer), JSON.stringify(policies.skill.demote), JSON.stringify(policies.skill.hide), JSON.stringify(policies.skill.allow));
    this.db
      .prepare(
        `INSERT INTO project_connector_policy (project_id, allow_json, deny_json, recommended_json)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET
           allow_json = excluded.allow_json,
           deny_json = excluded.deny_json,
           recommended_json = excluded.recommended_json`,
      )
      .run(projectId, JSON.stringify(policies.connector.allow), JSON.stringify(policies.connector.deny), JSON.stringify(policies.connector.recommended));
    this.db
      .prepare(
        `INSERT INTO project_mcp_policy (project_id, mode, allow_json, deny_json)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET
           mode = excluded.mode,
           allow_json = excluded.allow_json,
           deny_json = excluded.deny_json`,
      )
      .run(projectId, policies.mcp.mode, JSON.stringify(policies.mcp.allow), JSON.stringify(policies.mcp.deny));
  }
}






