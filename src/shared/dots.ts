import type { SpaceDto, TaskDto } from "./agent-ipc";
import type { AssemblySegmentDto } from "./mode-profile";

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

export { DOTS_TASK_ID, DOTS_NO_CHANGE, isDotsAutomaticInput } from "../../shared/src/dots-conversation";
export const DotsIpc = { open: "dots:open", list: "dots:list", activity: "dots:activity",
  newConversation: "dots:newConversation",
  taskDelivery: "dots:taskDelivery", getPromptSegments: "dots:getPromptSegments", changed: "dots:changed",
  report: "dots:report", reportChanged: "dots:reportChanged" } as const;

export interface DotsDependencyWait {
  operationId: string;
  title: string;
  deadlineAt: number;
}

export const dotsCapabilityKinds = ["tool", "skill", "connector", "expert", "mode", "preset", "mcp"] as const;
export type DotsCapabilityRequirement = {
  kind: typeof dotsCapabilityKinds[number];
  id: string;
  /** Exact visible MCP tool, when the assignment needs more than the server. */
  tool?: string;
};

export interface DotsDelegation {
  id: string;
  taskId: string;
  title: string;
  sourceMessageId: string;
  /** The desktop journal handles the result as a conversation follow-up. */
  proactiveReply?: boolean;
  goalId?: string;
  activity?: {
    lastActivityAt: number;
    lastProgressAt?: number;
    lastReportAt?: number;
    tool: string;
    phase: "start" | "finish";
  };
  status: "pending" | "running" | "blocked" | "completed" | "failed" | "superseded";
  interactionId?: string;
  dependencyWait?: DotsDependencyWait;
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
  retryApproval?: true;
  completion?: { id: string; workId: string; intentRevision: number; stateVersion: number };
  title: string;
  kind: "conclusion" | "question" | "progress";
  presentation?: "report";
  text: string;
  citations?: import("./chat-reply-content").ReplyCitation[];
  artifacts: DotsDelegation["artifacts"];
}

export type DotsTaskDelivery = Pick<DotsAssistantReply, "deliveryKey" | "operationId" | "artifacts">;
export type DotsLiveReport = Pick<DotsAssistantReply, "deliveryKey" | "operationId" | "taskId" | "sourceMessageId"
  | "title" | "text" | "origin" | "kind">;
export type DotsWorkerObservation = { id: string; generationId: number; text: string; preview: string };
export type DotsTaskOutput = { text: string; active: boolean };

type DotsActivityTask = {
  id: string;
  taskId: string;
  title: string;
  space: string;
  summary: string;
  presentation?: { phase: "details" | "summary"; text: string } | ({ phase: "streaming" } & DotsTaskOutput);
  updatedAt: number;
};

export type DotsActivityItem = DotsActivityTask & (
  | { state: "waiting"; target: { taskId: string; messageId: string; interactionId?: string } }
  | { state: "dependency"; dependencyWait: DotsDependencyWait }
  | { state: "delivered"; deliveryKey: string; fileCount: number }
  | { state: "running"; phase: "queued" | "working" | "following"; lastActivityAt?: number }
  | { state: "paused" | "stopped" | "failed" | "blocked" | "undelivered" | "superseded" }
);

export interface DotsApi {
  open(): Promise<TaskDto>;
  newConversation(): Promise<void>;
  list(sourceIds?: string[]): Promise<DotsDelegation[]>;
  activity(): Promise<DotsActivityItem[]>;
  taskDelivery(taskId: string): Promise<DotsTaskDelivery | undefined>;
  getPromptSegments(): Promise<AssemblySegmentDto[]>;
  onChanged(listener: () => void): () => void;
  report(): Promise<DotsLiveReport | null>;
  onReport(listener: (report: DotsLiveReport | null) => void): () => void;
}
