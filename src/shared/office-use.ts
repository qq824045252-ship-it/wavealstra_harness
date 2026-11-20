import type { LibraryOwnerScope, LibrarySearchRequest } from "./library-ipc";
import type { SavedArtifactRequest } from "./saved-artifact";

export type OfficeSource =
  | { type: "artifact"; id: string; taskId?: string }
  | { type: "work"; file: SavedArtifactRequest }
  | { type: "library"; id: string; readOnly?: boolean; owner?: LibraryOwnerScope; reference?: LibrarySearchRequest["reference"] };
export interface OfficeOpen { source: OfficeSource; name: string; modelId?: string }
export interface OfficeRect { x: number; y: number; width: number; height: number }
export const OfficeUseIpc = { open: "office-use:open", bounds: "office-use:bounds", close: "office-use:close" } as const;
export const OFFICE_USE_TOOLS = {
  documentCreate: "office_document_create",
  documentRead: "office_document_read",
  documentRender: "office_document_render",
  editPropose: "office_edit_propose",
  reviewStatus: "office_review_status",
  nativeTools: "office_native_tools",
  nativeCall: "office_native_call",
  selectionRead: "office_selection_read",
  selectionPropose: "office_selection_propose",
} as const;
export interface OfficeUseApi {
  onFailure(callback: (id: string, message: string) => void): () => void;
  open(request: OfficeOpen): Promise<{ id: string }>;
  bounds(id: string, rect: OfficeRect): void;
  close(id: string): Promise<void>;
}
