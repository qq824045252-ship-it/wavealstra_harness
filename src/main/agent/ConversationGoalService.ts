import { randomUUID } from "node:crypto";
import type { AgentUiPatch } from "../../shared/agent-ipc";
import {
  CONVERSATION_GOAL_MAX_CRITERIA,
  type ConversationGoalCreateRequest,
  type ConversationGoalDto,
  type ConversationGoalUpdateRequest,
} from "../../shared/conversation-goal";
import type { ConversationGoalMutationResult } from "../../shared/conversation-runtime";
import { ConversationGoalRepository } from "./ConversationGoalRepository";

export class ConversationGoalService {
  constructor(
    private readonly repo: ConversationGoalRepository,
    private readonly emit: (patch: AgentUiPatch) => void,
  ) {}

  create(request: ConversationGoalCreateRequest): ConversationGoalMutationResult {
    if (!request.taskId?.trim() || !request.title?.trim()) {
      return { ok: false, code: "invalid_request", message: "Task 与目标标题不能为空" };
    }
    const existing = this.repo.getLiveByTask(request.taskId);
    if (existing && (existing.status === "active" || existing.status === "blocked")) {
      return { ok: false, code: "conflict", message: "当前 Task 已有进行中的 Goal，请先更新或结束它" };
    }
    const now = Date.now();
    const goal = this.repo.insert({
      id: `goal-${randomUUID()}`,
      taskId: request.taskId,
      title: request.title.trim().slice(0, 240),
      description: request.description?.trim().slice(0, 2000) || undefined,
      status: "active",
      criteria: (request.criteria ?? []).slice(0, CONVERSATION_GOAL_MAX_CRITERIA)
        .map((criterion) => ({
          id: criterion.id?.trim() || `criterion-${randomUUID()}`,
          text: criterion.text.trim().slice(0, 500),
          status: "pending" as const,
        })).filter((criterion) => criterion.text.length > 0),
      version: 1,
      createdBy: request.createdBy ?? "user",
      createdAt: now,
      updatedAt: now,
    });
    this.publish(goal);
    return { ok: true, goal };
  }

  update(request: ConversationGoalUpdateRequest): ConversationGoalMutationResult {
    const current = this.repo.get(request.goalId);
    if (!current) return { ok: false, code: "not_found", message: "找不到该 Goal" };
    const updates = new Map((request.criterionUpdates ?? []).map((item) => [item.id, item]));
    const status = request.status ?? current.status;
    const now = Date.now();
    const goal = this.repo.update({
      ...current,
      title: request.title?.trim().slice(0, 240) || current.title,
      description: request.description === undefined
        ? current.description
        : request.description.trim().slice(0, 2000) || undefined,
      progressSummary: request.progressSummary === undefined
        ? current.progressSummary
        : request.progressSummary.trim().slice(0, 2000) || undefined,
      status,
      criteria: request.criteria
        ? request.criteria.slice(0, CONVERSATION_GOAL_MAX_CRITERIA).map((criterion) => ({
            id: criterion.id?.trim() || `criterion-${randomUUID()}`,
            text: criterion.text.trim().slice(0, 500),
            status: criterion.status ?? "pending",
            evidence: criterion.evidence?.trim().slice(0, 1000) || undefined,
          })).filter((criterion) => criterion.text.length > 0)
        : current.criteria.map((criterion) => {
        const patch = updates.get(criterion.id);
        if (!patch) return criterion;
        return {
          ...criterion,
          text: patch.text?.trim().slice(0, 500) || criterion.text,
          status: patch.status ?? criterion.status,
          evidence: patch.evidence === undefined ? criterion.evidence : patch.evidence.trim().slice(0, 1000) || undefined,
        };
          }),
      version: current.version + 1,
      updatedAt: now,
      achievedAt: status === "achieved" ? current.achievedAt ?? now : undefined,
    });
    this.publish(goal);
    return { ok: true, goal };
  }

  cancel(goalId: string): ConversationGoalMutationResult { return this.update({ goalId, status: "cancelled" }); }
  getLive(taskId: string): ConversationGoalDto | undefined { return this.repo.getLiveByTask(taskId); }
  listByTask(taskId: string): ConversationGoalDto[] { return this.repo.listByTask(taskId); }

  cloneLive(sourceTaskId: string, childTaskId: string): ConversationGoalDto | undefined {
    const source = this.repo.getLiveByTask(sourceTaskId);
    if (!source) return undefined;
    const result = this.create({
      taskId: childTaskId,
      title: source.title,
      description: source.description,
      criteria: source.criteria.map((criterion) => ({ text: criterion.text })),
      createdBy: source.createdBy,
    });
    if (!result.ok) return undefined;
    const criterionUpdates = result.goal.criteria.map((criterion, index) => ({
      id: criterion.id,
      status: source.criteria[index]?.status,
      evidence: source.criteria[index]?.evidence,
    }));
    const updated = this.update({
      goalId: result.goal.id,
      status: source.status,
      progressSummary: source.progressSummary,
      criterionUpdates,
    });
    return updated.ok ? updated.goal : result.goal;
  }

  private publish(goal?: ConversationGoalDto): void {
    if (goal) this.emit({ type: "conversation_goal_snapshot", taskId: goal.taskId, goal });
  }
}
