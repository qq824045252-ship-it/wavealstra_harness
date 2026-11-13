import { mergeBotHistoryPage } from "./botMessageStream";
import { buildTaskReferenceBlock, wrapReferenceContext } from "@/lib/taskReference";
import { requestConsultForMessage } from "@shared/multi-model-consult";
import type { Attachment } from "@/types";
import { z } from "zod";
import { botMessageDisplayText, botSendSchema, botComposerSelectionSchema, type BotComposerSelection, type BotHistoryDto, type BotSendRequest } from "../../../../../shared/bot-conversation";
import type { AppActions } from "../actions";
import type { AppContext } from "../context";

interface PendingSend { request: BotSendRequest; sending: boolean; error?: string }
export interface BotConversationUiState {
  botComposerDrafts: Record<string, BotComposerSelection>;
  botDrafts: Record<string, string>;
  botAttachmentDrafts: Record<string, Attachment[]>;
  botHistories: Record<string, BotHistoryDto>;
  botPendingSends: Record<string, PendingSend>;
  botHistoryPages: Record<string, { loading: boolean; error?: string }>;
  botConversationErrors: Record<string, string>;
}
export const botConversationScope = (botId: string, teamId?: string) => teamId ? `team:${teamId}` : botId;
const storageKey = "mybuddy.bot-conversation-drafts";
const savedSchema = z.object({ selections: z.record(z.string(), botComposerSelectionSchema).default({}), drafts: z.record(z.string(), z.string()), requests: z.record(z.string(), botSendSchema), attachments: z.record(z.string(), z.array(z.object({ name: z.string(), path: z.string().optional() }))).default({}) });
export function createBotConversationState(): BotConversationUiState {
  let saved: z.infer<typeof savedSchema> = { drafts: {}, requests: {}, attachments: {}, selections: {} };
  try { saved = savedSchema.parse(JSON.parse(localStorage.getItem(storageKey) ?? "{}")); } catch { /* An absent/invalid cache is not an accepted send. */ }
  return { botComposerDrafts: saved.selections, botDrafts: saved.drafts, botAttachmentDrafts: saved.attachments, botHistories: {}, botHistoryPages: {}, botConversationErrors: {},
    botPendingSends: Object.fromEntries(Object.entries(saved.requests).map(([, request]) => [request.requestId, { request, sending: false, error: "发送结果未确认，请按原请求重试" }])) };
}

