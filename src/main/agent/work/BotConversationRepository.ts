import { botClarificationSchema } from "../../../shared/bot-conversation";
import { botOrganizationsForMessage } from "./BotOrganizationProjection";
import { BotForegroundMetricsStore } from "./BotForegroundMetrics";
import { BotPeerCallRepository } from "./BotPeerCallRepository";
import { BotCollaborationRepository } from "./BotCollaborationRepository";
import { botInboxId } from "./WorkDeliveryTargets";
import type Database from "better-sqlite3";
import { z } from "zod";
import { botActivitySchema, botReplySegmentSchema, botAttachmentSchema, botMessageSchema, workFeedbackSchema, type BotHistoryDto, type BotHistoryRequest, type BotMessageDto } from "../../../shared/bot-conversation";
import { BotPeerIngress } from "./BotPeerIngress";
import { settleBotCapabilityTools } from "./BotCapabilityPresentation";
import { delegatedReplyWorkIds } from "./BotDelegatedTaskProjection";
import type { ChatToolCallDto } from "../../../shared/agent-ipc";
import type { RuntimeBotHistoryFacts, RuntimeBotHistoryPage } from "./BotHistoryData";
import { overlayFindAll, overlayHasTable, overlayReadOne } from "./WorkDomainRuntime";

const conversationRow = z.object({ conversation_id: z.string(), bot_id: z.string(), team_id: z.string().nullable().optional(), user_id: z.string(), revision: z.number(),
  current_request_id: z.string().nullable(), archived_at: z.number().nullable(), created_at: z.number(), updated_at: z.number() });
export type BotConversation = z.infer<typeof conversationRow>;
const receiptRow = z.object({ user_id: z.string(), bot_id: z.string(), request_id: z.string(), payload_hash: z.string(),
  conversation_id: z.string(), user_message_id: z.string(), assistant_message_id: z.string(),
  selected_work_id: z.string().nullable(), reference_message_id: z.string().nullable() });
type BotMessageReceipt = z.infer<typeof receiptRow>;
const messageRow = z.object({ message_id: z.string(), conversation_id: z.string(), bot_id: z.string(), request_id: z.string(),
  ordinal: z.number(), role: botMessageSchema.shape.role, text: z.string(), status: botMessageSchema.shape.status,
  work_ids_json: z.string(), error: z.string().nullable(), created_at: z.number(), updated_at: z.number() });
type MessageRow = z.infer<typeof messageRow>;

export class BotConversationRepository {
  readonly metrics: BotForegroundMetricsStore;
  readonly peerCalls: BotPeerCallRepository;
  readonly collaborations: BotCollaborationRepository;
  readonly peers: BotPeerIngress;
  constructor(readonly db: Database.Database) {
    this.metrics = new BotForegroundMetricsStore(db);
    this.peerCalls = new BotPeerCallRepository(db);
    this.collaborations = new BotCollaborationRepository(db);
    this.peers = new BotPeerIngress(db);
  }

  private getConvRaw(conversationId: string): Record<string, unknown> | undefined {
    return overlayReadOne(this.db, "bot_conversations", conversationId, () =>
      this.db.prepare("SELECT * FROM bot_conversations WHERE conversation_id=?").get(conversationId) as Record<string, unknown> | undefined);
  }

  private getMessageRaw(messageId: string): Record<string, unknown> | undefined {
    return overlayReadOne(this.db, "bot_messages", messageId, () =>
      this.db.prepare("SELECT * FROM bot_messages WHERE message_id=?").get(messageId) as Record<string, unknown> | undefined);
  }

  private hasGatewayConversation(conversationId: string): boolean {
    const row = overlayReadOne(this.db, "bot_gateway_conversations", conversationId, () =>
      this.db.prepare("SELECT * FROM bot_gateway_conversations WHERE conversation_id=?").get(conversationId) as Record<string, unknown> | undefined);
    return Boolean(row);
  }

  private feedbackForMessage(messageId: string): { message_id: string; metadata_json: string } | undefined {
    return overlayReadOne<{ message_id: string; metadata_json: string }>(this.db, "bot_work_feedback", messageId, () =>
      this.db.prepare("SELECT * FROM bot_work_feedback WHERE message_id=?").get(messageId) as { message_id: string; metadata_json: string } | undefined);
  }

