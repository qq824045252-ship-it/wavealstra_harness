import type { StoreApi } from "zustand";
import type { AppState } from "./types";
import type { AppRuntimeState } from "./runtime/state";

/** Dependencies shared by actions; no module imports the instantiated store. */
export interface AppContext {
  get: StoreApi<AppState>["getState"];
  set: StoreApi<AppState>["setState"];
  getApi: () => Window["api"];
  runtime: AppRuntimeState;
}

export interface AppStoreDependencies {
  /** Resolve lazily: preload and test bridges can become available after construction. */
  getApi?: () => Window["api"];
}
