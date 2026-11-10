import type { WorkDto } from "./bot-work";

/** Wall-clock deadline is absolute; pausing/restarting never extends it. */
export function watchTimeExpired(work: Pick<WorkDto, "mode" | "watchRule">, now: number): boolean {
  const end = work.watchRule?.endsAt;
  return work.mode === "watch" && typeof end === "number" && Number.isSafeInteger(end) && end >= 0 && end <= now;
}
export function watchEndedByTime(work: Pick<WorkDto, "mode" | "lifecycle"> & { watchRule?: Pick<NonNullable<WorkDto["watchRule"]>, "termination"> }): boolean {
  return work.mode === "watch" && work.lifecycle === "closed"
    && work.watchRule?.termination?.reason === "schedule_expired" && work.watchRule.termination.settledAt !== undefined;
}
