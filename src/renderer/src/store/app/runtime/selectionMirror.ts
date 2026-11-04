import type { SelectionState } from "../../../../../shared/selection";
import type { AppContext } from "../context";

export function applySelectionMirror(
  storeContext: AppContext,
  state: SelectionState,
): void {
  const { get, set } = storeContext;
  set({ selection: state });
  const current = get().chatSelections;
  if (!current.length) return;
  let changed = false;
  const next = current.map((item) => {
    if (item.status === "stale") return item;
    const d = state.status === "active" ? state.descriptor : null;
    const sameSurface = Boolean(
      d &&
        d.artifactId === item.artifactId &&
        d.artifactVersion === item.artifactVersion &&
        d.surfaceGeneration === item.surfaceGeneration,
    );
    if (sameSurface) return item;
    changed = true;
    return { ...item, status: "stale" as const };
  });
  if (changed) set({ chatSelections: next });
}
