import type { TaskDto } from "../../../../../shared/agent-ipc";
import { normalizeSingleExpertId } from "../../../../../shared/expert-id";
import { DEFAULT_WELCOME_MODE } from "../../../../../shared/mode-profile";
import type { PermissionMode, Task } from "../../../types";

/**
 * TaskDto → renderer Task 的唯一映射源：初始加载与回收站恢复共用，
 * 避免恢复出来的任务缺字段（messages/默认模型/权限等）。
 */
export function mapTaskRowToTask(
  row: TaskDto,
  context: {
    enabledModelIds: ReadonlySet<string>;
    defaultModelId: string;
    permissionModeDefault: PermissionMode;
    taskConnectorIds?: Record<string, string[]>;
  },
): Task {
  return {
    id: row.id,
    title: row.title,
    spaceId: row.spaceId ?? undefined,
    projectId: row.projectId ?? undefined,
    status: row.status as Task["status"],
    updatedAt: row.updatedAt,
    messages: [],
    sessionFile: row.sessionFile,
    cwd: row.cwd,
    modelId:
      row.modelId && context.enabledModelIds.has(row.modelId)
        ? row.modelId
        : context.defaultModelId,
    permissionMode:
      row.permissionMode ?? context.permissionModeDefault ?? "default",
    welcomeMode: row.welcomeMode ?? DEFAULT_WELCOME_MODE,
    archived: row.archived,
    expertId: normalizeSingleExpertId(row.expertId),
    expertBinding: row.expertBinding,
    modePresetId: row.modePresetId,
    startAt: row.startAt ?? undefined,
    dueAt: row.dueAt ?? undefined,
    // Phase 2：isFavorited / spaceSortOrder 复用已冻结列，重启后持久（单一真相，直接来自 DB）
    isFavorited: Boolean(row.isFavorited),
    spaceSortOrder: row.spaceSortOrder ?? 0,
    // ACP pin：任务级固定，重启后恢复逐轮续链路由
    externalAgentPin: row.externalAgentPin ?? undefined,
    // 侧栏绿点水位：DB 是唯一真相（重启后绿点仍按查看历史显示/隐藏）
    doneAckedAt: row.doneAckedAt ?? null,
    // F3：任务级 Active Connector（settings.json 持久化；无新 DB schema）
    connectorIds: context.taskConnectorIds?.[row.id],
  };
}
