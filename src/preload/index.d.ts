import type { GoogleWorkspaceWriteApi } from "../shared/google-workspace-write";
import type { GoogleWorkspaceApi } from "../shared/google-workspace";
import type { BrowserOpenOptions, BrowserTabInfo, BrowserTabsState } from "../shared/browser-tabs";
import type { BrowserConsoleEventDto, BrowserConsoleSnapshotDto, BrowserConsoleTarget } from "../shared/browser-console";
import type { ArchivedContentDeletionRequest, ArchivedContentDeletionResult, TrashedTaskDto } from "../shared/archive-deletion";
import type { MemoryCandidateDto, MemoryCoreProfileDto, MemoryCreateRequest, MemoryDismissedProjectionDto, MemoryKernelStats, MemoryListRequest, MemoryProjectionProposalDto, MemoryRecordDto, MemoryRevisionDto, MemoryScenarioDto, MemoryScopeType, MemorySearchHit, MemorySearchRequest, MemoryTurnDto, MemoryTurnListRequest, MemorySkillCandidateDto, MemorySkillCandidateStatus, MemorySkillEffectivenessDto, MemorySkillEffectivenessSummaryDto, MemorySkillFeedbackKind, MemorySkillRevisionCandidateDto, MemorySkillRevisionStatus, MemoryUpdateRequest } from "../shared/memory-kernel";
import type { MemoryGatewayAccessGrantDto, MemoryGatewayConfigureRequest, MemoryGatewayCreateGrantRequest, MemoryGatewayIssuedGrantDto, MemoryGatewayStatusDto, MemoryGatewayUpdateGrantRequest } from "../shared/memory-gateway";
import type { RemoteCloudflaredStatus, RemoteConfigureRequest, RemoteDeviceSummary, RemotePairingSession, RemoteStatus } from "../shared/remote-access";
import type { NotificationChangedEvent, NotificationDto, NotificationListRequest } from "../shared/notification";
import type { ExternalAgentDescriptorDto, ExternalAgentHistoryDto, ExternalAgentId, ExternalAgentPromptRequest, ExternalAgentPromptResult, ExternalAgentResolvePermissionRequest, ExternalAgentRunDto, ExternalAgentSetConfigOptionRequest, ExternalAgentTestResultDto, ExternalAgentUiEvent } from "../shared/external-agent";
import type { AgentLoadoutObservationDto, RuntimeAuditClearResultDto } from "../shared/agent-loadout";
import type {
  BuiltinCapabilitiesConfigDto,
  BuiltinCapabilitiesSnapshotDto,
  BuiltinCapabilityId,
  SaveBuiltinCredentialRequest,
  SaveBuiltinCapabilitySettingsRequest,
  TestBuiltinCapabilityResultDto,
} from "../shared/builtin-capabilities";
import type { CapabilityVideoJobDto } from "../shared/media-capabilities";
import type {
  AgentApproveToolRequest,
  AgentPromptRequest,
  AgentPromptResult,
  AgentSubmissionReceipt,
  AgentRegenerateRequest,
  AgentRegenerateResult,
  AgentDeleteUserMessageRequest,
  AgentRestoreBackupRequest,
  AgentSelectModePresetRequest,
  AgentSetPermissionModeRequest,
  AgentSwitchExpertRequest,
  AgentUiPatch,
  AppSettingsDto,
  ArtifactPreviewRequest,
  BtwPromptRequest,
  BtwStartRequest,
  BtwUiPatch,
  EnhancePromptRequest,
  EnhancePromptResult,
  RuntimeRequirementStateDto,
  ContextUsageDto,
  DiskSpaceDto,
  UserFontDto,
  ExpertDto,
  ExpertAuthoringCreateRequest,
  ExpertAuthoringCreateResult,
  ExpertAuthoringDraft,
  ExpertAuthoringGenerateRequest,
  LocalConnectorDto,
  PrivateSkillDto,
  CronJobDto,
  CronRunDto,
  FileBackupInfoDto,
  GatewayChannelConfigDto,
  GatewayWeixinQrLoginStateDto,
  GatewayQQQrLoginStateDto,
  GatewayEventDto,
  GatewayListMessagesRequest,
  SubagentSteerResultDto,
  SubagentSummaryDto,
  SubagentTranscriptDto,
  UsageDashboardDto,
  UsageDrilldownRowDto,
  UsageHeatmapCellDto,
  UsageMonthlyPointDto,
  UsageSummaryDto,
  UsageTrendPointDto,
  GatewayMessageDto,
  GatewayStatusDto,
  MarketExpertDto,
  MarketSkillDto,
  ModeBlockId,
  ModePolicyDto,
  ModeProfileDto,
  ModeProfileSummaryDto,
  WelcomeMode,
  AssembleModePreviewRequest,
  AssemblyTraceDto,
  RuntimeContextInspectionDto,
  RuntimeContextSnapshotDto,
  SkillAuthoringCreateRequest,
  SkillAuthoringCreateResult,
  SkillAuthoringDraft,
  SkillAuthoringGenerateRequest,
  SkillEvalRunRequest,
  SkillEvalRunResultDto,
  SkillImprovementApplyRequest,
  SkillImprovementDraftResult,
  SkillImprovementGenerateRequest,
  SkillPackageValidationDto,
  SubagentConfigDto,
  SubagentConfigPatch,
  WebSearchConfigDto,
  SearchProviderKeyUsageDto,
  McpDiscoveryDto,
  McpInstallResultDto,
  McpNotifyDto,
  McpProjectConfigDto,
  McpProxyResultDto,
  McpServerDto,
  McpStatusSnapshotDto,
  McpUiPromptDto,
  MemoryChangedDto,
  ModelInfoDto,
  ModelReloadResultDto,
  ModelsFileConfigDto,
  SkillDto,
  SoulDto,
  SpaceDto,
  TaskDto,
  TaskHistoryDto,
  TaskTitleSuggestionDto,
  TaskUserQuestionsDto,
  WorkspaceFileNodeDto,
  WorkspaceFilePreviewDto,
  WorkspaceMutationResult,
  WorkspaceCopyIntoTaskResult,
} from "../shared/agent-ipc";
import type {
  ProjectCreateRequest,
  ProjectDetailsDto,
  ProjectDuplicateRequest,
  ProjectDto,
  ProjectMutationResult,
  ProjectResourceInspectionDto,
  ProjectResourceCreateRequest,
  ProjectResourceDto,
  ProjectResourceUpdateRequest,
  ProjectUpdateRequest,
} from "../shared/project-domain";
import type {
  TerminalCloseRequest,
  TerminalDataEvent,
  TerminalExitEvent,
  TerminalInputRequest,
  TerminalOpenRequest,
  TerminalPrepareHerdrRequest,
  TerminalPrepareHerdrResult,
  TerminalResizeRequest,
  TerminalSessionInfo,
  TerminalTailRequest,
  TerminalTailResult,
} from "../shared/terminal-ipc";
import type {
  PreparePythonEnvironmentRequest,
  PreparePythonEnvironmentResult,
  PythonDiagnosticsExportResult,
  PythonEnvironmentInfo,
  PythonProjectBindingMutationResult,
  PythonProjectBindingRequest,
  PythonProjectBindingView,
  PythonProjectInterpreterView,
  PythonRuntimeProgressEvent,
  PythonRuntimeStatus,
} from "../shared/python-runtime";
import type {
  ProfessionalToolProviderId,
  ProfessionalToolResultDto,
  ProfessionalToolStatusDto,
} from "../shared/professional-tools";
import type {
  WorkspaceSharedContextView,
  WorkspaceSharedContextViewRequest,
  WorkspaceSharedContextPromoteRequest,
  WorkspaceSharedContextPromoteResult,
} from "../shared/workspace-shared-context";
import type {
  WorkspaceLibraryBindingListView,
  WorkspaceLibraryBindingMutationResult,
  WorkspaceLibraryBindingRequest,
} from "../shared/workspace-library-binding";
import type { GadgetApi } from "../shared/gadget-ipc";
import type { BlueprintApi } from "../shared/blueprint-ipc";
import type {
  WorkGraphAddEdgeRequest,
  WorkGraphAddEdgeResult,
  WorkGraphBenchmarkResult,
  WorkGraphEdgeDto,
  WorkGraphIntegrityReport,
  WorkGraphListRequest,
  WorkGraphObservability,
  WorkGraphRemoveEdgeResult,
  WorkGraphRepairPreview,
} from "../shared/work-graph";
import type { ConversationRuntimeApi } from "../shared/conversation-runtime";