  conversation(userId: string, botId: string, conversationId?: string, teamId?: string): BotConversation | undefined {
    // An explicit historical receipt retains its original executing Bot.
    // Callers validate team scope separately.
    if (conversationId) {
      const row = this.getConvRaw(conversationId);
      if (!row || row.user_id !== userId || (row.bot_id !== botId && (row.team_id ?? null) === null)) return undefined;
      return conversationRow.parse(row);
    }
    if (teamId) {
      const dbRows = this.db.prepare("SELECT * FROM bot_conversations WHERE user_id=? AND team_id=? AND archived_at IS NULL")
        .all(userId, teamId) as Array<Record<string, unknown>>;
      const row = overlayFindAll(this.db, "bot_conversations", dbRows, r => String(r.conversation_id),
        r => r.user_id === userId && r.team_id === teamId && (r.archived_at ?? null) === null)[0];
      return row ? conversationRow.parse(row) : undefined;
    }
    const dbRows = this.db.prepare(`SELECT c.* FROM bot_conversations c WHERE user_id=? AND bot_id=? AND team_id IS NULL AND archived_at IS NULL AND ingress_kind='desktop' AND source_kind='user'
      AND NOT EXISTS(SELECT 1 FROM bot_gateway_conversations g WHERE g.conversation_id=c.conversation_id)`)
      .all(userId, botId) as Array<Record<string, unknown>>;
    const row = overlayFindAll(this.db, "bot_conversations", dbRows, r => String(r.conversation_id),
      r => r.user_id === userId && r.bot_id === botId && (r.team_id ?? null) === null
        && (r.archived_at ?? null) === null && (r.ingress_kind ?? "desktop") === "desktop" && (r.source_kind ?? "user") === "user"
        && !this.hasGatewayConversation(String(r.conversation_id)))[0];
    return row ? conversationRow.parse(row) : undefined;
  }

  private assertScope(conversation: BotConversation | undefined, teamId?: string): void {
    if (conversation && (conversation.team_id ?? undefined) !== teamId) throw new Error("对话不属于当前团队或个人空间");
  }

  private receipt(userId: string, botId: string, requestId: string): BotMessageReceipt | undefined {
    const row = overlayReadOne(this.db, "bot_send_receipts", `${userId}\0${botId}\0${requestId}`, () =>
      this.db.prepare("SELECT * FROM bot_send_receipts WHERE user_id=? AND bot_id=? AND request_id=?").get(userId, botId, requestId) as Record<string, unknown> | undefined);
    return row ? receiptRow.parse(row) : undefined;
  }

  message(messageId: string): BotMessageDto | undefined {
    const row = this.getMessageRaw(messageId);
    return row ? this.mapMessage(row) : undefined;
  }

  /** Image recovery only needs host feedback messages. Filter the current DB
   * before mapping unrelated attachments/metrics/segments; never trust a stale
   * history DTO to decide whether feedback has since been added. */
  messageWithWorkFeedback(messageId: string): BotMessageDto | undefined {
    const row = this.getMessageRaw(messageId);
    if (!row || row.role !== "assistant" || !this.feedbackForMessage(messageId)) return undefined;
    return this.mapMessage(row);
  }

