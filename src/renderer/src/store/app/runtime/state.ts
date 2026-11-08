import type { RenderHydration } from "../../../lib/renderHydration";
import { createBotNavigationPersistence } from "./botNavigation";

/** Mutable resources belong to one store instance, never a React effect. */
export interface AppRuntimeState {
  botNavigation: ReturnType<typeof createBotNavigationPersistence>;
  activeRuntimeDispose?: () => void;
  pendingPinTaskIds: Set<string>;
  pendingMoveSpaceIds: Set<string>;
  pendingMoveTaskIds: Set<string>;
  deletedTaskRuntimeTombstones: Set<string>;
  pendingTaskMetadataHydrations: Set<string>;
  externalHistoryHydrations: Map<string, number>;
  externalHistoryHydrationRequests: Map<string, { isActive(): boolean }>;
  durableResyncs: Map<string, import("../../../../../shared/durable-bot").DurableBotDelta[]>;
  moveChain: Promise<void>;
  idCounter: number;
  renderHydration: RenderHydration | null;
}

export function createAppRuntimeState(): AppRuntimeState {
  return {
    botNavigation: createBotNavigationPersistence(),
    pendingPinTaskIds: new Set(),
    pendingMoveSpaceIds: new Set(),
    pendingMoveTaskIds: new Set(),
    deletedTaskRuntimeTombstones: new Set(),
    pendingTaskMetadataHydrations: new Set(),
    externalHistoryHydrations: new Map(),
    externalHistoryHydrationRequests: new Map(),
    durableResyncs: new Map(),
    moveChain: Promise.resolve(),
    idCounter: 0,
    renderHydration: null,
  };
}