export interface PreloadApi {
  googleWorkspaceWrite: GoogleWorkspaceWriteApi;
  googleWorkspace: GoogleWorkspaceApi;
  plugins: {
    paths: () => Promise<import("../shared/plugin-storage").PluginStoragePathsDto>;
    openDirectory: () => Promise<{ ok: boolean; path: string; error?: string }>;
  };
  platform: string;
  versions: {
    electron: string;
    node: string;
  };
  /** Issue #17 A1 startup phase marks; the main process ignores them unless measurement is enabled. */
  perf: {
    mark: (name: string) => void;
  };
  gadget: GadgetApi;
  blueprint: BlueprintApi;
  workgraph: {
    addEdge: (req: WorkGraphAddEdgeRequest) => Promise<WorkGraphAddEdgeResult>;
    removeEdge: (id: string) => Promise<WorkGraphRemoveEdgeResult>;
    listOutgoing: (req: WorkGraphListRequest) => Promise<WorkGraphEdgeDto[]>;
    listIncoming: (req: WorkGraphListRequest) => Promise<WorkGraphEdgeDto[]>;
    listRelated: (req: WorkGraphListRequest) => Promise<WorkGraphEdgeDto[]>;
    checkIntegrity: () => Promise<WorkGraphIntegrityReport>;
    previewRepair: (report: WorkGraphIntegrityReport) => Promise<WorkGraphRepairPreview>;
    applyRepair: (preview: WorkGraphRepairPreview) => Promise<{ deletedEdges: number; deletedBindings: number }>;
    observability: () => Promise<WorkGraphObservability>;
    benchmark: () => Promise<WorkGraphBenchmarkResult>;
  };
  conversationRuntime: ConversationRuntimeApi;
  botWork: import("../shared/bot-work-ipc").BotWorkApi;
  setTheme: (theme: "light" | "dark") => void;
  onThemeRequest: (callback: () => void) => void;
  pickLocalFile: () => Promise<WorkspaceFilePreviewDto | null>;
  pickLocalFolder: () => Promise<{ path: string; name: string } | null>;
  /** 目录是否仍在磁盘上（空间文件夹被挪走后为 false） */
  pathExists: (folderPath: string) => Promise<boolean>;
  pickZipFile: () => Promise<{ path: string } | null>;
  openFolder: (folderPath?: string) => Promise<void>;
  showItemInFolder: (filePath: string) => Promise<void>;
  listWorkspaceFiles: (root: string) => Promise<WorkspaceFileNodeDto[]>;
  readWorkspaceFile: (root: string, relativePath: string, textPreview?: boolean) => Promise<WorkspaceFilePreviewDto>;
  trashWorkspacePath: (root: string, relativePath: string) => Promise<WorkspaceMutationResult>;
  renameWorkspacePath: (
    root: string,
    relativePath: string,
    newName: string,
  ) => Promise<WorkspaceMutationResult>;
  moveWorkspacePath: (
    root: string,
    fromRel: string,
    destDirRel: string,
  ) => Promise<WorkspaceMutationResult>;
  createWorkspacePath: (
    root: string,
    parentRel: string,
    name: string,
    kind: "file" | "folder",
  ) => Promise<WorkspaceMutationResult>;
  copyIntoTaskWorkspace: (taskId: string, absPaths: string[]) => Promise<WorkspaceCopyIntoTaskResult>;
  getPathForFile: (file: File) => string;
  /** 剪贴板/无 path 的 File 落盘，返回真实路径（供附件与 agent 读取） */
  saveTempFile: (payload: {
    name?: string;
    base64: string;
    mimeType?: string;
  }) => Promise<{ name: string; path: string } | null>;
  /** 原生拖出文件到系统；须在 dragstart 同步调用 */
  startNativeDrag: (filePaths: string | string[]) => void;
  agent: {
    prompt: (req: AgentPromptRequest) => Promise<AgentPromptResult>;
    submissionStatus: (receipt: AgentSubmissionReceipt) => Promise<AgentPromptResult>;
    waitForSubmission: (receipt: AgentSubmissionReceipt) => Promise<AgentPromptResult>;
    regenerate: (req: AgentRegenerateRequest) => Promise<AgentRegenerateResult>;
    deleteUserMessage: (req: AgentDeleteUserMessageRequest) => Promise<void>;
    abort: (taskId: string) => Promise<void>;
    /** 终止多模型会诊中的单个参与者（返回 false 表示该会诊已结束或该模型已终结）。 */
    stopConsultWorker: (req: import("../shared/agent-ipc").AgentStopConsultWorkerRequest) => Promise<boolean>;
    compact: (taskId: string) => Promise<import("../shared/compaction").TaskCompactionResultDto>;
    abortCompaction: (taskId: string) => Promise<boolean>;
    getCompactionStatus: (taskId: string) => Promise<import("../shared/compaction").TaskCompactionStatusDto>;
    approveTool: (req: AgentApproveToolRequest) => Promise<boolean>;
    setPermissionMode: (req: AgentSetPermissionModeRequest) => Promise<boolean>;
    listBackups: (taskId?: string) => Promise<FileBackupInfoDto[]>;
    restoreBackup: (req: AgentRestoreBackupRequest) => Promise<FileBackupInfoDto>;
    selectModePreset: (req: AgentSelectModePresetRequest) => Promise<void>;
    getRuntimeRequirementStates: () => Promise<RuntimeRequirementStateDto[]>;
    startRuntimeRequirement: (providerId: string) => Promise<void>;
    stopRuntimeRequirement: (providerId: string) => Promise<void>;
    restartRuntimeRequirement: (providerId: string) => Promise<void>;
    /** 订阅 runtime requirement 状态 push（返回取消订阅函数）。 */
    onRuntimeRequirementState: (cb: (state: RuntimeRequirementStateDto) => void) => () => void;
    listModels: () => Promise<ModelInfoDto[]>;
    listSkills: (cwd?: string) => Promise<SkillDto[]>;
    listMarketSkills: (cwd?: string) => Promise<MarketSkillDto[]>;
    installSkill: (id: string) => Promise<SkillDto>;
    installSkillByPath: (path: string) => Promise<SkillDto>;
    authorSkill: (input: SkillAuthoringCreateRequest) => Promise<SkillAuthoringCreateResult>;
    generateSkillAuthoringDraft: (input: SkillAuthoringGenerateRequest) => Promise<SkillAuthoringDraft>;
    generateExpertAuthoringDraft: (input: ExpertAuthoringGenerateRequest) => Promise<ExpertAuthoringDraft>;
    runSkillEvals: (input: SkillEvalRunRequest) => Promise<SkillEvalRunResultDto>;
    getSkillDetail: (skillId: string) => Promise<SkillDetailDto>;
    generateSkillImprovementDraft: (input: SkillImprovementGenerateRequest) => Promise<SkillImprovementDraftResult>;
    applySkillImprovement: (input: SkillImprovementApplyRequest) => Promise<SkillAuthoringCreateResult>;
    validateSkillPackage: (path: string) => Promise<SkillPackageValidationDto>;
    uninstallSkill: (id: string) => Promise<void>;
    deleteMarketSkill: (id: string) => Promise<void>;
    setSkillEnabled: (id: string, enabled: boolean) => Promise<SkillDto>;
    listExperts: () => Promise<ExpertDto[]>;
    listMarketExperts: () => Promise<MarketExpertDto[]>;
    /** 只读：已安装专家的 Private Skills 详情（名称/描述） */
    listExpertPrivateSkills: (expertId: string) => Promise<PrivateSkillDto[]>;
    installExpert: (id: string) => Promise<ExpertDto>;
    installExpertByPath: (path: string) => Promise<ExpertDto>;
    authorExpert: (input: ExpertAuthoringCreateRequest) => Promise<ExpertAuthoringCreateResult>;
    getExpertDetail: (id: string) => Promise<import("../shared/expert-binding").ExpertDetailDto>;
    updateExpert: (input: import("../shared/expert-binding").ExpertUpdateRequest) => Promise<import("../shared/expert-binding").ExpertDetailDto>;
    getTaskExpertBinding: (taskId: string) => Promise<import("../shared/expert-binding").TaskExpertBindingDto>;
    saveTaskExpertBinding: (input: import("../shared/expert-binding").SaveTaskExpertBindingRequest) => Promise<import("../shared/expert-binding").TaskExpertBindingDto>;
    cancelExpertAuthoring: (requestId: string) => Promise<void>;
    importExpertZip: (zipPath: string) => Promise<ExpertDto>;
    exportExpert: (id: string) => Promise<string>;
    uninstallExpert: (id: string) => Promise<void>;
    deleteMarketExpert: (id: string) => Promise<void>;
    setExpertEnabled: (id: string, enabled: boolean) => Promise<ExpertDto>;
    switchExpert: (req: AgentSwitchExpertRequest) => Promise<void>;
    listConnectors: () => Promise<LocalConnectorDto[]>;
    installConnector: (id: string) => Promise<string[]>;
    importConnectorByPath: (path: string) => Promise<LocalConnectorDto>;
    importConnectorZip: (zipPath: string) => Promise<LocalConnectorDto>;
    /** 启用/停用已安装连接器（停用 = 私有技能不再进入候选装配；安装 ≠ active） */
    setConnectorEnabled: (id: string, enabled: boolean) => Promise<void>;
    /** F3：任务级 Active Connector 持久化（settings.json，无新 DB schema） */
    setTaskConnectorIds: (taskId: string, ids: string[]) => Promise<void>;
    clearTaskConnectorIds: (taskId: string) => Promise<void>;
    uninstallConnector: (id: string) => Promise<void>;
    deleteMarketConnector: (id: string) => Promise<void>;
    reloadModels: (providerId?: string) => Promise<ModelReloadResultDto>;
    getModelsPath: () => Promise<string>;
    getModelsConfig: () => Promise<ModelsFileConfigDto>;
    saveModelsConfig: (config: ModelsFileConfigDto) => Promise<ModelInfoDto[]>;
    getAppSettings: () => Promise<AppSettingsDto>;
    updateAppSettings: (partial: Partial<AppSettingsDto>) => Promise<AppSettingsDto>;
    getDiskSpace: () => Promise<DiskSpaceDto>;
    listUserFonts: () => Promise<UserFontDto[]>;
    listSystemFonts: () => Promise<string[]>;
    /** 传入本地路径则直接导入；不传则主进程弹原生文件框 */
    importUserFont: (sourcePath?: string) => Promise<UserFontDto | null>;
    removeUserFont: (id: string) => Promise<UserFontDto[]>;
    readUserFont: (id: string) => Promise<ArrayBuffer | Uint8Array>;
    openFontsDir: () => Promise<string>;
    getWebSearchConfig: () => Promise<WebSearchConfigDto>;
    saveWebSearchConfig: (config: WebSearchConfigDto) => Promise<WebSearchConfigDto>;
    getSearchProviderUsage: (provider: string, keys: string[]) => Promise<SearchProviderKeyUsageDto[]>;
    getBuiltinCapabilities: () => Promise<BuiltinCapabilitiesSnapshotDto>;
    refreshBuiltinMediaServices: () => Promise<BuiltinCapabilitiesSnapshotDto>;
    listBuiltinVideoJobs: (taskId?: string) => Promise<CapabilityVideoJobDto[]>;
    saveBuiltinCapabilitySettings: (request: SaveBuiltinCapabilitySettingsRequest) => Promise<BuiltinCapabilitiesSnapshotDto>;
    saveBuiltinCapabilities: (config: BuiltinCapabilitiesConfigDto) => Promise<BuiltinCapabilitiesSnapshotDto>;
    saveBuiltinCredential: (request: SaveBuiltinCredentialRequest) => Promise<BuiltinCapabilitiesSnapshotDto>;
    testBuiltinCapability: (id: BuiltinCapabilityId) => Promise<TestBuiltinCapabilityResultDto>;
    getSubagentConfig: () => Promise<SubagentConfigDto>;
    saveSubagentConfig: (config: SubagentConfigPatch) => Promise<SubagentConfigDto>;
    getContextUsage: (taskId: string) => Promise<ContextUsageDto | null>;
    loadTaskHistory: (taskId: string, beforeEntryId?: number) => Promise<TaskHistoryDto>;
    listTaskUserQuestions: (taskId: string) => Promise<TaskUserQuestionsDto>;
    generateTaskTitle: (taskId: string) => Promise<TaskTitleSuggestionDto>;
    listLoginProviders: () => Promise<import("../shared/agent-ipc").LoginProviderDto[]>;
    setProviderEnabled: (providerId: string, enabled: boolean) => Promise<ModelInfoDto[]>;
    listCredentials: () => Promise<import("../shared/agent-ipc").CredentialInfoDto[]>;
    login: (
      req: import("../shared/agent-ipc").AuthLoginRequest,
    ) => Promise<import("../shared/agent-ipc").AuthLoginResult>;
    logout: (providerId: string) => Promise<import("../shared/agent-ipc").AuthLogoutResult>;
    authRespond: (requestId: string, value: string) => Promise<boolean>;
    authCancel: (requestId?: string) => Promise<void>;
    getAuthPath: () => Promise<string>;
    listModeProfiles: () => Promise<ModeProfileSummaryDto[]>;
    getModeProfile: (id: WelcomeMode) => Promise<ModeProfileDto>;
    saveModeBlock: (
      id: WelcomeMode,
      blockId: ModeBlockId,
      content: string,
    ) => Promise<ModeProfileDto>;
    saveModePolicy: (id: WelcomeMode, policy: ModePolicyDto) => Promise<ModeProfileDto>;
    resetModeBlock: (id: WelcomeMode, blockId: ModeBlockId) => Promise<ModeProfileDto>;
    resetModePolicy: (id: WelcomeMode) => Promise<ModeProfileDto>;
    resetModeProfile: (id: WelcomeMode) => Promise<ModeProfileDto>;
    openModesDir: (id?: WelcomeMode) => Promise<string>;
    /** 打开场景文案 .md 或 policy.json */
    openModeFile: (id: WelcomeMode, target: ModeBlockId | "policy") => Promise<string>;
    assembleModePreview: (req: AssembleModePreviewRequest) => Promise<AssemblyTraceDto>;
    inspectRuntimeContext: (taskId: string) => Promise<RuntimeContextInspectionDto>;
    getTaskDiagnostics: (taskId: string, limit?: number, offset?: number) => Promise<import("../shared/task-diagnostics").TaskDiagnosticsDto>;
    listAgentLoadoutObservations: (taskId: string, limit?: number) => Promise<AgentLoadoutObservationDto[]>;
    listRuntimeContextSnapshots: (taskId: string, limit?: number) => Promise<RuntimeContextSnapshotDto[]>;
    clearRuntimeContextSnapshots: (taskId?: string) => Promise<number>;
    clearRuntimeAudit: (taskId?: string) => Promise<RuntimeAuditClearResultDto>;
    onAuthPrompt: (
      callback: (req: import("../shared/agent-ipc").AuthPromptRequestDto) => void,
    ) => () => void;
    onAuthEvent: (
      callback: (ev: import("../shared/agent-ipc").AuthEventDto) => void,
    ) => () => void;
    onEvent: (callback: (patch: AgentUiPatch) => void) => () => void;
  };
  notification: {
    list: (request?: NotificationListRequest) => Promise<NotificationDto[]>;
    unreadCount: () => Promise<number>;
    markRead: (id: string) => Promise<void>;
    markAllRead: () => Promise<void>;
    dismiss: (id: string) => Promise<void>;
    dismissAll: () => Promise<void>;
    onChanged: (callback: (event: NotificationChangedEvent) => void) => () => void;
  };
  /** 对话分支（Branch in new task）：窄 API，不暴露 SessionManager/路径（§6.1） */
  conversationBranch: {
    preview: (request: CreateConversationBranchRequest) => Promise<ConversationBranchPreviewDto>;
    create: (request: CreateConversationBranchRequest) => Promise<ConversationBranchCreateOutcome>;
    getInfo: (taskId: string) => Promise<ConversationBranchInfoDto | undefined>;
    listChildren: (taskId: string) => Promise<ConversationBranchInfoDto[]>;
  };
  /** Subagent 临时 Chat（task-scoped：仅当前父 Task 运行中实例） */
  subagent: {
    active: (taskId: string) => Promise<SubagentSummaryDto[]>;
    transcript: (subagentId: string) => Promise<SubagentTranscriptDto>;
    steer: (subagentId: string, instruction: string) => Promise<SubagentSteerResultDto>;
    cancel: (subagentId: string) => Promise<{ ok: boolean; message: string }>;
    onEvent: (callback: (ev: { ts: number }) => void) => () => void;
  };
  /** 外部 Agent：ACP Runtime（与 Pi/Subagent 独立） */
  externalAgent: {
    listAgents: (refresh?: boolean) => Promise<ExternalAgentDescriptorDto[]>;
    setEnabled: (agentId: ExternalAgentId, enabled: boolean) => Promise<ExternalAgentDescriptorDto[]>;
    setConfigOption: (req: ExternalAgentSetConfigOptionRequest) => Promise<ExternalAgentDescriptorDto[]>;
    test: (agentId: ExternalAgentId) => Promise<ExternalAgentTestResultDto>;
    prompt: (req: ExternalAgentPromptRequest) => Promise<ExternalAgentPromptResult>;
    cancel: (runId?: string, taskId?: string) => Promise<{ ok: boolean; message: string }>;
    resolvePermission: (req: ExternalAgentResolvePermissionRequest) => Promise<{ ok: boolean; message: string }>;
    history: (taskId: string) => Promise<ExternalAgentHistoryDto>;
    active: (taskId?: string) => Promise<ExternalAgentRunDto[]>;
    onEvent: (callback: (event: ExternalAgentUiEvent) => void) => () => void;
  };
  /** BTW（临时上下文分支）：瞬时会话桥（独立 btw:event 通道） */
  btw: {
    start: (req: BtwStartRequest) => Promise<void>;
    prompt: (req: BtwPromptRequest) => Promise<void>;
    abort: (btwId: string) => Promise<void>;
    close: (btwId: string) => Promise<void>;
    keepalive: (btwIds: string[]) => Promise<void>;
    onEvent: (callback: (patch: BtwUiPatch) => void) => () => void;
  };
  /** 用量统计（账户面板；主进程 usage_events 事实表） */
  usage: {
    summary: (rangeDays: number) => Promise<UsageSummaryDto>;
    drilldown: (rangeDays: number) => Promise<UsageDrilldownRowDto[]>;
    trend: (rangeDays: number) => Promise<UsageTrendPointDto[]>;
    heatmap: (year: number) => Promise<UsageHeatmapCellDto[]>;
    monthly: () => Promise<UsageMonthlyPointDto[]>;
    exportCsv: (rangeDays: number) => Promise<string>;
    dashboard: (rangeDays: number) => Promise<UsageDashboardDto>;
  };
  /** Prompt Enhance（Instruction Enhancement）：消息发送前的单轮指令增强，与 BTW/任务管道完全独立 */
  enhance: {
    prompt: (req: EnhancePromptRequest) => Promise<EnhancePromptResult>;
  };
  memoryGateway: {
    status: () => Promise<MemoryGatewayStatusDto>;
    configure: (request: MemoryGatewayConfigureRequest) => Promise<MemoryGatewayStatusDto>;
    listGrants: () => Promise<MemoryGatewayAccessGrantDto[]>;
    createGrant: (request: MemoryGatewayCreateGrantRequest) => Promise<MemoryGatewayIssuedGrantDto>;
    updateGrant: (request: MemoryGatewayUpdateGrantRequest) => Promise<MemoryGatewayAccessGrantDto>;
    rotateGrant: (id: string) => Promise<MemoryGatewayIssuedGrantDto>;
    deleteGrant: (id: string) => Promise<void>;
  };
  remoteAccess: {
    status: () => Promise<RemoteStatus>;
    configure: (request: RemoteConfigureRequest) => Promise<RemoteStatus>;
    listDevices: () => Promise<RemoteDeviceSummary[]>;
    revokeDevice: (id: string) => Promise<boolean>;
    createPairingSession: () => Promise<RemotePairingSession>;
    cancelPairingSession: (id: string) => Promise<void>;
    openPairWindow: () => Promise<RemotePairWindowDto>;
    closePairWindow: () => Promise<void>;
    pairWindowState: () => Promise<RemotePairWindowDto | null>;
    detectCloudflared: () => Promise<RemoteCloudflaredStatus>;
  };
  memory: {
    organization: () => Promise<import("../shared/memory-organization").MemoryOrganizationRun | null>;
    startOrganization: (resumeId?: string) => Promise<import("../shared/memory-organization").MemoryOrganizationRun>;
    pauseOrganization: (id: string) => Promise<import("../shared/memory-organization").MemoryOrganizationRun>;
    applyOrganization: (id: string) => Promise<import("../shared/memory-organization").MemoryOrganizationRun>;
    undoOrganization: (id: string) => Promise<import("../shared/memory-organization").MemoryOrganizationRun>;
    dismissOrganization: (id: string) => Promise<import("../shared/memory-organization").MemoryOrganizationRun>;
    list: (request?: MemoryListRequest | number) => Promise<MemoryRecordDto[]>;
    turns: (request?: MemoryTurnListRequest) => Promise<MemoryTurnDto[]>;
    getTurn: (id: string) => Promise<MemoryTurnDto | undefined>;
    turnTasks: () => Promise<import("../shared/memory-kernel").MemoryTurnTaskDto[]>;
    deleteAllTurns: () => Promise<number>;
    deleteTurns: (ids: string[]) => Promise<number>;
    memoriesForTurn: (turnId: string) => Promise<MemoryRecordDto[]>;
    search: (request: MemorySearchRequest) => Promise<MemorySearchHit[]>;
    get: (id: string) => Promise<MemoryRecordDto | undefined>;
    create: (request: MemoryCreateRequest) => Promise<MemoryRecordDto>;
    update: (request: MemoryUpdateRequest) => Promise<MemoryRecordDto>;
    forget: (ids: string | string[]) => Promise<void>;
    promote: (id: string, scopeType: MemoryScopeType, scopeId?: string) => Promise<MemoryRecordDto>;
    detachScope: (id: string, scopeType: MemoryScopeType, scopeId?: string) => Promise<{ detached: boolean; forgotten: boolean }>;
    retryFailedTurns: () => Promise<number>;
    extractPendingTurns: () => Promise<import("../shared/memory-kernel").MemoryExtractionRunResult>;
    dismissProjection: (id: string, kind: "scenario" | "profile") => Promise<boolean>;
    deleteProjectionRecords: (request: import("../shared/memory-kernel").MemoryProjectionDeleteRequest) => Promise<import("../shared/memory-kernel").MemoryProjectionDeleteResult>;
    restoreProjection: (id: string) => Promise<boolean>;
    dismissedProjections: () => Promise<MemoryDismissedProjectionDto[]>;
    generateL2Proposals: () => Promise<{ completed: boolean; scopesProcessed: number; outputs: number }>;
    generateL3Proposals: () => Promise<{ completed: boolean; scopesProcessed: number; outputs: number }>;
    projectionProposals: () => Promise<MemoryProjectionProposalDto[]>;
    approveProjectionProposal: (id: string) => Promise<boolean>;
    rejectProjectionProposal: (id: string) => Promise<boolean>;
    restoreProjectionProposal: (id: string) => Promise<boolean>;
    history: (id: string) => Promise<MemoryRevisionDto[]>;
    candidates: (status?: MemoryCandidateDto["status"], limit?: number) => Promise<MemoryCandidateDto[]>;
    resolveCandidate: (id: string, decision: "approve" | "reject") => Promise<{ status: "committed" | "rejected" | "needs_review"; memoryId?: string }>;
    stats: () => Promise<MemoryKernelStats>;
    scenarios: (limit?: number) => Promise<MemoryScenarioDto[]>;
    coreProfiles: (limit?: number) => Promise<MemoryCoreProfileDto[]>;
    skillCandidates: (status?: MemorySkillCandidateStatus, limit?: number) => Promise<MemorySkillCandidateDto[]>;
    skillLearningStatus: () => Promise<import("../shared/memory-kernel").MemorySkillLearningStatusDto>;
    deleteSkillHistory: (request: import("../shared/memory-kernel").MemorySkillHistoryDeleteRequest) => Promise<number>;
    refreshSkillCandidates: () => Promise<{ evaluated: number; created: number; updated: number; staled: number; ready: number }>;
    approveSkillCandidate: (id: string) => Promise<MemorySkillCandidateDto>;
    rejectSkillCandidate: (id: string) => Promise<MemorySkillCandidateDto>;
    skillEffectiveness: (limit?: number, invokedOnly?: boolean) => Promise<MemorySkillEffectivenessDto[]>;
    skillEffectivenessSummary: (limit?: number) => Promise<MemorySkillEffectivenessSummaryDto[]>;
    setSkillFeedback: (id: string, kind: MemorySkillFeedbackKind | null, note?: string) => Promise<MemorySkillEffectivenessDto>;
    skillRevisionCandidates: (status?: MemorySkillRevisionStatus, limit?: number) => Promise<MemorySkillRevisionCandidateDto[]>;
    refreshSkillRevisionCandidates: () => Promise<{ evaluated: number; created: number; staled: number; ready: number }>;
    approveSkillRevisionCandidate: (id: string) => Promise<{ candidate: MemorySkillRevisionCandidateDto; skill: SkillDto }>;
    rejectSkillRevisionCandidate: (id: string) => Promise<MemorySkillRevisionCandidateDto>;
    reindexSemantic: (limit?: number) => Promise<{ indexed: number; failed: number }>;
  };
  db: {
    listSpaces: () => Promise<SpaceDto[]>;
    listTasks: () => Promise<TaskDto[]>;
    listProjects: (includeArchived?: boolean) => Promise<ProjectDto[]>;
    getProject: (id: string) => Promise<ProjectDetailsDto | undefined>;
    createProject: (request: ProjectCreateRequest) => Promise<ProjectMutationResult>;
    updateProject: (request: ProjectUpdateRequest) => Promise<ProjectMutationResult>;
    duplicateProject: (request: ProjectDuplicateRequest) => Promise<ProjectMutationResult>;
    archiveProject: (id: string, archived: boolean) => Promise<ProjectMutationResult>;
    deleteProject: (id: string) => Promise<void>;
    createProjectResource: (request: ProjectResourceCreateRequest) => Promise<ProjectResourceDto>;
    updateProjectResource: (request: ProjectResourceUpdateRequest) => Promise<ProjectResourceDto>;
    deleteProjectResource: (id: string) => Promise<void>;
    inspectProjectResources: (projectId: string) => Promise<ProjectResourceInspectionDto | null>;
    listProjectPosts: (projectId: string) => Promise<import("../shared/project-domain").ProjectPostDto[]>;
    createProjectPost: (request: import("../shared/project-domain").ProjectPostCreateRequest) => Promise<import("../shared/project-domain").ProjectPostDto>;
    deleteProjectPost: (id: string) => Promise<void>;
    listProjectTodos: (projectId: string) => Promise<import("../shared/project-domain").ProjectTodoDto[]>;
    createProjectTodo: (request: import("../shared/project-domain").ProjectTodoCreateRequest) => Promise<import("../shared/project-domain").ProjectTodoDto>;
    updateProjectTodo: (request: import("../shared/project-domain").ProjectTodoUpdateRequest) => Promise<import("../shared/project-domain").ProjectTodoDto>;
    deleteProjectTodo: (id: string) => Promise<void>;
    listProjectMemory: (projectId: string) => Promise<import("../shared/project-domain").ProjectMemoryItemDto[]>;
    createProjectMemory: (request: import("../shared/project-domain").ProjectMemoryCreateRequest) => Promise<import("../shared/project-domain").ProjectMemoryItemDto>;
    updateProjectMemory: (request: import("../shared/project-domain").ProjectMemoryUpdateRequest) => Promise<import("../shared/project-domain").ProjectMemoryItemDto>;
    deleteProjectMemory: (request: import("../shared/project-domain").ProjectMemoryDeleteRequest) => Promise<void>;
    pinProjectItem: (request: import("../shared/project-domain").ProjectContextPinRequest) => Promise<import("../shared/project-domain").ProjectContextPinDto>;
    unpinProjectItem: (request: import("../shared/project-domain").ProjectContextUnpinRequest) => Promise<{ ok: true }>;
    listProjectPins: (projectId: string) => Promise<import("../shared/project-domain").ProjectContextPinDto[]>;
    listExecutionFailures: (taskId: string) => Promise<import("../shared/execution-recovery").ExecutionFailureDto[]>;
    dismissExecutionFailure: (taskId: string, id: string) => Promise<boolean>;
    previewProjectFolder: (projectId: string, path: string) => Promise<import("../shared/project-domain").ProjectFolderPreview>;
    commitProjectFolder: (token: string) => Promise<{ ok: true }>;
    getProjectStatus: (projectId: string) => Promise<import("../shared/project-domain").ProjectStatusSnapshotDto>;
    recordProjectReview: (request: { projectId: string; note?: string }) => Promise<import("../shared/project-domain").ProjectReviewDto>;
    getProjectActions: (projectId: string) => Promise<import("../shared/project-domain").ProjectActionProposalDto[]>;
    onProjectTaskChanged: (callback: (change: { projectId: string }) => void) => () => void;
    getProjectAttention: (projectId: string) => Promise<import("../shared/project-domain").ProjectAttentionDigestDto | null>;
    acknowledgeProjectAttention: (projectId: string) => Promise<import("../shared/project-domain").ProjectAttentionDigestDto | null>;
    onProjectAttentionChanged: (callback: (digest: import("../shared/project-domain").ProjectAttentionDigestDto) => void) => () => void;
    listProjectEvents: (projectId: string, limit?: number) => Promise<import("../shared/project-domain").ProjectEventDto[]>;
    promoteProjectEvent: (request: import("../shared/project-domain").ProjectEventPromoteRequest) => Promise<import("../shared/project-domain").ProjectEventPromoteResultDto>;
    ingestProjectDocument: (projectId: string, request: { title: string; body: string; ref?: string }) => Promise<import("../shared/project-domain").ProjectEventDto>;
    importProjectFile: (projectId: string, sourcePath: string) => Promise<{
      event: import("../shared/project-domain").ProjectEventDto;
      item: import("../shared/library-ipc").LibraryItemDto | null;
      reused: boolean;
    }>;
    pickImportFile: () => Promise<string | null>;
    dismissProjectEvent: (projectId: string, eventId: string) => Promise<import("../shared/project-domain").ProjectEventDto>;
    reopenProjectEvent: (projectId: string, eventId: string) => Promise<import("../shared/project-domain").ProjectEventDto>;
    onProjectEventsChanged: (callback: (change: { projectId: string }) => void) => () => void;
    upsertSpace: (space: SpaceDto) => Promise<
      import("../shared/agent-ipc").DbUpsertResult
    >;
    renameSpace: (id: string, name: string) => Promise<
      import("../shared/agent-ipc").DbRenameResult
    >;
    upsertTask: (task: TaskDto) => Promise<void>;
    deleteTask: (id: string) => Promise<void>;
    purgeArchivedContent: (request: ArchivedContentDeletionRequest) => Promise<ArchivedContentDeletionResult>;
    archiveTask: (id: string, archived: boolean) => Promise<void>;
    /** 侧栏「已结束」绿点确认：写 done_acked_at（unix ms），点击任务即视为已查看 */
    ackTaskDone: (id: string, ackedAt?: number) => Promise<void>;
    listTrashedTasks: () => Promise<TrashedTaskDto[]>;
    restoreTrashedTask: (id: string) => Promise<TaskDto | null>;
    listTaskWriteGrants: (taskId: string) => Promise<import("../shared/external-write").TaskWriteGrantRow[]>;
    deleteTaskWriteGrant: (taskId: string, path: string) => Promise<boolean>;
    deleteSpace: (id: string) => Promise<{ ok: true; warning?: string } | { ok: false; reason: string; error: string }>;
    archiveSpace: (id: string, archived: boolean) => Promise<void>;
    getSoul: () => Promise<SoulDto>;
    updateSoul: (partial: Partial<SoulDto>) => Promise<SoulDto>;
    onMemoryChanged: (callback: (change: MemoryChangedDto) => void) => () => void;
  };
  cron: {
    list: () => Promise<CronJobDto[]>;
    runs: (limit?: number) => Promise<CronRunDto[]>;
    upsert: (job: CronJobDto) => Promise<CronJobDto>;
    setEnabled: (id: string, enabled: boolean) => Promise<void>;
    remove: (id: string) => Promise<void>;
    runNow: (id: string) => Promise<void>;
    onEvent: (callback: (ev: unknown) => void) => () => void;
  };
  gateway: {
    weixinQrStart: (approvedPersistentAccess: boolean) => Promise<GatewayWeixinQrLoginStateDto>;
    qqQrStart: (approvedPersistentAccess: boolean) => Promise<GatewayQQQrLoginStateDto>;
    weixinQrState: () => Promise<GatewayWeixinQrLoginStateDto>;
    qqQrState: () => Promise<GatewayQQQrLoginStateDto>;
    weixinQrCancel: (sessionId?: string) => Promise<GatewayWeixinQrLoginStateDto>;
    qqQrCancel: (sessionId?: string) => Promise<GatewayQQQrLoginStateDto>;
    status: () => Promise<GatewayStatusDto>;
    listChannels: () => Promise<GatewayStatusDto["channels"]>;
    connect: (channelId: string, config: Record<string, unknown>) => Promise<GatewayStatusDto>;
    disconnect: (channelId: string) => Promise<GatewayStatusDto>;
    getChannelConfig: (channelId: string) => Promise<GatewayChannelConfigDto>;
    listMessages: (req: GatewayListMessagesRequest) => Promise<GatewayMessageDto[]>;
    onEvent: (callback: (ev: GatewayEventDto) => void) => () => void;
  };
  mcp: {
    discover: () => Promise<McpDiscoveryDto>;
    listServers: () => Promise<McpServerDto[]>;
    install: (names: string[]) => Promise<McpInstallResultDto>;
    /** 安装 extensions/mcp 捆绑 serena/codegraph（modes: coding） */
    installBundled: () => Promise<McpInstallResultDto>;
    remove: (names: string[]) => Promise<McpInstallResultDto>;
    setServerEnabled: (name: string, enabled: boolean) => Promise<McpInstallResultDto>;
    readAppConfig: () => Promise<McpProjectConfigDto>;
    readServerConfig: (name: string) => Promise<import("../shared/agent-ipc").McpServerConfigDto>;
    saveServerConfig: (request: import("../shared/agent-ipc").McpSaveServerRequest) => Promise<McpInstallResultDto>;
    serverTools: (name: string) => Promise<import("../shared/agent-ipc").McpServerToolsDto>;
    writeAppConfig: (text: string) => Promise<McpInstallResultDto>;
    status: (taskId?: string) => Promise<McpStatusSnapshotDto | null>;
    connect: (name: string) => Promise<McpProxyResultDto>;
    authStart: (name: string) => Promise<McpProxyResultDto>;
    authComplete: (name: string, input: string) => Promise<McpProxyResultDto>;
    logout: (name: string) => Promise<{ ok: boolean; error?: string }>;
    hasCredentials: (name: string) => Promise<boolean>;
    uiRespond: (requestId: string, value?: string | boolean) => Promise<boolean>;
    uiCancel: (requestId?: string) => Promise<void>;
    onStatusEvent: (callback: (snapshot: McpStatusSnapshotDto) => void) => () => void;
    onNotify: (callback: (ev: McpNotifyDto) => void) => () => void;
    onUiPrompt: (callback: (req: McpUiPromptDto) => void) => () => void;
  };
  professionalTools: {
    status: (providerId: ProfessionalToolProviderId) => Promise<ProfessionalToolStatusDto>;
    prepare: (providerId: ProfessionalToolProviderId) => Promise<ProfessionalToolResultDto>;
    open: (providerId: ProfessionalToolProviderId) => Promise<ProfessionalToolResultDto>;
    stop: (providerId: ProfessionalToolProviderId) => Promise<ProfessionalToolStatusDto>;
  };
  /** 浏览器 / HTML 产物预览共享控制台。 */
  runtimeConsole: {
    snapshot: (target: BrowserConsoleTarget) => Promise<BrowserConsoleSnapshotDto>;
    clear: (target: BrowserConsoleTarget) => Promise<boolean>;
    onEntry: (callback: (event: BrowserConsoleEventDto) => void) => () => void;
  };
  /** 扩展栏浏览器 */
  browser: {
    getTabs: () => Promise<BrowserTabsState>;
    ensureTab: (options: BrowserOpenOptions) => Promise<BrowserTabInfo>;
    selectTab: (id: string) => void;
    closeTab: (id: string) => void;
    onTabsChanged: (callback: (state: BrowserTabsState) => void) => () => void;
    open: (url: string, options?: BrowserOpenOptions) => void;
    close: () => void;
    navigate: (url: string) => void;
    reload: () => void;
    hardReload: () => void;
    back: () => void;
    forward: () => void;
    /** 无参：打开扩展栏当前页；有 url：在系统浏览器打开指定 http(s) */
    openExternal: (url?: string) => void;
    setRect: (rect: { x: number; y: number; width: number; height: number }) => void;
    hide: () => void;
    show: () => void;
    addBlocker: (token: string) => void;
    removeBlocker: (token: string) => void;
    onUrlChanged: (callback: (url: string) => void) => () => void;
    onOpenRequest: (callback: (url: string) => void) => () => void;
  };
  /** 扩展栏终端（node-pty，主进程托管；renderer 只走白名单 IPC） */
  terminal: {
    open: (req: TerminalOpenRequest) => Promise<TerminalSessionInfo>;
    restart: (req: TerminalOpenRequest) => Promise<TerminalSessionInfo>;
    input: (req: TerminalInputRequest) => void;
    resize: (req: TerminalResizeRequest) => void;
    close: (req: TerminalCloseRequest) => void;
    tail: (req: TerminalTailRequest) => Promise<TerminalTailResult>;
    prepareHerdr: (req: TerminalPrepareHerdrRequest) => Promise<TerminalPrepareHerdrResult>;
    onData: (callback: (ev: TerminalDataEvent) => void) => () => void;
    onExit: (callback: (ev: TerminalExitEvent) => void) => () => void;
  };
  /** 受管 Python 运行时（解释器/环境由主进程权威解析，renderer 不传安装路径） */
  pythonRuntime: {
    status: () => Promise<PythonRuntimeStatus>;
    list: () => Promise<PythonEnvironmentInfo[]>;
    prepare: (req: PreparePythonEnvironmentRequest) => Promise<PreparePythonEnvironmentResult>;
    remove: (environmentId: string) => Promise<{ ok: boolean; detail: string }>;
    cleanStaging: () => Promise<{ removed: number; detail: string }>;
    /** 回收被取代的 uv 版本目录与下载缓存 */
    reclaimDisk: () => Promise<{ removed: number; detail: string }>;
    /** 导出诊断快照到用户选择的 JSON 文件 */
    exportDiagnostics: () => Promise<PythonDiagnosticsExportResult>;
    /** 当前项目解释器：手动覆盖优先，否则自动识别项目内虚拟环境 */
    inspectProject: (projectDir: string) => Promise<PythonProjectInterpreterView>;
    /** 手动覆盖记录，仅诊断/兼容使用 */
    listProjectBindings: () => Promise<PythonProjectBindingView[]>;
    bindProject: (req: PythonProjectBindingRequest) => Promise<PythonProjectBindingMutationResult>;
    unbindProject: (projectDir: string) => Promise<{ ok: boolean; detail: string }>;
    pickProjectDir: () => Promise<string | null>;
    pickInterpreter: (defaultPath?: string) => Promise<string | null>;
    onProgress: (callback: (ev: PythonRuntimeProgressEvent) => void) => () => void;
  };
  artifact: {
    preview: (req: ArtifactPreviewRequest) => Promise<{ ok: boolean }>;
    reload: () => void;
    hardReload: () => void;
    openInBrowser: (req: ArtifactPreviewRequest) => Promise<{ ok: boolean; error?: string }>;
    close: () => void;
    /** Wave 4A：显示意图统一走 NativeSurfaceCoordinator（§75）；setRect/hide/show 已移除 */
    surface: {
      requestBounds: (surfaceId: string, rect: { x: number; y: number; width: number; height: number }) => void;
      requestVisible: (surfaceId: string, visible: boolean) => void;
      addBlocker: (surfaceId: string, token: string) => void;
      removeBlocker: (surfaceId: string, token: string) => void;
    };
  };
  /** Wave 4C：Capture Mode MVP（§78-82） */
  captureMode: {
    enter: (req: import("../shared/capture-mode").CaptureModeEnterRequest) => Promise<{ ok: boolean }>;
    exit: () => void;
    startInspect: () => void;
    stopInspect: () => void;
    onState: (cb: (ev: import("../shared/capture-mode").CaptureModeStateEvent) => void) => () => void;
  };
  /** Wave 4D：Selection 投影（唯一 truth 在 main SelectionStore） */
  selection: {
    comment: () => void;
    onAttach: (callback: (event: import("../shared/selection").SelectionAttachEvent) => void) => () => void;
    get: () => Promise<import("../shared/selection").SelectionState | null>;
    clear: () => void;
    onChanged: (cb: (ev: import("../shared/selection").SelectionChangedEvent) => void) => () => void;
  };
  /** Wave 4E：Prompt Context 采集（E2E 入口；不接 Agent） */
  promptContext: {
    collect: (req: import("../shared/prompt-context").PromptContextCollectRequest) => Promise<import("../shared/prompt-context").PromptContextResult>;
  };
  /** Artifact Domain（V3.5 Wave 2：通道已通，renderer 暂未消费） */
  artifactDomain: {
    get: (req: import("../shared/artifact-ipc").ArtifactDomainGetRequest) => Promise<
      import("../shared/artifact-ipc").ArtifactDomainGetResponse
    >;
    list: (req: import("../shared/artifact-ipc").ArtifactDomainTaskRequest) => Promise<
      import("../shared/artifact-ipc").ArtifactDomainListResponse
    >;
    snapshot: (req: import("../shared/artifact-ipc").ArtifactDomainTaskRequest) => Promise<
      import("../shared/artifact-types").ArtifactSnapshot
    >;
    register: (req: import("../shared/artifact-ipc").ArtifactDomainRegisterRequest) => Promise<
      import("../shared/artifact-types").ArtifactDescriptor
    >;
    readContent: (req: import("../shared/artifact-ipc").ArtifactDomainReadContentRequest) => Promise<
      import("../shared/artifact-ipc").ArtifactDomainReadContentResponse | null
    >;
    removeTask: (req: import("../shared/artifact-ipc").ArtifactDomainTaskRequest) => Promise<{
      removed: number;
      orphaned: number;
    }>;
    remove: (req: import("../shared/artifact-ipc").ArtifactDomainRemoveRequest) => Promise<{
      ok: boolean;
    }>;
    onCreated: (callback: (ev: import("../shared/artifact-types").ArtifactCreatedEvent) => void) => () => void;
    onUpdated: (callback: (ev: import("../shared/artifact-types").ArtifactUpdatedEvent) => void) => () => void;
    onRemoved: (callback: (ev: import("../shared/artifact-types").ArtifactRemovedEvent) => void) => () => void;
  };
  library: {
    snapshot: () => Promise<import("../shared/library-ipc").LibrarySnapshotDto>;
    listItems: (req: import("../shared/library-ipc").LibraryListItemsRequest) => Promise<import("../shared/library-ipc").LibraryItemDto[]>;
    getItem: (id: string) => Promise<import("../shared/library-ipc").LibraryItemDto | null>;
    createSpace: (req: import("../shared/library-ipc").LibraryCreateSpaceRequest) => Promise<{ ok: true; value: import("../shared/library-ipc").LibrarySpaceDto } | { ok: false; error: string }>;
    ensureOwnedSpace: (owner: import("../shared/library-ipc").LibraryOwnerScope) => Promise<{ ok: true; value: import("../shared/library-ipc").LibrarySpaceDto } | { ok: false; error: string }>;
    renameSpace: (req: import("../shared/library-ipc").LibraryRenameSpaceRequest) => Promise<{ ok: true; value: import("../shared/library-ipc").LibrarySpaceDto } | { ok: false; error: string }>;
    deleteSpace: (id: string) => Promise<{ ok: true; value: void } | { ok: false; error: string }>;
    createCollection: (req: import("../shared/library-ipc").LibraryCreateCollectionRequest) => Promise<{ ok: true; value: import("../shared/library-ipc").LibraryCollectionDto } | { ok: false; error: string }>;
    renameCollection: (req: import("../shared/library-ipc").LibraryRenameCollectionRequest) => Promise<{ ok: true; value: import("../shared/library-ipc").LibraryCollectionDto } | { ok: false; error: string }>;
    moveCollection: (req: import("../shared/library-ipc").LibraryMoveCollectionRequest) => Promise<{ ok: true; value: import("../shared/library-ipc").LibraryCollectionDto } | { ok: false; error: string }>;
    deleteCollection: (id: string) => Promise<{ ok: true; value: void } | { ok: false; error: string }>;
    createItem: (req: import("../shared/library-ipc").LibraryCreateItemRequest) => Promise<{ ok: true; value: import("../shared/library-ipc").LibraryItemDto } | { ok: false; error: string }>;
    updateItem: (req: import("../shared/library-ipc").LibraryUpdateItemRequest) => Promise<{ ok: true; value: import("../shared/library-ipc").LibraryItemDto } | { ok: false; error: string }>;
    deleteItem: (id: string) => Promise<{ ok: true; value: void } | { ok: false; error: string }>;
    readContent: (id: string) => Promise<{ ok: true; value: import("../shared/library-ipc").LibraryContentDto } | { ok: false; error: string }>;
    writeContent: (req: import("../shared/library-ipc").LibraryWriteContentRequest) => Promise<{ ok: true; value: import("../shared/library-ipc").LibraryItemDto } | { ok: false; error: string }>;
    importFile: (req: import("../shared/library-ipc").LibraryImportFileRequest) => Promise<{ ok: true; value: import("../shared/library-ipc").LibraryItemDto } | { ok: false; error: string }>;
    pickAndImport: (req: {
      spaceId: string;
      collectionId?: string | null;
    }) => Promise<{ ok: true; value: import("../shared/library-ipc").LibraryItemDto[] } | { ok: false; error: string }>;
    markVisited: (id: string) => Promise<{ ok: true; value: import("../shared/library-ipc").LibraryItemDto } | { ok: false; error: string }>;
    search: (req: import("../shared/library-ipc").LibrarySearchRequest) => Promise<import("../shared/library-ipc").LibraryListRowDto[]>;
    previewUrl: (id: string) => Promise<string>;
    showInFolder: (id: string) => Promise<{ ok: true } | { ok: false; error: string }>;
    createUrl: (req: import("../shared/library-ipc").LibraryCreateUrlRequest) => Promise<{ ok: true; value: import("../shared/library-ipc").LibraryItemDto } | { ok: false; error: string }>;
    saveArtifact: (req: import("../shared/library-ipc").LibrarySaveArtifactRequest) => Promise<{ ok: true; value: import("../shared/library-ipc").LibraryItemDto } | { ok: false; error: string }>;
    favorite: (req: import("../shared/library-ipc").LibraryFavoriteRequest) => Promise<{ ok: true; value: import("../shared/library-ipc").LibraryItemDto } | { ok: false; error: string }>;
    attachToTask: (req: import("../shared/library-ipc").LibraryAttachRequest) => Promise<{ ok: true; value: import("../shared/library-ipc").LibraryTaskReferenceDto } | { ok: false; error: string }>;
    detachFromTask: (req: import("../shared/library-ipc").LibraryDetachRequest) => Promise<{ ok: true; value: void } | { ok: false; error: string }>;
    listTaskReferences: (taskId: string) => Promise<{ ok: true; value: import("../shared/library-ipc").LibraryTaskReferencesDto } | { ok: false; error: string }>;
  };
  htmlEdit: import("../shared/html-edit").HtmlEditApi;
  projectNotes: import("../shared/project-notes").ProjectNotesApi;
  workspace: {
    notes: import("../shared/workspace-notes").WorkspaceNotesApi;
    getSharedContextView: (req: WorkspaceSharedContextViewRequest) => Promise<WorkspaceSharedContextView>;
    promoteSharedContextItem: (req: WorkspaceSharedContextPromoteRequest) => Promise<WorkspaceSharedContextPromoteResult>;
    libraryBindings: {
      createFolder: (req: { workspaceId: string; librarySpaceId: string; name: string }) => Promise<WorkspaceLibraryBindingMutationResult>;
      list: (workspaceId: string) => Promise<WorkspaceLibraryBindingListView>;
      bind: (req: WorkspaceLibraryBindingRequest) => Promise<WorkspaceLibraryBindingMutationResult>;
      unbind: (req: WorkspaceLibraryBindingRequest) => Promise<WorkspaceLibraryBindingMutationResult>;
    };
  };
}

declare global {
  interface Window {
    api?: PreloadApi;
  }
}

export {};
