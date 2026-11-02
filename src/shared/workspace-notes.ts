export const WORKSPACE_NOTE_MAX_CHARS = 16_000;
export const WorkspaceNotesIpc = { read: "workspace:notes:read", save: "workspace:notes:save" } as const;

export interface WorkspaceNoteDto {
  workspaceId: string;
  content: string;
  revision: number;
  updatedAt: number;
}
export interface WorkspaceNoteSaveRequest {
  workspaceId: string;
  content: string;
  expectedRevision: number;
}
export interface WorkspaceNotesApi {
  read(workspaceId: string): Promise<WorkspaceNoteDto>;
  save(request: WorkspaceNoteSaveRequest): Promise<WorkspaceNoteDto>;
}
