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
export const botConversationScope = (botId: string, teamId?: string) => teamId ? `team:${teamId}` : botId;
const storageKey = "mybuddy.bot-conversation-drafts";
const savedSchema = z.object({ drafts: z.record(z.string(), z.string()), requests: z.record(z.string(), botSendSchema), attachments: z.record(z.string(), z.array(z.object({ name: z.string(), path: z.string().optional() }))).default({}) });
export function createBotConversationState(): BotConversationUiState {
  let saved: z.infer<typeof savedSchema> = { drafts: {}, requests: {}, attachments: {} };
  try { saved = savedSchema.parse(JSON.parse(localStorage.getItem(storageKey) ?? "{}")); } catch { /* An absent/invalid cache is not an accepted send. */ }
  return { botDrafts: saved.drafts, botAttachmentDrafts: saved.attachments, botHistories: {}, botConversationErrors: {},
    botPendingSends: Object.fromEntries(Object.entries(saved.requests).map(([, request]) => [request.requestId, { request, sending: false, error: "发送结果未确认，请按原请求重试" }])) };
}

export function createBotConversationActions({ get, set, getApi }: AppContext): Pick<AppActions,
  "forgetDeletedBot" | "setBotAttachments" | "setBotDraft" | "submitBotDraft" | "setActiveBotId" | "setActiveTeam" | "refreshBotHistory" | "cancelBotSend" | "archiveBotConversation"> {
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
      const active = get();
      const botId = active.activeBotId ? botConversationScope(active.activeBotId, active.activeTeam?.templateId) : null;
      set(state => ({ botDraft: text, botSubmissionNotice: false, botDrafts: botId ? { ...state.botDrafts, [botId]: text } : state.botDrafts }));
      persist();
    },
    setActiveTeam: team => {
      try { if (team) localStorage.setItem("mybuddy.active-team", team.templateId); else localStorage.removeItem("mybuddy.active-team"); } catch {}
      if (!team) { set({ activeTeam: null }); return; }
      const key = botConversationScope(team.ownerBotId, team.templateId);
      set(state => ({ activeTeam: team, activeBotId: team.ownerBotId, selectedWorkId: null, botDraft: state.botDrafts[key] ?? "", botSubmissionNotice: false, page: "bot" }));
      void get().refreshBotHistory(team.ownerBotId, team.templateId);
    },
    setActiveBotId: botId => {
      try { localStorage.removeItem("mybuddy.active-team"); } catch {}
      set(state => ({ activeTeam: null, activeBotId: botId, selectedWorkId: null, botDraft: botId ? state.botDrafts[botId] ?? "" : "", botSubmissionNotice: false }));
      if (botId) void get().refreshBotHistory(botId);
    },
    submitBotDraft: async (options = {}) => {
      const { activeBotId: botId, activeTeam, botDraft, selectedWorkId } = get();
      const teamId = activeTeam?.templateId;
      const scopeKey = botConversationScope(botId ?? "", teamId);
      if (!botId) return;
      if (options.editRejectedRequestId) {
        const item = get().botPendingSends[options.editRejectedRequestId];
        if (!item || (item.request.botId !== botId || item.request.teamId !== teamId) || !item.error?.includes("BOT_ATTACHMENT_REJECTED:")) return;
        if (botDraft.trim() || get().botAttachmentDrafts[scopeKey]?.length) return;
        set(state => {
          const pending = { ...state.botPendingSends }; delete pending[item.request.requestId];
          return { botPendingSends: pending, botDraft: item.request.text,
            botDrafts: { ...state.botDrafts, [scopeKey]: item.request.text },
            botAttachmentDrafts: { ...state.botAttachmentDrafts, [scopeKey]: item.request.attachments ?? [] } };
        });
        persist(); return;
      }
      const attachments = get().botAttachmentDrafts[scopeKey] ?? [];
      const previous = options.retryRequestId ? get().botPendingSends[options.retryRequestId] : undefined;
      if (options.retryRequestId && (!previous || (previous.request.botId !== botId || previous.request.teamId !== teamId) || previous.sending)) return;
      if (!previous && !botDraft.trim() && !attachments.length) return;
      // Each send owns its identity. A missing receipt can be retried independently
      // without hijacking a newer draft or blocking unrelated messages.
      const request = previous?.request ?? { botId, teamId, requestId: crypto.randomUUID(), text: botDraft.trim(),
        attachments: attachments.map(item => ({ name: item.name, path: item.path ?? "" })),
        conversationId: get().botHistories[scopeKey]?.conversationId || undefined,
        selectedWorkId: selectedWorkId ?? undefined, referenceMessageId: options.referenceMessageId };
      set(state => ({ botPendingSends: { ...state.botPendingSends, [request.requestId]: { request, sending: true } },
        ...(!previous ? { botDraft: "", botDrafts: { ...state.botDrafts, [scopeKey]: "" },
          botAttachmentDrafts: { ...state.botAttachmentDrafts, [scopeKey]: [] } } : {}) }));
      persist();
      try {
        const api = getApi();
        if (!api) throw new Error("主机离线，请求已保留，可单独重试");
        const receipt = await api.botWork.sendMessage(request);
        if (receipt.botId !== botId || receipt.requestId !== request.requestId) throw new Error("发送回执身份不匹配");
        if (!get().botPendingSends[request.requestId]) return; // Bot deleted while the receipt was in flight.
        set(state => {
          const pending = { ...state.botPendingSends }; delete pending[request.requestId];
          return { botPendingSends: pending, ...(state.activeBotId === botId && state.activeTeam?.templateId === teamId ? { botSubmissionNotice: true } : {}) };
        });
        persist();
        await get().refreshBotHistory(botId, teamId);
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
    refreshBotHistory: async (botId, teamId) => {
      const scopeKey = botConversationScope(botId, teamId);
      const sequence = (histories.get(scopeKey) ?? 0) + 1; histories.set(scopeKey, sequence);
      try {
        const api = getApi(); if (!api) throw new Error("主机离线，消息状态待核对");
        const history = await api.botWork.history({ botId, teamId });
        if (histories.get(scopeKey) !== sequence || history.botId !== botId) return;
        set(state => {
          const observed = state.botHistories[scopeKey];
          if (observed?.conversationId === history.conversationId && observed.revision > history.revision) return {};
          const errors = { ...state.botConversationErrors }; delete errors[scopeKey];
          return { botHistories: { ...state.botHistories, [scopeKey]: history }, botConversationErrors: errors };
        });
      } catch (error) {
        if (histories.get(scopeKey) === sequence) set(state => ({ botConversationErrors: { ...state.botConversationErrors,
          [scopeKey]: error instanceof Error ? error.message : String(error) } }));
      }
    },
    cancelBotSend: async (botId, requestId) => {
      await getApi()?.botWork.cancelSend(botId, requestId);
      await get().refreshBotHistory(botId, get().activeTeam?.templateId);
    },
    archiveBotConversation: async (botId, teamId) => {
      const history = get().botHistories[botConversationScope(botId, teamId)];
      if (!history?.conversationId) return;
      await getApi()?.botWork.archiveConversation(botId, history.conversationId);
      await get().refreshBotHistory(botId, teamId);
    },
  };
}
