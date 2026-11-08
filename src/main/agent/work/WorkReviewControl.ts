import type { WorkActor, WorkControlResult } from "../../../shared/bot-work";
import { workReviewControlSchema } from "../../../shared/bot-work-review";
import type { WorkService } from "./WorkService";

/** Trusted UI entry only. This delegates to the existing controls and their receipts. */
export function reviewWork(works: WorkService, actor: WorkActor, request: unknown): WorkControlResult {
  if (actor.kind !== "user") return {
    ok: false, code: "unauthorized_actor", message: "成果评审和结束决定必须来自已认证用户入口",
  };
  const parsed = workReviewControlSchema.safeParse(request);
  if (!parsed.success) return {
    ok: false, code: "invalid_request", message: parsed.error.issues[0]?.message ?? "评审请求无效",
  };
  const input = parsed.data;
  const work = works.getWork(input.request.workId);
  if (!work || work.userId !== actor.userId) return { ok: false, code: "not_found", message: "找不到事项" };
  if (input.kind === "accept_deliverable") return works.acceptDeliverable(actor, input.request);
  if (input.kind === "reject_deliverable") return works.rejectDeliverable(actor, input.request);
  if (input.kind === "attest_criteria") return works.attestCriteria(actor, input.request);
  if (input.kind === "reply_legacy_user_input") return works.replyLegacyUserInput(actor, input.request);
  if (input.kind === "reply_user_input") return works.replyUserInput(actor, input.request);
  if (input.kind === "feedback") return works.recordUserFeedback(actor, input.request);
  const { confirmed: _confirmed, ...close } = input.request;
  return works.closeWork(actor, close);
}
