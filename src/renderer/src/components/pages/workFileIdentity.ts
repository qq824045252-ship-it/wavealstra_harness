import type { WorkProjectionDto } from "@shared/bot-work";

type GeneratedFile = NonNullable<WorkProjectionDto["generatedArtifacts"]>[number];
export interface WorkFile { ref: string; name: string; artifact?: GeneratedFile; openPath?: string; previewManifestPath?: string | null }

export const previewManifestFor = (file: WorkFile): string | undefined => file.previewManifestPath === null ? undefined : file.previewManifestPath ?? file.artifact?.previewManifestPath;
