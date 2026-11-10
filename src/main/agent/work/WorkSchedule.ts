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

/** Validate before writing any Work or subscription rows. */
export function watchRuleProblem(rule: WorkWatchRuleDto | undefined, now: number, compute: WorkNextWake): string | undefined {
  if (!rule) return undefined;
  if (rule.endsAt !== undefined && (!Number.isSafeInteger(rule.endsAt) || rule.endsAt <= now || rule.endsAt > 8640000000000000))
    return "持续追踪终止时间必须是未来的有效 Unix 毫秒时刻";
  if (rule.timezone) {
    try { new Intl.DateTimeFormat("en", { timeZone: rule.timezone }).format(now); }
    catch { return "时区必须是可以解析的 IANA 名称"; }
  }
  if (rule.nextWakeAt !== undefined && (!Number.isSafeInteger(rule.nextWakeAt) || rule.nextWakeAt <= now))
    return "首次检查时间必须晚于当前时间";
  if (rule.cronExpression) {
    try { if (compute({ cronExpression: rule.cronExpression, timezone: rule.timezone }, now) === undefined) return "时间表没有下一次检查时间"; }
    catch { return "Cron 表达式或时区无法解析"; }
  }
  return undefined;
}
