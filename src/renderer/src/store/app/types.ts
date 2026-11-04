import type { AgentUiPatch } from "../../../../shared/agent-ipc";
import type { ExternalAgentPinDto } from "../../../../shared/external-agent";
import type { Theme } from "../../lib/theme";
import type { PermissionMode, WelcomeMode } from "../../types";
import type { AppActions } from "./actions";
import type { ActiveContextState } from "./slices/activeContext";
import type { AppConfigState } from "./slices/appConfig";
import type { AppUiState } from "./slices/appUi";
import type { ArtifactsState } from "./slices/artifacts";
import type { CapabilitiesState } from "./slices/capabilities";
import type { ComposerState } from "./slices/composer";
import type { ProjectsState } from "./slices/projects";
import type { TasksState } from "./slices/tasks";
import type { TerminalState } from "./slices/terminal";
import type { WorkbenchState } from "./slices/workbench";
import type { WorkspacesState } from "./slices/workspaces";

export type AgentDeltaPatch = Extract<
  AgentUiPatch,
  { type: "text_delta" | "thinking_delta" }
>;

export type PanelMode =
  | "file"
  | "overview"
  | "artifacts"
  | "workspace"
  | "gadgets"
  | "terminal"
  | "browser"
  | "changes";

export type StreamingSendMode = "continue" | "steer" | "interrupt";

export type SettingsTab =
  | "system"
  | "extensions"
  | "modes"
  | "personalize"
  | "memory"
  | "archive"
  | "models"
  | "assistant"
  | "acp"
  | "data"
  | "python"
  | "shortcuts"
  | "notifications"
  | "remote"
  | "security"
  | "help";

export interface TaskDraft {
  /** 发起时绑定的空间（空间内「+ 添加对话」） */
  spaceId?: string;
  /** 与 Space 正交的长期 Project 上下文。 */
  projectId?: string;
  /** 发起该任务的 Project Plan 项；仅在首条消息落库后建立 Work Graph 关系。 */
  planId?: string;
  /** Expert selected for the task. */
  expertId?: string;
  /** 草稿期固定的 ACP 外部 Agent；首条消息 materialize 时随任务落库。 */
  externalAgentPin?: ExternalAgentPinDto;
  /** Project 内创建任务时预填的标题；首条消息 materialize 时写入。 */
  title?: string;
}

export interface PendingRegeneration {
  /** 去重/归属 id，随 IPC 贯穿。 */
  requestId: string;
  taskId: string;
  /** 被重新生成的源助手消息 id（commit 时按此重新定位，不依赖跨异步旧 index）。 */
  sourceAssistantMessageId: string;
  /** 被重新生成的源用户消息 id（drift 校验锚点）。 */
  sourceUserMessageId: string;
  userMessageIndex: number;
  /** 新助手消息 id（assistant_start 到达时据此 commit）。 */
  newAssistantMessageId: string;
  startedAt: number;
}

export interface CreateRelatedTaskOptions {
  sourceTaskId: string;
  /** 目标 Mode（working/coding/design） */
  welcomeMode: WelcomeMode;
  /** 目标 Tag/Preset；缺省 = 目标模式默认 tag */
  modePresetId?: string;
  /** 目标专家（可选；未安装时尝试市场安装，失败返回 null） */
  expertId?: string | null;
  /** 显式权限；缺省 = Tag 建议 ?? 系统当前 */
  permissionMode?: PermissionMode;
  /** 显式模型；缺省 = Tag 建议（须可用）?? 源任务/当前模型 */
  modelId?: string;
  /** 自定义标题；缺省 = “关联：<源任务标题>” */
  title?: string;
  /** 首条指令；缺省 = 引用源任务继续 */
  instruction?: string;
}

export interface TerminalTabItem {
  id: string;
  title: string;
}

export type RelocateSpaceResult =
  | { ok: true }
  | {
      ok: false;
      reason: "cancel" | "occupied" | "missing" | "write";
      otherName?: string;
    };

export type { Theme } from "../../lib/theme";

export type AppState = AppUiState &
  TasksState &
  WorkspacesState &
  ProjectsState &
  ActiveContextState &
  ComposerState &
  ArtifactsState &
  WorkbenchState &
  TerminalState &
  AppConfigState &
  CapabilitiesState &
  AppActions;
