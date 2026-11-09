import "./platform/credentials";
import "./agent-environment";
import "./officecli-environment";
import { workApprovalIpcHandler } from "./agent/work/WorkApprovalIpc";
import { ensureOfficeCliSkill } from "./skills/OfficeCliSkill";
import { ProjectNotesIpc, type ProjectNoteSaveRequest } from "../shared/project-notes";
import { ProjectNotesService } from "./project/ProjectNotesService";
import { WorkspaceNotesIpc } from "../shared/workspace-notes";
import { WorkspaceNotesService } from "./workspace/WorkspaceNotesService";
import { ExecutionFailureRepository } from "./agent/ExecutionFailureRepository";
import { HtmlEditService } from "./html-edit/HtmlEditService";
import { HtmlEditIpc, type HtmlEditStart } from "../shared/html-edit";
import "./pi-bundled-runtime";
import { randomUUID } from "node:crypto";
import { closeSync, copyFileSync, existsSync, openSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { app, BrowserWindow, crashReporter, dialog, ipcMain, Menu, nativeImage, nativeTheme, powerMonitor, protocol, shell } from "electron";
import appIconPath from "./assets/app.ico?asset";
import appPngPath from "./assets/app.png?asset";
import trayPngPath from "./assets/tray.png?asset";
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
  UsageIpc,
  WorkspaceIpc,
} from "../shared/agent-ipc";
import type {
  AgentApproveToolRequest,
  AgentPromptRequest,
  AgentRegenerateRequest,
  AgentDeleteUserMessageRequest,
  AgentRestoreBackupRequest,
  AgentSelectModePresetRequest,
  AgentStopConsultWorkerRequest,
  AgentSwitchExpertRequest,
  ArtifactPreviewRequest,
  ArtifactSurfaceBlockerRequest,
  ArtifactSurfaceBoundsRequest,
  ArtifactSurfaceVisibleRequest,
  BtwKeepaliveRequest,
  BtwPromptRequest,
  BtwStartRequest,
  BuiltinCapabilitiesConfigDto,
  BuiltinCapabilityId,
  CronJobDto,
  GatewayListMessagesRequest,
  EnhancePromptRequest,
  SpaceDto,
  SubagentConfigDto,
  SubagentConfigPatch,
  SaveBuiltinCredentialRequest,
  SaveBuiltinCapabilitySettingsRequest,
  WebSearchConfigDto,
} from "../shared/agent-ipc";
import { ArtifactDomainIpc } from "../shared/artifact-ipc";
import { ConversationRuntimeIpc } from "../shared/conversation-runtime";
import type { ConversationInteractionRespondRequest } from "../shared/conversation-interaction";
import type { ConversationGoalCreateRequest, ConversationGoalUpdateRequest } from "../shared/conversation-goal";
import { BotWorkIpc } from "../shared/bot-work-ipc";
import { createBotIpcHandler } from "./agent/work/BotCreationIpc";
import { createWorkTeamIpcHandler } from "./agent/work/WorkTeamIpc";
import type { AttestCriteriaParams, RecordUserFeedbackParams } from "../shared/bot-work";
import {
  GadgetIpc,
  type GadgetConvertFromArtifactRequest,
  type GadgetExportArtifactRequest,
  type GadgetListRequest,
  type GadgetMoveScopeRequest,
  type GadgetSaveAsBlueprintRequest,
} from "../shared/gadget-ipc";
import { BlueprintIpc, type BlueprintCaptureRequest } from "../shared/blueprint-ipc";
import type { BlueprintCreateRequest, BlueprintInstantiateRequest, BlueprintUpdateRequest } from "../shared/blueprint-types";
import type { TemplateCapabilityRegistries } from "../shared/project-template";
import type { GadgetCreateRequest, GadgetUpdateRequest, GadgetSourceUpdateRequest } from "../shared/gadget-types";
import {
  LibraryIpc,
  type LibraryCreateItemRequest,
  type LibraryCreateSpaceRequest,
  type LibraryImportFileRequest,
  type LibraryListItemsRequest,
  type LibraryRenameSpaceRequest,
  type LibraryUpdateItemRequest,
  type LibraryWriteContentRequest,
} from "../shared/library-ipc";
import { LibraryProtocol } from "./library/LibraryProtocol";
import { LibraryService } from "./library/LibraryService";
import { WorkspaceLibraryBindingService } from "./workspace/WorkspaceLibraryBindingService";
import { workspaceLibraryBindingView } from "./workspace/WorkspaceLibraryBindingView";
import { deleteEmptyWorkspace } from "./workspace/WorkspaceDeletion";
import {
  WorkspaceLibraryBindingIpc,
  type WorkspaceLibraryBindingRequest,
} from "../shared/workspace-library-binding";
import { WorkGraphService } from "./workgraph/WorkGraphService";
import {
  WorkGraphIpc,
  type WorkGraphAddEdgeRequest,
  type WorkGraphListRequest,
} from "../shared/work-graph";
import { CaptureModeEvent, CaptureModeIpc, type CaptureModeEnterRequest } from "../shared/capture-mode";
import {
  PromptContextIpc,
  type PromptContextCollectRequest,
} from "../shared/prompt-context";
import { SelectionEvent, SelectionIpc } from "../shared/selection";
import { SelectionPopover } from "./artifact/SelectionPopover";
import {
  ProfessionalToolIpc,
  isManagedToolProvider,
  type ManagedToolProviderId,
} from "../shared/professional-tools";
import { BROWSER_CAPTURE_ARTIFACT_ID, browserHost } from "./browser/BrowserHost";
import { uiAutomationService, setUiAutomationMainWindow } from "./capabilities/UiAutomationService";
import { bindBrowserBridge } from "./browser/browser-bridge";
import {
  TerminalIpc,
  type TerminalCloseRequest,
  type TerminalInputRequest,
  type TerminalOpenRequest,
  type TerminalPrepareHerdrRequest,
  type TerminalPrepareHerdrResult,
  type TerminalResizeRequest,
  type TerminalTailRequest,
} from "../shared/terminal-ipc";
import {
  PythonRuntimeIpc,
  type PreparePythonEnvironmentRequest,
  type PreparePythonEnvironmentResult,
  type PythonDiagnosticsExportResult,
  type PythonProjectBindingMutationResult,
  type PythonProjectBindingRequest,
  type PythonProjectBindingView,
} from "../shared/python-runtime";
import { getPythonRuntimeService } from "./runtime/pythonRuntimeInstance";
import { PythonProjectBindingStore } from "./runtime/PythonProjectBindingStore";
import { registerSubagentIpcHost } from "./agent/subagent-ipc-host";
import { installSubagentInvocationEnv } from "./agent/subagent-invocation-host";
import { installBuiltinSubagentIpc } from "./capabilities/builtin-subagent";
import {
  TerminalHost,
  resolveBoundWorkspaceCwd,
} from "./terminal/TerminalHost";
import { prepareHerdrWorkspace, projectMyBuddySkillsToCliRoots } from "./terminal/HerdrLauncher";
import type {
  ArtifactDomainGetRequest,
  ArtifactDomainReadContentRequest,
  ArtifactDomainRegisterRequest,
  ArtifactDomainRemoveRequest,
  ArtifactDomainTaskRequest,
} from "../shared/artifact-ipc";
import { AgentService } from "./agent/AgentService";
import { armStartupReport, onStartupReport, startupMark, startupMarkEnabled } from "./perf/startupMarks";
import { WorkNotificationHost } from "./agent/work/WorkNotificationHost";
import { publishTaskLifecycleNotification } from "./notification/TaskLifecycleNotifications";
import { createDesktopWorkChannel } from "./agent/work/WorkDesktopNotificationChannel";
import { WorkGatewayNotificationChannels } from "./agent/work/WorkGatewayNotificationChannel";
import { ExternalAgentRuntime } from "./external-agent/ExternalAgentRuntime";
import { ExternalAgentIpc, type ExternalAgentId, type ExternalAgentPromptRequest, type ExternalAgentResolvePermissionRequest, type ExternalAgentSetConfigOptionRequest } from "../shared/external-agent";
import { ConversationBranchService } from "./agent/ConversationBranchService";
import { TaskWorkspaceBrancher } from "./task/TaskWorkspaceBrancher";
import {
  ConversationBranchIpc,
  type CreateConversationBranchRequest,
} from "../shared/conversation-branch";
import {
  createArtifactDomain,
  ensureTaskLegacyMigrated,
  type LegacyArtifactSource,
} from "./artifact/ArtifactDomainSetup";
import { artifactPreviewHost } from "./artifact/ArtifactPreviewHost";
import { runtimeProbeService, type RuntimeProbeEvent } from "./capabilities/RuntimeProbeService";
import { BROWSER_CONSOLE_MAX_ENTRIES, type BrowserConsoleEntryDto, type BrowserConsoleSnapshotDto, type BrowserConsoleTarget } from "../shared/browser-console";
import { computerAutomationService } from "./capabilities/ComputerAutomationService";
import { computerUseOverlayService } from "./capabilities/ComputerUseOverlayService";
import { computerUseRunCoordinator } from "./capabilities/ComputerUseRunCoordinator";
import { ArtifactProtocol } from "./artifact/ArtifactProtocol";
import { CaptureModeController } from "./artifact/CaptureModeController";
import { NativeSurfaceCoordinator, SURFACE_MAIN } from "./artifact/NativeSurfaceCoordinator";
import { PromptContextService } from "./artifact/PromptContextService";
import { WorkspaceSharedContextService } from "./workspace/WorkspaceSharedContextService";
import { SelectionStore } from "./artifact/SelectionStore";
import { WebArtifactRuntime } from "./artifact/WebArtifactRuntime";
import { CronService } from "./cron/CronService";
import { TaskTerminalService } from "./terminal/TaskTerminalService";
import { AppDatabase } from "./db/AppDatabase";
import { GadgetRepository } from "./gadget/GadgetRepository";
import { GadgetStorage } from "./gadget/GadgetStorage";
import { GadgetRegistry } from "./gadget/GadgetRegistry";
import { GadgetRuntime } from "./gadget/GadgetRuntime";
import { GadgetService } from "./gadget/GadgetService";
import { BlueprintRepository } from "./blueprint/BlueprintRepository";
import { BlueprintResolver } from "./blueprint/BlueprintResolver";
import { BlueprintInstantiationPlanner } from "./blueprint/BlueprintInstantiationPlanner";
import { BlueprintService } from "./blueprint/BlueprintService";
import { ProjectRepository } from "./project/ProjectRepository";
import { ProjectService } from "./project/ProjectService";
import { ProjectFolderRelocation } from "./project/ProjectFolderRelocation";
import { MemoryService } from "./memory/MemoryService";
import { MemoryGatewayController } from "./memory/MemoryGatewayController";
import { ExternalCliMemoryBridge } from "./memory/ExternalCliMemoryBridge";
import { ensureExternalCliMemoryAssets } from "./memory/ExternalCliMemoryAssets";
import { MemoryGatewayIpc, type MemoryGatewayConfigureRequest, type MemoryGatewayCreateGrantRequest, type MemoryGatewayUpdateGrantRequest } from "../shared/memory-gateway";
import { MemoryOrganizationIpc } from "../shared/memory-organization";
import { MemoryIpc, type MemoryCreateRequest, type MemorySearchRequest, type MemoryScopeType, type MemoryUpdateRequest } from "../shared/memory-kernel";
import { ProjectAttentionTracker } from "./project/ProjectAttention";
import { ProjectCadence } from "./project/ProjectCadence";
import { parseProjectMessageDirective, ProjectEventIngestor, cronRunEventInput } from "./project/ProjectEventIngestor";
import { ProjectDocumentImporter } from "./project/ProjectDocumentImporter";
import { ProjectEventPromoter } from "./project/ProjectEventPromoter";
import { ProjectContextResolver } from "./project/ProjectContextResolver";
import type {
  ProjectCreateRequest,
  ProjectMemoryCreateRequest,
  ProjectMemoryDeleteRequest,
  ProjectMemoryUpdateRequest,
  ProjectResourceCreateRequest,
  ProjectResourceUpdateRequest,
  ProjectTodoCreateRequest,
  ProjectTodoUpdateRequest,
  ProjectUpdateRequest,
} from "../shared/project-domain";
import { GatewayService } from "./gateway/GatewayService";
import {
  getBlueprintWorkspaceInstancesDir,
  getGadgetsDir,
  getMyBuddyBinDir,
  getMyBuddyDir,
  getUploadsDir,
  migrateLegacyTaskWorkspacesDirs,
} from "./paths";
import { TaskExecutionWorkspaceLifecycle } from "./task/TaskExecutionWorkspaceLifecycle";
import { ArchivedContentDeletion, artifactPurgeCleanupWarning, removeManagedTaskSession } from "./task/ArchivedContentDeletion";
import { ArchivedContentDeletionIpc, TRASH_RETENTION_DAYS, TrashIpc, type ArchivedContentDeletionRequest } from "../shared/archive-deletion";
import { TaskExecutionWorkspace } from "./task/TaskExecutionWorkspace";
import { McpConfigService } from "./mcp/McpConfigService";
import { PluginStorageIpc } from "../shared/plugin-storage";
import { getPluginStorage } from "./plugins/PluginStorage";
import type { McpSaveServerRequest } from "../shared/agent-ipc";
import { ProfessionalToolRuntimeService } from "./professional-tools/ProfessionalToolRuntime";
import { TrayService } from "./TrayService";
import { applyPlatformAppIdentity, applyPlatformCommandLineSwitches, nodePlatformName } from "./platform/app";
import { applyPlatformTitleBarOverlay, applyPlatformWindowIdentity, platformWindowIconPath, platformWindowOptions } from "./platform/window-shell";
import { shouldQuitOnAllWindowsClosed, windowOpenProperties } from "./platform/lifecycle";
import { configureCrashReporting, createProcessGoneReporter, installFaultHandlers } from "./crash-reporting";
import { getRuntimeLogger } from "./runtime-logging";
import { NotificationService } from "./notification/NotificationService";
import { NotificationIpc, type NotificationListRequest } from "../shared/notification";
import {
  RemoteAccessIpc,
  type RemoteConfigureRequest,
} from "../shared/remote-access";
import { RemoteAccessController } from "./remote/RemoteAccessController";
import { detectCloudflared } from "./remote/CloudflaredCli";
import { cleanupRemoteUploads } from "./remote/RemoteTaskCommandService";
import {
  copyExternalIntoWorkspace,
  createWorkspacePath,
  listWorkspaceFiles,
  moveWorkspacePath,
  previewWorkspaceFile,
  readWorkspaceFile,
  renameWorkspacePath,
  resolveWorkspaceTarget,
} from "./workspace/WorkspaceService";

/** ProjectLibre 等占用源文件时，复制一份再拖，避免 startDrag 静默失败 */
function prepareNativeDragFile(filePath: string): string | null {
  if (!existsSync(filePath)) return null;
  try {
    const fd = openSync(filePath, "r");
    closeSync(fd);
    return filePath;
  } catch {
    try {
      const dest = join(tmpdir(), `mybuddy-drag-${Date.now()}-${basename(filePath)}`);
      copyFileSync(filePath, dest);
      return dest;
    } catch {
      return filePath;
    }
  }
}

type AppTheme = "light" | "dark";

const THEME_WINDOW_BG: Record<AppTheme, string> = {
  light: "#ffffff",
  dark: "#121212",
};

const THEME_TITLEBAR: Record<AppTheme, { color: string; symbolColor: string }> = {
  light: { color: "#ffffff", symbolColor: "#1a1a19" },
  dark: { color: "#121212", symbolColor: "#ececea" },
};

const TITLE_BAR_HEIGHT = 32;

// 产物预览自定义协议：privileges 必须在 app ready 前声明（standard 才能解析 host/相对路径）
protocol.registerSchemesAsPrivileged([
  {
    scheme: "mybuddy-artifact",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
  {
    scheme: "mybuddy-library",
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
  },
]);

// Linux 上给自己的 Electron 渲染进程打开无障碍（computer_exec 才能看到应用内控件）。
// 命令行开关必须在 app ready 之前追加；其它平台 no-op。
applyPlatformCommandLineSwitches(app);

let db: AppDatabase;
let libraryService: LibraryService;
let workspaceLibraryBindingService: WorkspaceLibraryBindingService;
let workGraphService: WorkGraphService;
let libraryProtocol: LibraryProtocol | null = null;
let projectService: ProjectService;
let projectFolderRelocation: ProjectFolderRelocation;
let attentionTracker: ProjectAttentionTracker;
let cadenceEngine: ProjectCadence;
let projectEventIngestor: ProjectEventIngestor;
let projectEventPromoter: ProjectEventPromoter;
let projectDocumentImporter: ProjectDocumentImporter;
let projectContextResolver: ProjectContextResolver;
let agentService: AgentService;
let workNotificationHost: WorkNotificationHost | null = null;
let workGatewayNotificationChannels: WorkGatewayNotificationChannels | null = null;
let externalAgentRuntime: ExternalAgentRuntime;
/** 对话分支（Branch in new task）服务 */
let conversationBranchService: ConversationBranchService;
/** 扩展栏终端宿主（按 taskId 保活 PTY；App 退出时 dispose） */
let terminalHost: TerminalHost | null = null;
let cronService: CronService;
let gatewayService: GatewayService;
let memoryGatewayController: MemoryGatewayController | null = null;
let externalCliMemoryBridge: ExternalCliMemoryBridge | null = null;
let remoteAccessController: RemoteAccessController | null = null;
let trayService: TrayService;
let notificationService: NotificationService;
let taskLifecycle: TaskExecutionWorkspaceLifecycle;
let archivedContentDeletion: ArchivedContentDeletion;
let artifactDomainService: ReturnType<typeof createArtifactDomain>["service"];
let artifactDomain: ReturnType<typeof createArtifactDomain> | null = null;
let gadgetService: GadgetService;
let blueprintService: BlueprintService;
let quitCleanupPromise: Promise<void> | null = null;
let quitCleanupComplete = false;
let selectionPopover: SelectionPopover | null = null;
let htmlEditService: HtmlEditService | null = null;
let reopenSelectionComment: (() => void) | null = null;
let perfStartupReported = false;
let botManagementWindow: BrowserWindow | null = null;

// §5-7 崩溃可观测性（必须在 app ready 前装配）：
// - crashDumps 固定到 <MyBuddyDir>/crashdumps，crashReporter 只落本地、不上传；
// - 主进程运行日志落 <MyBuddyDir>/logs/main-YYYYMMDD.log（按天/大小轮转，保留 7 份）；
// - uncaughtException / unhandledRejection 记录完整栈与进程信息后交回 Node 默认处理；
// - render/child process gone 写日志 + 用户可见通知（同类事件节流，避免崩溃循环刷屏）。
const runtimeLogger = getRuntimeLogger();
configureCrashReporting({
  app,
  crashReporter,
  logger: runtimeLogger,
  productName: "MyBuddy",
  version: app.getVersion(),
  platform: nodePlatformName(),
});
installFaultHandlers({ logger: runtimeLogger });
const reportProcessGone = createProcessGoneReporter({
  logger: runtimeLogger,
  publish: (notification) => notificationService?.publish(notification),
});

// P3-6：单实例 —— 第二个实例直接退出并聚焦/恢复主窗口（复用托盘恢复路径），
// 保证同一时刻只有一个 MyBuddy 实例写用户设置（settings.json 无跨实例合并）。
// 必须在 app ready 前尽早申请；测试/无头路径不加载本模块，不受影响。
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (trayService) {
      trayService.showMainWindow();
      return;
    }
    const win = BrowserWindow.getAllWindows()[0];
    if (win && !win.isDestroyed()) {
      if (win.isMinimized()) win.restore();
      win.show();
      win.focus();
    }
  });
}
/** Native Surface 唯一显示决策层（V3.5 Wave 4A §75）：Renderer intent → Coordinator → PreviewHost → WCV */
const surfaceCoordinator = new NativeSurfaceCoordinator();
/** Web Artifact 运行时 + 协议（V3.5 Wave 4B §17）：资源解析与协议层独立于 PreviewHost */
let artifactRuntime: WebArtifactRuntime | null = null;
let artifactProtocol: ArtifactProtocol | null = null;
/** Capture Mode 状态机（V3.5 Wave 4C §78-82）：CDP inspect → SelectionDescriptor */
let captureModeController: CaptureModeController | null = null;
/** Selection 唯一真相源（V3.5 Wave 4D §80）：active/stale/empty + stale 生命周期 */
let selectionStore: SelectionStore | null = null;
/** Prompt Context 采集（V3.5 Wave 4E §81/§82）：ACTIVE selection + Domain 内容 → 结构化 UNTRUSTED context */
let promptContextService: PromptContextService | null = null;
/** Workspace Shared Context 运行时（Phase 2B）：memories 复用 + 分层 digest 注入 prompt chain */
let workspaceSharedContextService: WorkspaceSharedContextService | null = null;
/** Legacy artifact 数据源（3B.2）：session jsonl + artifact-index.json，由 AgentService 提供 */
let artifactLegacySource: LegacyArtifactSource | null = null;
installSubagentInvocationEnv();
const mcpService = new McpConfigService();
let professionalToolService: ProfessionalToolRuntimeService;

/** 向全部窗口广播（Cockpit 任务变更即时刷新；不轮询） */
function broadcastToWindows(channel: string, payload: unknown): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(channel, payload);
  }
}

/** 业务变更 → 注意度重算（先确定性重生成 proposals 保证计数新鲜）+ 指纹去重广播；并重排时间边界 */
function notifyProjectAttention(projectId: string): void {
  try {
    projectService.generateActionProposals(projectId);
  } catch {
    /* 建议层失败不影响状态广播 */
  }
  const digest = attentionTracker?.onChange(projectId);
  if (digest) {
    broadcastToWindows(DbIpc.projectAttentionChanged, digest);
    if (digest.blockerCount > 0 || digest.atRiskCount > 0 || digest.needsConfirmation > 0) {
      const projectName = projectService?.get(projectId)?.name ?? "项目";
      const detail = [
        digest.blockerCount > 0 ? `${digest.blockerCount} 个阻塞` : "",
        digest.atRiskCount > 0 ? `${digest.atRiskCount} 个风险` : "",
        digest.needsConfirmation > 0 ? `${digest.needsConfirmation} 项待确认` : "",
      ].filter(Boolean).join(" · ");
      notificationService?.publish({
        type: "project.attention",
        level: digest.blockerCount > 0 ? "error" : "warning",
        title: "项目需要关注",
        body: `${projectName}${detail ? ` · ${detail}` : ""}`,
        sourceType: "project",
        sourceId: projectId,
        projectId,
        dedupeKey: `project:${projectId}:attention:${digest.fingerprint}`,
      });
    }
  }
  cadenceEngine?.schedule(projectId);
}

/** 刷新/崩溃恢复前收起原生叠加层，避免 WebContentsView 盖住刚重载的空白页 */
function hideNativeOverlays(): void {
  try {
    browserHost.hide();
  } catch {
    /* 宿主未挂载时忽略 */
  }
  try {
    surfaceCoordinator.close(SURFACE_MAIN);
  } catch {
    /* 协调层未就绪时忽略 */
  }
}

