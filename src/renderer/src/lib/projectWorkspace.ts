import type { ProjectPoliciesDto } from "@shared/project-domain";

export const PROJECT_WORKSPACE_TABS = [
  "activity",
  "health",
  "plan",
  "memory",
  "notes",
  "tasks",
  "assets",
  "capabilities",
  "settings",
] as const;

export type ProjectWorkspaceTab = (typeof PROJECT_WORKSPACE_TABS)[number];

export const PROJECT_PRIMARY_TABS = ["activity", "health", "plan", "tasks", "notes", "memory", "assets"] as const;

export const PROJECT_WORKSPACE_TAB_LABELS: Record<ProjectWorkspaceTab, string> = {
  health: "健康",
  activity: "概览",
  plan: "计划",
  memory: "记忆",
  notes: "便签",
  tasks: "任务",
  assets: "资料",
  capabilities: "能力",
  settings: "设置",
};

export const PROJECT_WORKSPACE_TAB_HINTS: Record<ProjectWorkspaceTab, string> = {
  health: "项目健康与待办建议",
  activity: "项目留言、事件与最近动态",
  plan: "共享计划与日程",
  memory: "项目长期认知：事实、决策、约束、风险",
  notes: "项目共享 Markdown 便签，项目内任务可读取和修改",
  tasks: "绑定本项目的任务",
  assets: "项目资料、常用引用、补充参考与实际使用记录",
  capabilities: "项目能力策略",
  settings: "项目设置",
};

export function normalizeProjectWorkspaceTab(value: string | null | undefined): ProjectWorkspaceTab {
  if (value === "overview") return "activity";
  if (value === "context" || value === "library") return "assets";
  if (value && (PROJECT_WORKSPACE_TABS as readonly string[]).includes(value)) {
    return value as ProjectWorkspaceTab;
  }
  return "activity";
}

export type ProjectArchiveFilter = "active" | "archived";
export type ProjectTaskStatusFilter = "all" | "active" | "done";

export interface ProjectSearchFields {
  name: string;
  description?: string;
}

export interface ProjectTaskListItem {
  id: string;
  projectId?: string;
  title: string;
  status?: string;
  archived?: boolean;
  updatedAt: number;
  startAt?: number;
  dueAt?: number;
}

export function isProjectWorkspaceTab(value: string): value is ProjectWorkspaceTab {
  return (PROJECT_WORKSPACE_TABS as readonly string[]).includes(value);
}

export function filterProjectsByQuery<T extends ProjectSearchFields>(
  projects: readonly T[],
  query: string,
): T[] {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return [...projects];
  return projects.filter(
    (project) =>
      project.name.toLowerCase().includes(normalized) ||
      (project.description?.toLowerCase().includes(normalized) ?? false),
  );
}

export function matchesArchiveFilter(
  archived: boolean | undefined,
  filter: ProjectArchiveFilter,
): boolean {
  return filter === "archived" ? Boolean(archived) : !archived;
}

export function projectTasksFor<T extends { projectId?: string }>(
  tasks: readonly T[],
  projectId: string,
): T[] {
  return tasks.filter((task) => task.projectId === projectId);
}

export function projectTaskCount(
  tasks: readonly { projectId?: string }[],
  projectId: string,
): number {
  return projectTasksFor(tasks, projectId).length;
}

export function filterProjectTasks<T extends ProjectTaskListItem>(
  tasks: readonly T[],
  projectId: string,
  options: { query?: string; status?: ProjectTaskStatusFilter } = {},
): T[] {
  const normalized = options.query?.trim().toLowerCase() ?? "";
  const status = options.status ?? "all";
  return projectTasksFor(tasks, projectId)
    .filter((task) => {
      // 删除 = 回收站（archived）。归档/回收的任务不出现在项目任务列表。
      if (task.archived) return false;
      if (status === "active") return task.status !== "completed";
      if (status === "done") return task.status === "completed";
      return true;
    })
    .filter((task) => !normalized || task.title.toLowerCase().includes(normalized))
    .sort((left, right) => right.updatedAt - left.updatedAt);
}

