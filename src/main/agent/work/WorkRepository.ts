import { botAttachmentSchema } from "../../../shared/bot-conversation";
import { nonBlockingEffect, workAdmissionInFlight } from "../../../shared/work-effect-policy";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  WorkAdmissionDto,
  WorkBlockerDto,
  WorkDeliverableDto,
  WorkDto,
  WorkEvidenceDto,
  WorkExecutionBindingDto,
  WorkGoalSourceDto,
  WorkInboxEventDto,
  WorkIntentSnapshotDto,
  WorkNotificationDelivery,
  WorkNotificationDto,
  WorkOutboxInstructionDto,
  WorkParticipantDto,
  WorkSubscriptionDto,
  WorkWatchRuleDto,
} from "../../../shared/bot-work";
import type { ExpertConfigSnapshotDto, WorkAuthorizationDto } from "../../../shared/bot-work";
import { captureTeamReportContext, capturedTeamReportContext } from "./WorkReportPresentation";
import { botDelegationInput, BOT_DELEGATION_INSTRUCTIONS } from "./BotDelegationInput";

function json<T>(value: string | null | undefined, fallback: T): T {
  if (!value) return fallback;
  try { return JSON.parse(value) as T; } catch { return fallback; }
}
function jsonText(value: unknown): string {
  return JSON.stringify(value ?? null);
}

interface WorkRow {
  work_id: string;
  user_id: string;
  project_id: string | null;
  workspace_path: string | null;
  source_message_id: string | null;
  legacy_task_id: string | null;
  owner_bot_id: string;
  owner_epoch: number;
  intent_revision: number;
  source_version: number;
  title: string;
  goal_description: string | null;
  constraints_json: string;
  criteria_json: string;
  authorization_json: string;
  active_intent_snapshot_id: string;
  input_snapshot_id: string;
  goal_sources_json: string;
  mode: WorkDto["mode"];
  lifecycle: WorkDto["lifecycle"];
  pending_conclusion: WorkDto["pendingConclusion"] | null;
  cancel_requested_at: number | null;
  closure_conclusion: WorkDto["closureConclusion"] | null;
  closure_summary: string | null;
  accepted_deliverable_ids_json: string;
  active_execution_ids_json: string;
  progress_summary: string | null;
  watch_rule_json: string | null;
  deadline_at: number | null;
  deadline_revision: number;
  deadline_set_at: number | null;
  causal_policy_json: string;
  state_version: number;
  created_by: "user" | "bot";
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  close_operation_id: string | null;
}

export interface ReceiptRow {
  user_id: string;
  operation_id: string;
  work_id: string | null;
  operation_type: string;
  payload_hash: string;
  result_snapshot_json: string;
  outbox_event_id: string | null;
  created_at: number;
}

export interface BindingRow {
  binding_id: string;
  work_id: string;
  operation_id: string;
  bot_id: string;
  task_id: string;
  durable_store_key: string;
  conversation_id: string;
  intent_revision: number;
  owner_epoch: number;
  input_snapshot_id: string;
  expert_snapshot_json: string;
  delegated_scope_json: string;
  workspace_binding: string;
  status: WorkExecutionBindingDto["status"];
  attempt_id: string | null;
  submission_receipt: string | null;
  settlement_note: string | null;
  admitted_at: number;
  submitted_at: number | null;
  invalidated_at: number | null;
  settled_at: number | null;
  inbox_event_id: string | null;
}

interface DeliverableRow {
  deliverable_id: string;
  work_id: string;
  producer_bot_id: string;
  execution_id: string;
  intent_revision: number;
  owner_epoch: number;
  input_snapshot_id: string;
  status: WorkDeliverableDto["status"];
  summary: string;
  artifact_refs_json: string;
  evidence_refs_json: string;
  uncovered_scope_json: string;
  uncovered_criterion_ids_json: string;
  is_speculation: number;
  has_write_conflicts: number;
  rejected_reason: string | null;
  created_at: number;
  reviewed_at: number | null;
  reviewed_by_bot_id: string | null;
}

interface EvidenceRow {
  evidence_id: string;
  work_id: string;
  deliverable_id: string | null;
  execution_id: string | null;
  criterion_ids_json: string;
  kind: WorkEvidenceDto["kind"];
  provenance: WorkEvidenceDto["provenance"];
  source_ref: string;
  source_sha: string | null;
  input_snapshot_id: string;
  environment: string | null;
  intent_revision: number;
  detail: string | null;
  recorded_at: number;
}

interface BlockerRow {
  blocker_id: string;
  work_id: string;
  reported_by_bot_id: string | null;
  reason: string;
  kind: WorkBlockerDto["kind"];
  reason_code: string | null;
  details_json: string;
  source_ref: string | null;
  subscription_id: string | null;
  causal_chain_id: string | null;
  unknown_external_effect_ref: string | null;
  waiting_for_user_input: number;
  status: WorkBlockerDto["status"];
  created_at: number;
  cleared_at: number | null;
}

interface AdmissionRow {
  admission_id: string;
  work_id: string;
  binding_id: string | null;
  operation_id: string;
  action_kind: string;
  state: WorkAdmissionDto["state"];
  intent_revision: number;
  owner_epoch: number;
  admitted_at: number;
  settled_at: number | null;
}

interface SubscriptionRow {
  subscription_id: string;
  work_id: string;
  source: string;
  filter_json: string;
  catch_up_policy: WorkSubscriptionDto["catchUpPolicy"];
  max_merge_wait_ms: number;
  max_queue_depth: number;
  stop_condition_text: string | null;
  timezone: string | null;
  cron_expression: string | null;
  next_wake_at: number | null;
  last_processed_source_version: string | null;
  schedule_revision: number;
  config_revision: number;
  source_target: string | null;
  version_mode: string;
  dst_policy: string;
  max_backlog_events: number;
  max_backlog_bytes: number;
  last_checked_at: number | null;
  stopped_reason: string | null;
  config_json: string;
  created_at: number;
  updated_at: number;
  stopped_at: number | null;
}

interface InboxRow {
  event_id: string;
  dedupe_key: string;
  source: string;
  source_event_id: string;
  event_type: string;
  work_id: string;
  subscription_id: string | null;
  intent_revision: number;
  state_version: number;
  owner_epoch: number;
  source_version: string | null;
  causal_event_id: string | null;
  payload_json: string;
  status: WorkInboxEventDto["status"];
  merged_count: number;
  merge_deadline_at: number | null;
  batch_id: string | null;
  batch_deadline_at: number | null;
  frozen_at: number | null;
  frozen_payload_json: string | null;
  claim_version: number;
  target_key: string | null;
  process_reason: string | null;
  received_at: number;
  processed_at: number | null;
}

interface OutboxRow {
  event_id: string;
  dedupe_key: string;
  event_type: string;
  work_id: string;
  binding_id: string | null;
  intent_revision: number;
  state_version: number;
  owner_epoch: number;
  request_id: string;
  causal_event_id: string | null;
  payload_json: string;
  delivery_status: WorkOutboxInstructionDto["deliveryStatus"];
  attempt_id: string | null;
  attempt_count: number;
  created_at: number;
  delivered_at: number | null;
}

interface NotificationRow {
  notification_id: string;
  work_id: string;
  semantic_key: string;
  kind: WorkNotificationDto["kind"];
  title: string;
  body: string | null;
  state_version: number;
  intent_revision: number;
  delivery: WorkNotificationDelivery;
  channel: string | null;
  idempotency_key: string | null;
  attempt_count: number;
  external_receipt: string | null;
  read_at: number | null;
  created_at: number;
  sent_at: number | null;
  card_key: string | null;
  effect_key: string | null;
  target_key: string | null;
}

export class WorkRepository {
  private readonly legacyWorkInsert: boolean;

  constructor(private readonly db: Database.Database) {
    // Older current-version files retain their inert quota history. Their required
    // JSON column has no default; supply an empty tombstone only for new rows.
    // Do not bump the schema version or rewrite existing history to remove a module.
    this.legacyWorkInsert = (db.prepare("PRAGMA table_info(works)").all() as Array<{ name: string }>)
      .some(column => column.name === "budget_json");
  }

  // ------------------------------------------------------------------ works

