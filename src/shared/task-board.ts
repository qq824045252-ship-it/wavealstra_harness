import type { BotWorkspaceRequestDto } from "./bot-workspace-navigation";

export const boardViews = [
  "attention",
  "today",
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
export type BoardDateKind = "follow" | "result" | "due" | "updated";
export interface BoardQuery {
  view: TaskBoardView;
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
