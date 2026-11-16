import type { BotWorkspaceRequestDto } from "@shared/bot-workspace-navigation";

let selected: BotWorkspaceRequestDto | null = null;

export function activateWorkspaceRequest(request: BotWorkspaceRequestDto, openDetail: (spaceId: string) => void): void {
  selected = request;
  openDetail(request.spaceId);
  window.dispatchEvent(new CustomEvent("mybuddy:workspace-request", { detail: request }));
}

export function selectedWorkspaceRequest(spaceId: string | null): BotWorkspaceRequestDto | null {
  return selected?.spaceId === spaceId ? selected : null;
}

export function clearWorkspaceRequest(): void { selected = null; }
