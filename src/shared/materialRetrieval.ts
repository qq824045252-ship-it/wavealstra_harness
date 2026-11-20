export type MaterialRetrievalMode = "keyword" | "hybrid";
export type MaterialRetrievalScope = { kind: "space" | "project"; id: string };

export interface MaterialRetrievalSettings {
  mode: MaterialRetrievalMode;
  decisionModel: string | null;
}

export interface MaterialRetrievalScopeSettings {
  override: MaterialRetrievalMode | null;
  effective: MaterialRetrievalMode;
  source: "global" | MaterialRetrievalScope["kind"];
  sourceId: string | null;
}

export const MaterialRetrievalIpc = {
  getSettings: "material-retrieval:get-settings",
  setSettings: "material-retrieval:set-settings",
  getScope: "material-retrieval:get-scope",
  setScope: "material-retrieval:set-scope",
} as const;

export interface MaterialRetrievalApi {
  getSettings(): Promise<MaterialRetrievalSettings>;
  setSettings(settings: Partial<MaterialRetrievalSettings>): Promise<MaterialRetrievalSettings>;
  getScope(scope: MaterialRetrievalScope): Promise<MaterialRetrievalScopeSettings>;
  setScope(scope: MaterialRetrievalScope, mode: MaterialRetrievalMode | null): Promise<MaterialRetrievalScopeSettings>;
}