export function recentProjectTasks<T extends ProjectTaskListItem>(
  tasks: readonly T[],
  projectId: string,
  limit = 5,
): T[] {
  return filterProjectTasks(tasks, projectId).slice(0, Math.max(1, limit));
}

export interface ProjectTaskCrumb {
  projectId: string;
  projectName: string;
  taskTitle: string;
}

/** 绑定了项目的任务才出面包屑：项目 / 项目名 / 任务名 */
export function resolveProjectTaskCrumb(input: {
  projectId?: string | null;
  projectName?: string | null;
  taskTitle?: string | null;
}): ProjectTaskCrumb | null {
  const projectId = input.projectId?.trim();
  if (!projectId) return null;
  return {
    projectId,
    projectName: input.projectName?.trim() || "项目",
    taskTitle: input.taskTitle?.trim() || "任务",
  };
}

export function projectActivityAt(
  projectUpdatedAt: number,
  tasks: readonly { projectId?: string; updatedAt: number }[],
  projectId: string,
): number {
  return projectTasksFor(tasks, projectId).reduce(
    (latest, task) => Math.max(latest, task.updatedAt),
    projectUpdatedAt,
  );
}

/**
 * 首页「最近时间」唯一入口：项目自身 updatedAt 与其绑定任务的最大 updatedAt 取大。
 * 其他 projectId 的任务不计入。组件层不要重复实现此逻辑。
 */
export function resolveProjectLastActivityAt(
  project: { id: string; updatedAt: number },
  tasks: readonly { projectId?: string; updatedAt: number }[],
): number {
  return projectActivityAt(project.updatedAt, tasks, project.id);
}

export function formatRelativeTime(timestamp: number, now = Date.now()): string {
  const diff = now - timestamp;
  if (diff < 45_000) return "刚刚";
  if (diff < 60 * 60_000) {
    const minutes = Math.max(1, Math.floor(diff / 60_000));
    return `${minutes} 分钟前`;
  }
  if (diff < 24 * 60 * 60_000) {
    const hours = Math.max(1, Math.floor(diff / (60 * 60_000)));
    return hours === 1 ? "1 小时前" : `${hours} 小时前`;
  }

  const startOfToday = new Date(now);
  startOfToday.setHours(0, 0, 0, 0);
  if (timestamp >= startOfToday.getTime()) return "今天";
  const startOfYesterday = startOfToday.getTime() - 24 * 60 * 60_000;
  if (timestamp >= startOfYesterday) return "昨天";

  const date = new Date(timestamp);
  return `${date.getMonth() + 1}月${date.getDate()}日`;
}

export function summarizeProjectCapabilities(policies: ProjectPoliciesDto): {
  experts: number;
  skills: number;
  connectors: number;
  mcp: number;
} {
  return {
    experts: uniqueCount(policies.expert.allow, policies.expert.recommended, policies.expert.deny),
    skills: uniqueCount(
      policies.skill.allow,
      policies.skill.prefer,
      policies.skill.demote,
      policies.skill.hide,
    ),
    connectors: uniqueCount(
      policies.connector.allow,
      policies.connector.recommended,
      policies.connector.deny,
    ),
    mcp: uniqueCount(policies.mcp.allow, policies.mcp.deny),
  };
}

export function lockProjectTaskCreate(projectId: string): {
  projectId: string;
  projectLocked: true;
} {
  return { projectId, projectLocked: true };
}

export function workspaceAfterCreate(projectId: string): {
  activeProjectId: string;
  activeProjectTab: ProjectWorkspaceTab;
} {
  return { activeProjectId: projectId, activeProjectTab: "activity" };
}

export function workspaceAfterProjectRemoved(
  activeProjectId: string | null,
  removedProjectId: string,
): string | null {
  return activeProjectId === removedProjectId ? null : activeProjectId;
}

