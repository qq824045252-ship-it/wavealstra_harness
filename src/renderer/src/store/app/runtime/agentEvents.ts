import type { ExternalAgentUiEvent } from "../../../../../shared/external-agent";
import type { RuntimeBinding } from "./binding";
import type { AgentDeltaBuffer } from "./deltaBuffer";

export function bindAgentEvents(
  binding: RuntimeBinding,
  deltas: AgentDeltaBuffer,
  hydrateExternalHistory: (taskId: string) => void,
): void {
  const {
    context: { get, set },
    api,
    isActive,
    addCleanup,
  } = binding;

  addCleanup(
    api.agent.onEvent((patch) => {
      if (!isActive()) return;
      if (patch.type === "text_delta" || patch.type === "thinking_delta") {
        deltas.push(patch);
        return;
      }
      // Tool and terminal events must follow every previously accepted text delta.
      deltas.flush();
      get().applyAgentPatch(patch);
    }),
  );

  addCleanup(
    api.externalAgent?.onEvent?.((event: ExternalAgentUiEvent) => {
      if (!isActive()) return;
      // A turn from another device may need its missing assistant message restored first.
      const currentTask = get().tasks.find((task) => task.id === event.taskId);
      if (
        currentTask &&
        !currentTask.messages.some(
          (message) => message.id === event.assistantMessageId,
        )
      ) {
        hydrateExternalHistory(event.taskId);
      }
      // ACP has its own channel; preserve provenance before using the shared UI reducer.
      set((state) => ({
        tasks: state.tasks.map((task) =>
          task.id !== event.taskId
            ? task
            : {
                ...task,
                messages: task.messages.map((message) =>
                  message.id !== event.assistantMessageId
                    ? message
                    : {
                        ...message,
                        externalAgent: {
                          id: event.agentId,
                          name: event.agentName,
                          protocol: event.protocol,
                          runId: event.runId,
                          continuationMode: event.continuationMode,
                          sessionReady:
                            Boolean(event.sessionId) ||
                            message.externalAgent?.sessionReady,
                          resumeSupported: event.resumeSupported,
                          recoveryState: event.recoveryState,
                          verificationStatus: event.verificationStatus,
                          outputCursor: event.outputCursor,
                        },
                        artifactIds: event.artifactRefs.length
                          ? [
                              ...new Set([
                                ...(message.artifactIds ?? []),
                                ...event.artifactRefs,
                              ]),
                            ]
                          : message.artifactIds,
                      },
                ),
              },
        ),
      }));
      const patch = event.patch;
      if (patch.type === "text_delta" || patch.type === "thinking_delta") {
        deltas.push(patch);
        return;
      }
      deltas.flush();
      get().applyAgentPatch(patch);
    }),
  );
}
