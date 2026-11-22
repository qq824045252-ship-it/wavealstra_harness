import type { BotWorkspaceRequestDto } from "@shared/bot-workspace-navigation";

export type WorkspaceRequestSelection = BotWorkspaceRequestDto & {
  focusMessageId?: string;
};
let selected: WorkspaceRequestSelection | null = null;
let revision = 0;
export const workspaceRequestRevision = (): number => revision;

export function activateWorkspaceRequest(request: WorkspaceRequestSelection, openDetail: (spaceId: string) => void): void {
  selected = request;
  revision++;
  openDetail(request.spaceId);
  window.dispatchEvent(new CustomEvent("mybuddy:workspace-request", { detail: request }));
}

export function selectedWorkspaceRequest(spaceId: string | null): WorkspaceRequestSelection | null {
  return selected?.spaceId === spaceId ? selected : null;
}

export function clearWorkspaceRequest(): void { if (selected) revision++; selected = null; }
