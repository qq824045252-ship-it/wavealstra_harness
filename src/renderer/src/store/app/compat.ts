import { appContext } from "./store";
import { hydrateExternalAgentHistory as hydrateHistory } from "./runtime/taskHydration";
import { applySelectionMirror as applyMirror } from "./runtime/selectionMirror";
import type { SelectionState } from "../../../../shared/selection";

export function hydrateExternalAgentHistory(taskId: string): void {
  hydrateHistory(appContext, taskId);
}
export function applySelectionMirror(state: SelectionState): void {
  applyMirror(appContext, state);
}
