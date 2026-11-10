import type { BotDto, WorkActor, WorkAuthorizationDto, WorkControlErrorCode, WorkDto, WorkExecutionBindingDto } from "../../../shared/bot-work";

export type Fail = { ok: false; code: WorkControlErrorCode; message: string; latestWorkSnapshot?: WorkDto };
export type Mutation = { ok: true; outboxEventId?: string } | Fail;
export interface ResolvedActor {
  userId: string;
  kind: WorkActor["kind"];
  bot?: BotDto;
  grants: WorkAuthorizationDto;
  binding?: WorkExecutionBindingDto;
}
