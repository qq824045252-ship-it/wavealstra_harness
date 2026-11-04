import type { AppActions } from "../actions";
import type { AppContext } from "../context";
import { EMPTY_SOUL } from "../defaults";
import { formatDuration } from "../format";
import { mapTaskRowToTask } from "../tasks/taskMapper";
import { recomputeEffectiveArchived } from "../workspaces/spaceHelpers";
import { bindAgentEvents } from "./agentEvents";
import type { RuntimeBinding } from "./binding";
import { loadRuntimeBootstrap } from "./bootstrap";
import { bindCronEvents } from "./cronEvents";
import {
  createAgentDeltaBuffer,
  type AgentDeltaScheduler,
} from "./deltaBuffer";
import { bindProjectionEvents } from "./projectionEvents";
import { applySelectionMirror } from "./selectionMirror";
import { hydrateExternalAgentHistory } from "./taskHydration";

export interface InitRuntimeOptions {
  scheduler?: AgentDeltaScheduler;
}

const browserScheduler: AgentDeltaScheduler = {
  requestFrame: (callback) => requestAnimationFrame(callback),
  cancelFrame: (handle) => cancelAnimationFrame(handle),
  setTimer: (callback, delayMs) => window.setTimeout(callback, delayMs),
  clearTimer: (handle) => window.clearTimeout(handle),
};

export function createInitRuntimeActions(
  storeContext: AppContext,
  options: InitRuntimeOptions = {},
): Pick<AppActions, "initRuntime"> {
  return {
    initRuntime: () => {
      // Replacement retires the entire old lifetime, including queued deltas and async reads.
      storeContext.runtime.activeRuntimeDispose?.();
      const api = storeContext.getApi();
      if (!api?.agent) return () => undefined;

      let active = true;
      const cleanups: Array<() => void> = [];
      const deltas = createAgentDeltaBuffer({
        scheduler: options.scheduler ?? browserScheduler,
        // Cleanup still drains already accepted text after the lifetime has been closed.
        applyBatch: (patches) =>
          storeContext.get().applyAgentDeltaBatch(patches),
      });

      const dispose = (): void => {
        if (!active) return;
        active = false;
        const failures: unknown[] = [];
        try {
          deltas.dispose();
        } catch (error) {
          failures.push(error);
        }
        for (const cleanup of cleanups.splice(0)) {
          try {
            cleanup();
          } catch (error) {
            failures.push(error);
          }
        }
        if (storeContext.runtime.activeRuntimeDispose === dispose) {
          storeContext.runtime.activeRuntimeDispose = undefined;
        }
        if (failures.length)
          console.warn("[initRuntime] cleanup failed", ...failures);
      };

      storeContext.runtime.activeRuntimeDispose = dispose;
      const binding: RuntimeBinding = {
        context: storeContext,
        api,
        isActive: () => active,
        addCleanup: (cleanup) => {
          if (!cleanup) return;
          if (active) cleanups.push(cleanup);
          else cleanup();
        },
      };

      try {
        bindAgentEvents(binding, deltas, (taskId) =>
          hydrateExternalAgentHistory(storeContext, taskId, binding.isActive),
        );
        bindCronEvents(binding, formatDuration);
        bindProjectionEvents(binding, (state) =>
          applySelectionMirror(storeContext, state),
        );
        void loadRuntimeBootstrap(binding, {
          mapTaskRowToTask,
          recomputeEffectiveArchived,
          emptySoul: EMPTY_SOUL,
        });
      } catch (error) {
        dispose();
        throw error;
      }
      return dispose;
    },
  };
}