  insertWork(work: WorkDto): void {
    this.db.prepare(`INSERT INTO works (
      work_id,user_id,project_id,workspace_path,source_message_id,legacy_task_id,
      owner_bot_id,owner_epoch,intent_revision,source_version,title,goal_description,
      constraints_json,criteria_json,authorization_json,active_intent_snapshot_id,
      input_snapshot_id,goal_sources_json,mode,lifecycle,pending_conclusion,cancel_requested_at,
      closure_conclusion,closure_summary,accepted_deliverable_ids_json,active_execution_ids_json,
      progress_summary,watch_rule_json,deadline_at,deadline_revision,deadline_set_at,
      causal_policy_json,state_version,created_by,created_at,updated_at,
      closed_at,close_operation_id${this.legacyWorkInsert ? ",budget_json" : ""}
    ) VALUES (
      @workId,@userId,@projectId,@workspacePath,@sourceMessageId,@legacyTaskId,
      @ownerBotId,@ownerEpoch,@intentRevision,@sourceVersion,@title,@goalDescription,
      @constraintsJson,@criteriaJson,@authorizationJson,@activeIntentSnapshotId,
      @inputSnapshotId,@goalSourcesJson,@mode,@lifecycle,@pendingConclusion,@cancelRequestedAt,
      @closureConclusion,@closureSummary,@acceptedDeliverableIdsJson,@activeExecutionIdsJson,
      @progressSummary,@watchRuleJson,@deadlineAt,@deadlineRevision,@deadlineSetAt,
      @causalPolicyJson,@stateVersion,@createdBy,@createdAt,@updatedAt,
      @closedAt,@closeOperationId${this.legacyWorkInsert ? ",'{}'" : ""}
    )`).run(this.workParams(work));
  }

  updateWork(work: WorkDto): void {
    this.db.prepare(`UPDATE works SET
      project_id=@projectId, workspace_path=@workspacePath, source_message_id=@sourceMessageId,
      legacy_task_id=@legacyTaskId, owner_bot_id=@ownerBotId, owner_epoch=@ownerEpoch,
      intent_revision=@intentRevision, source_version=@sourceVersion, title=@title,
      goal_description=@goalDescription, constraints_json=@constraintsJson, criteria_json=@criteriaJson,
      authorization_json=@authorizationJson, active_intent_snapshot_id=@activeIntentSnapshotId,
      input_snapshot_id=@inputSnapshotId, goal_sources_json=@goalSourcesJson, mode=@mode,
      lifecycle=@lifecycle, pending_conclusion=@pendingConclusion, cancel_requested_at=@cancelRequestedAt,
      closure_conclusion=@closureConclusion, closure_summary=@closureSummary,
      accepted_deliverable_ids_json=@acceptedDeliverableIdsJson, active_execution_ids_json=@activeExecutionIdsJson,
      progress_summary=@progressSummary, watch_rule_json=@watchRuleJson, deadline_at=@deadlineAt,
      deadline_revision=@deadlineRevision, deadline_set_at=@deadlineSetAt,
      causal_policy_json=@causalPolicyJson, state_version=@stateVersion, updated_at=@updatedAt,
      closed_at=@closedAt, close_operation_id=@closeOperationId
      WHERE work_id=@workId`).run(this.workParams(work));
  }

  private workParams(work: WorkDto): Record<string, unknown> {
    return {
      workId: work.workId,
      userId: work.userId,
      projectId: work.projectId ?? null,
      workspacePath: work.workspacePath ?? null,
      sourceMessageId: work.sourceMessageId ?? null,
      legacyTaskId: work.legacyTaskId ?? null,
      ownerBotId: work.ownerBotId,
      ownerEpoch: work.ownerEpoch,
      intentRevision: work.intentRevision,
      sourceVersion: work.sourceVersion,
      title: work.title,
      goalDescription: work.goalDescription ?? null,
      constraintsJson: jsonText(work.constraints),
      criteriaJson: jsonText(work.criteria),
      authorizationJson: jsonText(work.authorization),
      activeIntentSnapshotId: work.activeIntentSnapshotId,
      inputSnapshotId: work.inputSnapshotId,
      goalSourcesJson: jsonText(work.goalSources),
      mode: work.mode,
      lifecycle: work.lifecycle,
      pendingConclusion: work.pendingConclusion ?? null,
      cancelRequestedAt: work.cancelRequestedAt ?? null,
      closureConclusion: work.closureConclusion ?? null,
      closureSummary: work.closureSummary ?? null,
      acceptedDeliverableIdsJson: jsonText(work.acceptedDeliverableIds),
      activeExecutionIdsJson: jsonText(work.activeExecutionIds),
      progressSummary: work.progressSummary ?? null,
      watchRuleJson: work.watchRule ? jsonText(work.watchRule) : null,
      deadlineAt: work.deadlineAt ?? null,
      deadlineRevision: work.deadlineRevision ?? 1,
      deadlineSetAt: work.deadlineSetAt ?? null,
      causalPolicyJson: jsonText(work.causalPolicy ?? {}),
      stateVersion: work.stateVersion,
      createdBy: work.createdBy,
      createdAt: work.createdAt,
      updatedAt: work.updatedAt,
      closedAt: work.closedAt ?? null,
      closeOperationId: work.closeOperationId ?? null,
    };
  }

  getWork(workId: string): WorkDto | undefined {
    const row = this.db.prepare("SELECT * FROM works WHERE work_id=?").get(workId) as WorkRow | undefined;
    return row ? this.hydrate(row) : undefined;
  }

  listWorks(userId: string, options: { includeClosed?: boolean } = {}): WorkDto[] {
    const rows = (options.includeClosed
      ? this.db.prepare("SELECT * FROM works WHERE user_id=? ORDER BY updated_at DESC").all(userId)
      : this.db.prepare("SELECT * FROM works WHERE user_id=? AND lifecycle != 'closed' ORDER BY updated_at DESC").all(userId)) as WorkRow[];
    return rows.map((row) => this.hydrate(row));
  }

  listWorksByOwner(botId: string, options: { includeClosed?: boolean } = {}): WorkDto[] {
    const rows = (options.includeClosed
      ? this.db.prepare("SELECT * FROM works WHERE owner_bot_id=? ORDER BY updated_at DESC").all(botId)
      : this.db.prepare("SELECT * FROM works WHERE owner_bot_id=? AND lifecycle != 'closed' ORDER BY updated_at DESC").all(botId)) as WorkRow[];
    return rows.map((row) => this.hydrate(row));
  }

  listLiveWorksByTask(taskId: string): WorkDto[] {
    const rows = this.db.prepare(`SELECT DISTINCT w.* FROM works w
      INNER JOIN work_conversations c ON c.work_id = w.work_id
      WHERE c.conversation_id=? AND w.lifecycle != 'closed'
      ORDER BY w.updated_at DESC`).all(taskId) as WorkRow[];
    return rows.map((row) => this.hydrate(row));
  }

  listConversationIds(workId: string): string[] {
    return (this.db.prepare("SELECT conversation_id FROM work_conversations WHERE work_id=? ORDER BY last_referenced_at DESC")
      .all(workId) as Array<{ conversation_id: string }>).map((row) => row.conversation_id);
  }

  linkConversation(workId: string, conversationId: string, channelType = "desktop", now = Date.now()): void {
    this.db.prepare(`INSERT INTO work_conversations (work_id,conversation_id,channel_type,last_referenced_at)
      VALUES (?,?,?,?) ON CONFLICT(work_id,conversation_id) DO UPDATE SET last_referenced_at=excluded.last_referenced_at`)
      .run(workId, conversationId, channelType, now);
  }

  private hydrate(row: WorkRow): WorkDto {
    return {
      workId: row.work_id,
      userId: row.user_id,
      projectId: row.project_id ?? undefined,
      workspacePath: row.workspace_path ?? undefined,
      sourceMessageId: row.source_message_id ?? undefined,
      legacyTaskId: row.legacy_task_id ?? undefined,
      ownerBotId: row.owner_bot_id,
      ownerEpoch: row.owner_epoch,
      participants: this.listParticipants(row.work_id),
      intentRevision: row.intent_revision,
      sourceVersion: row.source_version,
      title: row.title,
      goalDescription: row.goal_description ?? undefined,
      constraints: json<string[]>(row.constraints_json, []),
      criteria: json<WorkDto["criteria"]>(row.criteria_json, []),
      authorization: readAuthorization(row.authorization_json),
      activeIntentSnapshotId: row.active_intent_snapshot_id,
      inputSnapshotId: row.input_snapshot_id,
      goalSources: json<WorkGoalSourceDto[]>(row.goal_sources_json, []),
      mode: row.mode,
      lifecycle: row.lifecycle,
      pendingConclusion: row.pending_conclusion ?? undefined,
      cancelRequestedAt: row.cancel_requested_at ?? undefined,
      closureConclusion: row.closure_conclusion ?? undefined,
      closureSummary: row.closure_summary ?? undefined,
      acceptedDeliverableIds: json<string[]>(row.accepted_deliverable_ids_json, []),
      activeExecutionIds: json<string[]>(row.active_execution_ids_json, []),
      progressSummary: row.progress_summary ?? undefined,
      watchRule: row.watch_rule_json ? json<WorkWatchRuleDto | undefined>(row.watch_rule_json, undefined) : undefined,
      deadlineAt: row.deadline_at ?? undefined,
      deadlineRevision: row.deadline_revision,
      deadlineSetAt: row.deadline_set_at ?? undefined,
      causalPolicy: json<WorkDto["causalPolicy"] | undefined>(row.causal_policy_json, undefined),
      stateVersion: row.state_version,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      closedAt: row.closed_at ?? undefined,
      closeOperationId: row.close_operation_id ?? undefined,
    };
  }

