import { workspaceRequestRevision } from "./workspace-request-selection";
import type { NotificationActivationTarget } from "@shared/notification";
import type { BotWorkApi } from "@shared/bot-work-ipc";
import type { BotWorkspaceRequestDto } from "@shared/bot-workspace-navigation";

export async function openHistoricalNotification(
  target: Extract<NotificationActivationTarget, { kind: "botConversation" }>, api: BotWorkApi | undefined,
  open: (request: BotWorkspaceRequestDto) => void, options: { signal?: AbortSignal; isCurrent: () => boolean },
): Promise<void> {
  options.signal?.throwIfAborted();
  if (!api) throw new Error("主机离线，无法打开历史通知");
  const selectionRevision = workspaceRequestRevision();
  const navigation = await api.workspaceNavigation();
  options.signal?.throwIfAborted();
  let requestId: string | undefined;
  if (target.messageId) {
    let before: number | undefined;
    do {
      const history = await api.history({ botId: target.botId, teamId: target.teamId, conversationId: target.conversationId, before });
      options.signal?.throwIfAborted();
      if (history.botId !== target.botId || history.teamId !== target.teamId || history.conversationId !== target.conversationId) throw new Error("历史通知身份不匹配");
      requestId = history.messages.find(message => message.messageId === target.messageId)?.requestId;
      if (requestId || history.before === undefined || history.before === before) break;
      before = history.before;
    } while (before !== undefined);
    if (!requestId) throw new Error("通知指定的历史消息未找到，未跳转到其他消息");
  }
  const request = navigation.foregroundRequests.filter(item => item.botId === target.botId
    && item.teamId === target.teamId && item.conversationId === target.conversationId
    && (!requestId || item.requestId === requestId)).sort((a, b) => b.updatedAt - a.updatedAt)[0];
  if (!request) throw new Error("此历史会话尚无工作空间入口，记录未删除");
  options.signal?.throwIfAborted();
  if (workspaceRequestRevision() !== selectionRevision || !options.isCurrent()) throw new Error("通知导航已被新的选择取代");
  open(request);
}
