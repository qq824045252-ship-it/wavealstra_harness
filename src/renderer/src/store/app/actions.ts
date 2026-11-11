import type {
  AgentUiPatch,
  LocalConnectorDto,
} from "../../../../shared/agent-ipc";
import type {
  ArchivedContentDeletionRequest,
  ArchivedContentDeletionResult,
} from "../../../../shared/archive-deletion";
import type {
  ArtifactCreatedEvent,
  ArtifactRemovedEvent,
  ArtifactSnapshot,
  ArtifactUpdatedEvent,
} from "../../../../shared/artifact-types";
import type {
  ExternalAgentDescriptorDto,
  ExternalAgentId,
  ExternalAgentPinDto,
} from "../../../../shared/external-agent";
import type { ModelReasoningPreferenceDto } from "../../../../shared/model-metadata";
import type {
  TerminalContextDto,
  TerminalExitEvent,
  TerminalSessionInfo,
} from "../../../../shared/terminal-ipc";
import type { ArtifactRenderPayload } from "../../lib/artifactIngest";
import type {
  ProjectNavDestination,
  ProjectWorkspaceTab,
} from "../../lib/projectWorkspace";
import type { RefFileItem } from "../../lib/refTaskArtifacts";
import type { Theme } from "../../lib/theme";
import type {
  Attachment,
  ChatSelection,
  Expert,
  Page,
  PermissionMode,
  Skill,
  Soul,
  Task,
  TaskFilterStatus,
  TaskFilterTime,
  TaskReference,
  WelcomeMode,
} from "../../types";
import type {
  AgentDeltaPatch,
  CreateRelatedTaskOptions,
  PanelMode,
  RelocateSpaceResult,
  SettingsTab,
  StreamingSendMode,
  TerminalSurface,
} from "./types";

