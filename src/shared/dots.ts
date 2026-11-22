import type { SpaceDto, TaskDto } from "./agent-ipc";

export function dotsLocalSpacePath(space: SpaceDto, parent: (id: string) => SpaceDto | undefined): string[] | undefined {
  const names: string[] = [];
  const seen = new Set<string>();
  let current: SpaceDto | undefined = space;
  while (current) {
    if (seen.has(current.id) || current.id.startsWith("sp-gw-") || /^bot-(space-|team-space-|workspace-group-)/.test(current.id)) return;
    seen.add(current.id);
    names.unshift(current.name);
    if (!current.parentId) return names;
    current = parent(current.parentId);
  }
}

/** One foreground per local profile. It never belongs to a project or task list. */
export const DOTS_TASK_ID = "mybuddy-dots";
export const DOTS_NO_CHANGE = "[[dots:no-change]]";
export function isDotsAutomaticInput(requestId: string): boolean {
  return /^cron-[0-9a-f-]{36}-input$/i.test(requestId) || requestId.startsWith("goal-continuation:");
}
export const DotsIpc = { open: "dots:open", list: "dots:list", changed: "dots:changed" } as const;

export interface DotsDelegation {
  id: string;
  taskId: string;
  title: string;
  sourceMessageId: string;
  /** The desktop journal handles the result as a conversation follow-up. */
  proactiveReply?: boolean;
  goalId?: string;
  status: "pending" | "running" | "blocked" | "completed" | "failed" | "superseded";
  interactionId?: string;
  text: string;
  artifacts: { id: string; name: string; saved?: import("./saved-artifact").SavedArtifactRequest; version?: number }[];
  createdAt: number;
  updatedAt: number;
}

export interface DotsReplyOrigin {
  conversationId: number;
  entryId: number;
}

/** A worker result belongs to the Dots input that commissioned it. */
export interface DotsAssistantReply {
  deliveryKey: string;
  operationId: string;
  taskId: string;
  sourceMessageId: string;
  origin?: DotsReplyOrigin;
  title: string;
  kind: "conclusion" | "question" | "progress";
  text: string;
  citations?: import("./chat-reply-content").ReplyCitation[];
  artifacts: DotsDelegation["artifacts"];
}

export interface DotsApi {
  open(): Promise<TaskDto>;
  list(sourceIds?: string[]): Promise<DotsDelegation[]>;
  onChanged(listener: () => void): () => void;
}
