import type { GadgetRuntimeState } from "../../shared/gadget-types";

export class GadgetRegistry {
  private readonly runtimes = new Map<string, GadgetRuntimeState>();

  remove(id: string): void {
    this.runtimes.delete(id);
  }

  setRuntime(state: GadgetRuntimeState): void {
    this.runtimes.set(state.gadgetId, { ...state });
  }

  runtime(id: string): GadgetRuntimeState {
    return this.runtimes.get(id) ?? { gadgetId: id, status: "stopped" };
  }
}
