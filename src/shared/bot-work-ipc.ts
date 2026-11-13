import type {
  AttestCriteriaParams,
  BotDto,
  BotExpertVersionDto,
  RecordUserFeedbackParams,
  WorkControlResult,
  WorkProjectionDto,
} from "./bot-work";
import type { BotSendRequest, BotSendReceipt, BotHistoryRequest, BotHistoryDto, WorkListRequest, WorkListUpdate } from "./bot-conversation";
import type { WorkPhase3ControlRequest, WorkPhase3ControlResult } from "./bot-work-phase3-control";
import type { WorkPhase4ControlRequest, WorkPhase4ControlResult } from "./bot-work-phase4";
import type { WorkReviewControlRequest } from "./bot-work-review";
import type { WorkClosureReviewRequest } from "./work-closure-review";
import type { BotCreateRequest, BotCreateResult } from "./bot-create";
import type { WorkTeamControlRequest, WorkTeamControlResult } from "./bot-work-team";
export type { BotCreateRequest, BotCreateResult, BotCreateErrorCode } from "./bot-create";
import type {
  WorkCardReadRequest, WorkCardReadResult, WorkDiagnosticsRequest, WorkExpandedDiagnosticsDto,
  WorkManualResendRequest, WorkSummaryProjectionDto,
} from "./bot-work-phase5";

export const BotWorkIpc = {
  getSettings: "bot-work:get-settings",
  saveSettings: "bot-work:save-settings",
  hostStatus: "bot-work:host-status",
  listBots: "bot-work:list-bots",
  createBot: "bot-work:create-bot",
  renameBot: "bot-work:rename-bot",
  deleteBot: "bot-work:delete-bot",
  updateWorkspaceAuthorization: "bot-work:update-workspace-authorization",
  teamControl: "bot-work:team-control",
  listBotExpertVersions: "bot-work:list-bot-expert-versions",
  adoptBotExpertVersion: "bot-work:adopt-bot-expert-version",
  listWorks: "bot-work:list-works",
  queryWorks: "bot-work:query-works",
  workIndicators: "bot-work:work-indicators",
  syncWorks: "bot-work:sync-works",
  sendMessage: "bot-work:send-message",
  history: "bot-work:history",
  collaborations: "bot-work:collaborations",
  collaborationHistory: "bot-work:collaboration-history",
  activeRequests: "bot-work:active-requests",
  displayGroups: "bot-work:display-groups",
  workspaceNavigation: "bot-work:workspace-navigation",
  messageChanged: "bot-work:message-changed",
  cancelSend: "bot-work:cancel-send",
  archiveConversation: "bot-work:archive-conversation",
  getWork: "bot-work:get-work",
  attestCriteria: "bot-work:attest-criteria",
  recordUserFeedback: "bot-work:record-user-feedback",
  markNotificationRead: "bot-work:mark-notification-read",
  markCardRead: "bot-work:mark-card-read",
  workSummary: "bot-work:work-summary",
  executionDiagnostics: "bot-work:execution-diagnostics",
  workDiagnostics: "bot-work:work-diagnostics",
  resendNotification: "bot-work:resend-notification",
  reviewControl: "bot-work:review-control",
  reassessClosedWork: "bot-work:reassess-closed-work",
  phase3Control: "bot-work:phase3-control",
  phase4Control: "bot-work:phase4-control",
} as const;

export interface BotWorkHostStatusDto {
  online: boolean;
  isAuthority: boolean;
  authorityId: string;
}

/** Truthful, unscoped counters for the Bot directory. They mirror the personal
 * (Bot) and team Work tabs; archived and deleted records are not counted. */
export interface BotWorkIndicatorDto {
  active: number;
  completed: number;
}

export interface BotWorkIndicatorsDto {
  bots: Record<string, BotWorkIndicatorDto>;
  teams: Record<string, BotWorkIndicatorDto>;
}

export interface BotExpertAdoptionResult {
  ok: boolean;
  code?: string;
  message?: string;
  adoptedVersion?: number;
}

export interface BotWorkNotificationReadResult {
  ok: boolean;
  message?: string;
}

