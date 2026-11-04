import {
  normalizeSelectionComment,
  selectionFingerprintMatches,
} from "../../../../../shared/selection";
import { TERMINAL_CONTEXT_MAX_CHARS } from "../../../../../shared/terminal-ipc";
import type { ChatSelection } from "../../../types";
import type { AppActions } from "../actions";
import type { AppContext } from "../context";

export function createComposerInputActions(
  storeContext: AppContext,
): Pick<
  AppActions,
  | "attachSelectionToChat"
  | "attachTerminalContext"
  | "attachArtifactToChat"
  | "continueExternalAgent"
  | "fillComposer"
  | "appendComposer"
> {
  const { get, set } = storeContext;
  return {
    attachSelectionToChat: (comment) => {
      const { selection } = get();
      if (selection.status !== "active" || !selection.descriptor) return false;
      const d = selection.descriptor;
      const classTail = d.classNames
        .slice(0, 2)
        .map((c) => `.${c}`)
        .join("");
      const label = `${d.tagName}${d.id ? `#${d.id}` : ""}${classTail}`;
      const nextSelection: ChatSelection = {
        comment:
          comment === undefined
            ? get().chatSelections.find((item) =>
                selectionFingerprintMatches(d, item),
              )?.comment
            : normalizeSelectionComment(comment),
        artifactId: d.artifactId,
        artifactVersion: d.artifactVersion,
        surfaceGeneration: d.surfaceGeneration,
        backendNodeId: d.backendNodeId,
        label,
        status: "pending",
      };
      set((s) => ({
        chatSelections: [
          ...s.chatSelections.filter(
            (item) => !selectionFingerprintMatches(d, item),
          ),
          nextSelection,
        ],
        chatFocusTick: s.chatFocusTick + 1,
      }));
      return true;
    },

    attachTerminalContext: (ctx) => {
      const { terminalSessions } = get();
      // 空间终端会话键是 workspaceId；taskId 仍写入 TerminalContextDto 供对话绑定。
      const ownerKey = ctx.workspaceId?.trim() || ctx.taskId;
      const info = terminalSessions[ownerKey];
      if (!info?.sessionId || !ctx.text?.trim()) return false;
      const text = ctx.text.slice(0, TERMINAL_CONTEXT_MAX_CHARS);
      set((s) => ({
        terminalContext: {
          taskId: ctx.taskId,
          sessionId: info.sessionId,
          cwd: info.cwd,
          shell: info.shell,
          source: ctx.source,
          text,
          capturedAt: ctx.capturedAt ?? Date.now(),
        },
        chatFocusTick: s.chatFocusTick + 1,
      }));
      return true;
    },

    attachArtifactToChat: (file) => {
      if (!file?.id || !file.name?.trim()) return false;
      set((s) => ({
        pendingRefFile: {
          id: file.id,
          name: file.name.trim(),
          path: file.path?.trim() || undefined,
          content: file.path?.trim() ? undefined : file.content,
          source: file.source ?? "artifact",
        },
        chatFocusTick: s.chatFocusTick + 1,
      }));
      return true;
    },

    continueExternalAgent: (target) => {
      const taskId = get().activeTaskId;
      if (!taskId || !target.runId?.trim()) return false;
      set((state) => ({
        pendingExternalAgentContinuation: {
          taskId,
          runId: target.runId.trim(),
          agentId: target.agentId,
          agentName: target.agentName,
        },
        chatFocusTick: state.chatFocusTick + 1,
        page: "chat",
      }));
      return true;
    },

    fillComposer: (text) => {
      const next = text?.trim() ? text : null;
      if (!next) return;
      set((s) => ({
        composerDraft: next,
        chatFocusTick: s.chatFocusTick + 1,
        page: "chat",
      }));
    },

    appendComposer: (text) => {
      const insertion = text?.trim();
      if (!insertion) return;
      set((state) => ({
        composerInsertion: state.composerInsertion
          ? `${state.composerInsertion}\n\n${insertion}`
          : insertion,
        chatFocusTick: state.chatFocusTick + 1,
        page: "chat",
      }));
    },
  };
}