export type ProjectNavDestination =
  | { type: "tab"; tab: ProjectWorkspaceTab }
  | { type: "project-list" }
  | { type: "project"; projectId: string; tab?: ProjectWorkspaceTab }
  /** Rail 内部动作：Detail → Summary / Collapse。dirty 时同样走 Unsaved Guard（§7/§22） */
  | { type: "rail-back" }
  | { type: "rail-collapse" }
  /** §13/§14：Connector/MCP 全局管理入口（全局 Hub 页），dirty 时同样走 Unsaved Guard */
  | { type: "page"; page: "connectors" | "mcp" };

export interface ProjectUnsavedGuard {
  dirty: boolean;
  save: () => Promise<void>;
  discard: () => void;
}

export type ProjectGuardKey = "pane" | "rail";

export type ProjectGuardDecision = "proceed" | "prompt";
export type UnsavedGuardAction = "cancel" | "discard" | "save";
export type UnsavedGuardResult = "stay" | "navigate" | "stay-error";

export function sameProjectFormValue(left: unknown, right: unknown): boolean {
  return stableSerialize(left) === stableSerialize(right);
}

export function decideProjectNavigation(dirty: boolean): ProjectGuardDecision {
  return dirty ? "prompt" : "proceed";
}

/**
 * §7：主 Tab（概览/健康/计划/任务/记忆/资料）切换不触发 Rail Guard（Rail 保持存在，Draft 不丢）；
 * 旧 overview/library 链接先归一化，避免兼容入口触发与目标页不一致的 Guard。
 * Pane 表单（Capabilities/Settings）会卸载，其 Guard 仍生效。
 * @param dirtyByKey 各注册 key 的 dirty 状态（rail / pane）
 */
export function decideTabSwitchGuard(
  tab: ProjectWorkspaceTab,
  dirtyByKey: Readonly<Record<string, boolean>>,
): boolean {
  if ((PROJECT_PRIMARY_TABS as readonly string[]).includes(normalizeProjectWorkspaceTab(tab))) {
    return Object.entries(dirtyByKey).some(([key, dirty]) => key !== "rail" && dirty);
  }
  return Object.values(dirtyByKey).some(Boolean);
}

export async function resolveUnsavedGuardAction(
  action: UnsavedGuardAction,
  guard: Pick<ProjectUnsavedGuard, "save" | "discard"> | readonly Pick<ProjectUnsavedGuard, "save" | "discard">[],
): Promise<UnsavedGuardResult> {
  const guards = Array.isArray(guard) ? guard : [guard];
  if (action === "cancel") return "stay";
  if (action === "discard") {
    for (const item of guards) item.discard();
    return "navigate";
  }
  try {
    // §7：保存所有 dirty guard，全部成功才放行；任一失败保留现场
    for (const item of guards) await item.save();
    return "navigate";
  } catch {
    return "stay-error";
  }
}

export function resolveProjectTagLabel(
  modePresetId: string | null | undefined,
  labelsById: ReadonlyMap<string, string>,
): string {
  if (!modePresetId) return "无 Tag";
  return labelsById.get(modePresetId) ?? "已移除的 Tag";
}

export function applyModeProfileResponse(args: {
  requestedMode: string;
  currentMode: string;
  presets: ReadonlyArray<{ id: string }>;
  currentPresetId: string;
  fallbackPresetId: string;
}): { ignore: true } | { ignore: false; modePresetId: string } {
  if (args.requestedMode !== args.currentMode) return { ignore: true };
  const belongs = args.presets.some((preset) => preset.id === args.currentPresetId);
  return {
    ignore: false,
    modePresetId: belongs ? args.currentPresetId : args.fallbackPresetId,
  };
}

export function emptyModeTagOptionLabel(): string {
  return "默认";
}

function stableSerialize(value: unknown): string {
  if (value === null || value === undefined) return String(value);
  if (typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableSerialize(item)).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableSerialize(record[key])}`)
    .join(",")}}`;
}

export type ProjectPlanColumnId = "todo" | "doing" | "paused" | "done";
export type ProjectPlanView = "table" | "board" | "list" | "gantt" | "calendar";

