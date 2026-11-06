import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  WorkAdmissionDto,
  WorkBlockerDto,
  WorkBudgetDto,
  WorkBudgetReservationDto,
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
  state_version: number;
  budget_json: string;
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
}

export class WorkRepository {
  constructor(private readonly db: Database.Database) {}

  // ------------------------------------------------------------------ works

  insertWork(work: WorkDto): void {
    this.db.prepare(`INSERT INTO works (
      work_id,user_id,project_id,workspace_path,source_message_id,legacy_task_id,
      owner_bot_id,owner_epoch,intent_revision,source_version,title,goal_description,
      constraints_json,criteria_json,authorization_json,active_intent_snapshot_id,
      input_snapshot_id,goal_sources_json,mode,lifecycle,pending_conclusion,cancel_requested_at,
      closure_conclusion,closure_summary,accepted_deliverable_ids_json,active_execution_ids_json,
      progress_summary,watch_rule_json,state_version,budget_json,created_by,created_at,updated_at,
      closed_at,close_operation_id
    ) VALUES (
      @workId,@userId,@projectId,@workspacePath,@sourceMessageId,@legacyTaskId,
      @ownerBotId,@ownerEpoch,@intentRevision,@sourceVersion,@title,@goalDescription,
      @constraintsJson,@criteriaJson,@authorizationJson,@activeIntentSnapshotId,
      @inputSnapshotId,@goalSourcesJson,@mode,@lifecycle,@pendingConclusion,@cancelRequestedAt,
      @closureConclusion,@closureSummary,@acceptedDeliverableIdsJson,@activeExecutionIdsJson,
      @progressSummary,@watchRuleJson,@stateVersion,@budgetJson,@createdBy,@createdAt,@updatedAt,
      @closedAt,@closeOperationId
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
      progress_summary=@progressSummary, watch_rule_json=@watchRuleJson, state_version=@stateVersion,
      budget_json=@budgetJson, updated_at=@updatedAt, closed_at=@closedAt, close_operation_id=@closeOperationId
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
      stateVersion: work.stateVersion,
      budgetJson: jsonText(work.budget),
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
      authorization: json<WorkAuthorizationDto>(row.authorization_json, {
        allowedScopes: [], targetWhitelist: [], allowGitBranchOrWorktree: false, allowRedelegation: false,
      }),
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
      stateVersion: row.state_version,
      budget: json<WorkBudgetDto>(row.budget_json, {
        windowId: `win-${row.work_id}-1`, maxTokens: 0, usedTokens: 0, reservedTokens: 0,
        unknownUsageCount: 0, windowStartAt: row.created_at, allowNextWindow: false,
      }),
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

  // ----------------------------------------------------------- participants

  executionInput(binding: WorkExecutionBindingDto): string {
    const row = this.db.prepare(`SELECT title,goal_description,constraints_json,criteria_json
      FROM work_intent_snapshots WHERE work_id=? AND intent_revision=? AND input_snapshot_id=?
      ORDER BY source_version DESC LIMIT 1`).get(binding.workId, binding.intentRevision, binding.inputSnapshotId) as
      { title: string; goal_description: string | null; constraints_json: string; criteria_json: string } | undefined;
    if (!row) throw new Error("执行缺少持久化的要求与输入快照");
    return JSON.stringify({
      workId: binding.workId, intentRevision: binding.intentRevision, inputSnapshotId: binding.inputSnapshotId,
      title: row.title, description: row.goal_description, constraints: json<string[]>(row.constraints_json, []),
      criteria: json<WorkDto["criteria"]>(row.criteria_json, []), delegatedScope: binding.delegatedScope,
      instructions: "按上述持久要求执行。只提交成果、证据和未覆盖范围，不自行宣布整个 Work 已验收。",
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
      status,attempt_id,submission_receipt,settlement_note,admitted_at,submitted_at,invalidated_at,settled_at
    ) VALUES (@bindingId,@workId,@operationId,@botId,@taskId,@durableStoreKey,@conversationId,@intentRevision,
      @ownerEpoch,@inputSnapshotId,@expertSnapshotJson,@delegatedScopeJson,@workspaceBinding,
      @status,@attemptId,@submissionReceipt,@settlementNote,@admittedAt,@submittedAt,@invalidatedAt,@settledAt)`).run({
      ...binding,
      attemptId: binding.attemptId ?? null,
      submissionReceipt: binding.submissionReceipt ?? null,
      settlementNote: binding.settlementNote ?? null,
      submittedAt: binding.submittedAt ?? null,
      invalidatedAt: binding.invalidatedAt ?? null,
      settledAt: binding.settledAt ?? null,
      expertSnapshotJson: jsonText(binding.expertSnapshot),
      delegatedScopeJson: jsonText(binding.delegatedScope),
    });
  }

