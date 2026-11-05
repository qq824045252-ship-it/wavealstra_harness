import { Cron } from "croner";
import type { CronJobDto } from "../../shared/agent-ipc";

export function withinEffectiveRange(job: CronJobDto, time = Date.now()): "ok" | "before" | "after" {
  if (job.effectiveFrom != null && time < job.effectiveFrom) return "before";
  if (job.effectiveTo != null && time > job.effectiveTo) return "after";
  return "ok";
}

export function parseEveryExpr(expr: string): number {
  const match = /^(\d+)([smhd])$/i.exec(expr.trim());
  const units: Record<string, number> = { s: 1000, m: 60000, h: 3600000, d: 86400000 };
  const interval = match ? Number(match[1]) * units[match[2].toLowerCase()] : 0;
  if (!Number.isSafeInteger(interval) || interval <= 0) throw new Error("Interval must be a positive integer followed by s, m, h or d");
  return interval;
}

export function validateSchedule(job: CronJobDto): void {
  for (const time of [job.effectiveFrom, job.effectiveTo]) {
    if (time != null && (!Number.isSafeInteger(time) || Math.abs(time) > 8.64e15)) throw new Error("Invalid automation date");
  }
  if (job.effectiveFrom != null && job.effectiveTo != null && job.effectiveFrom > job.effectiveTo) throw new Error("Automation start must not exceed deadline");
  switch (job.scheduleType) {
    case "every": parseEveryExpr(job.scheduleExpr); break;
    case "at":
      if (!Number.isFinite(Date.parse(job.scheduleExpr))) throw new Error("Invalid automation time");
      break;
    case "cron": new Cron(job.scheduleExpr, { timezone: job.timezone, paused: true }).stop(); break;
    default: throw new Error("Invalid automation schedule type");
  }
}

export function computeNextRunAt(job: CronJobDto, now = Date.now()): number | undefined {
  if (!job.enabled || withinEffectiveRange(job, now) === "after" ||
    (job.maxRuns != null && (job.runCount ?? 0) >= job.maxRuns)) return undefined;
  let next: number | undefined;
  switch (job.scheduleType) {
    case "at": next = Date.parse(job.scheduleExpr); break;
    case "every": {
      const interval = parseEveryExpr(job.scheduleExpr);
      const anchor = Math.max(job.createdAt, job.effectiveFrom ?? job.createdAt);
      next = anchor > now ? anchor : anchor + (Math.floor((now - anchor) / interval) + 1) * interval;
      break;
    }
    case "cron": {
      const cron = new Cron(job.scheduleExpr, { timezone: job.timezone, paused: true });
      next = cron.nextRun(new Date(Math.max(now, (job.effectiveFrom ?? now) - 1)))?.getTime();
      cron.stop();
      break;
    }
  }
  return next != null && next > now && withinEffectiveRange(job, next) === "ok" ? next : undefined;
}

export interface SegmentedTimer { stop(): void }

export function scheduleTimer(targetTime: number, callback: () => void): SegmentedTimer {
  let stopped = false;
  let timer: NodeJS.Timeout;
  const tick = () => {
    if (stopped) return;
    if (Date.now() >= targetTime) callback();
    else timer = setTimeout(tick, Math.min(targetTime - Date.now(), 2147483647));
  };
  timer = setTimeout(tick, Math.max(1, Math.min(targetTime - Date.now(), 2147483647)));
  timer.unref();
  return { stop() { stopped = true; clearTimeout(timer); } };
}