function applyNativeChrome(theme: AppTheme): void {
  nativeTheme.themeSource = theme;

  for (const win of BrowserWindow.getAllWindows()) {
    win.setBackgroundColor(THEME_WINDOW_BG[theme]);

    // Windows titleBarOverlay 的实时更新收在 platform/window-shell.ts；其它平台 no-op。
    const overlay = THEME_TITLEBAR[theme];
    applyPlatformTitleBarOverlay(win, {
      titleBar: { color: overlay.color, symbolColor: overlay.symbolColor, height: TITLE_BAR_HEIGHT },
    });
  }
}

function requireBrowserConsoleTarget(value: unknown): BrowserConsoleTarget {
  if (value !== "browser" && value !== "artifact") throw new Error("无效的控制台 target");
  return value;
}

function toBrowserConsoleEntry(event: RuntimeProbeEvent): BrowserConsoleEntryDto | null {
  if (event.target !== "browser" && event.target !== "artifact") return null;
  if (event.kind !== "console" && event.kind !== "runtime-error" && event.kind !== "load") return null;
  // load 生命周期中的 start/stop 属于内部诊断噪声；控制台只显示真正失败。
  if (event.kind === "load" && event.level !== "error") return null;
  return {
    sequence: event.sequence,
    timestamp: event.timestamp,
    level: event.level,
    kind: event.kind,
    message: event.message.replace(/^\[MYBUDDY_(?:RUNTIME_ERROR|UNHANDLED_REJECTION)\]\s*/, ""),
    url: event.url,
    sourceId: event.sourceId,
    line: event.line,
  };
}

function createWindow(initialTheme: AppTheme = "light"): void {
  const overlay = THEME_TITLEBAR[initialTheme];

  // 平台差异集中在 src/main/platform/window-shell.ts：图标格式 / titleBarOverlay / 任务栏身份。
  const shellOptions = {
    windowsIconPath: appIconPath,
    linuxIconPath: appPngPath,
    titleBar: { color: overlay.color, symbolColor: overlay.symbolColor, height: TITLE_BAR_HEIGHT },
    isPackaged: app.isPackaged,
    execPath: process.execPath,
    appPath: app.getAppPath(),
  };
  const windowIconPath = platformWindowIconPath(shellOptions);
  const appIcon = nativeImage.createFromPath(windowIconPath);
  const win = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: "MyBuddy",
    icon: appIcon.isEmpty() ? undefined : appIcon,
    backgroundColor: THEME_WINDOW_BG[initialTheme],
    autoHideMenuBar: true,
    // The A1 baseline needs a visible window: a hidden page never paints, so its "interactive"
    // mark would measure throttling instead of first paint.
    show: process.env.MYBUDDY_PERF_STARTUP !== "1",
    webPreferences: {
      preload: join(__dirname, "../preload/index.js"),
      sandbox: false,
      // Measurement keeps the window hidden; without this a hidden window throttles the very
      // frames the startup marks rely on.
      ...(startupMarkEnabled() ? { backgroundThrottling: false } : {}),
    },
    ...platformWindowOptions(shellOptions),
  });

  botManagementWindow = win;
  startupMark("windowCreated");
  win.once("closed", () => { if (botManagementWindow === win) botManagementWindow = null; });
  setUiAutomationMainWindow(win);
  applyPlatformWindowIdentity(win, shellOptions);

  runtimeProbeService.attach("app", win.webContents);

  win.webContents.setWindowOpenHandler(({ url }) => {
    const openSafeLocalDocument = (fileUrl: string): void => {
      try {
        const target = fileURLToPath(fileUrl);
        const safeExtensions = new Set([
          ".html", ".htm", ".pdf", ".md", ".txt", ".csv", ".json",
          ".png", ".jpg", ".jpeg", ".gif", ".webp", ".avif", ".bmp", ".ico", ".svg",
          ".docx", ".xlsx", ".pptx",
        ]);
        if (existsSync(target) && safeExtensions.has(extname(target).toLowerCase())) {
          void shell.openPath(target);
        }
      } catch (error) {
        console.warn("[WindowOpen] 无法打开本地文档链接", error);
      }
    };

    // Gadget iframe 中 Chromium 会阻止 http 页面直接打开 file://。
    // Runtime 会把显式 file 链接转成这个仅用于 window.open 的哨兵 URL；Main 再安全落到 shell.openPath。
    try {
      const parsed = new URL(url);
      if (parsed.hostname === "mybuddy-open.local" && parsed.pathname === "/open-file") {
        const target = parsed.searchParams.get("target");
        if (target && /^file:/i.test(target)) openSafeLocalDocument(target);
        return { action: "deny" };
      }
    } catch { /* non-standard URL; handled below */ }

    if (/^https?:/i.test(url)) {
      void shell.openExternal(url);
      return { action: "deny" };
    }
    if (/^file:/i.test(url)) openSafeLocalDocument(url);
    return { action: "deny" };
  });

  // 终端（xterm）：应用菜单 role 加速键（Ctrl+C/V/X/A/Z、Ctrl+R）会在浏览器进程
  // 优先消费按键，xterm 收不到 keydown → Ctrl+C(SIGINT)/PSReadLine 快捷键失效。
  // 关闭菜单快捷键抢占（菜单仍可鼠标使用）；F12 DevTools 用 before-input-event 补回。
  win.webContents.setIgnoreMenuShortcuts(true);
  win.webContents.on("before-input-event", (event, input) => {
    if (input.type === "keyDown" && input.key === "F12") {
      event.preventDefault();
      win.webContents.toggleDevTools();
    }
  });

  // 长时间运行后渲染进程可能因 OOM / GPU 复位 / 休眠被杀，窗口会留下主题底色白屏。
  // 菜单快捷键已关闭（终端抢键），用户无法 Ctrl+R；此处自动重载，并限次防止崩溃循环。
  let rendererCrashReloads = 0;

  win.webContents.on("did-finish-load", () => {
    rendererCrashReloads = 0;
    startupMark("rendererLoaded");
    win.webContents.send("theme:request");
    if (process.env.MYBUDDY_PERF_STARTUP === "1" && !perfStartupReported) {
      perfStartupReported = true;
      const payload = JSON.stringify({ processToRendererLoadedMs: process.uptime() * 1000 });
      process.stdout.write(`MYBUDDY_PERF_STARTUP:${payload}\n`, () => app.exit(0));
    }
  });

  win.webContents.on("did-fail-load", (_event, errorCode, errorDescription, validatedURL, isMainFrame) => {
    if (!isMainFrame || errorCode === -3) return; // ERR_ABORTED
    console.error("[renderer] did-fail-load", { errorCode, errorDescription, validatedURL });
    runtimeLogger.error("renderer", `did-fail-load code=${errorCode} ${errorDescription} url=${validatedURL}`);
  });

  win.webContents.on("render-process-gone", (_event, details) => {
    console.error("[renderer] render-process-gone", details);
    if (details.reason === "clean-exit") return;
    // 退出/重启流程里 renderer 会被一起结束：只记日志，不重载、不发用户通知（避免每次 stop 弹窗）。
    if (quitCleanupPromise || quitCleanupComplete) {
      runtimeLogger.warn("renderer", `render-process-gone during shutdown：reason=${details.reason} exitCode=${details.exitCode}`);
      return;
    }
    reportProcessGone("renderer", details);
    if (win.isDestroyed()) return;
    if (rendererCrashReloads >= 3) {
      console.error("[renderer] 连续崩溃，停止自动刷新。请用托盘右键「刷新」或重启应用。");
      runtimeLogger.error("renderer", `连续崩溃（已自动重载 ${rendererCrashReloads} 次），停止自动刷新：reason=${details.reason}`);
      return;
    }
    rendererCrashReloads += 1;
    hideNativeOverlays();
    setTimeout(() => {
      if (!win.isDestroyed() && !win.webContents.isDestroyed()) {
        win.webContents.reload();
      }
    }, 300);
  });

  win.on("show", () => {
    if (win.isDestroyed() || win.webContents.isDestroyed()) return;
    if (win.webContents.isCrashed()) {
      hideNativeOverlays();
      win.webContents.reload();
      return;
    }
    // 托盘隐藏很久后再显示：Windows 合成器有时丢 backing store，先强制重绘
    win.webContents.invalidate();
  });

  // 扩展栏浏览器宿主（手动浏览 / 抓取 / Penpot·Draw.io openInApp）
  browserHost.attach(win);
  uiAutomationService.setBrowserHost(browserHost);
  bindBrowserBridge(browserHost); // WebAccess/Browser 收敛 B：注入浏览器只读桥
  browserHost.onUrlChanged = (url) => {
    if (!win.isDestroyed()) win.webContents.send(BrowserIpc.urlChanged, url);
  };
  const offRuntimeConsoleEvent = runtimeProbeService.onEvent((event) => {
    const entry = toBrowserConsoleEntry(event);
    if (!entry || win.isDestroyed() || (event.target !== "browser" && event.target !== "artifact")) return;
    win.webContents.send(RuntimeConsoleIpc.event, { target: event.target, entry });
  });
  win.once("closed", offRuntimeConsoleEvent);

  // HTML 产物预览宿主：WebContentsView 叠加 + mybuddy-artifact 协议
  // Wave 4A：宿主挂载后注入 Coordinator（唯一能碰 WCV 显示状态的入口）
  artifactPreviewHost.attach(win);
  surfaceCoordinator.setHost(artifactPreviewHost);

  if (process.env.ELECTRON_RENDERER_URL) {
    win.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    win.loadFile(join(__dirname, "../renderer/index.html"));
  }

  // 系统托盘：关闭窗口 → 最小化到后台（重建窗口时先释放旧托盘）
  trayService?.dispose();
  trayService = new TrayService();
  trayService.initialize(win, { onBeforeReload: hideNativeOverlays });
  trayService.setCloseToTray(agentService.getAppSettings().closeToTray !== false);
  notificationService?.setDesktopDelivery(
    (notice) => trayService.showNotification({ title: notice.title, body: notice.body }),
    () => win.isVisible() && win.isFocused(),
  );
}