  // ------------------------------------------------------- intent snapshots

  insertIntentSnapshot(snapshot: WorkIntentSnapshotDto): void {
    this.db.prepare(`INSERT INTO work_intent_snapshots (
      snapshot_id,work_id,intent_revision,source_version,title,goal_description,constraints_json,
      criteria_json,authorization_json,expert_snapshot_json,input_snapshot_id,goal_sources_json,
      created_by,source_message_id,created_at
    ) VALUES (@snapshotId,@workId,@intentRevision,@sourceVersion,@title,@goalDescription,@constraintsJson,
      @criteriaJson,@authorizationJson,@expertSnapshotJson,@inputSnapshotId,@goalSourcesJson,
      @createdBy,@sourceMessageId,@createdAt)`).run({
      snapshotId: snapshot.snapshotId,
      workId: snapshot.workId,
      intentRevision: snapshot.intentRevision,
      sourceVersion: snapshot.sourceVersion ?? 1,
      title: snapshot.title,
      goalDescription: snapshot.goalDescription ?? null,
      constraintsJson: jsonText(snapshot.constraints),
      criteriaJson: jsonText(snapshot.criteria),
      authorizationJson: jsonText(snapshot.authorization),
      expertSnapshotJson: jsonText(snapshot.expertSnapshot),
      inputSnapshotId: snapshot.inputSnapshotId,
      goalSourcesJson: jsonText(snapshot.goalSources),
      createdBy: snapshot.createdBy,
      sourceMessageId: snapshot.sourceMessageId ?? null,
      createdAt: snapshot.createdAt,
    });
  }

  /** Requirement revisions for the expanded diagnostics view, newest first. */
  listIntentSnapshots(workId: string): Array<{ intentRevision: number; inputSnapshotId: string; sourceVersion: number; createdAt: number }> {
    return (this.db.prepare(`SELECT intent_revision,input_snapshot_id,source_version,created_at
      FROM work_intent_snapshots WHERE work_id=? ORDER BY intent_revision DESC,source_version DESC`)
      .all(workId) as Array<{ intent_revision: number; input_snapshot_id: string; source_version: number; created_at: number }>)
      .map(row => ({ intentRevision: row.intent_revision, inputSnapshotId: row.input_snapshot_id,
        sourceVersion: row.source_version, createdAt: row.created_at }));
  }

  // ----------------------------------------------------------- participants

  captureReportContext(binding: WorkExecutionBindingDto, input: string): void { captureTeamReportContext(this.db, binding, input); }
  reportContext(binding: WorkExecutionBindingDto): unknown { return capturedTeamReportContext(this.db, binding); }

  attachmentInput(binding: WorkExecutionBindingDto): string {
    const row = this.db.prepare("SELECT attachments_json FROM bot_work_attachments WHERE work_id=? AND input_snapshot_id=?")
      .get(binding.workId, binding.inputSnapshotId) as { attachments_json: string } | undefined;
    if (!row) return "";
    const attachments = botAttachmentSchema.array().parse(JSON.parse(row.attachments_json));
    return `\n\n用户附件（此执行输入快照的宿主持久副本；读取实际文件，不要仅凭文件名推断内容）：\n${attachments.map(item => JSON.stringify(item)).join("\n")}`;
  }

  executionInput(binding: WorkExecutionBindingDto): string {
    const row = this.db.prepare(`SELECT title,goal_description,constraints_json,criteria_json,source_version,created_by
      FROM work_intent_snapshots WHERE work_id=? AND intent_revision=? AND input_snapshot_id=?
      ORDER BY source_version DESC LIMIT 1`).get(binding.workId, binding.intentRevision, binding.inputSnapshotId) as
      { title: string; goal_description: string | null; constraints_json: string; criteria_json: string;
        source_version: number; created_by: "user" | "bot" } | undefined;
    if (!row) throw new Error("执行缺少持久化的要求与输入快照");
    const userRequest = botDelegationInput(this.db, binding, row.source_version);
    const definition = { title: row.title, description: row.goal_description, constraints: json<string[]>(row.constraints_json, []),
      criteria: json<WorkDto["criteria"]>(row.criteria_json, []) };
    const userDefinition: Partial<typeof definition> = {}, planDefinition: Partial<typeof definition> = {};
    if (userRequest) for (const field of ["title", "description"] as const) {
      Object.assign(userRequest.definitionOrigins[field] === "user" ? userDefinition : planDefinition, { [field]: definition[field] });
    }
    if (userRequest) {
      const requiredConstraints = definition.constraints.filter(text => userRequest.constraintOrigins[text] === "user");
      if (requiredConstraints.length) userDefinition.constraints = requiredConstraints;
      planDefinition.constraints = definition.constraints.filter(text => userRequest.constraintOrigins[text] !== "user");
      userDefinition.criteria = definition.criteria.filter(item => item.origin !== "assistant_proposal");
      planDefinition.criteria = definition.criteria.filter(item => item.origin === "assistant_proposal");
    }
    const sourceEvent = binding.inboxEventId
      ? this.db.prepare("SELECT source,source_event_id,event_type,source_version,payload_json,received_at FROM work_events_inbox WHERE event_id=?")
        .get(binding.inboxEventId) as { source: string; source_event_id: string; event_type: string; source_version: string | null;
          payload_json: string; received_at: number } | undefined
      : undefined;
    const hasTeams = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_team_execution_history'").get();
    const team = hasTeams ? this.db.prepare("SELECT input_json FROM work_team_executions WHERE task_id=? AND work_id=? UNION ALL SELECT input_json FROM work_team_execution_history WHERE task_id=? AND work_id=? LIMIT 1")
      .get(binding.taskId, binding.workId, binding.taskId, binding.workId) as { input_json: string | null } | undefined : undefined;
    return JSON.stringify({
      ...(team?.input_json ? { teamAssignment: JSON.parse(team.input_json) } : {}),
      workId: binding.workId, intentRevision: binding.intentRevision, inputSnapshotId: binding.inputSnapshotId,
      ...(userRequest ? { userRequest, ...userDefinition, delegationPlan: { provenance: "assistant_generated", ...planDefinition } }
        : definition),
      delegatedScope: binding.delegatedScope,
      ...(sourceEvent ? { sourceEvent: { source: sourceEvent.source, eventId: sourceEvent.source_event_id,
        eventType: sourceEvent.event_type, sourceVersion: sourceEvent.source_version ?? undefined,
        receivedAt: sourceEvent.received_at, payload: json<Record<string, unknown>>(sourceEvent.payload_json, {}) } } : {}),
      ...(sourceEvent?.event_type === "work.tick" ? { watchFollowUp: {
        readOnly: true,
        watchRule: this.getWork(binding.workId)?.watchRule,
        previousReports: this.db.prepare(`SELECT deliverable_id AS deliverableId,substr(summary,1,2000) AS summary
          FROM work_deliverables WHERE work_id=? AND execution_id!=? ORDER BY created_at DESC LIMIT 3`)
          .all(binding.workId, binding.bindingId),
        instructions: "这是按用户时间表触发的一次只读检查。读取当前来源，和已有报告比较，汇报重要变化或明确缺口；不重跑原任务的修改、购买、发送等副作用。不自行循环等待下一次，完成本次后交还宿主调度。说明用户停止条件是否已满足，不把一次检查当成整个事项已完成。",
      } } : {}),
      ...(sourceEvent?.event_type === "deadline_expired" ? { deadlineFollowUp: {
        readOnly: true, deadlineRevision: json<Record<string, unknown>>(sourceEvent.payload_json, {}).deadlineRevision,
        deadlineAt: json<Record<string, unknown>>(sourceEvent.payload_json, {}).deadlineAt,
        instructions: "这是承诺到期的只读跟进。整理已有成果、未完成项和缺口，不重跑原业务副作用，不重复已确认的外部效果。",
      } } : {}),
      instructions: userRequest ? BOT_DELEGATION_INSTRUCTIONS
        : "按上述持久要求执行。只提交成果、证据和未覆盖范围，不自行宣布整个 Work 已验收。",
    });
  }

  upsertParticipant(participant: WorkParticipantDto & { workId: string }): void {
    this.db.prepare(`INSERT INTO work_participants (work_id,bot_id,role,delegated_scope_json,expert_snapshot_json,added_at)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(work_id,bot_id) DO UPDATE SET
        role=excluded.role, delegated_scope_json=excluded.delegated_scope_json,
        expert_snapshot_json=excluded.expert_snapshot_json`)
      .run(participant.workId, participant.botId, participant.role,
        jsonText(participant.delegatedScope), jsonText(participant.expertSnapshot), participant.addedAt);
  }

  getParticipant(workId: string, botId: string): WorkParticipantDto | undefined {
    return this.listParticipants(workId).find((participant) => participant.botId === botId);
  }

