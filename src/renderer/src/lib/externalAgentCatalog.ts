import { create } from "zustand";
import type { ExternalAgentDescriptorDto } from "@shared/external-agent";

interface ExternalAgentCatalog {
  agents: ExternalAgentDescriptorDto[];
  loaded: boolean;
  loading: boolean;
  error: string | null;
}

/** Settings and composer menus share one catalog for this renderer's lifetime. */
export const useExternalAgentCatalog = create<ExternalAgentCatalog>(() => ({
  agents: [],
  loaded: false,
  loading: false,
  error: null,
}));

let generation = 0;
let pending: Promise<ExternalAgentDescriptorDto[]> | null = null;

export function updateExternalAgentCatalog(agents: ExternalAgentDescriptorDto[]): void {
  generation += 1;
  pending = null;
  useExternalAgentCatalog.setState({ agents, loaded: true, loading: false, error: null });
}

export function loadExternalAgentCatalog(refresh = false): Promise<ExternalAgentDescriptorDto[]> {
  const state = useExternalAgentCatalog.getState();
  if (!refresh && state.loaded) return Promise.resolve(state.agents);
  if (!refresh && pending) return pending;
  const list = window.api?.externalAgent?.listAgents;
  if (!list) return Promise.reject(new Error("外部 Agent API 未就绪，请完整重启应用"));
  const requestGeneration = ++generation;
  useExternalAgentCatalog.setState({ loading: true, error: null });
  const request = list(refresh)
    .then((items) => {
      if (generation === requestGeneration) {
        useExternalAgentCatalog.setState({ agents: items ?? [], loaded: true });
      }
      return useExternalAgentCatalog.getState().agents;
    })
    .catch((error: unknown) => {
      if (generation === requestGeneration) {
        useExternalAgentCatalog.setState({ error: error instanceof Error ? error.message : String(error) });
      }
      throw error;
    })
    .finally(() => {
      if (generation === requestGeneration) {
        pending = null;
        useExternalAgentCatalog.setState({ loading: false });
      }
    });
  pending = request;
  return request;
}
