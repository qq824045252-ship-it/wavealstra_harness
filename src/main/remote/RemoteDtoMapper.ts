import type {
  RemoteAcpRunInfo,
  RemoteArtifactMetadata,
  RemoteHistoryMessage,
  RemoteModelSummary,
  RemoteNotification,
  RemoteProjectSummary,
  RemoteSpaceSummary,
  RemoteTaskHistory,
  RemoteTaskSummary,
} from "../../../shared/src/remote-contract";
import type { ChatMessageDto, ModelInfoDto, SpaceDto, TaskDto, TaskHistoryDto } from "../../shared/agent-ipc";
import type { ExternalAgentRunDto } from "../../shared/external-agent";
import type { NotificationDto } from "../../shared/notification";
import type { ProjectDto } from "../../shared/project-domain";

export interface TaskRuntimeFacts {
  busy: boolean;
  pendingActionCount: number;
}

export function mapRemoteTask(task: TaskDto, runtime: TaskRuntimeFacts): RemoteTaskSummary {
  return {
    id: task.id,
    title: task.title,
    spaceId: task.spaceId ?? null,
    projectId: task.projectId ?? null,
    status: task.status,
    updatedAt: task.updatedAt,
    welcomeMode: task.welcomeMode,
    modelId: task.modelId,
    permissionMode: task.permissionMode,
    archived: task.archived === true,
    expertId: task.expertId,
    modePresetId: task.modePresetId ?? null,
    startAt: task.startAt ?? null,
    dueAt: task.dueAt ?? null,
    isFavorited: task.isFavorited === true,
    doneAckedAt: task.doneAckedAt ?? null,
    busy: runtime.busy,
    pendingActionCount: runtime.pendingActionCount,
  };
}

export function mapRemoteSpace(space: SpaceDto): RemoteSpaceSummary {
  return {
    id: space.id,
    name: space.name,
    archived: space.archived === true,
    parentId: space.parentId ?? null,
    sortOrder: space.sortOrder ?? 0,
    effectiveArchived: space.effectiveArchived === true,
    pathMissing: space.pathMissing === true,
  };
}

export function mapRemoteModel(model: ModelInfoDto): RemoteModelSummary {
  return {
    id: model.id,
    name: model.name,
    vendor: model.vendor,
    contextWindow: model.contextWindow,
    supportsReasoning: model.supportsReasoning === true,
    supportsImages: model.supportsImages === true,
  };
}

export function mapRemoteProject(project: ProjectDto): RemoteProjectSummary {
  return {
    id: project.id,
    name: project.name,
    description: project.description,
    updatedAt: project.updatedAt,
    archived: project.archived === true,
  };
}

function mapArtifact(artifact: NonNullable<ChatMessageDto["artifacts"]>[number]): RemoteArtifactMetadata {
  return { id: artifact.id, name: artifact.name, kind: artifact.kind };
}

/** ExternalAgentRunDto → 手机端 ACP 运行投影（只暴露展示与续聊所需的字段） */
export function mapRemoteAcpRun(run: ExternalAgentRunDto): RemoteAcpRunInfo {
  return {
    runId: run.runId,
    agentId: run.agentId,
    agentName: run.agentName,
    protocol: "acp",
    status: run.status,
    sessionReady: Boolean(run.sessionId),
    resumeSupported: run.capabilities.resumeSupported === true,
    cancelSupported: run.capabilities.cancelSupported === true,
    continuationMode: run.continuationMode,
    recoveryState: run.recovery.state,
    verificationStatus: run.verification.status,
    commandLabel: run.diagnostics.commandLabel,
  };
}

export function mapRemoteHistoryMessage(message: ChatMessageDto): RemoteHistoryMessage {
  return {
    id: message.id,
    streaming: message.streaming,
    role: message.role,
    text: message.text,
    thinking: message.thinking,
    modelName: message.modelName,
    createdAt: message.createdAt,
    durationMs: message.durationMs,
    tools: message.tools?.map((tool) => ({
      id: tool.id,
      tool: tool.tool,
      summary: tool.summary,
      detail: tool.detail,
      output: tool.output,
      status: tool.status,
    })),
    artifacts: message.artifacts?.map(mapArtifact),
    attachments: message.attachments?.map((attachment) => ({ name: attachment.name })),
  };
}

export function mapRemoteHistory(taskId: string, history: TaskHistoryDto): RemoteTaskHistory {
  return { taskId, messages: history.messages.map(mapRemoteHistoryMessage),
    durable: history.durable ? { ...history.durable, messages: history.durable.messages.map(mapRemoteHistoryMessage) } : undefined };
}

export function mapRemoteNotification(notification: NotificationDto): RemoteNotification {
  return {
    id: notification.id,
    type: notification.type,
    level: notification.level,
    title: notification.title,
    body: notification.body,
    taskId: notification.taskId,
    projectId: notification.projectId,
    workspaceId: notification.workspaceId,
    createdAt: notification.createdAt,
    readAt: notification.readAt,
  };
}
