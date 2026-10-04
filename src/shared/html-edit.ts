export type HtmlEditTarget = "browser" | "artifact";
export interface HtmlEditStart { target: HtmlEditTarget; artifactId?: string; modelId?: string }
export interface HtmlEditPatch { key: string; html: string; align?: string; deleted?: boolean }
export interface HtmlEditNode { key: string; selector: string; html: string; deletable: boolean }
export interface HtmlEditSnapshot {
  revision: number; patches: HtmlEditPatch[];
  selected: null | { key: string; text: string; html: string; deletable: boolean; x: number; y: number; width: number; height: number };
  error?: string;
}
export interface HtmlEditRuntimeAction { id: string; name: "ai" | "save" | "stop"; value?: string }
export interface HtmlEditRuntimeTick { snapshot: HtmlEditSnapshot; actions: HtmlEditRuntimeAction[] }
export interface HtmlEditRuntimeUiState { status: string; canSave: boolean; busy: boolean; aiEnabled: boolean }
export interface HtmlEditState { active: boolean; target?: HtmlEditTarget; error?: string; message?: string }
export interface HtmlEditApi {
  start(request: HtmlEditStart): Promise<{ ok: boolean; error?: string }>;
  stop(): Promise<void>;
  onState(callback: (state: HtmlEditState) => void): () => void;
}
export const HtmlEditIpc = { start: "html-edit:start", stop: "html-edit:stop", state: "html-edit:state" } as const;