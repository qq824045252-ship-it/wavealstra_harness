import { z } from "zod";
import { botSendSchema, type BotHistoryDto, type BotSendRequest } from "../../../../../shared/bot-conversation";
import type { AppActions } from "../actions";
import type { AppContext } from "../context";

interface PendingSend { request: BotSendRequest; sending: boolean; error?: string }
export interface BotConversationUiState {
  botDrafts: Record<string, string>;
  botHistories: Record<string, BotHistoryDto>;
  botPendingSends: Record<string, PendingSend>;
  botConversationErrors: Record<string, string>;
}
const storageKey = "mybuddy.bot-conversation-drafts";
const savedSchema = z.object({ drafts: z.record(z.string(), z.string()), requests: z.record(z.string(), botSendSchema) });
export function createBotConversationState(): BotConversationUiState {
  let saved: z.infer<typeof savedSchema> = { drafts: {}, requests: {} };
  try { saved = savedSchema.parse(JSON.parse(localStorage.getItem(storageKey) ?? "{}")); } catch { /* An absent/invalid cache is not an accepted send. */ }
  return { botDrafts: saved.drafts, botHistories: {}, botConversationErrors: {},
    botPendingSends: Object.fromEntries(Object.entries(saved.requests).map(([botId, request]) => [botId, { request, sending: false, error: "发送结果未确认，请按原请求重试" }])) };
}

export function createBotConversationActions({ get, set, getApi }: AppContext): Pick<AppActions,
  "setBotDraft" | "submitBotDraft" | "setActiveBotId" | "refreshBotHistory" | "cancelBotSend" | "archiveBotConversation"> {
  const histories = new Map<string, number>();
  const persist = () => {
    try { localStorage.setItem(storageKey, JSON.stringify({ drafts: get().botDrafts,
      requests: Object.fromEntries(Object.entries(get().botPendingSends).map(([botId, pending]) => [botId, pending.request])) })); } catch { /* Host receipt remains authoritative. */ }
  };
  return {
    setBotDraft: text => {
      const botId = get().activeBotId;
      set(state => ({ botDraft: text, botSubmissionNotice: false, botDrafts: botId ? { ...state.botDrafts, [botId]: text } : state.botDrafts }));
      persist();
    },
    setActiveBotId: botId => {
      set(state => ({ activeBotId: botId, selectedWorkId: null, botDraft: botId ? state.botDrafts[botId] ?? "" : "", botSubmissionNotice: false }));
      if (botId) void get().refreshBotHistory(botId);
    },
    submitBotDraft: async () => {
      const { activeBotId: botId, botDraft, selectedWorkId } = get();
      if (!botId || !botDraft.trim()) return;
      const previous = get().botPendingSends[botId];
      if (previous?.sending) return;
      // A lost acknowledgement must first resolve its original request. Editing the
      // draft does not silently allocate a second business identity.
      const request = previous?.request ?? { botId, requestId: crypto.randomUUID(), text: botDraft.trim(),
        conversationId: get().botHistories[botId]?.conversationId || undefined, selectedWorkId: selectedWorkId ?? undefined };
      set(state => ({ botPendingSends: { ...state.botPendingSends, [botId]: { request, sending: true } } }));
      persist();
      try {
        const api = getApi();
        if (!api) throw new Error("主机离线，草稿与请求身份已保留");
        const receipt = await api.botWork.sendMessage(request);
        if (receipt.botId !== botId || receipt.requestId !== request.requestId) throw new Error("发送回执身份不匹配");
        set(state => {
          if (state.botPendingSends[botId]?.request.requestId !== request.requestId) return {};
          const pending = { ...state.botPendingSends }; delete pending[botId];
          const errors = { ...state.botConversationErrors }; delete errors[botId];
          const matches = (state.botDrafts[botId] ?? (state.activeBotId === botId ? state.botDraft : "")).trim() === request.text;
          return { botPendingSends: pending, botConversationErrors: errors,
            botDrafts: matches ? { ...state.botDrafts, [botId]: "" } : state.botDrafts,
            ...(matches && state.activeBotId === botId ? { botDraft: "", botSubmissionNotice: true } : {}) };
        });
        persist();
        await get().refreshBotHistory(botId);
        await get().refreshBotWork();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set(state => ({ botPendingSends: { ...state.botPendingSends, [botId]: { request, sending: false, error: message } },
          botConversationErrors: { ...state.botConversationErrors, [botId]: message } }));
        persist();
      }
    },
    refreshBotHistory: async botId => {
      const sequence = (histories.get(botId) ?? 0) + 1; histories.set(botId, sequence);
      try {
        const api = getApi(); if (!api) throw new Error("主机离线，消息状态待核对");
        const history = await api.botWork.history({ botId });
        if (histories.get(botId) !== sequence || history.botId !== botId) return;
        set(state => {
          const observed = state.botHistories[botId];
          if (observed?.conversationId === history.conversationId && observed.revision > history.revision) return {};
          const errors = { ...state.botConversationErrors }; delete errors[botId];
          return { botHistories: { ...state.botHistories, [botId]: history }, botConversationErrors: errors };
        });
      } catch (error) {
        if (histories.get(botId) === sequence) set(state => ({ botConversationErrors: { ...state.botConversationErrors,
          [botId]: error instanceof Error ? error.message : String(error) } }));
      }
    },
    cancelBotSend: async (botId, requestId) => {
      await getApi()?.botWork.cancelSend(botId, requestId);
      await get().refreshBotHistory(botId);
    },
    archiveBotConversation: async botId => {
      const history = get().botHistories[botId];
      if (!history?.conversationId) return;
      await getApi()?.botWork.archiveConversation(botId, history.conversationId);
      await get().refreshBotHistory(botId);
    },
  };
}
