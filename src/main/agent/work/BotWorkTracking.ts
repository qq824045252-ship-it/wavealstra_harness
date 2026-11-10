import type Database from "better-sqlite3";
import type { BotWorkSummary } from "./BotWorkQuery";

export interface BotWorkTracking {
  state: "closed" | "paused" | "closing" | "running" | "queued" | "waiting_input" | "blocked" | "scheduled" | "waiting_event" | "failed" | "unverified" | "result_ready" | "not_running";
  nextStep: string;
  reason: string | null;
  execution: { running: number; queued: number; completed: number; failed: number; unknown: number; stopped: number };
  /** A DB observation, not proof that a worker is alive or a promise of monitoring while the app is offline. */
  observedAt: number;
}

/** Read facts for the bounded catalogue page only; never hydrate every Work. */
export function workTrackingReader(db: Database.Database) {
  const executions = db.prepare(`SELECT
    coalesce(sum(e.status='running'),0) running,
    coalesce(sum(e.status IN ('pending','submitted')),0) queued,
    coalesce(sum(e.status='completed'),0) completed,
    coalesce(sum(e.status='failed'),0) failed,
    coalesce(sum(e.status='unknown'),0) unknown,
    coalesce(sum(e.status='stopped'),0) stopped,
    max(CASE WHEN e.status IN ('failed','unknown') THEN substr(e.settlement_note,1,300) END) reason
    FROM work_execution_bindings e WHERE e.work_id=@workId AND e.intent_revision=@intentRevision
      AND e.input_snapshot_id=(SELECT input_snapshot_id FROM works WHERE work_id=@workId)
      AND e.owner_epoch=@ownerEpoch AND e.status!='invalidated'
      AND NOT EXISTS(SELECT 1 FROM work_execution_bindings newer WHERE newer.work_id=e.work_id
        AND newer.task_id=e.task_id AND newer.intent_revision=e.intent_revision
        AND newer.input_snapshot_id=e.input_snapshot_id AND newer.owner_epoch=e.owner_epoch
        AND (newer.admitted_at>e.admitted_at OR (newer.admitted_at=e.admitted_at AND newer.rowid>e.rowid)))`);
  const blocker = db.prepare(`SELECT substr(reason,1,300) reason FROM work_blockers
    WHERE work_id=? AND status='open' ORDER BY waiting_for_user_input DESC,created_at DESC,blocker_id DESC LIMIT 1`);
  return (item: Omit<BotWorkSummary, "tracking">, observedAt: number): BotWorkTracking => {
    const params = { workId: item.workId, intentRevision: item.versionGuard.expectedIntentRevision,
      ownerEpoch: item.versionGuard.expectedOwnerEpoch };
    const { reason: executionReason, ...execution } = executions.get(params) as BotWorkTracking["execution"] & { reason: string | null };
    const reason = (blocker.get(item.workId) as { reason: string } | undefined)?.reason
      ?? executionReason ?? null;
    const result = (state: BotWorkTracking["state"], nextStep: string): BotWorkTracking => ({ state, nextStep, reason, execution, observedAt });
    if (item.lifecycle === "closed") return result("closed", "已结束；可查看结论与成果");
    if (item.lifecycle === "paused") return result("paused", "已暂停；恢复后才能继续派发，已有执行状态见 execution");
    if (item.lifecycle === "closing") return result("closing", "正在收尾；核对剩余执行与关闭结论");
    if (execution.running) return result("running", "有执行记录处于运行中；等待返回结果，不能仅据 active 判断仍在执行");
    if (item.needsUserInput) return result("waiting_input", "等待回复所列问题；其他成员是否仍执行以 execution 为准");
    if (item.openBlockerCount) return result("blocked", "查看所列受阻原因及详情；未核实恢复前不要承诺已继续");
    if (execution.unknown) return result("unverified", "执行结果尚未核实；查看执行详情，不把未知当成功或自动重做");
    if (execution.queued) return result("queued", "已排队或已提交，尚无运行确认；不要称作正在执行");
    if (item.nextWakeAt !== null && item.activeSubscriptionCount) return result("scheduled", item.nextWakeAt <= observedAt
      ? "已到计划检查时间，但尚无排队或运行确认；核对调度状态，不要声称检查已完成"
      : "按 nextWakeAt 等待下一次检查；应用需运行，到时是否执行仍需核实");
    if (item.activeSubscriptionCount) return result("waiting_event", "等待已登记来源事件；没有已确定的下次检查时间");
    if (execution.failed) return result("failed", "执行失败且当前没有排队的后续执行；查看原因，不能承诺正在重试");
    if (item.latestDeliverableStatus || execution.completed) return result("result_ready", "执行已有结果但事项未结束；查看成果及仍未满足的要求");
    return result("not_running", "当前无运行、排队或有效跟踪安排；查看详情确定下一步，不能声称持续执行");
  };
}
