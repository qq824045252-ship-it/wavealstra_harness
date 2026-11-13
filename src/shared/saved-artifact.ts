/** Read-only, exact saved-version preview. No current Task selection is consulted. */
export const SavedArtifactIpc = {
  prepare: 'saved-artifact:prepare',
  release: 'saved-artifact:release',
  openSystem: 'saved-artifact:open-system',
  saveAs: 'saved-artifact:save-as',
} as const;
export interface SavedArtifactRequest { snapshotPath: string; name: string; manifestPath?: string }
export interface SavedArtifactPreview { url: string; token: string; source: string; warnings: string[] }
export interface SavedArtifactApi {
  prepare(request: SavedArtifactRequest): Promise<SavedArtifactPreview>;
  release(token: string): Promise<void>;
  openSystem(request: SavedArtifactRequest): Promise<void>;
  saveAs(request: SavedArtifactRequest): Promise<{ canceled: boolean; path?: string }>;
}
