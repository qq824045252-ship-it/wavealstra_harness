import type { GadgetDescriptor, GadgetRuntimeState } from "../../shared/gadget-types";

export class GadgetRegistry {
  private readonly descriptors = new Map<string, GadgetDescriptor>();
  private readonly runtimes = new Map<string, GadgetRuntimeState>();

  rebuild(descriptors: GadgetDescriptor[]): void {
    this.descriptors.clear();
    for (const descriptor of descriptors) this.descriptors.set(descriptor.id, descriptor);
  }

  upsert(descriptor: GadgetDescriptor): void {
    this.descriptors.set(descriptor.id, descriptor);
  }

  remove(id: string): void {
    this.descriptors.delete(id);
    this.runtimes.delete(id);
  }

  setRuntime(state: GadgetRuntimeState): void {
    this.runtimes.set(state.gadgetId, { ...state });
  }

  runtime(id: string): GadgetRuntimeState {
    return this.runtimes.get(id) ?? { gadgetId: id, status: "stopped" };
  }
}
