import type { SpaceDto } from './agent-ipc';
import type { BotMessageDto } from './bot-conversation';
/** Navigation references real foreground receipts, not executable ordinary Tasks. */
export interface BotWorkspaceRequestDto {
  id: string; spaceId: string; botId: string; teamId?: string; conversationId: string;
  requestId: string; messageId: string; title: string; status: BotMessageDto['status'];
  createdAt: number; updatedAt: number; archived: boolean;
}
export interface BotWorkspaceNavigationDto { spaces: SpaceDto[]; taskSpaces: Array<{taskId:string;spaceId:string}>; foregroundRequests: BotWorkspaceRequestDto[]; }
