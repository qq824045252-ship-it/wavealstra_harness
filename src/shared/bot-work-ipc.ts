import type { BotHistoryRequest, BotHistoryDto } from "./bot-conversation";
import type { WorkProjectionDto } from "./bot-work";
import type { BotWorkspaceNavigationDto } from "./bot-workspace-navigation";

/** Read-only access to historical Bot conversations and their recorded Work. */
export const BotWorkIpc = {
  history: "bot-work:history",
  workspaceNavigation: "bot-work:workspace-navigation",
  getWork: "bot-work:get-work",
} as const;

export interface BotWorkApi {
  history(request: BotHistoryRequest): Promise<BotHistoryDto>;
  workspaceNavigation(): Promise<BotWorkspaceNavigationDto>;
  getWork(workId: string): Promise<WorkProjectionDto | undefined>;
}