  listParticipants(workId: string): WorkParticipantDto[] {
    const rows = this.db.prepare("SELECT * FROM work_participants WHERE work_id=? ORDER BY added_at ASC")
      .all(workId) as Array<{
        bot_id: string; role: WorkParticipantDto["role"]; delegated_scope_json: string;
        expert_snapshot_json: string; added_at: number;
      }>;
    return rows.map((row) => ({
      botId: row.bot_id,
      role: row.role,
      delegatedScope: json<string[]>(row.delegated_scope_json, []),
      expertSnapshot: json<ExpertConfigSnapshotDto>(row.expert_snapshot_json, {
        expertId: "", revision: "", version: 0, systemPromptHash: "", allowedMcpIds: [],
        allowedSkillIds: [], allowedConnectorIds: [], capturedAt: 0,
      }),
      addedAt: row.added_at,
    }));
  }

  // -------------------------------------------------------------- receipts

  getReceipt(userId: string, operationId: string): ReceiptRow | undefined {
    return this.db.prepare("SELECT * FROM work_operation_receipts WHERE user_id=? AND operation_id=?")
      .get(userId, operationId) as ReceiptRow | undefined;
  }

  saveReceipt(params: {
    userId: string; operationId: string; workId?: string; operationType: string;
    payloadHash: string; workSnapshot: WorkDto; outboxEventId?: string; now: number;
  }): void {
    this.db.prepare(`INSERT INTO work_operation_receipts
      (user_id,operation_id,work_id,operation_type,payload_hash,result_snapshot_json,outbox_event_id,created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      params.userId, params.operationId, params.workId ?? null, params.operationType,
      params.payloadHash, jsonText(params.workSnapshot), params.outboxEventId ?? null, params.now,
    );
  }

  countReceiptsForUser(userId: string): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS count FROM work_operation_receipts WHERE user_id=?")
      .get(userId) as { count: number }).count);
  }

  // ------------------------------------------------------ execution bindings

  insertBinding(binding: WorkExecutionBindingDto): void {
    this.db.prepare(`INSERT INTO work_execution_bindings (
      binding_id,work_id,operation_id,bot_id,task_id,durable_store_key,conversation_id,intent_revision,
      owner_epoch,input_snapshot_id,expert_snapshot_json,delegated_scope_json,workspace_binding,
      status,attempt_id,submission_receipt,settlement_note,admitted_at,submitted_at,invalidated_at,settled_at,inbox_event_id
    ) VALUES (@bindingId,@workId,@operationId,@botId,@taskId,@durableStoreKey,@conversationId,@intentRevision,
      @ownerEpoch,@inputSnapshotId,@expertSnapshotJson,@delegatedScopeJson,@workspaceBinding,
      @status,@attemptId,@submissionReceipt,@settlementNote,@admittedAt,@submittedAt,@invalidatedAt,@settledAt,@inboxEventId)`).run({
      ...binding,
      attemptId: binding.attemptId ?? null,
      submissionReceipt: binding.submissionReceipt ?? null,
      settlementNote: binding.settlementNote ?? null,
      submittedAt: binding.submittedAt ?? null,
      invalidatedAt: binding.invalidatedAt ?? null,
      settledAt: binding.settledAt ?? null,
      inboxEventId: binding.inboxEventId ?? null,
      expertSnapshotJson: jsonText(binding.expertSnapshot),
      delegatedScopeJson: jsonText(binding.delegatedScope),
    });
  }

  updateBinding(binding: WorkExecutionBindingDto): void {
    this.db.prepare(`UPDATE work_execution_bindings SET status=@status, attempt_id=@attemptId,
      submission_receipt=@submissionReceipt, settlement_note=@settlementNote, submitted_at=@submittedAt,
      invalidated_at=@invalidatedAt, settled_at=@settledAt, inbox_event_id=@inboxEventId WHERE binding_id=@bindingId`).run({
      bindingId: binding.bindingId,
      status: binding.status,
      attemptId: binding.attemptId ?? null,
      submissionReceipt: binding.submissionReceipt ?? null,
      settlementNote: binding.settlementNote ?? null,
      submittedAt: binding.submittedAt ?? null,
      invalidatedAt: binding.invalidatedAt ?? null,
      settledAt: binding.settledAt ?? null,
      inboxEventId: binding.inboxEventId ?? null,
    });
  }

  getBinding(bindingId: string): WorkExecutionBindingDto | undefined {
    const row = this.db.prepare("SELECT * FROM work_execution_bindings WHERE binding_id=?").get(bindingId) as BindingRow | undefined;
    return row ? mapBinding(row) : undefined;
  }

  bindingForTask(taskId: string): WorkExecutionBindingDto | undefined {
    const row = this.db.prepare("SELECT * FROM work_execution_bindings WHERE task_id=? ORDER BY admitted_at DESC, rowid DESC LIMIT 1")
      .get(taskId) as BindingRow | undefined;
    return row ? mapBinding(row) : undefined;
  }

  getBindingByOperation(workId: string, operationId: string): WorkExecutionBindingDto | undefined {
    const row = this.db.prepare("SELECT * FROM work_execution_bindings WHERE work_id=? AND operation_id=?")
      .get(workId, operationId) as BindingRow | undefined;
    return row ? mapBinding(row) : undefined;
  }

  listBindings(workId: string): WorkExecutionBindingDto[] {
    return (this.db.prepare("SELECT * FROM work_execution_bindings WHERE work_id=? ORDER BY admitted_at ASC")
      .all(workId) as BindingRow[]).map(mapBinding);
  }

  // ------------------------------------------------------------- admissions

  insertAdmission(admission: WorkAdmissionDto): void {
    this.db.prepare(`INSERT INTO work_action_admissions
      (admission_id,work_id,binding_id,operation_id,action_kind,state,intent_revision,owner_epoch,admitted_at,settled_at)
      VALUES (@admissionId,@workId,@bindingId,@operationId,@actionKind,@state,@intentRevision,@ownerEpoch,@admittedAt,@settledAt)`)
      .run({
        ...admission,
        bindingId: admission.bindingId ?? null,
        settledAt: admission.settledAt ?? null,
      });
  }

  updateAdmissionState(admissionId: string, state: WorkAdmissionDto["state"], settledAt?: number): void {
    this.db.prepare("UPDATE work_action_admissions SET state=?, settled_at=? WHERE admission_id=?")
      .run(state, settledAt ?? null, admissionId);
  }

  getAdmission(admissionId: string): WorkAdmissionDto | undefined {
    const row = this.db.prepare("SELECT * FROM work_action_admissions WHERE admission_id=?").get(admissionId) as AdmissionRow | undefined;
    return row ? mapAdmission(row) : undefined;
  }

  listAdmissions(workId: string): WorkAdmissionDto[] {
    return (this.db.prepare("SELECT * FROM work_action_admissions WHERE work_id=? ORDER BY admitted_at ASC")
      .all(workId) as AdmissionRow[]).map(mapAdmission);
  }

  // ------------------------------------------------------------ deliverables

  insertDeliverable(deliverable: WorkDeliverableDto): void {
    this.db.prepare(`INSERT INTO work_deliverables (
      deliverable_id,work_id,producer_bot_id,execution_id,intent_revision,owner_epoch,input_snapshot_id,
      status,summary,artifact_refs_json,evidence_refs_json,uncovered_scope_json,uncovered_criterion_ids_json,is_speculation,
      has_write_conflicts,rejected_reason,created_at,reviewed_at,reviewed_by_bot_id
    ) VALUES (@deliverableId,@workId,@producerBotId,@executionId,@intentRevision,@ownerEpoch,@inputSnapshotId,
      @status,@summary,@artifactRefsJson,@evidenceRefsJson,@uncoveredScopeJson,@uncoveredCriterionIdsJson,@isSpeculation,
      @hasWriteConflicts,@rejectedReason,@createdAt,@reviewedAt,@reviewedByBotId)`).run({
      ...deliverable,
      artifactRefsJson: jsonText(deliverable.artifactRefs),
      evidenceRefsJson: jsonText(deliverable.evidenceRefs),
      uncoveredScopeJson: jsonText(deliverable.uncoveredScope),
      uncoveredCriterionIdsJson: jsonText(deliverable.uncoveredCriterionIds),
      isSpeculation: deliverable.isSpeculation ? 1 : 0,
      hasWriteConflicts: deliverable.hasWriteConflicts ? 1 : 0,
      rejectedReason: deliverable.rejectedReason ?? null,
      reviewedAt: deliverable.reviewedAt ?? null,
      reviewedByBotId: deliverable.reviewedByBotId ?? null,
    });
  }

  updateDeliverableReview(deliverableId: string, params: {
    status: WorkDeliverableDto["status"]; reviewedAt?: number; reviewedByBotId?: string; rejectedReason?: string;
  }): void {
    this.db.prepare(`UPDATE work_deliverables SET status=@status, reviewed_at=@reviewedAt,
      reviewed_by_bot_id=@reviewedByBotId, rejected_reason=@rejectedReason WHERE deliverable_id=@deliverableId`)
      .run({
        deliverableId,
        status: params.status,
        reviewedAt: params.reviewedAt ?? null,
        reviewedByBotId: params.reviewedByBotId ?? null,
        rejectedReason: params.rejectedReason ?? null,
      });
  }

  getDeliverable(deliverableId: string): WorkDeliverableDto | undefined {
    const row = this.db.prepare("SELECT * FROM work_deliverables WHERE deliverable_id=?").get(deliverableId) as DeliverableRow | undefined;
    return row ? mapDeliverable(row) : undefined;
  }

  listDeliverables(workId: string): WorkDeliverableDto[] {
    return (this.db.prepare("SELECT * FROM work_deliverables WHERE work_id=? ORDER BY created_at ASC")
      .all(workId) as DeliverableRow[]).map(mapDeliverable);
  }

  supersedeStaleDeliverables(workId: string, intentRevision: number, inputSnapshotId: string): void {
    // A pending result from an old input is no longer awaiting current acceptance.
    // Accepted rows retain their historical review; Work tracks current result IDs.
    this.db.prepare(`UPDATE work_deliverables SET status='superseded'
      WHERE work_id=? AND status='proposed' AND (
        intent_revision != ? OR input_snapshot_id != ? OR EXISTS (
          SELECT 1 FROM work_execution_bindings b
          WHERE b.binding_id=work_deliverables.execution_id AND b.work_id=work_deliverables.work_id
            AND (b.invalidated_at IS NOT NULL OR b.status='invalidated')
        )
      )`).run(workId, intentRevision, inputSnapshotId);
  }

  // ---------------------------------------------------------------- evidence

  insertEvidence(evidence: WorkEvidenceDto): void {
    this.db.prepare(`INSERT INTO work_evidence (
      evidence_id,work_id,deliverable_id,execution_id,criterion_ids_json,kind,provenance,source_ref,
      source_sha,input_snapshot_id,environment,intent_revision,detail,recorded_at
    ) VALUES (@evidenceId,@workId,@deliverableId,@executionId,@criterionIdsJson,@kind,@provenance,@sourceRef,
      @sourceSha,@inputSnapshotId,@environment,@intentRevision,@detail,@recordedAt)`).run({
      ...evidence,
      deliverableId: evidence.deliverableId ?? null,
      executionId: evidence.executionId ?? null,
      criterionIdsJson: jsonText(evidence.criterionIds),
      sourceSha: evidence.sourceSha ?? null,
      environment: evidence.environment ?? null,
      detail: evidence.detail ?? null,
    });
  }

  getEvidence(evidenceId: string): WorkEvidenceDto | undefined {
    const row = this.db.prepare("SELECT * FROM work_evidence WHERE evidence_id=?").get(evidenceId) as EvidenceRow | undefined;
    return row ? mapEvidence(row) : undefined;
  }

  listEvidence(workId: string): WorkEvidenceDto[] {
    return (this.db.prepare("SELECT * FROM work_evidence WHERE work_id=? ORDER BY recorded_at ASC")
      .all(workId) as EvidenceRow[]).map(mapEvidence);
  }

  // ---------------------------------------------------------------- blockers

  insertBlocker(blocker: WorkBlockerDto): void {
    blocker = nonBlockingEffect(blocker);
    this.db.prepare(`INSERT INTO work_blockers (
      blocker_id,work_id,reported_by_bot_id,reason,kind,unknown_external_effect_ref,
      reason_code,details_json,source_ref,subscription_id,causal_chain_id,
      waiting_for_user_input,status,created_at,cleared_at
    ) VALUES (@blockerId,@workId,@reportedByBotId,@reason,@kind,@unknownExternalEffectRef,
      @reasonCode,@detailsJson,@sourceRef,@subscriptionId,@causalChainId,
      @waitingForUserInput,@status,@createdAt,@clearedAt)`).run({
      ...blocker,
      reportedByBotId: blocker.reportedByBotId ?? null,
      unknownExternalEffectRef: blocker.unknownExternalEffectRef ?? null,
      reasonCode: blocker.reasonCode ?? null,
      detailsJson: jsonText(blocker.details ?? {}),
      sourceRef: blocker.sourceRef ?? null,
      subscriptionId: blocker.subscriptionId ?? null,
      causalChainId: blocker.causalChainId ?? null,
      waitingForUserInput: blocker.waitingForUserInput ? 1 : 0,
      clearedAt: blocker.clearedAt ?? null,
    });
  }

  clearBlocker(blockerId: string, workId: string, now: number): void {
    this.db.prepare("UPDATE work_blockers SET status='cleared', cleared_at=? WHERE blocker_id=? AND work_id=? AND status='open'")
      .run(now, blockerId, workId);
  }

  recordBlockerResponse(blocker: WorkBlockerDto, response: Record<string, unknown>, now: number): void {
    this.db.prepare("UPDATE work_blockers SET details_json=?,status='cleared',cleared_at=? WHERE blocker_id=? AND work_id=? AND status='open'")
      .run(jsonText({ ...blocker.details, response }), now, blocker.blockerId, blocker.workId);
  }

  getBlocker(blockerId: string): WorkBlockerDto | undefined {
    const row = this.db.prepare("SELECT * FROM work_blockers WHERE blocker_id=?").get(blockerId) as BlockerRow | undefined;
    return row ? mapBlocker(row) : undefined;
  }

  listBlockers(workId: string): WorkBlockerDto[] {
    return (this.db.prepare("SELECT * FROM work_blockers WHERE work_id=? ORDER BY created_at ASC")
      .all(workId) as BlockerRow[]).filter(row => !isRetiredQuotaBlocker(row) && !this.isRetiredTeamQuotaBlocker(row)).map(mapBlocker);
  }

  /** Read-only retirement of exact module errors; never reinterpret an existing execution/effect. */
  canIgnoreRetiredTeamQuotaFailure(workId: string, taskId: string, reason: string): boolean {
    if (!["团队共享预算已耗尽，未启动下一成员", "团队仍有未核实的供应商用量，核对原预留后才能继续",
      "团队仍有未核实的供应商用量，不能派发新的执行"].includes(reason)) return false;
    if (this.bindingForTask(taskId)) return false;
    if (this.listAdmissions(workId).some(workAdmissionInFlight)) return false;
    // Uncertain effects do not revive retired quota refusals on unstarted tasks.
    return true;
  }

  private isRetiredTeamQuotaBlocker(row: BlockerRow): boolean {
    const prefix = "团队执行尚未启动，需核对后继续：";
    return row.kind === "operational" && !row.unknown_external_effect_ref
      && row.blocker_id.startsWith("team-dispatch:") && row.reason.startsWith(prefix)
      && this.canIgnoreRetiredTeamQuotaFailure(row.work_id, row.blocker_id.slice("team-dispatch:".length), row.reason.slice(prefix.length));
  }

  listOpenBlockers(workId: string): WorkBlockerDto[] {
    return this.listBlockers(workId).filter((blocker) => blocker.status === "open");
  }

  reopenBlocker(blockerId: string, workId: string): void {
    this.db.prepare("UPDATE work_blockers SET status='open',cleared_at=NULL WHERE blocker_id=? AND work_id=? AND kind!='external_effect' AND unknown_external_effect_ref IS NULL").run(blockerId, workId);
  }

  // ------------------------------------------------------------- subscriptions

  insertSubscription(subscription: WorkSubscriptionDto): void {
    this.db.prepare(`INSERT INTO work_subscriptions (
      subscription_id,work_id,source,filter_json,catch_up_policy,max_merge_wait_ms,max_queue_depth,
      stop_condition_text,timezone,cron_expression,next_wake_at,last_processed_source_version,
      schedule_revision,config_revision,source_target,version_mode,dst_policy,max_backlog_events,
      max_backlog_bytes,last_checked_at,stopped_reason,config_json,
      created_at,updated_at,stopped_at
    ) VALUES (@subscriptionId,@workId,@source,@filterJson,@catchUpPolicy,@maxMergeWaitMs,@maxQueueDepth,
      @stopConditionText,@timezone,@cronExpression,@nextWakeAt,@lastProcessedSourceVersion,
      @scheduleRevision,@configRevision,@sourceTarget,@versionMode,@dstPolicy,@maxBacklogEvents,
      @maxBacklogBytes,@lastCheckedAt,@stoppedReason,@configJson,
      @createdAt,@updatedAt,@stoppedAt)`).run({
      ...subscription,
      filterJson: jsonText(subscription.filter),
      stopConditionText: subscription.stopConditionText ?? null,
      timezone: subscription.timezone ?? null,
      cronExpression: subscription.cronExpression ?? null,
      nextWakeAt: subscription.nextWakeAt ?? null,
      lastProcessedSourceVersion: subscription.lastProcessedSourceVersion ?? null,
      scheduleRevision: subscription.scheduleRevision ?? 1,
      configRevision: subscription.configRevision ?? 1,
      sourceTarget: subscription.sourceTarget ?? null,
      versionMode: subscription.versionMode ?? "readback",
      dstPolicy: subscription.dstPolicy ?? "first-valid",
      maxBacklogEvents: subscription.maxBacklogEvents ?? 400,
      maxBacklogBytes: subscription.maxBacklogBytes ?? 8_388_608,
      lastCheckedAt: subscription.lastCheckedAt ?? null,
      stoppedReason: subscription.stoppedReason ?? null,
      configJson: jsonText(subscription.filter),
      stoppedAt: subscription.stoppedAt ?? null,
    });
  }

  updateSubscription(subscription: WorkSubscriptionDto): void {
    this.db.prepare(`UPDATE work_subscriptions SET filter_json=@filterJson, catch_up_policy=@catchUpPolicy,
      max_merge_wait_ms=@maxMergeWaitMs, max_queue_depth=@maxQueueDepth, stop_condition_text=@stopConditionText,
      timezone=@timezone, cron_expression=@cronExpression, next_wake_at=@nextWakeAt,
      last_processed_source_version=@lastProcessedSourceVersion, schedule_revision=@scheduleRevision,
      config_revision=@configRevision, source_target=@sourceTarget, version_mode=@versionMode,
      dst_policy=@dstPolicy, max_backlog_events=@maxBacklogEvents, max_backlog_bytes=@maxBacklogBytes,
      last_checked_at=@lastCheckedAt, stopped_reason=@stoppedReason, config_json=@configJson,
      updated_at=@updatedAt, stopped_at=@stoppedAt
      WHERE subscription_id=@subscriptionId`).run({
      ...subscription,
      filterJson: jsonText(subscription.filter),
      stopConditionText: subscription.stopConditionText ?? null,
      timezone: subscription.timezone ?? null,
      cronExpression: subscription.cronExpression ?? null,
      nextWakeAt: subscription.nextWakeAt ?? null,
      lastProcessedSourceVersion: subscription.lastProcessedSourceVersion ?? null,
      scheduleRevision: subscription.scheduleRevision ?? 1,
      configRevision: subscription.configRevision ?? 1,
      sourceTarget: subscription.sourceTarget ?? null,
      versionMode: subscription.versionMode ?? "readback",
      dstPolicy: subscription.dstPolicy ?? "first-valid",
      maxBacklogEvents: subscription.maxBacklogEvents ?? 400,
      maxBacklogBytes: subscription.maxBacklogBytes ?? 8_388_608,
      lastCheckedAt: subscription.lastCheckedAt ?? null,
      stoppedReason: subscription.stoppedReason ?? null,
      configJson: jsonText(subscription.filter),
      stoppedAt: subscription.stoppedAt ?? null,
    });
  }

  getSubscription(subscriptionId: string): WorkSubscriptionDto | undefined {
    const row = this.db.prepare("SELECT * FROM work_subscriptions WHERE subscription_id=?").get(subscriptionId) as SubscriptionRow | undefined;
    return row ? mapSubscription(row) : undefined;
  }

  listSubscriptions(workId: string, options: { includeStopped?: boolean } = {}): WorkSubscriptionDto[] {
    const rows = (options.includeStopped
      ? this.db.prepare("SELECT * FROM work_subscriptions WHERE work_id=? ORDER BY created_at ASC").all(workId)
      : this.db.prepare("SELECT * FROM work_subscriptions WHERE work_id=? AND stopped_at IS NULL ORDER BY created_at ASC").all(workId)) as SubscriptionRow[];
    return rows.map(mapSubscription);
  }

  listActiveSubscriptions(): WorkSubscriptionDto[] {
    return (this.db.prepare("SELECT * FROM work_subscriptions WHERE stopped_at IS NULL ORDER BY created_at ASC").all() as SubscriptionRow[])
      .map(mapSubscription);
  }

  stopSubscriptionsForWork(workId: string, now: number): void {
    this.db.prepare("UPDATE work_subscriptions SET stopped_at=?, updated_at=? WHERE work_id=? AND stopped_at IS NULL")
      .run(now, now, workId);
  }

  // --------------------------------------------------------- source/inbox/outbox

  /** True when this exact source event was already recorded. */
  recordSourceEvent(event: {
    source: string; sourceEventId: string; eventType: string; sourceVersion?: string;
    causalEventId?: string; payload: Record<string, unknown>; receivedAt: number;
    occurredAt?: number; targetKey?: string; adapter?: string; trustedOrigin?: string;
  }): boolean {
    const payloadJson = jsonText(event.payload);
    const result = this.db.prepare(`INSERT OR IGNORE INTO work_source_events
      (source,source_event_id,event_type,source_version,causal_event_id,payload_json,received_at,
       occurred_at,target_key,payload_bytes,adapter,trusted_origin)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      event.source, event.sourceEventId, event.eventType, event.sourceVersion ?? null,
      event.causalEventId ?? null, payloadJson, event.receivedAt,
      event.occurredAt ?? null, event.targetKey ?? null, Buffer.byteLength(payloadJson, "utf8"),
      event.adapter ?? null, event.trustedOrigin ?? null,
    );
    return result.changes > 0;
  }

