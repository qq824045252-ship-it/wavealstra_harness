import { Cron } from "croner";
import type { WorkWatchRuleDto } from "../../../shared/bot-work";

/** Injectable wake computation so scheduling tests do not sleep through real cron time. */
export type WorkNextWake = (
  rule: { cronExpression?: string; timezone?: string; nextWakeAt?: number },
  from: number,
) => number | undefined;

export function cronNextWake(
  rule: { cronExpression?: string; timezone?: string; nextWakeAt?: number },
  from: number,
): number | undefined {
  if (rule.nextWakeAt !== undefined) return rule.nextWakeAt > from ? rule.nextWakeAt : undefined;
  if (!rule.cronExpression) return undefined;
  const cron = new Cron(rule.cronExpression, { timezone: rule.timezone, paused: true });
  try {
    return cron.nextRun(new Date(from))?.getTime();
  } finally {
    cron.stop();
  }
}

export function nextWakeForRule(watchRule: WorkWatchRuleDto | undefined, from: number, compute: WorkNextWake): number | undefined {
  if (!watchRule) return undefined;
  return compute({
    cronExpression: watchRule.cronExpression,
    timezone: watchRule.timezone,
    nextWakeAt: watchRule.nextWakeAt,
  }, from);
}
