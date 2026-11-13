import type { BotLifecycleStatus } from "@shared/bot-work";
import type { BotDirectoryActivityDto, BotDirectoryActivitySnapshotDto } from "@shared/bot-work-ipc";

export const EMPTY_BOT_DIRECTORY_ACTIVITY: BotDirectoryActivitySnapshotDto = { bots: {}, teams: {} };
export type BotPresenceState = "working" | "idle" | "offline" | "unknown" | "paused" | "disabled";
export interface BotPresence { state: BotPresenceState; label: string }
export interface BotWorkBadge { key: "active" | "completed"; label: string; value: number; title: string }
export interface BotReplyBadge { label: "回复中"; title: string }

/** One unfinished Work or one queued/streaming foreground answer means 工作中.
 * `live` is the reply this window already renders, ahead of the host count.
 * Availability stays separate: a paused, disabled or unreachable Bot keeps its own
 * truthful label instead of claiming work. */
export function botPresence(bot: { status: BotLifecycleStatus } | null | undefined,
  host: { online: boolean } | null | undefined, activity?: BotDirectoryActivityDto, live = false): BotPresence {
  if (bot?.status === "disabled") return { state: "disabled", label: "已停用" };
  if (bot?.status === "paused") return { state: "paused", label: "已暂停" };
  if (!host) return { state: "unknown", label: "状态待核实" };
  if (!host.online) return { state: "offline", label: "离线" };
  const busy = live || (activity?.activeWorks ?? 0) > 0 || (activity?.activeReplies ?? 0) > 0;
  return busy ? { state: "working", label: "工作中" } : { state: "idle", label: "空闲" };
}

/** Foreground output is a state, not a Work count, so it never joins 进行中/已完成. */
export function botReplyBadge(activity?: BotDirectoryActivityDto, live = false): BotReplyBadge | null {
  const replies = Math.max(activity?.activeReplies ?? 0, live ? 1 : 0);
  if (replies === 0) return null;
  return { label: "回复中", title: replies > 1 ? `${replies} 条回复正在输出` : "正在输出回复" };
}

/** Zero counters stay silent: an empty badge would add noise, not information. */
export function botWorkBadges(activity?: BotDirectoryActivityDto): BotWorkBadge[] {
  if (!activity) return [];
  return [
    ...(activity.activeWorks > 0 ? [{ key: "active" as const, label: "进行中", value: activity.activeWorks, title: `${activity.activeWorks} 个事项进行中` }] : []),
    ...(activity.completedWorks > 0 ? [{ key: "completed" as const, label: "已完成", value: activity.completedWorks, title: `${activity.completedWorks} 个事项已完成` }] : []),
  ];
}
