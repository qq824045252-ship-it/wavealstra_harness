import type { ModeMcpPolicy, ModeSkillPolicy } from "./mode-profile";

export const DEFAULT_PROJECT_RESOURCE_BUDGET_CHARS = 128_000;
export const MIN_PROJECT_RESOURCE_BUDGET_CHARS = 8_000;
export const MAX_PROJECT_RESOURCE_BUDGET_CHARS = 256_000;

/** Long-lived product context. A Project never owns a Space or a Task lifecycle. */
export interface ProjectDto {
  /** New task folder preference; existing task bindings remain authoritative. */
  defaultSpaceId?: string;
  id: string;
  name: string;
  description?: string;
  instructions?: string;
  /** 项目长期目标/一句话定位（Shared Context：goal） */
  goal?: string;
  /** 当前阶段/状态（Shared Context：currentStage） */
  currentStage?: string;
  createdAt: number;
  updatedAt: number;
  /** Hidden from new selection; already-bound Tasks continue resolving this context. */
  archived?: boolean;
  /** 模板来源记录（project-template），可空，不参与 Runtime。 */
  templateId?: string;
  /** Maximum combined Project Resource characters injected into one runtime assembly. */
  resourceBudgetChars: number;
}

/** Candidate/eligibility policy for capabilities selected by id. */
export interface ProjectSelectionPolicyDto {
  allow: string[];
  deny: string[];
  recommended: string[];
}

export interface ProjectPoliciesDto {
  expert: ProjectSelectionPolicyDto;
  skill: ModeSkillPolicy;
  connector: ProjectSelectionPolicyDto;
  mcp: ModeMcpPolicy;
}

export type ProjectResourceKind = "text" | "file" | "url" | "folder";

