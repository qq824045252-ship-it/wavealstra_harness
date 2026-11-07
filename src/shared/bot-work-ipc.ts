import type {
  AttestCriteriaParams,
  BotDto,
  RecordUserFeedbackParams,
  WorkControlResult,
  WorkProjectionDto,
} from "./bot-work";
import type { BotSendRequest, BotSendReceipt, BotHistoryRequest, BotHistoryDto, WorkListRequest, WorkListUpdate } from "./bot-conversation";
import type { WorkPhase3ControlRequest, WorkPhase3ControlResult } from "./bot-work-phase3-control";
import type { WorkPhase4ControlRequest, WorkPhase4ControlResult } from "./bot-work-phase4";

export const BotWorkIpc = {
  hostStatus: "bot-work:host-status",
  listBots: "bot-work:list-bots",
  listWorks: "bot-work:list-works",
  syncWorks: "bot-work:sync-works",
  sendMessage: "bot-work:send-message",
  history: "bot-work:history",
  cancelSend: "bot-work:cancel-send",
  archiveConversation: "bot-work:archive-conversation",
  getWork: "bot-work:get-work",
  attestCriteria: "bot-work:attest-criteria",
  recordUserFeedback: "bot-work:record-user-feedback",
  markNotificationRead: "bot-work:mark-notification-read",
  phase3Control: "bot-work:phase3-control",
  phase4Control: "bot-work:phase4-control",
} as const;

export interface BotWorkHostStatusDto {
  online: boolean;
  isAuthority: boolean;
  authorityId: string;
}

export interface BotWorkNotificationReadResult {
  ok: boolean;
  message?: string;
}

export interface BotWorkApi {
  hostStatus(): Promise<BotWorkHostStatusDto>;
  listBots(): Promise<BotDto[]>;
  listWorks(includeClosed?: boolean): Promise<WorkProjectionDto[]>;
  syncWorks(request: WorkListRequest): Promise<WorkListUpdate>;
  sendMessage(request: BotSendRequest): Promise<BotSendReceipt>;
  history(request: BotHistoryRequest): Promise<BotHistoryDto>;
  cancelSend(botId: string, requestId: string): Promise<void>;
  archiveConversation(botId: string, conversationId: string): Promise<void>;
  getWork(workId: string): Promise<WorkProjectionDto | undefined>;
  attestCriteria(request: AttestCriteriaParams): Promise<WorkControlResult>;
  recordUserFeedback(request: RecordUserFeedbackParams): Promise<WorkControlResult>;
  markNotificationRead(notificationId: string): Promise<BotWorkNotificationReadResult>;
  phase3Control(request: WorkPhase3ControlRequest): Promise<WorkPhase3ControlResult>;
  phase4Control(request: WorkPhase4ControlRequest): Promise<WorkPhase4ControlResult>;
}
