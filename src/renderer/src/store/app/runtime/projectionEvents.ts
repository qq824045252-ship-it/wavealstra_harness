import { mapTaskRowToTask } from "../tasks/taskMapper";
import {
  selectionFingerprintMatches,
  type SelectionState,
} from "../../../../../shared/selection";
import type { RuntimeBinding } from "./binding";

export function bindProjectionEvents(
  binding: RuntimeBinding,
  applySelectionMirror: (state: SelectionState) => void,
): void {
  const {
    context: { get, set },
    api,
    isActive,
    addCleanup,
  } = binding;
  let dotsRefresh = 0;
  addCleanup(api.dots?.onChanged(() => {
    if (!isActive()) return;
    const revision = ++dotsRefresh;
    void get().refreshSpaces();
    void api.db.listTasks().then(rows => {
      if (!isActive() || revision !== dotsRefresh) return;
      const state = get();
      const known = new Set(state.tasks.map(task => task.id));
      const missing = rows.filter(row => !known.has(row.id));
      if (!missing.length) return;
      const context = {
        enabledModelIds: new Set(state.models.filter(model => model.enabled !== false).map(model => model.id)),
        defaultModelId: state.defaultModelId,
        permissionModeDefault: state.permissionMode,
      };
      set({ tasks: [...state.tasks, ...missing.map(row => mapTaskRowToTask(row, context))] });
    }).catch(reason => console.warn("[Dots] 任务列表刷新失败", reason));
  }));
  const domain = api.artifactDomain;
  if (domain) {
    addCleanup(
      domain.onCreated((event) => {
        if (isActive()) get().applyArtifactCreated(event);
      }),
    );
    addCleanup(
      domain.onUpdated((event) => {
        if (isActive()) get().applyArtifactUpdated(event);
      }),
    );
    addCleanup(
      domain.onRemoved((event) => {
        if (isActive()) get().applyArtifactRemoved(event);
      }),
    );
  }

  // SelectionStore in Main remains the authority; this runtime only mirrors it.
  void api.selection
    ?.get()
    ?.then((state) => {
      if (isActive() && state) applySelectionMirror(state);
    })
    .catch(() => undefined);
  addCleanup(
    api.selection?.onChanged?.(({ state }) => {
      if (isActive()) applySelectionMirror(state);
    }),
  );
  addCleanup(
    api.selection?.onAttach?.(({ selection, comment }) => {
      if (!isActive()) return;
      const current = get().selection;
      if (
        current.status === "active" &&
        current.descriptor &&
        selectionFingerprintMatches(current.descriptor, selection)
      ) {
        get().attachSelectionToChat(comment);
      }
    }),
  );
}
