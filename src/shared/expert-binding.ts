import type { ExpertDto } from "./agent-ipc";

/** Editable, installed expert template. Revision changes with its package contents. */
export interface ExpertDetailDto extends ExpertDto {
  instructions: string;
  revision: string;
  mcpIds: string[];
  connectorIds: string[];
}

export interface ExpertUpdateRequest {
  id: string;
  name: string;
  description: string;
  instructions: string;
  /** Omit to preserve all current private skills. Existing private ids retain their package. */
  skillIds?: string[];
  mcpIds: string[];
  connectorIds: string[];
  expectedRevision: string;
}

/** Task-owned identity; template changes are adopted explicitly. */
export interface TaskExpertSnapshot {
  revision: string;
  sourceExpertId?: string;
  sourceRevision?: string;
  name: string;
  instructions: string;
  skillIds: string[];
  mcpIds: string[];
  connectorIds: string[];
}

export interface TaskExpertBindingDto {
  taskId: string;
  desired: TaskExpertSnapshot | null;
  active: TaskExpertSnapshot | null;
  pending: boolean;
  warnings?: string[];
}

export interface TaskExpertBindingSaveRequest {
  taskId: string;
  expertId?: string | null;
  expectedRevision?: string | null;
  custom?: {
    name: string;
    instructions: string;
    skillIds: string[];
    mcpIds: string[];
    connectorIds: string[];
  };
}

export type SaveTaskExpertBindingRequest = TaskExpertBindingSaveRequest;