export interface BotWorkApi {
  avatars(request: import("./bot-avatar").BotAvatarCommand): Promise<import("./bot-avatar").BotAvatarResult>;
  getSettings(botId: string): Promise<import("./bot-settings").BotSettingsView>;
  saveSettings(request: import("./bot-settings").BotSettingsSaveRequest): Promise<import("./bot-settings").BotSettingsResult>;
  hostStatus(): Promise<BotWorkHostStatusDto>;
  listBots(): Promise<BotDto[]>;
  renameBot(request: import("./bot-create").BotRenameRequest): Promise<BotCreateResult>;
  createBot(request: BotCreateRequest): Promise<BotCreateResult>;
  deleteBot(request: { botId: string; expectedUpdatedAt: number }): Promise<BotCreateResult>;
  updateWorkspaceAuthorization(request: import("./bot-create").BotWorkspaceAuthorizationRequest): Promise<BotCreateResult>;
  teamControl(request: WorkTeamControlRequest): Promise<WorkTeamControlResult>;
  listBotExpertVersions(botId: string): Promise<BotExpertVersionDto[]>;
  adoptBotExpertVersion(botId: string, expected: { pendingVersion: number; snapshotId: string }): Promise<BotExpertAdoptionResult>;
  listWorks(includeClosed?: boolean): Promise<WorkProjectionDto[]>;
  queryWorks(request: import("./bot-work-query").WorkQueryRequest): Promise<import("./bot-work-query").WorkQueryResult>;
  workIndicators(): Promise<BotWorkIndicatorsDto>;
  syncWorks(request: WorkListRequest): Promise<WorkListUpdate>;
  sendMessage(request: BotSendRequest): Promise<BotSendReceipt>;
  history(request: BotHistoryRequest): Promise<BotHistoryDto>;
  collaborations(request: import("./bot-collaboration").BotCollaborationsQuery): Promise<import("./bot-collaboration").BotCollaborationsPage>;
  collaborationHistory(request: import("./bot-collaboration").BotCollaborationHistoryQuery): Promise<import("./bot-collaboration").BotCollaborationHistoryPage & { work?: WorkProjectionDto }>;
  displayGroups(request: import("./bot-display-groups").BotDisplayGroupCommand): Promise<import("./bot-display-groups").BotDisplayGroups>;
  workspaceNavigation(): Promise<import("./bot-workspace-navigation").BotWorkspaceNavigationDto>;
  activeRequests(): Promise<import("./bot-conversation").BotActiveRequestDto[]>;
  onMessageChanged?(listener: (event: import("./bot-conversation").BotMessageEvent) => void): () => void;
  cancelSend(botId: string, requestId: string): Promise<void>;
  archiveConversation(botId: string, conversationId: string): Promise<void>;
  getWork(workId: string): Promise<WorkProjectionDto | undefined>;
  attestCriteria(request: AttestCriteriaParams): Promise<WorkControlResult>;
  recordUserFeedback(request: RecordUserFeedbackParams): Promise<WorkControlResult>;
  markNotificationRead(notificationId: string): Promise<BotWorkNotificationReadResult>;
  /** Read facts only: never a Work control version or a new execution. */
  markCardRead(request: WorkCardReadRequest): Promise<WorkCardReadResult>;
  workSummary(workId: string): Promise<WorkSummaryProjectionDto | undefined>;
  executionDiagnostics(request: import("./bot-execution-diagnostics").BotExecutionDiagnosticsRequest): Promise<import("./bot-execution-diagnostics").BotExecutionDiagnosticsDto>;
  workDiagnostics(request: WorkDiagnosticsRequest): Promise<WorkExpandedDiagnosticsDto | undefined>;
  /** Explicit user-authorized resend of a delivery whose external outcome is unknown. */
  resendNotification(request: WorkManualResendRequest): Promise<WorkControlResult>;
  reviewControl(request: WorkReviewControlRequest): Promise<WorkControlResult>;
  reassessClosedWork(request: WorkClosureReviewRequest): Promise<WorkControlResult>;
  phase3Control(request: WorkPhase3ControlRequest): Promise<WorkPhase3ControlResult>;
  phase4Control(request: WorkPhase4ControlRequest): Promise<WorkPhase4ControlResult>;
}