  updateBinding(binding: WorkExecutionBindingDto): void {
    this.db.prepare(`UPDATE work_execution_bindings SET status=@status, attempt_id=@attemptId,
      submission_receipt=@submissionReceipt, settlement_note=@settlementNote, submitted_at=@submittedAt,
      invalidated_at=@invalidatedAt, settled_at=@settledAt WHERE binding_id=@bindingId`).run({
      bindingId: binding.bindingId,
      status: binding.status,
      attemptId: binding.attemptId ?? null,
      submissionReceipt: binding.submissionReceipt ?? null,
      settlementNote: binding.settlementNote ?? null,
      submittedAt: binding.submittedAt ?? null,
      invalidatedAt: binding.invalidatedAt ?? null,
      settledAt: binding.settledAt ?? null,
    });
  }

  getBinding(bindingId: string): WorkExecutionBindingDto | undefined {
    const row = this.db.prepare("SELECT * FROM work_execution_bindings WHERE binding_id=?").get(bindingId) as BindingRow | undefined;
    return row ? mapBinding(row) : undefined;
  }

  bindingForTask(taskId: string): WorkExecutionBindingDto | undefined {
    const row = this.db.prepare("SELECT * FROM work_execution_bindings WHERE task_id=? ORDER BY admitted_at DESC LIMIT 1")
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

  supersedeStaleDeliverables(workId: string, intentRevision: number): void {
    this.db.prepare("UPDATE work_deliverables SET status='superseded' WHERE work_id=? AND status='proposed' AND intent_revision < ?")
      .run(workId, intentRevision);
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
    this.db.prepare(`INSERT INTO work_blockers (
      blocker_id,work_id,reported_by_bot_id,reason,kind,unknown_external_effect_ref,
      waiting_for_user_input,status,created_at,cleared_at
    ) VALUES (@blockerId,@workId,@reportedByBotId,@reason,@kind,@unknownExternalEffectRef,
      @waitingForUserInput,@status,@createdAt,@clearedAt)`).run({
      ...blocker,
      reportedByBotId: blocker.reportedByBotId ?? null,
      unknownExternalEffectRef: blocker.unknownExternalEffectRef ?? null,
      waitingForUserInput: blocker.waitingForUserInput ? 1 : 0,
      clearedAt: blocker.clearedAt ?? null,
    });
  }

  clearBlocker(blockerId: string, workId: string, now: number): void {
    this.db.prepare("UPDATE work_blockers SET status='cleared', cleared_at=? WHERE blocker_id=? AND work_id=?")
      .run(now, blockerId, workId);
  }

  getBlocker(blockerId: string): WorkBlockerDto | undefined {
    const row = this.db.prepare("SELECT * FROM work_blockers WHERE blocker_id=?").get(blockerId) as BlockerRow | undefined;
    return row ? mapBlocker(row) : undefined;
  }

  listBlockers(workId: string): WorkBlockerDto[] {
    return (this.db.prepare("SELECT * FROM work_blockers WHERE work_id=? ORDER BY created_at ASC")
      .all(workId) as BlockerRow[]).map(mapBlocker);
  }

  listOpenBlockers(workId: string): WorkBlockerDto[] {
    return this.listBlockers(workId).filter((blocker) => blocker.status === "open");
  }

  // ------------------------------------------------------------- subscriptions

  insertSubscription(subscription: WorkSubscriptionDto): void {
    this.db.prepare(`INSERT INTO work_subscriptions (
      subscription_id,work_id,source,filter_json,catch_up_policy,max_merge_wait_ms,max_queue_depth,
      stop_condition_text,timezone,cron_expression,next_wake_at,last_processed_source_version,
      created_at,updated_at,stopped_at
    ) VALUES (@subscriptionId,@workId,@source,@filterJson,@catchUpPolicy,@maxMergeWaitMs,@maxQueueDepth,
      @stopConditionText,@timezone,@cronExpression,@nextWakeAt,@lastProcessedSourceVersion,
      @createdAt,@updatedAt,@stoppedAt)`).run({
      ...subscription,
      filterJson: jsonText(subscription.filter),
      stopConditionText: subscription.stopConditionText ?? null,
      timezone: subscription.timezone ?? null,
      cronExpression: subscription.cronExpression ?? null,
      nextWakeAt: subscription.nextWakeAt ?? null,
      lastProcessedSourceVersion: subscription.lastProcessedSourceVersion ?? null,
      stoppedAt: subscription.stoppedAt ?? null,
    });
  }

  updateSubscription(subscription: WorkSubscriptionDto): void {
    this.db.prepare(`UPDATE work_subscriptions SET filter_json=@filterJson, catch_up_policy=@catchUpPolicy,
      max_merge_wait_ms=@maxMergeWaitMs, max_queue_depth=@maxQueueDepth, stop_condition_text=@stopConditionText,
      timezone=@timezone, cron_expression=@cronExpression, next_wake_at=@nextWakeAt,
      last_processed_source_version=@lastProcessedSourceVersion, updated_at=@updatedAt, stopped_at=@stoppedAt
      WHERE subscription_id=@subscriptionId`).run({
      ...subscription,
      filterJson: jsonText(subscription.filter),
      stopConditionText: subscription.stopConditionText ?? null,
      timezone: subscription.timezone ?? null,
      cronExpression: subscription.cronExpression ?? null,
      nextWakeAt: subscription.nextWakeAt ?? null,
      lastProcessedSourceVersion: subscription.lastProcessedSourceVersion ?? null,
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
  }): boolean {
    const result = this.db.prepare(`INSERT OR IGNORE INTO work_source_events
      (source,source_event_id,event_type,source_version,causal_event_id,payload_json,received_at)
      VALUES (?,?,?,?,?,?,?)`).run(
      event.source, event.sourceEventId, event.eventType, event.sourceVersion ?? null,
      event.causalEventId ?? null, jsonText(event.payload), event.receivedAt,
    );
    return result.changes > 0;
  }

  insertInbox(event: WorkInboxEventDto): boolean {
    const result = this.db.prepare(`INSERT OR IGNORE INTO work_events_inbox (
      event_id,dedupe_key,source,source_event_id,event_type,work_id,subscription_id,intent_revision,
      state_version,owner_epoch,source_version,causal_event_id,payload_json,status,merged_count,
      merge_deadline_at,received_at,processed_at
    ) VALUES (@eventId,@dedupeKey,@source,@sourceEventId,@eventType,@workId,@subscriptionId,@intentRevision,
      @stateVersion,@ownerEpoch,@sourceVersion,@causalEventId,@payloadJson,@status,@mergedCount,
      @mergeDeadlineAt,@receivedAt,@processedAt)`).run({
      ...event,
      subscriptionId: event.subscriptionId ?? null,
      sourceVersion: event.sourceVersion ?? null,
      payloadJson: jsonText(event.payload),
      mergeDeadlineAt: event.processAfter ?? null,
      processedAt: event.processedAt ?? null,
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

  // ----------------------------------------------------------------- budget

  insertReservation(reservation: WorkBudgetReservationDto): void {
    this.db.prepare(`INSERT INTO work_budget_reservations
      (reservation_id,work_id,window_id,tokens,state,created_at,settled_at)
      VALUES (@reservationId,@workId,@windowId,@tokens,@state,@createdAt,@settledAt)`).run({
      ...reservation,
      settledAt: reservation.settledAt ?? null,
    });
  }

  listReservations(workId: string): WorkBudgetReservationDto[] {
    return (this.db.prepare("SELECT * FROM work_budget_reservations WHERE work_id=? ORDER BY created_at ASC")
      .all(workId) as Array<{
        reservation_id: string; work_id: string; window_id: string; tokens: number;
        state: WorkBudgetReservationDto["state"]; created_at: number; settled_at: number | null;
      }>).map((row) => ({
        reservationId: row.reservation_id,
        workId: row.work_id,
        windowId: row.window_id,
        tokens: row.tokens,
        state: row.state,
        createdAt: row.created_at,
        settledAt: row.settled_at ?? undefined,
      }));
  }

  getReservation(reservationId: string): WorkBudgetReservationDto | undefined {
    return this.listReservationsById(reservationId)[0];
  }

  private listReservationsById(reservationId: string): WorkBudgetReservationDto[] {
    const row = this.db.prepare("SELECT * FROM work_budget_reservations WHERE reservation_id=?")
      .get(reservationId) as { reservation_id: string; work_id: string; window_id: string; tokens: number;
        state: WorkBudgetReservationDto["state"]; created_at: number; settled_at: number | null } | undefined;
    if (!row) return [];
    return [{
      reservationId: row.reservation_id, workId: row.work_id, windowId: row.window_id, tokens: row.tokens,
      state: row.state, createdAt: row.created_at, settledAt: row.settled_at ?? undefined,
    }];
  }

  updateReservation(reservationId: string, state: WorkBudgetReservationDto["state"], now: number): void {
    this.db.prepare("UPDATE work_budget_reservations SET state=?, settled_at=? WHERE reservation_id=?")
      .run(state, now, reservationId);
  }

  // ---------------------------------------------------------- notifications

  insertNotification(notification: WorkNotificationDto): boolean {
    const result = this.db.prepare(`INSERT OR IGNORE INTO work_notifications (
      notification_id,work_id,semantic_key,kind,title,body,state_version,intent_revision,delivery,
      channel,idempotency_key,attempt_count,external_receipt,read_at,created_at,sent_at
    ) VALUES (@notificationId,@workId,@semanticKey,@kind,@title,@body,@stateVersion,@intentRevision,@delivery,
      @channel,@idempotencyKey,@attemptCount,@externalReceipt,@readAt,@createdAt,@sentAt)`).run({
      ...notification,
      body: notification.body ?? null,
      channel: notification.channel ?? null,
      idempotencyKey: notification.idempotencyKey ?? null,
      externalReceipt: notification.externalReceipt ?? null,
      readAt: notification.readAt ?? null,
      sentAt: notification.sentAt ?? null,
    });
    return result.changes > 0;
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
    this.db.prepare(`UPDATE work_notifications SET delivery='failed',
      body=COALESCE(body,'') || '（已被更新的要求或输入取代）'
      WHERE work_id=? AND kind='result' AND delivery='pending' AND (intent_revision < ? OR EXISTS (
        SELECT 1 FROM work_deliverables d WHERE d.work_id=work_notifications.work_id
        AND work_notifications.notification_id='notification-' || d.work_id || '-' || d.deliverable_id
        AND d.input_snapshot_id != ?))`)
      .run(workId, intentRevision, inputSnapshotId);
  }

  cancelPendingResultNotifications(workId: string): void {
    this.db.prepare(`UPDATE work_notifications SET delivery='failed', body=COALESCE(body,'') || '（事项已请求取消，停止发送）'
      WHERE work_id=? AND kind='result' AND delivery='pending'`).run(workId);
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
  return {
    blockerId: row.blocker_id,
    workId: row.work_id,
    reportedByBotId: row.reported_by_bot_id ?? undefined,
    reason: row.reason,
    kind: row.kind,
    unknownExternalEffectRef: row.unknown_external_effect_ref ?? undefined,
    waitingForUserInput: row.waiting_for_user_input === 1,
    status: row.status,
    createdAt: row.created_at,
    clearedAt: row.cleared_at ?? undefined,
  };
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
    readAt: row.read_at ?? undefined,
    createdAt: row.created_at,
    sentAt: row.sent_at ?? undefined,
  };
}

export function newId(prefix: string): string {
  return `${prefix}-${randomUUID()}`;
}