export interface ProjectResourceDto {
  id: string;
  projectId: string;
  kind: ProjectResourceKind;
  title: string;
  /** Inline text, absolute file path, or http(s) URL depending on kind. */
  value: string;
  enabled: boolean;
  sortOrder: number;
  /** 文件夹内资源；根目录为空。 */
  parentId?: string;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectPostDto {
  id: string;
  projectId: string;
  body: string;
  createdAt: number;
}

export interface ProjectPostCreateRequest {
  projectId: string;
  body: string;
}

/** 计划待办：人手维护的事项，不是 Agent Task。 */
export type ProjectTodoStatus = "todo" | "doing" | "paused" | "done";
export type ProjectTodoPriority = "low" | "medium" | "high";

export interface ProjectTodoDto {
  id: string;
  projectId: string;
  title: string;
  description?: string;
  status: ProjectTodoStatus;
  assignee?: string;
  priority?: ProjectTodoPriority;
  tags: string[];
  startAt?: number;
  dueAt?: number;
  createdAt: number;
  updatedAt: number;
}

export interface ProjectTodoCreateRequest {
  projectId: string;
  title: string;
  description?: string;
  status?: ProjectTodoStatus;
  assignee?: string;
  priority?: ProjectTodoPriority;
  tags?: string[];
  startAt?: number;
  dueAt?: number;
}

export interface ProjectTodoUpdateRequest {
  id: string;
  title?: string;
  description?: string | null;
  status?: ProjectTodoStatus;
  assignee?: string | null;
  priority?: ProjectTodoPriority | null;
  tags?: string[];
  startAt?: number | null;
  dueAt?: number | null;
}

/** ProjectTodo title 长度上限（数据边界：service/DB 层强制，UI 与 Agent 工具均不可绕过） */
export const PROJECT_TODO_TITLE_MAX_CHARS = 500;

/* ---------------- Project Memory（项目级共享长期认知，Agent 可读写） ---------------- */

/** Memory 条目类型：已确认事实 / 决策 / 约束 / 风险 / 待解决问题 / 进度 */
export type ProjectMemoryKind = "fact" | "decision" | "constraint" | "risk" | "open_question" | "progress";
/** 生命周期：active=当前有效；superseded=已被后续条目取代；resolved=问题已解决/决策已过时 */
export type ProjectMemoryStatus = "active" | "superseded" | "resolved";
/** 来源：agent=Agent 工具写入（自动带 taskId）；manual=用户在项目页手动维护 */
export type ProjectMemorySourceType = "agent" | "manual";

export const PROJECT_MEMORY_KINDS: readonly ProjectMemoryKind[] = [
  "fact",
  "decision",
  "constraint",
  "risk",
  "open_question",
  "progress",
];
export const PROJECT_MEMORY_STATUSES: readonly ProjectMemoryStatus[] = [
  "active",
  "superseded",
  "resolved",
];

/** 数据边界（service/DB 层强制；Agent 工具 schema 复用同一常量） */
export const PROJECT_MEMORY_TITLE_MAX_CHARS = 200;
export const PROJECT_MEMORY_CONTENT_MAX_CHARS = 4000;
export const PROJECT_MEMORY_TAG_MAX_CHARS = 60;
export const PROJECT_MEMORY_MAX_TAGS = 20;

/** Agent 上下文注入的 Memory 摘要预算（不是全量 dump） */
export const PROJECT_MEMORY_ACTIVE_SLICE_MAX_ITEMS = 6;
export const PROJECT_MEMORY_ACTIVE_SLICE_MAX_CHARS = 900;

/** 证据引用类型：library=资料库条目；task=来源任务；artifact=任务产物；event=项目事件（提升溯源） */
export type ProjectMemoryEvidenceKind = "library" | "task" | "artifact" | "event";

export interface ProjectMemoryEvidenceDto {
  id: string;
  memoryId: string;
  evidenceKind: ProjectMemoryEvidenceKind;
  refId: string;
  /** 引用对象当前标题快照（可空：来源已删除 = evidence missing，memory 保留） */
  refTitle?: string;
  createdAt: number;
}

export interface ProjectMemoryItemDto {
  id: string;
  projectId: string;
  kind: ProjectMemoryKind;
  /** 简洁 subject：稳定识别与去重用 */
  title: string;
  /** 正文（允许比 title 长） */
  content: string;
  status: ProjectMemoryStatus;
  tags: string[];
  /** 0-3：重要度（0=默认；用于检索/上下文排序） */
  importance: number;
  /** agent 工具写入自动带 sourceType=agent + sourceTaskId；用户 UI 维护为 manual */
  sourceType: ProjectMemorySourceType;
  sourceTaskId?: string;
  /** 结构化证据引用（library/task/artifact）；不随引用对象删除而级联删 memory */
  evidence: ProjectMemoryEvidenceDto[];
  createdAt: number;
  updatedAt: number;
}

export interface ProjectMemoryCreateRequest {
  projectId: string;
  kind: ProjectMemoryKind;
  title: string;
  content?: string;
  status?: ProjectMemoryStatus;
  tags?: string[];
  importance?: number;
  /** 证据：library 条目 id（当前项目或经显式引用授权的旧资料） */
  evidenceItemIds?: string[];
  /** 证据：来源任务 id / 产物 id（工具层注入当前 task/artifact 时校验 scope） */
  evidenceTaskId?: string;
  evidenceArtifactIds?: string[];
  /** 证据：项目事件 id（提升溯源；必须属于当前 project，事件淘汰后证据保留） */
  evidenceEventId?: string;
}

export interface ProjectMemoryUpdateRequest {
  /** Main-process scope boundary: mutations must name the owning Project explicitly. */
  projectId: string;
  id: string;
  kind?: ProjectMemoryKind;
  title?: string;
  content?: string | null;
  status?: ProjectMemoryStatus;
  tags?: string[];
  importance?: number;
}

export interface ProjectMemoryDeleteRequest {
  projectId: string;
  id: string;
}

/** Agent 工具写入来源（主进程自动注入，不接受 Agent 伪造） */
export interface ProjectMemorySource {
  sourceType: ProjectMemorySourceType;
  sourceTaskId?: string;
}

/**
 * 项目共享长期认知的轻量摘要：按 kind/status 计数 + 预算内 active slice。
 * 完整内容不注入上下文，由 Agent 经 project_memory_* 工具按需读取（数据库实时）。
 */
export interface ProjectMemorySummaryDto {
  projectId: string;
  total: number;
  byKind: Record<ProjectMemoryKind, number>;
  byStatus: Record<ProjectMemoryStatus, number>;
  /** active 高价值项：decision/constraint/risk/open_question 优先，fact 其次（预算内） */
  active: ProjectMemoryItemDto[];
  budget: { maxItems: number; maxChars: number; includedChars: number };
}

const MEMORY_KIND_LABEL: Record<ProjectMemoryKind, string> = {
  fact: "事实",
  decision: "决策",
  constraint: "约束",
  risk: "风险",
  open_question: "待确认",
  progress: "进度",
};

/** Memory 条目单行紧凑渲染（resolver 预算 / 工具输出 / prompt 摘要共用字符口径） */
export function formatProjectMemoryLine(item: ProjectMemoryItemDto, contentLimit = 120): string {
  const meta: string[] = [];
  if (item.tags.length > 0) meta.push(`标签 ${item.tags.join(",")}`);
  if (item.sourceTaskId) meta.push(`来源任务 ${item.sourceTaskId}`);
  const content =
    item.content.length > contentLimit
      ? `${item.content.slice(0, contentLimit)}…`
      : item.content;
  const body = content ? `：${content}` : "";
  return `[${MEMORY_KIND_LABEL[item.kind]}] ${item.title}${body}（${item.status}${meta.length > 0 ? `，${meta.join("，")}` : ""}）id=${item.id}`;
}

/* ---------------- Project Plan（项目级共享计划，Agent 可读写） ---------------- */

/** Agent 上下文注入的共享计划 active slice 预算（不是完整 todo dump） */
export const PROJECT_PLAN_ACTIVE_SLICE_MAX_ITEMS = 6;
export const PROJECT_PLAN_ACTIVE_SLICE_MAX_CHARS = 900;

/**
 * 项目共享计划的轻量摘要：状态计数 + 预算内 active slice。
 * 完整列表不注入上下文，由 Agent 经 project_plan_* 工具按需读取（数据库实时）。
 */
export interface ProjectPlanSummaryDto {
  projectId: string;
  /** 计划总项数 */
  total: number;
  byStatus: Record<ProjectTodoStatus, number>;
  /** doing / 高优先 / 临近截止 的非完成项（预算内；不含 done） */
  active: ProjectTodoDto[];
  /** 预算参数（审计/测试用） */
  budget: { maxItems: number; maxChars: number; includedChars: number };
}

/** 本地日期（当地 0 点语义与 UI 一致，避免 toISOString 的 UTC 漂移） */
export function formatPlanLocalDate(ms: number): string {
  const date = new Date(ms);
  const mm = `${date.getMonth() + 1}`.padStart(2, "0");
  const dd = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${mm}-${dd}`;
}

/**
 * 计划项单行紧凑渲染。resolver（字符预算）/ 工具输出 / prompt 摘要共用，
 * 保证三处字符口径一致。
 */
export function formatProjectTodoLine(todo: ProjectTodoDto): string {
  const meta: string[] = [];
  if (todo.assignee) meta.push(`负责人 ${todo.assignee}`);
  if (todo.priority) meta.push(`优先级 ${todo.priority}`);
  if (todo.startAt) meta.push(`开始 ${formatPlanLocalDate(todo.startAt)}`);
  if (todo.dueAt) meta.push(`截止 ${formatPlanLocalDate(todo.dueAt)}`);
  if (todo.tags.length > 0) meta.push(`标签 ${todo.tags.join(",")}`);
  return `[${todo.status}] ${todo.title}${meta.length > 0 ? `（${meta.join("，")}）` : ""} id=${todo.id}`;
}

/**
 * Agent 计划工具日期入参归一化：毫秒时间戳或 "YYYY-MM-DD"（当地 0 点）。
 * null = 清除字段；undefined = 不涉及；非法输入抛错（由调用方转为受控错误）。
 */
export function parsePlanDateValue(value: number | string | null | undefined): number | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("日期参数必须是合法时间戳或 YYYY-MM-DD");
    return Math.round(value);
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value.trim());
  if (!match) throw new Error(`日期格式无效：${value}（应为 YYYY-MM-DD 或毫秒时间戳）`);
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) throw new Error(`日期越界：${value}`);
  // round-trip 严格校验：拒绝 2026-02-30 / 2026-04-31 等 JS Date 会静默滚动的语义非法日期；
  // 合法闰年日期（2028-02-29）正确通过。
  const date = new Date(year, month - 1, day);
  if (date.getFullYear() !== year || date.getMonth() !== month - 1 || date.getDate() !== day) {
    throw new Error(`日期越界：${value}`);
  }
  return date.getTime();
}

export interface ProjectResourceCreateRequest {
  projectId: string;
  kind: ProjectResourceKind;
  title: string;
  value: string;
  parentId?: string;
}

export interface ProjectResourceUpdateRequest {
  id: string;
  title?: string;
  value?: string;
  enabled?: boolean;
  sortOrder?: number;
  parentId?: string | null;
}

export type ProjectResourceHealthStatus =
  | "ready"
  | "disabled"
  | "missing"
  | "unreadable"
  | "binary"
  | "too-large"
  | "budget-exceeded";

export interface ProjectResourceHealthDto {
  resourceId: string;
  status: ProjectResourceHealthStatus;
  included: boolean;
  chars: number;
  bytes?: number;
  reason?: string;
}

export interface ProjectResourceInspectionDto {
  projectId: string;
  budgetChars: number;
  includedChars: number;
  checkedAt: number;
  items: ProjectResourceHealthDto[];
}

export interface ResolvedProjectResource {
  id: string;
  kind: ProjectResourceKind;
  title: string;
  content: string;
  source: "project-resource";
  sourceId: string;
}

export interface ProjectDetailsDto extends ProjectDto {
  policies: ProjectPoliciesDto;
  resources: ProjectResourceDto[];
}

/** 归档项目写拒绝的统一文案（library/context/memory 写工具共用） */
export const ARCHIVED_PROJECT_WRITE_GUIDANCE =
  "项目已归档（只读）：可以读取，但不能写入项目资料/上下文/记忆；独立任务也不提供个人资料库作为写入退路。";

/* ---------------- Project Autopilot：派生运行状态（非真源；源变化即重算） ---------------- */

/** review 备注长度上限（服务层强制；UI/工具同值） */
export const PROJECT_REVIEW_NOTE_MAX_CHARS = 500;

/* ---------------- Project Action Proposals（编排层建议：非业务真源，源变化即 stale/obsolete） ---------------- */

export type ProjectActionType =
  | "locate_task"
  | "locate_plan"
  | "update_plan_status"
  | "needs_confirmation";

export type ProjectActionProposalStatus = "proposed" | "applied" | "stale" | "obsolete";

export interface ProjectActionProposalDto {
  id: string;
  projectId: string;
  actionType: ProjectActionType;
  /** 建议动作人类可读标题（含目标对象与拟修改） */
  title: string;
  rationale: string;
  /** 来源引用（task/todo/memory id + 标题），生成时从快照固化 */
  sourceRefs: Array<{ source: "plan" | "task" | "memory"; refId: string; title: string }>;
  /** 当前生成器恒为 false；保留字段只为读取既有审计记录。建议层不可执行业务写入。 */
  executable: boolean;
  targetRef?: string;
  status: ProjectActionProposalStatus;
  /** 去重指纹（internal：actionType:targetRef） */
  fingerprint?: string;
  /** 生成者（internal） */
  createdBy?: string;
  createdAt: number;
  updatedAt: number;
  appliedAt?: number;
  appliedResult?: string;
}

/* ---------------- Project Attention（派生注意度：状态变化即广播，去重/可确认/自动收敛） ---------------- */

export interface ProjectAttentionDigestDto {
  projectId: string;
  /** 派生快照时刻 */
  generatedAt: number;
  health: ProjectHealthLevel;
  blockerCount: number;
  atRiskCount: number;
  /** 兼容展示字段；recommendation-only 运行时恒为 0。 */
  executableProposals: number;
  /** 仅建议/待确认数（needs_confirmation proposed） */
  needsConfirmation: number;
  proposalsTotal: number;
  /** 变化指纹（去重用：相同指纹不重复广播） */
  fingerprint: string;
  /** 用户是否已确认当前指纹（确认后不再高亮，状态变化后重新未确认） */
  seen: boolean;
}

export type ProjectHealthLevel = "green" | "yellow" | "red";

export interface ProjectStatusIssueDto {
  /** 来源类型：plan=计划项 / task=任务 / memory=项目记忆 */
  source: "plan" | "task" | "memory";
  refId: string;
  title: string;
  reason: string;
}

export interface ProjectNextActionDto {
  source: "plan" | "task";
  refId: string;
  title: string;
  dueAt?: number;
}

export interface ProjectStatusSnapshotDto {
  projectId: string;
  projectName: string;
  goal: string | null;
  currentStage: string | null;
  archived: boolean;
  health: ProjectHealthLevel;
  generatedAt: number;
  /** 源数据时间窗上限（max of project/tasks/todos/memory updatedAt） */
  lastActivityAt: number;
  /** 最近一次人工/Agent review（project_reviews 审计表；无则 null） */
  lastReviewedAt: number | null;
  tasks: { total: number; active: number; doing: number; stale: number };
  plan: { total: number; doing: number; overdue: number };
  memory: { openQuestions: number; risks: number };
  blockers: ProjectStatusIssueDto[];
  atRisks: ProjectStatusIssueDto[];
  nextActions: ProjectNextActionDto[];
}

/**
 * Project Event（外部输入入口层）：跨来源事件的统一落点/审计契约。
 * 事件是“输入/审计”层，不是业务真源（plan/todo/task/memory 仍为唯一真源）；
 * 派生层（snapshot/attention/proposal）不从事件取数，事件只触发既有重算收敛。
 */
export type ProjectEventSource = "gateway" | "cron" | "manual" | "document" | "mcp";
export type ProjectEventKind = "message" | "note" | "run" | "reminder" | "update";

/** 事件列表单次返回上限（IPC / repository / ingestor 同源钳制） */
export const PROJECT_EVENT_LIST_MAX_LIMIT = 200;
/** 每项目事件保留上限（审计层容量控制，超出按 created_at 淘汰最旧） */
export const PROJECT_EVENT_RETENTION_PER_PROJECT = 1000;

/* ---------------- Project Event（外部输入审计层；非业务真源） ---------------- */

/**
 * 事件 triage 状态（工作流元数据，绝不参与 snapshot/attention/autopilot 派生）。
 * - open：默认，待判断；
 * - dismissed：显式标记“已处理/无需动作”（人/Agent 调用 dismiss）。
 * 有效状态由消费方推导：handled = triageStatus==='dismissed' || 存在 promotion 链接。
 */
export type ProjectEventTriageStatus = "open" | "dismissed";

export interface ProjectEventDto {
  id: string;
  projectId: string;
  source: ProjectEventSource;
  kind: ProjectEventKind;
  /** ≤200 字符；显示用标题 */
  title: string;
  /** ≤4000 字符；正文（可为空） */
  body?: string;
  /** 来源引用（如 gateway messageId / cron runId）；不参与派生 */
  ref?: string;
  /** 附加结构化载荷（序列化后 ≤4096 字节）；不参与派生 */
  payload?: Record<string, unknown>;
  /** triage 工作流状态（默认 open；dismiss 幂等） */
  triageStatus: ProjectEventTriageStatus;
  createdAt: number;
  /** 提升审计链接（事件 → 已提升真实对象；list/read 时填充，无则缺省） */
  promotions?: ProjectEventPromotionDto[];
}

export interface ProjectEventCreateRequest {
  source: ProjectEventSource;
  kind: ProjectEventKind;
  title: string;
  body?: string;
  ref?: string;
  payload?: Record<string, unknown>;
}

/* ---------------- Project Event Promotion（显式提升：事件 → 项目真源） ---------------- */

/** 提升目标类型（支持范围基于现有 service 能力冻结：memory/todo/library） */
export type ProjectEventPromotionTargetKind = "memory" | "todo" | "library";
export type ProjectEventPromotedBy = "user" | "agent";

/**
 * 提升审计链接（事件 → 真实对象）。
 * - 不持有对 event 的 FK：事件滚动淘汰/删除后链接保留（target 永不被级联误删），
 *   eventTitle/targetTitle 为快照，事件侧追溯优雅退化；
 * - 每 (project, event, targetKind) 至多一条（UNIQUE，幂等兜底）；
 * - project_id FK 随项目删除级联（项目没了其事件与提升记录一并消失）。
 */
export interface ProjectEventPromotionDto {
  id: string;
  projectId: string;
  eventId: string;
  /** 事件标题快照（事件淘汰后仍可显示来源） */
  eventTitle: string;
  targetKind: ProjectEventPromotionTargetKind;
  targetId: string;
  /** 目标标题快照 */
  targetTitle?: string;
  promotedBy: ProjectEventPromotedBy;
  note?: string;
  createdAt: number;
}

export interface ProjectEventPromoteRequest {
  eventId: string;
  targetKind: ProjectEventPromotionTargetKind;
  /** 提升主体：UI/IPC 固定 user；Agent 工具固定 agent；缺省按 user 处理（不接受外部伪造） */
  promotedBy?: ProjectEventPromotedBy;
  /** memory 目标字段（targetKind=memory 必填 kind+title；其余可省） */
  memoryKind?: ProjectMemoryKind;
  memoryTitle?: string;
  memoryContent?: string;
  memoryTags?: string[];
  memoryImportance?: number;
  /** todo 目标字段（targetKind=todo 必填 title） */
  todoTitle?: string;
  todoDescription?: string;
  todoDueAt?: number;
  todoPriority?: ProjectTodoPriority;
  /** library 目标字段（targetKind=library 必填 title+content） */
  libraryTitle?: string;
  libraryContent?: string;
}

export interface ProjectEventPromoteResultDto {
  promotion: ProjectEventPromotionDto;
  targetKind: ProjectEventPromotionTargetKind;
  targetId: string;
  targetTitle?: string;
  /** 幂等：此前已提升过同类型 → 复用旧目标（不重复创建） */
  reused: boolean;
  /** 幂等复用但目标已被删除（不新建，避免垃圾；UI 显示降级） */
  targetMissing?: boolean;
}

/** 项目 review 记录（审计/派生标记：只影响 lastReviewedAt，不影响任何派生计算） */
export interface ProjectReviewDto {
  id: string;
  projectId: string;
  reviewedAt: number;
  note?: string;
  createdBy: string;
}

/* ---------------- Project Shared Context / Pinned Library Refs ---------------- */

/** 项目固定到上下文的 Library 条目（只引用不复制；item 删除/项目删除级联清理） */
export const PROJECT_PINS_MAX = 10;
/** Shared Context 字段长度上限（与 prompt 装配预算一致，写时即拒绝超限） */
export const PROJECT_CONTEXT_GOAL_MAX_CHARS = 300;
export const PROJECT_CONTEXT_STAGE_MAX_CHARS = 200;

export interface ProjectContextPinDto {
  id: string;
  projectId: string;
  itemId: string;
  /** 引用对象当前标题快照（展示用；item 删除后 pin 级联消失） */
  itemTitle?: string;
  itemKind?: string;
  note?: string;
  createdBy: string;
  createdAt: number;
}

export interface ProjectContextPinRequest {
  projectId: string;
  itemId: string;
  note?: string;
}

export interface ProjectContextUnpinRequest {
  projectId: string;
  itemId: string;
}

/** Shared Context 装配摘要（resolve 时从 DB 现读） */
export interface ProjectSharedContextSummary {
  projectId: string;
  goal: string | null;
  currentStage: string | null;
  instructions: string | null;
  pinned: ProjectContextPinDto[];
}

/* ---------------- Project Knowledge Retrieval（统一检索层 DTO） ---------------- */

/** 命中分层：task-explicit=本任务显式附加（最高优先，已单独注入） > pinned=项目固定引用 > plain=普通检索 */
export type KnowledgeHitTier = "task-explicit" | "pinned" | "plain";

/** 统一检索命中（结构化；不含绝对路径——路径只对二进制 read 按需给出） */
export interface ProjectKnowledgeHitDto {
  itemId: string;
  title: string;
  kind: string;
  spaceId: string;
  /** 文本类命中片段（≤300 字符）；非文本 = 空（绝不伪造已理解） */
  snippet: string;
  /** 0=exact 标题 < 1=prefix < 2=FTS 相关性 */
  rank: number;
  /** 语义分层（用于提示模型该引用是否已在上下文中，避免重复读取） */
  tier: KnowledgeHitTier;
  /** true = 文本类，可用 project_knowledge_read 内联读取；false = 需文件/预览工具 */
  readable: boolean;
  favorite: boolean;
  sourceType?: string;
  sourceTaskId?: string;
  sourceArtifactId?: string;
  updatedAt: number;
}

export interface ProjectKnowledgeSearchResultDto {
  taskId: string;
  /** 任务绑定项目；资料范围同时包含当前工作空间与显式引用 */
  projectId: string | null;
  scope: "project" | "workspace" | "personal" | "none";
  hits: ProjectKnowledgeHitDto[];
  /** 预算信息（审计/测试用） */
  budget: { requestedLimit: number; effectiveLimit: number };
}

/** Structured Project contribution consumed by agent assembly and policy resolution. */
export interface ResolvedProjectContext {
  project: ProjectDto;
  instructions: string | null;
  policies: ProjectPoliciesDto;
  resources: ResolvedProjectResource[];
  resourceWarnings: string[];
  /**
   * 项目共享计划轻量摘要（状态计数 + 预算内 active slice；非全量）。
   * 完整列表由 Agent 经 project_plan_* 工具按需读取；无计划项时 total=0。
   */
  planSummary: ProjectPlanSummaryDto | null;
  /**
   * 项目共享长期认知（Project Memory）轻量摘要（kind/status 计数 + 预算内 active slice）。
   * 完整内容由 Agent 经 project_memory_* 工具按需读取；无记忆项时 total=0。
   */
  /**
   * 项目长期显式上下文（goal/currentStage/instructions + pinned library refs）。
   * 与 Memory 分离：Shared Context = 显式配置；Memory = 提炼认知。
   */
  sharedContext: ProjectSharedContextSummary | null;
  /** Changes whenever the Project configuration changes. */
  version: string;
  source: "project";
  sourceId: string;
}

export interface ProjectCreateRequest {
  name: string;
  description?: string;
  instructions?: string;
  goal?: string;
  currentStage?: string;
  /** 模板来源记录（project-template），可空。 */
  templateId?: string;
  policies?: Partial<ProjectPoliciesDto>;
  resourceBudgetChars?: number;
}

export interface ProjectUpdateRequest {
  defaultSpaceId?: string | null;
  id: string;
  name?: string;
  description?: string | null;
  instructions?: string | null;
  goal?: string | null;
  currentStage?: string | null;
  policies?: Partial<ProjectPoliciesDto>;
  resourceBudgetChars?: number;
}

export interface ProjectFolderPreview {
  token: string;
  projectId: string;
  spaceId: string;
  oldPath: string;
  newPath: string;
  projectUpdatedAt: number;
  targetIdentity: string;
  artifacts?: Array<{ id: string; title: string; rootDir: string; fileCount: number; missingOriginal: boolean }>;
  folders?: Array<{ id: string; name: string; parentId?: string | null; archived?: boolean; oldPath: string; newPath: string; identity: string }>;
  affectedProjects?: Array<{ id: string; name: string; updatedAt: number; archived: boolean; defaultSpaceId?: string | null }>;
  tasks: Array<{ id: string; title: string; projectId?: string | null; spaceId?: string | null; newCwd?: string }>;
  references: Array<{ id: string; projectId?: string; title: string; oldPath: string; newPath: string; fingerprint: string; oldExists: boolean }>;
}

export interface ProjectDuplicateRequest {
  sourceId: string;
  /** Optional explicit name; omitted uses a unique “副本” suffix. */
  name?: string;
}

export type ProjectMutationResult =
  | { ok: true; project: ProjectDetailsDto }
  | { ok: false; error: string };

export function emptyProjectSelectionPolicy(): ProjectSelectionPolicyDto {
  return { allow: [], deny: [], recommended: [] };
}

export function emptyProjectPolicies(): ProjectPoliciesDto {
  return {
    expert: emptyProjectSelectionPolicy(),
    skill: { prefer: [], demote: [], hide: [], allow: [] },
    connector: emptyProjectSelectionPolicy(),
    mcp: { mode: "hard", allow: [], deny: [] },
  };
}
