import type { Attachment } from "@/types";
import { z } from "zod";
import { botSendSchema, type BotHistoryDto, type BotSendRequest } from "../../../../../shared/bot-conversation";
import type { AppActions } from "../actions";
import type { AppContext } from "../context";

interface PendingSend { request: BotSendRequest; sending: boolean; error?: string }
export interface BotConversationUiState {
  botDrafts: Record<string, string>;
  botAttachmentDrafts: Record<string, Attachment[]>;
  botHistories: Record<string, BotHistoryDto>;
  botPendingSends: Record<string, PendingSend>;
  botConversationErrors: Record<string, string>;
}
const storageKey = "mybuddy.bot-conversation-drafts";
const savedSchema = z.object({ drafts: z.record(z.string(), z.string()), requests: z.record(z.string(), botSendSchema), attachments: z.record(z.string(), z.array(z.object({ name: z.string(), path: z.string().optional() }))).default({}) });
export function createBotConversationState(): BotConversationUiState {
  let saved: z.infer<typeof savedSchema> = { drafts: {}, requests: {}, attachments: {} };
  try { saved = savedSchema.parse(JSON.parse(localStorage.getItem(storageKey) ?? "{}")); } catch { /* An absent/invalid cache is not an accepted send. */ }
  return { botDrafts: saved.drafts, botAttachmentDrafts: saved.attachments, botHistories: {}, botConversationErrors: {},
    botPendingSends: Object.fromEntries(Object.entries(saved.requests).map(([, request]) => [request.requestId, { request, sending: false, error: "发送结果未确认，请按原请求重试" }])) };
}

export function createBotConversationActions({ get, set, getApi }: AppContext): Pick<AppActions,
  "forgetDeletedBot" | "setBotAttachments" | "setBotDraft" | "submitBotDraft" | "setActiveBotId" | "refreshBotHistory" | "cancelBotSend" | "archiveBotConversation"> {
  const histories = new Map<string, number>();
  const persist = () => {
    try { localStorage.setItem(storageKey, JSON.stringify({ drafts: get().botDrafts, attachments: get().botAttachmentDrafts,
      requests: Object.fromEntries(Object.entries(get().botPendingSends).map(([botId, pending]) => [botId, pending.request])) })); } catch { /* Host receipt remains authoritative. */ }
  };
  return {
    forgetDeletedBot: botId => {
      histories.set(botId, (histories.get(botId) ?? 0) + 1);
      const omit = <T,>(values: Record<string, T>) => { const next = { ...values }; delete next[botId]; return next; };
      set(state => ({ botDrafts: omit(state.botDrafts), botAttachmentDrafts: omit(state.botAttachmentDrafts),
        botHistories: omit(state.botHistories), botPendingSends: Object.fromEntries(Object.entries(state.botPendingSends).filter(([, item]) => item.request.botId !== botId)),
        botConversationErrors: omit(state.botConversationErrors),
        ...(state.activeBotId === botId ? { botDraft: "", activeBotId: null, selectedWorkId: null } : {}) }));
      persist();
    },
    setBotAttachments: (botId, attachments) => {
      set(state => ({ botAttachmentDrafts: { ...state.botAttachmentDrafts, [botId]: attachments } }));
      persist();
    },
    setBotDraft: text => {
      const botId = get().activeBotId;
      set(state => ({ botDraft: text, botSubmissionNotice: false, botDrafts: botId ? { ...state.botDrafts, [botId]: text } : state.botDrafts }));
      persist();
    },
    setActiveBotId: botId => {
      set(state => ({ activeBotId: botId, selectedWorkId: null, botDraft: botId ? state.botDrafts[botId] ?? "" : "", botSubmissionNotice: false }));
      if (botId) void get().refreshBotHistory(botId);
    },
    submitBotDraft: async (options = {}) => {
      const { activeBotId: botId, botDraft, selectedWorkId } = get();
      if (!botId) return;
      if (options.editRejectedRequestId) {
        const item = get().botPendingSends[options.editRejectedRequestId];
        if (!item || item.request.botId !== botId || !item.error?.includes("BOT_ATTACHMENT_REJECTED:")) return;
        if (botDraft.trim() || get().botAttachmentDrafts[botId]?.length) return;
        set(state => {
          const pending = { ...state.botPendingSends }; delete pending[item.request.requestId];
          return { botPendingSends: pending, botDraft: item.request.text,
            botDrafts: { ...state.botDrafts, [botId]: item.request.text },
            botAttachmentDrafts: { ...state.botAttachmentDrafts, [botId]: item.request.attachments ?? [] } };
        });
        persist(); return;
      }
      const attachments = get().botAttachmentDrafts[botId] ?? [];
      const previous = options.retryRequestId ? get().botPendingSends[options.retryRequestId] : undefined;
      if (options.retryRequestId && (!previous || previous.request.botId !== botId || previous.sending)) return;
      if (!previous && !botDraft.trim() && !attachments.length) return;
      // Each send owns its identity. A missing receipt can be retried independently
      // without hijacking a newer draft or blocking unrelated messages.
      const request = previous?.request ?? { botId, requestId: crypto.randomUUID(), text: botDraft.trim(),
        attachments: attachments.map(item => ({ name: item.name, path: item.path ?? "" })),
        conversationId: get().botHistories[botId]?.conversationId || undefined,
        selectedWorkId: selectedWorkId ?? undefined, referenceMessageId: options.referenceMessageId };
      set(state => ({ botPendingSends: { ...state.botPendingSends, [request.requestId]: { request, sending: true } },
        ...(!previous ? { botDraft: "", botDrafts: { ...state.botDrafts, [botId]: "" },
          botAttachmentDrafts: { ...state.botAttachmentDrafts, [botId]: [] } } : {}) }));
      persist();
      try {
        const api = getApi();
        if (!api) throw new Error("主机离线，请求已保留，可单独重试");
        const receipt = await api.botWork.sendMessage(request);
        if (receipt.botId !== botId || receipt.requestId !== request.requestId) throw new Error("发送回执身份不匹配");
        if (!get().botPendingSends[request.requestId]) return; // Bot deleted while the receipt was in flight.
        set(state => {
          const pending = { ...state.botPendingSends }; delete pending[request.requestId];
          return { botPendingSends: pending, ...(state.activeBotId === botId ? { botSubmissionNotice: true } : {}) };
        });
        persist();
        await get().refreshBotHistory(botId);
        await get().refreshBotWork(get().botWorkCursor?.scope === "all");
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        set(state => {
          if (!state.botPendingSends[request.requestId]) return {};
          return { botPendingSends: { ...state.botPendingSends,
            [request.requestId]: { request, sending: false, error: message } } };
        });
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