  insertInbox(event: WorkInboxEventDto): boolean {
    const result = this.db.prepare(`INSERT OR IGNORE INTO work_events_inbox (
      event_id,dedupe_key,source,source_event_id,event_type,work_id,subscription_id,intent_revision,
      state_version,owner_epoch,source_version,causal_event_id,payload_json,status,merged_count,
      merge_deadline_at,received_at,processed_at,batch_id,batch_deadline_at,frozen_at,frozen_payload_json,
      claim_version,target_key,process_reason
    ) VALUES (@eventId,@dedupeKey,@source,@sourceEventId,@eventType,@workId,@subscriptionId,@intentRevision,
      @stateVersion,@ownerEpoch,@sourceVersion,@causalEventId,@payloadJson,@status,@mergedCount,
      @mergeDeadlineAt,@receivedAt,@processedAt,@batchId,@batchDeadlineAt,@frozenAt,@frozenPayloadJson,
      @claimVersion,@targetKey,@processReason)`).run({
      ...event,
      subscriptionId: event.subscriptionId ?? null,
      causalEventId: event.causalEventId ?? null,
      sourceVersion: event.sourceVersion ?? null,
      payloadJson: jsonText(event.payload),
      mergeDeadlineAt: event.batchDeadlineAt ?? event.processAfter ?? null,
      processedAt: event.processedAt ?? null,
      batchId: event.batchId ?? null,
      batchDeadlineAt: event.batchDeadlineAt ?? null,
      frozenAt: event.frozenAt ?? null,
      frozenPayloadJson: event.frozenPayload ? jsonText(event.frozenPayload) : null,
      claimVersion: event.claimVersion ?? 0,
      targetKey: event.targetKey ?? null,
      processReason: event.processReason ?? null,
    });
    return result.changes > 0;
  }

