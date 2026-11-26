import { parseWatchObservation, CONTINUOUS_WATCH_OBSERVATION_INSTRUCTIONS, WATCH_COMPARISON_INSTRUCTIONS, WATCH_OBSERVATION_INSTRUCTIONS } from "./WorkWatchObservation";
import { WorkExecutionMetricsStore } from "./WorkExecutionMetrics";
import { workDeliveryContext } from "./WorkDeliveryContext";
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
import { WORK_FILE_DELIVERY_INSTRUCTIONS } from "./WorkFileDeliveryInstructions";
import { enqueueWorkOp, overlayFindAll, overlayHasTable, overlayMutate, overlayReadOne, overlaySet, requiresWorkRustWrites } from "./WorkDomainRuntime";
import { z } from "zod";

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
  private readonly metrics: WorkExecutionMetricsStore;

  constructor(private readonly db: Database.Database) {
    this.metrics = new WorkExecutionMetricsStore(db);
    if (!db.readonly) {
      db.exec(`CREATE TABLE IF NOT EXISTS conversation_goal_sources (
        work_id TEXT PRIMARY KEY REFERENCES works(work_id) ON DELETE CASCADE,
        source_json TEXT NOT NULL CHECK(json_valid(source_json))
      )`);
    }
    // Older current-version files retain their inert quota history. Their required
    // JSON column has no default; supply an empty tombstone only for new rows.
    // Do not bump the schema version or rewrite existing history to remove a module.
    this.legacyWorkInsert = (db.prepare("PRAGMA table_info(works)").all() as Array<{ name: string }>)
      .some(column => column.name === "budget_json");
  }

  private workRowOf(work: WorkDto): WorkRow & Record<string, unknown> {
    return {
      work_id: work.workId,
      user_id: work.userId,
      project_id: work.projectId ?? null,
      workspace_path: work.workspacePath ?? null,
      source_message_id: work.sourceMessageId ?? null,
      legacy_task_id: work.legacyTaskId ?? null,
      owner_bot_id: work.ownerBotId,
      owner_epoch: work.ownerEpoch,
      intent_revision: work.intentRevision,
      source_version: work.sourceVersion,
      title: work.title,
      goal_description: work.goalDescription ?? null,
      constraints_json: jsonText(work.constraints),
      criteria_json: jsonText(work.criteria),
      authorization_json: jsonText(work.authorization),
      active_intent_snapshot_id: work.activeIntentSnapshotId,
      input_snapshot_id: work.inputSnapshotId,
      goal_sources_json: jsonText(work.goalSources),
      mode: work.mode,
      lifecycle: work.lifecycle,
      pending_conclusion: work.pendingConclusion ?? null,
      cancel_requested_at: work.cancelRequestedAt ?? null,
      closure_conclusion: work.closureConclusion ?? null,
      closure_summary: work.closureSummary ?? null,
      accepted_deliverable_ids_json: jsonText(work.acceptedDeliverableIds),
      active_execution_ids_json: jsonText(work.activeExecutionIds),
      progress_summary: work.progressSummary ?? null,
      watch_rule_json: work.watchRule ? jsonText(work.watchRule) : null,
      deadline_at: work.deadlineAt ?? null,
      deadline_revision: work.deadlineRevision ?? 1,
      deadline_set_at: work.deadlineSetAt ?? null,
      causal_policy_json: jsonText(work.causalPolicy ?? {}),
      state_version: work.stateVersion,
      created_by: work.createdBy,
      created_at: work.createdAt,
      updated_at: work.updatedAt,
      closed_at: work.closedAt ?? null,
      close_operation_id: work.closeOperationId ?? null,
    };
  }

  // ------------------------------------------------------------------ works

  insertWork(work: WorkDto): void {
    const p = this.workParams(work);
    if (requiresWorkRustWrites(this.db)) {
      overlaySet(this.db, "works", work.workId, this.workRowOf(work));
      enqueueWorkOp(this.db, { op: "workInsert", ...p });
      return;
    }
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
    )`).run(p);
  }

  updateWork(work: WorkDto): void {
    const p = this.workParams(work);
    if (requiresWorkRustWrites(this.db)) {
      overlaySet(this.db, "works", work.workId, this.workRowOf(work));
      const { userId: _userId, createdBy: _createdBy, createdAt: _createdAt, ...rest } = p;
      enqueueWorkOp(this.db, { op: "workUpdate", ...rest });
      return;
    }
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
      WHERE work_id=@workId`).run(p);
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
    const row = overlayReadOne(this.db, "works", workId, () =>
      this.db.prepare("SELECT * FROM works WHERE work_id=?").get(workId) as (WorkRow & Record<string, unknown>) | undefined);
    return row ? this.hydrate(row as WorkRow) : undefined;
  }

  listWorks(userId: string, options: { includeClosed?: boolean } = {}): WorkDto[] {
    const dbRows = (options.includeClosed
      ? this.db.prepare("SELECT * FROM works WHERE user_id=? ORDER BY updated_at DESC").all(userId)
      : this.db.prepare("SELECT * FROM works WHERE user_id=? AND lifecycle != 'closed' ORDER BY updated_at DESC").all(userId)) as Array<WorkRow & Record<string, unknown>>;
    const rows = overlayFindAll(this.db, "works", dbRows, r => String(r.work_id),
      r => r.user_id === userId && (Boolean(options.includeClosed) || r.lifecycle !== "closed"),
      (a, b) => Number(b.updated_at) - Number(a.updated_at));
    return rows.map((row) => this.hydrate(row as WorkRow));
  }

  listWorksByOwner(botId: string, options: { includeClosed?: boolean } = {}): WorkDto[] {
    const dbRows = (options.includeClosed
      ? this.db.prepare("SELECT * FROM works WHERE owner_bot_id=? ORDER BY updated_at DESC").all(botId)
      : this.db.prepare("SELECT * FROM works WHERE owner_bot_id=? AND lifecycle != 'closed' ORDER BY updated_at DESC").all(botId)) as Array<WorkRow & Record<string, unknown>>;
    const rows = overlayFindAll(this.db, "works", dbRows, r => String(r.work_id),
      r => r.owner_bot_id === botId && (Boolean(options.includeClosed) || r.lifecycle !== "closed"),
      (a, b) => Number(b.updated_at) - Number(a.updated_at));
    return rows.map((row) => this.hydrate(row as WorkRow));
  }

  saveGoalSource(workId: string, source: import("../../../shared/conversation-goal").ConversationGoalSourceDto): void {
    const sourceJson = JSON.stringify(source);
    if (requiresWorkRustWrites(this.db)) {
      overlaySet(this.db, "conversation_goal_sources", workId, { work_id: workId, source_json: sourceJson });
      enqueueWorkOp(this.db, { op: "workGoalSourceInsert", workId, sourceJson });
      return;
    }
    this.db.prepare("INSERT INTO conversation_goal_sources VALUES(?,?)").run(workId, sourceJson);
  }

  getGoalSource(workId: string): import("../../../shared/conversation-goal").ConversationGoalSourceDto | undefined {
    const row = overlayReadOne<{ source_json: string }>(this.db, "conversation_goal_sources", workId, () =>
      this.db.prepare("SELECT work_id, source_json FROM conversation_goal_sources WHERE work_id=?").get(workId) as { work_id: string; source_json: string } | undefined);
    return row ? JSON.parse(row.source_json) : undefined;
  }

  findWorkByGoalSource(userId: string, source: import("../../../shared/conversation-goal").ConversationGoalSourceDto): WorkDto | undefined {
    const key = source.entryId ?? source.messageId;
    const dbSources = this.db.prepare(`SELECT s.work_id, s.source_json FROM conversation_goal_sources s
      INNER JOIN works w ON w.work_id = s.work_id
      WHERE w.user_id = ? AND json_extract(s.source_json, '$.taskId') = ?
        AND json_extract(s.source_json, '$.conversationId') = ?
        AND coalesce(json_extract(s.source_json, '$.entryId'), json_extract(s.source_json, '$.messageId')) = ?`)
      .all(userId, source.taskId, source.conversationId, key) as Array<{ work_id: string; source_json: string }>;
    const matched = overlayFindAll(this.db, "conversation_goal_sources", dbSources, r => String(r.work_id), r => {
      const parsed = JSON.parse(String(r.source_json)) as { taskId?: string; conversationId?: string; entryId?: string; messageId?: string };
      return parsed.taskId === source.taskId && parsed.conversationId === source.conversationId && (parsed.entryId ?? parsed.messageId) === key;
    });
    for (const s of matched) {
      const work = this.getWork(String(s.work_id));
      if (work && work.userId === userId) return work;
    }
    return undefined;
  }

  listWorksByTaskForUser(taskId: string, userId: string): WorkDto[] {
    const dbLinks = this.db.prepare("SELECT * FROM work_conversations WHERE conversation_id=?").all(taskId) as Array<Record<string, unknown>>;
    const workIds = new Set(overlayFindAll(this.db, "work_conversations", dbLinks, r => `${r.work_id}\0${r.conversation_id}`,
      r => r.conversation_id === taskId).map(r => String(r.work_id)));
    const results: WorkDto[] = [];
    for (const id of workIds) {
      const w = this.getWork(id);
      if (w && w.userId === userId) results.push(w);
    }
    results.sort((a, b) => b.createdAt - a.createdAt || a.workId.localeCompare(b.workId));
    return results;
  }

  getWorkByTaskForUser(workId: string, taskId: string, userId: string): WorkDto | undefined {
    const link = overlayReadOne(this.db, "work_conversations", `${workId}\0${taskId}`, () =>
      this.db.prepare("SELECT * FROM work_conversations WHERE work_id=? AND conversation_id=?").get(workId, taskId) as Record<string, unknown> | undefined);
    if (!link) return undefined;
    const work = this.getWork(workId);
    return work && work.userId === userId ? work : undefined;
  }

  listLiveWorksByTask(taskId: string): WorkDto[] {
    const dbLinks = this.db.prepare("SELECT * FROM work_conversations WHERE conversation_id=?").all(taskId) as Array<Record<string, unknown>>;
    const workIds = new Set(overlayFindAll(this.db, "work_conversations", dbLinks, r => `${r.work_id}\0${r.conversation_id}`,
      r => r.conversation_id === taskId).map(r => String(r.work_id)));
    const results: WorkDto[] = [];
    for (const id of workIds) {
      const w = this.getWork(id);
      if (w && w.lifecycle !== "closed") results.push(w);
    }
    results.sort((a, b) => b.updatedAt - a.updatedAt);
    return results;
  }

  listConversationIds(workId: string): string[] {
    const dbRows = this.db.prepare("SELECT * FROM work_conversations WHERE work_id=? ORDER BY last_referenced_at DESC")
      .all(workId) as Array<Record<string, unknown>>;
    return overlayFindAll(this.db, "work_conversations", dbRows, r => `${r.work_id}\0${r.conversation_id}`,
      r => r.work_id === workId, (a, b) => Number(b.last_referenced_at) - Number(a.last_referenced_at))
      .map((row) => String(row.conversation_id));
  }

  linkConversation(workId: string, conversationId: string, channelType = "desktop", now = Date.now()): void {
    if (requiresWorkRustWrites(this.db)) {
      overlayMutate(this.db, "work_conversations", `${workId}\0${conversationId}`, () =>
        this.db.prepare("SELECT * FROM work_conversations WHERE work_id=? AND conversation_id=?").get(workId, conversationId) as Record<string, unknown> | undefined,
      cur => ({ work_id: workId, conversation_id: conversationId, channel_type: cur ? cur.channel_type : channelType, last_referenced_at: now }));
      enqueueWorkOp(this.db, { op: "workConversationLink", workId, conversationId, channelType, lastReferencedAt: now });
      return;
    }
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
    const params = {
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
    };
    if (requiresWorkRustWrites(this.db)) {
      overlaySet(this.db, "work_intent_snapshots", snapshot.snapshotId, {
        snapshot_id: params.snapshotId, work_id: params.workId, intent_revision: params.intentRevision,
        source_version: params.sourceVersion, title: params.title, goal_description: params.goalDescription,
        constraints_json: params.constraintsJson, criteria_json: params.criteriaJson,
        authorization_json: params.authorizationJson, expert_snapshot_json: params.expertSnapshotJson,
        input_snapshot_id: params.inputSnapshotId, goal_sources_json: params.goalSourcesJson,
        created_by: params.createdBy, source_message_id: params.sourceMessageId, created_at: params.createdAt,
      });
      enqueueWorkOp(this.db, { op: "workIntentSnapshotInsert", ...params });
      return;
    }
    this.db.prepare(`INSERT INTO work_intent_snapshots (
      snapshot_id,work_id,intent_revision,source_version,title,goal_description,constraints_json,
      criteria_json,authorization_json,expert_snapshot_json,input_snapshot_id,goal_sources_json,
      created_by,source_message_id,created_at
    ) VALUES (@snapshotId,@workId,@intentRevision,@sourceVersion,@title,@goalDescription,@constraintsJson,
      @criteriaJson,@authorizationJson,@expertSnapshotJson,@inputSnapshotId,@goalSourcesJson,
      @createdBy,@sourceMessageId,@createdAt)`).run(params);
  }

  /** Requirement revisions for the expanded diagnostics view, newest first. */
  listIntentSnapshots(workId: string): Array<{ intentRevision: number; inputSnapshotId: string; sourceVersion: number; createdAt: number }> {
    const dbRows = this.db.prepare(`SELECT snapshot_id,work_id,intent_revision,input_snapshot_id,source_version,created_at
      FROM work_intent_snapshots WHERE work_id=? ORDER BY intent_revision DESC,source_version DESC`)
      .all(workId) as Array<Record<string, unknown>>;
    return overlayFindAll(this.db, "work_intent_snapshots", dbRows, r => String(r.snapshot_id), r => r.work_id === workId,
      (a, b) => Number(b.intent_revision) - Number(a.intent_revision) || Number(b.source_version) - Number(a.source_version))
      .map(row => ({ intentRevision: Number(row.intent_revision), inputSnapshotId: String(row.input_snapshot_id),
        sourceVersion: Number(row.source_version), createdAt: Number(row.created_at) }));
  }

  // ----------------------------------------------------------- participants

  captureReportContext(binding: WorkExecutionBindingDto, input: string): void { captureTeamReportContext(this.db, binding, input); }
  reportContext(binding: WorkExecutionBindingDto): unknown { return capturedTeamReportContext(this.db, binding); }

  attachmentInput(binding: WorkExecutionBindingDto): string {
    const row = overlayReadOne<{ attachments_json: string }>(this.db, "bot_work_attachments", `${binding.workId}\0${binding.inputSnapshotId}`, () =>
      this.db.prepare("SELECT attachments_json FROM bot_work_attachments WHERE work_id=? AND input_snapshot_id=?")
        .get(binding.workId, binding.inputSnapshotId) as { attachments_json: string } | undefined);
    if (!row) return "";
    const attachments = botAttachmentSchema.array().parse(JSON.parse(row.attachments_json));
    return `\n\n用户附件（此执行输入快照的宿主持久副本；读取实际文件，不要仅凭文件名推断内容）：\n${attachments.map(item => JSON.stringify(item)).join("\n")}`;
  }

  /** Single-Work detail read using the same host-owned provenance as execution. */
  originalDelegation(work: WorkDto): import("../../../shared/bot-work").WorkProjectionDto["originalDelegation"] {
    try {
      const input = botDelegationInput(this.db, work, work.sourceVersion);
      return { messages: input?.messages.map(({ messageId, text, intentRevision, sourceVersion }) =>
        ({ messageId, text, intentRevision, sourceVersion })) ?? [],
        context: input ? [...new Map([...input.dialogueContext, ...input.referencedContext].map(message => [message.messageId, message])).values()]
          .map(({ messageId, text, role }) => ({ messageId, text, role })) : [], descriptionOrigin: input?.definitionOrigins.description };
    } catch {
      // Missing receipts must not turn an assistant plan into a claimed user quote.
      return { messages: [], unavailable: true };
    }
  }

  executionInput(binding: WorkExecutionBindingDto): string {
    const dbSnapshots = this.db.prepare(`SELECT snapshot_id,work_id,intent_revision,input_snapshot_id,title,goal_description,constraints_json,criteria_json,source_version,created_by
      FROM work_intent_snapshots WHERE work_id=? AND intent_revision=? AND input_snapshot_id=?
      ORDER BY source_version DESC`).all(binding.workId, binding.intentRevision, binding.inputSnapshotId) as Array<Record<string, unknown>>;
    const row = overlayFindAll(this.db, "work_intent_snapshots", dbSnapshots, r => String(r.snapshot_id),
      r => r.work_id === binding.workId && r.intent_revision === binding.intentRevision && r.input_snapshot_id === binding.inputSnapshotId,
      (a, b) => Number(b.source_version) - Number(a.source_version))[0] as
      { title: string; goal_description: string | null; constraints_json: string; criteria_json: string;
        source_version: number; created_by: "user" | "bot" } | undefined;
    if (!row) throw new Error("执行缺少持久化的要求与输入快照");
    const userRequest = botDelegationInput(this.db, binding, row.source_version);
    const hasCollaborationContext = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='bot_collaboration_work_context'").get();
    const collaborationContext = hasCollaborationContext
      ? z.object({ context_json: z.string() }).optional().parse(
        overlayReadOne(this.db, "bot_collaboration_work_context", `${binding.workId}\0${binding.inputSnapshotId}`, () =>
          this.db.prepare("SELECT context_json FROM bot_collaboration_work_context WHERE work_id=? AND input_snapshot_id=?")
            .get(binding.workId, binding.inputSnapshotId) as Record<string, unknown> | undefined))
      : undefined;
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
    // A continuation inherits only its proven same-version source's trigger;
    // an active subscription alone never proves that an event has arrived.
    let triggerBinding: WorkExecutionBindingDto | undefined = binding;
    const seenTriggers=new Set<string>();
    const hasContinuationPlans=!!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_continuation_plans'").get();
    while(hasContinuationPlans && this.getWork(binding.workId)?.mode === "watch" && triggerBinding && !triggerBinding.inboxEventId && !seenTriggers.has(triggerBinding.bindingId)){
      seenTriggers.add(triggerBinding.bindingId);
      const dbReqs = this.db.prepare("SELECT * FROM work_dispatch_requests WHERE task_id=? AND work_id=?")
        .all(triggerBinding.taskId, binding.workId) as Array<Record<string, unknown>>;
      const req = overlayFindAll(this.db, "work_dispatch_requests", dbReqs, r => String(r.operation_id),
        r => r.task_id === triggerBinding!.taskId && r.work_id === binding.workId && r.state !== "cancelled")[0];
      const plan = req?.continuation_plan_id ? overlayReadOne(this.db, "work_continuation_plans", String(req.continuation_plan_id), () =>
        this.db.prepare("SELECT * FROM work_continuation_plans WHERE plan_id=?").get(String(req.continuation_plan_id)) as Record<string, unknown> | undefined) : undefined;
      const parent = plan && plan.state !== "cancelled" && plan.work_id === binding.workId && plan.intent_revision === binding.intentRevision
        && plan.input_snapshot_id === binding.inputSnapshotId && plan.owner_epoch === binding.ownerEpoch && plan.owner_bot_id === binding.botId
        ? { source_binding_id: String(plan.source_binding_id) } : undefined;
      const source=parent?this.getBinding(parent.source_binding_id):undefined;
      triggerBinding=source && !source.invalidatedAt && source.workId===binding.workId && source.intentRevision===binding.intentRevision
        && source.inputSnapshotId===binding.inputSnapshotId && source.ownerEpoch===binding.ownerEpoch ? source : undefined;
    }
    const triggerEvent=triggerBinding?.inboxEventId?this.getInbox(triggerBinding.inboxEventId):undefined;
    const sourceEvent=triggerEvent && triggerEvent.workId===binding.workId && triggerEvent.intentRevision===binding.intentRevision
      && triggerEvent.ownerEpoch===binding.ownerEpoch && triggerEvent.status!=='skipped' ? {
        source:triggerEvent.source,source_event_id:triggerEvent.sourceEventId,event_type:triggerEvent.eventType,
        source_version:triggerEvent.sourceVersion,payload_json:JSON.stringify(triggerEvent.frozenPayload??triggerEvent.payload),received_at:triggerEvent.receivedAt,
      } : undefined;
    const hasTeams = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_team_execution_history'").get();
    const team = hasTeams ? this.db.prepare("SELECT input_json FROM work_team_executions WHERE task_id=? AND work_id=? UNION ALL SELECT input_json FROM work_team_execution_history WHERE task_id=? AND work_id=? LIMIT 1")
      .get(binding.taskId, binding.workId, binding.taskId, binding.workId) as { input_json: string | null } | undefined : undefined;
    const previousReports = sourceEvent?.event_type === "work.tick" ? this.previousWatchReports(binding) : [];
    return JSON.stringify({
      ...(team?.input_json ? { teamAssignment: JSON.parse(team.input_json) } : {}),
      workId: binding.workId, intentRevision: binding.intentRevision, inputSnapshotId: binding.inputSnapshotId,
      hostDeliveryContext: workDeliveryContext(this.db, binding),
      ...(collaborationContext ? { collaborationContext: JSON.parse(collaborationContext.context_json) } : {}),
      ...(userRequest ? { userRequest, ...userDefinition, delegationPlan: { provenance: "assistant_generated", ...planDefinition } }
        : definition),
      delegatedScope: binding.delegatedScope,
      ...(this.getWork(binding.workId)?.mode === "watch" ? { watchLifetimeControl: this.getWork(binding.workId)?.watchRule?.requestedOutcome === "one_time" ? "这是用户指定未来执行的一次性目标，不是长期职责。现在触发后完成原请求，交付真实结果与产物，前台核对全部完成后结案；有缺项如实保留，不自造后续周期或等待。" : this.getWork(binding.workId)?.watchRule?.executionMode === "continuous" ? "按原始授权推进持续目标，先完成现在可行动的步骤，再交付实际结果、未完成步骤和证据。不要虚构等待时间，不因本轮回复结束宣称整个目标完成；后续由前台安排。不要重复已完成的外部动作。" : "你只执行本轮观察（团队成员也相同），交付实际结果和用户停止条件对应的证据；本轮回复结束后由前台自主判断持续委托是否应结束。不调用 conversation_goal_propose_complete，不请求用户确认结束，也不使用 automation_exec 修改或取消 Work 订阅。不要等待下一轮或尝试自行关闭长期委托。" } : {}),
      ...(this.getWork(binding.workId)?.mode === "watch" ? { watchArtifactContract: "用户指定了成品文件或附件时，必须回读并通过现有产物登记工具登记该指定文件的本轮真实快照，供前台核验和交付。额外写的报告或摘要不能替代指定成品，例如要求 benchmark.json 时不能只登记 benchmark-report.md。只登记实际存在且已核验的文件，不自行扫描或伪造快照；登记失败或目标缺失时如实报告缺项。只读观察只核验已有成果，不因此改写文件。" } : {}),
      ...(this.getWork(binding.workId)?.mode === "watch" && sourceEvent ? { watchExecutionStage: {
        stage:"triggered_execution",inboxEventId:triggerEvent!.eventId,triggerBindingId:triggerBinding!.bindingId,
        continuation:triggerBinding!.bindingId!==binding.bindingId,subscriptionId:triggerEvent!.subscriptionId,
        currentInputSnapshotId:binding.inputSnapshotId,
        instructions:"宿主已建立此事项的订阅或执行计划，并因下列真实事件派发当前轮；现在不是创建监听阶段。原文的建立监听、查询事件源、创建时不执行是已处理的受理设置，不要重做、不要另建automation/监听，也不要因执行器工具目录没有file源就声称宿主未接入。只处理本次触发的原任务：先实际读取目标并判断业务条件，事件信号或哈希不证明merged、成果或成功；来源失败必须如实报告。当前已有可处理事件，不重新等待下一事件来替代本轮。完成后交回宿主按既有订阅安排后续。续办仅补本轮未完成步骤，不重复已完成或未知外部效果。",
      } } : {}),
      ...(sourceEvent ? { sourceEvent: { source: sourceEvent.source, eventId: sourceEvent.source_event_id,
        eventType: sourceEvent.event_type, sourceVersion: sourceEvent.source_version ?? undefined,
        receivedAt: sourceEvent.received_at, payload: json<Record<string, unknown>>(sourceEvent.payload_json, {}) } } : {}),
      ...(sourceEvent?.event_type === "work.tick" ? { watchFollowUp: {
        readOnly: this.getWork(binding.workId)?.watchRule?.executionMode !== "continuous",
        ...(this.getWork(binding.workId)?.watchRule?.notificationMode === "changes_only" ? { observationContract: this.getWork(binding.workId)?.watchRule?.executionMode === "continuous" ? CONTINUOUS_WATCH_OBSERVATION_INSTRUCTIONS : WATCH_OBSERVATION_INSTRUCTIONS } : {}),
        watchRule: this.getWork(binding.workId)?.watchRule,
        previousReports: previousReports.map(r => ({ deliverableId: r.deliverableId, summary: r.summary.slice(0, 2000), createdAt: r.createdAt })),
        comparisonState: previousReports.length ? "unverified" : "no_baseline",
        instructions: this.getWork(binding.workId)?.watchRule?.executionMode === "continuous" ? "这是持续目标的可执行步骤，按原始授权推进，不要因没有nextWakeAt而等待。交付真实结果与剩余步骤，不重复已完成动作。" : "这是按用户时间表触发的一次只读检查。读取当前来源，和已有报告比较，汇报重要变化或明确缺口；不重跑原任务的修改、购买、发送等副作用。不自行循环等待下一次，完成本次后交还宿主调度。说明用户停止条件是否已满足，不把一次检查当成整个事项已完成。\n" + WATCH_COMPARISON_INSTRUCTIONS,
      } } : {}),
      ...(sourceEvent?.event_type === "deadline_expired" ? { deadlineFollowUp: {
        readOnly: true, deadlineRevision: json<Record<string, unknown>>(sourceEvent.payload_json, {}).deadlineRevision,
        deadlineAt: json<Record<string, unknown>>(sourceEvent.payload_json, {}).deadlineAt,
        instructions: "这是承诺到期的只读跟进。整理已有成果、未完成项和缺口，不重跑原业务副作用，不重复已确认的外部效果。",
      } } : {}),
      instructions: (userRequest ? BOT_DELEGATION_INSTRUCTIONS
        : "按上述持久要求执行。只提交成果、证据和未覆盖范围，不自行宣布整个 Work 已验收。") + "\n" + WORK_FILE_DELIVERY_INSTRUCTIONS,
    });
  }

  upsertParticipant(participant: WorkParticipantDto & { workId: string }): void {
    const delegatedScopeJson = jsonText(participant.delegatedScope);
    const expertSnapshotJson = jsonText(participant.expertSnapshot);
    if (requiresWorkRustWrites(this.db)) {
      overlayMutate(this.db, "work_participants", `${participant.workId}\0${participant.botId}`, () =>
        this.db.prepare("SELECT * FROM work_participants WHERE work_id=? AND bot_id=?").get(participant.workId, participant.botId) as Record<string, unknown> | undefined,
      cur => ({
        work_id: participant.workId, bot_id: participant.botId, role: participant.role,
        delegated_scope_json: delegatedScopeJson, expert_snapshot_json: expertSnapshotJson,
        added_at: cur ? Number(cur.added_at) : participant.addedAt,
      }));
      enqueueWorkOp(this.db, {
        op: "workParticipantUpsert", workId: participant.workId, botId: participant.botId,
        role: participant.role, delegatedScopeJson, expertSnapshotJson, addedAt: participant.addedAt,
      });
      return;
    }
    this.db.prepare(`INSERT INTO work_participants (work_id,bot_id,role,delegated_scope_json,expert_snapshot_json,added_at)
      VALUES (?,?,?,?,?,?)
      ON CONFLICT(work_id,bot_id) DO UPDATE SET
        role=excluded.role, delegated_scope_json=excluded.delegated_scope_json,
        expert_snapshot_json=excluded.expert_snapshot_json`)
      .run(participant.workId, participant.botId, participant.role,
        delegatedScopeJson, expertSnapshotJson, participant.addedAt);
  }

  getParticipant(workId: string, botId: string): WorkParticipantDto | undefined {
    return this.listParticipants(workId).find((participant) => participant.botId === botId);
  }

  listParticipants(workId: string): WorkParticipantDto[] {
    const dbRows = this.db.prepare("SELECT * FROM work_participants WHERE work_id=? ORDER BY added_at ASC")
      .all(workId) as Array<Record<string, unknown>>;
    const rows = overlayFindAll(this.db, "work_participants", dbRows, r => `${r.work_id}\0${r.bot_id}`,
      r => r.work_id === workId, (a, b) => Number(a.added_at) - Number(b.added_at)) as Array<{
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
    return overlayReadOne<ReceiptRow & Record<string, unknown>>(this.db, "work_operation_receipts", `${userId}\0${operationId}`, () =>
      this.db.prepare("SELECT * FROM work_operation_receipts WHERE user_id=? AND operation_id=?").get(userId, operationId) as (ReceiptRow & Record<string, unknown>) | undefined);
  }

  saveReceipt(params: {
    userId: string; operationId: string; workId?: string; operationType: string;
    payloadHash: string; workSnapshot: WorkDto; outboxEventId?: string; now: number;
    receiptMetadata?: import("./WorkControlTypes").WorkReceiptMetadata;
  }): void {
    const resultSnapshotJson = jsonText(params.receiptMetadata
      ? { ...params.workSnapshot, _controlResult: params.receiptMetadata } : params.workSnapshot);
    if (requiresWorkRustWrites(this.db)) {
      overlaySet(this.db, "work_operation_receipts", `${params.userId}\0${params.operationId}`, {
        user_id: params.userId, operation_id: params.operationId, work_id: params.workId ?? null,
        operation_type: params.operationType, payload_hash: params.payloadHash,
        result_snapshot_json: resultSnapshotJson, outbox_event_id: params.outboxEventId ?? null, created_at: params.now,
      });
      enqueueWorkOp(this.db, {
        op: "workReceiptInsert", userId: params.userId, operationId: params.operationId,
        workId: params.workId ?? null, operationType: params.operationType, payloadHash: params.payloadHash,
        resultSnapshotJson, outboxEventId: params.outboxEventId ?? null, createdAt: params.now,
      });
      return;
    }
    this.db.prepare(`INSERT INTO work_operation_receipts
      (user_id,operation_id,work_id,operation_type,payload_hash,result_snapshot_json,outbox_event_id,created_at)
      VALUES (?,?,?,?,?,?,?,?)`).run(
      params.userId, params.operationId, params.workId ?? null, params.operationType,
      params.payloadHash, resultSnapshotJson, params.outboxEventId ?? null, params.now,
    );
  }

  countReceiptsForUser(userId: string): number {
    if (overlayHasTable(this.db, "work_operation_receipts")) {
      const dbRows = this.db.prepare("SELECT user_id, operation_id FROM work_operation_receipts WHERE user_id=?")
        .all(userId) as Array<Record<string, unknown>>;
      return overlayFindAll(this.db, "work_operation_receipts", dbRows, r => `${r.user_id}\0${r.operation_id}`,
        r => r.user_id === userId).length;
    }
    return Number((this.db.prepare("SELECT COUNT(*) AS count FROM work_operation_receipts WHERE user_id=?")
      .get(userId) as { count: number }).count);
  }

  // ------------------------------------------------------ execution bindings

  insertBinding(binding: WorkExecutionBindingDto): void {
    const p = {
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
    };
    if (requiresWorkRustWrites(this.db)) {
      overlaySet(this.db, "work_execution_bindings", binding.bindingId, {
        binding_id: p.bindingId, work_id: p.workId, operation_id: p.operationId, bot_id: p.botId,
        task_id: p.taskId, durable_store_key: p.durableStoreKey, conversation_id: p.conversationId,
        intent_revision: p.intentRevision, owner_epoch: p.ownerEpoch, input_snapshot_id: p.inputSnapshotId,
        expert_snapshot_json: p.expertSnapshotJson, delegated_scope_json: p.delegatedScopeJson,
        workspace_binding: p.workspaceBinding, status: p.status, attempt_id: p.attemptId,
        submission_receipt: p.submissionReceipt, settlement_note: p.settlementNote,
        admitted_at: p.admittedAt, submitted_at: p.submittedAt, invalidated_at: p.invalidatedAt,
        settled_at: p.settledAt, inbox_event_id: p.inboxEventId,
      });
      enqueueWorkOp(this.db, {
        op: "workBindingInsert",
        bindingId: p.bindingId, workId: p.workId, operationId: p.operationId, botId: p.botId,
        taskId: p.taskId, durableStoreKey: p.durableStoreKey, conversationId: p.conversationId,
        intentRevision: p.intentRevision, ownerEpoch: p.ownerEpoch, inputSnapshotId: p.inputSnapshotId,
        expertSnapshotJson: p.expertSnapshotJson, delegatedScopeJson: p.delegatedScopeJson,
        workspaceBinding: p.workspaceBinding, status: p.status, attemptId: p.attemptId,
        submissionReceipt: p.submissionReceipt, settlementNote: p.settlementNote,
        admittedAt: p.admittedAt, submittedAt: p.submittedAt, invalidatedAt: p.invalidatedAt,
        settledAt: p.settledAt, inboxEventId: p.inboxEventId,
      });
      return;
    }
    this.db.prepare(`INSERT INTO work_execution_bindings (
      binding_id,work_id,operation_id,bot_id,task_id,durable_store_key,conversation_id,intent_revision,
      owner_epoch,input_snapshot_id,expert_snapshot_json,delegated_scope_json,workspace_binding,
      status,attempt_id,submission_receipt,settlement_note,admitted_at,submitted_at,invalidated_at,settled_at,inbox_event_id
    ) VALUES (@bindingId,@workId,@operationId,@botId,@taskId,@durableStoreKey,@conversationId,@intentRevision,
      @ownerEpoch,@inputSnapshotId,@expertSnapshotJson,@delegatedScopeJson,@workspaceBinding,
      @status,@attemptId,@submissionReceipt,@settlementNote,@admittedAt,@submittedAt,@invalidatedAt,@settledAt,@inboxEventId)`).run(p);
  }

  updateBinding(binding: WorkExecutionBindingDto): void {
    const p = {
      bindingId: binding.bindingId,
      status: binding.status,
      attemptId: binding.attemptId ?? null,
      submissionReceipt: binding.submissionReceipt ?? null,
      settlementNote: binding.settlementNote ?? null,
      submittedAt: binding.submittedAt ?? null,
      invalidatedAt: binding.invalidatedAt ?? null,
      settledAt: binding.settledAt ?? null,
      inboxEventId: binding.inboxEventId ?? null,
    };
    if (requiresWorkRustWrites(this.db)) {
      overlayMutate(this.db, "work_execution_bindings", binding.bindingId, () =>
        this.db.prepare("SELECT * FROM work_execution_bindings WHERE binding_id=?").get(binding.bindingId) as Record<string, unknown> | undefined,
      cur => cur ? {
        ...cur, status: p.status, attempt_id: p.attemptId, submission_receipt: p.submissionReceipt,
        settlement_note: p.settlementNote, submitted_at: p.submittedAt, invalidated_at: p.invalidatedAt,
        settled_at: p.settledAt, inbox_event_id: p.inboxEventId,
      } : cur);
      enqueueWorkOp(this.db, { op: "workBindingUpdate", ...p });
      return;
    }
    this.db.prepare(`UPDATE work_execution_bindings SET status=@status, attempt_id=@attemptId,
      submission_receipt=@submissionReceipt, settlement_note=@settlementNote, submitted_at=@submittedAt,
      invalidated_at=@invalidatedAt, settled_at=@settledAt, inbox_event_id=@inboxEventId WHERE binding_id=@bindingId`).run(p);
  }

  consumeMetricsChange(bindingId: string): boolean { return this.metrics.consumeChange(bindingId); }

  getBinding(bindingId: string): WorkExecutionBindingDto | undefined {
    const row = overlayReadOne<BindingRow & Record<string, unknown>>(this.db, "work_execution_bindings", bindingId, () =>
      this.db.prepare("SELECT * FROM work_execution_bindings WHERE binding_id=?").get(bindingId) as (BindingRow & Record<string, unknown>) | undefined);
    return row ? { ...mapBinding(row), metrics: this.metrics.read(row.binding_id) } : undefined;
  }

  bindingForTask(taskId: string): WorkExecutionBindingDto | undefined {
    const dbRows = this.db.prepare("SELECT * FROM work_execution_bindings WHERE task_id=? ORDER BY admitted_at DESC, rowid DESC")
      .all(taskId) as Array<BindingRow & Record<string, unknown>>;
    const row = overlayFindAll(this.db, "work_execution_bindings", dbRows, r => String(r.binding_id),
      r => r.task_id === taskId, (a, b) => Number(b.admitted_at) - Number(a.admitted_at))[0];
    return row ? { ...mapBinding(row), metrics: this.metrics.read(row.binding_id) } : undefined;
  }

  getBindingByOperation(workId: string, operationId: string): WorkExecutionBindingDto | undefined {
    const dbRows = this.db.prepare("SELECT * FROM work_execution_bindings WHERE work_id=? AND operation_id=?")
      .all(workId, operationId) as Array<BindingRow & Record<string, unknown>>;
    const row = overlayFindAll(this.db, "work_execution_bindings", dbRows, r => String(r.binding_id),
      r => r.work_id === workId && r.operation_id === operationId)[0];
    return row ? { ...mapBinding(row), metrics: this.metrics.read(row.binding_id) } : undefined;
  }

  listBindings(workId: string): WorkExecutionBindingDto[] {
    const dbRows = this.db.prepare("SELECT * FROM work_execution_bindings WHERE work_id=? ORDER BY admitted_at ASC,rowid ASC")
      .all(workId) as Array<BindingRow & Record<string, unknown>>;
    return overlayFindAll(this.db, "work_execution_bindings", dbRows, r => String(r.binding_id),
      r => r.work_id === workId, (a, b) => Number(a.admitted_at) - Number(b.admitted_at))
      .map(row => ({ ...mapBinding(row), metrics: this.metrics.read(row.binding_id) }));
  }

  /** Watch risk checks need unsettled facts, never execution payloads or metrics. */
  executionRiskFacts(workId: string) {
    const executions = this.listBindings(workId)
      .filter(b => ["pending", "submitted", "running", "unknown"].includes(b.status))
      .map(b => ({ bindingId: b.bindingId, operationId: b.operationId, state: b.status,
        intentRevision: b.intentRevision, ownerEpoch: b.ownerEpoch, invalidatedAt: b.invalidatedAt ?? null }));
    const bindingInvalidated = new Map(this.listBindings(workId).map(b => [b.bindingId, b.invalidatedAt ?? null]));
    const operations = this.listAdmissions(workId)
      .filter(a => ["admitted", "attempted", "unknown"].includes(a.state))
      .map(a => ({ admissionId: a.admissionId, bindingId: a.bindingId ?? null, operationId: a.operationId,
        actionKind: a.actionKind, state: a.state, intentRevision: a.intentRevision, ownerEpoch: a.ownerEpoch,
        invalidatedAt: a.bindingId ? (bindingInvalidated.get(a.bindingId) ?? null) : null }));
    return { executions, operations };
  }

  // ------------------------------------------------------------- admissions

  insertAdmission(admission: WorkAdmissionDto): void {
    const p = { ...admission, bindingId: admission.bindingId ?? null, settledAt: admission.settledAt ?? null };
    if (requiresWorkRustWrites(this.db)) {
      overlaySet(this.db, "work_action_admissions", admission.admissionId, {
        admission_id: p.admissionId, work_id: p.workId, binding_id: p.bindingId, operation_id: p.operationId,
        action_kind: p.actionKind, state: p.state, intent_revision: p.intentRevision, owner_epoch: p.ownerEpoch,
        admitted_at: p.admittedAt, settled_at: p.settledAt,
      });
      enqueueWorkOp(this.db, {
        op: "workAdmissionInsert", admissionId: p.admissionId, workId: p.workId, bindingId: p.bindingId,
        operationId: p.operationId, actionKind: p.actionKind, state: p.state,
        intentRevision: p.intentRevision, ownerEpoch: p.ownerEpoch, admittedAt: p.admittedAt, settledAt: p.settledAt,
      });
      return;
    }
    this.db.prepare(`INSERT INTO work_action_admissions
      (admission_id,work_id,binding_id,operation_id,action_kind,state,intent_revision,owner_epoch,admitted_at,settled_at)
      VALUES (@admissionId,@workId,@bindingId,@operationId,@actionKind,@state,@intentRevision,@ownerEpoch,@admittedAt,@settledAt)`)
      .run(p);
  }

  updateAdmissionState(admissionId: string, state: WorkAdmissionDto["state"], settledAt?: number): void {
    if (requiresWorkRustWrites(this.db)) {
      overlayMutate(this.db, "work_action_admissions", admissionId, () =>
        this.db.prepare("SELECT * FROM work_action_admissions WHERE admission_id=?").get(admissionId) as Record<string, unknown> | undefined,
      cur => cur ? { ...cur, state, settled_at: settledAt ?? null } : cur);
      enqueueWorkOp(this.db, { op: "workAdmissionUpdateState", admissionId, state, settledAt: settledAt ?? null });
      return;
    }
    this.db.prepare("UPDATE work_action_admissions SET state=?, settled_at=? WHERE admission_id=?")
      .run(state, settledAt ?? null, admissionId);
  }

  getAdmission(admissionId: string): WorkAdmissionDto | undefined {
    const row = overlayReadOne<AdmissionRow & Record<string, unknown>>(this.db, "work_action_admissions", admissionId, () =>
      this.db.prepare("SELECT * FROM work_action_admissions WHERE admission_id=?").get(admissionId) as (AdmissionRow & Record<string, unknown>) | undefined);
    return row ? mapAdmission(row) : undefined;
  }

  listAdmissions(workId: string): WorkAdmissionDto[] {
    const dbRows = this.db.prepare("SELECT * FROM work_action_admissions WHERE work_id=? ORDER BY admitted_at ASC")
      .all(workId) as Array<AdmissionRow & Record<string, unknown>>;
    return overlayFindAll(this.db, "work_action_admissions", dbRows, r => String(r.admission_id),
      r => r.work_id === workId, (a, b) => Number(a.admitted_at) - Number(b.admitted_at)).map(mapAdmission);
  }

  // ------------------------------------------------------------ deliverables

  insertDeliverable(deliverable: WorkDeliverableDto): void {
    const p = {
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
    };
    if (requiresWorkRustWrites(this.db)) {
      overlaySet(this.db, "work_deliverables", deliverable.deliverableId, {
        deliverable_id: p.deliverableId, work_id: p.workId, producer_bot_id: p.producerBotId,
        execution_id: p.executionId, intent_revision: p.intentRevision, owner_epoch: p.ownerEpoch,
        input_snapshot_id: p.inputSnapshotId, status: p.status, summary: p.summary,
        artifact_refs_json: p.artifactRefsJson, evidence_refs_json: p.evidenceRefsJson,
        uncovered_scope_json: p.uncoveredScopeJson, uncovered_criterion_ids_json: p.uncoveredCriterionIdsJson,
        is_speculation: p.isSpeculation, has_write_conflicts: p.hasWriteConflicts,
        rejected_reason: p.rejectedReason, created_at: p.createdAt, reviewed_at: p.reviewedAt,
        reviewed_by_bot_id: p.reviewedByBotId,
      });
      enqueueWorkOp(this.db, {
        op: "workDeliverableInsert",
        deliverableId: p.deliverableId, workId: p.workId, producerBotId: p.producerBotId,
        executionId: p.executionId, intentRevision: p.intentRevision, ownerEpoch: p.ownerEpoch,
        inputSnapshotId: p.inputSnapshotId, status: p.status, summary: p.summary,
        artifactRefsJson: p.artifactRefsJson, evidenceRefsJson: p.evidenceRefsJson,
        uncoveredScopeJson: p.uncoveredScopeJson, uncoveredCriterionIdsJson: p.uncoveredCriterionIdsJson,
        isSpeculation: p.isSpeculation, hasWriteConflicts: p.hasWriteConflicts,
        rejectedReason: p.rejectedReason, createdAt: p.createdAt, reviewedAt: p.reviewedAt,
        reviewedByBotId: p.reviewedByBotId,
      });
      return;
    }
    this.db.prepare(`INSERT INTO work_deliverables (
      deliverable_id,work_id,producer_bot_id,execution_id,intent_revision,owner_epoch,input_snapshot_id,
      status,summary,artifact_refs_json,evidence_refs_json,uncovered_scope_json,uncovered_criterion_ids_json,is_speculation,
      has_write_conflicts,rejected_reason,created_at,reviewed_at,reviewed_by_bot_id
    ) VALUES (@deliverableId,@workId,@producerBotId,@executionId,@intentRevision,@ownerEpoch,@inputSnapshotId,
      @status,@summary,@artifactRefsJson,@evidenceRefsJson,@uncoveredScopeJson,@uncoveredCriterionIdsJson,@isSpeculation,
      @hasWriteConflicts,@rejectedReason,@createdAt,@reviewedAt,@reviewedByBotId)`).run(p);
  }

  updateDeliverableReview(deliverableId: string, params: {
    status: WorkDeliverableDto["status"]; reviewedAt?: number; reviewedByBotId?: string; rejectedReason?: string;
  }): void {
    const p = {
      deliverableId,
      status: params.status,
      reviewedAt: params.reviewedAt ?? null,
      reviewedByBotId: params.reviewedByBotId ?? null,
      rejectedReason: params.rejectedReason ?? null,
    };
    if (requiresWorkRustWrites(this.db)) {
      overlayMutate(this.db, "work_deliverables", deliverableId, () =>
        this.db.prepare("SELECT * FROM work_deliverables WHERE deliverable_id=?").get(deliverableId) as Record<string, unknown> | undefined,
      cur => cur ? {
        ...cur, status: p.status, reviewed_at: p.reviewedAt,
        reviewed_by_bot_id: p.reviewedByBotId, rejected_reason: p.rejectedReason,
      } : cur);
      enqueueWorkOp(this.db, { op: "workDeliverableUpdateReview", ...p });
      return;
    }
    this.db.prepare(`UPDATE work_deliverables SET status=@status, reviewed_at=@reviewedAt,
      reviewed_by_bot_id=@reviewedByBotId, rejected_reason=@rejectedReason WHERE deliverable_id=@deliverableId`)
      .run(p);
  }

  getDeliverable(deliverableId: string): WorkDeliverableDto | undefined {
    const row = overlayReadOne<DeliverableRow & Record<string, unknown>>(this.db, "work_deliverables", deliverableId, () =>
      this.db.prepare("SELECT * FROM work_deliverables WHERE deliverable_id=?").get(deliverableId) as (DeliverableRow & Record<string, unknown>) | undefined);
    return row ? mapDeliverable(row) : undefined;
  }

  listDeliverables(workId: string): WorkDeliverableDto[] {
    const dbRows = this.db.prepare("SELECT * FROM work_deliverables WHERE work_id=? ORDER BY created_at ASC,rowid ASC")
      .all(workId) as Array<DeliverableRow & Record<string, unknown>>;
    return overlayFindAll(this.db, "work_deliverables", dbRows, r => String(r.deliverable_id),
      r => r.work_id === workId, (a, b) => Number(a.created_at) - Number(b.created_at)).map(mapDeliverable);
  }

  /** History that already existed when this observation was admitted. The same
   * cutoff is used before native submission and after completion/recovery: a
   * later round (even one finishing first) must never become an earlier baseline.
   * Incomplete reports remain history, not proof that anything is unchanged. */
  previousWatchReports(binding: WorkExecutionBindingDto, includeBaseline = false): WorkDeliverableDto[] {
    const comparable = (r: WorkDeliverableDto) => !r.isSpeculation && !r.hasWriteConflicts && !r.uncoveredScope.length
      && parseWatchObservation(r.summary)?.status === "observed";
    if (overlayHasTable(this.db, "work_deliverables") || overlayHasTable(this.db, "work_execution_bindings")) {
      const bindings = this.listBindings(binding.workId);
      const bindingById = new Map(bindings.map(b => [b.bindingId, b]));
      const currentIdx = bindings.findIndex(b => b.bindingId === binding.bindingId);
      const eligible = this.listDeliverables(binding.workId).filter(d => {
        if (d.intentRevision !== binding.intentRevision || d.inputSnapshotId !== binding.inputSnapshotId
          || d.ownerEpoch !== binding.ownerEpoch || d.producerBotId !== binding.botId
          || d.status === "superseded" || d.status === "rejected" || d.createdAt > binding.admittedAt) return false;
        const b = bindingById.get(d.executionId);
        if (!b || b.workId !== d.workId || b.intentRevision !== d.intentRevision || b.inputSnapshotId !== d.inputSnapshotId
          || b.ownerEpoch !== d.ownerEpoch || b.botId !== d.producerBotId || b.invalidatedAt !== undefined || b.status === "invalidated") return false;
        if (binding.inboxEventId && b.inboxEventId && b.inboxEventId === binding.inboxEventId) return false;
        if (b.admittedAt < binding.admittedAt) return true;
        if (b.admittedAt === binding.admittedAt && currentIdx >= 0) {
          const bIdx = bindings.findIndex(item => item.bindingId === b.bindingId);
          return bIdx >= 0 && bIdx < currentIdx;
        }
        return false;
      });
      const recent = eligible.slice(-3);
      if (includeBaseline && !recent.some(comparable)) {
        const baseline = [...eligible].reverse().find(comparable);
        if (baseline) recent.unshift(baseline);
      }
      return recent;
    }
    const sql = `SELECT d.* FROM work_deliverables d
      JOIN work_execution_bindings b ON b.binding_id=d.execution_id
      JOIN work_execution_bindings current ON current.binding_id=@bindingId
      WHERE d.work_id=@workId AND d.intent_revision=@intentRevision AND d.input_snapshot_id=@inputSnapshotId
        AND d.owner_epoch=@ownerEpoch AND d.producer_bot_id=@botId
        AND b.work_id=d.work_id AND b.intent_revision=d.intent_revision AND b.input_snapshot_id=d.input_snapshot_id
        AND b.owner_epoch=d.owner_epoch AND b.bot_id=d.producer_bot_id
        AND b.invalidated_at IS NULL AND b.status<>'invalidated' AND d.status NOT IN ('superseded','rejected')
        AND (current.inbox_event_id IS NULL OR b.inbox_event_id IS NULL OR b.inbox_event_id<>current.inbox_event_id)
        AND d.created_at<=current.admitted_at
        AND (b.admitted_at<current.admitted_at OR (b.admitted_at=current.admitted_at AND b.rowid<current.rowid))`;
    const params = { bindingId: binding.bindingId, workId: binding.workId,
      intentRevision: binding.intentRevision, inputSnapshotId: binding.inputSnapshotId,
      ownerEpoch: binding.ownerEpoch, botId: binding.botId };
    const order = " ORDER BY d.created_at DESC,d.rowid DESC";
    const recent = (this.db.prepare(sql + order + " LIMIT 3").all(params) as DeliverableRow[]).map(mapDeliverable).reverse();
    // Repeated failed rounds must not erase a prior changes-only baseline. Find
    // just that one candidate lazily; never materialize an unbounded report list.
    if (includeBaseline && !recent.some(comparable)) {
      for (const row of this.db.prepare(sql + " AND d.is_speculation=0 AND d.has_write_conflicts=0 AND d.uncovered_scope_json='[]'" + order).iterate(params)) {
        const candidate = mapDeliverable(row as DeliverableRow);
        if (comparable(candidate)) { recent.unshift(candidate); break; }
      }
    }
    return recent;
  }

  supersedeStaleDeliverables(workId: string, intentRevision: number, inputSnapshotId: string): void {
    // A pending result from an old input is no longer awaiting current acceptance.
    // Accepted rows retain their historical review; Work tracks current result IDs.
    if (requiresWorkRustWrites(this.db)) {
      const bindingsById = new Map(this.listBindings(workId).map(b => [b.bindingId, b]));
      const dbRows = this.db.prepare("SELECT * FROM work_deliverables WHERE work_id=? AND status='proposed'")
        .all(workId) as Array<Record<string, unknown>>;
      for (const row of overlayFindAll(this.db, "work_deliverables", dbRows, r => String(r.deliverable_id),
        r => r.work_id === workId && r.status === "proposed")) {
        const b = bindingsById.get(String(row.execution_id));
        const invalidated = Boolean(b && (b.invalidatedAt !== undefined || b.status === "invalidated"));
        if (Number(row.intent_revision) !== intentRevision || String(row.input_snapshot_id) !== inputSnapshotId || invalidated) {
          overlaySet(this.db, "work_deliverables", String(row.deliverable_id), { ...row, status: "superseded" });
        }
      }
      enqueueWorkOp(this.db, { op: "workDeliverablesSupersedeProposed", workId, intentRevision, inputSnapshotId });
      return;
    }
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
    const p = {
      ...evidence,
      deliverableId: evidence.deliverableId ?? null,
      executionId: evidence.executionId ?? null,
      criterionIdsJson: jsonText(evidence.criterionIds),
      sourceSha: evidence.sourceSha ?? null,
      environment: evidence.environment ?? null,
      detail: evidence.detail ?? null,
    };
    if (requiresWorkRustWrites(this.db)) {
      overlaySet(this.db, "work_evidence", evidence.evidenceId, {
        evidence_id: p.evidenceId, work_id: p.workId, deliverable_id: p.deliverableId,
        execution_id: p.executionId, criterion_ids_json: p.criterionIdsJson, kind: p.kind,
        provenance: p.provenance, source_ref: p.sourceRef, source_sha: p.sourceSha,
        input_snapshot_id: p.inputSnapshotId, environment: p.environment,
        intent_revision: p.intentRevision, detail: p.detail, recorded_at: p.recordedAt,
      });
      enqueueWorkOp(this.db, {
        op: "workEvidenceInsert", evidenceId: p.evidenceId, workId: p.workId, deliverableId: p.deliverableId,
        executionId: p.executionId, criterionIdsJson: p.criterionIdsJson, kind: p.kind, provenance: p.provenance,
        sourceRef: p.sourceRef, sourceSha: p.sourceSha, inputSnapshotId: p.inputSnapshotId,
        environment: p.environment, intentRevision: p.intentRevision, detail: p.detail, recordedAt: p.recordedAt,
      });
      return;
    }
    this.db.prepare(`INSERT INTO work_evidence (
      evidence_id,work_id,deliverable_id,execution_id,criterion_ids_json,kind,provenance,source_ref,
      source_sha,input_snapshot_id,environment,intent_revision,detail,recorded_at
    ) VALUES (@evidenceId,@workId,@deliverableId,@executionId,@criterionIdsJson,@kind,@provenance,@sourceRef,
      @sourceSha,@inputSnapshotId,@environment,@intentRevision,@detail,@recordedAt)`).run(p);
  }

  getEvidence(evidenceId: string): WorkEvidenceDto | undefined {
    const row = overlayReadOne<EvidenceRow & Record<string, unknown>>(this.db, "work_evidence", evidenceId, () =>
      this.db.prepare("SELECT * FROM work_evidence WHERE evidence_id=?").get(evidenceId) as (EvidenceRow & Record<string, unknown>) | undefined);
    return row ? mapEvidence(row) : undefined;
  }

  listEvidence(workId: string): WorkEvidenceDto[] {
    const dbRows = this.db.prepare("SELECT * FROM work_evidence WHERE work_id=? ORDER BY recorded_at ASC")
      .all(workId) as Array<EvidenceRow & Record<string, unknown>>;
    return overlayFindAll(this.db, "work_evidence", dbRows, r => String(r.evidence_id),
      r => r.work_id === workId, (a, b) => Number(a.recorded_at) - Number(b.recorded_at)).map(mapEvidence);
  }

  // ---------------------------------------------------------------- blockers

  insertBlocker(blocker: WorkBlockerDto): void {
    blocker = nonBlockingEffect(blocker);
    const p = {
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
    };
    if (requiresWorkRustWrites(this.db)) {
      overlaySet(this.db, "work_blockers", blocker.blockerId, {
        blocker_id: p.blockerId, work_id: p.workId, reported_by_bot_id: p.reportedByBotId,
        reason: p.reason, kind: p.kind, unknown_external_effect_ref: p.unknownExternalEffectRef,
        reason_code: p.reasonCode, details_json: p.detailsJson, source_ref: p.sourceRef,
        subscription_id: p.subscriptionId, causal_chain_id: p.causalChainId,
        waiting_for_user_input: p.waitingForUserInput, status: p.status,
        created_at: p.createdAt, cleared_at: p.clearedAt,
      });
      enqueueWorkOp(this.db, {
        op: "workBlockerInsert", blockerId: p.blockerId, workId: p.workId, reportedByBotId: p.reportedByBotId,
        reason: p.reason, kind: p.kind, unknownExternalEffectRef: p.unknownExternalEffectRef,
        reasonCode: p.reasonCode, detailsJson: p.detailsJson, sourceRef: p.sourceRef,
        subscriptionId: p.subscriptionId, causalChainId: p.causalChainId,
        waitingForUserInput: p.waitingForUserInput, status: p.status,
        createdAt: p.createdAt, clearedAt: p.clearedAt,
      });
      return;
    }
    this.db.prepare(`INSERT INTO work_blockers (
      blocker_id,work_id,reported_by_bot_id,reason,kind,unknown_external_effect_ref,
      reason_code,details_json,source_ref,subscription_id,causal_chain_id,
      waiting_for_user_input,status,created_at,cleared_at
    ) VALUES (@blockerId,@workId,@reportedByBotId,@reason,@kind,@unknownExternalEffectRef,
      @reasonCode,@detailsJson,@sourceRef,@subscriptionId,@causalChainId,
      @waitingForUserInput,@status,@createdAt,@clearedAt)`).run(p);
  }

  clearBlocker(blockerId: string, workId: string, now: number): void {
    if (requiresWorkRustWrites(this.db)) {
      overlayMutate(this.db, "work_blockers", blockerId, () =>
        this.db.prepare("SELECT * FROM work_blockers WHERE blocker_id=?").get(blockerId) as Record<string, unknown> | undefined,
      cur => cur && cur.work_id === workId && cur.status === "open" ? { ...cur, status: "cleared", cleared_at: now } : cur);
      enqueueWorkOp(this.db, {
        op: "workBlockerUpdate", blockerId, workId, mode: "clear", reason: null,
        detailsJson: null, sourceRef: null, subscriptionId: null, causalChainId: null, clearedAt: now,
      });
      return;
    }
    this.db.prepare("UPDATE work_blockers SET status='cleared', cleared_at=? WHERE blocker_id=? AND work_id=? AND status='open'")
      .run(now, blockerId, workId);
  }

  recordBlockerResponse(blocker: WorkBlockerDto, response: Record<string, unknown>, now: number): void {
    const detailsJson = jsonText({ ...blocker.details, response });
    if (requiresWorkRustWrites(this.db)) {
      overlayMutate(this.db, "work_blockers", blocker.blockerId, () =>
        this.db.prepare("SELECT * FROM work_blockers WHERE blocker_id=?").get(blocker.blockerId) as Record<string, unknown> | undefined,
      cur => cur && cur.work_id === blocker.workId && cur.status === "open"
        ? { ...cur, details_json: detailsJson, status: "cleared", cleared_at: now } : cur);
      enqueueWorkOp(this.db, {
        op: "workBlockerUpdate", blockerId: blocker.blockerId, workId: blocker.workId, mode: "respond", reason: null,
        detailsJson, sourceRef: null, subscriptionId: null, causalChainId: null, clearedAt: now,
      });
      return;
    }
    this.db.prepare("UPDATE work_blockers SET details_json=?,status='cleared',cleared_at=? WHERE blocker_id=? AND work_id=? AND status='open'")
      .run(detailsJson, now, blocker.blockerId, blocker.workId);
  }

  getBlocker(blockerId: string): WorkBlockerDto | undefined {
    const row = overlayReadOne<BlockerRow & Record<string, unknown>>(this.db, "work_blockers", blockerId, () =>
      this.db.prepare("SELECT * FROM work_blockers WHERE blocker_id=?").get(blockerId) as (BlockerRow & Record<string, unknown>) | undefined);
    return row ? mapBlocker(row) : undefined;
  }

  listBlockers(workId: string): WorkBlockerDto[] {
    const dbRows = this.db.prepare("SELECT * FROM work_blockers WHERE work_id=? ORDER BY created_at ASC")
      .all(workId) as Array<BlockerRow & Record<string, unknown>>;
    return overlayFindAll(this.db, "work_blockers", dbRows, r => String(r.blocker_id),
      r => r.work_id === workId, (a, b) => Number(a.created_at) - Number(b.created_at))
      .filter(row => !isRetiredQuotaBlocker(row) && !this.isRetiredTeamQuotaBlocker(row)).map(mapBlocker);
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
    if (requiresWorkRustWrites(this.db)) {
      overlayMutate(this.db, "work_blockers", blockerId, () =>
        this.db.prepare("SELECT * FROM work_blockers WHERE blocker_id=?").get(blockerId) as Record<string, unknown> | undefined,
      cur => cur && cur.work_id === workId && cur.kind !== "external_effect" && (cur.unknown_external_effect_ref ?? null) === null
        ? { ...cur, status: "open", cleared_at: null } : cur);
      enqueueWorkOp(this.db, {
        op: "workBlockerUpdate", blockerId, workId, mode: "reopen", reason: null,
        detailsJson: null, sourceRef: null, subscriptionId: null, causalChainId: null, clearedAt: null,
      });
      return;
    }
    this.db.prepare("UPDATE work_blockers SET status='open',cleared_at=NULL WHERE blocker_id=? AND work_id=? AND kind!='external_effect' AND unknown_external_effect_ref IS NULL").run(blockerId, workId);
  }

  // ------------------------------------------------------------- subscriptions

  private subscriptionParams(subscription: WorkSubscriptionDto, isUpdate: boolean) {
    return {
      subscriptionId: subscription.subscriptionId,
      workId: subscription.workId,
      source: subscription.source,
      filterJson: jsonText(subscription.filter),
      catchUpPolicy: subscription.catchUpPolicy,
      maxMergeWaitMs: subscription.maxMergeWaitMs,
      maxQueueDepth: subscription.maxQueueDepth,
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
      createdAt: subscription.createdAt,
      updatedAt: subscription.updatedAt,
      stoppedAt: subscription.stoppedAt ?? null,
      isUpdate,
    };
  }

  private subscriptionRowFromParams(p: ReturnType<WorkRepository["subscriptionParams"]>): SubscriptionRow & Record<string, unknown> {
    return {
      subscription_id: p.subscriptionId, work_id: p.workId, source: p.source, filter_json: p.filterJson,
      catch_up_policy: p.catchUpPolicy, max_merge_wait_ms: p.maxMergeWaitMs, max_queue_depth: p.maxQueueDepth,
      stop_condition_text: p.stopConditionText, timezone: p.timezone, cron_expression: p.cronExpression,
      next_wake_at: p.nextWakeAt, last_processed_source_version: p.lastProcessedSourceVersion,
      schedule_revision: p.scheduleRevision, config_revision: p.configRevision, source_target: p.sourceTarget,
      version_mode: p.versionMode, dst_policy: p.dstPolicy, max_backlog_events: p.maxBacklogEvents,
      max_backlog_bytes: p.maxBacklogBytes, last_checked_at: p.lastCheckedAt, stopped_reason: p.stoppedReason,
      config_json: p.configJson, created_at: p.createdAt, updated_at: p.updatedAt, stopped_at: p.stoppedAt,
    };
  }

  insertSubscription(subscription: WorkSubscriptionDto): void {
    const p = this.subscriptionParams(subscription, false);
    if (requiresWorkRustWrites(this.db)) {
      overlaySet(this.db, "work_subscriptions", subscription.subscriptionId, this.subscriptionRowFromParams(p));
      enqueueWorkOp(this.db, { op: "workSubscriptionUpsert", ...p });
      return;
    }
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
      @createdAt,@updatedAt,@stoppedAt)`).run(p);
  }

  updateSubscription(subscription: WorkSubscriptionDto): void {
    const p = this.subscriptionParams(subscription, true);
    if (requiresWorkRustWrites(this.db)) {
      overlaySet(this.db, "work_subscriptions", subscription.subscriptionId, this.subscriptionRowFromParams(p));
      enqueueWorkOp(this.db, { op: "workSubscriptionUpsert", ...p });
      return;
    }
    this.db.prepare(`UPDATE work_subscriptions SET filter_json=@filterJson, catch_up_policy=@catchUpPolicy,
      max_merge_wait_ms=@maxMergeWaitMs, max_queue_depth=@maxQueueDepth, stop_condition_text=@stopConditionText,
      timezone=@timezone, cron_expression=@cronExpression, next_wake_at=@nextWakeAt,
      last_processed_source_version=@lastProcessedSourceVersion, schedule_revision=@scheduleRevision,
      config_revision=@configRevision, source_target=@sourceTarget, version_mode=@versionMode,
      dst_policy=@dstPolicy, max_backlog_events=@maxBacklogEvents, max_backlog_bytes=@maxBacklogBytes,
      last_checked_at=@lastCheckedAt, stopped_reason=@stoppedReason, config_json=@configJson,
      updated_at=@updatedAt, stopped_at=@stoppedAt
      WHERE subscription_id=@subscriptionId`).run(p);
  }

  getSubscription(subscriptionId: string): WorkSubscriptionDto | undefined {
    const row = overlayReadOne<SubscriptionRow & Record<string, unknown>>(this.db, "work_subscriptions", subscriptionId, () =>
      this.db.prepare("SELECT * FROM work_subscriptions WHERE subscription_id=?").get(subscriptionId) as (SubscriptionRow & Record<string, unknown>) | undefined);
    return row ? mapSubscription(row) : undefined;
  }

  listSubscriptions(workId: string, options: { includeStopped?: boolean } = {}): WorkSubscriptionDto[] {
    const dbRows = (options.includeStopped
      ? this.db.prepare("SELECT * FROM work_subscriptions WHERE work_id=? ORDER BY created_at ASC").all(workId)
      : this.db.prepare("SELECT * FROM work_subscriptions WHERE work_id=? AND stopped_at IS NULL ORDER BY created_at ASC").all(workId)) as Array<SubscriptionRow & Record<string, unknown>>;
    return overlayFindAll(this.db, "work_subscriptions", dbRows, r => String(r.subscription_id),
      r => r.work_id === workId && (Boolean(options.includeStopped) || (r.stopped_at ?? null) === null),
      (a, b) => Number(a.created_at) - Number(b.created_at)).map(mapSubscription);
  }

  listActiveSubscriptions(source?: string): WorkSubscriptionDto[] {
    const dbRows = (source === undefined
      ? this.db.prepare("SELECT * FROM work_subscriptions WHERE stopped_at IS NULL ORDER BY created_at ASC").all()
      : this.db.prepare("SELECT * FROM work_subscriptions WHERE source=? AND stopped_at IS NULL ORDER BY created_at ASC").all(source)) as Array<SubscriptionRow & Record<string, unknown>>;
    return overlayFindAll(this.db, "work_subscriptions", dbRows, r => String(r.subscription_id),
      r => (r.stopped_at ?? null) === null && (source === undefined || r.source === source),
      (a, b) => Number(a.created_at) - Number(b.created_at)).map(mapSubscription);
  }

  stopSubscriptionsForWork(workId: string, now: number): void {
    if (requiresWorkRustWrites(this.db)) {
      const dbRows = this.db.prepare("SELECT * FROM work_subscriptions WHERE work_id=? AND stopped_at IS NULL")
        .all(workId) as Array<Record<string, unknown>>;
      for (const row of overlayFindAll(this.db, "work_subscriptions", dbRows, r => String(r.subscription_id),
        r => r.work_id === workId && (r.stopped_at ?? null) === null)) {
        overlaySet(this.db, "work_subscriptions", String(row.subscription_id), { ...row, stopped_at: now, updated_at: now });
      }
      enqueueWorkOp(this.db, { op: "workSubscriptionsStopForWork", workId, now });
      return;
    }
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
    const payloadBytes = Buffer.byteLength(payloadJson, "utf8");
    if (requiresWorkRustWrites(this.db)) {
      const pk = `${event.source}\0${event.sourceEventId}`;
      const existing = overlayReadOne(this.db, "work_source_events", pk, () =>
        this.db.prepare("SELECT * FROM work_source_events WHERE source=? AND source_event_id=?")
          .get(event.source, event.sourceEventId) as Record<string, unknown> | undefined);
      enqueueWorkOp(this.db, {
        op: "workSourceEventInsert",
        source: event.source, sourceEventId: event.sourceEventId, eventType: event.eventType,
        sourceVersion: event.sourceVersion ?? null, causalEventId: event.causalEventId ?? null,
        payloadJson, receivedAt: event.receivedAt, occurredAt: event.occurredAt ?? null,
        targetKey: event.targetKey ?? null, payloadBytes,
        adapter: event.adapter ?? null, trustedOrigin: event.trustedOrigin ?? null,
      });
      if (existing) return false;
      overlaySet(this.db, "work_source_events", pk, {
        source: event.source, source_event_id: event.sourceEventId, event_type: event.eventType,
        source_version: event.sourceVersion ?? null, causal_event_id: event.causalEventId ?? null,
        payload_json: payloadJson, received_at: event.receivedAt, occurred_at: event.occurredAt ?? null,
        target_key: event.targetKey ?? null, payload_bytes: payloadBytes,
        adapter: event.adapter ?? null, trusted_origin: event.trustedOrigin ?? null,
      });
      return true;
    }
    const result = this.db.prepare(`INSERT OR IGNORE INTO work_source_events
      (source,source_event_id,event_type,source_version,causal_event_id,payload_json,received_at,
       occurred_at,target_key,payload_bytes,adapter,trusted_origin)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      event.source, event.sourceEventId, event.eventType, event.sourceVersion ?? null,
      event.causalEventId ?? null, payloadJson, event.receivedAt,
      event.occurredAt ?? null, event.targetKey ?? null, payloadBytes,
      event.adapter ?? null, event.trustedOrigin ?? null,
    );
    return result.changes > 0;
  }

  insertInbox(event: WorkInboxEventDto): boolean {
    const p = {
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
    };
    if (requiresWorkRustWrites(this.db)) {
      const dbExisting = this.db.prepare("SELECT * FROM work_events_inbox WHERE event_id=? OR dedupe_key=?")
        .all(event.eventId, event.dedupeKey) as Array<Record<string, unknown>>;
      const existing = overlayFindAll(this.db, "work_events_inbox", dbExisting, r => String(r.event_id),
        r => r.event_id === event.eventId || r.dedupe_key === event.dedupeKey)[0];
      enqueueWorkOp(this.db, {
        op: "workInboxInsert",
        eventId: p.eventId, dedupeKey: p.dedupeKey, source: p.source, sourceEventId: p.sourceEventId,
        eventType: p.eventType, workId: p.workId, subscriptionId: p.subscriptionId,
        intentRevision: p.intentRevision, stateVersion: p.stateVersion, ownerEpoch: p.ownerEpoch,
        sourceVersion: p.sourceVersion, causalEventId: p.causalEventId, payloadJson: p.payloadJson,
        status: p.status, mergedCount: p.mergedCount, mergeDeadlineAt: p.mergeDeadlineAt,
        receivedAt: p.receivedAt, processedAt: p.processedAt, batchId: p.batchId,
        batchDeadlineAt: p.batchDeadlineAt, frozenAt: p.frozenAt, frozenPayloadJson: p.frozenPayloadJson,
        claimVersion: p.claimVersion, targetKey: p.targetKey, processReason: p.processReason,
        queuedWhilePaused: null,
      });
      if (existing) return false;
      overlaySet(this.db, "work_events_inbox", p.eventId, {
        event_id: p.eventId, dedupe_key: p.dedupeKey, source: p.source, source_event_id: p.sourceEventId,
        event_type: p.eventType, work_id: p.workId, subscription_id: p.subscriptionId,
        intent_revision: p.intentRevision, state_version: p.stateVersion, owner_epoch: p.ownerEpoch,
        source_version: p.sourceVersion, causal_event_id: p.causalEventId, payload_json: p.payloadJson,
        status: p.status, merged_count: p.mergedCount, merge_deadline_at: p.mergeDeadlineAt,
        received_at: p.receivedAt, processed_at: p.processedAt, batch_id: p.batchId,
        batch_deadline_at: p.batchDeadlineAt, frozen_at: p.frozenAt, frozen_payload_json: p.frozenPayloadJson,
        claim_version: p.claimVersion, target_key: p.targetKey, process_reason: p.processReason,
      });
      return true;
    }
    const result = this.db.prepare(`INSERT OR IGNORE INTO work_events_inbox (
      event_id,dedupe_key,source,source_event_id,event_type,work_id,subscription_id,intent_revision,
      state_version,owner_epoch,source_version,causal_event_id,payload_json,status,merged_count,
      merge_deadline_at,received_at,processed_at,batch_id,batch_deadline_at,frozen_at,frozen_payload_json,
      claim_version,target_key,process_reason
    ) VALUES (@eventId,@dedupeKey,@source,@sourceEventId,@eventType,@workId,@subscriptionId,@intentRevision,
      @stateVersion,@ownerEpoch,@sourceVersion,@causalEventId,@payloadJson,@status,@mergedCount,
      @mergeDeadlineAt,@receivedAt,@processedAt,@batchId,@batchDeadlineAt,@frozenAt,@frozenPayloadJson,
      @claimVersion,@targetKey,@processReason)`).run(p);
    return result.changes > 0;
  }

  getInbox(eventId: string): WorkInboxEventDto | undefined {
    const row = overlayReadOne<InboxRow & Record<string, unknown>>(this.db, "work_events_inbox", eventId, () =>
      this.db.prepare("SELECT * FROM work_events_inbox WHERE event_id=?").get(eventId) as (InboxRow & Record<string, unknown>) | undefined);
    return row ? mapInbox(row) : undefined;
  }

  listInbox(workId: string, statuses: WorkInboxEventDto["status"][] = ["pending", "merged"]): WorkInboxEventDto[] {
    const placeholders = statuses.map(() => "?").join(",");
    const dbRows = this.db.prepare(`SELECT * FROM work_events_inbox WHERE work_id=? AND status IN (${placeholders})
      ORDER BY received_at ASC`).all(workId, ...statuses) as Array<InboxRow & Record<string, unknown>>;
    const statusSet = new Set(statuses);
    return overlayFindAll(this.db, "work_events_inbox", dbRows, r => String(r.event_id),
      r => r.work_id === workId && statusSet.has(r.status),
      (a, b) => Number(a.received_at) - Number(b.received_at)).map(mapInbox);
  }

  mergeLatestInbox(params: {
    subscriptionId: string; eventType: string; sourceVersion?: string; causalEventId?: string;
    payload: Record<string, unknown>; now: number;
  }): { merged: boolean } {
    const dbRows = this.db.prepare(`SELECT * FROM work_events_inbox
      WHERE subscription_id=? AND status IN ('pending','merged') ORDER BY received_at ASC LIMIT 1`)
      .all(params.subscriptionId) as Array<InboxRow & Record<string, unknown>>;
    const pending = overlayFindAll(this.db, "work_events_inbox", dbRows, r => String(r.event_id),
      r => r.subscription_id === params.subscriptionId && ["pending", "merged"].includes(String(r.status)),
      (a, b) => Number(a.received_at) - Number(b.received_at))[0];
    if (!pending) return { merged: false };
    const payloadJson = jsonText(params.payload);
    if (requiresWorkRustWrites(this.db)) {
      overlaySet(this.db, "work_events_inbox", String(pending.event_id), {
        ...pending, event_type: params.eventType, source_version: params.sourceVersion ?? null,
        causal_event_id: params.causalEventId ?? null, payload_json: payloadJson,
        status: "merged", merged_count: Number(pending.merged_count ?? 0) + 1,
      });
      enqueueWorkOp(this.db, {
        op: "workInboxUpdate", mode: "mergeLatest", eventId: String(pending.event_id),
        subscriptionId: null, workId: null, eventType: params.eventType,
        sourceVersion: params.sourceVersion ?? null, causalEventId: params.causalEventId ?? null,
        payloadJson, status: null, mergeDeadlineAt: null, mergedCount: null, targetKey: null,
        batchId: null, batchDeadlineAt: null, now: null,
      });
      return { merged: true };
    }
    this.db.prepare(`UPDATE work_events_inbox SET event_type=?, source_version=?, causal_event_id=?,
      payload_json=?, status='merged', merged_count=merged_count+1 WHERE event_id=?`).run(
      params.eventType, params.sourceVersion ?? null, params.causalEventId ?? null,
      payloadJson, pending.event_id,
    );
    return { merged: true };
  }

  countPendingInboxForSubscription(subscriptionId: string): number {
    if (overlayHasTable(this.db, "work_events_inbox")) {
      const dbRows = this.db.prepare("SELECT * FROM work_events_inbox WHERE subscription_id=? AND status IN ('pending','merged','blocked')")
        .all(subscriptionId) as Array<Record<string, unknown>>;
      return overlayFindAll(this.db, "work_events_inbox", dbRows, r => String(r.event_id),
        r => r.subscription_id === subscriptionId && ["pending", "merged", "blocked"].includes(String(r.status))).length;
    }
    return Number((this.db.prepare("SELECT COUNT(*) AS count FROM work_events_inbox WHERE subscription_id=? AND status IN ('pending','merged','blocked')")
      .get(subscriptionId) as { count: number }).count);
  }

  setInboxStatus(eventId: string, status: WorkInboxEventDto["status"], now?: number): void {
    if (requiresWorkRustWrites(this.db)) {
      overlayMutate(this.db, "work_events_inbox", eventId, () =>
        this.db.prepare("SELECT * FROM work_events_inbox WHERE event_id=?").get(eventId) as Record<string, unknown> | undefined,
      cur => cur ? { ...cur, status, processed_at: now ?? null } : cur);
      enqueueWorkOp(this.db, {
        op: "workInboxUpdate", mode: "setStatus", eventId, subscriptionId: null, workId: null,
        eventType: null, sourceVersion: null, causalEventId: null, payloadJson: null,
        status, mergeDeadlineAt: null, mergedCount: null, targetKey: null, batchId: null, batchDeadlineAt: null,
        now: now ?? null,
      });
      return;
    }
    this.db.prepare("UPDATE work_events_inbox SET status=?, processed_at=? WHERE event_id=?")
      .run(status, now ?? null, eventId);
  }

  insertOutbox(instruction: WorkOutboxInstructionDto): void {
    const p = {
      ...instruction,
      bindingId: instruction.bindingId ?? null,
      causalEventId: instruction.causalEventId ?? null,
      payloadJson: jsonText(instruction.payload),
      attemptId: instruction.attemptId ?? null,
      deliveredAt: instruction.deliveredAt ?? null,
    };
    if (requiresWorkRustWrites(this.db)) {
      overlaySet(this.db, "work_events_outbox", instruction.eventId, {
        event_id: p.eventId, dedupe_key: p.dedupeKey, event_type: p.eventType, work_id: p.workId,
        binding_id: p.bindingId, intent_revision: p.intentRevision, state_version: p.stateVersion,
        owner_epoch: p.ownerEpoch, request_id: p.requestId, causal_event_id: p.causalEventId,
        payload_json: p.payloadJson, delivery_status: p.deliveryStatus, attempt_id: p.attemptId,
        attempt_count: p.attemptCount, created_at: p.createdAt, delivered_at: p.deliveredAt,
      });
      enqueueWorkOp(this.db, {
        op: "workOutboxInsert", eventId: p.eventId, dedupeKey: p.dedupeKey, eventType: p.eventType,
        workId: p.workId, bindingId: p.bindingId, intentRevision: p.intentRevision,
        stateVersion: p.stateVersion, ownerEpoch: p.ownerEpoch, requestId: p.requestId,
        causalEventId: p.causalEventId, payloadJson: p.payloadJson, deliveryStatus: p.deliveryStatus,
        attemptId: p.attemptId, attemptCount: p.attemptCount, createdAt: p.createdAt, deliveredAt: p.deliveredAt,
      });
      return;
    }
    this.db.prepare(`INSERT INTO work_events_outbox (
      event_id,dedupe_key,event_type,work_id,binding_id,intent_revision,state_version,owner_epoch,
      request_id,causal_event_id,payload_json,delivery_status,attempt_id,attempt_count,created_at,delivered_at
    ) VALUES (@eventId,@dedupeKey,@eventType,@workId,@bindingId,@intentRevision,@stateVersion,@ownerEpoch,
      @requestId,@causalEventId,@payloadJson,@deliveryStatus,@attemptId,@attemptCount,@createdAt,@deliveredAt)`).run(p);
  }

  getOutbox(eventId: string): WorkOutboxInstructionDto | undefined {
    const row = overlayReadOne<OutboxRow & Record<string, unknown>>(this.db, "work_events_outbox", eventId, () =>
      this.db.prepare("SELECT * FROM work_events_outbox WHERE event_id=?").get(eventId) as (OutboxRow & Record<string, unknown>) | undefined);
    return row ? mapOutbox(row) : undefined;
  }

  listOutbox(workId: string, statuses?: WorkOutboxInstructionDto["deliveryStatus"][]): WorkOutboxInstructionDto[] {
    const dbRows = (statuses?.length
      ? this.db.prepare(`SELECT * FROM work_events_outbox WHERE work_id=? AND delivery_status IN (${statuses.map(() => "?").join(",")}) ORDER BY created_at ASC`)
        .all(workId, ...statuses)
      : this.db.prepare("SELECT * FROM work_events_outbox WHERE work_id=? ORDER BY created_at ASC").all(workId)) as Array<OutboxRow & Record<string, unknown>>;
    const statusSet = statuses?.length ? new Set(statuses) : undefined;
    return overlayFindAll(this.db, "work_events_outbox", dbRows, r => String(r.event_id),
      r => r.work_id === workId && (!statusSet || statusSet.has(r.delivery_status)),
      (a, b) => Number(a.created_at) - Number(b.created_at)).map(mapOutbox);
  }

  markOutboxAttempt(eventId: string, attemptId: string): void {
    if (requiresWorkRustWrites(this.db)) {
      overlayMutate(this.db, "work_events_outbox", eventId, () =>
        this.db.prepare("SELECT * FROM work_events_outbox WHERE event_id=?").get(eventId) as Record<string, unknown> | undefined,
      cur => cur ? { ...cur, delivery_status: "attempted", attempt_id: attemptId, attempt_count: Number(cur.attempt_count ?? 0) + 1 } : cur);
      enqueueWorkOp(this.db, { op: "workOutboxUpdate", eventId, mode: "attempt", attemptId, status: null, now: null });
      return;
    }
    this.db.prepare("UPDATE work_events_outbox SET delivery_status='attempted', attempt_id=?, attempt_count=attempt_count+1 WHERE event_id=?")
      .run(attemptId, eventId);
  }

  markOutboxDelivered(eventId: string, now: number): void {
    if (requiresWorkRustWrites(this.db)) {
      overlayMutate(this.db, "work_events_outbox", eventId, () =>
        this.db.prepare("SELECT * FROM work_events_outbox WHERE event_id=?").get(eventId) as Record<string, unknown> | undefined,
      cur => cur ? { ...cur, delivery_status: "delivered", delivered_at: now } : cur);
      enqueueWorkOp(this.db, { op: "workOutboxUpdate", eventId, mode: "delivered", attemptId: null, status: null, now });
      return;
    }
    this.db.prepare("UPDATE work_events_outbox SET delivery_status='delivered', delivered_at=? WHERE event_id=?")
      .run(now, eventId);
  }

  markOutboxStatus(eventId: string, status: WorkOutboxInstructionDto["deliveryStatus"]): void {
    if (requiresWorkRustWrites(this.db)) {
      overlayMutate(this.db, "work_events_outbox", eventId, () =>
        this.db.prepare("SELECT * FROM work_events_outbox WHERE event_id=?").get(eventId) as Record<string, unknown> | undefined,
      cur => cur ? { ...cur, delivery_status: status } : cur);
      enqueueWorkOp(this.db, { op: "workOutboxUpdate", eventId, mode: "status", attemptId: null, status, now: null });
      return;
    }
    this.db.prepare("UPDATE work_events_outbox SET delivery_status=? WHERE event_id=?").run(status, eventId);
  }

  // ---------------------------------------------------------- notifications

  insertNotification(notification: WorkNotificationDto): boolean {
    const p = {
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
    };
    if (requiresWorkRustWrites(this.db)) {
      const dbExisting = this.db.prepare("SELECT * FROM work_notifications WHERE notification_id=? OR semantic_key=?")
        .all(notification.notificationId, notification.semanticKey) as Array<Record<string, unknown>>;
      const existing = overlayFindAll(this.db, "work_notifications", dbExisting, r => String(r.notification_id),
        r => r.notification_id === notification.notificationId || r.semantic_key === notification.semanticKey)[0];
      enqueueWorkOp(this.db, {
        op: "workNotificationInsert",
        notificationId: p.notificationId, workId: p.workId, semanticKey: p.semanticKey, kind: p.kind,
        title: p.title, body: p.body, stateVersion: p.stateVersion, intentRevision: p.intentRevision,
        delivery: p.delivery, channel: p.channel, idempotencyKey: p.idempotencyKey,
        attemptCount: p.attemptCount, externalReceipt: p.externalReceipt, readAt: p.readAt,
        createdAt: p.createdAt, sentAt: p.sentAt, cardKey: p.cardKey, effectKey: p.effectKey, targetKey: p.targetKey,
      });
      if (existing) return false;
      overlaySet(this.db, "work_notifications", p.notificationId, {
        notification_id: p.notificationId, work_id: p.workId, semantic_key: p.semanticKey, kind: p.kind,
        title: p.title, body: p.body, state_version: p.stateVersion, intent_revision: p.intentRevision,
        delivery: p.delivery, channel: p.channel, idempotency_key: p.idempotencyKey,
        attempt_count: p.attemptCount, external_receipt: p.externalReceipt, read_at: p.readAt,
        created_at: p.createdAt, sent_at: p.sentAt, card_key: p.cardKey, effect_key: p.effectKey, target_key: p.targetKey,
      });
      const w = this.getWork(p.workId);
      if (w) {
        overlaySet(this.db, "work_notification_identity", p.notificationId, {
          notification_id: p.notificationId, input_snapshot_id: w.inputSnapshotId,
          owner_epoch: w.ownerEpoch, sender_bot_id: w.ownerBotId, semantic_validity: "active",
        });
      }
      return true;
    }
    const result = this.db.prepare(`INSERT OR IGNORE INTO work_notifications (
      notification_id,work_id,semantic_key,kind,title,body,state_version,intent_revision,delivery,
      channel,idempotency_key,attempt_count,external_receipt,read_at,created_at,sent_at,card_key,effect_key,target_key
    ) VALUES (@notificationId,@workId,@semanticKey,@kind,@title,@body,@stateVersion,@intentRevision,@delivery,
      @channel,@idempotencyKey,@attemptCount,@externalReceipt,@readAt,@createdAt,@sentAt,@cardKey,@effectKey,@targetKey)`).run(p);
    return result.changes > 0;
  }

  /** Link an existing intent to its card or provider effect without touching delivery. */
  updateNotificationLinks(notificationId: string, params: { cardKey?: string; effectKey?: string; targetKey?: string }): void {
    if (requiresWorkRustWrites(this.db)) {
      overlayMutate(this.db, "work_notifications", notificationId, () =>
        this.db.prepare("SELECT * FROM work_notifications WHERE notification_id=?").get(notificationId) as Record<string, unknown> | undefined,
      cur => cur ? {
        ...cur, card_key: params.cardKey ?? cur.card_key, effect_key: params.effectKey ?? cur.effect_key,
        target_key: params.targetKey ?? cur.target_key,
      } : cur);
      enqueueWorkOp(this.db, {
        op: "workNotificationUpdate", notificationId, mode: "links",
        delivery: null, channel: null, attemptCount: null, externalReceipt: null, sentAt: null,
        idempotencyKey: null, cardKey: params.cardKey ?? null, effectKey: params.effectKey ?? null,
        targetKey: params.targetKey ?? null, readAt: null,
      });
      return;
    }
    this.db.prepare(`UPDATE work_notifications SET card_key=COALESCE(?,card_key), effect_key=COALESCE(?,effect_key),
      target_key=COALESCE(?,target_key) WHERE notification_id=?`)
      .run(params.cardKey ?? null, params.effectKey ?? null, params.targetKey ?? null, notificationId);
  }

  listWorksForNotifications(): WorkDto[] {
    const dbPending = this.db.prepare("SELECT * FROM work_notifications WHERE delivery IN ('pending','unknown')")
      .all() as Array<Record<string, unknown>>;
    const workIds = new Set(overlayFindAll(this.db, "work_notifications", dbPending, r => String(r.notification_id),
      r => r.delivery === "pending" || r.delivery === "unknown").map(r => String(r.work_id)));
    const works: WorkDto[] = [];
    for (const id of workIds) {
      const w = this.getWork(id);
      if (w) works.push(w);
    }
    works.sort((a, b) => b.updatedAt - a.updatedAt);
    return works;
  }

  listNotifications(workId: string): WorkNotificationDto[] {
    const dbRows = this.db.prepare("SELECT * FROM work_notifications WHERE work_id=? ORDER BY created_at DESC")
      .all(workId) as Array<NotificationRow & Record<string, unknown>>;
    return overlayFindAll(this.db, "work_notifications", dbRows, r => String(r.notification_id),
      r => r.work_id === workId, (a, b) => Number(b.created_at) - Number(a.created_at)).map(mapNotification);
  }

  getNotification(notificationId: string): WorkNotificationDto | undefined {
    const row = overlayReadOne<NotificationRow & Record<string, unknown>>(this.db, "work_notifications", notificationId, () =>
      this.db.prepare("SELECT * FROM work_notifications WHERE notification_id=?").get(notificationId) as (NotificationRow & Record<string, unknown>) | undefined);
    return row ? mapNotification(row) : undefined;
  }

  updateNotificationDelivery(notificationId: string, params: {
    delivery: WorkNotificationDelivery; channel?: string; attemptCount?: number;
    externalReceipt?: string; sentAt?: number; idempotencyKey?: string;
  }): void {
    if (requiresWorkRustWrites(this.db)) {
      overlayMutate(this.db, "work_notifications", notificationId, () =>
        this.db.prepare("SELECT * FROM work_notifications WHERE notification_id=?").get(notificationId) as Record<string, unknown> | undefined,
      cur => cur ? {
        ...cur, delivery: params.delivery, channel: params.channel ?? cur.channel,
        attempt_count: params.attemptCount ?? cur.attempt_count,
        external_receipt: params.externalReceipt ?? cur.external_receipt,
        sent_at: params.sentAt ?? cur.sent_at,
        idempotency_key: params.idempotencyKey ?? cur.idempotency_key,
      } : cur);
      enqueueWorkOp(this.db, {
        op: "workNotificationUpdate", notificationId, mode: "delivery",
        delivery: params.delivery, channel: params.channel ?? null, attemptCount: params.attemptCount ?? null,
        externalReceipt: params.externalReceipt ?? null, sentAt: params.sentAt ?? null,
        idempotencyKey: params.idempotencyKey ?? null, cardKey: null, effectKey: null, targetKey: null, readAt: null,
      });
      return;
    }
    this.db.prepare(`UPDATE work_notifications SET delivery=?, channel=COALESCE(?,channel),
      attempt_count=COALESCE(?,attempt_count), external_receipt=COALESCE(?,external_receipt),
      sent_at=COALESCE(?,sent_at), idempotency_key=COALESCE(?,idempotency_key) WHERE notification_id=?`)
      .run(params.delivery, params.channel ?? null, params.attemptCount ?? null,
        params.externalReceipt ?? null, params.sentAt ?? null, params.idempotencyKey ?? null, notificationId);
  }

  markNotificationRead(notificationId: string, now: number): void {
    if (requiresWorkRustWrites(this.db)) {
      overlayMutate(this.db, "work_notifications", notificationId, () =>
        this.db.prepare("SELECT * FROM work_notifications WHERE notification_id=?").get(notificationId) as Record<string, unknown> | undefined,
      cur => cur ? { ...cur, read_at: now } : cur);
      enqueueWorkOp(this.db, {
        op: "workNotificationUpdate", notificationId, mode: "read",
        delivery: null, channel: null, attemptCount: null, externalReceipt: null, sentAt: null,
        idempotencyKey: null, cardKey: null, effectKey: null, targetKey: null, readAt: now,
      });
      return;
    }
    this.db.prepare("UPDATE work_notifications SET read_at=? WHERE notification_id=?").run(now, notificationId);
  }

  /** Move a stale completion card to "superseded by newer requirement" without deleting history. */
  supersedeNotifications(workId: string, intentRevision: number, inputSnapshotId: string): void {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_notification_identity'").get()) return;
    if (requiresWorkRustWrites(this.db)) {
      const results = this.listNotifications(workId).filter(n => n.kind === "result");
      for (const n of results) {
        const idRow = overlayReadOne<Record<string, unknown>>(this.db, "work_notification_identity", n.notificationId, () =>
          this.db.prepare("SELECT * FROM work_notification_identity WHERE notification_id=?").get(n.notificationId) as Record<string, unknown> | undefined);
        if (idRow && (n.intentRevision !== intentRevision || idRow.input_snapshot_id !== inputSnapshotId)) {
          overlaySet(this.db, "work_notification_identity", n.notificationId, { ...idRow, semantic_validity: "superseded" });
        }
      }
      enqueueWorkOp(this.db, {
        op: "workNotificationIdentityUpdate", mode: "supersedeByWork", workId, notificationId: null,
        intentRevision, inputSnapshotId, ownerEpoch: null, senderBotId: null, semanticValidity: null,
      });
      return;
    }
    this.db.prepare(`UPDATE work_notification_identity SET semantic_validity='superseded' WHERE notification_id IN (
      SELECT n.notification_id FROM work_notifications n WHERE n.work_id=? AND n.kind='result'
      AND (n.intent_revision<>? OR work_notification_identity.input_snapshot_id<>?))`)
      .run(workId, intentRevision, inputSnapshotId);
  }

  cancelPendingResultNotifications(workId: string): void {
    if (!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='work_notification_identity'").get()) return;
    if (requiresWorkRustWrites(this.db)) {
      for (const n of this.listNotifications(workId).filter(item => item.kind === "result")) {
        overlayMutate(this.db, "work_notification_identity", n.notificationId, () =>
          this.db.prepare("SELECT * FROM work_notification_identity WHERE notification_id=?").get(n.notificationId) as Record<string, unknown> | undefined,
        cur => cur ? { ...cur, semantic_validity: "cancelled" } : cur);
      }
      enqueueWorkOp(this.db, {
        op: "workNotificationIdentityUpdate", mode: "cancelPendingByWork", workId, notificationId: null,
        intentRevision: null, inputSnapshotId: null, ownerEpoch: null, senderBotId: null, semanticValidity: null,
      });
      return;
    }
    this.db.prepare(`UPDATE work_notification_identity SET semantic_validity='cancelled' WHERE notification_id IN (
      SELECT notification_id FROM work_notifications WHERE work_id=? AND kind='result')`).run(workId);
  }

  // ------------------------------------------------------------- telemetry

  recordTelemetry(params: {
    workId: string; executionId?: string; streamingText?: string; tokensPerSecond?: number; now: number;
  }): void {
    if (requiresWorkRustWrites(this.db)) {
      overlayMutate(this.db, "work_telemetry_state", params.workId, () =>
        this.db.prepare("SELECT * FROM work_telemetry_state WHERE work_id=?").get(params.workId) as Record<string, unknown> | undefined,
      cur => ({
        work_id: params.workId,
        active_execution_id: params.executionId ?? cur?.active_execution_id ?? null,
        streaming_text: params.streamingText ?? cur?.streaming_text ?? null,
        tokens_per_second: params.tokensPerSecond ?? cur?.tokens_per_second ?? null,
        last_heartbeat_at: params.now,
        updated_at: params.now,
      }));
      enqueueWorkOp(this.db, {
        op: "workTelemetryUpsert", workId: params.workId,
        executionId: params.executionId ?? null, streamingText: params.streamingText ?? null,
        tokensPerSecond: params.tokensPerSecond ?? null, now: params.now,
      });
      return;
    }
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