  history(userId: string, request: BotHistoryRequest): BotHistoryDto {
    const conversation = this.conversation(userId, request.botId, request.inbox ? botInboxId(userId, request.botId) : request.conversationId, request.teamId);
    this.assertScope(conversation, request.teamId);
    if (!conversation) return this.emptyHistory(request);
    // Query each disjoint source using its conversation/ordinal index. A single
    // OR scans unrelated messages; a feedback-driven UNION instead scans/sorts
    // all feedback when an inbox is large. Each source contributes at most 101
    // rows, and the rolling merge keeps the same bounded global page.
    const ascending = request.after !== undefined;
    const before = request.before ?? Number.MAX_SAFE_INTEGER;
    const after = request.after ?? 0;
    const idSet = request.messageIds ? new Set(request.messageIds) : undefined;
    const cmp = (a: Record<string, unknown>, b: Record<string, unknown>) =>
      ascending ? Number(a.ordinal) - Number(b.ordinal) : Number(b.ordinal) - Number(a.ordinal);
    const idsSql = request.messageIds ? "AND m.message_id IN (SELECT value FROM json_each(@ids))" : "";
    const params = { conversationId: conversation.conversation_id, before, after, ids: JSON.stringify(request.messageIds ?? []) };
    const pageSql = `SELECT m.* FROM bot_messages m WHERE m.conversation_id=@sourceId
      AND m.ordinal<@before AND m.ordinal>@after ${idsSql}`;
    const mainDbRows = this.db.prepare(pageSql + ` ORDER BY m.ordinal ${ascending ? "ASC" : "DESC"} LIMIT 101`)
      .all({ ...params, sourceId: conversation.conversation_id }) as Array<Record<string, unknown>>;
    let rows = overlayFindAll(this.db, "bot_messages", mainDbRows, r => String(r.message_id),
      r => r.conversation_id === conversation!.conversation_id && Number(r.ordinal) < before && Number(r.ordinal) > after
        && (!idSet || idSet.has(String(r.message_id))), cmp).slice(0, 101);
    const dbInboxes = this.db.prepare(`SELECT conversation_id FROM bot_conversations
      WHERE user_id=? AND conversation_id LIKE 'bot-inbox-%' AND conversation_id<>?`)
      .all(userId, conversation.conversation_id) as Array<{ conversation_id: string }>;
    const inboxes = overlayFindAll(this.db, "bot_conversations", dbInboxes.map(r => ({ conversation_id: r.conversation_id, user_id: userId })),
      r => String(r.conversation_id),
      r => r.user_id === userId && String(r.conversation_id).startsWith("bot-inbox-") && r.conversation_id !== conversation!.conversation_id);
    if (inboxes.length) {
      const useIndexedSqlExists = !overlayHasTable(this.db, "bot_messages")
        && !overlayHasTable(this.db, "bot_work_feedback")
        && !overlayHasTable(this.db, "work_conversations");
      if (useIndexedSqlExists) {
        const linkedSql = this.db.prepare(pageSql + ` AND EXISTS (
          SELECT 1 FROM bot_work_feedback f JOIN work_conversations t ON t.work_id=json_extract(f.metadata_json,'$.workId')
          WHERE f.message_id=m.message_id AND t.channel_type='bot-delivery' AND t.conversation_id=@conversationId
        ) ORDER BY m.ordinal ${ascending ? "ASC" : "DESC"} LIMIT 101`);
        for (const inbox of inboxes) {
          const edge = rows.length === 101 ? Number(rows[100].ordinal) : undefined;
          const inboxBefore = ascending && edge !== undefined ? Math.min(params.before, edge) : params.before;
          const inboxAfter = !ascending && edge !== undefined ? Math.max(params.after, edge) : params.after;
          const linked = linkedSql.all({ ...params, sourceId: String(inbox.conversation_id), before: inboxBefore, after: inboxAfter }) as Array<Record<string, unknown>>;
          const byId = new Map<string, Record<string, unknown>>();
          for (const r of rows) byId.set(String(r.message_id), r);
          for (const r of linked) byId.set(String(r.message_id), r);
          rows = [...byId.values()].sort(cmp).slice(0, 101);
        }
      } else {
        const dbDeliveryWorks = this.db.prepare("SELECT work_id FROM work_conversations WHERE channel_type='bot-delivery' AND conversation_id=?")
          .all(conversation.conversation_id) as Array<{ work_id: string }>;
        const deliveryWorks = new Set(overlayFindAll(this.db, "work_conversations",
          dbDeliveryWorks.map(r => ({ work_id: r.work_id, conversation_id: conversation!.conversation_id, channel_type: "bot-delivery" })),
          r => `${r.work_id}\0${r.conversation_id}`,
          r => r.channel_type === "bot-delivery" && r.conversation_id === conversation!.conversation_id).map(r => String(r.work_id)));
        const linkedSql = this.db.prepare(pageSql + ` ORDER BY m.ordinal ${ascending ? "ASC" : "DESC"}`);
        for (const inbox of inboxes) {
          const edge = rows.length === 101 ? Number(rows[100].ordinal) : undefined;
          const inboxBefore = ascending && edge !== undefined ? Math.min(params.before, edge) : params.before;
          const inboxAfter = !ascending && edge !== undefined ? Math.max(params.after, edge) : params.after;
          const dbCandidates = linkedSql.all({ ...params, sourceId: String(inbox.conversation_id), before: inboxBefore, after: inboxAfter }) as Array<Record<string, unknown>>;
          const linked = overlayFindAll(this.db, "bot_messages", dbCandidates, r => String(r.message_id), r => {
            if (r.conversation_id !== inbox.conversation_id) return false;
            const ord = Number(r.ordinal);
            if (!(ord < inboxBefore && ord > inboxAfter)) return false;
            if (idSet && !idSet.has(String(r.message_id))) return false;
            const fb = this.feedbackForMessage(String(r.message_id));
            if (!fb) return false;
            const meta = JSON.parse(fb.metadata_json) as { workId?: string };
            return Boolean(meta.workId && deliveryWorks.has(meta.workId));
          }, cmp).slice(0, 101);
          const byId = new Map<string, Record<string, unknown>>();
          for (const r of rows) byId.set(String(r.message_id), r);
          for (const r of linked) byId.set(String(r.message_id), r);
          rows = [...byId.values()].sort(cmp).slice(0, 101);
        }
      }
    }
    const messages = rows.slice(0, 100).map(row => this.mapMessage(row));
    if (request.after === undefined) messages.reverse();
    return { conversationId: conversation.conversation_id, botId: request.botId, teamId: request.teamId, revision: conversation.revision,
      archived: conversation.archived_at !== null, messages, before: !request.messageIds && (request.after !== undefined || rows.length > 100) ? messages[0]?.ordinal : undefined };
  }

