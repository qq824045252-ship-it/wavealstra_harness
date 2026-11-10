import type { Task } from "../src/renderer/src/types";
import type { BotDto, WorkProjectionDto } from "../src/shared/bot-work";
import type { BotHistoryDto } from "../src/shared/bot-conversation";
import type { SubagentSummaryDto } from "../src/shared/agent-ipc";
export const tasks: Task[] = [
  { id: "ordinary", title: "核对杭州天气", status: "in_progress", updatedAt: 100, messages: [{ id: "m", role: "assistant", createdAt: 100, blocks: [{ type: "text", text: "正在查询天气来源" }], streaming: true }] },
  { id: "failed", title: "失败任务不能显示运行", status: "failed", updatedAt: 90, messages: [] },
  { id: "finished", title: "已完成任务不能显示运行", status: "completed", updatedAt: 80, messages: [] },
  { id: "binding-task", title: "内部执行体不重复", status: "in_progress", updatedAt: 100, messages: [] },
];
export const bots = [{ botId: "owner", userId: "user", displayName: "MyBuddy" }] as BotDto[];
export const works: WorkProjectionDto[] = [
  { workId: "work", title: "整理季度报告", mode: "once", lifecycle: "active", ownerBotId: "owner", ownerEpoch: 1, intentRevision: 1, sourceVersion: 1, stateVersion: 1, inputSnapshotId: "input", inputSnapshotBound: true,
    goalSources: [], criteria: [], acceptedDeliverableIds: [], deliverables: [], blockers: [],
    executions: [{ taskId: "binding-task", status: "pending", intentRevision: 1, inputSnapshotId: "input" } as WorkProjectionDto["executions"][number]],
    notifications: [], subscriptionIds: [], uncoveredScope: [], nextSteps: ["等待执行体启动"], updatedAt: 120 },
];
export const histories: Record<string, BotHistoryDto> = { owner: { botId: "owner", conversationId: "conversation", revision: 1, archived: false,
  messages: [
    { messageId: "user", conversationId: "conversation", botId: "owner", requestId: "request", ordinal: 1, role: "user", text: "查明天是否下雨", status: "completed", workIds: [], createdAt: 100, updatedAt: 100 },
    { messageId: "reply", conversationId: "conversation", botId: "owner", requestId: "request", ordinal: 2, role: "assistant", text: "正在读取气象来源", status: "running", workIds: [], createdAt: 100, updatedAt: 101 },
  ] } };
export const subagents = { ordinary: [{ subagentId: "child", displayName: "天气核验员", role: "researcher", status: "running", createdAt: 100, updatedAt: 100, lastTask: "交叉核对降雨概率", workerAlive: true, project: "/fixture" } as SubagentSummaryDto] };