function registerIpc(): void {
  ipcMain.handle(NotificationIpc.list, (_event, request?: NotificationListRequest) => notificationService.list(request));
  ipcMain.handle(NotificationIpc.unreadCount, () => notificationService.unreadCount());
  ipcMain.handle(NotificationIpc.markRead, (_event, id: string) => notificationService.markRead(id));
  ipcMain.handle(NotificationIpc.markAllRead, () => notificationService.markAllRead());
  ipcMain.handle(NotificationIpc.dismiss, (_event, id: string) => notificationService.dismiss(id));
  ipcMain.handle(NotificationIpc.dismissAll, () => notificationService.dismissAll());
  ipcMain.handle(RemoteAccessIpc.status, () => remoteAccessController?.status());
  ipcMain.handle(RemoteAccessIpc.configure, (_event, request: RemoteConfigureRequest) => {
    if (!remoteAccessController) throw new Error("Remote Access 未初始化");
    return remoteAccessController.configure(request);
  });
  ipcMain.handle(RemoteAccessIpc.listDevices, () => remoteAccessController?.listDevices() ?? []);
  ipcMain.handle(RemoteAccessIpc.revokeDevice, (_event, id: string) => remoteAccessController?.revokeDevice(id) ?? false);
  ipcMain.handle(RemoteAccessIpc.createPairingSession, () => {
    if (!remoteAccessController) throw new Error("Remote Access 未初始化");
    return remoteAccessController.createPairingSession();
  });
  ipcMain.handle(RemoteAccessIpc.cancelPairingSession, (_event, id: string) => remoteAccessController?.cancelPairingSession(id));
  ipcMain.handle(RemoteAccessIpc.openPairWindow, () => {
    if (!remoteAccessController) throw new Error("Remote Access 未初始化");
    return remoteAccessController.openPairWindow();
  });
  ipcMain.handle(RemoteAccessIpc.closePairWindow, () => remoteAccessController?.closePairWindow());
  ipcMain.handle(RemoteAccessIpc.pairWindowState, () => remoteAccessController?.pairWindowState() ?? null);
  // 只读探测本机 cloudflared CLI（不启动隧道、不改配置）；结果用于设置页提示
  ipcMain.handle(RemoteAccessIpc.detectCloudflared, () => detectCloudflared());

  // 窗口创建前先挂上 subagent 通道，避免概览一启动 invoke 打出 No handler registered
  registerSubagentIpcHost(ipcMain);

  // Gadget / Blueprint：Renderer 只表达业务意图；组合与进程生命周期全部留在 Main。
  ipcMain.handle(GadgetIpc.create, (_event, request: GadgetCreateRequest) => gadgetService.create({
    name: request.name,
    description: request.description,
    scope: request.scope,
    type: request.type,
    entry: request.entry,
    files: request.files,
    defaultConfig: request.defaultConfig,
    metadata: request.metadata,
    // createdByTaskId / blueprintId are Main-owned provenance and are never accepted from Renderer IPC.
  }));
  ipcMain.handle(GadgetIpc.list, (_event, request?: GadgetListRequest) => gadgetService.list(request));
  ipcMain.handle(GadgetIpc.get, (_event, id: string) => gadgetService.get(id));
  ipcMain.handle(GadgetIpc.update, (_event, request: GadgetUpdateRequest) => gadgetService.update(request));
  ipcMain.handle(GadgetIpc.readSource, (_event, id: string) => gadgetService.readSource(id));
  ipcMain.handle(GadgetIpc.updateSource, (_event, request: GadgetSourceUpdateRequest) => gadgetService.updateSource(request));
  ipcMain.handle(GadgetIpc.moveScope, (_event, request: GadgetMoveScopeRequest) => gadgetService.moveScope(request.gadgetId, request.scope));
  ipcMain.handle(GadgetIpc.start, (_event, id: string) => gadgetService.start(id));
  ipcMain.handle(GadgetIpc.health, (_event, id: string) => gadgetService.health(id));
  ipcMain.handle(GadgetIpc.stop, (_event, id: string) => gadgetService.stop(id));
  ipcMain.handle(GadgetIpc.restart, (_event, id: string) => gadgetService.restart(id));
  ipcMain.handle(GadgetIpc.delete, async (_event, id: string) => { await gadgetService.delete(id); return { ok: true as const }; });
  ipcMain.handle(GadgetIpc.convertFromArtifact, (_event, request: GadgetConvertFromArtifactRequest) => gadgetService.convertFromArtifact(request));
  ipcMain.handle(GadgetIpc.exportArtifact, (_event, request: GadgetExportArtifactRequest) => gadgetService.exportArtifact(request));
  ipcMain.handle(GadgetIpc.saveAsBlueprint, (_event, request: GadgetSaveAsBlueprintRequest) => {
    const blueprint = blueprintService.captureGadget(request.gadgetId, request);
    return { blueprintId: blueprint.id };
  });

  ipcMain.handle(BlueprintIpc.create, (_event, request: BlueprintCreateRequest) => blueprintService.create(request));
  ipcMain.handle(BlueprintIpc.list, () => blueprintService.list());
  ipcMain.handle(BlueprintIpc.get, (_event, id: string) => blueprintService.get(id));
  ipcMain.handle(BlueprintIpc.update, (_event, request: BlueprintUpdateRequest) => blueprintService.update(request));
  ipcMain.handle(BlueprintIpc.resolve, (_event, id: string, registries?: TemplateCapabilityRegistries) => blueprintService.resolve(id, registries));
  ipcMain.handle(BlueprintIpc.plan, (_event, id: string, registries?: TemplateCapabilityRegistries) => blueprintService.plan(id, registries));
  ipcMain.handle(BlueprintIpc.capture, (_event, request: BlueprintCaptureRequest) =>
    blueprintService.captureDefinition(request.workspaceId, request.options, request.confirmedDefinition));
  ipcMain.handle(BlueprintIpc.previewCapture, (_event, request: BlueprintCaptureRequest) => blueprintService.previewCaptureDefinition(request.workspaceId, request.options));
  ipcMain.handle(BlueprintIpc.instantiate, (_event, request: BlueprintInstantiateRequest) => blueprintService.instantiate(request));
  ipcMain.handle(BlueprintIpc.delete, (_event, id: string) => { blueprintService.delete(id); return { ok: true as const }; });

  ipcMain.on("theme:set", (_event, theme: AppTheme) => {
    if (theme === "light" || theme === "dark") applyNativeChrome(theme);
  });

  /**
   * 渲染进程 dragstart → 原生拖出文件到资源管理器/其它应用。
   * 须在 dragstart 同步调用；files 覆盖 file。
   */
  ipcMain.on("shell:startNativeDrag", (event, payload: unknown) => {
    const raw = Array.isArray(payload)
      ? payload
      : typeof payload === "string"
        ? [payload]
        : payload &&
            typeof payload === "object" &&
            Array.isArray((payload as { files?: unknown }).files)
          ? (payload as { files: unknown[] }).files
          : [];
    const files = raw
      .map((p) => (typeof p === "string" ? p.trim() : ""))
      .filter((p) => p.length > 0)
      .map((p) => prepareNativeDragFile(p))
      .filter((p): p is string => Boolean(p));
    if (!files.length) return;
    try {
      let icon = nativeImage.createFromPath(String(trayPngPath));
      if (icon.isEmpty()) {
        icon = nativeImage.createFromPath(String(appIconPath));
      }
      if (!icon.isEmpty()) {
        const size = icon.getSize();
        if (size.width > 48 || size.height > 48) {
          icon = icon.resize({ width: 32, height: 32 });
        }
      }
      // Windows 允许空 icon；macOS 要求非空 — 兜底 1×1 透明图
      if (icon.isEmpty()) {
        icon = nativeImage.createEmpty();
      }
      event.sender.startDrag({
        file: files[0]!,
        files,
        icon,
      });
    } catch (err) {
      console.warn("[shell:startNativeDrag] failed", err);
    }
  });

  ipcMain.handle("workspace:pickLocalFile", async () => {
    const win = BrowserWindow.getFocusedWindow();
    const result = win
      ? await dialog.showOpenDialog(win, {
          properties: ["openFile"],
          filters: [
            { name: "文档与代码", extensions: ["md", "txt", "json", "py", "html", "htm", "css", "js", "ts", "tsx", "docx", "xlsx", "xls", "pptx", "pdf"] },
            { name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg"] },
            { name: "所有文件", extensions: ["*"] },
          ],
        })
      : await dialog.showOpenDialog({
          properties: ["openFile"],
          filters: [
            { name: "文档与代码", extensions: ["md", "txt", "json", "py", "html", "htm", "css", "js", "ts", "tsx", "docx", "xlsx", "xls", "pptx", "pdf"] },
            { name: "图片", extensions: ["png", "jpg", "jpeg", "gif", "webp", "svg"] },
            { name: "所有文件", extensions: ["*"] },
          ],
        });
    if (result.canceled || !result.filePaths[0]) return null;

    const filePath = result.filePaths[0];
    return previewWorkspaceFile(filePath);
  });

  /**
   * 剪贴板/拖入无磁盘 path 的文件（常见：截图 blob）落盘到 ~/.mybuddy/uploads，
   * 返回真实路径供附件芯片与 agent:prompt 使用。
   */
  ipcMain.handle(
    "workspace:saveTempFile",
    async (
      _e,
      payload: { name?: string; base64?: string; mimeType?: string } | null,
    ): Promise<{ name: string; path: string } | null> => {
      const base64 = typeof payload?.base64 === "string" ? payload.base64.trim() : "";
      if (!base64) return null;
      // 去掉 data URL 前缀（若渲染端误传整段）
      const raw = base64.includes(",") ? (base64.split(",").pop() ?? "") : base64;
      if (!raw) return null;

      let buffer: Buffer;
      try {
        buffer = Buffer.from(raw, "base64");
      } catch {
        return null;
      }
      if (!buffer.length) return null;
      // 防误传超大 payload（约 25MB）
      if (buffer.length > 25 * 1024 * 1024) return null;

      const mime = (payload?.mimeType ?? "").toLowerCase();
      const originalName = (payload?.name ?? "").trim() || "paste.bin";
      const extFromName = extname(originalName);
      const extFromMime =
        mime === "image/png"
          ? ".png"
          : mime === "image/jpeg" || mime === "image/jpg"
            ? ".jpg"
            : mime === "image/gif"
              ? ".gif"
              : mime === "image/webp"
                ? ".webp"
                : mime === "image/bmp"
                  ? ".bmp"
                  : "";
      const ext = extFromName || extFromMime || ".bin";
      const base =
        basename(originalName, extFromName)
          .replace(/[^\w.\u4e00-\u9fff-]+/g, "_")
          .slice(0, 48) || "paste";
      const fileName = `${Date.now()}-${randomUUID().slice(0, 8)}-${base}${ext}`;
      const filePath = join(getUploadsDir(), fileName);
      writeFileSync(filePath, buffer);
      return { name: `${base}${ext}`, path: filePath };
    },
  );

  ipcMain.handle("workspace:pickLocalFolder", async () => {
    const win = BrowserWindow.getFocusedWindow();
    const properties = windowOpenProperties();

    const result = win
      ? await dialog.showOpenDialog(win, {
          properties,
          title: "打开本地文件夹",
        })
      : await dialog.showOpenDialog({
          properties,
          title: "打开本地文件夹",
        });
    if (result.canceled || !result.filePaths[0]) return null;

    const folderPath = result.filePaths[0];
    return { path: folderPath, name: basename(folderPath) };
  });

  ipcMain.handle("workspace:pickZipFile", async () => {
    const win = BrowserWindow.getFocusedWindow();
    const result = win
      ? await dialog.showOpenDialog(win, {
          properties: ["openFile"],
          title: "选择 ZIP 包",
          filters: [
            { name: "ZIP 包", extensions: ["zip"] },
            { name: "所有文件", extensions: ["*"] },
          ],
        })
      : await dialog.showOpenDialog({
          properties: ["openFile"],
          title: "选择 ZIP 包",
          filters: [
            { name: "ZIP 包", extensions: ["zip"] },
            { name: "所有文件", extensions: ["*"] },
          ],
        });
    if (result.canceled || !result.filePaths[0]) return null;
    return { path: result.filePaths[0] };
  });

  ipcMain.handle("workspace:pathExists", (_event, folderPath?: string) => {
    if (!folderPath) return false;
    try {
      return existsSync(folderPath) && statSync(folderPath).isDirectory();
    } catch {
      return false;
    }
  });

  ipcMain.handle("workspace:openFolder", async (_event, folderPath?: string) => {
    const target =
      folderPath && folderPath.length > 0
        ? folderPath
        : join(app.getPath("home"), "Desktop", "mybuddy");
    const err = await shell.openPath(target);
    if (err) throw new Error(err);
  });

  ipcMain.handle("workspace:showInFolder", (_event, filePath: string) => {
    shell.showItemInFolder(filePath);
  });

  ipcMain.handle("workspace:listFiles", (_event, root: string) => listWorkspaceFiles(root));
  ipcMain.handle("workspace:readFile", (_event, root: string, relativePath: string) =>
    readWorkspaceFile(root, relativePath),
  );
  ipcMain.handle("workspace:trashPath", async (_event, root: string, relativePath: string) => {
    try {
      const target = resolveWorkspaceTarget(root, relativePath);
      if (resolveWorkspaceTarget(root, "") === target) {
        return { ok: false, error: "不能删除工作区根目录" };
      }
      await shell.trashItem(target);
      return { ok: true, relativePath };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  });
  ipcMain.handle(
    "workspace:renamePath",
    (_event, root: string, relativePath: string, newName: string) =>
      renameWorkspacePath(root, relativePath, newName),
  );
  ipcMain.handle(
    "workspace:movePath",
    (_event, root: string, fromRel: string, destDirRel: string) =>
      moveWorkspacePath(root, fromRel, destDirRel),
  );
  ipcMain.handle(
    "workspace:createPath",
    (_event, root: string, parentRel: string, name: string, kind: "file" | "folder") =>
      createWorkspacePath(root, parentRel, name, kind),
  );
  ipcMain.handle("workspace:copyIntoTask", async (_event, taskId: unknown, absPaths: unknown) => {
    const id = typeof taskId === "string" ? taskId.trim() : "";
    const paths = Array.isArray(absPaths)
      ? absPaths.filter((p): p is string => typeof p === "string" && p.trim().length > 0).map((p) => p.trim())
      : [];
    if (!id) return { ok: false as const, error: "任务无效" };
    if (!paths.length) return { ok: false as const, error: "没有可复制的文件" };
    try {
      const destRoot = agentService.resolveTaskExecutionWorkspaceCwd(id);
      const items: Array<{ source: string; relativePath: string; alreadyThere: boolean }> = [];
      for (const src of paths) {
        const result = await copyExternalIntoWorkspace(destRoot, src);
        if (!result.ok) return { ok: false as const, error: result.error };
        items.push({
          source: src,
          relativePath: result.relativePath,
          alreadyThere: result.alreadyThere,
        });
      }
      return { ok: true as const, destRoot, items };
    } catch (error) {
      return { ok: false as const, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // Agent
  ipcMain.handle(AgentIpc.prompt, async (_e, req: AgentPromptRequest) => {
    return await agentService.prompt(req);
  });
  ipcMain.handle(AgentIpc.submissionStatus, (_e, receipt: import("../shared/agent-ipc").AgentSubmissionReceipt) => agentService.submissionStatus(receipt));
  ipcMain.handle(AgentIpc.waitForSubmission, (_e, receipt: import("../shared/agent-ipc").AgentSubmissionReceipt) => agentService.waitForSubmission(receipt));
  ipcMain.handle(AgentIpc.regenerate, async (_e, req: AgentRegenerateRequest) => {
    return await agentService.regenerate(req);
  });
  ipcMain.handle(AgentIpc.deleteUserMessage, async (_e, req: AgentDeleteUserMessageRequest) => {
    await agentService.deleteUserMessage(req);
  });
  ipcMain.handle(ConversationRuntimeIpc.snapshot, (_e, taskId: string) =>
    agentService.getConversationRuntimeSnapshot(taskId));
  ipcMain.handle(ConversationRuntimeIpc.respondInteraction, (_e, req: ConversationInteractionRespondRequest) =>
    agentService.respondConversationInteraction(req.interactionId, req.answer));
  ipcMain.handle(ConversationRuntimeIpc.cancelInteraction, (_e, req: { interactionId: string }) =>
    agentService.cancelConversationInteraction(req.interactionId));
  ipcMain.handle(ConversationRuntimeIpc.createGoal, (_e, req: ConversationGoalCreateRequest) =>
    agentService.createConversationGoal(req));
  ipcMain.handle(ConversationRuntimeIpc.updateGoal, (_e, req: ConversationGoalUpdateRequest) =>
    agentService.updateConversationGoal(req));
  ipcMain.handle(ConversationRuntimeIpc.cancelGoal, (_e, goalId: string) =>
    agentService.cancelConversationGoal(goalId));

  ipcMain.handle(BotWorkIpc.decideAction, workApprovalIpcHandler({
    getMainWindow: () => botManagementWindow,
    rendererUrl: process.env.ELECTRON_RENDERER_URL ?? pathToFileURL(join(__dirname, "../renderer/index.html")).href,
    decideAction: request => agentService.decideWorkAction(request),
  }));
  ipcMain.handle(BotWorkIpc.listAutonomyRules, () => agentService.listWorkAutonomyRules());
  ipcMain.handle(BotWorkIpc.revokeAutonomyRule, (_e, ruleId: string) => agentService.revokeWorkAutonomyRule(ruleId));
  ipcMain.handle(BotWorkIpc.phase3Control, (_e, request: unknown) => agentService.phase3WorkControl(request));
  ipcMain.handle(BotWorkIpc.phase4Control, (_e, request: unknown) => agentService.phase4WorkControl(request));
  ipcMain.handle(BotWorkIpc.hostStatus, () => agentService.getWorkHostStatus());
  ipcMain.handle(BotWorkIpc.listBots, () => agentService.listBots());
  ipcMain.handle(BotWorkIpc.createBot, createBotIpcHandler({
    getMainWindow: () => botManagementWindow,
    rendererUrl: process.env.ELECTRON_RENDERER_URL ?? pathToFileURL(join(__dirname, "../renderer/index.html")).href,
    createBot: request => agentService.createBot(request),
  }));
  ipcMain.handle(BotWorkIpc.teamControl, createWorkTeamIpcHandler({
    getMainWindow: () => botManagementWindow,
    rendererUrl: process.env.ELECTRON_RENDERER_URL ?? pathToFileURL(join(__dirname, "../renderer/index.html")).href,
    control: request => agentService.teamWorkControl(request),
  }));
  ipcMain.handle(BotWorkIpc.listBotExpertVersions, (_e, botId: string) => agentService.listBotExpertVersions(botId));
  ipcMain.handle(BotWorkIpc.adoptBotExpertVersion, (_e, botId: string, expected: { pendingVersion: number; snapshotId: string }) =>
    agentService.adoptBotExpertVersion(botId, expected));
  ipcMain.handle(BotWorkIpc.syncWorks, (_e, request: unknown) => agentService.syncWorkProjections(request));
  ipcMain.handle(BotWorkIpc.sendMessage, (_e, request: unknown) => agentService.sendBotMessage(request));
  ipcMain.handle(BotWorkIpc.history, (_e, request: unknown) => agentService.botMessageHistory(request));
  ipcMain.handle(BotWorkIpc.cancelSend, (_e, botId: string, requestId: string) => agentService.cancelBotSend(botId, requestId));
  ipcMain.handle(BotWorkIpc.archiveConversation, (_e, botId: string, conversationId: string) => agentService.archiveBotConversation(botId, conversationId));
  ipcMain.handle(BotWorkIpc.listWorks, (_e, includeClosed?: boolean) => agentService.listWorkProjections(Boolean(includeClosed)));
  ipcMain.handle(BotWorkIpc.getWork, (_e, workId: string) => agentService.getWorkProjection(workId));
  ipcMain.handle(BotWorkIpc.attestCriteria, (_e, request: AttestCriteriaParams) => agentService.attestWorkCriteria(request));
  ipcMain.handle(BotWorkIpc.recordUserFeedback, (_e, request: RecordUserFeedbackParams) => agentService.recordWorkUserFeedback(request));
  ipcMain.handle(BotWorkIpc.markNotificationRead, (_e, notificationId: string) => agentService.markWorkNotificationRead(notificationId));
  ipcMain.handle(BotWorkIpc.markCardRead, (_e, request: unknown) => agentService.markWorkCardRead(request));
  ipcMain.handle(BotWorkIpc.workSummary, (_e, workId: string) => agentService.getWorkSummary(workId));
  ipcMain.handle(BotWorkIpc.workDiagnostics, (_e, request: unknown) => agentService.getWorkDiagnostics(request));
  ipcMain.handle(BotWorkIpc.resendNotification, (_e, request: unknown) => agentService.resendWorkNotification(request));
  ipcMain.handle(BotWorkIpc.reviewControl, (_e, request: unknown) => agentService.reviewWork(request));

  // BTW（临时上下文分支）：瞬时会话，与 Task Registry / agent:event 完全隔离
  ipcMain.handle(BtwIpc.start, async (_e, req: BtwStartRequest) => {
    await agentService.startBtw(req);
  });
  ipcMain.handle(BtwIpc.prompt, async (_e, req: BtwPromptRequest) => {
    await agentService.btwPrompt(req);
  });
  ipcMain.handle(BtwIpc.abort, async (_e, btwId: string) => {
    await agentService.btwAbort(btwId);
  });
  ipcMain.handle(BtwIpc.close, async (_e, btwId: string) => {
    await agentService.btwClose(btwId);
  });
  ipcMain.handle(BtwIpc.keepalive, (_e, req: BtwKeepaliveRequest) => {
    agentService.btwKeepalive(req.btwIds);
  });

  // Prompt Enhance（Instruction Enhancement）：瞬时而独立的单轮文本改写，与任务管道/BTW 完全隔离
  ipcMain.handle(EnhanceIpc.prompt, async (_e, req: EnhancePromptRequest) => {
    // 轻量校验（与 AgentService.enhancePrompt 内部校验一致）：
    // - surface 必填，只允许 new-task | chat；
    // - chat 必须带有效 taskId；new-task 不应带 taskId（带了直接抛错）；
    // - input trim 后非空且 ≤ 20000 字符。
    if (req.surface !== "chat" && req.surface !== "new-task") {
      throw new Error(`未知的 enhance surface：${req.surface}`);
    }
    const surface = req.surface;
    if (surface === "chat" && !req.taskId?.trim()) {
      throw new Error("chat surface 需要有效 taskId");
    }
    if (surface === "new-task" && req.taskId) {
      throw new Error("new-task surface 不应携带 taskId");
    }
    const input = req.input?.trim() ?? "";
    if (!input) {
      throw new Error("提示词增强需要非空输入");
    }
    if (input.length > 20_000) {
      throw new Error("输入过长（上限 20000 字符）");
    }
    // expertId 仅接受非空短字符串（new-task 显式 Expert id；chat 忽略此字段）
    if (
      req.expertId != null &&
      (typeof req.expertId !== "string" || req.expertId.trim().length === 0 || req.expertId.length > 200)
    ) {
      throw new Error("expertId 非法");
    }
    return await agentService.enhancePrompt({ ...req, surface, input });
  });
  ipcMain.handle(AgentIpc.compact, (_e, taskId: string) => agentService.compactTask(taskId));
  ipcMain.handle(AgentIpc.abortCompaction, (_e, taskId: string) => agentService.abortCompaction(taskId));
  ipcMain.handle(AgentIpc.getCompactionStatus, (_e, taskId: string) => agentService.getCompactionStatus(taskId));
  ipcMain.handle(AgentIpc.abort, async (_e, taskId: string) => {
    await agentService.abort(taskId);
  });
  ipcMain.handle(AgentIpc.approveTool, (_e, req: AgentApproveToolRequest) => {
    const result = agentService.approveTool(req);
    notificationService.markReadByDedupeKey(`task:${req.taskId}:tool:${req.toolCallId}:action`);
    return result;
  });
  // 单个会诊参与者的直接终结：不结束整场会诊，其它模型继续。
  ipcMain.handle(AgentIpc.stopConsultWorker, (_e, req: AgentStopConsultWorkerRequest) =>
    agentService.stopConsultWorker(req),
  );
  ipcMain.handle(AgentIpc.setPermissionMode, (_e, req) => {
    return agentService.setPermissionMode(req);
  });
  ipcMain.handle(AgentIpc.listBackups, (_e, taskId?: string) => agentService.listBackups(taskId));
  ipcMain.handle(AgentIpc.restoreBackup, (_e, req: AgentRestoreBackupRequest) =>
    agentService.restoreBackup(req),
  );
  // Tag/preset 被选择：立即触发 required-runtime prewarm（不等发送消息）
  ipcMain.handle(
    AgentIpc.selectModePreset,
    (_e, req: AgentSelectModePresetRequest) => {
      agentService.onModePresetSelected(req.welcomeMode, req.modePresetId);
    },
  );
  ipcMain.handle(AgentIpc.getRuntimeRequirementStates, () => agentService.listRuntimeRequirementStates());
  ipcMain.handle(AgentIpc.startRuntimeRequirement, (_e, providerId: string) => {
    agentService.startRuntimeRequirement(providerId);
  });
  ipcMain.handle(AgentIpc.stopRuntimeRequirement, (_e, providerId: string) =>
    agentService.stopRuntimeRequirement(providerId),
  );
  ipcMain.handle(AgentIpc.restartRuntimeRequirement, (_e, providerId: string) =>
    agentService.restartRuntimeRequirement(providerId),
  );
  ipcMain.handle(AgentIpc.listModels, async () => agentService.listModels());
  ipcMain.handle(AgentIpc.listSkills, (_e, cwd?: string) => agentService.listSkills(cwd));
  ipcMain.handle(AgentIpc.listMarketSkills, (_e, cwd?: string) => agentService.listMarketSkills(cwd));
  ipcMain.handle(AgentIpc.installSkill, (_e, id: string) => agentService.installSkill(id));
  ipcMain.handle(AgentIpc.installSkillByPath, (_e, path: string) =>
    agentService.installSkillByPath(path),
  );
  ipcMain.handle(AgentIpc.authorSkill, (_e, input) => agentService.authorSkill(input));
  ipcMain.handle(AgentIpc.generateSkillAuthoringDraft, (_e, input) => agentService.generateSkillAuthoringDraft(input));
  ipcMain.handle(AgentIpc.generateExpertAuthoringDraft, (_e, input) => agentService.generateExpertAuthoringDraft(input));
  ipcMain.handle(AgentIpc.runSkillEvals, (_e, input) => agentService.runSkillEvals(input));
  ipcMain.handle(AgentIpc.getSkillDetail, (_e, skillId: string) => agentService.getSkillDetail(skillId));
  ipcMain.handle(AgentIpc.generateSkillImprovementDraft, (_e, input) => agentService.generateSkillImprovementDraft(input));
  ipcMain.handle(AgentIpc.applySkillImprovement, (_e, input) => agentService.applySkillImprovement(input));
  ipcMain.handle(AgentIpc.validateSkillPackage, (_e, path: string) =>
    agentService.validateSkillPackage(path),
  );
  ipcMain.handle(AgentIpc.uninstallSkill, (_e, id: string) => {
    agentService.uninstallSkill(id);
  });
  ipcMain.handle(AgentIpc.deleteMarketSkill, (_e, id: string) => {
    try {
      agentService.deleteMarketSkill(id);
    } catch (err) {
      console.error("[deleteMarketSkill]", err);
      throw err instanceof Error ? err : new Error(String(err));
    }
  });
  ipcMain.handle(AgentIpc.setSkillEnabled, (_e, id: string, enabled: boolean) =>
    agentService.setSkillEnabled(id, enabled),
  );
  ipcMain.handle(AgentIpc.listExperts, () => agentService.listExperts());
  ipcMain.handle(AgentIpc.listMarketExperts, () => agentService.listMarketExperts());
  ipcMain.handle(AgentIpc.listExpertPrivateSkills, (_e, expertId: string) =>
    agentService.listExpertPrivateSkills(expertId),
  );
  ipcMain.handle(AgentIpc.installExpert, (_e, id: string) => agentService.installExpert(id));
  ipcMain.handle(AgentIpc.installExpertByPath, (_e, path: string) =>
    agentService.installExpertByPath(path),
  );
  ipcMain.handle(AgentIpc.authorExpert, (_e, input) => agentService.authorExpert(input));
  ipcMain.handle(AgentIpc.getExpertDetail, (_e, id: string) => agentService.getExpertDetail(id));
  ipcMain.handle(AgentIpc.updateExpert, (_e, input) => agentService.updateExpert(input));
  ipcMain.handle(AgentIpc.getTaskExpertBinding, (_e, taskId: string) => agentService.getTaskExpertBinding(taskId));
  ipcMain.handle(AgentIpc.saveTaskExpertBinding, (_e, input) => agentService.saveTaskExpertBinding(input));
  ipcMain.handle(AgentIpc.cancelExpertAuthoring, (_e, requestId: string) => agentService.cancelExpertAuthoring(requestId));
  ipcMain.handle(AgentIpc.importExpertZip, (_e, zipPath: string) =>
    agentService.importExpertZip(zipPath),
  );
  ipcMain.handle(AgentIpc.exportExpert, (_e, id: string) => agentService.exportExpert(id));
  ipcMain.handle(AgentIpc.uninstallExpert, (_e, id: string) => {
    agentService.uninstallExpert(id);
  });
  ipcMain.handle(AgentIpc.deleteMarketExpert, (_e, id: string) => {
    try {
      agentService.deleteMarketExpert(id);
    } catch (err) {
      console.error("[deleteMarketExpert]", err);
      throw err instanceof Error ? err : new Error(String(err));
    }
  });
  ipcMain.handle(AgentIpc.setExpertEnabled, (_e, id: string, enabled: boolean) =>
    agentService.setExpertEnabled(id, enabled),
  );
  ipcMain.handle(AgentIpc.switchExpert, async (_e, req: AgentSwitchExpertRequest) => {
    await agentService.switchExpert(req);
  });
  ipcMain.handle(AgentIpc.listConnectors, () => agentService.listConnectors());
  ipcMain.handle(AgentIpc.installConnector, (_e, id: string) =>
    agentService.installConnector(id),
  );
  ipcMain.handle(AgentIpc.importConnectorByPath, (_e, path: string) =>
    agentService.importConnectorByPath(path),
  );
  ipcMain.handle(AgentIpc.importConnectorZip, (_e, zipPath: string) =>
    agentService.importConnectorZip(zipPath),
  );
  ipcMain.handle(AgentIpc.setConnectorEnabled, (_e, id: string, enabled: boolean) =>
    agentService.setConnectorEnabled(id, enabled),
  );
  ipcMain.handle(AgentIpc.setTaskConnectorIds, (_e, taskId: string, ids: string[]) =>
    agentService.setTaskConnectorIds(taskId, ids),
  );
  ipcMain.handle(AgentIpc.clearTaskConnectorIds, (_e, taskId: string) =>
    agentService.clearTaskConnectorIds(taskId),
  );
  ipcMain.handle(AgentIpc.uninstallConnector, (_e, id: string) => {
    agentService.uninstallConnector(id);
  });
  ipcMain.handle(AgentIpc.deleteMarketConnector, (_e, id: string) => {
    try {
      agentService.deleteMarketConnector(id);
    } catch (err) {
      console.error("[deleteMarketConnector]", err);
      throw err instanceof Error ? err : new Error(String(err));
    }
  });
  ipcMain.handle(AgentIpc.reloadModels, async (_e, providerId?: string) =>
    agentService.reloadModels(typeof providerId === "string" ? providerId : undefined),
  );
  ipcMain.handle(AgentIpc.getModelsPath, () => agentService.getModelsFilePath());
  ipcMain.handle(AgentIpc.getModelsConfig, () => agentService.getModelsConfig());
  ipcMain.handle(AgentIpc.saveModelsConfig, async (_e, config) =>
    agentService.saveModelsConfig(config),
  );
  ipcMain.handle(AgentIpc.getAppSettings, () => agentService.getAppSettings());
  ipcMain.handle(AgentIpc.updateAppSettings, async (_e, partial) => {
    const {
      memoryGatewayEnabled, memoryGatewayWriteEnabled, memoryGatewayPort,
      remoteAccessEnabled, remoteAccessPort, remoteAccessBaseUrl,
      ...ordinary
    } = partial;
    const hasGatewayChange = memoryGatewayEnabled !== undefined || memoryGatewayWriteEnabled !== undefined || memoryGatewayPort !== undefined;
    if (hasGatewayChange) {
      if (!memoryGatewayController) throw new Error("Memory Gateway 未初始化");
      await memoryGatewayController.configure({
        enabled: memoryGatewayEnabled,
        writeEnabled: memoryGatewayWriteEnabled,
        port: memoryGatewayPort,
      });
    }
    const hasRemoteChange = remoteAccessEnabled !== undefined || remoteAccessPort !== undefined || remoteAccessBaseUrl !== undefined;
    if (hasRemoteChange) {
      if (!remoteAccessController) throw new Error("Remote Access 未初始化");
      await remoteAccessController.configure({ enabled: remoteAccessEnabled, port: remoteAccessPort, baseUrl: remoteAccessBaseUrl });
    }
    const next = await agentService.updateAppSettings(ordinary);
    // 关闭到托盘开关实时生效
    trayService?.setCloseToTray(next.closeToTray !== false);
    return next;
  });
  ipcMain.handle(MemoryGatewayIpc.status, () => {
    if (!memoryGatewayController) throw new Error("Memory Gateway 未初始化");
    return memoryGatewayController.status();
  });
  ipcMain.handle(MemoryGatewayIpc.configure, async (_e, request: MemoryGatewayConfigureRequest) => {
    if (!memoryGatewayController) throw new Error("Memory Gateway 未初始化");
    return memoryGatewayController.configure(request);
  });
  ipcMain.handle(MemoryGatewayIpc.listGrants, () => memoryGatewayController?.listGrants() ?? []);
  ipcMain.handle(MemoryGatewayIpc.createGrant, (_e, request: MemoryGatewayCreateGrantRequest) => {
    if (!memoryGatewayController) throw new Error("Memory Gateway 未初始化");
    return memoryGatewayController.createGrant(request);
  });
  ipcMain.handle(MemoryGatewayIpc.updateGrant, (_e, request: MemoryGatewayUpdateGrantRequest) => {
    if (!memoryGatewayController) throw new Error("Memory Gateway 未初始化");
    return memoryGatewayController.updateGrant(request);
  });
  ipcMain.handle(MemoryGatewayIpc.rotateGrant, (_e, id: string) => {
    if (!memoryGatewayController) throw new Error("Memory Gateway 未初始化");
    return memoryGatewayController.rotateGrant(id);
  });
  ipcMain.handle(MemoryGatewayIpc.deleteGrant, (_e, id: string) => {
    if (!memoryGatewayController) throw new Error("Memory Gateway 未初始化");
    memoryGatewayController.deleteGrant(id);
  });
  ipcMain.handle(AgentIpc.getDiskSpace, () => agentService.getDiskSpace());
  ipcMain.handle(AgentIpc.listUserFonts, () => agentService.listUserFonts());
  ipcMain.handle(AgentIpc.listSystemFonts, () => agentService.listSystemFonts());
  /** 无 path 时弹原生对话框；有 path 时直接导入（渲染进程 file input + getPathForFile） */
  ipcMain.handle(AgentIpc.importUserFont, async (event, sourcePath?: string) => {
    let filePath = typeof sourcePath === "string" ? sourcePath.trim() : "";
    if (!filePath) {
      const win =
        BrowserWindow.fromWebContents(event.sender) ??
        BrowserWindow.getFocusedWindow() ??
        BrowserWindow.getAllWindows()[0];
      const opts: Electron.OpenDialogOptions = {
        properties: ["openFile"],
        title: "导入字体文件",
        filters: [
          { name: "字体文件", extensions: ["ttf", "otf", "woff", "woff2"] },
          { name: "所有文件", extensions: ["*"] },
        ],
      };
      const result = win
        ? await dialog.showOpenDialog(win, opts)
        : await dialog.showOpenDialog(opts);
      if (result.canceled || !result.filePaths[0]) return null;
      filePath = result.filePaths[0];
    }
    return agentService.importUserFontFromPath(filePath);
  });
  ipcMain.handle(AgentIpc.removeUserFont, (_e, id: string) => agentService.removeUserFont(id));
  ipcMain.handle(AgentIpc.readUserFont, (_e, id: string) => agentService.readUserFont(id));
  ipcMain.handle(AgentIpc.openFontsDir, () => agentService.openFontsDir());
  ipcMain.handle(AgentIpc.getWebSearchConfig, () => agentService.getWebSearchConfig());
  ipcMain.handle(AgentIpc.saveWebSearchConfig, (_e, config: WebSearchConfigDto) =>
    agentService.saveWebSearchConfig(config),
  );
  ipcMain.handle(AgentIpc.getSearchProviderUsage, (_e, provider: string, keys: string[]) =>
    agentService.getSearchProviderUsage(provider, keys),
  );
  ipcMain.handle(AgentIpc.getBuiltinCapabilities, () => agentService.getBuiltinCapabilities());
  ipcMain.handle(AgentIpc.refreshBuiltinMediaServices, () => agentService.refreshBuiltinMediaServices());
  ipcMain.handle(AgentIpc.listBuiltinVideoJobs, (_e, taskId?: string) => agentService.listBuiltinVideoJobs(taskId));
  ipcMain.handle(AgentIpc.saveBuiltinCapabilitySettings, (_e, request: SaveBuiltinCapabilitySettingsRequest) =>
    agentService.saveBuiltinCapabilitySettings(request),
  );
  ipcMain.handle(AgentIpc.saveBuiltinCapabilities, (_e, config: BuiltinCapabilitiesConfigDto) =>
    agentService.saveBuiltinCapabilities(config),
  );
  ipcMain.handle(AgentIpc.saveBuiltinCredential, (_e, request: SaveBuiltinCredentialRequest) =>
    agentService.saveBuiltinCredential(request),
  );
  ipcMain.handle(AgentIpc.testBuiltinCapability, (_e, id: BuiltinCapabilityId) =>
    agentService.testBuiltinCapability(id),
  );
  ipcMain.handle(AgentIpc.getSubagentConfig, () => agentService.getSubagentConfig());
  ipcMain.handle(AgentIpc.saveSubagentConfig, (_e, config: SubagentConfigPatch) =>
    agentService.saveSubagentConfig(config),
  );
  ipcMain.handle(AgentIpc.getContextUsage, (_e, taskId: string) =>
    agentService.getContextUsage(taskId),
  );
  // 用量统计（账户面板）：主进程 usage_events 事实表查询
  const clampRange = (rangeDays: number): number => Math.max(1, Math.min(3650, Math.round(rangeDays) || 7));
  ipcMain.handle(UsageIpc.summary, (_e, rangeDays: number) =>
    agentService.usageStats.summarize(clampRange(rangeDays)),
  );
  ipcMain.handle(UsageIpc.drilldown, (_e, rangeDays: number) =>
    agentService.usageStats.drilldown(clampRange(rangeDays)),
  );
  ipcMain.handle(UsageIpc.trend, (_e, rangeDays: number) =>
    agentService.usageStats.trend(clampRange(rangeDays)),
  );
  ipcMain.handle(UsageIpc.heatmap, (_e, year: number) =>
    agentService.usageStats.heatmap(Number.isFinite(year) ? year : new Date().getFullYear()),
  );
  ipcMain.handle(UsageIpc.monthly, () => agentService.usageStats.monthly());
  ipcMain.handle(UsageIpc.exportCsv, (_e, rangeDays: number) =>
    agentService.usageStats.exportCsv(clampRange(rangeDays)),
  );
  ipcMain.handle(UsageIpc.dashboard, (_e, rangeDays: number) =>
    agentService.usageStats.dashboard(clampRange(rangeDays)),
  );
  ipcMain.handle(AgentIpc.loadTaskHistory, async (_e, taskId: string, beforeEntryId?: number) => {
    const [nativeHistory, externalHistory] = await Promise.all([
      agentService.loadTaskHistory(taskId, beforeEntryId),
      Promise.resolve(externalAgentRuntime?.history(taskId) ?? { messages: [], runs: [] }),
    ]);
    if (!externalHistory.messages.length) return nativeHistory;
    return {
      ...nativeHistory,
      messages: [...nativeHistory.messages, ...externalHistory.messages]
        .sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id)),
    };
  });
  ipcMain.handle(AgentIpc.listLoginProviders, () => agentService.listLoginProviders());
  ipcMain.handle(AgentIpc.setProviderEnabled, (_e, providerId: string, enabled: boolean) =>
    agentService.setProviderEnabled(providerId, enabled),
  );
  ipcMain.handle(AgentIpc.listCredentials, () => agentService.listCredentials());
  ipcMain.handle(AgentIpc.login, (_e, req) => agentService.login(req));
  ipcMain.handle(AgentIpc.logout, (_e, providerId: string) => agentService.logout(providerId));
  ipcMain.handle(AgentIpc.authRespond, (_e, requestId: string, value: string) =>
    agentService.authRespond(requestId, value),
  );
  ipcMain.handle(AgentIpc.authCancel, (_e, requestId?: string) => {
    agentService.authCancel(requestId);
  });
  ipcMain.handle(AgentIpc.getAuthPath, () => agentService.getAuthFilePath());
  ipcMain.handle(AgentIpc.listModeProfiles, () => agentService.listModeProfiles());
  ipcMain.handle(AgentIpc.getModeProfile, (_e, id) => agentService.getModeProfile(id));
  ipcMain.handle(AgentIpc.saveModeBlock, (_e, id, blockId, content) =>
    agentService.saveModeBlock(id, blockId, content),
  );
  ipcMain.handle(AgentIpc.saveModePolicy, (_e, id, policy) =>
    agentService.saveModePolicy(id, policy),
  );
  ipcMain.handle(AgentIpc.resetModeBlock, (_e, id, blockId) =>
    agentService.resetModeBlock(id, blockId),
  );
  ipcMain.handle(AgentIpc.resetModePolicy, (_e, id) => agentService.resetModePolicy(id));
  ipcMain.handle(AgentIpc.resetModeProfile, (_e, id) => agentService.resetModeProfile(id));
  ipcMain.handle(AgentIpc.openModesDir, (_e, id?) => agentService.openModesDir(id));
  ipcMain.handle(AgentIpc.openModeFile, (_e, id, target) => agentService.openModeFile(id, target));
  ipcMain.handle(AgentIpc.assembleModePreview, (_e, req) => agentService.assembleModePreview(req));
  ipcMain.handle(AgentIpc.inspectRuntimeContext, (_e, taskId: string) =>
    agentService.inspectRuntimeContext(taskId),
  );
  ipcMain.handle(AgentIpc.getTaskDiagnostics, (_e, taskId: string, limit?: number, offset?: number) =>
    agentService.getTaskDiagnostics(taskId, limit, offset),
  );
  ipcMain.handle(AgentIpc.listAgentLoadoutObservations, (_e, taskId: string, limit?: number) =>
    agentService.listAgentLoadoutObservations(taskId, limit),
  );
  ipcMain.handle(AgentIpc.listRuntimeContextSnapshots, (_e, taskId: string, limit?: number) =>
    agentService.listRuntimeContextSnapshots(taskId, limit),
  );
  ipcMain.handle(AgentIpc.clearRuntimeContextSnapshots, (_e, taskId?: string) =>
    agentService.clearRuntimeContextSnapshots(taskId),
  );
  ipcMain.handle(AgentIpc.clearRuntimeAudit, (_e, taskId?: string) =>
    agentService.clearRuntimeAudit(taskId),
  );

  // DB
  ipcMain.handle(DbIpc.listSpaces, () => db.listSpaces());
  // Renderer 只接收正常/显式归档任务；安全回收（trashed）任务保留在 DB 至 purge，但不应重启后“复活”。
  ipcMain.handle(DbIpc.listTasks, () => db.listNonTrashedTasks());
  ipcMain.handle(DbIpc.listProjects, (_e, includeArchived?: boolean) =>
    projectService.list(includeArchived === true),
  );
  ipcMain.handle(DbIpc.getProject, (_e, id: string) => projectService.get(id));
  ipcMain.handle(DbIpc.createProject, (_e, request: ProjectCreateRequest) => {
    try {
      return { ok: true as const, project: projectService.create(request) };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle(DbIpc.updateProject, (_e, request: ProjectUpdateRequest) => {
    try {
      const result = { ok: true as const, project: projectService.update(request) };
      notifyProjectAttention(request.id);
      return result;
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle(DbIpc.duplicateProject, (_e, request: import("../shared/project-domain").ProjectDuplicateRequest) => {
    try {
      return { ok: true as const, project: projectService.duplicate(request) };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle(DbIpc.archiveProject, (_e, id: string, archived: boolean) => {
    try {
      const project = projectService.archive(id, archived);
      if (archived) cronService.disableProject(id);
      return { ok: true as const, project };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle(DbIpc.deleteProject, (_e, id: string) => {
    // 项目删除语义：级联删除该项目资料库空间（集合/条目/版本/引用/受管文件）；personal 不受影响
    libraryService.deleteProjectLibrary(id);
    cadenceEngine?.cancel(id);
    cronService.removeProject(id);
    projectService.delete(id);
    try { workGraphService.cleanupByNode("project", id); } catch {}
    // plan nodes are project_todos; their edges cascade via project delete cleanup of project_todos rows
    try {
      const conn: unknown = (db as unknown as { connection: { prepare: (sql: string) => { all: (...a: unknown[]) => Array<{ id: string }> } } }).connection;
      // Best-effort: also remove orphan plan/artifact edges if any remain referencing deleted todos
      void conn;
    } catch {}
  });

  const libraryResult = <T,>(fn: () => T): { ok: true; value: T } | { ok: false; error: string } => {
    try {
      return { ok: true, value: fn() };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : String(err) };
    }
  };
  ipcMain.handle(LibraryIpc.snapshot, () => libraryService.snapshot());
  ipcMain.handle(LibraryIpc.listItems, (_e, req: LibraryListItemsRequest) =>
    libraryService.listItems(req.spaceId, req.collectionId),
  );
  ipcMain.handle(LibraryIpc.getItem, (_e, id: string) => libraryService.getItem(id));
  ipcMain.handle(LibraryIpc.createSpace, (_e, req: LibraryCreateSpaceRequest) =>
    libraryResult(() => libraryService.createSpace(req)),
  );
  ipcMain.handle(LibraryIpc.ensureOwnedSpace, (_e, owner: import("../shared/library-ipc").LibraryOwnerScope) =>
    libraryResult(() => libraryService.ensureOwnedSpace(owner)),
  );
  ipcMain.handle(LibraryIpc.renameSpace, (_e, req: LibraryRenameSpaceRequest) =>
    libraryResult(() => libraryService.renameSpace(req.id, req.name)),
  );
  ipcMain.handle(LibraryIpc.deleteSpace, (_e, id: string) => libraryResult(() => libraryService.deleteSpace(id)));
  ipcMain.handle(LibraryIpc.createCollection, (_e, req: import("../shared/library-ipc").LibraryCreateCollectionRequest) =>
    libraryResult(() => libraryService.createCollection(req)),
  );
  ipcMain.handle(LibraryIpc.renameCollection, (_e, req: import("../shared/library-ipc").LibraryRenameCollectionRequest) =>
    libraryResult(() => libraryService.renameCollection(req)),
  );
  ipcMain.handle(LibraryIpc.moveCollection, (_e, req: import("../shared/library-ipc").LibraryMoveCollectionRequest) =>
    libraryResult(() => libraryService.moveCollection(req)),
  );
  ipcMain.handle(LibraryIpc.deleteCollection, (_e, id: string) =>
    libraryResult(() => libraryService.deleteCollection(id)),
  );
  ipcMain.handle(LibraryIpc.createItem, (_e, req: LibraryCreateItemRequest) =>
    libraryResult(() => libraryService.createItem(req)),
  );
  ipcMain.handle(LibraryIpc.updateItem, (_e, req: LibraryUpdateItemRequest) =>
    libraryResult(() => libraryService.updateItem(req)),
  );
  ipcMain.handle(LibraryIpc.deleteItem, (_e, id: string) => libraryResult(() => libraryService.deleteItem(id)));
  ipcMain.handle(LibraryIpc.readContent, (_e, id: string) => libraryResult(() => libraryService.readContent(id)));
  ipcMain.handle(LibraryIpc.writeContent, (_e, req: LibraryWriteContentRequest) =>
    libraryResult(() => libraryService.writeContent(req)),
  );
  ipcMain.handle(LibraryIpc.importFile, (_e, req: LibraryImportFileRequest) =>
    libraryResult(() => libraryService.importFile(req)),
  );
  ipcMain.handle(LibraryIpc.pickAndImport, async (_e, req: { spaceId: string; collectionId?: string | null }) => {
    const win = BrowserWindow.getFocusedWindow();
    const pickOpts = {
      properties: ["openFile", "multiSelections"] as Array<"openFile" | "multiSelections">,
      filters: [
        { name: "资料库文件", extensions: ["md", "html", "htm", "csv", "txt", "docx", "xlsx", "pptx", "pdf", "png", "jpg", "jpeg", "webp", "svg"] },
        { name: "所有文件", extensions: ["*"] },
      ],
    };
    const result = win
      ? await dialog.showOpenDialog(win, pickOpts)
      : await dialog.showOpenDialog(pickOpts);
    if (result.canceled || result.filePaths.length === 0) return { ok: true as const, value: [] as import("../shared/library-ipc").LibraryItemDto[] };
    try {
      const items = result.filePaths.map((sourcePath) =>
        libraryService.importFile({ spaceId: req.spaceId, collectionId: req.collectionId, sourcePath }),
      );
      return { ok: true as const, value: items };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle(LibraryIpc.markVisited, (_e, id: string) => libraryResult(() => libraryService.markVisited(id)));
  ipcMain.handle(LibraryIpc.search, (_e, req: import("../shared/library-ipc").LibrarySearchRequest) =>
    req.owner ? libraryService.searchOwnedScope(req.query, req.owner, req.reference) : libraryService.search(req.query),
  );
  ipcMain.handle(LibraryIpc.previewUrl, (_e, id: string) => libraryService.previewUrl(id));
  ipcMain.handle(LibraryIpc.showInFolder, (_e, id: string) => {
    try {
      const path = libraryService.showInFolder(id);
      shell.showItemInFolder(path);
      return { ok: true as const };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle(LibraryIpc.createUrl, (_e, req: import("../shared/library-ipc").LibraryCreateUrlRequest) =>
    libraryResult(() => libraryService.createUrl(req)),
  );
  ipcMain.handle(LibraryIpc.saveArtifact, (_e, req: import("../shared/library-ipc").LibrarySaveArtifactRequest) =>
    libraryResult(() => libraryService.saveArtifact(req)),
  );
  ipcMain.handle(LibraryIpc.favorite, (_e, req: import("../shared/library-ipc").LibraryFavoriteRequest) =>
    libraryResult(() => libraryService.favorite(req)),
  );
  ipcMain.handle(LibraryIpc.attachToTask, (_e, req: import("../shared/library-ipc").LibraryAttachRequest) =>
    libraryResult(() => libraryService.attachToTask(req)),
  );
  ipcMain.handle(LibraryIpc.detachFromTask, (_e, req: import("../shared/library-ipc").LibraryDetachRequest) =>
    libraryResult(() => libraryService.detachFromTask(req)),
  );
  ipcMain.handle(LibraryIpc.listTaskReferences, (_e, taskId: string) =>
    libraryResult(() => libraryService.listTaskReferences(taskId)),
  );

  /* ---------------- Workspace ↔ Library binding（Space / Collection） ---------------- */

  const projectNotes = new ProjectNotesService(db);
  ipcMain.handle(ProjectNotesIpc.read, (_e, projectId: string) => projectNotes.read(projectId));
  ipcMain.handle(ProjectNotesIpc.save, (_e, request: ProjectNoteSaveRequest) => projectNotes.save(request));
  const workspaceNotes = new WorkspaceNotesService(db);
  ipcMain.handle(WorkspaceNotesIpc.read, (_e, workspaceId: string) => workspaceNotes.read(workspaceId));
  ipcMain.handle(WorkspaceNotesIpc.save, (_e, request: import("../shared/workspace-notes").WorkspaceNoteSaveRequest) => workspaceNotes.save(request));

  const workspaceLibraryBindingList = (workspaceId: string) =>
    workspaceLibraryBindingView(db, libraryService, workspaceLibraryBindingService, workspaceId);

  ipcMain.handle(WorkspaceLibraryBindingIpc.list, (_e, workspaceId: string) =>
    workspaceLibraryBindingList(workspaceId),
  );

  ipcMain.handle(WorkspaceLibraryBindingIpc.createFolder, (_e, req: { workspaceId: string; librarySpaceId: string; name: string }) =>
    libraryResult(() => db.connection.transaction(() => {
      const workspace = db.getSpace(req.workspaceId);
      if (!workspace) throw new Error("工作空间不存在");
      if (workspace.archived || workspace.effectiveArchived) throw new Error("归档工作空间只可读取资料");
      if (!req.name?.trim()) throw new Error("文件夹名称不能为空");
      if (libraryService.getSpace(req.librarySpaceId)?.workspaceId !== workspace.id) throw new Error("请在当前工作空间的自有资料中新建文件夹");
      const folder = libraryService.createCollection({ spaceId: req.librarySpaceId, name: req.name.trim() });
      workspaceLibraryBindingService.bindCollection(req.workspaceId, req.librarySpaceId, folder.id);
    })()),
  );

  ipcMain.handle(WorkspaceLibraryBindingIpc.bind, (_e, req: WorkspaceLibraryBindingRequest) =>
    libraryResult(() => {
      const ws = req.workspaceId?.trim();
      const ls = req.librarySpaceId?.trim();
      const collectionId = req.collectionId?.trim();
      if (!ws) throw new Error("工作空间不能为空");
      if (!ls) throw new Error("资料库空间不能为空");
      const workspace = db.getSpace(ws);
      if (!workspace) throw new Error("工作空间不存在");
      if (workspace.archived || workspace.effectiveArchived) throw new Error("归档工作空间只可读取资料");
      if (!libraryService.getSpace(ls)) throw new Error("资料库空间不存在");
      if (collectionId) {
        const collection = libraryService.getCollection(collectionId);
        if (!collection || collection.spaceId !== ls) throw new Error("资料库文件夹不存在或不属于该资料库");
        workspaceLibraryBindingService.bindCollection(ws, ls, collectionId);
      } else {
        workspaceLibraryBindingService.bind(ws, ls);
      }
    }),
  );

  ipcMain.handle(WorkspaceLibraryBindingIpc.unbind, (_e, req: WorkspaceLibraryBindingRequest) =>
    libraryResult(() => {
      const ws = req.workspaceId?.trim();
      const ls = req.librarySpaceId?.trim();
      const collectionId = req.collectionId?.trim();
      if (!ws) throw new Error("工作空间不能为空");
      if (!ls) throw new Error("资料库空间不能为空");
      const workspace = db.getSpace(ws);
      if (!workspace) throw new Error("工作空间不存在");
      if (workspace.archived || workspace.effectiveArchived) throw new Error("归档工作空间只可读取资料");
      if (collectionId) workspaceLibraryBindingService.unbindCollection(ws, collectionId);
      else workspaceLibraryBindingService.unbind(ws, ls);
    }),
  );
  ipcMain.handle(DbIpc.createProjectResource, (_e, request: ProjectResourceCreateRequest) =>
    projectService.createResource(request),
  );
  ipcMain.handle(DbIpc.updateProjectResource, (_e, request: ProjectResourceUpdateRequest) =>
    projectService.updateResource(request),
  );
  ipcMain.handle(DbIpc.deleteProjectResource, (_e, id: string) => projectService.deleteResource(id));
  ipcMain.handle(DbIpc.inspectProjectResources, (_e, projectId: string) =>
    projectContextResolver.inspectProjectResources(projectId),
  );
  ipcMain.handle(DbIpc.listProjectPosts, (_e, projectId: string) => projectService.listPosts(projectId));
  ipcMain.handle(DbIpc.createProjectPost, (_e, request: import("../shared/project-domain").ProjectPostCreateRequest) =>
    projectService.createPost(request),
  );
  ipcMain.handle(DbIpc.deleteProjectPost, (_e, id: string) => projectService.deletePost(id));
  ipcMain.handle(DbIpc.listProjectTodos, (_e, projectId: string) => projectService.listTodos(projectId));
  ipcMain.handle(DbIpc.createProjectTodo, (_e, request: ProjectTodoCreateRequest) => {
    try {
      const todo = projectService.createTodo(request);
      notifyProjectAttention(request.projectId);
      return todo;
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err));
    }
  });
  ipcMain.handle(DbIpc.updateProjectTodo, (_e, request: ProjectTodoUpdateRequest) => {
    try {
      const todo = projectService.updateTodo(request);
      const projectId = projectService.getTodo(request.id)?.projectId ?? todo.projectId;
      if (projectId) notifyProjectAttention(projectId);
      return todo;
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err));
    }
  });
  ipcMain.handle(DbIpc.deleteProjectTodo, (_e, id: string) => {
    const projectId = projectService.getTodo(id)?.projectId;
    projectService.deleteTodo(id);
    try { workGraphService.cleanupByNode("plan", id); } catch {}
    if (projectId) notifyProjectAttention(projectId);
  });
  ipcMain.handle(DbIpc.listProjectMemory, (_e, projectId: string) =>
    projectService.listMemory(projectId),
  );
  ipcMain.handle(DbIpc.createProjectMemory, (_e, request: ProjectMemoryCreateRequest) => {
    try {
      const item = projectService.createMemory(request);
      notifyProjectAttention(request.projectId);
      return item;
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err));
    }
  });
  ipcMain.handle(DbIpc.updateProjectMemory, (_e, request: ProjectMemoryUpdateRequest) => {
    try {
      const item = projectService.updateMemory(request);
      notifyProjectAttention(request.projectId);
      return item;
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err));
    }
  });
  ipcMain.handle(DbIpc.deleteProjectMemory, (_e, request: ProjectMemoryDeleteRequest) => {
    projectService.deleteMemory(request);
    notifyProjectAttention(request.projectId);
  });
  ipcMain.handle(DbIpc.getProjectAttention, (_e, projectId: string) => {
    try {
      projectService.generateActionProposals(projectId);
    } catch {
      /* 建议层失败不影响注意度 */
    }
    return attentionTracker.getAttention(projectId);
  });
  ipcMain.handle(DbIpc.listProjectEvents, (_e, projectId: string, limit?: number) =>
    projectService.listProjectEvents(projectId, limit),
  );
  ipcMain.handle(DbIpc.promoteProjectEvent, (_e, request: import("../shared/project-domain").ProjectEventPromoteRequest) => {
    // UI 路径固定 promotedBy=user（不信任 renderer 声明）；Agent 路径走扩展（固定 agent）
    const result = projectEventPromoter.promote(request.eventId, { ...request, promotedBy: "user" });
    notifyProjectAttention(result.promotion.projectId);
    broadcastToWindows(DbIpc.projectEventsChanged, { projectId: result.promotion.projectId });
    return result;
  });
  ipcMain.handle(
    DbIpc.ingestProjectDocument,
    (_e, projectId: string, request: { title: string; body: string; ref?: string }) =>
      // 文档/纪要文本 → 事件（source=document；onIngested 已接线 attention 刷新 + 活动流广播）
      projectEventIngestor.ingestDocument(projectId, request),
  );
  ipcMain.handle(DbIpc.importProjectFile, (_e, projectId: string, sourcePath: string) =>
    // 文件 → 项目资料库真源 + document 事件（幂等按文件内容哈希；onIngested 负责刷新）
    projectDocumentImporter.importFile(projectId, sourcePath),
  );
  ipcMain.handle(DbIpc.pickImportFile, async () => {
    const win = BrowserWindow.getFocusedWindow();
    const options: Electron.OpenDialogOptions = {
      title: "选择要导入项目事件的文档",
      properties: ["openFile"],
      filters: [
        { name: "文档", extensions: ["md", "markdown", "txt", "docx", "doc", "pptx", "ppt", "xlsx", "xls", "pdf", "html", "htm", "csv"] },
        { name: "所有文件", extensions: ["*"] },
      ],
    };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    return result.filePaths[0];
  });
  // triage 状态（工作流元数据，不参与派生）：仅广播活动流刷新，绝不触发 attention
  ipcMain.handle(DbIpc.dismissProjectEvent, (_e, projectId: string, eventId: string) => {
    const updated = projectService.dismissProjectEvent(projectId, eventId);
    broadcastToWindows(DbIpc.projectEventsChanged, { projectId });
    return updated;
  });
  ipcMain.handle(DbIpc.reopenProjectEvent, (_e, projectId: string, eventId: string) => {
    const updated = projectService.reopenProjectEvent(projectId, eventId);
    broadcastToWindows(DbIpc.projectEventsChanged, { projectId });
    return updated;
  });
  ipcMain.handle(DbIpc.acknowledgeProjectAttention, (_e, projectId: string) => {
    const digest = attentionTracker.acknowledge(projectId);
    if (digest) broadcastToWindows(DbIpc.projectAttentionChanged, digest);
    return digest;
  });
  ipcMain.handle(DbIpc.pinProjectItem, (_e, request: import("../shared/project-domain").ProjectContextPinRequest) => {
    try {
      return projectService.pinProjectItem(request);
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err));
    }
  });
  ipcMain.handle(DbIpc.unpinProjectItem, (_e, request: import("../shared/project-domain").ProjectContextUnpinRequest) => {
    try {
      projectService.unpinProjectItem(request);
      return { ok: true as const };
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err));
    }
  });
  ipcMain.handle(DbIpc.listProjectPins, (_e, projectId: string) => {
    try {
      return projectService.listProjectPins(projectId);
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err));
    }
  });
  ipcMain.handle(DbIpc.getProjectStatus, (_e, projectId: string) => {
    try {
      return projectService.buildStatusSnapshot(projectId);
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err));
    }
  });
  ipcMain.handle(DbIpc.recordProjectReview, (_e, request: { projectId: string; note?: string }) => {
    try {
      const owner = (() => {
        try {
          return db.getSoul().name?.trim() || "UI";
        } catch {
          return "UI";
        }
      })();
      return projectService.recordReview(request.projectId, request.note, owner);
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err));
    }
  });
  ipcMain.handle(DbIpc.getProjectActions, (_e, projectId: string) => {
    try {
      return projectService.generateActionProposals(projectId);
    } catch (err) {
      throw new Error(err instanceof Error ? err.message : String(err));
    }
  });
  ipcMain.handle(DbIpc.upsertSpace, (_e, space: SpaceDto) => {
    try {
      return { ok: true as const, space: db.upsertSpace(space) };
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
  const executionFailureRepository = new ExecutionFailureRepository(db.connection);
  ipcMain.handle(DbIpc.listExecutionFailures, (_e, taskId: string) => executionFailureRepository.list(taskId));
  ipcMain.handle(DbIpc.dismissExecutionFailure, (_e, taskId: string, id: string) => executionFailureRepository.dismiss(taskId, id));
  ipcMain.handle(DbIpc.previewProjectFolder, (_e, projectId: string, path: string) => projectFolderRelocation.preview(projectId, path));
  ipcMain.handle(DbIpc.commitProjectFolder, (_e, token: string) => { projectFolderRelocation.commit(token); return { ok: true }; });
  ipcMain.handle(DbIpc.renameSpace, (_e, id: string, name: string) => {
    try {
      db.renameSpace(id, name);
      return { ok: true as const };
    } catch (err) {
      return {
        ok: false as const,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });
  ipcMain.handle(DbIpc.upsertTask, (_e, task) => {
    // Cockpit 即时刷新：任务绑定变化（含解绑/改绑）广播新旧项目（不 bump project.updated_at，避免会话重建扰动）
    const prevProjectId = task?.id ? db.getTask(task.id)?.projectId : undefined;
    db.upsertTask(task);
    for (const projectId of new Set([task?.projectId, prevProjectId].filter(Boolean) as string[])) {
      broadcastToWindows(DbIpc.projectTaskChanged, { projectId });
      notifyProjectAttention(projectId);
    }
  });
  // P1.5：delete = 安全回收（不 rm -rf、不立即删 Artifact）；archive 只改状态不移动目录
  ipcMain.handle(DbIpc.deleteTask, async (_e, id: string) => {
    if (!taskLifecycle) throw new Error("TaskExecutionWorkspaceLifecycle 尚未初始化");
    const prevProjectId = db.getTask(id)?.projectId;
    await taskLifecycle.trash(id);
    try { workGraphService.cleanupByNode("task", id); } catch {}
    if (prevProjectId) {
      broadcastToWindows(DbIpc.projectTaskChanged, { projectId: prevProjectId });
      notifyProjectAttention(prevProjectId);
    }
  });
  ipcMain.handle(DbIpc.archiveTask, (_e, id: string, archived: boolean) => {
    if (!taskLifecycle) {
      db.archiveTask(id, archived);
      return;
    }
    if (archived) taskLifecycle.archive(id);
    else taskLifecycle.unarchive(id);
  });
  // 侧栏绿点确认：只写 done_acked_at（不碰 updated_at），无需经过生命周期回收流程。
  ipcMain.handle(DbIpc.ackTaskDone, (_e, id: string, ackedAt?: number) => {
    db.ackTaskDone(id, ackedAt);
  });
  // 回收站：删除 = 可恢复回收（保留期见 shared/archive-deletion.ts 的 TRASH_RETENTION_DAYS），
  // 必须可见可恢复，否则被删除的数据既回不来也清不掉。
  ipcMain.handle(TrashIpc.list, () => taskLifecycle?.listTrashedTasks() ?? []);
  ipcMain.handle(TrashIpc.restore, async (_e, id: string) => {
    if (!taskLifecycle) throw new Error("TaskExecutionWorkspaceLifecycle 尚未初始化");
    taskLifecycle.restore(id);
    const restored = db.getTask(id) ?? null;
    if (restored?.projectId) {
      broadcastToWindows(DbIpc.projectTaskChanged, { projectId: restored.projectId });
      notifyProjectAttention(restored.projectId);
    }
    return restored;
  });
  ipcMain.handle(ArchivedContentDeletionIpc.purge, async (_e, request: ArchivedContentDeletionRequest) => {
    const projects = new Map(db.listTasks().map((task) => [task.id, task.projectId]));
    const result = await archivedContentDeletion.purge(request);
    for (const projectId of new Set(result.deletedTaskIds.map((id) => projects.get(id)).filter(Boolean) as string[])) {
      broadcastToWindows(DbIpc.projectTaskChanged, { projectId });
      notifyProjectAttention(projectId);
    }
    return result;
  });
  ipcMain.handle(DbIpc.deleteSpace, async (_e, id: string) => {
    const result = await deleteEmptyWorkspace(db, id, [
      { name: "工作空间工具", run: () => gadgetService.deleteByWorkspace(id) },
      { name: "空间关联", run: () => { workGraphService.cleanupByNode("workspace", id); } },
      { name: "终端", run: () => { terminalHost?.close({ workspaceId: id }); } },
    ]);
    if (result.ok && result.warning) console.warn(`[WorkspaceDeletion] ${result.warning}`);
    return result;
  });
  ipcMain.handle(DbIpc.archiveSpace, (_e, id: string, archived: boolean) => {
    db.archiveSpace(id, archived);
  });
  ipcMain.handle(DbIpc.moveSpace, (_e, req: { spaceId: string; targetParentId: string | null; targetIndex?: number }) => {
    try {
      // P3-2：显式 pick 仅 targetIndex，不透传 targetSortOrder（DB 内兼容分支保留，但 IPC 不暴露）
      db.moveSpace({ spaceId: req.spaceId, targetParentId: req.targetParentId, targetIndex: req.targetIndex });
      return { ok: true as const };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle(DbIpc.moveTaskInWorkspaceTree, (_e, req: { taskId: string; targetSpaceId: string | null; targetIndex?: number }) => {
    try {
      // P3-2：显式 pick 仅 targetIndex，不透传 targetSortOrder
      db.moveTaskInWorkspaceTree({ taskId: req.taskId, targetSpaceId: req.targetSpaceId, targetIndex: req.targetIndex });
      return { ok: true as const };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });
  ipcMain.handle(DbIpc.listTaskWriteGrants, (_e, taskId: string) => {
    return db.listTaskWriteGrants(taskId);
  });
  ipcMain.handle(DbIpc.deleteTaskWriteGrant, (_e, taskId: string, path: string) => {
    // 必须经 AgentService：DB 删除 + 存活会话 policy 立即内存失效（撤销后同会话不得继续放行）
    return agentService.revokeTaskWriteGrant(taskId, path);
  });
  ipcMain.handle(DbIpc.getSemanticIndexStats, () => {
    try { return (libraryService as any).semanticIndexStats ?? { running: false }; } catch { return { running: false }; }
  });
  ipcMain.handle(DbIpc.getSemanticModelStatus, () => {
    try {
      const { SemanticModelManager } = require("./retrieval/SemanticModelManager");
      const mgr = new SemanticModelManager();
      return mgr.getStatus();
    } catch (e) { return { status: "failed", error: String(e), modelsRoot: "" }; }
  });
  ipcMain.handle(DbIpc.getSoul, () => agentService.getSoul());
  ipcMain.handle(DbIpc.updateSoul, (_e, partial) => agentService.updateSoul(partial));

  // Workspace Shared Context UI foundation (typed, no raw upsert bypass; single promote chain)
  ipcMain.handle(WorkspaceIpc.getView, (_e, req: { currentSpaceId?: string | null; taskId?: string | null } | null) => {
    try {
      if (!workspaceSharedContextService) {
        return {
          currentSpaceId: req?.currentSpaceId ?? null,
          currentSpaceName: null,
          parentId: null,
          parentName: null,
          isRoot: false,
          hasParent: false,
          isStandalone: true,
          memoryEnabled: false,
          effectiveArchived: false,
          ancestorChain: [],
          blocks: [],
          grouped: { local: [], inherited: [], promoted: [] },
          totalCount: 0,
          message: "服务未就绪",
        };
      }
      const memoryEnabled = agentService.getAppSettings().memoryEnabled;
      const currentSpaceId = (req?.currentSpaceId ?? null) as string | null;
      const taskId = (req?.taskId ?? null) as string | null;
      return workspaceSharedContextService.getView({ currentSpaceId, taskId, memoryEnabled });
    } catch (err) {
      return {
        currentSpaceId: req?.currentSpaceId ?? null,
        currentSpaceName: null,
        parentId: null,
        parentName: null,
        isRoot: false,
        hasParent: false,
        isStandalone: true,
        memoryEnabled: false,
        effectiveArchived: false,
        ancestorChain: [],
        blocks: [],
        grouped: { local: [], inherited: [], promoted: [] },
        totalCount: 0,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  });
  // Phase 6 Work Graph — typed relation (centralized validation, no Context/Permission change)
  ipcMain.handle(WorkGraphIpc.addEdge, (_e, req: WorkGraphAddEdgeRequest) => {
    try {
      const r = workGraphService.addEdge(req);
      return { ok: true as const, edge: r.edge, created: r.created };
    } catch (err) { return { ok: false as const, error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle(WorkGraphIpc.removeEdge, (_e, id: string) => {
    try {
      const removed = workGraphService.removeEdge(id);
      return { ok: true as const, removed };
    } catch (err) { return { ok: false as const, error: err instanceof Error ? err.message : String(err) }; }
  });
  ipcMain.handle(WorkGraphIpc.listOutgoing, (_e, req: WorkGraphListRequest) => {
    try { return workGraphService.listOutgoing(req.type, req.id, req.relation); } catch (err) { throw new Error(err instanceof Error ? err.message : String(err)); }
  });
  ipcMain.handle(WorkGraphIpc.listIncoming, (_e, req: WorkGraphListRequest) => {
    try { return workGraphService.listIncoming(req.type, req.id, req.relation); } catch (err) { throw new Error(err instanceof Error ? err.message : String(err)); }
  });
  ipcMain.handle(WorkGraphIpc.listRelated, (_e, req: WorkGraphListRequest) => {
    try { return workGraphService.listRelated(req.type, req.id, req.relation); } catch (err) { throw new Error(err instanceof Error ? err.message : String(err)); }
  });
  // Phase 10: integrity / repair (explicit, previewable, reversible — never silent on boot)
  ipcMain.handle(WorkGraphIpc.checkIntegrity, () => {
    const { checkIntegrity } = require("./workgraph/WorkGraphIntegrity");
    return checkIntegrity(db);
  });
  ipcMain.handle(WorkGraphIpc.previewRepair, (_e, report: import("../shared/work-graph").WorkGraphIntegrityReport) => {
    const { previewRepair } = require("./workgraph/WorkGraphIntegrity");
    return previewRepair(db, report as unknown as Parameters<typeof previewRepair>[1]);
  });
  ipcMain.handle(WorkGraphIpc.applyRepair, (_e, preview: import("../shared/work-graph").WorkGraphRepairPreview) => {
    const { applyRepair } = require("./workgraph/WorkGraphIntegrity");
    return applyRepair(db, preview as unknown as Parameters<typeof applyRepair>[1]);
  });
  ipcMain.handle(WorkGraphIpc.observability, () => {
    try {
      const edges = workGraphService.countAll();
      const start = Date.now();
      try { workGraphService.listRelated("task" as unknown as import("../shared/work-graph").WorkGraphNodeType, "non-existent", undefined); } catch {}
      const resolverMs = Date.now() - start;
      return { edges, resolverMs };
    } catch (e) { return { edges: 0, error: String(e) }; }
  });
  ipcMain.handle(WorkGraphIpc.benchmark, async () => {
    const t0 = Date.now();
    const spaces = db.listSpaces().length;
    const t1 = Date.now();
    const tasks = db.listTasks().length;
    const t2 = Date.now();
    const edges = workGraphService.countAll();
    const t3 = Date.now();
    // Locator timing (if available)
    let locatorMs: number | undefined;
    try {
      const { WorkspaceResourceLocator } = require("./workspace/WorkspaceResourceLocator");
      const { WorkspaceLibraryBindingService } = require("./workspace/WorkspaceLibraryBindingService");
      const { LibraryService } = require("./library/LibraryService");
      const binding = new WorkspaceLibraryBindingService(db);
      const lib = new LibraryService(db);
      const loc = new WorkspaceResourceLocator(db, lib, binding);
      const t = db.listTasks()[0]?.id ?? null;
      if (t) { const s = Date.now(); loc.search({ query: "test", taskId: t }); locatorMs = Date.now() - s; }
    } catch {}
    return { spaces, tasks, edges, timingsMs: { listSpaces: t1 - t0, listTasks: t2 - t1, countEdges: t3 - t2, ...(locatorMs !== undefined ? { locator: locatorMs } : {}) } };
  });

  ipcMain.handle(WorkspaceIpc.promote, (_e, req: { itemId: string; fromSpaceId: string }) => {
    try {
      if (!agentService.getAppSettings().memoryEnabled) {
        return { ok: false as const, error: "记忆已关闭，共享上下文未启用" };
      }
      if (!workspaceSharedContextService) return { ok: false as const, error: "服务未就绪" };
      if (!req?.itemId || !req?.fromSpaceId) return { ok: false as const, error: "参数缺失" };
      const result = workspaceSharedContextService.promote(req.itemId, req.fromSpaceId);
      if (!result.ok) return { ok: false as const, error: result.error };
      // Promote success: broadcast memoryChanged for parent (renderer refresh)
      try {
        broadcastToWindows(DbIpc.memoryChanged, { scope: "space", spaceId: result.targetParentId });
      } catch {}
      return { ok: true as const, targetParentId: result.targetParentId, alreadyExisted: result.alreadyExisted };
    } catch (err) {
      return { ok: false as const, error: err instanceof Error ? err.message : String(err) };
    }
  });

  // Unified Memory Kernel IPC (single truth for Global/Workspace/Project/Task).
  ipcMain.handle(MemoryOrganizationIpc.latest, () => agentService.kernelMemoryOrganization());
  ipcMain.handle(MemoryOrganizationIpc.start, (_e, resumeId?: string) => agentService.startKernelMemoryOrganization(resumeId));
  ipcMain.handle(MemoryOrganizationIpc.pause, (_e, id: string) => agentService.pauseKernelMemoryOrganization(id));
  ipcMain.handle(MemoryOrganizationIpc.apply, (_e, id: string) => agentService.applyKernelMemoryOrganization(id));
  ipcMain.handle(MemoryOrganizationIpc.undo, (_e, id: string) => agentService.undoKernelMemoryOrganization(id));
  ipcMain.handle(MemoryOrganizationIpc.dismiss, (_e, id: string) => agentService.dismissKernelMemoryOrganization(id));
  ipcMain.handle(MemoryIpc.list, (_e, request?: import("../shared/memory-kernel").MemoryListRequest | number) => agentService.listKernelMemory(request));
  ipcMain.handle(MemoryIpc.turns, (_e, request?: import("../shared/memory-kernel").MemoryTurnListRequest) => agentService.listKernelMemoryTurns(request));
  ipcMain.handle(MemoryIpc.getTurn, (_e, id: string) => agentService.getKernelMemoryTurn(id));
  ipcMain.handle(MemoryIpc.memoriesForTurn, (_e, turnId: string) => agentService.memoriesForKernelTurn(turnId));
  ipcMain.handle(MemoryIpc.search, (_e, request: MemorySearchRequest) => agentService.searchKernelMemory(request));
  ipcMain.handle(MemoryIpc.get, (_e, id: string) => agentService.getKernelMemory(id));
  ipcMain.handle(MemoryIpc.create, (_e, request: MemoryCreateRequest) => agentService.createKernelMemory(request));
  ipcMain.handle(MemoryIpc.update, (_e, request: MemoryUpdateRequest) => agentService.updateKernelMemory(request));
  ipcMain.handle(MemoryIpc.forget, (_e, ids: string | string[]) => agentService.forgetKernelMemories(Array.isArray(ids) ? ids : [ids]));
  ipcMain.handle(MemoryIpc.promote, (_e, id: string, scopeType: MemoryScopeType, scopeId?: string) => agentService.promoteKernelMemory(id, scopeType, scopeId));
  ipcMain.handle(MemoryIpc.detachScope, (_e, id: string, scopeType: MemoryScopeType, scopeId?: string) => agentService.detachKernelMemoryScope(id, scopeType, scopeId));
  ipcMain.handle(MemoryIpc.retryFailedTurns, () => agentService.retryKernelFailedTurns());
  ipcMain.handle(MemoryIpc.extractPendingTurns, () => agentService.extractKernelPendingTurns());
  ipcMain.handle(MemoryIpc.turnTasks, () => agentService.kernelMemoryTurnTasks());
  ipcMain.handle(MemoryIpc.deleteAllTurns, () => agentService.deleteAllKernelMemoryTurns());
  ipcMain.handle(MemoryIpc.deleteTurns, (_e, ids: string[]) => agentService.deleteKernelMemoryTurns(ids));
  ipcMain.handle(MemoryIpc.dismissProjection, (_e, id: string, kind: "scenario" | "profile") => agentService.dismissKernelProjection(id, kind));
  ipcMain.handle(MemoryIpc.deleteProjectionRecords, (_e, request: import("../shared/memory-kernel").MemoryProjectionDeleteRequest) => agentService.deleteKernelProjectionRecords(request));
  ipcMain.handle(MemoryIpc.restoreProjection, (_e, id: string) => agentService.restoreKernelProjection(id));
  ipcMain.handle(MemoryIpc.dismissedProjections, () => agentService.listKernelDismissedProjections());
  ipcMain.handle(MemoryIpc.generateL2Proposals, () => agentService.generateKernelL2Proposals());
  ipcMain.handle(MemoryIpc.generateL3Proposals, () => agentService.generateKernelL3Proposals());
  ipcMain.handle(MemoryIpc.projectionProposals, () => agentService.listKernelProjectionProposals());
  ipcMain.handle(MemoryIpc.approveProjectionProposal, (_e, id: string) => agentService.approveKernelProjectionProposal(id));
  ipcMain.handle(MemoryIpc.rejectProjectionProposal, (_e, id: string) => agentService.rejectKernelProjectionProposal(id));
  ipcMain.handle(MemoryIpc.restoreProjectionProposal, (_e, id: string) => agentService.restoreKernelProjectionProposal(id));
  ipcMain.handle(MemoryIpc.history, (_e, id: string) => agentService.kernelMemoryHistory(id));
  ipcMain.handle(MemoryIpc.candidates, (_e, status?: import("../shared/memory-kernel").MemoryCandidateDto["status"], limit?: number) => agentService.kernelMemoryCandidates(status, limit));
  ipcMain.handle(MemoryIpc.resolveCandidate, (_e, id: string, decision: "approve" | "reject") => agentService.resolveKernelMemoryCandidate(id, decision));
  ipcMain.handle(MemoryIpc.stats, () => agentService.kernelMemoryStats());
  ipcMain.handle(MemoryIpc.scenarios, (_e, limit?: number) => agentService.kernelMemoryScenarios(limit));
  ipcMain.handle(MemoryIpc.coreProfiles, (_e, limit?: number) => agentService.kernelMemoryCoreProfiles(limit));
  ipcMain.handle(MemoryIpc.skillCandidates, (_e, status?: import("../shared/memory-kernel").MemorySkillCandidateStatus, limit?: number) => agentService.kernelMemorySkillCandidates(status, limit));
  ipcMain.handle(MemoryIpc.skillLearningStatus, () => agentService.kernelSkillLearningStatus());
  ipcMain.handle(MemoryIpc.deleteSkillHistory, (_e, request: import("../shared/memory-kernel").MemorySkillHistoryDeleteRequest) => agentService.deleteKernelSkillHistory(request));
  ipcMain.handle(MemoryIpc.refreshSkillCandidates, () => agentService.refreshKernelMemorySkillCandidates());
  ipcMain.handle(MemoryIpc.approveSkillCandidate, (_e, id: string) => agentService.approveKernelMemorySkillCandidate(id));
  ipcMain.handle(MemoryIpc.rejectSkillCandidate, (_e, id: string) => agentService.rejectKernelMemorySkillCandidate(id));
  ipcMain.handle(MemoryIpc.skillEffectiveness, (_e, limit?: number, invokedOnly?: boolean) => agentService.kernelSkillEffectiveness(limit, invokedOnly));
  ipcMain.handle(MemoryIpc.skillEffectivenessSummary, (_e, limit?: number) => agentService.kernelSkillEffectivenessSummary(limit));
  ipcMain.handle(MemoryIpc.setSkillFeedback, (_e, id: string, kind: import("../shared/memory-kernel").MemorySkillFeedbackKind | null, note?: string) => agentService.setKernelSkillFeedback(id, kind, note));
  ipcMain.handle(MemoryIpc.skillRevisionCandidates, (_e, status?: import("../shared/memory-kernel").MemorySkillRevisionStatus, limit?: number) => agentService.kernelSkillRevisionCandidates(status, limit));
  ipcMain.handle(MemoryIpc.refreshSkillRevisionCandidates, () => agentService.refreshKernelSkillRevisionCandidates());
  ipcMain.handle(MemoryIpc.approveSkillRevisionCandidate, (_e, id: string) => agentService.approveKernelSkillRevisionCandidate(id));
  ipcMain.handle(MemoryIpc.rejectSkillRevisionCandidate, (_e, id: string) => agentService.rejectKernelSkillRevisionCandidate(id));
  ipcMain.handle(MemoryIpc.reindexSemantic, (_e, limit?: number) => agentService.reindexKernelMemory(limit));

  // Cron
  ipcMain.handle(CronIpc.list, () => cronService.list());
  ipcMain.handle(CronIpc.runs, (_e, limit?: number) => cronService.listRuns(limit));
  ipcMain.handle(CronIpc.upsert, (_e, job: CronJobDto) => cronService.upsert(job));
  ipcMain.handle(CronIpc.setEnabled, (_e, id: string, enabled: boolean) => {
    cronService.setEnabled(id, enabled);
  });
  ipcMain.handle(CronIpc.remove, (_e, id: string) => cronService.remove(id));
  ipcMain.handle(CronIpc.runNow, async (_e, id: string) => {
    await cronService.runNow(id);
  });

  // Gateway
  ipcMain.handle(GatewayIpc.weixinQrStart, (_e, approved: boolean) => gatewayService.startWeixinQrLogin(approved));
  ipcMain.handle(GatewayIpc.qqQrStart, (_e, approved: boolean) => gatewayService.startQQQrLogin(approved));
  ipcMain.handle(GatewayIpc.weixinQrState, () => gatewayService.getWeixinQrLoginState());
  ipcMain.handle(GatewayIpc.qqQrState, () => gatewayService.getQQQrLoginState());
  ipcMain.handle(GatewayIpc.weixinQrCancel, (_e, sessionId?: string) => gatewayService.cancelWeixinQrLogin(sessionId));
  ipcMain.handle(GatewayIpc.qqQrCancel, (_e, sessionId?: string) => gatewayService.cancelQQQrLogin(sessionId));
  ipcMain.handle(GatewayIpc.status, () => gatewayService.status());
  ipcMain.handle(GatewayIpc.listChannels, () => gatewayService.listChannels());
  ipcMain.handle(
    GatewayIpc.connect,
    async (_e, channelId: string, config: Record<string, unknown>) =>
      gatewayService.connect(channelId, config),
  );
  ipcMain.handle(GatewayIpc.disconnect, async (_e, channelId: string) =>
    gatewayService.disconnect(channelId),
  );
  ipcMain.handle(GatewayIpc.getChannelConfig, (_e, channelId: string) =>
    gatewayService.getChannelConfig(channelId),
  );
  ipcMain.handle(GatewayIpc.listMessages, (_e, req: GatewayListMessagesRequest) =>
    gatewayService.listMessages(req ?? {}),
  );

  // Artifact Domain（V3.5 Wave 2 双系统施工态：通道已通，renderer 暂未消费）
  ipcMain.handle(ArtifactDomainIpc.get, (_e, req: ArtifactDomainGetRequest) => {
    const artifact = artifactDomainService.get(req.artifactId);
    return { artifact };
  });
  ipcMain.handle(ArtifactDomainIpc.list, (_e, req: ArtifactDomainTaskRequest) => {
    const artifacts = artifactDomainService.listByTask(req.taskId);
    return { artifacts, state: artifacts.length ? "ready" : "unloaded" };
  });
  ipcMain.handle(ArtifactDomainIpc.snapshot, async (_e, req: ArtifactDomainTaskRequest) => {
    // lazy hydrate（§21-23）：task 级快照，含 load state；首次 hydrate 前跑一次性 legacy migration
    try {
      if (artifactLegacySource) await ensureTaskLegacyMigrated(artifactDomainService, artifactLegacySource, req.taskId);
    } catch (err) {
      // 迁移失败不毁 history（隔离）；snapshot 返回 error state，允许 retry（3B.4/M6）
      console.error("[ArtifactDomain] legacy migration failed:", err);
      return { taskId: req.taskId, artifacts: [], revision: 0, state: "error", error: err instanceof Error ? err.message : String(err) };
    }
    return artifactDomainService.hydrateTask(req.taskId);
  });
  ipcMain.handle(ArtifactDomainIpc.register, async (_e, req: ArtifactDomainRegisterRequest) => {
    // 3C：Artifact create 唯一通道（openLocalFile/openWorkspaceFile/ensureCanvasArtifact/Agent ingest）
    return artifactDomainService.register(req);
  });
  ipcMain.handle(ArtifactDomainIpc.readContent, async (_e, req: ArtifactDomainReadContentRequest) => {
    // 3C：内容解析（managed→storage；workspace-file→fs+root 边界）
    // inline：renderer 只拿协议 URL + 尺寸元数据，位图 base64 一律不过 IPC。
    return artifactDomainService.readContent(req.artifactId, { inline: true });
  });
  ipcMain.handle(ArtifactDomainIpc.removeTask, (_e, req: ArtifactDomainTaskRequest) => {
    // task 生命周期（3B.6）：DB/Registry/storage 全清理，removed 事件广播
    return artifactDomainService.removeByTask(req.taskId);
  });
  ipcMain.handle(ArtifactDomainIpc.remove, (_e, req: ArtifactDomainRemoveRequest) => {
    const ok = artifactDomainService.remove(req.artifactId);
    return { ok };
  });

  // HTML 产物预览宿主（WebContentsView + mybuddy-artifact 协议），
  // Wave 4A：显示决策全部经 NativeSurfaceCoordinator（§75）；setRect/hide/show 通道已删除
  ipcMain.handle(ArtifactIpc.preview, async (_e, req: ArtifactPreviewRequest) => {
    await surfaceCoordinator.loadArtifact(SURFACE_MAIN, req.id);
    return { ok: true };
  });
  ipcMain.on(ArtifactIpc.reload, () => surfaceCoordinator.reload(SURFACE_MAIN));
  ipcMain.on(ArtifactIpc.hardReload, () => surfaceCoordinator.hardReload(SURFACE_MAIN));
  ipcMain.handle(ArtifactIpc.openInBrowser, async (_e, req: ArtifactPreviewRequest) => {
    const descriptor = artifactDomainService.get(req.id);
    if (!descriptor || descriptor.kind !== "html") {
      return { ok: false, error: "仅 HTML 产物支持在系统浏览器打开" };
    }
    const target = artifactDomainService.entryPathOf(req.id);
    if (!target) return { ok: false, error: "产物入口文件不可用" };
    const error = await shell.openPath(target);
    return error ? { ok: false, error } : { ok: true };
  });
  ipcMain.on(ArtifactIpc.close, () => surfaceCoordinator.close(SURFACE_MAIN));
  ipcMain.on(
    ArtifactSurfaceIpc.requestBounds,
    (_e, req: ArtifactSurfaceBoundsRequest) =>
      surfaceCoordinator.requestBounds(req.surfaceId ?? SURFACE_MAIN, req.rect),
  );
  ipcMain.on(
    ArtifactSurfaceIpc.requestVisible,
    (_e, req: ArtifactSurfaceVisibleRequest) =>
      surfaceCoordinator.requestVisible(req.surfaceId ?? SURFACE_MAIN, req.visible),
  );
  ipcMain.on(
    ArtifactSurfaceIpc.addBlocker,
    (_e, req: ArtifactSurfaceBlockerRequest) =>
      surfaceCoordinator.addBlocker(req.surfaceId ?? SURFACE_MAIN, req.token),
  );
  ipcMain.on(
    ArtifactSurfaceIpc.removeBlocker,
    (_e, req: ArtifactSurfaceBlockerRequest) =>
      surfaceCoordinator.removeBlocker(req.surfaceId ?? SURFACE_MAIN, req.token),
  );
  // 4C：Capture Mode IPC（MVP：enter/exit/startInspect/stopInspect；事件经 CaptureModeEvent）
  ipcMain.handle(CaptureModeIpc.enter, async (_e, req: CaptureModeEnterRequest) => {
    await htmlEditService?.stop();
    if (req.target === "browser") {
      captureModeController?.exit();
      await browserHost.enterCapture();
    } else {
      browserHost.exitCapture();
      await captureModeController?.enter(req.artifactId);
    }
    return { ok: true };
  });
  ipcMain.on(CaptureModeIpc.exit, () => {
    captureModeController?.exit();
    browserHost.exitCapture();
  });
  ipcMain.on(CaptureModeIpc.startInspect, () => void captureModeController?.startInspect());
  ipcMain.on(CaptureModeIpc.stopInspect, () => void captureModeController?.stopInspect());
  // 4D：Selection 快照/清除（唯一 truth 在 SelectionStore；renderer 只读投影）
  ipcMain.handle(SelectionIpc.get, () => selectionStore?.getState() ?? null);
  ipcMain.on(SelectionIpc.clear, () => selectionStore?.clearSelection());
  ipcMain.on(SelectionIpc.comment, () => reopenSelectionComment?.());
  // 4E：Prompt Context 采集（Wave 4 Gate E2E 入口；不接 Agent，只组装不 prompt）
  ipcMain.handle(PromptContextIpc.collect, async (_e, req: PromptContextCollectRequest) => {
    return (await promptContextService?.collect(req.artifactId)) ?? {
      ok: false as const,
      reason: "artifact-not-found" as const,
    };
  });

  // 扩展栏浏览器 IPC
  ipcMain.on(BrowserIpc.open, (_e, url: string, options?: { reload?: boolean }) => browserHost.open(url ?? "", options));
  ipcMain.on(BrowserIpc.navigate, (_e, url: string) => browserHost.navigate(url ?? ""));
  ipcMain.on(BrowserIpc.reload, () => browserHost.reload());
  ipcMain.on(BrowserIpc.hardReload, () => browserHost.hardReload());
  ipcMain.on(BrowserIpc.back, () => browserHost.back());
  ipcMain.on(BrowserIpc.forward, () => browserHost.forward());
  // url 可选：聊天外链传显式 URL；扩展栏工具栏无参时打开当前页
  ipcMain.on(BrowserIpc.openExternal, (_e, url?: string) => {
    const target =
      typeof url === "string" && url.trim() ? url.trim() : browserHost.url;
    if (/^https?:/i.test(target)) void shell.openExternal(target);
  });
  ipcMain.on(BrowserIpc.setRect, (_e, rect: Electron.Rectangle) => browserHost.setBounds(rect));
  ipcMain.on(BrowserIpc.hide, () => browserHost.hide());
  ipcMain.on(BrowserIpc.show, () => browserHost.show());
  ipcMain.on(BrowserIpc.addBlocker, (_e, token: string) => browserHost.addBlocker(typeof token === "string" ? token : ""));
  ipcMain.on(BrowserIpc.removeBlocker, (_e, token: string) => browserHost.removeBlocker(typeof token === "string" ? token : ""));
  ipcMain.handle(RuntimeConsoleIpc.snapshot, async (_e, rawTarget: unknown): Promise<BrowserConsoleSnapshotDto> => {
    const target = requireBrowserConsoleTarget(rawTarget);
    const result = await runtimeProbeService.execute({
      action: "read",
      target,
      limit: BROWSER_CONSOLE_MAX_ENTRIES,
      kinds: ["console", "runtime-error", "load"],
    });
    const entries = (result.events ?? [])
      .map(toBrowserConsoleEntry)
      .filter((entry): entry is BrowserConsoleEntryDto => entry !== null);
    return { latestSequence: result.latestSequence, entries };
  });
  ipcMain.handle(RuntimeConsoleIpc.clear, (_e, rawTarget: unknown): boolean => {
    runtimeProbeService.clear(requireBrowserConsoleTarget(rawTarget));
    return true;
  });

  // 受管工具 Runtime（设计类工具 + 办公 drawio-ai；只接受注册表内 provider id，不暴露任意进程/URL 能力）
  const requireProfessionalProvider = (value: string): ManagedToolProviderId => {
    if (!isManagedToolProvider(value)) throw new Error(`不支持的受管工具 provider: ${value}`);
    return value;
  };
  ipcMain.handle(ProfessionalToolIpc.status, (_e, providerId: string) =>
    professionalToolService.status(requireProfessionalProvider(providerId)),
  );
  ipcMain.handle(ProfessionalToolIpc.prepare, (_e, providerId: string) =>
    professionalToolService.prepareForProvider(requireProfessionalProvider(providerId)),
  );
  ipcMain.handle(ProfessionalToolIpc.open, (_e, providerId: string) =>
    professionalToolService.open(requireProfessionalProvider(providerId)),
  );
  ipcMain.handle(ProfessionalToolIpc.stop, (_e, providerId: string) =>
    professionalToolService.stop(requireProfessionalProvider(providerId)),
  );

  // MCP 配置（MyBuddy 应用全局 ~/.mybuddy/plugins/mcp/mcp.json）
  ipcMain.handle(PluginStorageIpc.paths, () => getPluginStorage());
  ipcMain.handle(PluginStorageIpc.openDirectory, async () => {
    const path = getPluginStorage().root;
    const error = await shell.openPath(path);
    return { ok: !error, path, ...(error ? { error } : {}) };
  });
  ipcMain.handle(McpIpc.discover, () => mcpService.discover());
  ipcMain.handle(McpIpc.listServers, () => mcpService.listServers());
  ipcMain.handle(McpIpc.install, (_e, names: string[]) => mcpService.installServers(names));
  ipcMain.handle(McpIpc.installBundled, () => mcpService.installBundledCodingMcp());
  ipcMain.handle(McpIpc.remove, (_e, names: string[]) => mcpService.removeServers(names));
  ipcMain.handle(McpIpc.setServerEnabled, (_e, name: string, enabled: boolean) =>
    mcpService.setServerEnabled(name, enabled),
  );
  ipcMain.handle(McpIpc.readAppConfig, () => mcpService.readAppConfig());
  ipcMain.handle(McpIpc.writeAppConfig, (_e, text: string) => mcpService.writeAppConfig(text));
  ipcMain.handle(McpIpc.readServerConfig, (_e, name: string) => mcpService.readServerConfig(name));
  ipcMain.handle(McpIpc.saveServerConfig, (_e, request: McpSaveServerRequest) => mcpService.saveServerConfig(request));
  ipcMain.handle(McpIpc.serverTools, (_e, name: string) => agentService.mcpRuntime.getServerTools(name));

  // MCP 运行时（Pi 原生 MCP，管理会话与任务会话独立）
  ipcMain.handle(McpIpc.status, async (_e, taskId?: string) => {
    // Hub 打开/刷新时拉起全量无头会话，避免状态来自当前对话的模式过滤快照
    if (!taskId) await agentService.mcpRuntime.ensureHeadlessSession();
    return agentService.mcpRuntime.getStatus(taskId);
  });
  ipcMain.handle(McpIpc.connect, (_e, name: string, taskId?: string) => agentService.mcpRuntime.connect(name, taskId));
  ipcMain.handle(McpIpc.authStart, (_e, name: string) => agentService.mcpRuntime.authStart(name));
  ipcMain.handle(McpIpc.authComplete, (_e, name: string, input: string) =>
    agentService.mcpRuntime.authComplete(name, input),
  );
  ipcMain.handle(McpIpc.logout, (_e, name: string) => agentService.mcpRuntime.logout(name));
  ipcMain.handle(McpIpc.hasCredentials, (_e, name: string) =>
    agentService.mcpRuntime.hasCredentials(name),
  );
  ipcMain.handle(McpIpc.uiRespond, (_e, requestId: string, value?: string | boolean) =>
    agentService.mcpRuntime.respondUi(requestId, value),
  );
  ipcMain.handle(McpIpc.uiCancel, (_e, requestId?: string) =>
    agentService.mcpRuntime.cancelUi(requestId),
  );

  /* ------------------- 扩展栏终端（Terminal P0） ------------------- */
  const prepareExternalCliMemory = async (owner: { taskId?: string; workspaceId?: string }): Promise<void> => {
    // Skill-first sharing: every terminal launch refreshes the one-way Skill projection,
    // so direct Codex/Claude/Hermes launches do not need Herdr to see MyBuddy Skills.
    try {
      ensureExternalCliMemoryAssets();
      const projection = projectMyBuddySkillsToCliRoots();
      if (projection.errors.length > 0) console.warn("[Terminal] shared Skill projection incomplete", projection);
    } catch (error) {
      console.warn(`[Terminal] shared Skill projection failed: ${error instanceof Error ? error.message : String(error)}`);
    }

    if (!memoryGatewayController || !externalCliMemoryBridge) return;
    try {
      const gateway = await memoryGatewayController.start();
      if (!gateway.running || !gateway.memoryEnabled) return;

      let workspaceId = owner.workspaceId?.trim();
      let cwd: string | undefined;
      if (owner.taskId?.trim()) {
        const taskId = owner.taskId.trim();
        const taskBeforeResolve = db.getTask(taskId);
        cwd = agentService.resolveTaskExecutionWorkspaceCwd(taskId);
        const task = db.getTask(taskId) ?? taskBeforeResolve;
        workspaceId = task?.spaceId?.trim() || undefined;
        if (!workspaceId && task && cwd) {
          const prepared = externalCliMemoryBridge.ensureTaskAccess({
            taskId,
            taskName: task.title || taskId,
            cwd,
          });
          if (prepared.enabled) {
            console.log(`[Terminal] CLI Memory ready task=${taskId} mode=${prepared.mode}`);
          }
          return;
        }
      }
      if (!workspaceId) return;
      const space = db.getSpace(workspaceId);
      if (!space) return;
      if (!cwd) {
        cwd = resolveBoundWorkspaceCwd(space, (p) => {
          try { return existsSync(p) && statSync(p).isDirectory(); } catch { return false; }
        });
      }
      const prepared = externalCliMemoryBridge.ensureWorkspaceAccess({
        workspaceId,
        workspaceName: space.name || basename(cwd),
        cwd,
      });
      if (prepared.enabled) {
        console.log(`[Terminal] CLI Memory ready workspace=${workspaceId} mode=${prepared.mode}`);
      }
    } catch (error) {
      // Memory sharing is an additive capability; a gateway/profile failure must
      // never prevent the user's terminal from opening.
      console.warn(`[Terminal] CLI Memory preparation failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  };

  /* ------------------- 外部 Agent（ACP Runtime） ------------------- */
  ipcMain.handle(ExternalAgentIpc.listAgents, (_e, refresh?: boolean) =>
    externalAgentRuntime?.listAgents(refresh === true) ?? [],
  );
  ipcMain.handle(ExternalAgentIpc.setEnabled, async (_e, agentId: ExternalAgentId, enabled: boolean) => {
    if (!externalAgentRuntime) return [];
    const current = agentService.getAppSettings().disabledExternalAgentIds ?? [];
    const next = enabled === false
      ? [...new Set([...current, agentId])]
      : current.filter((id) => id !== agentId);
    await agentService.updateAppSettings({ disabledExternalAgentIds: next });
    return externalAgentRuntime.listAgents();
  });
  ipcMain.handle(ExternalAgentIpc.setConfigOption, async (_e, req: ExternalAgentSetConfigOptionRequest) => {
    if (!externalAgentRuntime) return [];
    const agentId = req?.agentId;
    const configId = typeof req?.configId === "string" ? req.configId.trim() : "";
    if (!agentId || !configId) return externalAgentRuntime.listAgents();
    const settings = agentService.getAppSettings();
    const all: Record<string, Record<string, string | boolean>> = { ...(settings.externalAgentConfigSelections ?? {}) };
    const per: Record<string, string | boolean> = { ...(all[agentId] ?? {}) };
    const value = req?.value;
    if (value === undefined || value === null || value === "") delete per[configId];
    else if (typeof value === "string" || typeof value === "boolean") per[configId] = value;
    if (Object.keys(per).length) all[agentId] = per;
    else delete all[agentId];
    await agentService.updateAppSettings({ externalAgentConfigSelections: all });
    return externalAgentRuntime.listAgents();
  });
  ipcMain.handle(ExternalAgentIpc.test, (_e, agentId: ExternalAgentId) => {
    if (!externalAgentRuntime) throw new Error("External Agent Runtime 未初始化");
    return externalAgentRuntime.testAgent(agentId);
  });
  ipcMain.handle(ExternalAgentIpc.active, (_e, taskId?: string) => externalAgentRuntime?.active(taskId) ?? []);
  ipcMain.handle(ExternalAgentIpc.history, (_e, taskId: string) =>
    externalAgentRuntime?.history(taskId) ?? { messages: [], runs: [] },
  );
  ipcMain.handle(ExternalAgentIpc.prompt, async (_e, req: ExternalAgentPromptRequest) => {
    if (!externalAgentRuntime) throw new Error("External Agent Runtime 未初始化");
    await prepareExternalCliMemory({ taskId: req.taskId });
    return externalAgentRuntime.prompt(req);
  });
  ipcMain.handle(ExternalAgentIpc.cancel, (_e, runId?: string, taskId?: string) => {
    if (!externalAgentRuntime) return { ok: false, message: "External Agent Runtime 未初始化" };
    return externalAgentRuntime.cancel(runId, taskId);
  });
  ipcMain.handle(ExternalAgentIpc.resolvePermission, (_e, req: ExternalAgentResolvePermissionRequest) => {
    if (!externalAgentRuntime) return { ok: false, message: "External Agent Runtime 未初始化" };
    return externalAgentRuntime.resolvePermission(req);
  });
  ipcMain.handle(TerminalIpc.open, async (_e, req: TerminalOpenRequest) => {
    if (!terminalHost) throw new Error("terminalHost 未初始化");
    await prepareExternalCliMemory(req);
    return terminalHost.open(req);
  });
  ipcMain.handle(TerminalIpc.restart, async (_e, req: TerminalOpenRequest) => {
    if (!terminalHost) throw new Error("terminalHost 未初始化");
    await prepareExternalCliMemory(req);
    return terminalHost.restart(req);
  });
  ipcMain.handle(TerminalIpc.tail, (_e, req: TerminalTailRequest) => {
    if (!terminalHost) return { sessionId: null, text: "", truncated: false };
    return terminalHost.tail(req);
  });
  ipcMain.handle(
    TerminalIpc.prepareHerdr,
    async (_e, req: TerminalPrepareHerdrRequest): Promise<TerminalPrepareHerdrResult> => {
      const workspaceId = req.workspaceId?.trim();
      if (!workspaceId) return { ok: false, error: "缺少 workspaceId" };
      const space = db.getSpace(workspaceId);
      if (!space) return { ok: false, error: `工作空间不存在：${workspaceId}` };
      let cwd: string;
      try {
        cwd = resolveBoundWorkspaceCwd(space, (p) => {
          try {
            return existsSync(p) && statSync(p).isDirectory();
          } catch {
            return false;
          }
        });
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      await prepareExternalCliMemory({ workspaceId });
      return prepareHerdrWorkspace({ workspaceId, cwd, label: space.name || basename(cwd) });
    },
  );
  ipcMain.on(TerminalIpc.input, (_e, req: TerminalInputRequest) => {
    terminalHost?.input({ ...req, data: req.data ?? "" });
  });
  ipcMain.on(TerminalIpc.resize, (_e, req: TerminalResizeRequest) => {
    terminalHost?.resize(req);
  });
  ipcMain.on(TerminalIpc.close, (_e, req: TerminalCloseRequest) => {
    terminalHost?.close(req);
  });

  /* ------------------- Python 运行时（受管解释器与环境） ------------------- */
  const pythonRuntime = getPythonRuntimeService();
  ipcMain.handle(PythonRuntimeIpc.status, () => pythonRuntime.status());
  ipcMain.handle(PythonRuntimeIpc.list, () => pythonRuntime.store.list());
  ipcMain.handle(
    PythonRuntimeIpc.prepare,
    (_e, req: PreparePythonEnvironmentRequest): Promise<PreparePythonEnvironmentResult> =>
      pythonRuntime.prepare(req ?? {}),
  );
  ipcMain.handle(PythonRuntimeIpc.remove, (_e, id: string) => pythonRuntime.removeEnvironment(id));
  ipcMain.handle(PythonRuntimeIpc.cleanStaging, () => pythonRuntime.cleanStaging());
  ipcMain.handle(PythonRuntimeIpc.reclaimDisk, () => pythonRuntime.reclaimDisk());
  // 诊断导出走「保存」对话框而不是固定目录：用户要把它发给别人，落在哪儿得自己定
  ipcMain.handle(PythonRuntimeIpc.exportDiagnostics, async (): Promise<PythonDiagnosticsExportResult> => {
    const win = BrowserWindow.getFocusedWindow();
    const options: Electron.SaveDialogOptions = {
      title: "导出 Python 运行时诊断信息",
      defaultPath: `mybuddy-python-diagnostics-${new Date().toISOString().slice(0, 10)}.json`,
      filters: [{ name: "JSON", extensions: ["json"] }],
    };
    const result = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options);
    if (result.canceled || !result.filePath) return { ok: false, cancelled: true, detail: "已取消" };
    try {
      writeFileSync(result.filePath, JSON.stringify(pythonRuntime.exportDiagnostics(), null, 2), "utf8");
      return { ok: true, cancelled: false, detail: `已导出：${result.filePath}` };
    } catch (error) {
      return {
        ok: false,
        cancelled: false,
        detail: `导出失败：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  });
  ipcMain.handle(PythonRuntimeIpc.inspectProject, (_e, projectDir: string) => pythonRuntime.inspectProject(projectDir));
  ipcMain.handle(PythonRuntimeIpc.listProjectBindings, (): PythonProjectBindingView[] => pythonRuntime.listProjectBindings());
  ipcMain.handle(
    PythonRuntimeIpc.bindProject,
    (_e, req: PythonProjectBindingRequest): Promise<PythonProjectBindingMutationResult> => pythonRuntime.bindProject(req),
  );
  ipcMain.handle(PythonRuntimeIpc.unbindProject, (_e, projectDir: string) => pythonRuntime.unbindProject(projectDir));
  // 旧版项目目录选择器保留 IPC 兼容；新 UI 直接使用当前空间/任务目录。
  ipcMain.handle(PythonRuntimeIpc.pickProjectDir, async () => {
    const win = BrowserWindow.getFocusedWindow();
    const options: Electron.OpenDialogOptions = {
      title: "选择 Python 项目目录",
      properties: ["openDirectory"],
    };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    return result.filePaths[0];
  });
  ipcMain.handle(PythonRuntimeIpc.pickInterpreter, async (_e, defaultPath?: string) => {
    const win = BrowserWindow.getFocusedWindow();
    const options: Electron.OpenDialogOptions = {
      title: "选择项目自己的 Python 解释器",
      properties: ["openFile"],
      // 不加扩展名过滤：venv 里的解释器在 macOS/Linux 上没有扩展名
      ...(defaultPath ? { defaultPath } : {}),
    };
    const result = win ? await dialog.showOpenDialog(win, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    return result.filePaths[0];
  });
  pythonRuntime.on("progress", (event) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(PythonRuntimeIpc.progress, event);
    }
  });

  /* ------------------- 对话分支（Branch in new task） ------------------- */
  ipcMain.handle(ConversationBranchIpc.preview, (_e, req: CreateConversationBranchRequest) =>
    conversationBranchService.preview(req),
  );
  ipcMain.handle(ConversationBranchIpc.create, async (_e, req: CreateConversationBranchRequest) => {
    const outcome = await conversationBranchService.create(req);
    if (outcome.ok) {
      await agentService.cloneConversationRuntimeHistory(req.sourceTaskId, outcome.result.task.id);
    }
    return outcome;
  });
  ipcMain.handle(ConversationBranchIpc.getInfo, (_e, taskId: string) =>
    conversationBranchService.getInfo(taskId),
  );
  ipcMain.handle(ConversationBranchIpc.listChildren, (_e, taskId: string) =>
    conversationBranchService.listChildren(taskId),
  );
}

app.whenReady().then(async () => {
  // Issue #17 A1: phase marks are opt-in and exit once the required phases are recorded.
  if (startupMarkEnabled()) {
    onStartupReport(() => app.exit(0));
    armStartupReport(() => ({ resume: agentService?.durableResumeReport() ?? null }));
    ipcMain.on("perf:mark", (_event, name) => startupMark(String(name)));
    startupMark("appReady");
  }
  // Windows 专属初始化（AppUserModelID）收在 platform/app.ts；其它平台 no-op。
  applyPlatformAppIdentity(app);

  getMyBuddyDir();
  getPluginStorage();
  try {
    const source = app.isPackaged
      ? join(process.resourcesPath, "builtin-skills", "officecli")
      : join(app.getAppPath(), "scripts", "skill-governance", "payload", "officecli");
    console.log(`[OfficeCLI] skill=${ensureOfficeCliSkill(source, join(getPluginStorage().root, "skills"))}`);
  } catch (error) { console.error("[OfficeCLI] bundled skill unavailable", error); }
  try {
    const assets = ensureExternalCliMemoryAssets();
    if (assets.skill === "created" || assets.cli.created.length > 0 || assets.cli.updated.length > 0) {
      console.log(`[Memory] external CLI assets ready skill=${assets.skill} cliCreated=${assets.cli.created.length} cliUpdated=${assets.cli.updated.length}`);
    }
  } catch (error) {
    // External CLI sharing is additive; asset materialization must never block MyBuddy startup.
    console.warn(`[Memory] external CLI assets unavailable: ${error instanceof Error ? error.message : String(error)}`);
  }
  // TaskExecutionWorkspace 语义纠偏：目录决策先行（幂等迁移/legacy 回退）；
  // 决策结果缓存于 paths 模块，后续 getters 与本次一致。
  const workspacesMigration = migrateLegacyTaskWorkspacesDirs();
  db = new AppDatabase();
  notificationService = new NotificationService(db);
  notificationService.setChangedListener((event) => {
    broadcastToWindows(NotificationIpc.changed, event);
    remoteAccessController?.publishNotificationChanged(event);
  });
  libraryService = new LibraryService(db);
  workspaceLibraryBindingService = new WorkspaceLibraryBindingService(db);
  workGraphService = new WorkGraphService(db);
  // Python 项目模式绑定：运行时服务是模块级单例、早于 DB 创建，故在此后注入。
  // 注入前 resolveForExecution 一律走受管环境，绑定读写返回「尚未就绪」。
  getPythonRuntimeService().setProjectBindingStore(new PythonProjectBindingStore(db.connection));
  // 启动恢复：中断/重启遗留的 Office/PDF 抽取（pending/error/缺 FTS）异步重新入队
  void libraryService.recoverPendingExtractions().catch((err) => {
    console.warn("[Library] 启动抽取恢复失败：", err);
  });
  // FTS v2：只异步重建旧版 200–256 KiB 文本覆盖；checkpoint 后以后启动零成本。
  void libraryService.recoverTextFtsCoverageV2({ batchSize: 20 }).then((result) => {
    if (result.processed > 0) console.log(`[Library] FTS v2 coverage refresh：${JSON.stringify(result)}`);
  }).catch((err) => {
    console.warn("[Library] FTS v2 coverage refresh failed：", err);
  });
  // R2 P2：旧数据 chunk backfill（不阻塞启动：DB migration 仅建表，此处异步分批回填 library_chunks）
  // 恢复边界：extraction 恢复保证 library_fts/extract_status；chunk backfill 保证 library_chunks/FTS，两者互补
  void libraryService.backfillMissingChunks({ batchSize: 20 }).then((r) => {
    if (r.processed > 0) console.log(`[Library] chunk backfill 完成：${JSON.stringify(r)}`);
  }).catch((err) => {
    console.warn("[Library] chunk backfill 失败：", err);
  });
  // R3.4：语义索引 backfill — 模型 ready 时异步分批，pending/crash-resume 由 semantic_index_jobs checkpoint 保证
  // fire-and-forget, bounded, abortable, 不阻塞 ready；模型未安装时 pending 不产 hash
  void libraryService.backfillEmbeddings({ batchSize: 20 }).then((r) => {
    if (r.processed > 0) console.log(`[Library] embedding backfill 完成：${JSON.stringify(r)}`);
  }).catch((err) => {
    console.warn("[Library] embedding backfill 失败：", err);
  });
  libraryProtocol = new LibraryProtocol(libraryService);
  const projectRepository = new ProjectRepository(db.connection);
  const memoryKernel = new MemoryService(db);
  memoryGatewayController = new MemoryGatewayController(db, memoryKernel);
  externalCliMemoryBridge = new ExternalCliMemoryBridge(memoryGatewayController);
  projectService = new ProjectService(projectRepository, memoryKernel);
  projectFolderRelocation = new ProjectFolderRelocation(db, (taskId) => agentService.isTaskBusy(taskId), () => artifactDomainService);
  attentionTracker = new ProjectAttentionTracker(projectService);
  // 时间边界调度：启动从真源重建；边界触发仅重算/收敛（proposal 层 + attention 广播），绝不后台执行
  cadenceEngine = new ProjectCadence(projectService, {
    onBoundary: (projectId) => notifyProjectAttention(projectId),
  });
  cadenceEngine.scheduleAll();
  // 休眠/系统恢复 catch-up：先按当前时间重算全部项目（指纹去重广播，错过边界不丢），再重建未来边界。
  // 不信任旧 timeout（系统睡眠期间 Node timer 不保证按墙钟推进；时钟跳变同样由此收敛）。
  powerMonitor.on("resume", () => {
    cadenceEngine?.catchUp();
    cadenceEngine?.scheduleAll();
    agentService?.onSystemResume();
  });
  powerMonitor.on("suspend", () => {
    agentService?.onSystemSuspend();
  });
  // 外部输入入口层：通用事件契约（source/kind 白名单 + 有界校验），ingest 后仅触发既有收敛
  projectEventIngestor = new ProjectEventIngestor(projectService, {
    onIngested: (projectId) => {
      notifyProjectAttention(projectId);
      broadcastToWindows(DbIpc.projectEventsChanged, { projectId });
    },
  });
  // 事件显式提升（Event Triage / Promotion Loop）：人/Agent 判断后 → 既有真源 service → 派生自然重算
  projectEventPromoter = new ProjectEventPromoter(projectService, libraryService);
  // 文件级文档导入（Library-first：文件入项目资料库真源 + document 事件引用/摘要）
  projectDocumentImporter = new ProjectDocumentImporter(projectService, libraryService, projectEventIngestor);
  projectContextResolver = new ProjectContextResolver(db, projectRepository, memoryKernel);
  // 收口：rename 成功后一次性重绑 DB 中旧根下的 tasks.cwd / trash_path（升级后 UI 直接可用，
  // 无需等待首次 Agent 交互的懒重绑）；legacy 回退 / 新旧并存时 migrated=false，绝不重写。
  if (workspacesMigration.workspacesMigrated || workspacesMigration.trashMigrated) {
    const rebind = db.rebindLegacyTaskWorkspacePaths(
      workspacesMigration.legacyWorkspacesDir,
      workspacesMigration.workspacesDir,
      workspacesMigration.legacyTrashDir,
      workspacesMigration.trashDir,
    );
    console.log(`[index] 任务执行工作区路径重绑完成：cwd=${rebind.cwds}, trash_path=${rebind.trashPaths}`);
  }
  agentService = new AgentService(db);
  // Cards remain available in-app. External effects use the same authority-owned ledger;
  // an unqueryable desktop/Gateway receipt stays unknown across a restart.
  workNotificationHost = new WorkNotificationHost(agentService.getWorkService(), {
    isAuthority: () => agentService.getWorkHostStatus().isAuthority,
    channels: () => notificationService ? [createDesktopWorkChannel(notificationService)] : [],
    asyncChannels: () => workGatewayNotificationChannels?.channels() ?? [],
    intervalMs: 15_000,
    onError: (error) => console.warn("[Work] 通知投递失败", error),
  });
  agentService.setWorkNotificationWake(() => workNotificationHost?.wake());
  workNotificationHost.start();
  computerUseOverlayService.setAbortHandler(async (taskId) => {
    computerUseRunCoordinator.cancel(taskId);
  });
  externalAgentRuntime = new ExternalAgentRuntime(
    db,
    (taskId) => agentService.resolveTaskExecutionWorkspaceCwd(taskId),
    (taskId, messageId, before) =>
      agentService.emitExternalAgentWorkspaceChanges(taskId, messageId, before),
    () => agentService.getAppSettings().disabledExternalAgentIds ?? [],
    {
      readSelections: (agentId) =>
        agentService.getAppSettings().externalAgentConfigSelections?.[agentId] ?? {},
      readOptions: (agentId) =>
        agentService.getAppSettings().externalAgentConfigOptions?.[agentId] ?? [],
      writeOptions: (agentId, options) => {
        const current = agentService.getAppSettings().externalAgentConfigOptions ?? {};
        void agentService.updateAppSettings({
          externalAgentConfigOptions: { ...current, [agentId]: options },
        });
      },
    },
    // ACP 权限策略（ACP 管理页按 Agent 保存）：auto-allow/auto-deny 时不再阻塞等人工点选
    () => agentService.getAppSettings().externalAgentPermissionPolicies ?? {},
  );
  externalAgentRuntime.setSend((event) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(ExternalAgentIpc.event, event);
    }
    remoteAccessController?.publishExternalAgentEvent(event);
  });
  remoteAccessController = new RemoteAccessController(
    db,
    agentService,
    notificationService,
    projectService,
    join(app.getAppPath(), "app", "remote", "dist"),
    externalAgentRuntime,
    () => artifactDomainService,
    // 手机端删除复用桌面端同一条安全回收链路（可恢复，不 rm -rf）。
    // taskLifecycle 在本调用之后才初始化，故在方法体内延迟读取。
    { trash: (id) => {
        if (!taskLifecycle) throw new Error("TaskExecutionWorkspaceLifecycle 尚未初始化");
        return taskLifecycle.trash(id);
      } },
    { cleanupByNode: (kind, id) => workGraphService.cleanupByNode(kind, id) },
  );
  agentService.setTaskLifecycleListener((event) => {
    publishTaskLifecycleNotification({ event, task: db.getTask(event.taskId),
      workRepo: agentService.getWorkService().repo, notifications: notificationService });
  });
  // 用量统计：启动后延迟调度异步分片回填历史 session jsonl + 扫描 subagent 归档
  // （水位+size/mtime 短路；分片让出事件循环，不阻塞启动；失败仅告警）
  try {
    setImmediate(() => {
      void agentService.usageStats
        .backfillAllTasksAsync(agentService.usageStats.listSessionFiles())
        .then(() => {
          try {
            agentService.usageStats.reattributeToMyBuddyModels();
          } catch (err) {
            console.warn(
              `[usage] MyBuddy 模型回写失败: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        })
        .catch((err) => console.warn(`[usage] 启动回填失败: ${err instanceof Error ? err.message : String(err)}`));
      try {
        agentService.usageStats.reattributeToMyBuddyModels();
      } catch (err) {
        console.warn(`[usage] MyBuddy 模型回写失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
    const subagentArchive = join(getMyBuddyDir(), "subagent", "usage-archive.jsonl");
    setImmediate(() => {
      try {
        agentService.usageStats.scanSubagentArchive(subagentArchive);
      } catch (err) {
        console.warn(`[usage] subagent 归档扫描失败: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  } catch (err) {
    console.warn(`[usage] 启动回填调度失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  // 终端宿主：renderer 无目录决定权。
  // · 任务终端 cwd = agentService.resolveTaskExecutionWorkspaceCwd（独立任务 / 隔离目录）
  // · 空间终端 cwd = 空间绑定的真实文件夹（未绑定/不可用直接抛错，不静默回退）
  // Interactive terminal preferences are independent of Pi's Bash shellPath.
  terminalHost = new TerminalHost({
    resolveCwd: (taskId) => agentService.resolveTaskExecutionWorkspaceCwd(taskId),
    resolveWorkspaceCwd: (workspaceId) => {
      const space = db.getSpace(workspaceId);
      if (!space) throw new Error(`工作空间不存在：${workspaceId}`);
      return resolveBoundWorkspaceCwd(space, (p) => {
        try {
          return existsSync(p) && statSync(p).isDirectory();
        } catch {
          return false;
        }
      });
    },
    getShellPath: () => agentService.getAppSettings().terminalShellPath || undefined,
    getIsolationLevel: () => agentService.getShellIsolationLevel(),
    getPathEntries: () => [getMyBuddyBinDir()],
  });
  terminalHost.setSend((channel, payload) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    }
  });
  // P1.5 生命周期：与 Agent/Artifact 解耦的 task-workspaces 目录回收；停 session 后 trash
  const artifactPurgeWarnings = new Map<string, string>();
  taskLifecycle = new TaskExecutionWorkspaceLifecycle({
    db,
    workspace: new TaskExecutionWorkspace(),
    beforeTrash: async (taskId, options) => {
      if (options?.strict && externalAgentRuntime?.hasLiveTaskRun(taskId)) {
        throw new Error("外部 Agent 正在运行，请先停止后再彻底删除");
      }
      // Ordinary trash retains lifecycle's best-effort handling; explicit archive purge uses strict shutdown.
      const errors: string[] = [];
      cronService?.disableTask(taskId);
      try { await agentService.releaseTaskForDeletion(taskId); }
      catch (error) { errors.push(`任务会话：${error instanceof Error ? error.message : String(error)}`); }
      // 终端：任务删除/归档 → kill 该任务 PTY（cwd 即将移入回收区）
      try { terminalHost?.close({ taskId }); }
      catch (error) { errors.push(`任务终端：${error instanceof Error ? error.message : String(error)}`); }
      if (errors.length) throw new Error(errors.join("；"));
    },
    onPurgeArtifacts: async (taskId) => {
      const warning = artifactPurgeCleanupWarning(await artifactDomainService?.removeByTask(taskId));
      artifactPurgeWarnings.delete(taskId);
      if (warning) artifactPurgeWarnings.set(taskId, warning);
    },
    onPurge: async (taskId) => {
      const artifactWarning = artifactPurgeWarnings.get(taskId);
      artifactPurgeWarnings.delete(taskId);
      const errors: string[] = artifactWarning ? [artifactWarning] : [];
      const cleanup = async (label: string, operation: () => unknown | Promise<unknown>) => {
        try { await operation(); }
        catch (error) { errors.push(`${label}：${error instanceof Error ? error.message : String(error)}`); }
      };
      // Durable history shares the task's trash/restore lifecycle, then goes away only on permanent deletion.
      await cleanup("Durable 历史", () => agentService.purgeDurableTask(taskId));
      // 永久删除时清理任务级配置（settings.json taskConnectorIds）；trash/restore 阶段保留
      await cleanup("任务连接器配置", () => agentService.clearTaskConnectorIds(taskId));
      // Skill readiness uses distinct completed-task support. Purge has already removed the task/L0 evidence,
      // so recalculate candidates now; installed learned Skills remain untouched and require explicit re-approval.
      await cleanup("记忆技能候选", () => agentService.refreshKernelMemorySkillCandidates());
      // Task Gadget 与回收/恢复同寿命：只在永久 purge 后清理，不在 trash 时误删。
      await cleanup("任务 Gadget", () => gadgetService?.deleteByTask(taskId));
      // 远程上传附件目录（userData/remote-uploads/<taskId>）与任务同寿命
      await cleanup("远程上传附件", () => cleanupRemoteUploads(taskId));
      await cleanup("任务关联", () => workGraphService.cleanupByNode("task", taskId));
      if (errors.length) throw new Error(errors.join("；"));
    },
  });
  archivedContentDeletion = new ArchivedContentDeletion({
    db,
    lifecycle: taskLifecycle,
    afterDeleteSpace: async (spaceId) => {
      terminalHost?.close({ workspaceId: spaceId });
      memoryKernel.detachAllInScope("workspace", spaceId);
      workGraphService.cleanupByNode("workspace", spaceId);
      await gadgetService.deleteByWorkspace(spaceId);
    },
    afterDeleteTask: (task, sessionFiles) => {
      memoryKernel.detachAllInScope("task", task.id);
      for (const sessionFile of sessionFiles) {
        removeManagedTaskSession(db, { ...task, sessionFile }, join(process.env.PI_CODING_AGENT_DIR || getMyBuddyDir(), "sessions"));
      }
    },
  });
  // 回收区超期清理：启动后延迟一次 + 每 6 小时一次。此前 purgeAfter 只写不读（purgeExpired 无调用者），
  // 删除的任务会永久留在磁盘上。保留期见 shared/archive-deletion.ts 的 TRASH_RETENTION_DAYS。
  const purgeExpiredTrash = async (trigger: string): Promise<void> => {
    if (!taskLifecycle) return;
    try {
      // 策略变更后先对齐存量保留期（只缩短），否则旧的 30 天期限会让存量继续滞留。
      if (trigger === "startup") {
        const aligned = taskLifecycle.alignTrashRetention();
        if (aligned > 0) console.log(`[trash] 已按 ${TRASH_RETENTION_DAYS} 天保留期对齐 ${aligned} 个存量回收条目`);
      }
      const projectIds = new Map(db.listTasks().map((task) => [task.id, task.projectId]));
      const results = await taskLifecycle.purgeExpired();
      const purged = results.filter((result) => result.removedTaskRow).map((result) => result.taskId);
      if (purged.length === 0) return;
      console.log(`[trash] purgeExpired(${trigger}): 永久清理 ${purged.length} 个超期任务`);
      for (const projectId of new Set(purged.map((id) => projectIds.get(id)).filter(Boolean) as string[])) {
        broadcastToWindows(DbIpc.projectTaskChanged, { projectId });
        notifyProjectAttention(projectId);
      }
    } catch (error) {
      console.warn(`[trash] purgeExpired(${trigger}) 失败`, error);
    }
  };
  setInterval(() => void purgeExpiredTrash("interval"), 6 * 60 * 60 * 1000).unref();
  setTimeout(() => void purgeExpiredTrash("startup"), 5_000).unref();
  professionalToolService = new ProfessionalToolRuntimeService({
    providerEnabled: (providerId) =>
      mcpService
        .listServers()
        .some((server) => server.name === providerId && server.installed && !server.disabled),
    ops: {
      openExternal: async (url) => {
        await shell.openExternal(url);
      },
      openInApp: async (url) => {
        // 应用内扩展栏浏览器：先导航，再通知渲染层打开浏览器面板（App.tsx 常驻监听 openRequest）
        browserHost.open(url);
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) win.webContents.send(BrowserIpc.openRequest, { url });
        }
      },
    },
  });
  agentService.setProfessionalToolRuntime(professionalToolService);
  // runtime requirement 状态 push：主进程广播到所有窗口（renderer 事件驱动展示）
  agentService.setRuntimeStateListener((state) => {
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(AgentIpc.runtimeRequirementStateChanged, state);
      }
    }
    if (state.phase === "failed") {
      notificationService.publish({
        type: "runtime.failed",
        level: "error",
        title: "运行环境启动失败",
        body: `${state.providerId}${state.detail ? ` · ${state.detail}` : ""}`,
        sourceType: "runtime",
        sourceId: state.providerId,
        dedupeKey: `runtime:${state.providerId}:failed:${state.lastReadyAt ?? "never"}:${state.detail ?? "unknown"}`,
      });
    }
  });
  // Draw.io AI：启动自愈（npx 可解析且条目缺失/过期时写入，用户停用不覆盖）
  void professionalToolService
    .drawioMcpPayload()
    .then((payload) => {
      if (!payload) return;
      const result = mcpService.ensureDrawioServer(payload);
      if (!result.ok) console.warn("[Drawio] MCP 条目自愈失败", result.error);
    })
    .catch((error) => console.warn("[Drawio] MCP 条目自愈异常", error));
  // 4D：SelectionStore 装配（唯一 Selection truth；纯数据，无 CDP 引用）
  selectionStore = new SelectionStore();
  selectionPopover = new SelectionPopover(() => selectionStore!.getState());
  htmlEditService = new HtmlEditService({
    draftDir: join(getMyBuddyDir(), "html-edit-drafts"),
    resolve: (request) => {
      const surface = request.target === "browser" ? browserHost.captureSurface : artifactPreviewHost.captureSurface;
      if (!surface || (request.target === "browser" ? !browserHost.visible : !surface.view.getVisible())) throw new Error("请先打开要编辑的 HTML 页面");
      if (request.target === "browser") return surface;
      const active = surfaceCoordinator.getState(SURFACE_MAIN);
      if (!request.artifactId || active?.artifactId !== request.artifactId) throw new Error("产物已切换，请重新进入编辑");
      const previewUrl = new URL(surface.view.webContents.getURL());
      if (previewUrl.protocol !== "mybuddy-artifact:" || previewUrl.pathname !== `/${encodeURIComponent(request.artifactId)}/`) throw new Error("请返回产物入口页后编辑；内部子页面暂不支持写回");
      const artifact = artifactDomainService?.get(request.artifactId);
      const path = artifactDomainService?.entryPathOf(request.artifactId);
      if (!artifact || artifact.kind !== "html" || !path) throw new Error("HTML 产物源文件不可用");
      return { ...surface, artifactId: artifact.id, path, version: artifact.version };
    },
    exitCapture: () => { captureModeController?.exit(); browserHost.exitCapture(); selectionPopover?.close(false); },
    contentSaved: (path) => artifactDomainService?.notifyHtmlSaved(path),
    ai: (modelId, html, instruction, signal) => agentService.proposeHtmlEdit(modelId, html, instruction, signal),
  });
  ipcMain.handle(HtmlEditIpc.start, (event, request: HtmlEditStart) => htmlEditService!.start(request, event.sender));
  ipcMain.handle(HtmlEditIpc.stop, async (event) => {
    const surface = browserHost.captureSurface ?? artifactPreviewHost.captureSurface;
    if (surface?.window.webContents === event.sender) await htmlEditService?.stop();
  });
  const showSelectionPopover = (descriptor: import("../shared/capture-mode").SelectionDescriptor, editing = false): void => {
    const isBrowser = descriptor.artifactId === BROWSER_CAPTURE_ARTIFACT_ID;
    const surface = isBrowser ? browserHost.captureSurface : artifactPreviewHost.captureSurface;
    if (!surface) return;
    void selectionPopover?.show({
      ...surface,
      selection: descriptor,
      resume: () => { void (isBrowser ? browserHost.resumeCapture() : captureModeController?.startInspect())?.catch(() => undefined); },
      attach: (comment) => surface.window.webContents.send(SelectionEvent.attach, { selection: descriptor, comment }),
    }, editing);
  };
  reopenSelectionComment = () => {
    const current = selectionStore?.getState();
    if (current?.status === "active" && current.descriptor) {
      const descriptor = current.descriptor;
      const pause = descriptor.artifactId === BROWSER_CAPTURE_ARTIFACT_ID ? browserHost.pauseCapture() : captureModeController?.stopInspect();
      void Promise.resolve(pause).then(() => showSelectionPopover(descriptor, true)).catch(() => undefined);
    }
  };
  selectionStore.onChange((state) => {
    selectionPopover?.invalidate(state);
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(SelectionEvent.changed, { state });
      }
    }
  });
  // 4E：PromptContextService 装配（依赖 Domain 合法读取路径 + SelectionStore）
  // Workspace Shared Context（Phase 2B）：memories 复用 + 分层 digest 注入 prompt chain（最小接入，保持其它上下文顺序）
  workspaceSharedContextService = new WorkspaceSharedContextService(db);
  promptContextService = new PromptContextService({
    getArtifact: (artifactId) => {
      if (artifactId === BROWSER_CAPTURE_ARTIFACT_ID && browserHost.url) {
        return {
          id: BROWSER_CAPTURE_ARTIFACT_ID,
          taskId: BROWSER_CAPTURE_ARTIFACT_ID,
          kind: "html",
          source: { type: "managed-content", storagePath: "", rootDir: "" },
          version: browserHost.captureVersion,
          capabilities: { capture: true, externalUrl: true },
          title: browserHost.url,
          mimeType: "text/html",
          createdAt: 0,
          updatedAt: Date.now(),
        };
      }
      return artifactDomainService?.get(artifactId) ?? null;
    },
    readContent: async (artifactId) => {
      if (artifactId === BROWSER_CAPTURE_ARTIFACT_ID) {
        const content = await browserHost.readDocumentHtml();
        return content === null
          ? null
          : { content, language: "text/html", kind: "html", path: browserHost.url };
      }
      return artifactDomainService?.readContent(artifactId) ?? null;
    },
    getSelection: () => selectionStore?.getState() ?? { descriptor: null, status: "empty", updatedAt: 0 },
    resolveSelection: (ref) => selectionStore?.resolveSelection(ref) ?? null,
    getWorkspaceSharedContext: (artifactId) => {
      try {
        // 统一 memoryEnabled 门控：两条链语义一致，复用 settings 真相，不引入第二开关
        if (!agentService.getAppSettings().memoryEnabled) return null;
        if (artifactId === BROWSER_CAPTURE_ARTIFACT_ID) return null;
        if (!workspaceSharedContextService) return null;
        const artifact = artifactDomainService?.get(artifactId) as { taskId?: string } | null | undefined;
        const taskId = artifact?.taskId ?? null;
        // standalone / missing artifact -> no workspace context (真实 AppDatabase 链路)
        if (!taskId) return null;
        const taskRow = db.getTask(taskId) as { spaceId?: string | null } | undefined;
        const spaceId = taskRow?.spaceId ?? null;
        // artifact→task→space 真实链路：artifact 无 taskId 或 task 无 space 视为 standalone，仅 task 级（当前为空）
        return workspaceSharedContextService.getDigestForTask(taskId, spaceId);
      } catch {
        return null;
      }
    },
  });
  // 「加入聊天」闭环：发送时 AgentService 经 collectForChat 解析 selection 引用
  agentService.setSelectionContextResolver((refs) =>
    promptContextService ? promptContextService.collectManyForChat(refs) : Promise.resolve(null),
  );
  // Artifact Domain 装配（双系统施工态收口：3C 后 Agent 产物创建/刷新已回 Domain）
  // extraSink：artifact updated/removed → SelectionStore（4D stale/clear 事件源）
  artifactDomain = createArtifactDomain(db.connection, {
    created: (e) => remoteAccessController?.publishArtifactChanged(e.taskId),
    updated: (e) => { selectionStore?.onArtifactUpdated(e); remoteAccessController?.publishArtifactChanged(e.taskId); },
    removed: (e) => { selectionStore?.onArtifactRemoved(e); remoteAccessController?.publishArtifactChanged(e.taskId); },
  });
  artifactDomainService = artifactDomain.service;
  // Construct only after the real Artifact Domain exists; never capture undefined.
  conversationBranchService = new ConversationBranchService({
    db,
    agent: agentService,
    brancher: new TaskWorkspaceBrancher(),
    artifactService: artifactDomainService,
  });
  agentService.setArtifactDomain(artifactDomain.service, artifactDomain.coordinator);
  // Gadget 独立 Domain：SQLite descriptor truth + durable storage + Main-owned runtime。
  const gadgetRepository = new GadgetRepository(db.connection);
  const gadgetStorage = new GadgetStorage(getGadgetsDir());
  const gadgetRegistry = new GadgetRegistry();
  const gadgetRuntime = new GadgetRuntime(gadgetStorage, gadgetRegistry, (state) => {
    broadcastToWindows(GadgetIpc.changed, { type: "runtime", gadgetId: state.gadgetId });
  });
  gadgetService = new GadgetService({
    repository: gadgetRepository,
    storage: gadgetStorage,
    registry: gadgetRegistry,
    runtime: gadgetRuntime,
    workspaceExists: (id) => Boolean(db.getSpace(id)),
    workspaceEffectiveArchived: (id) => db.getSpace(id)?.effectiveArchived === true,
    taskExists: (id) => Boolean(db.getTask(id)),
    taskWorkspaceId: (id) => db.getTask(id)?.spaceId ?? null,
    workspaceAncestors: (id) => db.getSpaceAncestors(id).filter((space) => !space.effectiveArchived).map((space) => space.id),
    onChanged: (event) => broadcastToWindows(GadgetIpc.changed, event),
    artifacts: {
      read: async (artifactId) => {
        const descriptor = artifactDomainService.get(artifactId);
        const content = await artifactDomainService.readContent(artifactId);
        if (!descriptor || !content) return null;
        return { taskId: descriptor.taskId, title: descriptor.title ?? "HTML Gadget", kind: descriptor.kind, content: content.content };
      },
      write: async ({ taskId, title, content }) => {
        const artifact = await artifactDomainService.register({ taskId, kind: "html", title, content });
        return { artifactId: artifact.id };
      },
    },
  });
  agentService.setGadgetDomain(gadgetService);
  // Blueprint 复用 project-template capability resolver，并仅协调既有 Workspace/Task/Library/Gadget 服务。
  blueprintService = new BlueprintService({
    repository: new BlueprintRepository(db.connection),
    resolver: new BlueprintResolver(),
    planner: new BlueprintInstantiationPlanner(),
    db,
    gadgetService,
    libraryBindings: workspaceLibraryBindingService,
    memoryService: memoryKernel,
    librarySpaceExists: (id) => Boolean(libraryService.getSpace(id)),
    workspaceInstancesRoot: getBlueprintWorkspaceInstancesDir(),
    onChanged: (event) => broadcastToWindows(BlueprintIpc.changed, event),
  });
  // 4B：WebArtifactRuntime + ArtifactProtocol 装配——资源解析唯一入口是 Domain
  // （ArtifactSourceResolver 注入；PreviewHost 不再接触 resolver/协议/磁盘路径）
  artifactRuntime = new WebArtifactRuntime({
    filePathOf: (artifactId) => {
      const descriptor = artifactDomainService?.get(artifactId);
      return descriptor?.source.type === "workspace-file" ? descriptor.source.entryFile : null;
    },
    contentOf: async (artifactId) => {
      const descriptor = artifactDomainService?.get(artifactId);
      if (!descriptor) return null;
      // workspace-file：入口即磁盘文件，返回 null 让 Runtime 走 filePathOf 读盘
      if (descriptor.source.type === "workspace-file") return null;
      const content = await artifactDomainService.readContent(artifactId);
      return content?.content ?? null;
    },
    rootOf: (artifactId) => artifactDomainService?.rootOf(artifactId) ?? null,
  });
  artifactProtocol = new ArtifactProtocol(artifactRuntime, async (artifactId, variant) =>
    artifactDomainService?.readImageVariant(artifactId, variant) ?? null,
  );
  // 4D：surface generation 变化（load/reload/close）→ SelectionStore stale 事件源
  surfaceCoordinator.onSurfaceChanged((info) => {
    htmlEditService?.invalidate("artifact");
    if (selectionStore?.getState().descriptor?.artifactId === BROWSER_CAPTURE_ARTIFACT_ID) return;
    selectionStore?.onSurfaceChanged(info);
  });
  browserHost.onSurfaceChanged = (change) => {
    htmlEditService?.invalidate("browser");
    if (selectionStore?.getState().descriptor?.artifactId !== BROWSER_CAPTURE_ARTIFACT_ID) return;
    selectionStore?.validateAgainst({
      artifactId: BROWSER_CAPTURE_ARTIFACT_ID,
      artifactVersion: change.generation,
      surfaceGeneration: change.generation,
      surfaceClosed: change.reason === "close" || change.reason === "destroy",
    });
  };
  browserHost.onCaptureStateChanged = (state, error) => {
    if (state === "exited" || state === "error") selectionPopover?.close(false);
    for (const win of BrowserWindow.getAllWindows()) {
      if (!win.isDestroyed()) {
        win.webContents.send(CaptureModeEvent.state, {
          state,
          artifactId: BROWSER_CAPTURE_ARTIFACT_ID,
          error,
        });
      }
    }
  };
  browserHost.onSelection = (descriptor) => {
    selectionStore?.setSelection(descriptor);
    showSelectionPopover(descriptor);
  };
  // 4C：Capture Mode 状态机装配（依赖 4A Coordinator + PreviewHost debugger + Domain version）
  captureModeController = new CaptureModeController(
    {
      addBlocker: (token) => surfaceCoordinator.addBlocker(SURFACE_MAIN, token),
      removeBlocker: (token) => surfaceCoordinator.removeBlocker(SURFACE_MAIN, token),
      getWebContents: () => artifactPreviewHost.webContentsView?.webContents ?? null,
      getArtifactVersion: (artifactId) => artifactDomainService?.get(artifactId)?.version ?? null,
      getSurfaceGeneration: () => surfaceCoordinator.getState(SURFACE_MAIN)?.generation ?? 0,
      onSurfaceChanged: (listener) =>
        surfaceCoordinator.onSurfaceChanged((info) =>
          listener({ generation: info.generation, artifactId: info.artifactId, reason: info.reason }),
        ),
    },
    {
      onStateChange: (state, artifactId, error) => {
        if (state === "exited" || state === "error") selectionPopover?.close(false);
        for (const win of BrowserWindow.getAllWindows()) {
          if (!win.isDestroyed()) {
            win.webContents.send(CaptureModeEvent.state, { state, artifactId, error });
          }
        }
      },
      onSelection: (descriptor) => {
        // 4D：唯一写入源 = SelectionStore（store 经 selection:changed 广播投影；
        // 不再发 CaptureModeEvent.selection 双通道，避免多份 truth）
        selectionStore?.setSelection(descriptor);
        showSelectionPopover(descriptor);
      },
    },
  );
  // 3B.2：legacy artifact 数据源（session jsonl + artifact-index.json），首次 hydrate 时一次性迁移
  artifactLegacySource = {
    loadLegacyArtifacts: async (taskId) => {
      const row = db.listTasks().find((t) => t.id === taskId);
      if (!row?.sessionFile) return null;
      const history = await agentService.loadTaskHistory(taskId);
      return { artifacts: history.artifacts ?? [], cwd: history.cwd };
    },
  };
  cronService = new CronService(
    db,
    agentService,
    (projectId, summary) => {
      // 第二真实 source adapter：project-bound 定时任务完成/失败 → 项目事件（摘要+stable ref；不触发 promotion）
      try {
        projectEventIngestor.ingest(projectId, cronRunEventInput(summary));
      } catch (err) {
        console.warn(`[index] 定时任务事件投递失败 ${projectId}：`, err);
      }
    },
    (summary) => {
      notificationService.publish({
        type: summary.status === "success" ? "automation.completed" : "automation.failed",
        level: summary.status === "success" ? "success" : "error",
        title: summary.status === "success" ? "自动化已完成" : "自动化执行失败",
        body: `${summary.jobName}${summary.error ? ` · ${summary.error}` : ""}`,
        sourceType: "automation",
        sourceId: summary.jobId,
        taskId: summary.taskId,
        projectId: summary.projectId,
        dedupeKey: `automation:${summary.jobId}:run:${summary.runId}:terminal`,
      });
    },
  );
  // 外部输入适配器（首个：IM/Gateway 投递指令 `@项目 <名>：内容` → 项目事件；fail-open）
  gatewayService = new GatewayService(db, agentService, (msg) => {
    const directive = parseProjectMessageDirective(msg.text);
    if (!directive) return;
    const project = projectService.resolveProjectByName(directive.projectName);
    if (!project) return;
    try {
      projectEventIngestor.ingest(project.id, {
        source: "gateway",
        kind: "message",
        title: `外部消息（${msg.senderName ?? msg.channelId}）`,
        body: directive.content || undefined,
        ref: msg.messageId,
      });
    } catch (err) {
      console.warn(`[index] 项目事件投递失败 ${project.id}：`, err);
    }
  });
  workGatewayNotificationChannels = new WorkGatewayNotificationChannels(db.connection, agentService.getWorkService(), gatewayService, {
    isAuthority: () => agentService.getWorkHostStatus().isAuthority,
  });
  gatewayService.setWorkNotificationWake(() => workNotificationHost?.wake());
  workNotificationHost.wake();
  gatewayService.setTrashedWorkspaceRestorer((taskId) => {
    taskLifecycle.restore(taskId);
  });
  agentService.setLocalWorkflowServices({ cron: cronService, terminal: new TaskTerminalService(terminalHost) });
  await agentService.init();
  // User-requested design retirement: use the same recoverable deletion as the task UI.
  for (const legacy of db.listTasks().filter(task => (task.welcomeMode as string) === "design")) {
    if (db.getTaskExecutionWorkspaceState(legacy.id)?.state !== "trashed") await taskLifecycle.trash(legacy.id);
  }
  registerIpc();
  // Subagent 是编译内建能力：直接把 backend 接入稳定 IPC host，不扫描用户目录。
  try {
    installBuiltinSubagentIpc();
    agentService.builtinCapabilities.setSubagentAvailable(true);
  } catch (err) {
    console.warn(`[index] 内建 Subagent IPC 初始化失败: ${err instanceof Error ? err.message : String(err)}`);
  }
  // 产物预览协议路由（4B：protocol.handle 只挂 ArtifactProtocol → WebArtifactRuntime）
  artifactProtocol?.register();
  libraryProtocol?.register();

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: "编辑",
        submenu: [
          { role: "undo", label: "撤销" },
          { role: "redo", label: "重做" },
          { type: "separator" },
          { role: "cut", label: "剪切" },
          { role: "copy", label: "复制" },
          { role: "paste", label: "粘贴" },
          { role: "selectAll", label: "全选" },
        ],
      },
      {
        label: "窗口",
        submenu: [
          { role: "minimize", label: "最小化" },
          { role: "zoom", label: "缩放" },
          { role: "reload", label: "重新加载" },
          { role: "toggleDevTools", label: "开发者工具" },
        ],
      },
      {
        label: "帮助",
        submenu: [{ role: "about", label: "关于 MyBuddy" }],
      },
    ]),
  );
  createWindow();
  await agentService.resumePersistedTasks();
  startupMark("restoreDelivered");
  cronService.start();
  startupMark("cronReady");
  // 启动时恢复上次已连接的 IM 通道（Telegram 长轮询 / 飞书 / 企微 / 微信）
  void gatewayService.restoreChannels().finally(() => startupMark("gatewayRestored"));
  if (memoryGatewayController) {
    try {
      const status = await memoryGatewayController.start();
      if (status.running) {
        console.log(`[MemoryGateway] listening ${status.mcpUrl} (${status.writeEnabled ? "read-write" : "read-only"})`);
      }
      startupMark("memoryGatewayReady");
    } catch (error) {
      console.warn(`[MemoryGateway] 启动失败，MyBuddy 将继续运行：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (remoteAccessController) {
    try {
      const status = await remoteAccessController.start();
      if (status.running) console.log(`[RemoteAccess] listening http://127.0.0.1:${status.port}`);
      startupMark("remoteAccessReady");
    } catch (error) {
      console.warn(`[RemoteAccess] 启动失败，MyBuddy 将继续运行：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    } else {
      trayService?.showMainWindow();
    }
  });
});

app.on("child-process-gone", (_event, details) => {
  if (details.type !== "GPU" && details.type !== "Utility") return;
  console.error("[process] child-process-gone", details);
  // 应用正在退出时子进程随之结束是正常现象：写日志即可，不触发用户通知。
  if (quitCleanupPromise || quitCleanupComplete) {
    runtimeLogger.warn("process", `child-process-gone during shutdown：type=${details.type} reason=${details.reason} exitCode=${details.exitCode}`);
    return;
  }
  reportProcessGone("child", details);
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.isDestroyed() || win.webContents.isDestroyed()) continue;
    win.webContents.invalidate();
  }
});

app.on("window-all-closed", () => {
  // 托盘存活时驻留后台，不退出；macOS 始终驻留。平台差异收在 platform/lifecycle.ts。
  if (shouldQuitOnAllWindowsClosed({ suppressQuit: trayService?.shouldSuppressQuit() ?? false })) app.quit();
});

app.on("before-quit", (event) => {
  if (quitCleanupComplete) return;
  event.preventDefault();
  if (quitCleanupPromise) return;
  quitCleanupPromise = (async () => {
    try { browserHost.dispose(); } catch { /* best effort */ }
    try { trayService?.dispose(); } catch { /* best effort */ }
    try { cronService?.stop(); } catch { /* best effort */ }
    try { cadenceEngine?.shutdown(); } catch { /* best effort */ }
    try { surfaceCoordinator.dispose(); } catch { /* best effort */ }
    try { captureModeController?.dispose(); } catch { /* best effort */ }
    try { artifactPreviewHost.dispose(); } catch { /* best effort */ }
    try { terminalHost?.dispose(); } catch { /* best effort */ }
    try { professionalToolService?.stopOwned(); } catch { /* best effort */ }
    try { externalAgentRuntime?.dispose(); } catch { /* best effort */ }
    try { computerUseOverlayService.dispose(); } catch { /* best effort */ }
    try { await workNotificationHost?.close(); } catch { /* best effort */ }
    try { agentService?.setWorkNotificationWake(undefined); } catch { /* best effort */ }
    try { gatewayService?.setWorkNotificationWake(undefined); } catch { /* best effort */ }
    try { await gatewayService?.suspend(); } catch { /* best effort */ }
    try { await agentService?.closeDurableBots(); } catch { /* best effort */ }
    try { agentService?.dispose(); } catch { /* best effort */ }
    // Gadget 进程必须真正退出后才关闭 DB / 允许 Electron 结束。
    // 退出路径不得因参数列表求值失败产生未处理 rejection（同函数其余 cleanup 均已包 try/catch）。
    try {
      await Promise.allSettled([
        gatewayService?.stop(),
        memoryGatewayController?.stop(),
        remoteAccessController?.dispose(),
        gadgetService?.disposeAll(),
        computerAutomationService.shutdown(),
      ].filter((pending): pending is Promise<void> => Boolean(pending)));
    } catch { /* best effort */ }
    try { db?.close(); } catch { /* best effort */ }
  })().finally(() => {
    quitCleanupComplete = true;
    app.quit();
  });
});