export const PROJECT_PLAN_VIEWS: Array<{ id: ProjectPlanView; label: string }> = [
  { id: "table", label: "表格" },
  { id: "board", label: "看板" },
  { id: "list", label: "列表" },
  { id: "gantt", label: "甘特" },
  { id: "calendar", label: "日历" },
];

export const PROJECT_PLAN_COLUMNS: Array<{
  id: ProjectPlanColumnId;
  label: string;
  tone: "neutral" | "doing" | "paused" | "done";
  statuses: ReadonlyArray<string | undefined>;
}> = [
  { id: "todo", label: "待开始", tone: "neutral", statuses: ["pending", "planning", undefined] },
  { id: "doing", label: "进行中", tone: "doing", statuses: ["in_progress"] },
  { id: "paused", label: "已暂停", tone: "paused", statuses: ["failed"] },
  { id: "done", label: "已完成", tone: "done", statuses: ["completed"] },
];

export function planColumnForStatus(status?: string): ProjectPlanColumnId {
  if (status === "in_progress") return "doing";
  if (status === "failed") return "paused";
  if (status === "completed") return "done";
  return "todo";
}

export function statusForPlanColumn(column: ProjectPlanColumnId): "pending" | "in_progress" | "failed" | "completed" {
  if (column === "doing") return "in_progress";
  if (column === "paused") return "failed";
  if (column === "done") return "completed";
  return "pending";
}

export function groupProjectPlanTasks<T extends ProjectTaskListItem>(
  tasks: readonly T[],
  projectId: string,
  query?: string,
): Record<ProjectPlanColumnId, T[]> {
  const grouped: Record<ProjectPlanColumnId, T[]> = { todo: [], doing: [], paused: [], done: [] };
  for (const task of filterProjectTasks(tasks, projectId, { query })) {
    grouped[planColumnForStatus(task.status)].push(task);
  }
  return grouped;
}

export function planColumnLabel(column: ProjectPlanColumnId): string {
  return PROJECT_PLAN_COLUMNS.find((item) => item.id === column)?.label ?? column;
}

export function planColumnOf(status?: string): ProjectPlanColumnId {
  if (status === "todo" || status === "doing" || status === "paused" || status === "done") return status;
  return planColumnForStatus(status);
}

export function groupProjectTodos<T extends { status: string; title: string; updatedAt: number }>(
  items: readonly T[],
  query?: string,
): Record<ProjectPlanColumnId, T[]> {
  const grouped: Record<ProjectPlanColumnId, T[]> = { todo: [], doing: [], paused: [], done: [] };
  const normalized = query?.trim().toLowerCase() ?? "";
  for (const item of items) {
    if (normalized && !item.title.toLowerCase().includes(normalized)) continue;
    grouped[planColumnOf(item.status)].push(item);
  }
  for (const column of PROJECT_PLAN_COLUMNS) {
    grouped[column.id].sort((left, right) => right.updatedAt - left.updatedAt);
  }
  return grouped;
}

export type ProjectAssetKindFilter = "all" | "text" | "file" | "url" | "folder";
export type ProjectAssetSortKey = "name" | "updatedAt" | "size";
export type ProjectAssetDisplayKind = "folder" | "pdf" | "image" | "sheet" | "slide" | "link" | "text" | "file";

export function projectAssetsInFolder<T extends { parentId?: string }>(
  resources: readonly T[],
  folderId: string | null,
): T[] {
  return resources.filter((resource) => (resource.parentId ?? null) === folderId);
}

export function filterProjectAssets<T extends { title: string; kind: string; parentId?: string }>(
  resources: readonly T[],
  options: { query?: string; kind?: ProjectAssetKindFilter; folderId?: string | null } = {},
): T[] {
  const query = options.query?.trim().toLowerCase() ?? "";
  const kind = options.kind ?? "all";
  const scoped = query
    ? resources
    : options.folderId === undefined
      ? resources
      : projectAssetsInFolder(resources, options.folderId);
  return scoped.filter((resource) => {
    if (kind !== "all" && resource.kind !== kind) return false;
    return !query || resource.title.toLowerCase().includes(query);
  });
}

