import type { WorkResultDecision } from "./WorkResultDecision";
import { WorkTeamWatchCycles } from "./WorkTeamWatchCycles";

import { readTeamPlan } from "./WorkTeamPlanRevision";
import { watchEndedByTime } from "../../../shared/work-watch-expiry";

import type Database from "better-sqlite3";
import { z } from "zod";
import type { BotRegistry } from "./BotRegistry";
import type { WorkService } from "./WorkService";
import type { WorkDto, WorkExecutionBindingDto } from "../../../shared/bot-work";
import { workAdmissionInFlight, workExecutionInFlight } from "../../../shared/work-effect-policy";
import { workTeamPlanSchema, type WorkTeamDto, type WorkTeamExecution, type WorkTeamTemplateDto, type WorkTeamPlan } from "../../../shared/bot-work-team";

const teamRowSchema = z.object({ work_id: z.string(), user_id: z.string(), operation_id: z.string(), request_hash: z.string(),
  plan_json: z.string(), intent_revision: z.number(), input_snapshot_id: z.string(), created_at: z.number() });
const executionRowSchema = z.object({ work_id: z.string(), ordinal: z.number(), bot_id: z.string(), task_id: z.string(),
  role: z.enum(["member", "owner_summary"]), responsibility: z.string(), scopes_json: z.string(),
  input_json: z.string().nullable(), original_input_json: z.string().nullable().optional(),
  error: z.string().nullable(), cancelled: z.number(), reported: z.number(), reported_binding_id: z.string().nullable().optional() });
const recoveryRowSchema = z.object({ recovery_id: z.string(), work_id: z.string(), task_id: z.string(), bot_id: z.string(),
  role: z.enum(["member", "owner_summary"]), intent_revision: z.number(), input_snapshot_id: z.string(), owner_epoch: z.number(),
  source_key: z.string(), source_binding_id: z.string().nullable(), generation: z.number(), operation_id: z.string(),
  state: z.enum(["pending", "claimed", "dispatched", "completed", "stopped"]), failure_class: z.string(),
  failure_message: z.string(), missing_json: z.string().nullable().optional(), progress_hash: z.string().nullable(), outcome: z.string().nullable(),
  attempt_count: z.number(), binding_id: z.string().nullable(), claimed_at: z.number().nullable(),
  dispatched_at: z.number().nullable(), settled_at: z.number().nullable(), created_at: z.number() });
