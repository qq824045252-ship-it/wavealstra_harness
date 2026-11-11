import { botParticipatesInWork } from "@/lib/botWorkspacePresentation";
import { z } from "zod";
import type { BotDto, WorkProjectionDto } from "../../../../../shared/bot-work";
import type { AppState } from "../types";

const storageKey = "mybuddy.bot-navigation";
const savedSchema = z.object({
  version: z.literal(1),
  userId: z.string().min(1),
  botId: z.string().min(1),
  page: z.enum(["chat", "bot"]),
  workId: z.string().min(1).nullable(),
}).strict();
type SavedNavigation = z.infer<typeof savedSchema>;

export function navigableBot(bot: BotDto): boolean {
  return bot.status === "active" && !!bot.userId
    && (bot.authorization.expiresAt === undefined || bot.authorization.expiresAt > Date.now());
}

/** A location cache only. Bots are validated on restore; Work access is checked on demand. */
export function createBotNavigationPersistence() {
  let saved: SavedNavigation | null = null;
  try { saved = savedSchema.parse(JSON.parse(localStorage.getItem(storageKey) ?? "null")); } catch { /* Optional cache. */ }
  let pending = saved;
  const write = () => {
    try {
      if (saved) localStorage.setItem(storageKey, JSON.stringify(saved));
      else localStorage.removeItem(storageKey);
    } catch { /* Navigation must work without browser storage. */ }
  };
  return {
    hasPendingRestore: () => pending !== null,
    observePatch(patch: Partial<AppState>) {
      // Even selecting ordinary mode while it is already the loading page wins
      // over a delayed restore. Cover all navigation commands, not just setPage.
      if ("page" in patch || "activeBotId" in patch || "selectedWorkId" in patch || "historicalTeamWork" in patch) pending = null;
      if ("page" in patch && saved) {
        saved = { ...saved, page: patch.page === "bot" ? "bot" : "chat" };
        write();
      }
    },
    restore(bots: BotDto[], _works: WorkProjectionDto[]): Partial<AppState> {
      const value = pending;
      pending = null;
      if (!value) return {};
      const bot = bots.find(item => item.botId === value.botId && item.userId === value.userId && navigableBot(item));
      if (!bot) return {};
      // The detail endpoint validates old IDs on demand; the first summary page is incomplete.
      return { activeBotId: bot.botId, selectedWorkId: value.workId,
        ...(value.page === "bot" ? { page: "bot" as const } : {}) };
    },
    persist(state: AppState) {
      // An error or an unfinished first load is not evidence of deletion.
      if (pending || !state.botIdentitiesLoaded || state.botWorkError) return;
      const bot = state.botIdentities.find(item => item.botId === state.activeBotId && navigableBot(item));
      const work = state.botWorks.find(item => item.workId === state.selectedWorkId && botParticipatesInWork(item, bot?.botId) && item.lifecycle !== "closed");
      saved = bot ? { version: 1, userId: bot.userId, botId: bot.botId,
        page: state.page === "bot" ? "bot" : "chat", workId: work?.workId ?? state.selectedWorkId ?? null } : null;
      write();
    },
  };
}
