import { terminalOwnerStoreKey } from "../../../../../shared/terminal-ipc";
import type { TerminalSessionInfo } from "../../../../../shared/terminal-ipc";
import type { AppActions } from "../actions";
import type { AppContext } from "../context";
import { currentTerminalOwnerKey } from "../selectors";
import type { TerminalTabItem } from "../types";

export interface TerminalState {
  terminalSessions: Record<string, TerminalSessionInfo>;
  terminalTabsByOwner: Record<
    string,
    { tabs: TerminalTabItem[]; activeId: string | null }
  >;
}

export function createTerminalState(): TerminalState {
  return {
    terminalSessions: {},
    terminalTabsByOwner: {},
  };
}

export function createTerminalActions(
  storeContext: AppContext,
): Pick<
  AppActions,
  "setTerminalSession" | "applyTerminalExit" | "setActiveTerminalTabId"
> {
  const { get, set } = storeContext;
  return {
    setTerminalSession: (info) => {
      const ownerKey = terminalOwnerStoreKey(info) ?? "?";
      const rawId = info.taskId ?? info.workspaceId;
      set((s) => ({
        terminalSessions: {
          ...s.terminalSessions,
          [ownerKey]: info,
          ...(rawId ? { [rawId]: info } : {}),
        },
      }));
    },

    applyTerminalExit: (ev) => {
      set((s) => {
        const ownerKey = terminalOwnerStoreKey(ev) ?? "?";
        const rawId = ev.taskId ?? ev.workspaceId;
        const current =
          s.terminalSessions[ownerKey] ??
          (rawId ? s.terminalSessions[rawId] : undefined);
        // 旧会话（已 restart 被替换）的 exit 事件丢弃，避免覆盖新会话状态
        if (!current || current.sessionId !== ev.sessionId) return {};
        const updated = {
          ...current,
          alive: false,
          exitCode: ev.exitCode,
          exitReason: ev.reason,
        };
        return {
          terminalSessions: {
            ...s.terminalSessions,
            [ownerKey]: updated,
            ...(rawId ? { [rawId]: updated } : {}),
          },
        };
      });
    },

    setActiveTerminalTabId: (tabId: string) => {
      const s = get();
      const ownerKey = currentTerminalOwnerKey(s);
      const current = s.terminalTabsByOwner[ownerKey] ?? {
        tabs: [],
        activeId: null,
      };
      set({
        terminalTabsByOwner: {
          ...s.terminalTabsByOwner,
          [ownerKey]: { ...current, activeId: tabId },
        },
      });
    },
  };
}