/** Public action signatures retained by the appStore facade. */
export interface AppActions {
  openWorkspaceDetail: (spaceId: string) => void;
  closeWorkspaceDetail: () => void;
  openSubagentDrawer: (instanceId: string) => void;
  closeSubagentDrawer: () => void;
  /** 进入子代理对话页（共用聊天外壳；导航回父任务用 closeSubagentView） */
  openSubagentView: (taskId: string, subagentId: string) => void;
  closeSubagentView: () => void;
  openUsageStats: () => void;
  closeUsageStats: () => void;
  openApiAggregation: () => void;
  closeApiAggregation: () => void;
  openExtensionSoftware: () => void;
  closeExtensionSoftware: () => void;
  toggleTheme: () => void;
  setTheme: (theme: Theme) => void;
  setSettingsOpen: (open: boolean, tab?: SettingsTab) => void;
  setSearchOpen: (open: boolean) => void;
  setTaskFilterStatus: (s: TaskFilterStatus) => void;
  setTaskFilterTime: (t: TaskFilterTime) => void;
  resetTaskFilters: () => void;
  toggleTaskSection: () => void;
  toggleSpaceCollapsed: (id: string) => void;
  setAllSpacesExpanded: (expanded: boolean) => void;
  closeProjectDetails: () => void;
  setActiveProjectTab: (tab: ProjectWorkspaceTab) => void;
  clearProjectNavRequest: () => void;
  refreshProjects: (includeArchived?: boolean) => Promise<void>;
  clearBranchError: () => void;
  setStreamingSendMode: (mode: StreamingSendMode) => void;
  setFullAccessDuringRun: (on: boolean) => void;
  setHomeSpaceId: (id: string | null) => void;
  clearChatSelection: (selection?: ChatSelection) => void;
  clearTerminalContext: () => void;
  clearPendingRefFile: () => void;
  clearPendingRefTask: () => void;
  clearPendingExternalAgentContinuation: () => void;
  clearComposerDraft: () => void;
  clearComposerInsertion: () => void;
  refreshArtifactPolicy: (mode: WelcomeMode) => Promise<void>;
  cacheArtifactRender: (
    artifactId: string,
    payload: ArtifactRenderPayload,
  ) => void;
  setWorkspaceFilesCount: (count: number) => void;
  setGadgetsCount: (count: number) => void;
  togglePanelPinned: () => void;
  showOverview: () => void;
  showArtifacts: () => void;
  showAllArtifacts: () => void;
  showWorkspace: () => void;
  showGadgets: () => void;
  showTerminal: () => void;
  refreshBrowser: () => void;
  showChanges: () => void;
  showAllChanges: () => void;
  openExtensionFlyout: (mode?: PanelMode) => void;
  toggleExtensionFlyout: () => void;
  closeExtensionFlyout: () => void;
  toggleExtensionFlyoutPinned: () => void;
  setExtensionMenuOpen: (open: boolean) => void;
  setPanelMode: (mode: PanelMode) => void;
  setTerminalSession: (info: TerminalSessionInfo) => void;
  applyTerminalExit: (ev: TerminalExitEvent) => void;
  setActiveTerminalTabId: (tabId: string, surface?: TerminalSurface) => void;
  setModelReasoningPreference: (
    modelId: string,
    preference: ModelReasoningPreferenceDto | undefined,
  ) => void;
  updateSoul: (soul: Partial<Soul>) => void;
  refreshSkills: () => Promise<void>;
  setSkillEnabled: (id: string, enabled: boolean) => void;
  installSkill: (id: string) => Promise<void>;
  installSkillByPath: (path: string) => Promise<Skill | null>;
  uninstallSkill: (id: string) => Promise<void>;
  deleteMarketSkill: (id: string) => Promise<void>;
  refreshExperts: () => Promise<void>;
  installExpert: (id: string) => Promise<void>;
  installExpertByPath: (path: string) => Promise<Expert | null>;
  importExpertZip: (zipPath: string) => Promise<Expert | null>;
  uninstallExpert: (id: string) => Promise<void>;
  deleteMarketExpert: (id: string) => Promise<void>;
  setExpertEnabled: (id: string, enabled: boolean) => void;
  refreshConnectors: () => Promise<void>;
  installConnector: (id: string) => Promise<string[]>;
  importConnectorByPath: (path: string) => Promise<LocalConnectorDto>;
  importConnectorZip: (zipPath: string) => Promise<LocalConnectorDto>;
  uninstallConnector: (id: string) => Promise<void>;
  deleteMarketConnector: (id: string) => Promise<void>;
  setConnectorEnabled: (id: string, enabled: boolean) => Promise<void>;
  setPage: (page: Page) => void;
  forgetDeletedBot: (botId: string) => void;
  setBotDraft: (text: string) => void;
  setBotAttachments: (botId: string, attachments: import("@/types").Attachment[]) => void;
  setBotComposerSelection: (scope: string, selection: import("@shared/bot-conversation").BotComposerSelection) => void;
  submitBotDraft: (options?: { retryRequestId?: string; editRejectedRequestId?: string; referenceMessageId?: string }) => Promise<void>;
  loadOlderBotHistory: (botId: string, teamId?: string) => Promise<void>;
  refreshBotHistory: (botId: string, teamId?: string) => Promise<void>;
  cancelBotSend: (botId: string, requestId: string) => Promise<void>;
  archiveBotConversation: (botId: string, teamId?: string) => Promise<void>;
  createBot: (request: import("../../../../shared/bot-create").BotCreateRequest) => Promise<import("../../../../shared/bot-create").BotCreateResult>;
  setActiveTeam: (team: import("../../../../shared/bot-work-team").WorkTeamTemplateDto | null) => void;
  setActiveBotId: (botId: string | null) => void;
  setSelectedWorkId: (workId: string | null) => void;
  setHistoricalTeamWork: (work: import("../../../../shared/bot-work").WorkProjectionDto | null) => void;
  refreshBotWork: (includeClosed?: boolean) => Promise<void>;
  applyWorkProjection: (projection: import("../../../../shared/bot-work").WorkProjectionDto) => void;
  markBotNotificationRead: (notificationId: string) => Promise<void>;
  openHubMcp: (serverName?: string) => void;
  requestLibraryNav: (
    dest:
      | { view: "space"; spaceId: string; folderId: string | null }
      | { view: "item"; itemId: string },
  ) => void;
  openProjectDetails: (projectId: string, tab?: ProjectWorkspaceTab) => void;
  requestProjectsRoot: () => void;
  requestProjectNav: (dest: ProjectNavDestination) => void;
  applyProjectNavigation: (dest: ProjectNavDestination) => void;
  startProjectTask: (opts: {
    projectId: string;
    planId?: string;
    spaceId?: string;
    title?: string;
    welcomeMode: WelcomeMode;
    modePresetId: string | null;
  }) => void;
  newTask: (spaceId?: string, projectId?: string) => void;
  summonExpert: (expertId: string, spaceId?: string) => void;
  setDraftProject: (projectId: string | null) => void;
  setActiveTask: (id: string) => void;
  setWelcomeMode: (mode: WelcomeMode) => void;
  setModePreset: (presetId: string) => void;
  refreshModelConfiguration: () => Promise<void>;
  setActiveConnectors: (ids: string[]) => void;
  setActiveModel: (id: string) => void;
  followSuggestedModel: () => Promise<void>;
  followSuggestedPermission: () => Promise<void>;
  setPermissionMode: (mode: PermissionMode) => void;
  refreshTaskExpertBinding: (
    taskId: string,
  ) => Promise<
    import("../../../../shared/expert-binding").TaskExpertBindingDto
  >;
  saveTaskExpertBinding: (
    input: import("../../../../shared/expert-binding").TaskExpertBindingSaveRequest,
  ) => Promise<
    import("../../../../shared/expert-binding").TaskExpertBindingDto
  >;
  switchExpert: (expertId: string | null) => void;
  setExternalAgentPin: (pin: ExternalAgentPinDto | null) => void;
  bindProjectContext: (taskId: string, projectId: string | null) => void;
  attachSelectionToChat: (comment?: string) => boolean;
  attachTerminalContext: (
    ctx: Pick<TerminalContextDto, "taskId" | "source" | "text"> & {
      capturedAt?: number;
      workspaceId?: string;
    },
  ) => boolean;
  attachArtifactToChat: (file: RefFileItem) => boolean;
  continueExternalAgent: (target: {
    runId: string;
    agentId: ExternalAgentId;
    agentName: string;
  }) => boolean;
  fillComposer: (text: string) => void;
  appendComposer: (text: string) => void;
  createTerminalTab: (surface?: TerminalSurface) => void;
  closeTerminalTab: (tabId: string, surface?: TerminalSurface) => void;
  shareTaskToConversation: (
    sourceTaskId: string,
    targetTaskId: string,
  ) => Promise<boolean>;
  duplicateTaskWithMode: (mode: WelcomeMode, fromTaskId?: string) => void;
  createRelatedTask: (opts: CreateRelatedTaskOptions) => Promise<string | null>;
  createBranchFromMessage: (
    messageId: string,
    opts: {
      role: "user" | "assistant";
      entryId?: string;
      userMessageIndex?: number;
    },
  ) => Promise<boolean>;
  refreshBranchLineage: (taskId: string) => void;
  deleteTask: (id: string) => void;
  purgeArchivedContent: (
    request: ArchivedContentDeletionRequest,
  ) => Promise<ArchivedContentDeletionResult>;
  refreshTrashedTasks: () => Promise<void>;
  restoreTrashedTask: (id: string) => Promise<void>;
  setTaskStatus: (id: string, status: Task["status"]) => void;
  renameTask: (id: string, title: string) => void;
  togglePinTask: (id: string) => Promise<void>;
  archiveTask: (id: string) => Promise<void>;
  ackTaskDone: (id: string) => Promise<void>;
  restoreTask: (id: string) => Promise<void>;
  sendMessage: (
    text: string,
    attachments?: Attachment[],
    taskReferences?: TaskReference[],
    streamingBehavior?: "steer" | "followUp",
    /** 当前消息激活的连接器 id（其 Private Skills 进入候选技能集） */
    connectorIds?: string[],
    /** 显式覆盖（createRelatedTask 等已解析场景使用）：直接作为 explicit 传给主进程 */
    explicitOverrides?: { modelId?: string; permissionMode?: PermissionMode },
    /** 显式从「+ → 外部 Agent」选中的 ACP 执行者；单轮生效。 */
    externalAgent?: Pick<
      ExternalAgentDescriptorDto,
      "id" | "name" | "protocol"
    > & { continueFromRunId?: string },
  ) => void | Promise<void>;
  deleteUserMessage: (messageId: string) => Promise<void>;
  regenerateMessage: (messageId: string) => void;
  abortActiveTask: () => Promise<void>;
  resolveToolApproval: (
    messageId: string,
    toolCallId: string,
    approved: boolean,
    externalWrite?: import("../../../../shared/external-write").ExternalWriteApprovalChoice,
  ) => void;
  listTaskWriteGrants: () => Promise<
    import("../../../../shared/external-write").TaskWriteGrantRow[]
  >;
  revokeTaskWriteGrant: (path: string) => Promise<boolean>;
  openArtifact: (id: string) => void;
  closeArtifactTab: (id: string) => void;
  removeArtifact: (
    id: string,
    opts?: { trashFile?: boolean },
  ) => Promise<boolean>;
  removeArtifactsForWorkspacePath: (
    root: string,
    relativePath: string,
  ) => Promise<void>;
  openLocalFile: () => Promise<void>;
  openLocalFolder: () => Promise<void>;
  openWorkspaceFile: (relativePath: string, name: string) => Promise<void>;
  openLocalAbsoluteFile: (absPath: string) => Promise<void>;
  openWorkspaceFolder: (
    relativePath?: string,
    taskId?: string,
  ) => Promise<void>;
  ensureCanvasArtifact: (input: {
    messageId: string;
    content: string;
    kind: Extract<import("../../types").ArtifactKind, "html" | "svg">;
    preferredName?: string;
    /** 为 true 时打开侧栏预览（默认 false，避免打断阅读） */
    open?: boolean;
  }) => Promise<string | null>;
  toggleSidebar: () => void;
  closePanel: () => void;
  setPanelWidth: (w: number) => void;
  togglePanelExpanded: () => void;
  showBrowser: () => void;
  setBrowserUrl: (url: string | null, gadgetId?: string) => void;
  navigateBrowser: () => void;
  archiveSpace: (id: string) => Promise<void>;
  restoreSpace: (id: string) => Promise<void>;
  deleteSpace: (id: string) => Promise<void>;
  addSpace: (
    parentId?: string | null,
    name?: string,
  ) => Promise<string | undefined>;
  refreshSpaces: () => Promise<void>;
  ensureSpaceFromPath: (
    folderPath: string,
    name: string,
    parentId?: string | null,
    options?: { activate?: boolean },
  ) => Promise<{ id: string; created: boolean }>;
  addSpaceFromPath: (
    folderPath: string,
    name: string,
    parentId?: string | null,
  ) => Promise<string>;
  relocateSpace: (id: string) => Promise<RelocateSpaceResult>;
  refreshSpacePathStatus: (id: string) => Promise<void>;
  renameSpace: (id: string, name: string) => Promise<boolean>;
  bindTaskSpace: (taskId: string, spaceId: string | null) => void;
  moveSpace: (req: {
    spaceId: string;
    targetParentId: string | null;
    targetIndex?: number;
  }) => Promise<{ ok: true } | { ok: false; error: string }>;
  moveTaskInWorkspaceTree: (req: {
    taskId: string;
    targetSpaceId: string | null;
    targetIndex?: number;
  }) => Promise<{ ok: true } | { ok: false; error: string }>;
  initRuntime: () => (() => void) | void;
  applyAgentPatch: (patch: AgentUiPatch) => void;
  applyAgentDeltaBatch: (patches: AgentDeltaPatch[]) => void;
  hydrateArtifacts: (taskId: string) => Promise<void>;
  reconcileTaskMessageArtifacts: (taskId: string) => void;
  applyArtifactSnapshot: (snapshot: ArtifactSnapshot) => void;
  applyArtifactCreated: (event: ArtifactCreatedEvent) => void;
  applyArtifactUpdated: (event: ArtifactUpdatedEvent) => void;
  applyArtifactRemoved: (event: ArtifactRemovedEvent) => void;
  clearArtifactTask: (taskId: string) => void;
  ensureArtifactRenderPayload: (
    artifactId: string,
  ) => Promise<ArtifactRenderPayload | null>;
  /** 离开视口回收：清掉该产物的渲染缓存与 loading 态（P0） */
  releaseArtifactRender: (artifactId: string) => void;
}
