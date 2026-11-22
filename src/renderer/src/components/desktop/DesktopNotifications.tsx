import { useEffect, useState } from "react";
import { useAppStore } from "@/store/appStore";
import { useBlockNativeSurfaces } from "@/hooks/useBlockNativeSurfaces";
import { openWorkspaceRequest } from "@/hooks/useBotWorkspaceNavigation";
import { workspaceRequestRevision } from "@/lib/workspace-request-selection";
import { openHistoricalNotification } from "@/lib/historicalNotification";
import { deliverNotificationActivation } from "@/lib/notificationActivationDelivery";
import type { NotificationActivationTarget } from "@shared/notification";
import ConfirmDialog from "@/components/common/ConfirmDialog";
import { IconBell } from "@/components/common/icons";
import { useDesktopNavigate } from "./DesktopSection";

async function openActivationTarget(target: NotificationActivationTarget, signal: AbortSignal): Promise<void> {
  const state = useAppStore.getState();
  const revision = workspaceRequestRevision();
  const assertSelection = (): void => {
    const current = useAppStore.getState();
    if (signal.aborted || workspaceRequestRevision() !== revision || current.page !== state.page
      || current.activeTaskId !== state.activeTaskId || current.activeWorkspaceId !== state.activeWorkspaceId
      || current.settingsOpen !== state.settingsOpen) {
      throw new Error("通知导航已被新的选择取代，请重新点击通知");
    }
  };
  const open = (action: () => void): void => {
    assertSelection();
    if (state.settingsOpen) state.setSettingsOpen(false);
    action();
  };
  switch (target.kind) {
    case "task": open(() => {
      state.setActiveTask(target.taskId, target.messageId ? {
        messageId: target.messageId, toolCallId: target.toolCallId, interactionId: target.interactionId,
      } : undefined);
    }); break;
    case "project": open(() => state.openProjectDetails(target.projectId)); break;
    case "automation": open(() => state.setPage("automation")); break;
    case "runtime": state.setSettingsOpen(true, "extensions"); break;
    case "botConversation":
      await openHistoricalNotification(target, window.api?.botWork,
        request => open(() => openWorkspaceRequest(request)),
        { signal, isCurrent: () => { assertSelection(); return true; } });
      break;
    case "work": {
      const work = await window.api?.botWork.getWork(target.workId);
      if (!work || work.workId !== target.workId || work.archive?.deletedAt !== undefined) throw new Error("通知对应的事项已不可用");
      assertSelection();
      const navigation = await window.api?.botWork.workspaceNavigation();
      const request = navigation?.foregroundRequests.find(item => item.botId === work.ownerBotId && work.originalDelegation?.messages.some(message => message.messageId === item.messageId));
      if (!request) throw new Error("此历史事项尚无工作空间入口，记录未删除");
      open(() => openWorkspaceRequest({ ...request, focusWork: target }));
      break;
    }
  }
}

export default function DesktopNotifications({ onOpen }: { onOpen: () => void }): React.JSX.Element {
  const active = useAppStore(s => s.page === "notifications" && !s.settingsOpen);
  const navigate = useDesktopNavigate();
  const [unreadCount, setUnreadCount] = useState(0);
  const [notificationError, setNotificationError] = useState<string | null>(null);

  useBlockNativeSurfaces(notificationError !== null);
  useEffect(() => {
    const api = window.api?.notification;
    if (!api) return;
    let disposed = false;
    let changed = false;
    const unsubscribe = api.onChanged(event => {
      changed = true;
      setUnreadCount(event.unreadCount);
    });
    void api.unreadCount().then(count => {
      if (!disposed && !changed) setUnreadCount(count);
    }).catch(error => console.warn("[Notifications] unread count failed", error));
    return () => { disposed = true; unsubscribe(); };
  }, []);

  useEffect(() => {
    const api = window.api?.notification;
    if (!api?.consumeActivation || !api.onActivation || !api.acknowledgeActivation) return;
    const controller = new AbortController();
    let disposed = false;
    let draining = false;
    let dirty = false;
    const drain = async (): Promise<void> => {
      dirty = true;
      if (draining) return;
      draining = true;
      try {
        do {
          dirty = false;
          let activation;
          while (!disposed && (activation = await api.consumeActivation())) {
            if (disposed) return;
            const target = activation.target;
            if (!target) {
              setNotificationError("通知来源已过期或不可用");
              await api.acknowledgeActivation(activation.notificationId);
              continue;
            }
            const delivered = await deliverNotificationActivation(activation, {
              disposed: () => disposed,
              showError: setNotificationError,
              markRead: id => api.markRead(id),
              acknowledge: id => api.acknowledgeActivation(id),
              navigate: async () => {
                let opening: Promise<void> | undefined;
                const moved = await navigate?.(() => { opening = openActivationTarget(target, controller.signal); });
                if (!moved) throw new Error("导航已取消");
                await opening;
              },
            });
            if (!delivered) return;
          }
        } while (dirty && !disposed);
      } catch (error) { if (!disposed) setNotificationError(String(error)); }
      finally { draining = false; }
    };
    const unsubscribe = api.onActivation(() => { void drain(); });
    void drain();
    return () => { disposed = true; controller.abort(); unsubscribe(); };
  }, [navigate]);

  return <>
    <button type="button" className="desktop-topbar-button notification-bell" title="通知中心"
      aria-current={active ? "page" : undefined}
      aria-label={unreadCount ? `通知中心，${unreadCount} 条未读` : "通知中心"} onClick={onOpen}>
      <IconBell size={17} />
      {unreadCount > 0 && <span className="notification-bell-dot" />}
    </button>
    <ConfirmDialog open={notificationError !== null} title="通知操作失败" body={notificationError}
      confirmLabel="知道了" onCancel={() => setNotificationError(null)} onConfirm={() => setNotificationError(null)} />
  </>;
}