  projectHistoryPage(request: BotHistoryRequest, page: Exclude<RuntimeBotHistoryPage, { kind: "needsHost" }>): BotHistoryDto {
    if (page.kind === "scopeMismatch") throw new Error("对话不属于当前团队或个人空间");
    if (page.kind === "missing") return this.emptyHistory(request);
    return {
      conversationId: page.conversationId, botId: request.botId, teamId: request.teamId,
      revision: page.revision, archived: page.archived, before: page.before ?? undefined,
      messages: page.rows.map(row => this.mapMessage(row, row)),
    };
  }

  private emptyHistory(request: BotHistoryRequest): BotHistoryDto {
    return { conversationId: "", botId: request.botId, teamId: request.teamId, revision: 0, archived: false, messages: [] };
  }

  /** Resolve the original authenticated send, never the current owner or active chat. */
  workOrigin(userId: string, workId: string): BotConversation | undefined {
    const work = overlayReadOne(this.db, "works", workId, () =>
      this.db.prepare("SELECT work_id, user_id, source_message_id FROM works WHERE work_id=?").get(workId) as Record<string, unknown> | undefined);
    if (!work || work.user_id !== userId) return undefined;
    const dbReceipts = this.db.prepare("SELECT * FROM bot_send_receipts WHERE user_id=?").all(userId) as Array<Record<string, unknown>>;
    const receipts = overlayFindAll(this.db, "bot_send_receipts", dbReceipts,
      r => `${r.user_id}\0${r.bot_id}\0${r.request_id}`, r => r.user_id === userId);
    const candidates: Array<{ conv: BotConversation; ordinal: number }> = [];
    for (const r of receipts) {
      const m = this.getMessageRaw(String(r.user_message_id));
      const c = this.getConvRaw(String(r.conversation_id));
      if (!m || !c || c.user_id !== userId || m.conversation_id !== c.conversation_id || m.bot_id !== r.bot_id || m.request_id !== r.request_id || m.role !== "user") continue;
      const workIds = z.array(z.string()).parse(JSON.parse(String(m.work_ids_json)));
      if (m.message_id === work.source_message_id || workIds.includes(workId)) {
        candidates.push({ conv: conversationRow.parse(c), ordinal: Number(m.ordinal) });
      }
    }
    candidates.sort((a, b) => a.ordinal - b.ordinal);
    return candidates[0]?.conv;
  }

