import type { BotLifecycleStatus } from "@shared/bot-work";
import type { BotWorkIndicatorDto, BotWorkIndicatorsDto } from "@shared/bot-work-ipc";

export const EMPTY_BOT_WORK_INDICATORS: BotWorkIndicatorsDto = { bots: {}, teams: {} };
export type BotPresenceState = "working" | "idle" | "offline" | "unknown" | "paused" | "disabled";
export interface BotPresence { state: BotPresenceState; label: string }
export interface BotWorkBadge { key: "active" | "completed"; label: string; value: number; title: string }

/** One unfinished Work means 工作中. Availability is separate from load: a paused,
 * disabled or unreachable Bot keeps its own truthful label instead of claiming work. */
export function botPresence(bot: { status: BotLifecycleStatus } | null | undefined,
  host: { online: boolean } | null | undefined, counts?: BotWorkIndicatorDto): BotPresence {
  if (bot?.status === "disabled") return { state: "disabled", label: "已停用" };
  if (bot?.status === "paused") return { state: "paused", label: "已暂停" };
  if (!host) return { state: "unknown", label: "状态待核实" };
  if (!host.online) return { state: "offline", label: "离线" };
  return counts && counts.active > 0 ? { state: "working", label: "工作中" } : { state: "idle", label: "空闲" };
}

/** Zero counters stay silent: an empty badge would add noise, not information. */
export function botWorkBadges(counts?: BotWorkIndicatorDto): BotWorkBadge[] {
  if (!counts) return [];
  return [
    ...(counts.active > 0 ? [{ key: "active" as const, label: "进行中", value: counts.active, title: `${counts.active} 个事项进行中` }] : []),
    ...(counts.completed > 0 ? [{ key: "completed" as const, label: "已完成", value: counts.completed, title: `${counts.completed} 个事项已完成` }] : []),
  ];
}