export function createBotConversationActions({ get, set, getApi }: AppContext): Pick<AppActions,
  "openNotificationConversation" | "setBotComposerSelection" | "forgetDeletedBot" | "setBotAttachments" | "setBotDraft" | "submitBotDraft" | "setActiveBotId" | "setActiveTeam" | "refreshBotHistory" | "loadOlderBotHistory" | "cancelBotSend" | "archiveBotConversation"> {
  const histories = new Map<string, number>();
  const notificationConversations = new Map<string, string>();
  const olderReads = new Map<string, symbol>();
  const pendingOffsets = new Map<string, number>();
  const persist = () => {
    try { localStorage.setItem(storageKey, JSON.stringify({ selections: get().botComposerDrafts, drafts: get().botDrafts, attachments: get().botAttachmentDrafts,
      requests: Object.fromEntries(Object.entries(get().botPendingSends).map(([botId, pending]) => [botId, pending.request])) })); } catch { /* Host receipt remains authoritative. */ }
  };
  return {
    openNotificationConversation: async (target, signal) => {
      signal?.throwIfAborted();
      const api = getApi()?.botWork;
      if (!api) throw new Error("主机离线，无法打开通知来源");
      const epoch = get().botNavigationEpoch + 1;
      set({ botNavigationEpoch: epoch });
      const bots = await api.listBots();
      if (!bots.some(bot => bot.botId === target.botId)) throw new Error("通知对应的 Bot 已不可用");
      let team: import("../../../../../shared/bot-work-team").WorkTeamTemplateDto | null = null;
      if (target.teamId) {
        const result = await api.teamControl({ kind: "list_templates" });
        team = result.ok ? result.templates?.find(item => item.templateId === target.teamId && item.ownerBotId === target.botId) ?? null : null;
        if (!team) throw new Error("通知对应的团队已不可用");
      }
      const history = await api.history({ botId: target.botId, teamId: target.teamId, conversationId: target.conversationId });
      if (history.botId !== target.botId || history.teamId !== target.teamId || history.conversationId !== target.conversationId) throw new Error("通知来源会话已不可用");
      signal?.throwIfAborted();
      if (get().botNavigationEpoch !== epoch) throw new Error("通知导航已被新的选择取代，请重新点击通知");
      const key = botConversationScope(target.botId, target.teamId);
      histories.set(key, (histories.get(key) ?? 0) + 1);
      notificationConversations.set(key, target.conversationId);
      set(state => ({ page: "bot", activeBotId: target.botId, activeTeam: team, selectedWorkId: null, historicalTeamWork: null,
        botHistories: { ...state.botHistories, [key]: history }, botDraft: state.botDrafts[key] ?? "",
        botHistoryPages: { ...state.botHistoryPages, [key]: { loading: false } } }));
    },
    setBotComposerSelection: (scope, selection) => { set(state => ({ botComposerDrafts: {...state.botComposerDrafts, [scope]: selection} })); persist(); },
    forgetDeletedBot: botId => {
      olderReads.delete(botId);
      histories.set(botId, (histories.get(botId) ?? 0) + 1);
      const omit = <T,>(values: Record<string, T>) => { const next = { ...values }; delete next[botId]; return next; };
      set(state => ({ botComposerDrafts: omit(state.botComposerDrafts), botDrafts: omit(state.botDrafts), botAttachmentDrafts: omit(state.botAttachmentDrafts),
        botHistories: omit(state.botHistories), botHistoryPages: omit(state.botHistoryPages), botPendingSends: Object.fromEntries(Object.entries(state.botPendingSends).filter(([, item]) => item.request.botId !== botId)),
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
      notificationConversations.clear();
      try { if (team) localStorage.setItem("mybuddy.active-team", team.templateId); else localStorage.removeItem("mybuddy.active-team"); } catch {}
      if (!team) { set(state => ({ activeTeam: null, historicalTeamWork: null, botNavigationEpoch: state.botNavigationEpoch + 1 })); return; }
      const key = botConversationScope(team.ownerBotId, team.templateId);
      set(state => ({ historicalTeamWork: null, botNavigationEpoch: state.botNavigationEpoch + 1, activeTeam: team, activeBotId: team.ownerBotId, selectedWorkId: null, botDraft: state.botDrafts[key] ?? "", botSubmissionNotice: false, page: "bot" }));
      void get().refreshBotHistory(team.ownerBotId, team.templateId);
    },
    setActiveBotId: botId => {
      notificationConversations.clear();
      try { localStorage.removeItem("mybuddy.active-team"); } catch {}
      set(state => ({ historicalTeamWork: null, botNavigationEpoch: state.botNavigationEpoch + 1, activeTeam: null, activeBotId: botId, selectedWorkId: null, botDraft: botId ? state.botDrafts[botId] ?? "" : "", botSubmissionNotice: false }));
      if (botId) void get().refreshBotHistory(botId);
    },
    submitBotDraft: async (options = {}) => {
      const { activeBotId: botId, activeTeam, botDraft, selectedWorkId } = get();
      const teamId = activeTeam?.templateId;
      const scopeKey = botConversationScope(botId ?? "", teamId);
      if (!botId) return;
      if (options.editRejectedRequestId) {
        const item = get().botPendingSends[options.editRejectedRequestId];
        if (!item || (item.request.botId !== botId || item.request.teamId !== teamId) || !(item.error?.includes("BOT_ATTACHMENT_REJECTED:") || item.error?.includes("BOT_SELECTION_REJECTED:"))) return;
        if (botDraft.trim() || get().botAttachmentDrafts[scopeKey]?.length) return;
        const referencedPaths = new Set([
          ...(item.request.selection?.refFiles ?? []),
          ...(item.request.selection?.refTasks ?? []).flatMap(task => task.files ?? []),
        ].flatMap(file => file.path ? [file.path] : []));
        set(state => {
          const pending = { ...state.botPendingSends }; delete pending[item.request.requestId];
          return { botPendingSends: pending, botDraft: botMessageDisplayText(item.request.text),
            ...(item.request.selection ? { botComposerDrafts: { ...state.botComposerDrafts, [scopeKey]: item.request.selection } } : {}),
            botDrafts: { ...state.botDrafts, [scopeKey]: botMessageDisplayText(item.request.text) },
            botAttachmentDrafts: { ...state.botAttachmentDrafts, [scopeKey]: (item.request.attachments ?? []).filter(file => !referencedPaths.has(file.path)) } };
        });
        persist(); return;
      }
      const attachments = get().botAttachmentDrafts[scopeKey] ?? [];
      const previous = options.retryRequestId ? get().botPendingSends[options.retryRequestId] : undefined;
      if (options.retryRequestId && (!previous || (previous.request.botId !== botId || previous.request.teamId !== teamId) || previous.sending)) return;
      const selection = get().botComposerDrafts[scopeKey];
      const refTasks = selection?.refTasks ?? [];
      const refFiles = selection?.refFiles ?? [];
      if (!previous && !botDraft.trim() && !attachments.length && !refTasks.length && !refFiles.length) return;
      if (!previous && selection?.consultRequested && selection.externalAgentId) {
        set(state => ({ botConversationErrors: { ...state.botConversationErrors,
          [scopeKey]: "当前选择的是外部 Agent，请移除外部 Agent 或多模型会诊标签后发送。" } }));
        return;
      }
      const referenceContext = wrapReferenceContext([
        ...refTasks.map(buildTaskReferenceBlock),
        ...refFiles.filter(file => !file.path?.trim()).map(file => {
          const content = file.content?.trim();
          return `## 引用文件：${file.name}\n${content ? content.slice(0, 12000) : "（无可用内容，请在对话中查看产物）"}`;
        }),
      ].join("\n\n"));
      const body = [botDraft.trim() || (refTasks.length ? "请结合引用任务的上下文继续" : refFiles.length ? "请查看附带/引用的文件" : ""), referenceContext].filter(Boolean).join("\n\n");
      const mergedAttachments = [...attachments, ...refFiles, ...refTasks.flatMap(task => task.files ?? [])]
        .filter((file, index, all) => index < attachments.length || (file.path?.trim() && all.findIndex(other => other.path === file.path) === index))
        .map(item => ({ name: item.name, path: item.path ?? "" }));
      // Each send owns its identity. A missing receipt can be retried independently
      // without hijacking a newer draft or blocking unrelated messages.
      const request = previous?.request ?? { botId, teamId, requestId: crypto.randomUUID(), text: selection?.consultRequested ? requestConsultForMessage(body) : body,
        selection,
        attachments: mergedAttachments,
        conversationId: get().botHistories[scopeKey]?.conversationId || undefined,
        selectedWorkId: selectedWorkId ?? undefined, referenceMessageId: options.referenceMessageId };
      const valid = botSendSchema.safeParse(request);
      if (!valid.success) {
        set(state => ({ botConversationErrors: { ...state.botConversationErrors,
          [scopeKey]: `消息或引用超出发送限制，请减少引用内容/附件后重试：${valid.error.issues[0]?.message ?? "无效请求"}` } }));
        return;
      }
      set(state => ({ botPendingSends: { ...state.botPendingSends, [request.requestId]: { request, sending: true } },
        ...(!previous ? { botDraft: "", botDrafts: { ...state.botDrafts, [scopeKey]: "" },
          botAttachmentDrafts: { ...state.botAttachmentDrafts, [scopeKey]: [] },
          ...(selection ? { botComposerDrafts: { ...state.botComposerDrafts, [scopeKey]: {
            ...selection, consultRequested: false, externalAgentId: undefined, refTasks: [], refFiles: [],
          } } } : {}) } : {}) }));
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
        const conversationId = notificationConversations.get(scopeKey);
        let history = await api.botWork.history({ botId, teamId, conversationId });
        if (histories.get(scopeKey) !== sequence || history.botId !== botId || history.teamId !== teamId) return;
        const previous = get().botHistories[scopeKey];
        // A burst larger than the latest page must not create an invisible gap.
        // Catch up one bounded page per refresh, never silently drain all history.
        const newest = previous?.messages.at(-1)?.ordinal;
        if (previous?.conversationId === history.conversationId && newest !== undefined && history.before
          && history.messages[0]?.ordinal > newest) {
          history = await api.botWork.history({ botId, teamId, conversationId, after: newest });
          if (histories.get(scopeKey) !== sequence || history.botId !== botId || history.teamId !== teamId) return;
        }
        set(state => {
          const observed = state.botHistories[scopeKey];
          const sameConversation = observed?.conversationId === history.conversationId;
          if (!sameConversation) olderReads.delete(scopeKey);
          const errors = { ...state.botConversationErrors }; delete errors[scopeKey];
          return { botHistories: { ...state.botHistories, [scopeKey]: sameConversation ? mergeBotHistoryPage(observed, history) : history },
            ...(!sameConversation ? { botHistoryPages: { ...state.botHistoryPages, [scopeKey]: { loading: false } } } : {}),
            botConversationErrors: errors };
        });
        // Reconcile off-page unfinished replies after a missed event/disconnect.
        // Rotate a bounded set; long histories never become full-table polling.
        const current = get().botHistories[scopeKey];
        const received = new Set(history.messages.map(message => message.messageId));
        const unfinished = current?.messages.filter(message => ["queued", "running", "unknown"].includes(message.status)
          && !received.has(message.messageId)) ?? [];
        if (current?.conversationId && unfinished.length) {
          const offset = (pendingOffsets.get(scopeKey) ?? 0) % unfinished.length;
          const ids = [...unfinished.slice(offset), ...unfinished.slice(0, offset)].slice(0, 100).map(message => message.messageId);
          pendingOffsets.set(scopeKey, offset + ids.length);
          const reconciled = await api.botWork.history({ botId, teamId, conversationId: current.conversationId, messageIds: ids });
          if (histories.get(scopeKey) !== sequence) return;
          if (reconciled.botId !== botId || reconciled.teamId !== teamId || reconciled.conversationId !== current.conversationId
            || reconciled.messages.some(message => !ids.includes(message.messageId))) throw new Error("历史消息核对身份不匹配");
          set(state => {
            const observed = state.botHistories[scopeKey];
            return observed?.conversationId === current.conversationId
              ? { botHistories: { ...state.botHistories, [scopeKey]: mergeBotHistoryPage(observed, reconciled) } } : {};
          });
        }
      } catch (error) {
        if (histories.get(scopeKey) === sequence) set(state => ({ botConversationErrors: { ...state.botConversationErrors,
          [scopeKey]: error instanceof Error ? error.message : String(error) } }));
      }
    },
    loadOlderBotHistory: async (botId, teamId) => {
      const key = botConversationScope(botId, teamId);
      const start = get().botHistories[key];
      if (!start?.conversationId || start.before === undefined || olderReads.has(key)) return;
      const token = Symbol(); olderReads.set(key, token);
      set(state => ({ botHistoryPages: { ...state.botHistoryPages, [key]: { loading: true } } }));
      try {
        const api = getApi(); if (!api) throw new Error("主机离线，请稍后重试");
        const page = await api.botWork.history({ botId, teamId, conversationId: start.conversationId, before: start.before });
        if (olderReads.get(key) !== token) return;
        if (page.botId !== botId || page.teamId !== teamId || page.conversationId !== start.conversationId
          || page.messages.some(message => message.ordinal >= start.before!)
          || (page.before !== undefined && page.before >= start.before)) throw new Error("历史分页身份或游标不匹配，请重试");
        set(state => {
          const current = state.botHistories[key];
          if (current?.conversationId !== start.conversationId || current.before !== start.before) return {};
          return { botHistories: { ...state.botHistories, [key]: mergeBotHistoryPage(current, page, true) } };
        });
      } catch (error) {
        if (olderReads.get(key) === token) set(state => ({ botHistoryPages: { ...state.botHistoryPages,
          [key]: { loading: false, error: error instanceof Error ? error.message : String(error) } } }));
      } finally {
        if (olderReads.get(key) === token) {
          olderReads.delete(key);
          set(state => ({ botHistoryPages: { ...state.botHistoryPages, [key]: { ...state.botHistoryPages[key], loading: false } } }));
        }
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
      notificationConversations.delete(botConversationScope(botId, teamId));
      await get().refreshBotHistory(botId, teamId);
    },
  };
}