  private messageFacts(row: MessageRow): RuntimeBotHistoryFacts {
    const conv = this.getConvRaw(row.conversation_id);
    const receipt = conv ? this.receipt(String(conv.user_id), row.bot_id, row.request_id) : undefined;
    const referenceMessageId = receipt && receipt.conversation_id === row.conversation_id && receipt.assistant_message_id === row.message_id
      ? receipt.reference_message_id : null;
    const scope = conv ? { team_id: (conv.team_id as string | null | undefined) ?? null, user_id: String(conv.user_id), reference_message_id: referenceMessageId } : undefined;
    const version = overlayReadOne<{ revision: number }>(this.db, "bot_message_revisions", row.message_id, () =>
      this.db.prepare('SELECT message_id, revision FROM bot_message_revisions WHERE message_id=?').get(row.message_id) as { message_id: string; revision: number } | undefined);
    const attachmentRow = overlayReadOne<{ attachments_json: string }>(this.db, "bot_message_attachments", row.message_id, () =>
      this.db.prepare("SELECT message_id, attachments_json FROM bot_message_attachments WHERE message_id=?").get(row.message_id) as { message_id: string; attachments_json: string } | undefined);
    const metadata = this.feedbackForMessage(row.message_id);
    const activityRow = row.status === "running"
      ? overlayReadOne<{ activity_json: string }>(this.db, "bot_message_activity", row.message_id, () =>
        this.db.prepare("SELECT message_id, activity_json FROM bot_message_activity WHERE message_id=?").get(row.message_id) as { message_id: string; activity_json: string } | undefined)
      : undefined;
    const segmentRow = row.role === "assistant"
      ? overlayReadOne<{ segments_json: string }>(this.db, "bot_message_segments", row.message_id, () =>
        this.db.prepare("SELECT message_id, segments_json FROM bot_message_segments WHERE message_id=?").get(row.message_id) as { message_id: string; segments_json: string } | undefined)
      : undefined;
    const toolRow = row.role === "assistant"
      ? overlayReadOne<{ task_id: string; tools_json: string }>(this.db, "bot_message_tools", row.message_id, () =>
        this.db.prepare("SELECT message_id, task_id, tools_json FROM bot_message_tools WHERE message_id=?").get(row.message_id) as { message_id: string; task_id: string; tools_json: string } | undefined)
      : undefined;
    return {
      team_id: scope?.team_id ?? null, user_id: scope?.user_id ?? null, reference_message_id: scope?.reference_message_id ?? null,
      revision: version?.revision ?? 0, attachments_json: attachmentRow?.attachments_json ?? null,
      metadata_json: metadata?.metadata_json ?? null, activity_json: activityRow?.activity_json ?? null,
      segments_json: segmentRow?.segments_json ?? null, tool_task_id: toolRow?.task_id ?? null, tools_json: toolRow?.tools_json ?? null,
    };
  }

