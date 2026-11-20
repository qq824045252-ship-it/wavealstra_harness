import type { SavedArtifactRequest } from "./saved-artifact";

export const CadCraftIpc = { openCopy: "cadcraft:open-copy" } as const;

export type CadCraftSource =
  | { type: "artifact"; id: string; taskId: string }
  | { type: "work"; file: SavedArtifactRequest };

export type CadCraftOpenResult = { canceled: true } | { canceled: false; path: string };

export interface CadCraftApi {
  openCopy(source: CadCraftSource): Promise<CadCraftOpenResult>;
}

export function cadCraftExtension(name: string): "dwg" | "dxf" | undefined {
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return name.includes(".") && (extension === "dwg" || extension === "dxf") ? extension : undefined;
}
