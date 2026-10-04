export const state = { soul: { alias: "我" }, artifacts: [] as any[], activeTaskId: null, tasks: [] as any[], spaces: [] as any[] };
export const useAppStore = Object.assign((selector: (value: typeof state) => unknown) => selector(state), { getState: () => state, setState: () => {} });
export const sizeLabel = (bytes: number): string => `${bytes} B`;
export const selectActiveTaskArtifacts = (): any[] => [];
