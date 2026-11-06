import type {
  AttestCriteriaParams,
  BotDto,
  RecordUserFeedbackParams,
  WorkControlResult,
  WorkProjectionDto,
} from "./bot-work";

export const BotWorkIpc = {
  hostStatus: "bot-work:host-status",
  listBots: "bot-work:list-bots",
  listWorks: "bot-work:list-works",
  getWork: "bot-work:get-work",
  attestCriteria: "bot-work:attest-criteria",
  recordUserFeedback: "bot-work:record-user-feedback",
  markNotificationRead: "bot-work:mark-notification-read",
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
  getWork(workId: string): Promise<WorkProjectionDto | undefined>;
  attestCriteria(request: AttestCriteriaParams): Promise<WorkControlResult>;
  recordUserFeedback(request: RecordUserFeedbackParams): Promise<WorkControlResult>;
  markNotificationRead(notificationId: string): Promise<BotWorkNotificationReadResult>;
}