  getInbox(eventId: string): WorkInboxEventDto | undefined {
    const row = this.db.prepare("SELECT * FROM work_events_inbox WHERE event_id=?").get(eventId) as InboxRow | undefined;
    return row ? mapInbox(row) : undefined;
  }

  listInbox(workId: string, statuses: WorkInboxEventDto["status"][] = ["pending", "merged"]): WorkInboxEventDto[] {
    const placeholders = statuses.map(() => "?").join(",");
    return (this.db.prepare(`SELECT * FROM work_events_inbox WHERE work_id=? AND status IN (${placeholders})
      ORDER BY received_at ASC`).all(workId, ...statuses) as InboxRow[]).map(mapInbox);
  }

  mergeLatestInbox(params: {
    subscriptionId: string; eventType: string; sourceVersion?: string; causalEventId?: string;
    payload: Record<string, unknown>; now: number;
  }): { merged: boolean } {
    const pending = this.db.prepare(`SELECT * FROM work_events_inbox
      WHERE subscription_id=? AND status IN ('pending','merged') ORDER BY received_at ASC LIMIT 1`)
      .get(params.subscriptionId) as InboxRow | undefined;
    if (!pending) return { merged: false };
    this.db.prepare(`UPDATE work_events_inbox SET event_type=?, source_version=?, causal_event_id=?,
      payload_json=?, status='merged', merged_count=merged_count+1 WHERE event_id=?`).run(
      params.eventType, params.sourceVersion ?? null, params.causalEventId ?? null,
      jsonText(params.payload), pending.event_id,
    );
    return { merged: true };
  }

  countPendingInboxForSubscription(subscriptionId: string): number {
    return Number((this.db.prepare("SELECT COUNT(*) AS count FROM work_events_inbox WHERE subscription_id=? AND status IN ('pending','merged','blocked')")
      .get(subscriptionId) as { count: number }).count);
  }

  setInboxStatus(eventId: string, status: WorkInboxEventDto["status"], now?: number): void {
    this.db.prepare("UPDATE work_events_inbox SET status=?, processed_at=? WHERE event_id=?")
      .run(status, now ?? null, eventId);
  }

