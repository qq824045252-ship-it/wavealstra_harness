import type { SavedArtifactRequest } from "./saved-artifact";

export const CadCraftIpc = { open: "cadcraft:open" } as const;
export const CAD_USE_TOOLS = {
  create: "cad_create",
  inspect: "cad_inspect",
  edit: "cad_edit",
  export: "cad_export",
} as const;

export type CadCraftSource =
  | { type: "artifact"; id: string; taskId: string }
  | { type: "work"; file: SavedArtifactRequest };

export interface CadCraftApi {
  open(source: CadCraftSource): Promise<{ id: string }>;
}

export function cadCraftExtension(name: string): "dwg" | "dxf" | undefined {
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  return name.includes(".") && (extension === "dwg" || extension === "dxf") ? extension : undefined;
}
