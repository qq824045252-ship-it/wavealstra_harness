import type {
  BlueprintCaptureOptions,
  BlueprintCreateRequest,
  BlueprintDescriptor,
  BlueprintInstantiateRequest,
  BlueprintInstantiationPlan,
  BlueprintInstantiationResult,
  ResolvedBlueprint,
  BlueprintUpdateRequest,
} from "./blueprint-types";
import type { TemplateCapabilityRegistries } from "./project-template/types";

export const BlueprintIpc = {
  create: "blueprint:create",
  list: "blueprint:list",
  get: "blueprint:get",
  update: "blueprint:update",
  resolve: "blueprint:resolve",
  plan: "blueprint:plan",
  capture: "blueprint:capture",
  previewCapture: "blueprint:previewCapture",
  instantiate: "blueprint:instantiate",
  delete: "blueprint:delete",
  changed: "blueprint:changed",
} as const;

export interface BlueprintChangedEvent {
  type: "created" | "updated" | "deleted";
  blueprintId: string;
}

export interface BlueprintCaptureRequest {
  workspaceId: string;
  options: BlueprintCaptureOptions;
  /** Exact definition the user previewed and confirmed; avoids saving a different live recapture. */
  confirmedDefinition?: import("./blueprint-types").BlueprintDefinition;
}

export interface BlueprintApi {
  create(request: BlueprintCreateRequest): Promise<BlueprintDescriptor>;
  list(): Promise<BlueprintDescriptor[]>;
  get(id: string): Promise<BlueprintDescriptor | null>;
  update(request: BlueprintUpdateRequest): Promise<BlueprintDescriptor>;
  resolve(id: string, registries?: TemplateCapabilityRegistries): Promise<ResolvedBlueprint>;
  plan(id: string, registries?: TemplateCapabilityRegistries): Promise<BlueprintInstantiationPlan>;
  capture(request: BlueprintCaptureRequest): Promise<BlueprintDescriptor>;
  previewCapture(request: BlueprintCaptureRequest): Promise<import("./blueprint-types").BlueprintDefinition>;
  instantiate(request: BlueprintInstantiateRequest): Promise<BlueprintInstantiationResult>;
  delete(id: string): Promise<{ ok: true }>;
  onChanged(callback: (event: BlueprintChangedEvent) => void): () => void;
}
