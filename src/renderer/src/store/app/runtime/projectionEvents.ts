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
    context: { get },
    api,
    isActive,
    addCleanup,
  } = binding;
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
