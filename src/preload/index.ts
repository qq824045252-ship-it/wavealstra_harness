import { contextBridge, ipcRenderer, webUtils } from "electron";
import { ProjectNotesIpc, type ProjectNoteSaveRequest } from "../shared/project-notes";
import { WorkspaceNotesIpc, type WorkspaceNoteSaveRequest } from "../shared/workspace-notes";
import { ArchivedContentDeletionIpc, TrashIpc, type ArchivedContentDeletionRequest, type ArchivedContentDeletionResult } from "../shared/archive-deletion";
import { PluginStorageIpc, type PluginStoragePathsDto } from "../shared/plugin-storage";
import type { McpServerConfigDto, McpSaveServerRequest } from "../shared/agent-ipc";
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
import {
  TerminalIpc,
  type TerminalCloseRequest,
  type TerminalDataEvent,
  type TerminalExitEvent,
  type TerminalInputRequest,
  type TerminalOpenRequest,
  type TerminalPrepareHerdrRequest,
  type TerminalPrepareHerdrResult,
  type TerminalResizeRequest,
  type TerminalSessionInfo,
  type TerminalTailRequest,
  type TerminalTailResult,
} from "../shared/terminal-ipc";
import {
  PythonRuntimeIpc,
  type PreparePythonEnvironmentRequest,
  type PreparePythonEnvironmentResult,
  type PythonDiagnosticsExportResult,
  type PythonEnvironmentInfo,
  type PythonProjectBindingMutationResult,
  type PythonProjectBindingRequest,
  type PythonProjectBindingView,
  type PythonProjectInterpreterView,
  type PythonRuntimeProgressEvent,
  type PythonRuntimeStatus,
} from "../shared/python-runtime";
import { WorkspaceIpc } from "../shared/agent-ipc";
import { ConversationRuntimeIpc } from "../shared/conversation-runtime";
import { ExternalAgentIpc, type ExternalAgentDescriptorDto, type ExternalAgentHistoryDto, type ExternalAgentId, type ExternalAgentPromptRequest, type ExternalAgentPromptResult, type ExternalAgentResolvePermissionRequest, type ExternalAgentRunDto, type ExternalAgentSetConfigOptionRequest, type ExternalAgentTestResultDto, type ExternalAgentUiEvent } from "../shared/external-agent";
import type { ConversationRuntimeApi } from "../shared/conversation-runtime";
import { BotWorkIpc, type BotWorkApi } from "../shared/bot-work-ipc";
import {
  ConversationBranchIpc,
  type ConversationBranchCreateOutcome,
  type ConversationBranchInfoDto,
  type ConversationBranchPreviewDto,
  type CreateConversationBranchRequest,
} from "../shared/conversation-branch";
import {
  NotificationIpc,
  type NotificationChangedEvent,
  type NotificationDto,
  type NotificationListRequest,
} from "../shared/notification";
import {
  WorkGraphIpc,
  type WorkGraphAddEdgeRequest,
  type WorkGraphAddEdgeResult,
  type WorkGraphEdgeDto,
  type WorkGraphListRequest,
  type WorkGraphRemoveEdgeResult,
} from "../shared/work-graph";
import {
  WorkspaceLibraryBindingIpc,
  type WorkspaceLibraryBindingListView,
  type WorkspaceLibraryBindingMutationResult,
  type WorkspaceLibraryBindingRequest,
} from "../shared/workspace-library-binding";
import type {
  WorkspaceSharedContextView,
  WorkspaceSharedContextViewRequest,
  WorkspaceSharedContextPromoteRequest,
  WorkspaceSharedContextPromoteResult,
} from "../shared/workspace-shared-context";
import { MemoryOrganizationIpc, type MemoryOrganizationRun } from "../shared/memory-organization";
import { MemoryIpc, type MemoryCandidateDto, type MemoryCoreProfileDto, type MemoryCreateRequest, type MemoryDismissedProjectionDto, type MemoryKernelStats, type MemoryListRequest, type MemoryProjectionProposalDto, type MemoryRecordDto, type MemoryRevisionDto, type MemoryScenarioDto, type MemoryScopeType, type MemorySearchHit, type MemorySearchRequest, type MemoryTurnDto, type MemoryTurnListRequest, type MemorySkillCandidateDto, type MemorySkillCandidateStatus, type MemorySkillEffectivenessDto, type MemorySkillEffectivenessSummaryDto, type MemorySkillFeedbackKind, type MemorySkillRevisionCandidateDto, type MemorySkillRevisionStatus, type MemoryUpdateRequest } from "../shared/memory-kernel";
import { MemoryGatewayIpc, type MemoryGatewayAccessGrantDto, type MemoryGatewayConfigureRequest, type MemoryGatewayCreateGrantRequest, type MemoryGatewayIssuedGrantDto, type MemoryGatewayStatusDto, type MemoryGatewayUpdateGrantRequest } from "../shared/memory-gateway";
import { RemoteAccessIpc, type RemoteConfigureRequest, type RemoteDeviceSummary, type RemotePairWindowDto, type RemotePairingSession, type RemoteStatus } from "../shared/remote-access";
import {
  AgentIpc,
  ArtifactIpc,
  ArtifactSurfaceIpc,
  BrowserIpc,
  RuntimeConsoleIpc,
  BtwIpc,
  CronIpc,
  DbIpc,
  GatewayIpc,
  EnhanceIpc,
  McpIpc,
  SubagentIpc,
  type AgentApproveToolRequest,
  type AgentPromptRequest,
  type AgentPromptResult,
  type AgentSubmissionReceipt,
  type AgentRegenerateRequest,
  type AgentRegenerateResult,
  type AgentDeleteUserMessageRequest,
  type AgentRestoreBackupRequest,
  type AgentSelectModePresetRequest,
  type RuntimeRequirementStateDto,
  type AgentSetPermissionModeRequest,
  type AgentSwitchExpertRequest,
  type AgentUiPatch,
  type SubagentSteerResultDto,
  type SubagentSummaryDto,
  type SubagentTranscriptDto,
  type UsageDashboardDto,
  type UsageDrilldownRowDto,
  type UsageHeatmapCellDto,
  type UsageMonthlyPointDto,
  type UsageSummaryDto,
  type UsageTrendPointDto,
  type AppSettingsDto,
  type ArtifactPreviewRequest,
  type AuthEventDto,
  type AuthLoginRequest,
  type AuthPromptRequestDto,
  type BtwPromptRequest,
  type BtwStartRequest,
  type BtwUiPatch,
  type EnhancePromptRequest,
  type EnhancePromptResult,
  type ContextUsageDto,
  type CredentialInfoDto,
  type SkillAuthoringCreateRequest,
  type SkillAuthoringCreateResult,
  type SkillAuthoringDraft,
  type SkillAuthoringGenerateRequest,
  type SkillEvalRunRequest,
  type SkillEvalRunResultDto,
  type SkillImprovementApplyRequest,
  type SkillImprovementDraftResult,
  type SkillDetailDto,
  type SkillImprovementGenerateRequest,
  type SkillPackageValidationDto,
  type ExpertDto,
  type ExpertAuthoringCreateRequest,
  type ExpertAuthoringCreateResult,
  type ExpertAuthoringDraft,
  type ExpertAuthoringGenerateRequest,
  type LocalConnectorDto,
  type PrivateSkillDto,
  type CronJobDto,
  type CronRunDto,
  type DbRenameResult,
  type DbUpsertResult,
  type FileBackupInfoDto,
  type GatewayChannelConfigDto,
  type GatewayWeixinQrLoginStateDto,
  type GatewayQQQrLoginStateDto,
  type GatewayEventDto,
  type GatewayListMessagesRequest,
  type GatewayMessageDto,
  type GatewayStatusDto,
  type LoginProviderDto,
  type MarketExpertDto,
  type MarketSkillDto,
  type ModeBlockId,
  type ModePolicyDto,
  type ModeProfileDto,
  type ModeProfileSummaryDto,
  type WelcomeMode,
  type AssembleModePreviewRequest,
  type AssemblyTraceDto,
  type RuntimeContextInspectionDto,
  type RuntimeContextSnapshotDto,
  type SubagentConfigDto,
  type SubagentConfigPatch,
  type WebSearchConfigDto,
  type SearchProviderKeyUsageDto,
  type McpDiscoveryDto,
  type McpInstallResultDto,
  type McpNotifyDto,
  type McpProjectConfigDto,
  type McpProxyResultDto,
  type McpServerDto,
  type McpStatusSnapshotDto,
  type McpUiPromptDto,
  type MemoryChangedDto,
  type ModelInfoDto,
  type ModelReloadResultDto,
  type ModelsFileConfigDto,
  type SkillDto,
  type SoulDto,
  type SpaceDto,
  type TaskDto,
  type TaskHistoryDto,
  type WorkspaceFileNodeDto,
  type WorkspaceFilePreviewDto,
  type WorkspaceMutationResult,
  type WorkspaceCopyIntoTaskResult,
  UsageIpc,
} from "../shared/agent-ipc";
import type { BrowserConsoleEventDto, BrowserConsoleSnapshotDto, BrowserConsoleTarget } from "../shared/browser-console";
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
import { ArtifactDomainIpc } from "../shared/artifact-ipc";
import {
  GadgetIpc,
  type GadgetConvertFromArtifactRequest,
  type GadgetExportArtifactRequest,
  type GadgetListRequest,
  type GadgetMoveScopeRequest,
  type GadgetSaveAsBlueprintRequest,
  type GadgetChangedEvent,
} from "../shared/gadget-ipc";
import type { GadgetCreateRequest, GadgetDescriptor, GadgetListItem, GadgetRuntimeState, GadgetUpdateRequest, GadgetSourceSnapshot, GadgetSourceUpdateRequest } from "../shared/gadget-types";
import { BlueprintIpc, type BlueprintCaptureRequest, type BlueprintChangedEvent } from "../shared/blueprint-ipc";
import type {
  BlueprintCreateRequest,
  BlueprintDefinition,
  BlueprintDescriptor,
  BlueprintInstantiateRequest,
  BlueprintInstantiationPlan,
  BlueprintInstantiationResult,
  BlueprintUpdateRequest,
  ResolvedBlueprint,
} from "../shared/blueprint-types";
import type { TemplateCapabilityRegistries } from "../shared/project-template";
import {
  LibraryIpc,
  type LibraryContentDto,
  type LibraryCreateItemRequest,
  type LibraryCreateSpaceRequest,
  type LibraryImportFileRequest,
  type LibraryItemDto,
  type LibraryListItemsRequest,
  type LibraryListRowDto,
  type LibraryRenameSpaceRequest,
  type LibrarySnapshotDto,
  type LibrarySpaceDto,
  type LibraryUpdateItemRequest,
  type LibraryWriteContentRequest,
} from "../shared/library-ipc";
import {
  ProfessionalToolIpc,
  type ProfessionalToolProviderId,
  type ProfessionalToolResultDto,
  type ProfessionalToolStatusDto,
} from "../shared/professional-tools";
import {
  CaptureModeEvent,
  CaptureModeIpc,
  type CaptureModeEnterRequest,
  type CaptureModeStateEvent,
} from "../shared/capture-mode";
import {
  SelectionEvent,
  SelectionIpc,
  type SelectionChangedEvent,
  type SelectionState,
} from "../shared/selection";
import {
  PromptContextIpc,
  type PromptContextCollectRequest,
  type PromptContextResult,
} from "../shared/prompt-context";
import type {
  ArtifactDomainGetRequest,
  ArtifactDomainGetResponse,
  ArtifactDomainListResponse,
  ArtifactDomainReadContentRequest,
  ArtifactDomainReadContentResponse,
  ArtifactDomainRegisterRequest,
  ArtifactDomainRemoveRequest,
  ArtifactDomainTaskRequest,
} from "../shared/artifact-ipc";
import type {
  ArtifactCreatedEvent,
  ArtifactDescriptor,
  ArtifactRemovedEvent,
  ArtifactSnapshot,
  ArtifactUpdatedEvent,
} from "../shared/artifact-types";

export interface LocalFilePayload {
  path: string;
  name: string;
  content: string;
  kind: WorkspaceFilePreviewDto["kind"];
  language?: string;
}

