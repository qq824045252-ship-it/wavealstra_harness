export const PROJECT_NOTE_MAX_CHARS = 16_000;
export const ProjectNotesIpc = { read: "project:notes:read", save: "project:notes:save" } as const;

export interface ProjectNoteDto {
  projectId: string;
  content: string;
  revision: number;
  updatedAt: number;
}
export interface ProjectNoteSaveRequest {
  projectId: string;
  content: string;
  expectedRevision: number;
}
export interface ProjectNotesApi {
  read(projectId: string): Promise<ProjectNoteDto>;
  save(request: ProjectNoteSaveRequest): Promise<ProjectNoteDto>;
}
