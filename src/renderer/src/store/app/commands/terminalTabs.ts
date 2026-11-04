import { canvasPanelWidth } from "../../../lib/panelWidth";
import type { AppActions } from "../actions";
import type { AppContext } from "../context";
import { currentTerminalOwnerKey } from "../selectors";
import type { TerminalTabItem } from "../types";

export function createTerminalTabsActions(
  storeContext: AppContext,
): Pick<AppActions, "createTerminalTab" | "closeTerminalTab"> {
  const { get, set } = storeContext;
  return {
    createTerminalTab: () => {
      const s = get();
      const ownerKey = currentTerminalOwnerKey(s);
      const current = s.terminalTabsByOwner[ownerKey] ?? {
        tabs: [],
        activeId: null,
      };
      let nextNum = 1;
      while (current.tabs.some((t) => t.title === `终端 ${nextNum}`)) {
        nextNum++;
      }
      const newTab: TerminalTabItem = {
        id: `term-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        title: `终端 ${nextNum}`,
      };
      const nextTabs = [...current.tabs, newTab];
      set({
        terminalTabsByOwner: {
          ...s.terminalTabsByOwner,
          [ownerKey]: { tabs: nextTabs, activeId: newTab.id },
        },
        panelOpen: true,
        panelMode: "terminal",
        extensionView: "terminal",
        extensionFlyoutOpen: false,
        panelWidth: canvasPanelWidth(s.sidebarCollapsed),
      });
    },

    closeTerminalTab: (tabId: string) => {
      const s = get();
      const ownerKey = currentTerminalOwnerKey(s);
      const current = s.terminalTabsByOwner[ownerKey] ?? {
        tabs: [],
        activeId: null,
      };
      const idx = current.tabs.findIndex((t) => t.id === tabId);
      if (idx < 0) return;
      const nextTabs = current.tabs.filter((t) => t.id !== tabId);
      let nextActiveId = current.activeId;
      if (current.activeId === tabId) {
        if (nextTabs.length === 0) {
          nextActiveId = null;
        } else {
          const nextIdx = Math.min(idx, nextTabs.length - 1);
          nextActiveId = nextTabs[nextIdx].id;
        }
      }

      // 立即更新该终端在 terminalSessions 中的状态为已结束（alive: false），
      // 确保概览中的「后台任务」即刻反映 exit，绝不在前台残留 running 假象
      const updatedSessions = { ...s.terminalSessions };
      for (const [key, sess] of Object.entries(updatedSessions)) {
        if (sess && (sess.terminalId === tabId || key.endsWith(`:${tabId}`))) {
          updatedSessions[key] = {
            ...sess,
            alive: false,
            exitCode: sess.exitCode ?? -1073741510,
            exitReason: "killed",
          };
        }
      }
      const rawId =
        s.page === "workspace" && s.activeWorkspaceId
          ? s.activeWorkspaceId
          : (s.activeTaskId ?? s.activeWorkspaceId);
      if (rawId && updatedSessions[rawId]?.terminalId === tabId) {
        updatedSessions[rawId] = {
          ...updatedSessions[rawId],
          alive: false,
          exitCode: updatedSessions[rawId].exitCode ?? -1073741510,
          exitReason: "killed",
        };
      }

      set({
        terminalTabsByOwner: {
          ...s.terminalTabsByOwner,
          [ownerKey]: { tabs: nextTabs, activeId: nextActiveId },
        },
        terminalSessions: updatedSessions,
      });
      try {
        if (s.page === "workspace" && s.activeWorkspaceId) {
          storeContext
            .getApi()
            ?.terminal?.close({
              workspaceId: s.activeWorkspaceId,
              terminalId: tabId,
            });
        } else if (s.activeTaskId) {
          storeContext
            .getApi()
            ?.terminal?.close({ taskId: s.activeTaskId, terminalId: tabId });
        } else if (s.activeWorkspaceId) {
          storeContext
            .getApi()
            ?.terminal?.close({
              workspaceId: s.activeWorkspaceId,
              terminalId: tabId,
            });
        }
      } catch {
        /* ignore */
      }
    },
  };
}