  private mapMessage(value: unknown, storedFacts?: RuntimeBotHistoryFacts): BotMessageDto {
    const row = messageRow.parse(value);
    const facts = storedFacts ?? this.messageFacts(row);
    const attachments = facts.attachments_json !== null ? z.array(botAttachmentSchema).parse(JSON.parse(facts.attachments_json)) : undefined;
    const parsed = facts.metadata_json !== null ? workFeedbackSchema.safeParse(JSON.parse(facts.metadata_json)) : undefined;
    const activity = facts.activity_json !== null ? botActivitySchema.safeParse(JSON.parse(facts.activity_json)) : undefined;
    const segments = facts.segments_json !== null ? z.array(botReplySegmentSchema).parse(JSON.parse(facts.segments_json)) : undefined;
    const tools = facts.tools_json !== null ? settleBotCapabilityTools(JSON.parse(facts.tools_json) as ChatToolCallDto[], row.status) : undefined;
    const organizationUser = row.role === "assistant" ? facts.user_id : undefined;
    const organizations = typeof organizationUser === "string" ? botOrganizationsForMessage(this.db, organizationUser, row.message_id) : [];
    const peerOrigin = this.peers.origin(row.message_id);
    const collaborationResult = peerOrigin && typeof organizationUser === "string"
      ? this.collaborations.feedbackForReturn({ userId: organizationUser, botId: row.bot_id, conversationId: row.conversation_id, origin: peerOrigin }) : undefined;
    const clarificationRows = row.role === "assistant" && row.status === "completed" ? this.db.prepare(`SELECT g.value AS goal FROM bot_request_runs r
      JOIN bot_messages m ON m.message_id=r.message_id, json_each(r.context_json,'$.clarificationState.goals') g
      WHERE m.conversation_id=? AND json_extract(g.value,'$.updatedBy')=?`).all(row.conversation_id,row.message_id) as {goal:string}[] : [];
    // Ordinary history must not depend on the optional team-template service schema.
    // Only live interactive goals need a current-owner check.
    const clarificationGoals = clarificationRows.map(value=>JSON.parse(value.goal)).filter(goal=>goal.options);
    const needsTeamOwner = Boolean(facts.team_id && clarificationGoals.some(goal=>goal.state==="pending"));
    const team = needsTeamOwner ? this.db.prepare("SELECT plan_json,deleted_at FROM work_team_templates WHERE template_id=?").get(facts.team_id) as {plan_json:string;deleted_at:number|null}|undefined : undefined;
    const ownerChanged = Boolean(needsTeamOwner && (!team || team.deleted_at!==null || JSON.parse(team.plan_json).ownerBotId!==row.bot_id));
    const clarifications = clarificationGoals.flatMap(goal=>{
      const answerRow = overlayReadOne<{ answer_message_id: string }>(this.db, "bot_clarification_answers", `${row.message_id}\0${goal.goalId}`, () =>
        this.db.prepare("SELECT * FROM bot_clarification_answers WHERE question_message_id=? AND goal_id=?").get(row.message_id, goal.goalId) as { answer_message_id: string } | undefined);
      const answerMsg = answerRow ? this.getMessageRaw(answerRow.answer_message_id) : undefined;
      const answer = answerMsg ? { text: String(answerMsg.text) } : undefined;
      const answered=goal.state==="pending" && Boolean(answer);
      return goal.options ? [botClarificationSchema.parse({goalId:goal.goalId,question:goal.question,options:goal.options,answerText:answer?.text,status:goal.state==="pending"&&ownerChanged ? "expired" : answered ? "answered" : goal.state})] : [];
    });
    return { clarifications, peerOrigin, collaborationResult, ...(organizations.length ? { organizations } : {}), teamId: facts.team_id ?? undefined, messageRevision: facts.revision, messageId: row.message_id, conversationId: row.conversation_id, botId: row.bot_id, requestId: row.request_id,
      referenceMessageId: row.role === "assistant" ? facts.reference_message_id ?? undefined : undefined,
      segments, tools, toolTaskId: facts.tool_task_id ?? undefined, botCalls: row.role === "assistant" ? this.peerCalls.list(row.message_id) : undefined,
      collaborations: row.role === "assistant" ? this.collaborations.summariesForMessage(
        z.string().parse(facts.user_id), row.message_id) : undefined,
      metrics: this.metrics.read(row.message_id), workFeedback: parsed?.success ? parsed.data : undefined, attachments, activity: activity?.success ? activity.data : undefined,
      ordinal: row.ordinal, role: row.role, text: row.text, status: row.status,
      // A delegation's original answer and each authenticated return/request
      // need the Work even when no result report exists or the anchor is paged
      // out. Project only assistants; do not change user control provenance.
      workIds: [...new Set([...z.array(z.string()).parse(JSON.parse(row.work_ids_json)),
        ...(row.role === "assistant" && typeof organizationUser === "string"
          ? delegatedReplyWorkIds(this.db, organizationUser, row.message_id) : [])])], error: row.error ?? undefined,
      createdAt: row.created_at, updatedAt: row.updated_at };
  }
}