  insertOutbox(instruction: WorkOutboxInstructionDto): void {
    this.db.prepare(`INSERT INTO work_events_outbox (
      event_id,dedupe_key,event_type,work_id,binding_id,intent_revision,state_version,owner_epoch,
      request_id,causal_event_id,payload_json,delivery_status,attempt_id,attempt_count,created_at,delivered_at
    ) VALUES (@eventId,@dedupeKey,@eventType,@workId,@bindingId,@intentRevision,@stateVersion,@ownerEpoch,
      @requestId,@causalEventId,@payloadJson,@deliveryStatus,@attemptId,@attemptCount,@createdAt,@deliveredAt)`).run({
      ...instruction,
      bindingId: instruction.bindingId ?? null,
      causalEventId: instruction.causalEventId ?? null,
      payloadJson: jsonText(instruction.payload),
      attemptId: instruction.attemptId ?? null,
      deliveredAt: instruction.deliveredAt ?? null,
    });
  }

  getOutbox(eventId: string): WorkOutboxInstructionDto | undefined {
    const row = this.db.prepare("SELECT * FROM work_events_outbox WHERE event_id=?").get(eventId) as OutboxRow | undefined;
    return row ? mapOutbox(row) : undefined;
  }

  listOutbox(workId: string, statuses?: WorkOutboxInstructionDto["deliveryStatus"][]): WorkOutboxInstructionDto[] {
    const rows = statuses?.length
      ? this.db.prepare(`SELECT * FROM work_events_outbox WHERE work_id=? AND delivery_status IN (${statuses.map(() => "?").join(",")}) ORDER BY created_at ASC`)
        .all(workId, ...statuses)
      : this.db.prepare("SELECT * FROM work_events_outbox WHERE work_id=? ORDER BY created_at ASC").all(workId);
    return (rows as OutboxRow[]).map(mapOutbox);
  }

  markOutboxAttempt(eventId: string, attemptId: string): void {
    this.db.prepare("UPDATE work_events_outbox SET delivery_status='attempted', attempt_id=?, attempt_count=attempt_count+1 WHERE event_id=?")
      .run(attemptId, eventId);
  }

  markOutboxDelivered(eventId: string, now: number): void {
    this.db.prepare("UPDATE work_events_outbox SET delivery_status='delivered', delivered_at=? WHERE event_id=?")
      .run(now, eventId);
  }

  markOutboxStatus(eventId: string, status: WorkOutboxInstructionDto["deliveryStatus"]): void {
    this.db.prepare("UPDATE work_events_outbox SET delivery_status=? WHERE event_id=?").run(status, eventId);
  }

  // ---------------------------------------------------------- notifications

  insertNotification(notification: WorkNotificationDto): boolean {
    const result = this.db.prepare(`INSERT OR IGNORE INTO work_notifications (
      notification_id,work_id,semantic_key,kind,title,body,state_version,intent_revision,delivery,
      channel,idempotency_key,attempt_count,external_receipt,read_at,created_at,sent_at,card_key,effect_key,target_key
    ) VALUES (@notificationId,@workId,@semanticKey,@kind,@title,@body,@stateVersion,@intentRevision,@delivery,
      @channel,@idempotencyKey,@attemptCount,@externalReceipt,@readAt,@createdAt,@sentAt,@cardKey,@effectKey,@targetKey)`).run({
      ...notification,
      body: notification.body ?? null,
      channel: notification.channel ?? null,
      idempotencyKey: notification.idempotencyKey ?? null,
      externalReceipt: notification.externalReceipt ?? null,
      readAt: notification.readAt ?? null,
      sentAt: notification.sentAt ?? null,
      cardKey: notification.cardKey ?? null,
      effectKey: notification.effectKey ?? null,
      targetKey: notification.targetKey ?? null,
    });
    return result.changes > 0;
  }

  /** Link an existing intent to its card or provider effect without touching delivery. */
  updateNotificationLinks(notificationId: string, params: { cardKey?: string; effectKey?: string; targetKey?: string }): void {
    this.db.prepare(`UPDATE work_notifications SET card_key=COALESCE(?,card_key), effect_key=COALESCE(?,effect_key),
      target_key=COALESCE(?,target_key) WHERE notification_id=?`)
      .run(params.cardKey ?? null, params.effectKey ?? null, params.targetKey ?? null, notificationId);
  }

  listWorksForNotifications(): WorkDto[] {
    const rows = this.db.prepare(`SELECT DISTINCT w.* FROM works w
      INNER JOIN work_notifications n ON n.work_id = w.work_id
      WHERE n.delivery IN ('pending','unknown') ORDER BY w.updated_at DESC`).all() as WorkRow[];
    return rows.map((row) => this.hydrate(row));
  }

  listNotifications(workId: string): WorkNotificationDto[] {
    return (this.db.prepare("SELECT * FROM work_notifications WHERE work_id=? ORDER BY created_at DESC")
      .all(workId) as NotificationRow[]).map(mapNotification);
  }

  getNotification(notificationId: string): WorkNotificationDto | undefined {
    const row = this.db.prepare("SELECT * FROM work_notifications WHERE notification_id=?")
      .get(notificationId) as NotificationRow | undefined;
    return row ? mapNotification(row) : undefined;
  }

  updateNotificationDelivery(notificationId: string, params: {
    delivery: WorkNotificationDelivery; channel?: string; attemptCount?: number;
    externalReceipt?: string; sentAt?: number; idempotencyKey?: string;
  }): void {
    this.db.prepare(`UPDATE work_notifications SET delivery=?, channel=COALESCE(?,channel),
      attempt_count=COALESCE(?,attempt_count), external_receipt=COALESCE(?,external_receipt),
      sent_at=COALESCE(?,sent_at), idempotency_key=COALESCE(?,idempotency_key) WHERE notification_id=?`)
      .run(params.delivery, params.channel ?? null, params.attemptCount ?? null,
        params.externalReceipt ?? null, params.sentAt ?? null, params.idempotencyKey ?? null, notificationId);
  }

  markNotificationRead(notificationId: string, now: number): void {
    this.db.prepare("UPDATE work_notifications SET read_at=? WHERE notification_id=?").run(now, notificationId);
  }

  /** Move a stale completion card to "superseded by newer requirement" without deleting history. */
  supersedeNotifications(workId: string, intentRevision: number, inputSnapshotId: string): void {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_notification_identity'").get()) return;
    this.db.prepare(`UPDATE work_notification_identity SET semantic_validity='superseded' WHERE notification_id IN (
      SELECT n.notification_id FROM work_notifications n WHERE n.work_id=? AND n.kind='result'
      AND (n.intent_revision<>? OR work_notification_identity.input_snapshot_id<>?))`)
      .run(workId, intentRevision, inputSnapshotId);
  }

  cancelPendingResultNotifications(workId: string): void {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_notification_identity'").get()) return;
    this.db.prepare(`UPDATE work_notification_identity SET semantic_validity='cancelled' WHERE notification_id IN (
      SELECT notification_id FROM work_notifications WHERE work_id=? AND kind='result')`).run(workId);
  }

  // ------------------------------------------------------------- telemetry

  recordTelemetry(params: {
    workId: string; executionId?: string; streamingText?: string; tokensPerSecond?: number; now: number;
  }): void {
    this.db.prepare(`INSERT INTO work_telemetry_state
      (work_id,active_execution_id,streaming_text,tokens_per_second,last_heartbeat_at,updated_at)
      VALUES (@workId,@executionId,@streamingText,@tokensPerSecond,@now,@now)
      ON CONFLICT(work_id) DO UPDATE SET
        active_execution_id=COALESCE(excluded.active_execution_id, work_telemetry_state.active_execution_id),
        streaming_text=COALESCE(excluded.streaming_text, work_telemetry_state.streaming_text),
        tokens_per_second=COALESCE(excluded.tokens_per_second, work_telemetry_state.tokens_per_second),
        last_heartbeat_at=excluded.last_heartbeat_at, updated_at=excluded.updated_at`)
      .run({
        workId: params.workId,
        executionId: params.executionId ?? null,
        streamingText: params.streamingText ?? null,
        tokensPerSecond: params.tokensPerSecond ?? null,
        now: params.now,
      });
  }
}

function mapBinding(row: BindingRow): WorkExecutionBindingDto {
  return {
    bindingId: row.binding_id,
    workId: row.work_id,
    operationId: row.operation_id,
    botId: row.bot_id,
    taskId: row.task_id,
    durableStoreKey: row.durable_store_key,
    conversationId: row.conversation_id,
    intentRevision: row.intent_revision,
    ownerEpoch: row.owner_epoch,
    inputSnapshotId: row.input_snapshot_id,
    expertSnapshot: json<ExpertConfigSnapshotDto>(row.expert_snapshot_json, {
      expertId: "", revision: "", version: 0, systemPromptHash: "", allowedMcpIds: [],
      allowedSkillIds: [], allowedConnectorIds: [], capturedAt: 0,
    }),
    delegatedScope: json<string[]>(row.delegated_scope_json, []),
    workspaceBinding: row.workspace_binding,
    status: row.status,
    attemptId: row.attempt_id ?? undefined,
    submissionReceipt: row.submission_receipt ?? undefined,
    settlementNote: row.settlement_note ?? undefined,
    admittedAt: row.admitted_at,
    submittedAt: row.submitted_at ?? undefined,
    invalidatedAt: row.invalidated_at ?? undefined,
    settledAt: row.settled_at ?? undefined,
    inboxEventId: row.inbox_event_id ?? undefined,
  };
}