type TeamRow = z.infer<typeof teamRowSchema>;
type ExecutionRow = z.infer<typeof executionRowSchema>;
type RecoveryRow = z.infer<typeof recoveryRowSchema>;
const TERMINAL_BINDING = new Set(["completed", "failed", "stopped", "invalidated"]);
/** Storage schema retained for historical team records. */
export function ensureWorkTeamSchema(db: Database.Database): void {
  if (db.readonly) return;
  db.exec(`CREATE TABLE IF NOT EXISTS work_teams (
    work_id TEXT PRIMARY KEY REFERENCES works(work_id), user_id TEXT NOT NULL,
    operation_id TEXT NOT NULL, request_hash TEXT NOT NULL, plan_json TEXT NOT NULL,
    intent_revision INTEGER NOT NULL, input_snapshot_id TEXT NOT NULL, created_at INTEGER NOT NULL,
    UNIQUE(user_id,operation_id));
    CREATE TABLE IF NOT EXISTS work_team_ownership (
      work_id TEXT PRIMARY KEY REFERENCES work_teams(work_id), team_id TEXT NOT NULL, team_name TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS work_team_record_visibility (
      work_id TEXT PRIMARY KEY REFERENCES work_teams(work_id), removed_at INTEGER);
    CREATE INDEX IF NOT EXISTS idx_work_team_ownership_team ON work_team_ownership(team_id);
    CREATE TABLE IF NOT EXISTS work_team_executions (
      work_id TEXT NOT NULL REFERENCES work_teams(work_id), ordinal INTEGER NOT NULL,
      bot_id TEXT NOT NULL, task_id TEXT NOT NULL UNIQUE, role TEXT NOT NULL,
      responsibility TEXT NOT NULL, scopes_json TEXT NOT NULL, input_json TEXT,
      error TEXT, cancelled INTEGER NOT NULL DEFAULT 0, reported INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY(work_id,ordinal));
    CREATE TABLE IF NOT EXISTS work_team_workspaces (
      work_id TEXT PRIMARY KEY, canonical_path TEXT NOT NULL, entity TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS work_team_execution_history (
      task_id TEXT PRIMARY KEY, work_id TEXT NOT NULL, input_json TEXT, execution_json TEXT NOT NULL, archived_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS work_team_templates (
      template_id TEXT PRIMARY KEY, user_id TEXT NOT NULL, operation_id TEXT NOT NULL,
      request_hash TEXT NOT NULL, name TEXT NOT NULL, plan_json TEXT NOT NULL, created_at INTEGER NOT NULL,
      deleted_at INTEGER, UNIQUE(user_id,operation_id));
    CREATE UNIQUE INDEX IF NOT EXISTS idx_work_team_template_name ON work_team_templates(user_id,name) WHERE deleted_at IS NULL;
    CREATE TABLE IF NOT EXISTS work_team_recovery_attempts (
      recovery_id TEXT PRIMARY KEY,
      work_id TEXT NOT NULL,
      task_id TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      role TEXT NOT NULL,
      intent_revision INTEGER NOT NULL,
      input_snapshot_id TEXT NOT NULL,
      owner_epoch INTEGER NOT NULL,
      source_key TEXT NOT NULL,
      source_binding_id TEXT,
      generation INTEGER NOT NULL,
      operation_id TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL CHECK (state IN ('pending','claimed','dispatched','completed','stopped')),
      failure_class TEXT NOT NULL,
      failure_message TEXT NOT NULL,
      progress_hash TEXT,
      outcome TEXT,
      attempt_count INTEGER NOT NULL DEFAULT 0,
      binding_id TEXT,
      claimed_at INTEGER,
      dispatched_at INTEGER,
      settled_at INTEGER,
      created_at INTEGER NOT NULL,
      UNIQUE(work_id,task_id,source_key),
      UNIQUE(work_id,task_id,generation));
    CREATE INDEX IF NOT EXISTS idx_work_team_recovery_state
      ON work_team_recovery_attempts(work_id,state,created_at);`);
  const columns = (table: string): Set<string> => new Set(
    (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(row => row.name));
  const add = (table: string, name: string, ddl: string): void => {
    if (!columns(table).size || columns(table).has(name)) return;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  };
  add("work_team_record_visibility", "removal_requested_at", "removal_requested_at INTEGER");
  add("work_team_executions", "reported_binding_id", "reported_binding_id TEXT");
  add("work_team_executions", "original_input_json", "original_input_json TEXT");
  add("work_team_recovery_attempts", "missing_json", "missing_json TEXT");
}

/** A bounded, explicit user-created team. It does not create a second execution engine. */
/** Historical projections and checks used by the shared Work/Goal authority. */
export class WorkTeamService {
  private readonly watchCycles: WorkTeamWatchCycles;
  constructor(private readonly db: Database.Database, private readonly works: WorkService,
    private readonly bots: BotRegistry) { ensureWorkTeamSchema(db); this.watchCycles = new WorkTeamWatchCycles(db, works); }

  /** Saved plans are user-owned. The foreground can reuse its own plans, never invent an actor or grant. */
  foregroundTemplates(userId: string, botId: string): WorkTeamTemplateDto[] {
    const bot = this.bots.getBot(botId);
    if (!bot || bot.userId !== userId || bot.status !== "active") return [];
    return this.templates(userId).filter(template => template.ownerBotId === botId);
  }

  /** Discover existing peers for this owner's current workspace; never expose private memory. */
  foregroundCandidates(userId: string, ownerBotId: string, _workspacePath: string) {
    const owner = this.bots.getBot(ownerBotId);
    if (!owner || owner.userId !== userId || owner.status !== "active") return [];
    return this.bots.listBots(userId).filter(bot => bot.botId !== ownerBotId && bot.status === "active")
      .map(bot => ({ botId: bot.botId, displayName: bot.displayName, responsibilitySummary: bot.responsibilitySummary,
        allowedScopes: ["workspace:read", "workspace:write"] as Array<"workspace:read" | "workspace:write"> }));
  }

  get(workId: string): WorkTeamDto | undefined {
    const row = this.row(workId), work = this.works.getWork(workId);
    if (!row || !work) return undefined;
    const { plan, revision } = readTeamPlan(row.plan_json);
    const executions: WorkTeamExecution[] = this.rows(workId).map(item => {
      const binding = this.works.repo.bindingForTask(item.task_id);
      const recovery = this.latestRecovery(workId, item.task_id);
      const deliverable = this.taskDeliverables(workId, item.task_id).at(-1);
      const notStartedReason = this.notStartedReason(work, plan, item, this.rows(workId));
      const recovered = recovery?.state === "completed";
      const recovering = recovery && ["pending", "claimed", "dispatched"].includes(recovery.state);
      const stopped = recovery?.state === "stopped";
      const stopMessage = stopped ? `${recovery.outcome === "no_progress" ? "自动恢复已停止：连续没有新进展"
        : recovery.outcome === "recovery_limit" ? "自动恢复已停止：已达恢复上限"
          : recovery.outcome === "authorization_lost" ? "自动恢复已停止：执行成员已停用或不再属于该事项"
            : "自动恢复已停止"}（${recovery.failure_message}）` : undefined;
      return { botId: item.bot_id, responsibility: item.responsibility, delegatedScope: JSON.parse(item.scopes_json), role: item.role,
        dependsOnBotIds: plan.members.find(member => member.botId === item.bot_id)?.dependsOnBotIds,
        notStartedReason,
        waitingReason: notStartedReason ?? (!binding && !item.error && !item.cancelled ? this.waitingReason(work, plan, item, this.rows(workId)) : undefined),
        taskId: item.task_id, bindingId: binding?.bindingId,
        status: recovering ? "recovering" : recovered ? "recovered"
          : binding?.status ?? (item.cancelled ? "cancelled" : item.error || notStartedReason ? "blocked" : "queued"),
        error: stopMessage ?? item.error ?? undefined,
        resultSummary: deliverable?.summary,
        recoveryState: recovery?.state, recoveryGeneration: recovery?.generation,
        recoveryAttempts: recovery ? this.recoveryRows(workId, item.task_id).length : undefined,
        recoveryOutcome: recovery?.outcome ?? undefined,
        failureReason: recovered || stopped ? recovery.failure_message : undefined };
    });
    const superseded = row.intent_revision !== work.intentRevision || row.input_snapshot_id !== work.inputSnapshotId;
    const state = watchEndedByTime(work) ? "expired" : work.lifecycle === "closed" && work.closureConclusion === "succeeded" ? "completed"
      : work.lifecycle === "closed" && work.closureConclusion === "ended_unsuccessfully" ? "ended_unsuccessfully"
        : work.lifecycle === "closed" ? "cancelled" : work.lifecycle === "closing" ? "closing" : work.lifecycle === "paused" ? "paused"
          : superseded ? "superseded"

      : executions.some(item => item.error || ["blocked", "unknown", "failed", "stopped", "invalidated"].includes(item.status))
        || executions.at(-1)?.status === "blocked" ? "blocked"
        : work.mode === "watch" && !this.watchCycles.pending(workId) ? "watching"
        : executions.at(-1)?.status === "completed" || executions.at(-1)?.status === "recovered" ? "awaiting_review"
          : executions.some(item => item.status !== "queued") ? "running" : "queued";
    const ownership = this.db.prepare("SELECT team_id,team_name FROM work_team_ownership WHERE work_id=?").get(workId) as { team_id: string; team_name: string } | undefined;
    const visibility = this.db.prepare("SELECT removed_at,removal_requested_at FROM work_team_record_visibility WHERE work_id=?").get(workId) as { removed_at: number | null; removal_requested_at: number | null } | undefined;
    return { ...plan, planRevision: revision, ...(visibility?.removed_at ? { removedAt: visibility.removed_at } : {}), ...(visibility?.removal_requested_at ? { removalRequestedAt: visibility.removal_requested_at } : {}), ...(ownership ? { teamId: ownership.team_id, teamName: ownership.team_name } : {}), ownerBotId: work.ownerBotId, workId, intentRevision: row.intent_revision, inputSnapshotId: row.input_snapshot_id,
      ownerEpoch: work.ownerEpoch, state, watchRound: work.mode === "watch" ? this.watchCycles.current(workId)?.sequence : undefined, executions, createdAt: row.created_at };
  }

  /** Host-owned provenance scoped to this exact team and input revision. */
  continuationTargets(owner: WorkExecutionBindingDto) {
    const work = this.works.getWork(owner.workId), team = this.row(owner.workId);
    if (!work || !team) return undefined;
    const rows = this.rows(owner.workId);
    const summary = rows.find(row => row.role === "owner_summary" && row.task_id === owner.taskId);
    if (!summary || work.mode !== "once" && work.watchRule?.executionMode !== "continuous" || owner.botId !== work.ownerBotId
      || this.works.repo.bindingForTask(owner.taskId)?.bindingId !== owner.bindingId
      || !this.works.collaboration.isDelegationAdopted(owner, work)) return [];
    return rows.filter(row => row.role === "member" && !row.cancelled).flatMap(row => {
      const binding = this.works.repo.bindingForTask(row.task_id);
      if (!binding || binding.status !== "completed" || binding.invalidatedAt
        || !this.works.collaboration.isDelegationAdopted(binding, work)) return [];
      const results = this.works.repo.listDeliverables(work.workId).filter(result => result.executionId === binding.bindingId
        && result.producerBotId === row.bot_id && result.status !== "superseded" && result.status !== "rejected")
        .map(result => ({ deliverableId: result.deliverableId, summary: result.summary,
          uncoveredScope: result.uncoveredScope, artifactRefs: result.artifactRefs }));
      return [{ sourceBindingId: binding.bindingId, botId: row.bot_id, responsibility: row.responsibility,
        intentRevision: binding.intentRevision, inputSnapshotId: binding.inputSnapshotId,
        delegatedScope: binding.delegatedScope, results }];
    });
  }

  private latestRecovery(workId: string, taskId: string): RecoveryRow | undefined {
    const row = this.db.prepare("SELECT * FROM work_team_recovery_attempts WHERE work_id=? AND task_id=? ORDER BY generation DESC, created_at DESC LIMIT 1")
      .get(workId, taskId);
    return row ? recoveryRowSchema.parse(row) : undefined;
  }
  private recoveryRows(workId: string, taskId: string): RecoveryRow[] {
    return this.db.prepare("SELECT * FROM work_team_recovery_attempts WHERE work_id=? AND task_id=? ORDER BY generation,created_at")
      .all(workId, taskId).map(row => recoveryRowSchema.parse(row));
  }
  private recoveryForOperation(operationId: string): RecoveryRow | undefined {
    const row = this.db.prepare("SELECT * FROM work_team_recovery_attempts WHERE operation_id=?").get(operationId);
    return row ? recoveryRowSchema.parse(row) : undefined;
  }

  private taskBindings(workId: string, taskId: string): WorkExecutionBindingDto[] {
    return this.works.repo.listBindings(workId).filter(binding => binding.taskId === taskId).sort((a, b) => a.admittedAt - b.admittedAt);
  }
  private taskDeliverables(workId: string, taskId: string) {
    const bindingIds = new Set(this.taskBindings(workId, taskId).map(binding => binding.bindingId));
    return this.works.repo.listDeliverables(workId).filter(item => bindingIds.has(item.executionId));
  }
  private bindingReported(row: ExecutionRow, binding: WorkExecutionBindingDto): boolean {
    if (row.reported_binding_id) return row.reported_binding_id === binding.bindingId;
    // Pre-recovery rows only have the boolean marker. Treat it as the first
    // binding so a newly created continuation can still report its own result.
    const first = this.taskBindings(binding.workId, row.task_id)[0];
    return row.reported === 1 && first?.bindingId === binding.bindingId;
  }

  private recoverySourceSettled(recovery: RecoveryRow): boolean {
    const source = recovery.source_binding_id ? this.works.repo.getBinding(recovery.source_binding_id) : undefined;
    if (!source || source.workId !== recovery.work_id || source.taskId !== recovery.task_id
      || !TERMINAL_BINDING.has(source.status)
      || (source.invalidatedAt || source.status === "invalidated") && (source.attemptId || source.submissionReceipt || source.submittedAt)) return false;
    // A persisted pre-upgrade claim is not proof that its native source stopped.
    // Exclude only this exact recovery's own binding so a lost dispatch response
    // can still adopt it idempotently without creating another execution.
    const others = this.taskBindings(recovery.work_id, recovery.task_id)
      .filter(binding => binding.operationId !== recovery.operation_id);
    if (others.some(binding => workExecutionInFlight(binding.status)
      || binding.status === "invalidated" && !!(binding.attemptId || binding.submissionReceipt || binding.submittedAt))) return false;
    const ids = new Set(others.map(binding => binding.bindingId));
    return !this.works.repo.listAdmissions(recovery.work_id)
      .some(admission => admission.bindingId && ids.has(admission.bindingId) && workAdmissionInFlight(admission));
  }

  private memberInFlight(workId: string, taskId: string): boolean {
    const bindings = this.taskBindings(workId, taskId);
    if (bindings.some(item => workExecutionInFlight(item.status)
      || item.status === "invalidated" && !!(item.attemptId || item.submissionReceipt || item.submittedAt))) return true;
    const ids = new Set(bindings.map(item => item.bindingId));
    return this.works.repo.listAdmissions(workId).some(item => item.bindingId && ids.has(item.bindingId) && workAdmissionInFlight(item));
  }

  /** Derived terminal dependency facts, never a synthetic execution or success.
   * Preparation errors remain retryable; running/unknown sources must still settle. */
  private notStartedReason(work: WorkDto, plan: WorkTeamPlan, row: ExecutionRow, rows: ExecutionRow[],
    memo = new Map<string, string | undefined>()): string | undefined {
    if (memo.has(row.task_id)) return memo.get(row.task_id);
    memo.set(row.task_id, undefined);
    if (row.role !== "member" || row.cancelled || this.works.repo.bindingForTask(row.task_id)) return undefined;
    const predecessors = plan.executionPolicy !== "parallel" ? rows.filter(item => item.ordinal < row.ordinal)
      : rows.filter(item => (plan.members.find(member => member.botId === row.bot_id)?.dependsOnBotIds ?? []).includes(item.bot_id));
    for (const previous of predecessors) {
      if (previous.cancelled) continue;
      const inherited = this.notStartedReason(work, plan, previous, rows, memo);
      if (inherited) {
        const reason = `未启动：前置成员 ${previous.bot_id} 无法继续（${inherited}）`;
        memo.set(row.task_id, reason); return reason;
      }
      const recovery = this.latestRecovery(work.workId, previous.task_id);
      const binding = this.works.repo.bindingForTask(previous.task_id);
      if (recovery?.state !== "stopped" || recovery.outcome === "superseded" || !binding
        || !TERMINAL_BINDING.has(binding.status) || !this.bindingReported(previous, binding)
        || !this.works.collaboration.isDelegationAdopted(binding, work)) continue;
      if (this.memberInFlight(work.workId, previous.task_id)) continue;
      const reason = `未启动：前置成员 ${previous.bot_id} 自动恢复已停止（${recovery.failure_message}）`;
      memo.set(row.task_id, reason); return reason;
    }
    return undefined;
  }

  /** Dependencies freeze a result boundary, not an assumption that a predecessor succeeded. */
  private waitingReason(work: WorkDto, plan: WorkTeamPlan, row: ExecutionRow, rows: ExecutionRow[]): string | undefined {
    if (work.lifecycle !== "active") return "事项未处于执行状态";
    const replacing = this.replacementWaitingReason(work.workId, row.task_id);
    if (replacing) return replacing;
    const predecessors = row.role === "owner_summary" || plan.executionPolicy !== "parallel"
      ? rows.filter(item => item.ordinal < row.ordinal)
      : rows.filter(item => (plan.members.find(member => member.botId === row.bot_id)?.dependsOnBotIds ?? []).includes(item.bot_id));
    for (const previous of predecessors) {
      if (previous.cancelled) continue;
      const binding = this.works.repo.bindingForTask(previous.task_id);
      const recovery = this.latestRecovery(work.workId, previous.task_id);
      if (!binding) {
        if (row.role === "owner_summary" && this.notStartedReason(work, plan, previous, rows)) continue;
        return `等待成员 ${previous.bot_id} 的执行结果`;
      }
      if (!TERMINAL_BINDING.has(binding.status)) return `等待成员 ${previous.bot_id} 的执行结果`;
      if (recovery && ["pending", "claimed", "dispatched"].includes(recovery.state)) return `等待成员 ${previous.bot_id} 自动恢复（第 ${recovery.generation} 次）`;
      if (row.role === "owner_summary") {
        if (this.memberInFlight(work.workId, previous.task_id)) return `等待成员 ${previous.bot_id} 的结果与效果结算`;
        if (!this.bindingReported(previous, binding)) return `等待成员 ${previous.bot_id} 的结果与效果结算`;
        continue;
      }
      if (recovery?.state === "stopped") return `成员 ${previous.bot_id} 自动恢复已停止：${recovery.failure_message}`;
      if (binding.status !== "completed" && recovery?.state !== "completed") return `等待成员 ${previous.bot_id} 的有效结果`;
      if (!this.bindingReported(previous, binding)) return `等待成员 ${previous.bot_id} 的结果与效果结算`;
    }
    if (plan.executionPolicy === "parallel") {
      const active = rows.filter(item => {
        const binding = this.works.repo.bindingForTask(item.task_id);
        return binding && !TERMINAL_BINDING.has(binding.status);
      }).length;
      if (active >= (plan.maxConcurrency ?? 2)) return "等待团队并行执行名额";
    }
    return undefined;
  }

  private replacementWaitingReason(workId: string, taskId: string): string | undefined {
    const team = this.row(workId);
    const priorTaskIds = team ? readTeamPlan(team.plan_json).predecessors.find(item => item.taskId === taskId)?.priorTaskIds ?? [] : [];
    for (const priorId of priorTaskIds) {
      const binding = this.works.repo.bindingForTask(priorId);
      if (binding && (workExecutionInFlight(binding.status)
        || binding.status === "invalidated" && Boolean(binding.attemptId || binding.submissionReceipt || binding.submittedAt)
        || this.works.repo.listAdmissions(workId).some(item => item.bindingId === binding.bindingId && workAdmissionInFlight(item))))
        return "正在结算本分工被替换的执行；独立分工继续推进";
    }
    return undefined;
  }

  /** A durable team recovery may continue the same task after its prior attempt is
   * failed/stopped. Native uncertainty is not confirmation that execution ended. */
  allowsRecoveryBinding(workId: string, taskId: string, operationId: string, occupied: WorkExecutionBindingDto): boolean {
    const recovery = this.recoveryForOperation(operationId);
    return Boolean(recovery && recovery.work_id === workId && recovery.task_id === taskId
      && ["pending", "claimed"].includes(recovery.state) && occupied.workId === workId
      && occupied.taskId === taskId && this.recoverySourceSettled(recovery)
      && (occupied.operationId === operationId || ["failed", "stopped", "invalidated"].includes(occupied.status)
        || occupied.status === "completed" && ["semantic_missing", "member_repaired_summary"].includes(recovery.failure_class)));
  }

  /** Semantic execution boundary from the persisted team plan, not retired grant scopes. */
  isReadOnlyBinding(binding: WorkExecutionBindingDto): boolean {
    const row = this.rows(binding.workId).find(item => item.task_id === binding.taskId && item.bot_id === binding.botId);
    if (!row) return false;
    if (row.role === "owner_summary") return true;
    const recovery = this.recoveryForOperation(binding.operationId);
    if (!recovery || recovery.work_id !== binding.workId || recovery.task_id !== binding.taskId
      || recovery.bot_id !== binding.botId || recovery.failure_class !== "semantic_missing" || !recovery.missing_json) return false;
    const items = JSON.parse(recovery.missing_json) as WorkResultDecision["missing"];
    return items.length > 0 && items.every(item => item.readOnly === true);
  }

  dispatchError(workId: string, taskId: string, botId: string, _scopes: string[] | undefined, operationId?: string): string | undefined {
    if (!this.row(workId)) return undefined;
    // A foreground result review may persist an exact missing-part plan for the
    // team owner. It is not an arbitrary additional team member or a root replay.
    const work = this.works.getWork(workId);
    const request = this.db.prepare("SELECT continuation_plan_id,operation_id FROM work_dispatch_requests WHERE work_id=? AND task_id=? AND bot_id=?")
      .get(workId, taskId, botId) as {continuation_plan_id:string|null;operation_id:string}|undefined;
    const plan = request?.continuation_plan_id && this.works.partialResults.plans(workId).find(item => item.planId === request.continuation_plan_id);
    const source = plan && this.works.repo.getBinding(plan.sourceBindingId);
    if (work && plan && source && botId === work.ownerBotId && plan.ownerBotId === botId
      && plan.ownerEpoch === work.ownerEpoch && plan.intentRevision === work.intentRevision
      && plan.inputSnapshotId === work.inputSnapshotId && ["pending","dispatched"].includes(plan.state)
      && operationId === `dispatch:${request!.operation_id}`
      && this.works.collaboration.isDelegationAdopted(source,work)
      && ["completed","failed","stopped"].includes(source.status)) return undefined;
    const row = this.rows(workId).find(item => item.task_id === taskId);
    if (!row || row.bot_id !== botId || row.cancelled) return "团队执行必须使用持久分工与原任务身份，不能追加未登记执行";
    const replacing = this.replacementWaitingReason(workId, taskId);
    if (replacing) return replacing;
    const recovery = operationId ? this.recoveryForOperation(operationId) : undefined;
    if (recovery) {
      if (recovery.task_id !== taskId || recovery.bot_id !== botId || !["pending", "claimed"].includes(recovery.state))
        return "自动恢复必须使用原成员身份与当前代次";
      if (recovery.work_id !== workId || !this.recoverySourceSettled(recovery))
        return "原生执行尚未确认结束或仍有在途操作，不能启动恢复";
      const source = recovery.source_binding_id && this.works.repo.getBinding(recovery.source_binding_id);
      const scopes = [..._scopes ?? []].sort();
      const readOnlyMissing = recovery.failure_class === "semantic_missing" && recovery.missing_json
        && (JSON.parse(recovery.missing_json) as WorkResultDecision["missing"]).length > 0
        && (JSON.parse(recovery.missing_json) as WorkResultDecision["missing"]).every(item => item.readOnly === true);
      if (readOnlyMissing && JSON.stringify(scopes) === JSON.stringify(["workspace:read"])
        && source && source.delegatedScope.includes("workspace:read")
        && JSON.parse(row.scopes_json).includes("workspace:read")) return undefined;
      if (JSON.stringify(scopes) !== JSON.stringify([...JSON.parse(row.scopes_json)].sort())
        || source && JSON.stringify(scopes) !== JSON.stringify([...source.delegatedScope].sort()))
        return "团队补做必须保持原成员的授权范围";
      return undefined;
    }
    if (!row.input_json || row.error) return "团队执行必须使用持久分工与原任务身份，不能追加未登记执行";
    return undefined;
  }

  private templates(userId: string, includeDeleted = false): WorkTeamTemplateDto[] {
    return this.db.prepare("SELECT * FROM work_team_templates WHERE user_id=? " + (includeDeleted ? "" : "AND deleted_at IS NULL ") + "ORDER BY created_at,template_id").all(userId).map(raw => {
      const row = z.object({ template_id: z.string(), name: z.string(), plan_json: z.string(), created_at: z.number(), deleted_at: z.number().nullable() }).parse(raw);
      return { ...workTeamPlanSchema.parse(JSON.parse(row.plan_json)), templateId: row.template_id, name: row.name, createdAt: row.created_at, ...(row.deleted_at !== null ? { deletedAt: row.deleted_at } : {}) };
    });
  }
  private row(workId: string): TeamRow | undefined { return teamRowSchema.optional().parse(this.db.prepare("SELECT * FROM work_teams WHERE work_id=?").get(workId)); }
  private rows(workId: string): ExecutionRow[] {
    return this.db.prepare("SELECT * FROM work_team_executions WHERE work_id=? ORDER BY ordinal").all(workId).map(raw => {
      const row = executionRowSchema.parse(raw);
      return row.error && this.works.repo.canIgnoreRetiredTeamQuotaFailure(workId, row.task_id, row.error)
        ? { ...row, error: null } : row;
    });
  }
}
