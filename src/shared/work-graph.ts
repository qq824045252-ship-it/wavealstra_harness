/**
 * Work Graph — shared types (Phase 6 Foundation, ADR-001)
 *
 * Graph = typed relation; Workspace = context hierarchy.
 * Node = existing entity reference (no duplication).
 * Only work_graph_edges is persisted; work_graph_nodes does not exist.
 */

export type WorkGraphNodeType =
  | "workspace"
  | "task"
  | "project"
  | "plan" // ProjectTodo
  | "artifact"
  | "library_item"
  | "agent_run"; // placeholder until Phase 8

export type WorkGraphRelation =
  | "RELATES_TO"
  | "DEPENDS_ON"
  | "PRODUCES"
  | "DERIVED_FROM"
  | "BELONGS_TO"
  | "CONTAINS"
  | "SPAWNED";

export const WORK_GRAPH_RELATIONS: readonly WorkGraphRelation[] = [
  "RELATES_TO",
  "DEPENDS_ON",
  "PRODUCES",
  "DERIVED_FROM",
  "BELONGS_TO",
  "CONTAINS",
  "SPAWNED",
] as const;

export const WORK_GRAPH_NODE_TYPES: readonly WorkGraphNodeType[] = [
  "workspace",
  "task",
  "project",
  "plan",
  "artifact",
  "library_item",
  "agent_run",
] as const;

/** Which relations require DAG (no cycles). SPAWNED is a tree/forest (also DAG). */
export const WORK_GRAPH_DAG_RELATIONS: ReadonlySet<WorkGraphRelation> = new Set([
  "DEPENDS_ON",
  "SPAWNED",
]);

export interface WorkGraphNodeRef {
  type: WorkGraphNodeType;
  id: string;
}

export interface WorkGraphEdgeDto {
  id: string;
  fromType: WorkGraphNodeType;
  fromId: string;
  relation: WorkGraphRelation;
  toType: WorkGraphNodeType;
  toId: string;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface WorkGraphAddEdgeRequest {
  fromType: WorkGraphNodeType;
  fromId: string;
  relation: WorkGraphRelation;
  toType: WorkGraphNodeType;
  toId: string;
  metadata?: Record<string, unknown>;
}

export interface WorkGraphListRequest {
  type: WorkGraphNodeType;
  id: string;
  relation?: WorkGraphRelation;
}

export const WorkGraphIpc = {
  addEdge: "workgraph:addEdge",
  removeEdge: "workgraph:removeEdge",
  listOutgoing: "workgraph:listOutgoing",
  listIncoming: "workgraph:listIncoming",
  listRelated: "workgraph:listRelated",
  checkIntegrity: "workgraph:checkIntegrity",
  previewRepair: "workgraph:previewRepair",
  applyRepair: "workgraph:applyRepair",
  benchmark: "workgraph:benchmark",
  observability: "workgraph:observability",
} as const;

export interface WorkGraphIntegrityFinding {
  kind: string;
  edgeId?: string;
  relation?: string;
  detail: string;
}
export interface WorkGraphIntegrityReport {
  checkedAt: number;
  findings: WorkGraphIntegrityFinding[];
  summary: Record<string, number>;
}
export interface WorkGraphRepairPreview {
  willDeleteEdgeIds: string[];
  willDeleteBindingKeys: Array<{ workspaceId: string; librarySpaceId: string }>;
  note: string;
}
export interface WorkGraphBenchmarkResult {
  spaces: number;
  tasks: number;
  edges: number;
  timingsMs: Record<string, number>;
}
export interface WorkGraphObservability {
  edges: number;
  resolverMs?: number;
  locatorMs?: number;
  indexPending?: number;
}

export type WorkGraphAddEdgeResult =
  | { ok: true; edge: WorkGraphEdgeDto; created: boolean }
  | { ok: false; error: string };

export type WorkGraphRemoveEdgeResult =
  | { ok: true; removed: boolean }
  | { ok: false; error: string };