function mapDeliverable(row: DeliverableRow): WorkDeliverableDto {
  return {
    deliverableId: row.deliverable_id,
    workId: row.work_id,
    producerBotId: row.producer_bot_id,
    executionId: row.execution_id,
    intentRevision: row.intent_revision,
    ownerEpoch: row.owner_epoch,
    inputSnapshotId: row.input_snapshot_id,
    status: row.status,
    summary: row.summary,
    artifactRefs: json<string[]>(row.artifact_refs_json, []),
    evidenceRefs: json<string[]>(row.evidence_refs_json, []),
    uncoveredScope: json<string[]>(row.uncovered_scope_json, []),
    uncoveredCriterionIds: json<string[]>(row.uncovered_criterion_ids_json, []),
    isSpeculation: row.is_speculation === 1,
    hasWriteConflicts: row.has_write_conflicts === 1,
    rejectedReason: row.rejected_reason ?? undefined,
    createdAt: row.created_at,
    reviewedAt: row.reviewed_at ?? undefined,
    reviewedByBotId: row.reviewed_by_bot_id ?? undefined,
  };
}

function mapEvidence(row: EvidenceRow): WorkEvidenceDto {
  return {
    evidenceId: row.evidence_id,
    workId: row.work_id,
    deliverableId: row.deliverable_id ?? undefined,
    executionId: row.execution_id ?? undefined,
    criterionIds: json<string[]>(row.criterion_ids_json, []),
    kind: row.kind,
    provenance: row.provenance,
    sourceRef: row.source_ref,
    sourceSha: row.source_sha ?? undefined,
    inputSnapshotId: row.input_snapshot_id,
    environment: row.environment ?? undefined,
    intentRevision: row.intent_revision,
    detail: row.detail ?? undefined,
    recordedAt: row.recorded_at,
  };
}

function mapBlocker(row: BlockerRow): WorkBlockerDto {
  return nonBlockingEffect({
    blockerId: row.blocker_id,
    workId: row.work_id,
    reportedByBotId: row.reported_by_bot_id ?? undefined,
    reason: row.reason,
    kind: row.kind,
    reasonCode: (row.reason_code ?? undefined) as WorkBlockerDto["reasonCode"],
    details: json<Record<string, unknown>>(row.details_json, {}),
    sourceRef: row.source_ref ?? undefined,
    subscriptionId: row.subscription_id ?? undefined,
    causalChainId: row.causal_chain_id ?? undefined,
    unknownExternalEffectRef: row.unknown_external_effect_ref ?? undefined,
    waitingForUserInput: row.waiting_for_user_input === 1,
    status: row.status,
    createdAt: row.created_at,
    clearedAt: row.cleared_at ?? undefined,
  });
}

function mapAdmission(row: AdmissionRow): WorkAdmissionDto {
  return {
    admissionId: row.admission_id,
    workId: row.work_id,
    bindingId: row.binding_id ?? undefined,
    operationId: row.operation_id,
    actionKind: row.action_kind,
    state: row.state,
    intentRevision: row.intent_revision,
    ownerEpoch: row.owner_epoch,
    admittedAt: row.admitted_at,
    settledAt: row.settled_at ?? undefined,
  };
}

function mapSubscription(row: SubscriptionRow): WorkSubscriptionDto {
  return {
    subscriptionId: row.subscription_id,
    workId: row.work_id,
    source: row.source,
    filter: json<Record<string, unknown>>(row.filter_json, {}),
    catchUpPolicy: row.catch_up_policy,
    maxMergeWaitMs: row.max_merge_wait_ms,
    maxQueueDepth: row.max_queue_depth,
    stopConditionText: row.stop_condition_text ?? undefined,
    timezone: row.timezone ?? undefined,
    cronExpression: row.cron_expression ?? undefined,
    nextWakeAt: row.next_wake_at ?? undefined,
    lastProcessedSourceVersion: row.last_processed_source_version ?? undefined,
    scheduleRevision: row.schedule_revision,
    configRevision: row.config_revision,
    sourceTarget: row.source_target ?? undefined,
    versionMode: (row.version_mode ?? "readback") as WorkSubscriptionDto["versionMode"],
    dstPolicy: (row.dst_policy ?? "first-valid") as WorkSubscriptionDto["dstPolicy"],
    maxBacklogEvents: row.max_backlog_events,
    maxBacklogBytes: row.max_backlog_bytes,
    lastCheckedAt: row.last_checked_at ?? undefined,
    stoppedReason: row.stopped_reason ?? undefined,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    stoppedAt: row.stopped_at ?? undefined,
  };
}

function mapInbox(row: InboxRow): WorkInboxEventDto {
  return {
    eventId: row.event_id,
    dedupeKey: row.dedupe_key,
    source: row.source,
    sourceEventId: row.source_event_id,
    eventType: row.event_type,
    workId: row.work_id,
    subscriptionId: row.subscription_id ?? undefined,
    intentRevision: row.intent_revision,
    stateVersion: row.state_version,
    ownerEpoch: row.owner_epoch,
    sourceVersion: row.source_version ?? undefined,
    status: row.status,
    payload: json<Record<string, unknown>>(row.payload_json, {}),
    causalEventId: row.causal_event_id ?? undefined,
    mergedCount: row.merged_count,
    receivedAt: row.received_at,
    processAfter: row.merge_deadline_at ?? undefined,
    batchId: row.batch_id ?? undefined,
    batchDeadlineAt: row.batch_deadline_at ?? undefined,
    frozenAt: row.frozen_at ?? undefined,
    frozenPayload: row.frozen_payload_json ? json<Record<string, unknown>>(row.frozen_payload_json, {}) : undefined,
    claimVersion: row.claim_version,
    targetKey: row.target_key ?? undefined,
    processReason: row.process_reason ?? undefined,
    processedAt: row.processed_at ?? undefined,
  };
}

function mapOutbox(row: OutboxRow): WorkOutboxInstructionDto {
  return {
    eventId: row.event_id,
    dedupeKey: row.dedupe_key,
    eventType: row.event_type,
    workId: row.work_id,
    bindingId: row.binding_id ?? undefined,
    intentRevision: row.intent_revision,
    stateVersion: row.state_version,
    ownerEpoch: row.owner_epoch,
    requestId: row.request_id,
    causalEventId: row.causal_event_id ?? undefined,
    deliveryStatus: row.delivery_status,
    attemptId: row.attempt_id ?? undefined,
    attemptCount: row.attempt_count,
    payload: json<Record<string, unknown>>(row.payload_json, {}),
    createdAt: row.created_at,
    deliveredAt: row.delivered_at ?? undefined,
  };
}

function mapNotification(row: NotificationRow): WorkNotificationDto {
  return {
    notificationId: row.notification_id,
    workId: row.work_id,
    semanticKey: row.semantic_key,
    kind: row.kind,
    title: row.title,
    body: row.body ?? undefined,
    stateVersion: row.state_version,
    intentRevision: row.intent_revision,
    delivery: row.delivery,
    channel: row.channel ?? undefined,
    idempotencyKey: row.idempotency_key ?? undefined,
    attemptCount: row.attempt_count,
    externalReceipt: row.external_receipt ?? undefined,
    cardKey: row.card_key ?? undefined,
    effectKey: row.effect_key ?? undefined,
    targetKey: row.target_key ?? undefined,
    readAt: row.read_at ?? undefined,
    createdAt: row.created_at,
    sentAt: row.sent_at ?? undefined,
  };
}

export function newId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}

/** Ignore only module-owned quota blocks, preserving their original audit rows.
 * A matching-looking blocker with an external-effect reference is still enforced.
 */
function isRetiredQuotaBlocker(row: BlockerRow): boolean {
  if (row.kind !== "operational" || row.unknown_external_effect_ref) return false;
  return (row.blocker_id === `budget:exhausted:${row.work_id}` || row.blocker_id === "causal:budget-exhausted") && row.reason_code === "budget-exhausted"
    || row.blocker_id === `budget:receipt-conflict:${row.work_id}` && row.reason_code === "budget-reconciliation-conflict"
    || row.blocker_id.startsWith("usage:") && row.reason === "原生用量尚未完整返回，保留原预算预留待核对";
}

function readAuthorization(raw: string): WorkAuthorizationDto {
  const value = json<WorkAuthorizationDto & { budgetLimitTokens?: unknown }>(raw, {
    allowedScopes: [], targetWhitelist: [], allowGitBranchOrWorktree: false, allowRedelegation: false,
  });
  const { budgetLimitTokens: _retired, ...authorization } = value;
  return authorization;
}
