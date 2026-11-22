import type { BotWorkspaceRequestDto } from "./bot-workspace-navigation";

export const boardViews = [
  "attention",
  "today",
  "running",
  "review",
  "week",
  "recent",
  "frequent",
  "dates",
  "all",
  "unread",
  "pinned",
  "later",
  "results",
  "automation",
] as const;
export type TaskBoardView = (typeof boardViews)[number];
export const boardLanes = ["attention", "pending", "running", "finished"] as const;
export type TaskBoardLane = (typeof boardLanes)[number];
export type BoardDateKind = "follow" | "result" | "due" | "updated";
export interface BoardQuery {
  view: TaskBoardView;
  lane?: TaskBoardLane;
  scope?: string | null;
  projectId?: string;
  search?: string;
  dateKind?: BoardDateKind;
  from?: number;
  until?: number;
  cursor?: { rank: number; at: number; id: string };
  preview?: boolean;
  jobId?: string;
}
export interface TaskBoardRow {
  id: string;
  title: string;
  spaceId: string | null;
  status: string;
  updatedAt: number;
  dueAt?: number;
  startAt?: number;
  pinned: boolean;
  unread: boolean;
  reason?: string;
  failureReason?: string;
  wait?: { kind: "question" | "approval" | "input"; reason?: string };
  activity?: { kind: "retrying" | "compacting"; reason?: string };
  pendingReviewCount?: number;
  resultSinceFollow?: number;
  messageId?: string;
  interactionId?: string;
  toolCallId?: string;
  request?: BotWorkspaceRequestDto;
  jobId?: string;
  at: number;
  rank: number;
  planned: boolean;
  laterUntil?: number;
}
export interface BoardPage {
  rows: TaskBoardRow[];
  total?: number;
  next?: BoardQuery["cursor"];
}
export type BoardAction = "visit" | "read" | "today" | "later" | "clear";
