import type { MemoryKind, MemoryScopeDto } from "./memory-kernel";

export type MemoryOrganizationStatus = "scanning" | "paused" | "ready" | "applied" | "undone" | "dismissed";
export type MemoryOrganizationAction = "merge" | "rewrite" | "split" | "retire" | "conflict";
export interface MemoryOrganizationText { kind: MemoryKind; title: string; content: string }
export interface MemoryOrganizationProposal {
  id: string;
  action: MemoryOrganizationAction;
  reason: string;
  before: Array<MemoryOrganizationText & { id: string }>;
  after: MemoryOrganizationText[];
  scopes: MemoryScopeDto[];
}
export interface MemoryOrganizationRun {
  id: string;
  status: MemoryOrganizationStatus;
  createdAt: number;
  updatedAt: number;
  total: number;
  scanned: number;
  skipped: number;
  unchanged: number;
  completedBatches: number;
  totalBatches: number;
  proposals: MemoryOrganizationProposal[];
  error?: string;
  beforeChars: number;
  afterChars: number;
}
export const MemoryOrganizationIpc = {
  latest: "memory:organization:latest",
  start: "memory:organization:start",
  pause: "memory:organization:pause",
  apply: "memory:organization:apply",
  undo: "memory:organization:undo",
  dismiss: "memory:organization:dismiss",
} as const;
