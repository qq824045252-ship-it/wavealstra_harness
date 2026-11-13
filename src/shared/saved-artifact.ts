/** Read-only, exact saved-version preview. No current Task selection is consulted. */
export const SavedArtifactIpc = {
  saveMessageHtml: 'saved-artifact:save-message-html',
  prepare: 'saved-artifact:prepare',
  release: 'saved-artifact:release',
  openSystem: 'saved-artifact:open-system',
  saveAs: 'saved-artifact:save-as',
} as const;
export interface SavedArtifactRequest { snapshotPath: string; name: string; manifestPath?: string }
export interface MessageHtmlRequest { botId: string; conversationId: string; messageId: string; index: number; expectedRevision?: number }
export interface MessageHtmlArtifact extends SavedArtifactRequest { digest: string; sizeBytes: number }
export interface SavedArtifactPreview { url: string; token: string; source: string; warnings: string[] }
export interface SavedArtifactApi {
  saveMessageHtml(request: MessageHtmlRequest): Promise<MessageHtmlArtifact>;
  prepare(request: SavedArtifactRequest): Promise<SavedArtifactPreview>;
  release(token: string): Promise<void>;
  openSystem(request: SavedArtifactRequest): Promise<void>;
  saveAs(request: SavedArtifactRequest): Promise<{ canceled: boolean; path?: string }>;
}