const api = {
  platform: process.platform,
  versions: {
    electron: process.versions.electron,
    node: process.versions.node,
  },
  /** 用量统计（账户面板；主进程 usage_events 事实表） */
  usage: {
    summary: (rangeDays: number): Promise<UsageSummaryDto> => ipcRenderer.invoke(UsageIpc.summary, rangeDays),
    drilldown: (rangeDays: number): Promise<UsageDrilldownRowDto[]> => ipcRenderer.invoke(UsageIpc.drilldown, rangeDays),
    trend: (rangeDays: number): Promise<UsageTrendPointDto[]> => ipcRenderer.invoke(UsageIpc.trend, rangeDays),
    heatmap: (year: number): Promise<UsageHeatmapCellDto[]> => ipcRenderer.invoke(UsageIpc.heatmap, year),
    monthly: (): Promise<UsageMonthlyPointDto[]> => ipcRenderer.invoke(UsageIpc.monthly),
    exportCsv: (rangeDays: number): Promise<string> => ipcRenderer.invoke(UsageIpc.exportCsv, rangeDays),
    dashboard: (rangeDays: number): Promise<UsageDashboardDto> => ipcRenderer.invoke(UsageIpc.dashboard, rangeDays),
  },
  setTheme: (theme: "light" | "dark"): void => {
    ipcRenderer.send("theme:set", theme);
  },
  onThemeRequest: (callback: () => void): void => {
    ipcRenderer.on("theme:request", () => callback());
  },
  pickLocalFile: (): Promise<LocalFilePayload | null> =>
    ipcRenderer.invoke("workspace:pickLocalFile"),
  pickLocalFolder: (): Promise<{ path: string; name: string } | null> =>
    ipcRenderer.invoke("workspace:pickLocalFolder"),
  pathExists: (folderPath: string): Promise<boolean> =>
    ipcRenderer.invoke("workspace:pathExists", folderPath),
  pickZipFile: (): Promise<{ path: string } | null> =>
    ipcRenderer.invoke("workspace:pickZipFile"),
  openFolder: (folderPath?: string): Promise<void> =>
    ipcRenderer.invoke("workspace:openFolder", folderPath),
  showItemInFolder: (filePath: string): Promise<void> =>
    ipcRenderer.invoke("workspace:showInFolder", filePath),
  listWorkspaceFiles: (root: string): Promise<WorkspaceFileNodeDto[]> =>
    ipcRenderer.invoke("workspace:listFiles", root),
  readWorkspaceFile: (root: string, relativePath: string): Promise<WorkspaceFilePreviewDto> =>
    ipcRenderer.invoke("workspace:readFile", root, relativePath),
  trashWorkspacePath: (root: string, relativePath: string): Promise<WorkspaceMutationResult> =>
    ipcRenderer.invoke("workspace:trashPath", root, relativePath),
  renameWorkspacePath: (
    root: string,
    relativePath: string,
    newName: string,
  ): Promise<WorkspaceMutationResult> =>
    ipcRenderer.invoke("workspace:renamePath", root, relativePath, newName),
  moveWorkspacePath: (
    root: string,
    fromRel: string,
    destDirRel: string,
  ): Promise<WorkspaceMutationResult> =>
    ipcRenderer.invoke("workspace:movePath", root, fromRel, destDirRel),
  createWorkspacePath: (
    root: string,
    parentRel: string,
    name: string,
    kind: "file" | "folder",
  ): Promise<WorkspaceMutationResult> =>
    ipcRenderer.invoke("workspace:createPath", root, parentRel, name, kind),
  copyIntoTaskWorkspace: (taskId: string, absPaths: string[]): Promise<WorkspaceCopyIntoTaskResult> =>
    ipcRenderer.invoke("workspace:copyIntoTask", taskId, absPaths),
  getPathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file) || "";
    } catch {
      return "";
    }
  },
  /** 剪贴板/无 path 的 File 落盘到 ~/.mybuddy/uploads，返回真实路径 */
  saveTempFile: (payload: {
    name?: string;
    base64: string;
    mimeType?: string;
  }): Promise<{ name: string; path: string } | null> =>
    ipcRenderer.invoke("workspace:saveTempFile", payload),
  /**
   * 原生拖出文件到系统（资源管理器/其它 App）。
   * 必须在元素 dragstart 里同步调用。
   */
  startNativeDrag: (filePaths: string | string[]): void => {
    const files = (Array.isArray(filePaths) ? filePaths : [filePaths])
      .map((p) => (typeof p === "string" ? p.trim() : ""))
      .filter(Boolean);
    if (!files.length) return;
    ipcRenderer.send("shell:startNativeDrag", files);
  },

  agent: {
    prompt: (req: AgentPromptRequest): Promise<AgentPromptResult> =>
      ipcRenderer.invoke(AgentIpc.prompt, req),
    submissionStatus: (receipt: AgentSubmissionReceipt): Promise<AgentPromptResult> => ipcRenderer.invoke(AgentIpc.submissionStatus, receipt),
    waitForSubmission: (receipt: AgentSubmissionReceipt): Promise<AgentPromptResult> => ipcRenderer.invoke(AgentIpc.waitForSubmission, receipt),
    regenerate: (req: AgentRegenerateRequest): Promise<AgentRegenerateResult> =>
      ipcRenderer.invoke(AgentIpc.regenerate, req),
    deleteUserMessage: (req: AgentDeleteUserMessageRequest): Promise<void> =>
      ipcRenderer.invoke(AgentIpc.deleteUserMessage, req),
    abort: (taskId: string): Promise<void> => ipcRenderer.invoke(AgentIpc.abort, taskId),
    stopConsultWorker: (req: import("../shared/agent-ipc").AgentStopConsultWorkerRequest): Promise<boolean> =>
      ipcRenderer.invoke(AgentIpc.stopConsultWorker, req),
    compact: (taskId: string): Promise<import("../shared/compaction").TaskCompactionResultDto> => ipcRenderer.invoke(AgentIpc.compact, taskId),
    abortCompaction: (taskId: string): Promise<boolean> => ipcRenderer.invoke(AgentIpc.abortCompaction, taskId),
    getCompactionStatus: (taskId: string): Promise<import("../shared/compaction").TaskCompactionStatusDto> => ipcRenderer.invoke(AgentIpc.getCompactionStatus, taskId),
    approveTool: (req: AgentApproveToolRequest): Promise<boolean> =>
      ipcRenderer.invoke(AgentIpc.approveTool, req),
    setPermissionMode: (req: AgentSetPermissionModeRequest): Promise<boolean> =>
      ipcRenderer.invoke(AgentIpc.setPermissionMode, req),
    listBackups: (taskId?: string): Promise<FileBackupInfoDto[]> =>
      ipcRenderer.invoke(AgentIpc.listBackups, taskId),
    restoreBackup: (req: AgentRestoreBackupRequest): Promise<FileBackupInfoDto> =>
      ipcRenderer.invoke(AgentIpc.restoreBackup, req),
    selectModePreset: (req: AgentSelectModePresetRequest): Promise<void> =>
      ipcRenderer.invoke(AgentIpc.selectModePreset, req),
    getRuntimeRequirementStates: (): Promise<RuntimeRequirementStateDto[]> =>
      ipcRenderer.invoke(AgentIpc.getRuntimeRequirementStates),
    startRuntimeRequirement: (providerId: string): Promise<void> =>
      ipcRenderer.invoke(AgentIpc.startRuntimeRequirement, providerId),
    stopRuntimeRequirement: (providerId: string): Promise<void> =>
      ipcRenderer.invoke(AgentIpc.stopRuntimeRequirement, providerId),
    restartRuntimeRequirement: (providerId: string): Promise<void> =>
      ipcRenderer.invoke(AgentIpc.restartRuntimeRequirement, providerId),
    /** 订阅 runtime requirement 状态 push（返回取消订阅函数）。 */
    onRuntimeRequirementState: (cb: (state: RuntimeRequirementStateDto) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: RuntimeRequirementStateDto): void => {
        cb(state);
      };
      ipcRenderer.on(AgentIpc.runtimeRequirementStateChanged, handler);
      return () => {
        ipcRenderer.removeListener(AgentIpc.runtimeRequirementStateChanged, handler);
      };
    },
    listModels: (): Promise<ModelInfoDto[]> => ipcRenderer.invoke(AgentIpc.listModels),
    listSkills: (cwd?: string): Promise<SkillDto[]> =>
      ipcRenderer.invoke(AgentIpc.listSkills, cwd),
    listMarketSkills: (cwd?: string): Promise<MarketSkillDto[]> =>
      ipcRenderer.invoke(AgentIpc.listMarketSkills, cwd),
    installSkill: (id: string): Promise<SkillDto> =>
      ipcRenderer.invoke(AgentIpc.installSkill, id),
    installSkillByPath: (path: string): Promise<SkillDto> =>
      ipcRenderer.invoke(AgentIpc.installSkillByPath, path),
    authorSkill: (input: SkillAuthoringCreateRequest): Promise<SkillAuthoringCreateResult> =>
      ipcRenderer.invoke(AgentIpc.authorSkill, input),
    generateSkillAuthoringDraft: (input: SkillAuthoringGenerateRequest): Promise<SkillAuthoringDraft> =>
      ipcRenderer.invoke(AgentIpc.generateSkillAuthoringDraft, input),
    generateExpertAuthoringDraft: (input: ExpertAuthoringGenerateRequest): Promise<ExpertAuthoringDraft> =>
      ipcRenderer.invoke(AgentIpc.generateExpertAuthoringDraft, input),
    runSkillEvals: (input: SkillEvalRunRequest): Promise<SkillEvalRunResultDto> =>
      ipcRenderer.invoke(AgentIpc.runSkillEvals, input),
    getSkillDetail: (skillId: string): Promise<SkillDetailDto> =>
      ipcRenderer.invoke(AgentIpc.getSkillDetail, skillId),
    generateSkillImprovementDraft: (input: SkillImprovementGenerateRequest): Promise<SkillImprovementDraftResult> =>
      ipcRenderer.invoke(AgentIpc.generateSkillImprovementDraft, input),
    applySkillImprovement: (input: SkillImprovementApplyRequest): Promise<SkillAuthoringCreateResult> =>
      ipcRenderer.invoke(AgentIpc.applySkillImprovement, input),
    validateSkillPackage: (path: string): Promise<SkillPackageValidationDto> =>
      ipcRenderer.invoke(AgentIpc.validateSkillPackage, path),
    uninstallSkill: (id: string): Promise<void> =>
      ipcRenderer.invoke(AgentIpc.uninstallSkill, id),
    deleteMarketSkill: (id: string): Promise<void> =>
      ipcRenderer.invoke(AgentIpc.deleteMarketSkill, id),
    setSkillEnabled: (id: string, enabled: boolean): Promise<SkillDto> =>
      ipcRenderer.invoke(AgentIpc.setSkillEnabled, id, enabled),
    listExperts: (): Promise<ExpertDto[]> => ipcRenderer.invoke(AgentIpc.listExperts),
    listMarketExperts: (): Promise<MarketExpertDto[]> =>
      ipcRenderer.invoke(AgentIpc.listMarketExperts),
    listExpertPrivateSkills: (expertId: string): Promise<PrivateSkillDto[]> =>
      ipcRenderer.invoke(AgentIpc.listExpertPrivateSkills, expertId),
    installExpert: (id: string): Promise<ExpertDto> =>
      ipcRenderer.invoke(AgentIpc.installExpert, id),
    installExpertByPath: (path: string): Promise<ExpertDto> =>
      ipcRenderer.invoke(AgentIpc.installExpertByPath, path),
    authorExpert: (input: ExpertAuthoringCreateRequest): Promise<ExpertAuthoringCreateResult> =>
      ipcRenderer.invoke(AgentIpc.authorExpert, input),
    getExpertDetail: (id: string): Promise<import("../shared/expert-binding").ExpertDetailDto> =>
      ipcRenderer.invoke(AgentIpc.getExpertDetail, id),
    updateExpert: (input: import("../shared/expert-binding").ExpertUpdateRequest): Promise<import("../shared/expert-binding").ExpertDetailDto> =>
      ipcRenderer.invoke(AgentIpc.updateExpert, input),
    getTaskExpertBinding: (taskId: string): Promise<import("../shared/expert-binding").TaskExpertBindingDto> =>
      ipcRenderer.invoke(AgentIpc.getTaskExpertBinding, taskId),
    saveTaskExpertBinding: (input: import("../shared/expert-binding").SaveTaskExpertBindingRequest): Promise<import("../shared/expert-binding").TaskExpertBindingDto> =>
      ipcRenderer.invoke(AgentIpc.saveTaskExpertBinding, input),
    cancelExpertAuthoring: (requestId: string): Promise<void> =>
      ipcRenderer.invoke(AgentIpc.cancelExpertAuthoring, requestId),
    importExpertZip: (zipPath: string): Promise<ExpertDto> =>
      ipcRenderer.invoke(AgentIpc.importExpertZip, zipPath),
    exportExpert: (id: string): Promise<string> =>
      ipcRenderer.invoke(AgentIpc.exportExpert, id),
    uninstallExpert: (id: string): Promise<void> =>
      ipcRenderer.invoke(AgentIpc.uninstallExpert, id),
    deleteMarketExpert: (id: string): Promise<void> =>
      ipcRenderer.invoke(AgentIpc.deleteMarketExpert, id),
    setExpertEnabled: (id: string, enabled: boolean): Promise<ExpertDto> =>
      ipcRenderer.invoke(AgentIpc.setExpertEnabled, id, enabled),
    switchExpert: (req: AgentSwitchExpertRequest): Promise<void> =>
      ipcRenderer.invoke(AgentIpc.switchExpert, req),
    listConnectors: (): Promise<LocalConnectorDto[]> =>
      ipcRenderer.invoke(AgentIpc.listConnectors),
    installConnector: (id: string): Promise<string[]> =>
      ipcRenderer.invoke(AgentIpc.installConnector, id),
    importConnectorByPath: (path: string): Promise<LocalConnectorDto> =>
      ipcRenderer.invoke(AgentIpc.importConnectorByPath, path),
    importConnectorZip: (zipPath: string): Promise<LocalConnectorDto> =>
      ipcRenderer.invoke(AgentIpc.importConnectorZip, zipPath),
    setConnectorEnabled: (id: string, enabled: boolean): Promise<void> =>
      ipcRenderer.invoke(AgentIpc.setConnectorEnabled, id, enabled),
    setTaskConnectorIds: (taskId: string, ids: string[]): Promise<void> =>
      ipcRenderer.invoke(AgentIpc.setTaskConnectorIds, taskId, ids),
    clearTaskConnectorIds: (taskId: string): Promise<void> =>
      ipcRenderer.invoke(AgentIpc.clearTaskConnectorIds, taskId),
    uninstallConnector: (id: string): Promise<void> =>
      ipcRenderer.invoke(AgentIpc.uninstallConnector, id),
    deleteMarketConnector: (id: string): Promise<void> =>
      ipcRenderer.invoke(AgentIpc.deleteMarketConnector, id),
    reloadModels: (providerId?: string): Promise<ModelReloadResultDto> =>
      ipcRenderer.invoke(AgentIpc.reloadModels, providerId),
    getModelsPath: (): Promise<string> => ipcRenderer.invoke(AgentIpc.getModelsPath),
    getModelsConfig: (): Promise<ModelsFileConfigDto> =>
      ipcRenderer.invoke(AgentIpc.getModelsConfig),
    saveModelsConfig: (config: ModelsFileConfigDto): Promise<ModelInfoDto[]> =>
      ipcRenderer.invoke(AgentIpc.saveModelsConfig, config),
    getAppSettings: (): Promise<AppSettingsDto> => ipcRenderer.invoke(AgentIpc.getAppSettings),
    getDiskSpace: (): Promise<import("../shared/agent-ipc").DiskSpaceDto> =>
      ipcRenderer.invoke(AgentIpc.getDiskSpace),
    updateAppSettings: (partial: Partial<AppSettingsDto>): Promise<AppSettingsDto> =>
      ipcRenderer.invoke(AgentIpc.updateAppSettings, partial),
    listUserFonts: (): Promise<import("../shared/agent-ipc").UserFontDto[]> =>
      ipcRenderer.invoke(AgentIpc.listUserFonts),
    listSystemFonts: (): Promise<string[]> => ipcRenderer.invoke(AgentIpc.listSystemFonts),
    importUserFont: (
      sourcePath?: string,
    ): Promise<import("../shared/agent-ipc").UserFontDto | null> =>
      ipcRenderer.invoke(AgentIpc.importUserFont, sourcePath),
    removeUserFont: (id: string): Promise<import("../shared/agent-ipc").UserFontDto[]> =>
      ipcRenderer.invoke(AgentIpc.removeUserFont, id),
    readUserFont: (id: string): Promise<ArrayBuffer | Uint8Array> =>
      ipcRenderer.invoke(AgentIpc.readUserFont, id),
    openFontsDir: (): Promise<string> => ipcRenderer.invoke(AgentIpc.openFontsDir),
    getWebSearchConfig: (): Promise<WebSearchConfigDto> =>
      ipcRenderer.invoke(AgentIpc.getWebSearchConfig),
    saveWebSearchConfig: (config: WebSearchConfigDto): Promise<WebSearchConfigDto> =>
      ipcRenderer.invoke(AgentIpc.saveWebSearchConfig, config),
    getSearchProviderUsage: (provider: string, keys: string[]): Promise<SearchProviderKeyUsageDto[]> =>
      ipcRenderer.invoke(AgentIpc.getSearchProviderUsage, provider, keys),
    getBuiltinCapabilities: (): Promise<BuiltinCapabilitiesSnapshotDto> =>
      ipcRenderer.invoke(AgentIpc.getBuiltinCapabilities),
    refreshBuiltinMediaServices: (): Promise<BuiltinCapabilitiesSnapshotDto> =>
      ipcRenderer.invoke(AgentIpc.refreshBuiltinMediaServices),
    listBuiltinVideoJobs: (taskId?: string): Promise<CapabilityVideoJobDto[]> =>
      ipcRenderer.invoke(AgentIpc.listBuiltinVideoJobs, taskId),
    saveBuiltinCapabilitySettings: (request: SaveBuiltinCapabilitySettingsRequest): Promise<BuiltinCapabilitiesSnapshotDto> =>
      ipcRenderer.invoke(AgentIpc.saveBuiltinCapabilitySettings, request),
    saveBuiltinCapabilities: (config: BuiltinCapabilitiesConfigDto): Promise<BuiltinCapabilitiesSnapshotDto> =>
      ipcRenderer.invoke(AgentIpc.saveBuiltinCapabilities, config),
    saveBuiltinCredential: (request: SaveBuiltinCredentialRequest): Promise<BuiltinCapabilitiesSnapshotDto> =>
      ipcRenderer.invoke(AgentIpc.saveBuiltinCredential, request),
    testBuiltinCapability: (id: BuiltinCapabilityId): Promise<TestBuiltinCapabilityResultDto> =>
      ipcRenderer.invoke(AgentIpc.testBuiltinCapability, id),
    getSubagentConfig: (): Promise<SubagentConfigDto> =>
      ipcRenderer.invoke(AgentIpc.getSubagentConfig),
    saveSubagentConfig: (config: SubagentConfigPatch): Promise<SubagentConfigDto> =>
      ipcRenderer.invoke(AgentIpc.saveSubagentConfig, config),
    getContextUsage: (taskId: string): Promise<ContextUsageDto | null> =>
      ipcRenderer.invoke(AgentIpc.getContextUsage, taskId),
    loadTaskHistory: (taskId: string, beforeEntryId?: number): Promise<TaskHistoryDto> =>
      ipcRenderer.invoke(AgentIpc.loadTaskHistory, taskId, beforeEntryId),
    listLoginProviders: (): Promise<LoginProviderDto[]> =>
      ipcRenderer.invoke(AgentIpc.listLoginProviders),
    setProviderEnabled: (providerId: string, enabled: boolean): Promise<ModelInfoDto[]> =>
      ipcRenderer.invoke(AgentIpc.setProviderEnabled, providerId, enabled),
    listCredentials: (): Promise<CredentialInfoDto[]> =>
      ipcRenderer.invoke(AgentIpc.listCredentials),
    login: (req: AuthLoginRequest): Promise<import("../shared/agent-ipc").AuthLoginResult> =>
      ipcRenderer.invoke(AgentIpc.login, req),
    logout: (providerId: string): Promise<import("../shared/agent-ipc").AuthLogoutResult> =>
      ipcRenderer.invoke(AgentIpc.logout, providerId),
    authRespond: (requestId: string, value: string): Promise<boolean> =>
      ipcRenderer.invoke(AgentIpc.authRespond, requestId, value),
    authCancel: (requestId?: string): Promise<void> =>
      ipcRenderer.invoke(AgentIpc.authCancel, requestId),
    getAuthPath: (): Promise<string> => ipcRenderer.invoke(AgentIpc.getAuthPath),
    listModeProfiles: (): Promise<ModeProfileSummaryDto[]> =>
      ipcRenderer.invoke(AgentIpc.listModeProfiles),
    getModeProfile: (id: WelcomeMode): Promise<ModeProfileDto> =>
      ipcRenderer.invoke(AgentIpc.getModeProfile, id),
    saveModeBlock: (
      id: WelcomeMode,
      blockId: ModeBlockId,
      content: string,
    ): Promise<ModeProfileDto> => ipcRenderer.invoke(AgentIpc.saveModeBlock, id, blockId, content),
    saveModePolicy: (id: WelcomeMode, policy: ModePolicyDto): Promise<ModeProfileDto> =>
      ipcRenderer.invoke(AgentIpc.saveModePolicy, id, policy),
    resetModeBlock: (id: WelcomeMode, blockId: ModeBlockId): Promise<ModeProfileDto> =>
      ipcRenderer.invoke(AgentIpc.resetModeBlock, id, blockId),
    resetModePolicy: (id: WelcomeMode): Promise<ModeProfileDto> =>
      ipcRenderer.invoke(AgentIpc.resetModePolicy, id),
    resetModeProfile: (id: WelcomeMode): Promise<ModeProfileDto> =>
      ipcRenderer.invoke(AgentIpc.resetModeProfile, id),
    openModesDir: (id?: WelcomeMode): Promise<string> =>
      ipcRenderer.invoke(AgentIpc.openModesDir, id),
    openModeFile: (id: WelcomeMode, target: ModeBlockId | "policy"): Promise<string> =>
      ipcRenderer.invoke(AgentIpc.openModeFile, id, target),
    assembleModePreview: (req: AssembleModePreviewRequest): Promise<AssemblyTraceDto> =>
      ipcRenderer.invoke(AgentIpc.assembleModePreview, req),
    inspectRuntimeContext: (taskId: string): Promise<RuntimeContextInspectionDto> =>
      ipcRenderer.invoke(AgentIpc.inspectRuntimeContext, taskId),
    getTaskDiagnostics: (taskId: string, limit?: number, offset?: number): Promise<import("../shared/task-diagnostics").TaskDiagnosticsDto> =>
      ipcRenderer.invoke(AgentIpc.getTaskDiagnostics, taskId, limit, offset),
    listAgentLoadoutObservations: (taskId: string, limit?: number): Promise<AgentLoadoutObservationDto[]> =>
      ipcRenderer.invoke(AgentIpc.listAgentLoadoutObservations, taskId, limit),
    listRuntimeContextSnapshots: (taskId: string, limit?: number): Promise<RuntimeContextSnapshotDto[]> =>
      ipcRenderer.invoke(AgentIpc.listRuntimeContextSnapshots, taskId, limit),
    clearRuntimeContextSnapshots: (taskId?: string): Promise<number> =>
      ipcRenderer.invoke(AgentIpc.clearRuntimeContextSnapshots, taskId),
    clearRuntimeAudit: (taskId?: string): Promise<RuntimeAuditClearResultDto> =>
      ipcRenderer.invoke(AgentIpc.clearRuntimeAudit, taskId),
    onAuthPrompt: (callback: (req: AuthPromptRequestDto) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, req: AuthPromptRequestDto): void =>
        callback(req);
      ipcRenderer.on(AgentIpc.authPrompt, handler);
      return () => ipcRenderer.removeListener(AgentIpc.authPrompt, handler);
    },
    onAuthEvent: (callback: (ev: AuthEventDto) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, ev: AuthEventDto): void => callback(ev);
      ipcRenderer.on(AgentIpc.authEvent, handler);
      return () => ipcRenderer.removeListener(AgentIpc.authEvent, handler);
    },
    onEvent: (callback: (patch: AgentUiPatch) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, patch: AgentUiPatch): void => callback(patch);
      ipcRenderer.on(AgentIpc.event, handler);
      return () => ipcRenderer.removeListener(AgentIpc.event, handler);
    },
  },

  conversationRuntime: {
    snapshot: (taskId) => ipcRenderer.invoke(ConversationRuntimeIpc.snapshot, taskId),
    respondInteraction: (request) => ipcRenderer.invoke(ConversationRuntimeIpc.respondInteraction, request),
    cancelInteraction: (request) => ipcRenderer.invoke(ConversationRuntimeIpc.cancelInteraction, request),
    createGoal: (request) => ipcRenderer.invoke(ConversationRuntimeIpc.createGoal, request),
    updateGoal: (request) => ipcRenderer.invoke(ConversationRuntimeIpc.updateGoal, request),
    cancelGoal: (goalId) => ipcRenderer.invoke(ConversationRuntimeIpc.cancelGoal, goalId),
  } satisfies ConversationRuntimeApi,

  botWork: {
    phase3Control: request => ipcRenderer.invoke(BotWorkIpc.phase3Control, request),
    phase4Control: request => ipcRenderer.invoke(BotWorkIpc.phase4Control, request),
    hostStatus: () => ipcRenderer.invoke(BotWorkIpc.hostStatus),
    listBots: () => ipcRenderer.invoke(BotWorkIpc.listBots),
    listBotExpertVersions: (botId: string) => ipcRenderer.invoke(BotWorkIpc.listBotExpertVersions, botId),
    adoptBotExpertVersion: (botId: string, expected) => ipcRenderer.invoke(BotWorkIpc.adoptBotExpertVersion, botId, expected),
    listWorks: (includeClosed?: boolean) => ipcRenderer.invoke(BotWorkIpc.listWorks, includeClosed),
    syncWorks: request => ipcRenderer.invoke(BotWorkIpc.syncWorks, request),
    sendMessage: request => ipcRenderer.invoke(BotWorkIpc.sendMessage, request),
    history: request => ipcRenderer.invoke(BotWorkIpc.history, request),
    cancelSend: (botId, requestId) => ipcRenderer.invoke(BotWorkIpc.cancelSend, botId, requestId),
    archiveConversation: (botId, conversationId) => ipcRenderer.invoke(BotWorkIpc.archiveConversation, botId, conversationId),
    getWork: (workId: string) => ipcRenderer.invoke(BotWorkIpc.getWork, workId),
    attestCriteria: (request) => ipcRenderer.invoke(BotWorkIpc.attestCriteria, request),
    recordUserFeedback: (request) => ipcRenderer.invoke(BotWorkIpc.recordUserFeedback, request),
    markNotificationRead: (notificationId: string) => ipcRenderer.invoke(BotWorkIpc.markNotificationRead, notificationId),
    markCardRead: (request) => ipcRenderer.invoke(BotWorkIpc.markCardRead, request),
    workSummary: (workId: string) => ipcRenderer.invoke(BotWorkIpc.workSummary, workId),
    workDiagnostics: (request) => ipcRenderer.invoke(BotWorkIpc.workDiagnostics, request),
    resendNotification: (request) => ipcRenderer.invoke(BotWorkIpc.resendNotification, request),
    reviewControl: (request) => ipcRenderer.invoke(BotWorkIpc.reviewControl, request),
  } satisfies BotWorkApi,

  notification: {
    list: (request?: NotificationListRequest): Promise<NotificationDto[]> =>
      ipcRenderer.invoke(NotificationIpc.list, request),
    unreadCount: (): Promise<number> => ipcRenderer.invoke(NotificationIpc.unreadCount),
    markRead: (id: string): Promise<void> => ipcRenderer.invoke(NotificationIpc.markRead, id),
    markAllRead: (): Promise<void> => ipcRenderer.invoke(NotificationIpc.markAllRead),
    dismiss: (id: string): Promise<void> => ipcRenderer.invoke(NotificationIpc.dismiss, id),
    dismissAll: (): Promise<void> => ipcRenderer.invoke(NotificationIpc.dismissAll),
    onChanged: (callback: (event: NotificationChangedEvent) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, event: NotificationChangedEvent): void => callback(event);
      ipcRenderer.on(NotificationIpc.changed, handler);
      return () => ipcRenderer.removeListener(NotificationIpc.changed, handler);
    },
  },

  /** 对话分支（Branch in new task）：只暴露窄 API，SessionManager/路径不可达（§6.1） */
  conversationBranch: {
    preview: (request: CreateConversationBranchRequest): Promise<ConversationBranchPreviewDto> =>
      ipcRenderer.invoke(ConversationBranchIpc.preview, request),
    create: (request: CreateConversationBranchRequest): Promise<ConversationBranchCreateOutcome> =>
      ipcRenderer.invoke(ConversationBranchIpc.create, request),
    getInfo: (taskId: string): Promise<ConversationBranchInfoDto | undefined> =>
      ipcRenderer.invoke(ConversationBranchIpc.getInfo, taskId),
    listChildren: (taskId: string): Promise<ConversationBranchInfoDto[]> =>
      ipcRenderer.invoke(ConversationBranchIpc.listChildren, taskId),
  },

  /** Subagent 临时 Chat（task-scoped：仅当前父 Task 运行中实例） */
  subagent: {
    active: (taskId: string): Promise<SubagentSummaryDto[]> => ipcRenderer.invoke(SubagentIpc.active, taskId),
    transcript: (subagentId: string): Promise<SubagentTranscriptDto> =>
      ipcRenderer.invoke(SubagentIpc.transcript, subagentId),
    steer: (subagentId: string, instruction: string): Promise<SubagentSteerResultDto> =>
      ipcRenderer.invoke(SubagentIpc.steer, subagentId, instruction),
    cancel: (subagentId: string): Promise<{ ok: boolean; message: string }> =>
      ipcRenderer.invoke(SubagentIpc.cancel, subagentId),
    onEvent: (callback: (ev: { ts: number }) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, ev: { ts: number }): void => callback(ev);
      ipcRenderer.on(SubagentIpc.event, handler);
      return () => ipcRenderer.removeListener(SubagentIpc.event, handler);
    },
  },

  /** 外部 Agent：ACP Runtime（与 Pi/Subagent 独立事件通道） */
  externalAgent: {
    listAgents: (refresh?: boolean): Promise<ExternalAgentDescriptorDto[]> =>
      ipcRenderer.invoke(ExternalAgentIpc.listAgents, refresh === true),
    setEnabled: (agentId: ExternalAgentId, enabled: boolean): Promise<ExternalAgentDescriptorDto[]> =>
      ipcRenderer.invoke(ExternalAgentIpc.setEnabled, agentId, enabled),
    setConfigOption: (req: ExternalAgentSetConfigOptionRequest): Promise<ExternalAgentDescriptorDto[]> =>
      ipcRenderer.invoke(ExternalAgentIpc.setConfigOption, req),
    test: (agentId: ExternalAgentId): Promise<ExternalAgentTestResultDto> =>
      ipcRenderer.invoke(ExternalAgentIpc.test, agentId),
    prompt: (req: ExternalAgentPromptRequest): Promise<ExternalAgentPromptResult> =>
      ipcRenderer.invoke(ExternalAgentIpc.prompt, req),
    cancel: (runId?: string, taskId?: string): Promise<{ ok: boolean; message: string }> =>
      ipcRenderer.invoke(ExternalAgentIpc.cancel, runId, taskId),
    resolvePermission: (req: ExternalAgentResolvePermissionRequest): Promise<{ ok: boolean; message: string }> =>
      ipcRenderer.invoke(ExternalAgentIpc.resolvePermission, req),
    history: (taskId: string): Promise<ExternalAgentHistoryDto> =>
      ipcRenderer.invoke(ExternalAgentIpc.history, taskId),
    active: (taskId?: string): Promise<ExternalAgentRunDto[]> =>
      ipcRenderer.invoke(ExternalAgentIpc.active, taskId),
    onEvent: (callback: (event: ExternalAgentUiEvent) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, event: ExternalAgentUiEvent): void => callback(event);
      ipcRenderer.on(ExternalAgentIpc.event, handler);
      return () => ipcRenderer.removeListener(ExternalAgentIpc.event, handler);
    },
  },
  /** BTW（临时上下文分支）：瞬时会话桥。事件走独立 btw:event 通道，绝不与 agent:event 混流 */
  btw: {
    start: (req: BtwStartRequest): Promise<void> => ipcRenderer.invoke(BtwIpc.start, req),
    prompt: (req: BtwPromptRequest): Promise<void> => ipcRenderer.invoke(BtwIpc.prompt, req),
    abort: (btwId: string): Promise<void> => ipcRenderer.invoke(BtwIpc.abort, btwId),
    close: (btwId: string): Promise<void> => ipcRenderer.invoke(BtwIpc.close, btwId),
    keepalive: (btwIds: string[]): Promise<void> =>
      ipcRenderer.invoke(BtwIpc.keepalive, { btwIds }),
    onEvent: (callback: (patch: BtwUiPatch) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, patch: BtwUiPatch): void => callback(patch);
      ipcRenderer.on(BtwIpc.event, handler);
      return () => ipcRenderer.removeListener(BtwIpc.event, handler);
    },
  },

  /** Prompt Enhance（Instruction Enhancement）：消息发送前的单轮指令增强，与 BTW/任务管道完全独立 */
  enhance: {
    prompt: (req: EnhancePromptRequest): Promise<EnhancePromptResult> =>
      ipcRenderer.invoke(EnhanceIpc.prompt, req),
  },

  memoryGateway: {
    status: (): Promise<MemoryGatewayStatusDto> => ipcRenderer.invoke(MemoryGatewayIpc.status),
    configure: (request: MemoryGatewayConfigureRequest): Promise<MemoryGatewayStatusDto> => ipcRenderer.invoke(MemoryGatewayIpc.configure, request),
    listGrants: (): Promise<MemoryGatewayAccessGrantDto[]> => ipcRenderer.invoke(MemoryGatewayIpc.listGrants),
    createGrant: (request: MemoryGatewayCreateGrantRequest): Promise<MemoryGatewayIssuedGrantDto> => ipcRenderer.invoke(MemoryGatewayIpc.createGrant, request),
    updateGrant: (request: MemoryGatewayUpdateGrantRequest): Promise<MemoryGatewayAccessGrantDto> => ipcRenderer.invoke(MemoryGatewayIpc.updateGrant, request),
    rotateGrant: (id: string): Promise<MemoryGatewayIssuedGrantDto> => ipcRenderer.invoke(MemoryGatewayIpc.rotateGrant, id),
    deleteGrant: (id: string): Promise<void> => ipcRenderer.invoke(MemoryGatewayIpc.deleteGrant, id),
  },

  remoteAccess: {
    status: (): Promise<RemoteStatus> => ipcRenderer.invoke(RemoteAccessIpc.status),
    configure: (request: RemoteConfigureRequest): Promise<RemoteStatus> => ipcRenderer.invoke(RemoteAccessIpc.configure, request),
    listDevices: (): Promise<RemoteDeviceSummary[]> => ipcRenderer.invoke(RemoteAccessIpc.listDevices),
    revokeDevice: (id: string): Promise<boolean> => ipcRenderer.invoke(RemoteAccessIpc.revokeDevice, id),
    createPairingSession: (): Promise<RemotePairingSession> => ipcRenderer.invoke(RemoteAccessIpc.createPairingSession),
    cancelPairingSession: (id: string): Promise<void> => ipcRenderer.invoke(RemoteAccessIpc.cancelPairingSession, id),
    openPairWindow: (): Promise<RemotePairWindowDto> => ipcRenderer.invoke(RemoteAccessIpc.openPairWindow),
    closePairWindow: (): Promise<void> => ipcRenderer.invoke(RemoteAccessIpc.closePairWindow),
    pairWindowState: (): Promise<RemotePairWindowDto | null> => ipcRenderer.invoke(RemoteAccessIpc.pairWindowState),
  },

  memory: {
    organization: (): Promise<MemoryOrganizationRun | null> => ipcRenderer.invoke(MemoryOrganizationIpc.latest),
    startOrganization: (resumeId?: string): Promise<MemoryOrganizationRun> => ipcRenderer.invoke(MemoryOrganizationIpc.start, resumeId),
    pauseOrganization: (id: string): Promise<MemoryOrganizationRun> => ipcRenderer.invoke(MemoryOrganizationIpc.pause, id),
    applyOrganization: (id: string): Promise<MemoryOrganizationRun> => ipcRenderer.invoke(MemoryOrganizationIpc.apply, id),
    undoOrganization: (id: string): Promise<MemoryOrganizationRun> => ipcRenderer.invoke(MemoryOrganizationIpc.undo, id),
    dismissOrganization: (id: string): Promise<MemoryOrganizationRun> => ipcRenderer.invoke(MemoryOrganizationIpc.dismiss, id),
    list: (request?: MemoryListRequest | number): Promise<MemoryRecordDto[]> => ipcRenderer.invoke(MemoryIpc.list, request),
    turns: (request?: MemoryTurnListRequest): Promise<MemoryTurnDto[]> => ipcRenderer.invoke(MemoryIpc.turns, request),
    getTurn: (id: string): Promise<MemoryTurnDto | undefined> => ipcRenderer.invoke(MemoryIpc.getTurn, id),
    turnTasks: (): Promise<import("../shared/memory-kernel").MemoryTurnTaskDto[]> => ipcRenderer.invoke(MemoryIpc.turnTasks),
    deleteAllTurns: (): Promise<number> => ipcRenderer.invoke(MemoryIpc.deleteAllTurns),
    deleteTurns: (ids: string[]): Promise<number> => ipcRenderer.invoke(MemoryIpc.deleteTurns, ids),
    memoriesForTurn: (turnId: string): Promise<MemoryRecordDto[]> => ipcRenderer.invoke(MemoryIpc.memoriesForTurn, turnId),
    search: (request: MemorySearchRequest): Promise<MemorySearchHit[]> => ipcRenderer.invoke(MemoryIpc.search, request),
    get: (id: string): Promise<MemoryRecordDto | undefined> => ipcRenderer.invoke(MemoryIpc.get, id),
    create: (request: MemoryCreateRequest): Promise<MemoryRecordDto> => ipcRenderer.invoke(MemoryIpc.create, request),
    update: (request: MemoryUpdateRequest): Promise<MemoryRecordDto> => ipcRenderer.invoke(MemoryIpc.update, request),
    forget: (ids: string | string[]): Promise<void> => ipcRenderer.invoke(MemoryIpc.forget, ids),
    promote: (id: string, scopeType: MemoryScopeType, scopeId?: string): Promise<MemoryRecordDto> => ipcRenderer.invoke(MemoryIpc.promote, id, scopeType, scopeId),
    detachScope: (id: string, scopeType: MemoryScopeType, scopeId?: string): Promise<{ detached: boolean; forgotten: boolean }> => ipcRenderer.invoke(MemoryIpc.detachScope, id, scopeType, scopeId),
    retryFailedTurns: (): Promise<number> => ipcRenderer.invoke(MemoryIpc.retryFailedTurns),
    extractPendingTurns: (): Promise<import("../shared/memory-kernel").MemoryExtractionRunResult> => ipcRenderer.invoke(MemoryIpc.extractPendingTurns),
    dismissProjection: (id: string, kind: "scenario" | "profile"): Promise<boolean> => ipcRenderer.invoke(MemoryIpc.dismissProjection, id, kind),
    deleteProjectionRecords: (request: import("../shared/memory-kernel").MemoryProjectionDeleteRequest): Promise<import("../shared/memory-kernel").MemoryProjectionDeleteResult> => ipcRenderer.invoke(MemoryIpc.deleteProjectionRecords, request),
    restoreProjection: (id: string): Promise<boolean> => ipcRenderer.invoke(MemoryIpc.restoreProjection, id),
    dismissedProjections: (): Promise<MemoryDismissedProjectionDto[]> => ipcRenderer.invoke(MemoryIpc.dismissedProjections),
    generateL2Proposals: (): Promise<{ completed: boolean; scopesProcessed: number; outputs: number }> => ipcRenderer.invoke(MemoryIpc.generateL2Proposals),
    generateL3Proposals: (): Promise<{ completed: boolean; scopesProcessed: number; outputs: number }> => ipcRenderer.invoke(MemoryIpc.generateL3Proposals),
    projectionProposals: (): Promise<MemoryProjectionProposalDto[]> => ipcRenderer.invoke(MemoryIpc.projectionProposals),
    approveProjectionProposal: (id: string): Promise<boolean> => ipcRenderer.invoke(MemoryIpc.approveProjectionProposal, id),
    rejectProjectionProposal: (id: string): Promise<boolean> => ipcRenderer.invoke(MemoryIpc.rejectProjectionProposal, id),
    restoreProjectionProposal: (id: string): Promise<boolean> => ipcRenderer.invoke(MemoryIpc.restoreProjectionProposal, id),
    history: (id: string): Promise<MemoryRevisionDto[]> => ipcRenderer.invoke(MemoryIpc.history, id),
    candidates: (status?: MemoryCandidateDto["status"], limit?: number): Promise<MemoryCandidateDto[]> => ipcRenderer.invoke(MemoryIpc.candidates, status, limit),
    resolveCandidate: (id: string, decision: "approve" | "reject"): Promise<{ status: "committed" | "rejected" | "needs_review"; memoryId?: string }> => ipcRenderer.invoke(MemoryIpc.resolveCandidate, id, decision),
    stats: (): Promise<MemoryKernelStats> => ipcRenderer.invoke(MemoryIpc.stats),
    scenarios: (limit?: number): Promise<MemoryScenarioDto[]> => ipcRenderer.invoke(MemoryIpc.scenarios, limit),
    coreProfiles: (limit?: number): Promise<MemoryCoreProfileDto[]> => ipcRenderer.invoke(MemoryIpc.coreProfiles, limit),
    skillCandidates: (status?: MemorySkillCandidateStatus, limit?: number): Promise<MemorySkillCandidateDto[]> => ipcRenderer.invoke(MemoryIpc.skillCandidates, status, limit),
    skillLearningStatus: (): Promise<import("../shared/memory-kernel").MemorySkillLearningStatusDto> => ipcRenderer.invoke(MemoryIpc.skillLearningStatus),
    deleteSkillHistory: (request: import("../shared/memory-kernel").MemorySkillHistoryDeleteRequest): Promise<number> => ipcRenderer.invoke(MemoryIpc.deleteSkillHistory, request),
    refreshSkillCandidates: (): Promise<{ evaluated: number; created: number; updated: number; staled: number; ready: number }> => ipcRenderer.invoke(MemoryIpc.refreshSkillCandidates),
    approveSkillCandidate: (id: string): Promise<MemorySkillCandidateDto> => ipcRenderer.invoke(MemoryIpc.approveSkillCandidate, id),
    rejectSkillCandidate: (id: string): Promise<MemorySkillCandidateDto> => ipcRenderer.invoke(MemoryIpc.rejectSkillCandidate, id),
    skillEffectiveness: (limit?: number, invokedOnly?: boolean): Promise<MemorySkillEffectivenessDto[]> => ipcRenderer.invoke(MemoryIpc.skillEffectiveness, limit, invokedOnly),
    skillEffectivenessSummary: (limit?: number): Promise<MemorySkillEffectivenessSummaryDto[]> => ipcRenderer.invoke(MemoryIpc.skillEffectivenessSummary, limit),
    setSkillFeedback: (id: string, kind: MemorySkillFeedbackKind | null, note?: string): Promise<MemorySkillEffectivenessDto> => ipcRenderer.invoke(MemoryIpc.setSkillFeedback, id, kind, note),
    skillRevisionCandidates: (status?: MemorySkillRevisionStatus, limit?: number): Promise<MemorySkillRevisionCandidateDto[]> => ipcRenderer.invoke(MemoryIpc.skillRevisionCandidates, status, limit),
    refreshSkillRevisionCandidates: (): Promise<{ evaluated: number; created: number; staled: number; ready: number }> => ipcRenderer.invoke(MemoryIpc.refreshSkillRevisionCandidates),
    approveSkillRevisionCandidate: (id: string): Promise<{ candidate: MemorySkillRevisionCandidateDto; skill: import("../shared/agent-ipc").SkillDto }> => ipcRenderer.invoke(MemoryIpc.approveSkillRevisionCandidate, id),
    rejectSkillRevisionCandidate: (id: string): Promise<MemorySkillRevisionCandidateDto> => ipcRenderer.invoke(MemoryIpc.rejectSkillRevisionCandidate, id),
    reindexSemantic: (limit?: number): Promise<{ indexed: number; failed: number }> => ipcRenderer.invoke(MemoryIpc.reindexSemantic, limit),
  },

  db: {
    listExecutionFailures: (taskId: string): Promise<import("../shared/execution-recovery").ExecutionFailureDto[]> => ipcRenderer.invoke(DbIpc.listExecutionFailures, taskId),
    dismissExecutionFailure: (taskId: string, id: string): Promise<boolean> => ipcRenderer.invoke(DbIpc.dismissExecutionFailure, taskId, id),
    previewProjectFolder: (projectId: string, path: string): Promise<import("../shared/project-domain").ProjectFolderPreview> => ipcRenderer.invoke(DbIpc.previewProjectFolder, projectId, path),
    commitProjectFolder: (token: string): Promise<{ ok: true }> => ipcRenderer.invoke(DbIpc.commitProjectFolder, token),
    listSpaces: (): Promise<SpaceDto[]> => ipcRenderer.invoke(DbIpc.listSpaces),
    listTasks: (): Promise<TaskDto[]> => ipcRenderer.invoke(DbIpc.listTasks),
    listProjects: (includeArchived?: boolean): Promise<ProjectDto[]> =>
      ipcRenderer.invoke(DbIpc.listProjects, includeArchived),
    getProject: (id: string): Promise<ProjectDetailsDto | undefined> =>
      ipcRenderer.invoke(DbIpc.getProject, id),
    createProject: (request: ProjectCreateRequest): Promise<ProjectMutationResult> =>
      ipcRenderer.invoke(DbIpc.createProject, request),
    updateProject: (request: ProjectUpdateRequest): Promise<ProjectMutationResult> =>
      ipcRenderer.invoke(DbIpc.updateProject, request),
    duplicateProject: (request: ProjectDuplicateRequest): Promise<ProjectMutationResult> =>
      ipcRenderer.invoke(DbIpc.duplicateProject, request),
    archiveProject: (id: string, archived: boolean): Promise<ProjectMutationResult> =>
      ipcRenderer.invoke(DbIpc.archiveProject, id, archived),
    deleteProject: (id: string): Promise<void> => ipcRenderer.invoke(DbIpc.deleteProject, id),
    createProjectResource: (request: ProjectResourceCreateRequest): Promise<ProjectResourceDto> =>
      ipcRenderer.invoke(DbIpc.createProjectResource, request),
    updateProjectResource: (request: ProjectResourceUpdateRequest): Promise<ProjectResourceDto> =>
      ipcRenderer.invoke(DbIpc.updateProjectResource, request),
    deleteProjectResource: (id: string): Promise<void> => ipcRenderer.invoke(DbIpc.deleteProjectResource, id),
    inspectProjectResources: (projectId: string): Promise<ProjectResourceInspectionDto | null> =>
      ipcRenderer.invoke(DbIpc.inspectProjectResources, projectId),
    listProjectPosts: (projectId: string): Promise<import("../shared/project-domain").ProjectPostDto[]> =>
      ipcRenderer.invoke(DbIpc.listProjectPosts, projectId),
    createProjectPost: (request: import("../shared/project-domain").ProjectPostCreateRequest): Promise<import("../shared/project-domain").ProjectPostDto> =>
      ipcRenderer.invoke(DbIpc.createProjectPost, request),
    deleteProjectPost: (id: string): Promise<void> => ipcRenderer.invoke(DbIpc.deleteProjectPost, id),
    listProjectTodos: (projectId: string): Promise<import("../shared/project-domain").ProjectTodoDto[]> =>
      ipcRenderer.invoke(DbIpc.listProjectTodos, projectId),
    createProjectTodo: (request: import("../shared/project-domain").ProjectTodoCreateRequest): Promise<import("../shared/project-domain").ProjectTodoDto> =>
      ipcRenderer.invoke(DbIpc.createProjectTodo, request),
    updateProjectTodo: (request: import("../shared/project-domain").ProjectTodoUpdateRequest): Promise<import("../shared/project-domain").ProjectTodoDto> =>
      ipcRenderer.invoke(DbIpc.updateProjectTodo, request),
    deleteProjectTodo: (id: string): Promise<void> => ipcRenderer.invoke(DbIpc.deleteProjectTodo, id),
    listProjectMemory: (projectId: string): Promise<import("../shared/project-domain").ProjectMemoryItemDto[]> =>
      ipcRenderer.invoke(DbIpc.listProjectMemory, projectId),
    createProjectMemory: (request: import("../shared/project-domain").ProjectMemoryCreateRequest): Promise<import("../shared/project-domain").ProjectMemoryItemDto> =>
      ipcRenderer.invoke(DbIpc.createProjectMemory, request),
    updateProjectMemory: (request: import("../shared/project-domain").ProjectMemoryUpdateRequest): Promise<import("../shared/project-domain").ProjectMemoryItemDto> =>
      ipcRenderer.invoke(DbIpc.updateProjectMemory, request),
    deleteProjectMemory: (request: import("../shared/project-domain").ProjectMemoryDeleteRequest): Promise<void> =>
      ipcRenderer.invoke(DbIpc.deleteProjectMemory, request),
    pinProjectItem: (request: import("../shared/project-domain").ProjectContextPinRequest): Promise<import("../shared/project-domain").ProjectContextPinDto> =>
      ipcRenderer.invoke(DbIpc.pinProjectItem, request),
    unpinProjectItem: (request: import("../shared/project-domain").ProjectContextUnpinRequest): Promise<{ ok: true }> =>
      ipcRenderer.invoke(DbIpc.unpinProjectItem, request),
    listProjectPins: (projectId: string): Promise<import("../shared/project-domain").ProjectContextPinDto[]> =>
      ipcRenderer.invoke(DbIpc.listProjectPins, projectId),
    getProjectStatus: (projectId: string): Promise<import("../shared/project-domain").ProjectStatusSnapshotDto> =>
      ipcRenderer.invoke(DbIpc.getProjectStatus, projectId),
    recordProjectReview: (request: { projectId: string; note?: string }): Promise<import("../shared/project-domain").ProjectReviewDto> =>
      ipcRenderer.invoke(DbIpc.recordProjectReview, request),
    getProjectActions: (projectId: string): Promise<import("../shared/project-domain").ProjectActionProposalDto[]> =>
      ipcRenderer.invoke(DbIpc.getProjectActions, projectId),
    onProjectTaskChanged: (callback: (change: { projectId: string }) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, change: { projectId: string }): void => callback(change);
      ipcRenderer.on(DbIpc.projectTaskChanged, handler);
      return () => ipcRenderer.removeListener(DbIpc.projectTaskChanged, handler);
    },
    getProjectAttention: (projectId: string): Promise<import("../shared/project-domain").ProjectAttentionDigestDto | null> =>
      ipcRenderer.invoke(DbIpc.getProjectAttention, projectId),
    acknowledgeProjectAttention: (projectId: string): Promise<import("../shared/project-domain").ProjectAttentionDigestDto | null> =>
      ipcRenderer.invoke(DbIpc.acknowledgeProjectAttention, projectId),
    onProjectAttentionChanged: (callback: (digest: import("../shared/project-domain").ProjectAttentionDigestDto) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, digest: import("../shared/project-domain").ProjectAttentionDigestDto): void => callback(digest);
      ipcRenderer.on(DbIpc.projectAttentionChanged, handler);
      return () => ipcRenderer.removeListener(DbIpc.projectAttentionChanged, handler);
    },
    listProjectEvents: (projectId: string, limit?: number): Promise<import("../shared/project-domain").ProjectEventDto[]> =>
      ipcRenderer.invoke(DbIpc.listProjectEvents, projectId, limit),
    promoteProjectEvent: (request: import("../shared/project-domain").ProjectEventPromoteRequest): Promise<import("../shared/project-domain").ProjectEventPromoteResultDto> =>
      ipcRenderer.invoke(DbIpc.promoteProjectEvent, request),
    ingestProjectDocument: (projectId: string, request: { title: string; body: string; ref?: string }): Promise<import("../shared/project-domain").ProjectEventDto> =>
      ipcRenderer.invoke(DbIpc.ingestProjectDocument, projectId, request),
    importProjectFile: (projectId: string, sourcePath: string): Promise<{
      event: import("../shared/project-domain").ProjectEventDto;
      item: import("../shared/library-ipc").LibraryItemDto | null;
      reused: boolean;
    }> =>
      ipcRenderer.invoke(DbIpc.importProjectFile, projectId, sourcePath),
    pickImportFile: (): Promise<string | null> => ipcRenderer.invoke(DbIpc.pickImportFile),
    dismissProjectEvent: (projectId: string, eventId: string): Promise<import("../shared/project-domain").ProjectEventDto> =>
      ipcRenderer.invoke(DbIpc.dismissProjectEvent, projectId, eventId),
    reopenProjectEvent: (projectId: string, eventId: string): Promise<import("../shared/project-domain").ProjectEventDto> =>
      ipcRenderer.invoke(DbIpc.reopenProjectEvent, projectId, eventId),
    onProjectEventsChanged: (callback: (change: { projectId: string }) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, change: { projectId: string }): void => callback(change);
      ipcRenderer.on(DbIpc.projectEventsChanged, handler);
      return () => ipcRenderer.removeListener(DbIpc.projectEventsChanged, handler);
    },
    upsertSpace: (space: SpaceDto): Promise<DbUpsertResult> =>
      ipcRenderer.invoke(DbIpc.upsertSpace, space),
    renameSpace: (id: string, name: string): Promise<DbRenameResult> =>
      ipcRenderer.invoke(DbIpc.renameSpace, id, name),
    upsertTask: (task: TaskDto): Promise<void> => ipcRenderer.invoke(DbIpc.upsertTask, task),
    deleteTask: (id: string): Promise<void> => ipcRenderer.invoke(DbIpc.deleteTask, id),
    purgeArchivedContent: (request: ArchivedContentDeletionRequest): Promise<ArchivedContentDeletionResult> =>
      ipcRenderer.invoke(ArchivedContentDeletionIpc.purge, request),
    archiveTask: (id: string, archived: boolean): Promise<void> =>
      ipcRenderer.invoke(DbIpc.archiveTask, id, archived),
    ackTaskDone: (id: string, ackedAt?: number): Promise<void> =>
      ipcRenderer.invoke(DbIpc.ackTaskDone, id, ackedAt),
    listTrashedTasks: (): Promise<import("../shared/archive-deletion").TrashedTaskDto[]> =>
      ipcRenderer.invoke(TrashIpc.list),
    restoreTrashedTask: (id: string): Promise<TaskDto | null> =>
      ipcRenderer.invoke(TrashIpc.restore, id),
    listTaskWriteGrants: (taskId: string): Promise<import("../shared/external-write").TaskWriteGrantRow[]> =>
      ipcRenderer.invoke(DbIpc.listTaskWriteGrants, taskId),
    deleteTaskWriteGrant: (taskId: string, path: string): Promise<boolean> =>
      ipcRenderer.invoke(DbIpc.deleteTaskWriteGrant, taskId, path),
    deleteSpace: (id: string): Promise<{ ok: true; warning?: string } | { ok: false; reason: string; error: string }> =>
      ipcRenderer.invoke(DbIpc.deleteSpace, id),
    archiveSpace: (id: string, archived: boolean): Promise<void> =>
      ipcRenderer.invoke(DbIpc.archiveSpace, id, archived),
    moveSpace: (req: { spaceId: string; targetParentId: string | null; targetIndex?: number }): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke(DbIpc.moveSpace, req),
    moveTaskInWorkspaceTree: (req: { taskId: string; targetSpaceId: string | null; targetIndex?: number }): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke(DbIpc.moveTaskInWorkspaceTree, req),
    getSoul: (): Promise<SoulDto> => ipcRenderer.invoke(DbIpc.getSoul),
    updateSoul: (partial: Partial<SoulDto>): Promise<SoulDto> =>
      ipcRenderer.invoke(DbIpc.updateSoul, partial),
    onMemoryChanged: (callback: (change: MemoryChangedDto) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, change: MemoryChangedDto): void => callback(change);
      ipcRenderer.on(DbIpc.memoryChanged, handler);
      return () => ipcRenderer.removeListener(DbIpc.memoryChanged, handler);
    },
    getSemanticIndexStats: (): Promise<{ running: boolean; pending?: number; failed?: number; processed?: number }> =>
      ipcRenderer.invoke(DbIpc.getSemanticIndexStats),
    getSemanticModelStatus: (): Promise<{ status: string; error: string | null; modelsRoot: string }> =>
      ipcRenderer.invoke(DbIpc.getSemanticModelStatus),
  },

  cron: {
    list: (): Promise<CronJobDto[]> => ipcRenderer.invoke(CronIpc.list),
    runs: (limit?: number): Promise<CronRunDto[]> => ipcRenderer.invoke(CronIpc.runs, limit),
    upsert: (job: CronJobDto): Promise<CronJobDto> => ipcRenderer.invoke(CronIpc.upsert, job),
    setEnabled: (id: string, enabled: boolean): Promise<void> =>
      ipcRenderer.invoke(CronIpc.setEnabled, id, enabled),
    remove: (id: string): Promise<void> => ipcRenderer.invoke(CronIpc.remove, id),
    runNow: (id: string): Promise<void> => ipcRenderer.invoke(CronIpc.runNow, id),
    onEvent: (callback: (ev: unknown) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, ev: unknown): void => callback(ev);
      ipcRenderer.on(CronIpc.event, handler);
      return () => ipcRenderer.removeListener(CronIpc.event, handler);
    },
  },

  gateway: {
    weixinQrStart: (approvedPersistentAccess: boolean): Promise<GatewayWeixinQrLoginStateDto> => ipcRenderer.invoke(GatewayIpc.weixinQrStart, approvedPersistentAccess),
    qqQrStart: (approvedPersistentAccess: boolean): Promise<GatewayQQQrLoginStateDto> => ipcRenderer.invoke(GatewayIpc.qqQrStart, approvedPersistentAccess),
    weixinQrState: (): Promise<GatewayWeixinQrLoginStateDto> => ipcRenderer.invoke(GatewayIpc.weixinQrState),
    qqQrState: (): Promise<GatewayQQQrLoginStateDto> => ipcRenderer.invoke(GatewayIpc.qqQrState),
    weixinQrCancel: (sessionId?: string): Promise<GatewayWeixinQrLoginStateDto> => ipcRenderer.invoke(GatewayIpc.weixinQrCancel, sessionId),
    qqQrCancel: (sessionId?: string): Promise<GatewayQQQrLoginStateDto> => ipcRenderer.invoke(GatewayIpc.qqQrCancel, sessionId),
    status: (): Promise<GatewayStatusDto> => ipcRenderer.invoke(GatewayIpc.status),
    listChannels: (): Promise<GatewayStatusDto["channels"]> =>
      ipcRenderer.invoke(GatewayIpc.listChannels),
    connect: (channelId: string, config: Record<string, unknown>): Promise<GatewayStatusDto> =>
      ipcRenderer.invoke(GatewayIpc.connect, channelId, config),
    disconnect: (channelId: string): Promise<GatewayStatusDto> =>
      ipcRenderer.invoke(GatewayIpc.disconnect, channelId),
    getChannelConfig: (channelId: string): Promise<GatewayChannelConfigDto> =>
      ipcRenderer.invoke(GatewayIpc.getChannelConfig, channelId),
    listMessages: (req: GatewayListMessagesRequest): Promise<GatewayMessageDto[]> =>
      ipcRenderer.invoke(GatewayIpc.listMessages, req),
    onEvent: (callback: (ev: GatewayEventDto) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, ev: GatewayEventDto): void => callback(ev);
      ipcRenderer.on(GatewayIpc.event, handler);
      return () => ipcRenderer.removeListener(GatewayIpc.event, handler);
    },
  },

  plugins: {
    paths: (): Promise<PluginStoragePathsDto> => ipcRenderer.invoke(PluginStorageIpc.paths),
    openDirectory: (): Promise<{ ok: boolean; path: string; error?: string }> => ipcRenderer.invoke(PluginStorageIpc.openDirectory),
  },
  mcp: {
    discover: (): Promise<McpDiscoveryDto> => ipcRenderer.invoke(McpIpc.discover),
    listServers: (): Promise<McpServerDto[]> => ipcRenderer.invoke(McpIpc.listServers),
    install: (names: string[]): Promise<McpInstallResultDto> =>
      ipcRenderer.invoke(McpIpc.install, names),
    installBundled: (): Promise<McpInstallResultDto> =>
      ipcRenderer.invoke(McpIpc.installBundled),
    remove: (names: string[]): Promise<McpInstallResultDto> =>
      ipcRenderer.invoke(McpIpc.remove, names),
    setServerEnabled: (name: string, enabled: boolean): Promise<McpInstallResultDto> =>
      ipcRenderer.invoke(McpIpc.setServerEnabled, name, enabled),
    readAppConfig: (): Promise<McpProjectConfigDto> =>
      ipcRenderer.invoke(McpIpc.readAppConfig),
    writeAppConfig: (text: string): Promise<McpInstallResultDto> =>
      ipcRenderer.invoke(McpIpc.writeAppConfig, text),
    readServerConfig: (name: string): Promise<McpServerConfigDto> => ipcRenderer.invoke(McpIpc.readServerConfig, name),
    saveServerConfig: (request: McpSaveServerRequest): Promise<McpInstallResultDto> => ipcRenderer.invoke(McpIpc.saveServerConfig, request),
    serverTools: (name: string): Promise<import("../shared/agent-ipc").McpServerToolsDto> => ipcRenderer.invoke(McpIpc.serverTools, name),
    status: (taskId?: string): Promise<McpStatusSnapshotDto | null> => ipcRenderer.invoke(McpIpc.status, taskId),
    connect: (name: string, taskId?: string): Promise<McpProxyResultDto> =>
      ipcRenderer.invoke(McpIpc.connect, name, taskId),
    authStart: (name: string): Promise<McpProxyResultDto> =>
      ipcRenderer.invoke(McpIpc.authStart, name),
    authComplete: (name: string, input: string): Promise<McpProxyResultDto> =>
      ipcRenderer.invoke(McpIpc.authComplete, name, input),
    logout: (name: string): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(McpIpc.logout, name),
    hasCredentials: (name: string): Promise<boolean> =>
      ipcRenderer.invoke(McpIpc.hasCredentials, name),
    uiRespond: (requestId: string, value?: string | boolean): Promise<boolean> =>
      ipcRenderer.invoke(McpIpc.uiRespond, requestId, value),
    uiCancel: (requestId?: string): Promise<void> =>
      ipcRenderer.invoke(McpIpc.uiCancel, requestId),
    onStatusEvent: (callback: (snapshot: McpStatusSnapshotDto) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, snapshot: McpStatusSnapshotDto): void =>
        callback(snapshot);
      ipcRenderer.on(McpIpc.statusEvent, handler);
      return () => ipcRenderer.removeListener(McpIpc.statusEvent, handler);
    },
    onNotify: (callback: (ev: McpNotifyDto) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, ev: McpNotifyDto): void => callback(ev);
      ipcRenderer.on(McpIpc.notify, handler);
      return () => ipcRenderer.removeListener(McpIpc.notify, handler);
    },
    onUiPrompt: (callback: (req: McpUiPromptDto) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, req: McpUiPromptDto): void => callback(req);
      ipcRenderer.on(McpIpc.uiPrompt, handler);
      return () => ipcRenderer.removeListener(McpIpc.uiPrompt, handler);
    },
  },

  professionalTools: {
    status: (providerId: ProfessionalToolProviderId): Promise<ProfessionalToolStatusDto> =>
      ipcRenderer.invoke(ProfessionalToolIpc.status, providerId),
    prepare: (providerId: ProfessionalToolProviderId): Promise<ProfessionalToolResultDto> =>
      ipcRenderer.invoke(ProfessionalToolIpc.prepare, providerId),
    open: (providerId: ProfessionalToolProviderId): Promise<ProfessionalToolResultDto> =>
      ipcRenderer.invoke(ProfessionalToolIpc.open, providerId),
    stop: (providerId: ProfessionalToolProviderId): Promise<ProfessionalToolStatusDto> =>
      ipcRenderer.invoke(ProfessionalToolIpc.stop, providerId),
  },

  htmlEdit: {
    start: (request: import("../shared/html-edit").HtmlEditStart): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("html-edit:start", request),
    stop: (): Promise<void> => ipcRenderer.invoke("html-edit:stop"),
    onState: (callback: (state: import("../shared/html-edit").HtmlEditState) => void): (() => void) => {
      const handler = (_event: Electron.IpcRendererEvent, state: import("../shared/html-edit").HtmlEditState): void => callback(state);
      ipcRenderer.on("html-edit:state", handler);
      return () => ipcRenderer.removeListener("html-edit:state", handler);
    },
  },
  /** 浏览器 / HTML 产物预览共享控制台（main RuntimeProbeService 的只读投影）。 */
  runtimeConsole: {
    snapshot: (target: BrowserConsoleTarget): Promise<BrowserConsoleSnapshotDto> =>
      ipcRenderer.invoke(RuntimeConsoleIpc.snapshot, target),
    clear: (target: BrowserConsoleTarget): Promise<boolean> => ipcRenderer.invoke(RuntimeConsoleIpc.clear, target),
    onEntry: (callback: (event: BrowserConsoleEventDto) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, event: BrowserConsoleEventDto): void => callback(event);
      ipcRenderer.on(RuntimeConsoleIpc.event, handler);
      return () => ipcRenderer.removeListener(RuntimeConsoleIpc.event, handler);
    },
  },
  /** 扩展栏浏览器（WebContentsView） */
  browser: {
    open: (url: string, options?: { reload?: boolean }): void => ipcRenderer.send(BrowserIpc.open, url, options),
    close: (): void => ipcRenderer.send(BrowserIpc.open, ""),
    navigate: (url: string): void => ipcRenderer.send(BrowserIpc.navigate, url),
    reload: (): void => ipcRenderer.send(BrowserIpc.reload),
    hardReload: (): void => ipcRenderer.send(BrowserIpc.hardReload),
    back: (): void => ipcRenderer.send(BrowserIpc.back),
    forward: (): void => ipcRenderer.send(BrowserIpc.forward),
    /** 无参：打开扩展栏当前页；有 url：打开指定 http(s)（聊天外链） */
    openExternal: (url?: string): void => ipcRenderer.send(BrowserIpc.openExternal, url),
    setRect: (rect: { x: number; y: number; width: number; height: number }): void =>
      ipcRenderer.send(BrowserIpc.setRect, rect),
    hide: (): void => ipcRenderer.send(BrowserIpc.hide),
    show: (): void => ipcRenderer.send(BrowserIpc.show),
    addBlocker: (token: string): void => ipcRenderer.send(BrowserIpc.addBlocker, token),
    removeBlocker: (token: string): void => ipcRenderer.send(BrowserIpc.removeBlocker, token),
    onUrlChanged: (callback: (url: string) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, url: string): void => callback(url);
      ipcRenderer.on(BrowserIpc.urlChanged, handler);
      return () => ipcRenderer.removeListener(BrowserIpc.urlChanged, handler);
    },
    onOpenRequest: (callback: (url: string) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, payload: { url?: string } | string): void => {
        const url = typeof payload === "string" ? payload : payload?.url;
        if (url) callback(url);
      };
      ipcRenderer.on(BrowserIpc.openRequest, handler);
      return () => ipcRenderer.removeListener(BrowserIpc.openRequest, handler);
    },
  },

  artifact: {
    preview: (req: ArtifactPreviewRequest): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(ArtifactIpc.preview, req),
    reload: (): void => ipcRenderer.send(ArtifactIpc.reload),
    hardReload: (): void => ipcRenderer.send(ArtifactIpc.hardReload),
    openInBrowser: (req: ArtifactPreviewRequest): Promise<{ ok: boolean; error?: string }> =>
      ipcRenderer.invoke(ArtifactIpc.openInBrowser, req),
    close: (): void => ipcRenderer.send(ArtifactIpc.close),
    /** Wave 4A：显示意图统一走 NativeSurfaceCoordinator（§75）；setRect/hide/show 已移除 */
    surface: {
      requestBounds: (surfaceId: string, rect: { x: number; y: number; width: number; height: number }): void =>
        ipcRenderer.send(ArtifactSurfaceIpc.requestBounds, { surfaceId, rect }),
      requestVisible: (surfaceId: string, visible: boolean): void =>
        ipcRenderer.send(ArtifactSurfaceIpc.requestVisible, { surfaceId, visible }),
      addBlocker: (surfaceId: string, token: string): void =>
        ipcRenderer.send(ArtifactSurfaceIpc.addBlocker, { surfaceId, token }),
      removeBlocker: (surfaceId: string, token: string): void =>
        ipcRenderer.send(ArtifactSurfaceIpc.removeBlocker, { surfaceId, token }),
    },
  },

  /** 扩展栏终端（node-pty，主进程托管；renderer 只走白名单 IPC） */
  terminal: {
    /** 打开（spawn 或 attach 存活会话并回放） */
    open: (req: TerminalOpenRequest): Promise<TerminalSessionInfo> =>
      ipcRenderer.invoke(TerminalIpc.open, req),
    /** 杀当前会话并重启（新 sessionId） */
    restart: (req: TerminalOpenRequest): Promise<TerminalSessionInfo> =>
      ipcRenderer.invoke(TerminalIpc.restart, req),
    /** 用户输入写入 pty（不解析、不执行；仅透传） */
    input: (req: TerminalInputRequest): void => ipcRenderer.send(TerminalIpc.input, req),
    /** 面板尺寸变化 → pty resize */
    resize: (req: TerminalResizeRequest): void => ipcRenderer.send(TerminalIpc.resize, req),
    /** kill 当前会话（PTY 保活由主进程管理，renderer 不持有生命周期） */
    close: (req: TerminalCloseRequest): void => ipcRenderer.send(TerminalIpc.close, req),
    /** Chat Context Source：有界最近输出 */
    tail: (req: TerminalTailRequest): Promise<TerminalTailResult> =>
      ipcRenderer.invoke(TerminalIpc.tail, req),
    /** 为当前空间定位/创建 Herdr workspace；真正 TUI 仍在可见 PTY 内启动 */
    prepareHerdr: (req: TerminalPrepareHerdrRequest): Promise<TerminalPrepareHerdrResult> =>
      ipcRenderer.invoke(TerminalIpc.prepareHerdr, req),
    onData: (callback: (ev: TerminalDataEvent) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, ev: TerminalDataEvent): void => callback(ev);
      ipcRenderer.on(TerminalIpc.data, handler);
      return () => ipcRenderer.removeListener(TerminalIpc.data, handler);
    },
    onExit: (callback: (ev: TerminalExitEvent) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, ev: TerminalExitEvent): void => callback(ev);
      ipcRenderer.on(TerminalIpc.exit, handler);
      return () => ipcRenderer.removeListener(TerminalIpc.exit, handler);
    },
  },

  /** 受管 Python 运行时：解释器与环境由主进程权威解析，renderer 只读状态、只按 id 回收 */
  pythonRuntime: {
    /** 当前阶段 / uv / 解释器 / 环境 / 根目录（高级设置展示路径与版本用） */
    status: (): Promise<PythonRuntimeStatus> => ipcRenderer.invoke(PythonRuntimeIpc.status),
    list: (): Promise<PythonEnvironmentInfo[]> => ipcRenderer.invoke(PythonRuntimeIpc.list),
    /** 按需准备环境；失败返回结果对象（含 failureStage），不抛错 */
    prepare: (req: PreparePythonEnvironmentRequest): Promise<PreparePythonEnvironmentResult> =>
      ipcRenderer.invoke(PythonRuntimeIpc.prepare, req),
    remove: (environmentId: string): Promise<{ ok: boolean; detail: string }> =>
      ipcRenderer.invoke(PythonRuntimeIpc.remove, environmentId),
    /** 清理安装失败留下的暂存目录 */
    cleanStaging: (): Promise<{ removed: number; detail: string }> =>
      ipcRenderer.invoke(PythonRuntimeIpc.cleanStaging),
    /** 回收被取代的 uv 版本目录与下载缓存 */
    reclaimDisk: (): Promise<{ removed: number; detail: string }> =>
      ipcRenderer.invoke(PythonRuntimeIpc.reclaimDisk),
    /** 导出诊断快照（路径 / 版本 / 环境清单 / 项目绑定）到用户选择的 JSON 文件 */
    exportDiagnostics: (): Promise<PythonDiagnosticsExportResult> =>
      ipcRenderer.invoke(PythonRuntimeIpc.exportDiagnostics),
    /** 当前项目解释器：手动覆盖优先，否则自动识别项目内虚拟环境 */
    inspectProject: (projectDir: string): Promise<PythonProjectInterpreterView> =>
      ipcRenderer.invoke(PythonRuntimeIpc.inspectProject, projectDir),
    /** 手动覆盖记录，仅诊断/兼容使用 */
    listProjectBindings: (): Promise<PythonProjectBindingView[]> =>
      ipcRenderer.invoke(PythonRuntimeIpc.listProjectBindings),
    bindProject: (req: PythonProjectBindingRequest): Promise<PythonProjectBindingMutationResult> =>
      ipcRenderer.invoke(PythonRuntimeIpc.bindProject, req),
    unbindProject: (projectDir: string): Promise<{ ok: boolean; detail: string }> =>
      ipcRenderer.invoke(PythonRuntimeIpc.unbindProject, projectDir),
    /** 原生目录选择器；取消返回 null */
    pickProjectDir: (): Promise<string | null> => ipcRenderer.invoke(PythonRuntimeIpc.pickProjectDir),
    /** 原生解释器选择器；取消返回 null */
    pickInterpreter: (defaultPath?: string): Promise<string | null> =>
      ipcRenderer.invoke(PythonRuntimeIpc.pickInterpreter, defaultPath),
    onProgress: (callback: (ev: PythonRuntimeProgressEvent) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, ev: PythonRuntimeProgressEvent): void => callback(ev);
      ipcRenderer.on(PythonRuntimeIpc.progress, handler);
      return () => ipcRenderer.removeListener(PythonRuntimeIpc.progress, handler);
    },
  },

  /** Wave 4C：Capture Mode（MVP：enter/exit/startInspect/stopInspect + state/selection 事件） */
  captureMode: {
    enter: (req: CaptureModeEnterRequest): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(CaptureModeIpc.enter, req),
    exit: (): void => ipcRenderer.send(CaptureModeIpc.exit),
    startInspect: (): void => ipcRenderer.send(CaptureModeIpc.startInspect),
    stopInspect: (): void => ipcRenderer.send(CaptureModeIpc.stopInspect),
    onState: (callback: (ev: CaptureModeStateEvent) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, ev: CaptureModeStateEvent): void => callback(ev);
      ipcRenderer.on(CaptureModeEvent.state, handler);
      return () => ipcRenderer.removeListener(CaptureModeEvent.state, handler);
    },
  },

  /** Wave 4D：Selection 投影（唯一 truth 在 main SelectionStore；renderer 只读） */
  selection: {
    comment: (): void => ipcRenderer.send(SelectionIpc.comment),
    onAttach: (callback: (event: import("../shared/selection").SelectionAttachEvent) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, event: import("../shared/selection").SelectionAttachEvent): void => callback(event);
      ipcRenderer.on(SelectionEvent.attach, handler);
      return () => ipcRenderer.removeListener(SelectionEvent.attach, handler);
    },
    get: (): Promise<SelectionState | null> => ipcRenderer.invoke(SelectionIpc.get),
    clear: (): void => ipcRenderer.send(SelectionIpc.clear),
    onChanged: (callback: (ev: SelectionChangedEvent) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, ev: SelectionChangedEvent): void => callback(ev);
      ipcRenderer.on(SelectionEvent.changed, handler);
      return () => ipcRenderer.removeListener(SelectionEvent.changed, handler);
    },
  },

  /** Wave 4E：Prompt Context 采集（E2E 入口；不接 Agent） */
  promptContext: {
    collect: (req: PromptContextCollectRequest): Promise<PromptContextResult> =>
      ipcRenderer.invoke(PromptContextIpc.collect, req),
  },

  artifactDomain: {
    get: (req: ArtifactDomainGetRequest): Promise<ArtifactDomainGetResponse> =>
      ipcRenderer.invoke(ArtifactDomainIpc.get, req),
    list: (req: ArtifactDomainTaskRequest): Promise<ArtifactDomainListResponse> =>
      ipcRenderer.invoke(ArtifactDomainIpc.list, req),
    snapshot: (req: ArtifactDomainTaskRequest): Promise<ArtifactSnapshot> =>
      ipcRenderer.invoke(ArtifactDomainIpc.snapshot, req),
    register: (req: ArtifactDomainRegisterRequest): Promise<ArtifactDescriptor> =>
      ipcRenderer.invoke(ArtifactDomainIpc.register, req),
    readContent: (req: ArtifactDomainReadContentRequest): Promise<ArtifactDomainReadContentResponse | null> =>
      ipcRenderer.invoke(ArtifactDomainIpc.readContent, req),
    removeTask: (req: ArtifactDomainTaskRequest): Promise<{ removed: number; orphaned: number }> =>
      ipcRenderer.invoke(ArtifactDomainIpc.removeTask, req),
    remove: (req: ArtifactDomainRemoveRequest): Promise<{ ok: boolean }> =>
      ipcRenderer.invoke(ArtifactDomainIpc.remove, req),
    onCreated: (callback: (ev: ArtifactCreatedEvent) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, ev: ArtifactCreatedEvent): void => callback(ev);
      ipcRenderer.on(ArtifactDomainIpc.created, handler);
      return () => ipcRenderer.removeListener(ArtifactDomainIpc.created, handler);
    },
    onUpdated: (callback: (ev: ArtifactUpdatedEvent) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, ev: ArtifactUpdatedEvent): void => callback(ev);
      ipcRenderer.on(ArtifactDomainIpc.updated, handler);
      return () => ipcRenderer.removeListener(ArtifactDomainIpc.updated, handler);
    },
    onRemoved: (callback: (ev: ArtifactRemovedEvent) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, ev: ArtifactRemovedEvent): void => callback(ev);
      ipcRenderer.on(ArtifactDomainIpc.removed, handler);
      return () => ipcRenderer.removeListener(ArtifactDomainIpc.removed, handler);
    },
  },

  gadget: {
    create: (request: GadgetCreateRequest): Promise<GadgetDescriptor> => ipcRenderer.invoke(GadgetIpc.create, request),
    list: (request?: GadgetListRequest): Promise<GadgetListItem[]> => ipcRenderer.invoke(GadgetIpc.list, request),
    get: (id: string): Promise<GadgetListItem | null> => ipcRenderer.invoke(GadgetIpc.get, id),
    update: (request: GadgetUpdateRequest): Promise<GadgetDescriptor> => ipcRenderer.invoke(GadgetIpc.update, request),
    readSource: (id: string): Promise<GadgetSourceSnapshot> => ipcRenderer.invoke(GadgetIpc.readSource, id),
    updateSource: (request: GadgetSourceUpdateRequest): Promise<GadgetSourceSnapshot> => ipcRenderer.invoke(GadgetIpc.updateSource, request),
    moveScope: (request: GadgetMoveScopeRequest): Promise<GadgetDescriptor> => ipcRenderer.invoke(GadgetIpc.moveScope, request),
    start: (id: string): Promise<GadgetRuntimeState> => ipcRenderer.invoke(GadgetIpc.start, id),
    health: (id: string): Promise<GadgetRuntimeState> => ipcRenderer.invoke(GadgetIpc.health, id),
    stop: (id: string): Promise<GadgetRuntimeState> => ipcRenderer.invoke(GadgetIpc.stop, id),
    restart: (id: string): Promise<GadgetRuntimeState> => ipcRenderer.invoke(GadgetIpc.restart, id),
    delete: (id: string): Promise<{ ok: true }> => ipcRenderer.invoke(GadgetIpc.delete, id),
    convertFromArtifact: (request: GadgetConvertFromArtifactRequest): Promise<GadgetDescriptor> =>
      ipcRenderer.invoke(GadgetIpc.convertFromArtifact, request),
    exportArtifact: (request: GadgetExportArtifactRequest): Promise<{ artifactId: string }> =>
      ipcRenderer.invoke(GadgetIpc.exportArtifact, request),
    saveAsBlueprint: (request: GadgetSaveAsBlueprintRequest): Promise<{ blueprintId: string }> =>
      ipcRenderer.invoke(GadgetIpc.saveAsBlueprint, request),
    onChanged: (callback: (event: GadgetChangedEvent) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, event: GadgetChangedEvent): void => callback(event);
      ipcRenderer.on(GadgetIpc.changed, handler);
      return () => ipcRenderer.removeListener(GadgetIpc.changed, handler);
    },
  },

  blueprint: {
    create: (request: BlueprintCreateRequest): Promise<BlueprintDescriptor> => ipcRenderer.invoke(BlueprintIpc.create, request),
    list: (): Promise<BlueprintDescriptor[]> => ipcRenderer.invoke(BlueprintIpc.list),
    get: (id: string): Promise<BlueprintDescriptor | null> => ipcRenderer.invoke(BlueprintIpc.get, id),
    update: (request: BlueprintUpdateRequest): Promise<BlueprintDescriptor> => ipcRenderer.invoke(BlueprintIpc.update, request),
    resolve: (id: string, registries?: TemplateCapabilityRegistries): Promise<ResolvedBlueprint> => ipcRenderer.invoke(BlueprintIpc.resolve, id, registries),
    plan: (id: string, registries?: TemplateCapabilityRegistries): Promise<BlueprintInstantiationPlan> => ipcRenderer.invoke(BlueprintIpc.plan, id, registries),
    capture: (request: BlueprintCaptureRequest): Promise<BlueprintDescriptor> => ipcRenderer.invoke(BlueprintIpc.capture, request),
    previewCapture: (request: BlueprintCaptureRequest): Promise<BlueprintDefinition> => ipcRenderer.invoke(BlueprintIpc.previewCapture, request),
    instantiate: (request: BlueprintInstantiateRequest): Promise<BlueprintInstantiationResult> =>
      ipcRenderer.invoke(BlueprintIpc.instantiate, request),
    delete: (id: string): Promise<{ ok: true }> => ipcRenderer.invoke(BlueprintIpc.delete, id),
    onChanged: (callback: (event: BlueprintChangedEvent) => void): (() => void) => {
      const handler = (_: Electron.IpcRendererEvent, event: BlueprintChangedEvent): void => callback(event);
      ipcRenderer.on(BlueprintIpc.changed, handler);
      return () => ipcRenderer.removeListener(BlueprintIpc.changed, handler);
    },
  },

  library: {
    snapshot: (): Promise<LibrarySnapshotDto> => ipcRenderer.invoke(LibraryIpc.snapshot),
    listItems: (req: LibraryListItemsRequest): Promise<LibraryItemDto[]> =>
      ipcRenderer.invoke(LibraryIpc.listItems, req),
    getItem: (id: string): Promise<LibraryItemDto | null> => ipcRenderer.invoke(LibraryIpc.getItem, id),
    createSpace: (req: LibraryCreateSpaceRequest): Promise<{ ok: true; value: LibrarySpaceDto } | { ok: false; error: string }> =>
      ipcRenderer.invoke(LibraryIpc.createSpace, req),
    ensureOwnedSpace: (owner: import("../shared/library-ipc").LibraryOwnerScope): Promise<{ ok: true; value: LibrarySpaceDto } | { ok: false; error: string }> =>
      ipcRenderer.invoke(LibraryIpc.ensureOwnedSpace, owner),
    renameSpace: (req: LibraryRenameSpaceRequest): Promise<{ ok: true; value: LibrarySpaceDto } | { ok: false; error: string }> =>
      ipcRenderer.invoke(LibraryIpc.renameSpace, req),
    deleteSpace: (id: string): Promise<{ ok: true; value: void } | { ok: false; error: string }> =>
      ipcRenderer.invoke(LibraryIpc.deleteSpace, id),
    createCollection: (req: import("../shared/library-ipc").LibraryCreateCollectionRequest): Promise<{ ok: true; value: import("../shared/library-ipc").LibraryCollectionDto } | { ok: false; error: string }> =>
      ipcRenderer.invoke(LibraryIpc.createCollection, req),
    renameCollection: (req: import("../shared/library-ipc").LibraryRenameCollectionRequest): Promise<{ ok: true; value: import("../shared/library-ipc").LibraryCollectionDto } | { ok: false; error: string }> =>
      ipcRenderer.invoke(LibraryIpc.renameCollection, req),
    moveCollection: (req: import("../shared/library-ipc").LibraryMoveCollectionRequest): Promise<{ ok: true; value: import("../shared/library-ipc").LibraryCollectionDto } | { ok: false; error: string }> =>
      ipcRenderer.invoke(LibraryIpc.moveCollection, req),
    deleteCollection: (id: string): Promise<{ ok: true; value: void } | { ok: false; error: string }> =>
      ipcRenderer.invoke(LibraryIpc.deleteCollection, id),
    createItem: (req: LibraryCreateItemRequest): Promise<{ ok: true; value: LibraryItemDto } | { ok: false; error: string }> =>
      ipcRenderer.invoke(LibraryIpc.createItem, req),
    updateItem: (req: LibraryUpdateItemRequest): Promise<{ ok: true; value: LibraryItemDto } | { ok: false; error: string }> =>
      ipcRenderer.invoke(LibraryIpc.updateItem, req),
    deleteItem: (id: string): Promise<{ ok: true; value: void } | { ok: false; error: string }> =>
      ipcRenderer.invoke(LibraryIpc.deleteItem, id),
    readContent: (id: string): Promise<{ ok: true; value: LibraryContentDto } | { ok: false; error: string }> =>
      ipcRenderer.invoke(LibraryIpc.readContent, id),
    writeContent: (req: LibraryWriteContentRequest): Promise<{ ok: true; value: LibraryItemDto } | { ok: false; error: string }> =>
      ipcRenderer.invoke(LibraryIpc.writeContent, req),
    importFile: (req: LibraryImportFileRequest): Promise<{ ok: true; value: LibraryItemDto } | { ok: false; error: string }> =>
      ipcRenderer.invoke(LibraryIpc.importFile, req),
    pickAndImport: (req: {
      spaceId: string;
      collectionId?: string | null;
    }): Promise<{ ok: true; value: LibraryItemDto[] } | { ok: false; error: string }> =>
      ipcRenderer.invoke(LibraryIpc.pickAndImport, req),
    markVisited: (id: string): Promise<{ ok: true; value: LibraryItemDto } | { ok: false; error: string }> =>
      ipcRenderer.invoke(LibraryIpc.markVisited, id),
    search: (req: import("../shared/library-ipc").LibrarySearchRequest): Promise<LibraryListRowDto[]> => ipcRenderer.invoke(LibraryIpc.search, req),
    previewUrl: (id: string): Promise<string> => ipcRenderer.invoke(LibraryIpc.previewUrl, id),
    showInFolder: (id: string): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke(LibraryIpc.showInFolder, id),
    createUrl: (req: import("../shared/library-ipc").LibraryCreateUrlRequest): Promise<{ ok: true; value: import("../shared/library-ipc").LibraryItemDto } | { ok: false; error: string }> =>
      ipcRenderer.invoke(LibraryIpc.createUrl, req),
    saveArtifact: (req: import("../shared/library-ipc").LibrarySaveArtifactRequest): Promise<{ ok: true; value: import("../shared/library-ipc").LibraryItemDto } | { ok: false; error: string }> =>
      ipcRenderer.invoke(LibraryIpc.saveArtifact, req),
    favorite: (req: import("../shared/library-ipc").LibraryFavoriteRequest): Promise<{ ok: true; value: import("../shared/library-ipc").LibraryItemDto } | { ok: false; error: string }> =>
      ipcRenderer.invoke(LibraryIpc.favorite, req),
    attachToTask: (req: import("../shared/library-ipc").LibraryAttachRequest): Promise<{ ok: true; value: import("../shared/library-ipc").LibraryTaskReferenceDto } | { ok: false; error: string }> =>
      ipcRenderer.invoke(LibraryIpc.attachToTask, req),
    detachFromTask: (req: import("../shared/library-ipc").LibraryDetachRequest): Promise<{ ok: true; value: void } | { ok: false; error: string }> =>
      ipcRenderer.invoke(LibraryIpc.detachFromTask, req),
    listTaskReferences: (taskId: string): Promise<{ ok: true; value: import("../shared/library-ipc").LibraryTaskReferencesDto } | { ok: false; error: string }> =>
      ipcRenderer.invoke(LibraryIpc.listTaskReferences, taskId),
  },

  projectNotes: {
    read: (projectId: string) => ipcRenderer.invoke(ProjectNotesIpc.read, projectId),
    save: (request: ProjectNoteSaveRequest) => ipcRenderer.invoke(ProjectNotesIpc.save, request),
  },
  workspace: {
    notes: {
      read: (workspaceId: string) => ipcRenderer.invoke(WorkspaceNotesIpc.read, workspaceId),
      save: (request: WorkspaceNoteSaveRequest) => ipcRenderer.invoke(WorkspaceNotesIpc.save, request),
    },
    getSharedContextView: (req: WorkspaceSharedContextViewRequest): Promise<WorkspaceSharedContextView> =>
      ipcRenderer.invoke(WorkspaceIpc.getView, req),
    promoteSharedContextItem: (req: WorkspaceSharedContextPromoteRequest): Promise<WorkspaceSharedContextPromoteResult> =>
      ipcRenderer.invoke(WorkspaceIpc.promote, req),
    libraryBindings: {
      createFolder: (req: { workspaceId: string; librarySpaceId: string; name: string }) => ipcRenderer.invoke(WorkspaceLibraryBindingIpc.createFolder, req),
      list: (workspaceId: string): Promise<WorkspaceLibraryBindingListView> =>
        ipcRenderer.invoke(WorkspaceLibraryBindingIpc.list, workspaceId),
      bind: (req: WorkspaceLibraryBindingRequest): Promise<WorkspaceLibraryBindingMutationResult> =>
        ipcRenderer.invoke(WorkspaceLibraryBindingIpc.bind, req),
      unbind: (req: WorkspaceLibraryBindingRequest): Promise<WorkspaceLibraryBindingMutationResult> =>
        ipcRenderer.invoke(WorkspaceLibraryBindingIpc.unbind, req),
    },
  },

  workgraph: {
    addEdge: (req: WorkGraphAddEdgeRequest): Promise<WorkGraphAddEdgeResult> =>
      ipcRenderer.invoke(WorkGraphIpc.addEdge, req),
    removeEdge: (id: string): Promise<WorkGraphRemoveEdgeResult> =>
      ipcRenderer.invoke(WorkGraphIpc.removeEdge, id),
    listOutgoing: (req: WorkGraphListRequest): Promise<WorkGraphEdgeDto[]> =>
      ipcRenderer.invoke(WorkGraphIpc.listOutgoing, req),
    listIncoming: (req: WorkGraphListRequest): Promise<WorkGraphEdgeDto[]> =>
      ipcRenderer.invoke(WorkGraphIpc.listIncoming, req),
    listRelated: (req: WorkGraphListRequest): Promise<WorkGraphEdgeDto[]> =>
      ipcRenderer.invoke(WorkGraphIpc.listRelated, req),
    checkIntegrity: (): Promise<import("../shared/work-graph").WorkGraphIntegrityReport> =>
      ipcRenderer.invoke(WorkGraphIpc.checkIntegrity),
    previewRepair: (report: import("../shared/work-graph").WorkGraphIntegrityReport): Promise<import("../shared/work-graph").WorkGraphRepairPreview> =>
      ipcRenderer.invoke(WorkGraphIpc.previewRepair, report),
    applyRepair: (preview: import("../shared/work-graph").WorkGraphRepairPreview): Promise<{ deletedEdges: number; deletedBindings: number }> =>
      ipcRenderer.invoke(WorkGraphIpc.applyRepair, preview),
    observability: (): Promise<import("../shared/work-graph").WorkGraphObservability> =>
      ipcRenderer.invoke(WorkGraphIpc.observability),
    benchmark: (): Promise<import("../shared/work-graph").WorkGraphBenchmarkResult> =>
      ipcRenderer.invoke(WorkGraphIpc.benchmark),
  },
};

contextBridge.exposeInMainWorld("api", api);

export type PreloadApi = typeof api;
