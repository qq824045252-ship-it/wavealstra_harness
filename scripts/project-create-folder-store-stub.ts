export const calls: any[] = [];
export const state = {
  experts: [] as any[],
  skills: [] as any[],
  connectors: [] as any[],
  homeSpaceId: "home-original" as string | null,
  refreshExperts: async () => {},
  refreshSkills: async () => {},
  refreshConnectors: async () => {},
  ensureSpaceFromPath: async (path: string, name: string, parentId?: string | null, options?: { activate?: boolean }) => {
    calls.push(["ensureSpaceFromPath", path, name, parentId ?? null, options]);
    if (options?.activate !== false) state.homeSpaceId = "unexpected-activation";
    return { id: "project-space", created: true };
  },
  deleteSpace: async (id: string) => { calls.push(["deleteSpace", id]); },
};
export const useAppStore = Object.assign((selector: (value: typeof state) => unknown) => selector(state), { getState: () => state });