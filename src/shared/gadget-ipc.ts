import type {
  GadgetCreateRequest,
  GadgetDescriptor,
  GadgetListItem,
  GadgetRuntimeState,
  GadgetScope,
  GadgetUpdateRequest,
  GadgetSourceSnapshot,
  GadgetSourceUpdateRequest,
} from "./gadget-types";

export const GadgetIpc = {
  create: "gadget:create",
  list: "gadget:list",
  get: "gadget:get",
  update: "gadget:update",
  readSource: "gadget:readSource",
  updateSource: "gadget:updateSource",
  moveScope: "gadget:moveScope",
  start: "gadget:start",
  health: "gadget:health",
  stop: "gadget:stop",
  restart: "gadget:restart",
  delete: "gadget:delete",
  convertFromArtifact: "gadget:convertFromArtifact",
  exportArtifact: "gadget:exportArtifact",
  saveAsBlueprint: "gadget:saveAsBlueprint",
  changed: "gadget:changed",
} as const;

export interface GadgetChangedEvent {
  type: "created" | "updated" | "runtime" | "deleted" | "open-requested";
  gadgetId: string;
  taskId?: string;
}

export interface GadgetListRequest {
  scope?: GadgetScope;
  includeInherited?: boolean;
}

export interface GadgetMoveScopeRequest {
  gadgetId: string;
  scope: GadgetScope;
}

export interface GadgetConvertFromArtifactRequest {
  artifactId: string;
  scope: GadgetScope;
  name?: string;
  description?: string;
}

export interface GadgetExportArtifactRequest {
  gadgetId: string;
  taskId: string;
  title?: string;
}

export interface GadgetSaveAsBlueprintRequest {
  gadgetId: string;
  name?: string;
  description?: string;
}

export interface GadgetApi {
  create(request: GadgetCreateRequest): Promise<GadgetDescriptor>;
  list(request?: GadgetListRequest): Promise<GadgetListItem[]>;
  get(id: string): Promise<GadgetListItem | null>;
  update(request: GadgetUpdateRequest): Promise<GadgetDescriptor>;
  readSource(id: string): Promise<GadgetSourceSnapshot>;
  updateSource(request: GadgetSourceUpdateRequest): Promise<GadgetSourceSnapshot>;
  moveScope(request: GadgetMoveScopeRequest): Promise<GadgetDescriptor>;
  start(id: string): Promise<GadgetRuntimeState>;
  health(id: string): Promise<GadgetRuntimeState>;
  stop(id: string): Promise<GadgetRuntimeState>;
  restart(id: string): Promise<GadgetRuntimeState>;
  delete(id: string): Promise<{ ok: true }>;
  convertFromArtifact(request: GadgetConvertFromArtifactRequest): Promise<GadgetDescriptor>;
  exportArtifact(request: GadgetExportArtifactRequest): Promise<{ artifactId: string }>;
  saveAsBlueprint(request: GadgetSaveAsBlueprintRequest): Promise<{ blueprintId: string }>;
  onChanged(callback: (event: GadgetChangedEvent) => void): () => void;
}
