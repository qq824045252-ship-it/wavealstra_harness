export const state: any = {
  spaces: [{ id: "vps", name: "VPS管理", path: "C:/Work/VPS" }],
  requestLibraryNav: (target: unknown) => { (window as any).noteTest.navigation = target; },
  relocateSpace: async (id: string) => { (window as any).noteTest.relocated = id; },
};
export const useAppStore: any = Object.assign((selector: any) => selector(state), { getState: () => state });
export const sizeLabel = (size: number) => `${size} B`;
export const selectActiveTaskArtifacts = () => [];