export function projectAssetDisplayKind(resource: { kind: string; title: string }): ProjectAssetDisplayKind {
  if (resource.kind === "folder") return "folder";
  if (resource.kind === "url") return "link";
  if (resource.kind === "text") return "text";
  const ext = resource.title.trim().split(".").pop()?.toLowerCase() ?? "";
  if (ext === "pdf") return "pdf";
  if (["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp"].includes(ext)) return "image";
  if (["xls", "xlsx", "csv"].includes(ext)) return "sheet";
  if (["ppt", "pptx"].includes(ext)) return "slide";
  return "file";
}

export function projectAssetTypeLabel(kind: string, title?: string): string {
  const display = projectAssetDisplayKind({ kind, title: title ?? "" });
  if (display === "folder") return "文件夹";
  if (display === "pdf") return "PDF";
  if (display === "image") return "图片";
  if (display === "sheet") return "表格";
  if (display === "slide") return "演示";
  if (display === "link") return "链接";
  if (display === "text") return "文档";
  return "文件";
}

export function formatAssetBytes(bytes?: number): string {
  if (bytes === undefined || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 2 : 1)} MB`;
}

export function formatAssetQuota(usedChars: number, budgetChars: number): string {
  return `补充参考 ${usedChars.toLocaleString("zh-CN")} / ${budgetChars.toLocaleString("zh-CN")} 字`;
}

export function sortProjectAssets<T extends { title: string; kind: string; updatedAt: number }>(
  resources: readonly T[],
  sort: { key: ProjectAssetSortKey; desc?: boolean } = { key: "name" },
  sizeOf?: (item: T) => number,
): T[] {
  const dir = sort.desc ? -1 : 1;
  return [...resources].sort((left, right) => {
    const folderDelta = Number(right.kind === "folder") - Number(left.kind === "folder");
    if (folderDelta !== 0) return folderDelta;
    if (sort.key === "updatedAt") return (left.updatedAt - right.updatedAt) * dir;
    if (sort.key === "size") return ((sizeOf?.(left) ?? 0) - (sizeOf?.(right) ?? 0)) * dir;
    return left.title.localeCompare(right.title, "zh") * dir;
  });
}

export const PROJECT_ASSET_DRAG_TYPE = "text/project-asset";

export function collectDroppedLocalFiles(
  files: ArrayLike<{ name: string; path?: string }>,
  getPath?: (file: { name: string; path?: string }) => string,
): Array<{ name: string; path: string }> {
  const out: Array<{ name: string; path: string }> = [];
  const seen = new Set<string>();
  for (let i = 0; i < files.length; i++) {
    const file = files[i]!;
    const path = (getPath?.(file) || file.path || "").trim();
    if (!path || seen.has(path)) continue;
    seen.add(path);
    const name = file.name.trim() || path.split(/[/\\]/).pop() || "未命名文件";
    out.push({ name, path });
  }
  return out;
}

export function dataTransferHasFiles(types: ArrayLike<string>): boolean {
  return Array.from(types).includes("Files");
}

export function dataTransferHasProjectAssets(types: ArrayLike<string>): boolean {
  return Array.from(types).includes(PROJECT_ASSET_DRAG_TYPE);
}

export function projectAssetDragIds(resourceId: string, selected: ReadonlySet<string>): string[] {
  if (selected.has(resourceId) && selected.size > 0) return [...selected];
  return [resourceId];
}

export function encodeProjectAssetDrag(ids: readonly string[]): string {
  return JSON.stringify([...new Set(ids.filter((id) => id.trim().length > 0))]);
}

export function decodeProjectAssetDrag(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return [...new Set(parsed.filter((id): id is string => typeof id === "string" && id.trim().length > 0))];
  } catch {
    return [];
  }
}

export function movableProjectAssetIds(args: {
  ids: readonly string[];
  targetParentId: string | null;
  resources: ReadonlyArray<{ id: string; kind: string; parentId?: string }>;
}): string[] {
  const byId = new Map(args.resources.map((resource) => [resource.id, resource]));
  if (args.targetParentId) {
    const parent = byId.get(args.targetParentId);
    if (!parent || parent.kind !== "folder") return [];
  }
  return args.ids.filter((id) => {
    const item = byId.get(id);
    if (!item) return false;
    if (id === args.targetParentId) return false;
    if ((item.parentId ?? null) === args.targetParentId) return false;
    if (item.kind === "folder" && args.targetParentId) {
      let cursor: string | undefined = args.targetParentId;
      const seen = new Set<string>();
      while (cursor) {
        if (cursor === id) return false;
        if (seen.has(cursor)) break;
        seen.add(cursor);
        cursor = byId.get(cursor)?.parentId;
      }
    }
    return true;
  });
}

export type ProjectActivityActor = "user" | "buddy" | "system";

export interface ProjectActivityItem {
  id: string;
  at: number;
  kind: "task" | "project" | "post" | "welcome" | "event";
  title: string;
  detail?: string;
  actor: ProjectActivityActor;
}

/** 项目动态里的助手署名，产品名固定，不用人设里可能被改掉的名字 */
export function projectBuddyName(): string {
  return "MyBuddy";
}

export function projectWelcomeBody(projectName: string): string {
  return [
    `**「${projectName}」已就绪。**`,
    "",
    "我是 MyBuddy，这个项目里的活我都能上手：读资料、跟计划、开任务、到点跑自动化。",
    "",
    "右侧改指令、专家、技能和连接器。下面输入框直接说事。",
    "",
    "这里开的任务和自动化，都会带上同一套项目上下文。",
  ].join("\n");
}

export function deriveProjectActivity(args: {
  project: { name: string; createdAt: number; updatedAt: number };
  tasks: ReadonlyArray<{ id: string; title: string; updatedAt: number; status?: string; archived?: boolean }>;
  posts?: ReadonlyArray<{ id: string; body: string; createdAt: number }>;
  events?: ReadonlyArray<{ id: string; title: string; body?: string; source: string; kind: string; createdAt: number }>;
}): ProjectActivityItem[] {
  const items: ProjectActivityItem[] = [
    {
      id: "project-welcome",
      at: args.project.createdAt,
      kind: "welcome",
      title: projectWelcomeBody(args.project.name),
      actor: "buddy",
    },
  ];
  if (args.project.updatedAt > args.project.createdAt) {
    items.push({
      id: "project-updated",
      at: args.project.updatedAt,
      kind: "project",
      title: "更新了项目配置",
      actor: "buddy",
    });
  }
  for (const task of args.tasks) {
    if (task.archived) continue;
    items.push({
      id: `task-${task.id}`,
      at: task.updatedAt,
      kind: "task",
      title: task.title,
      detail: task.status === "completed" ? "已完成" : task.status === "in_progress" ? "进行中" : "任务更新",
      actor: "system",
    });
  }
  for (const post of args.posts ?? []) {
    items.push({
      id: `post-${post.id}`,
      at: post.createdAt,
      kind: "post",
      title: post.body,
      actor: "user",
    });
  }
  // 外部输入事件（gateway/cron/…）：来源归属可见，不参与业务真源
  for (const event of args.events ?? []) {
    items.push({
      id: `event-${event.id}`,
      at: event.createdAt,
      kind: "event",
      title: event.title,
      detail: event.body,
      actor: "system",
    });
  }
  return items.sort((left, right) => right.at - left.at);
}

export function selectedProjectPolicyIds(policies: ProjectPoliciesDto): {
  experts: string[];
  skills: string[];
  connectors: string[];
} {
  return {
    experts: [...policies.expert.allow, ...policies.expert.recommended],
    skills: [...policies.skill.allow, ...policies.skill.prefer],
    connectors: [...policies.connector.allow, ...policies.connector.recommended],
  };
}

function uniqueCount(...groups: readonly (readonly string[])[]): number {
  return new Set(groups.flat()).size;
}
