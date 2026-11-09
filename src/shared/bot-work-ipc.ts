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
import type { BotCreateRequest, BotCreateResult } from "./bot-create";
import type { WorkTeamControlRequest, WorkTeamControlResult } from "./bot-work-team";
export type { BotCreateRequest, BotCreateResult, BotCreateErrorCode } from "./bot-create";
import type {
  WorkCardReadRequest, WorkCardReadResult, WorkDiagnosticsRequest, WorkExpandedDiagnosticsDto,
  WorkManualResendRequest, WorkSummaryProjectionDto,
} from "./bot-work-phase5";

export const BotWorkIpc = {
  decideAction: "bot-work:decide-action",
  listAutonomyRules: "bot-work:list-autonomy-rules",
  revokeAutonomyRule: "bot-work:revoke-autonomy-rule",
  hostStatus: "bot-work:host-status",
  listBots: "bot-work:list-bots",
  createBot: "bot-work:create-bot",
  updateWorkspaceAuthorization: "bot-work:update-workspace-authorization",
  teamControl: "bot-work:team-control",
  listBotExpertVersions: "bot-work:list-bot-expert-versions",
  adoptBotExpertVersion: "bot-work:adopt-bot-expert-version",
  listWorks: "bot-work:list-works",
  syncWorks: "bot-work:sync-works",
  sendMessage: "bot-work:send-message",
  history: "bot-work:history",
  messageChanged: "bot-work:message-changed",
  cancelSend: "bot-work:cancel-send",
  archiveConversation: "bot-work:archive-conversation",
  getWork: "bot-work:get-work",
  attestCriteria: "bot-work:attest-criteria",
  recordUserFeedback: "bot-work:record-user-feedback",
  markNotificationRead: "bot-work:mark-notification-read",
  markCardRead: "bot-work:mark-card-read",
  workSummary: "bot-work:work-summary",
  workDiagnostics: "bot-work:work-diagnostics",
  resendNotification: "bot-work:resend-notification",
  reviewControl: "bot-work:review-control",
  phase3Control: "bot-work:phase3-control",
  phase4Control: "bot-work:phase4-control",
} as const;

export interface BotWorkHostStatusDto {
  online: boolean;
  isAuthority: boolean;
  authorityId: string;
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
  decideAction(request: import("./bot-work-approval").WorkActionDecision): Promise<import("./bot-work-approval").WorkActionDecisionResult>;
  listAutonomyRules(): Promise<import("./bot-work-autonomy").WorkAutonomyRule[]>;
  revokeAutonomyRule(ruleId: string): Promise<boolean>;
  hostStatus(): Promise<BotWorkHostStatusDto>;
  listBots(): Promise<BotDto[]>;
  createBot(request: BotCreateRequest): Promise<BotCreateResult>;
  updateWorkspaceAuthorization(request: import("./bot-create").BotWorkspaceAuthorizationRequest): Promise<BotCreateResult>;
  teamControl(request: WorkTeamControlRequest): Promise<WorkTeamControlResult>;
  listBotExpertVersions(botId: string): Promise<BotExpertVersionDto[]>;
  adoptBotExpertVersion(botId: string, expected: { pendingVersion: number; snapshotId: string }): Promise<BotExpertAdoptionResult>;
  listWorks(includeClosed?: boolean): Promise<WorkProjectionDto[]>;
  syncWorks(request: WorkListRequest): Promise<WorkListUpdate>;
  sendMessage(request: BotSendRequest): Promise<BotSendReceipt>;
  history(request: BotHistoryRequest): Promise<BotHistoryDto>;
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
  workDiagnostics(request: WorkDiagnosticsRequest): Promise<WorkExpandedDiagnosticsDto | undefined>;
  /** Explicit user-authorized resend of a delivery whose external outcome is unknown. */
  resendNotification(request: WorkManualResendRequest): Promise<WorkControlResult>;
  reviewControl(request: WorkReviewControlRequest): Promise<WorkControlResult>;
  phase3Control(request: WorkPhase3ControlRequest): Promise<WorkPhase3ControlResult>;
  phase4Control(request: WorkPhase4ControlRequest): Promise<WorkPhase4ControlResult>;
}
