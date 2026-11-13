import { assertBotContactAdmission, botContactIntent } from "./BotContactAdmission";
import { z } from "zod";
import { botPeerOriginSchema, type BotPeerOrigin } from "../../../shared/bot-peer-origin";
import type { BotSendReceipt } from "../../../shared/bot-conversation";
import { botMessageSchema } from "../../../shared/bot-conversation";
import type { BotCollaborationDto } from "../../../shared/bot-collaboration";
import { botCollaborationMessageSchema } from "../../../shared/bot-collaboration";
import type { BotConversationRepository, BotMessageReceipt } from "./BotConversationRepository";
import type { BotConversationServiceOptions } from "./BotConversationService";
import { BotCollaborationRepository } from "./BotCollaborationRepository";
import { peerKey, type BotPeerDelivery } from "./BotPeerIngress";

export interface BotCollaborationHost {
  accept(delivery: BotPeerDelivery, guard?: () => void): Promise<BotSendReceipt>;
  cancel(botId: string, requestId: string): Promise<void>;
}

/** Narrow adapter to the existing foreground queue, with a durable outbox. */
export class BotCollaborationDelivery {
  private readonly inflight = new Map<string, Promise<void>>();
  private closing = false;
  close(): void { this.closing = true; }
  constructor(private readonly options: BotConversationServiceOptions, private readonly messages: BotConversationRepository,
    private readonly repo: BotCollaborationRepository, private readonly host: BotCollaborationHost,
    private readonly publish: (messageId: string) => void) {}

  async send(row: BotCollaborationDto, source: BotMessageReceipt, operationId: string, text: string, guard?: () => void,
    configuration?: Extract<BotPeerOrigin, { kind: "request" }>["configuration"],
    review?: Extract<BotPeerOrigin, { kind: "request" }>["review"]): Promise<void> {
    const origin: BotPeerOrigin = { kind: "request", collaborationId: row.collaborationId, exchangeId: operationId,
      senderBotId: row.sourceBotId, senderDisplayName: row.sourceDisplayName,
      sourceBotId: source.bot_id, sourceConversationId: source.conversation_id, sourceRequestId: source.request_id,
      sourceUserMessageId: source.user_message_id, sourceAssistantMessageId: source.assistant_message_id, ...(configuration ? { configuration } : {}), ...(review ? { review } : {}) };
    this.options.works.transaction(() => {
      if (!this.messages.peers.get(operationId)) {
        const current = this.repo.get(this.options.userId, row.collaborationId);
        if (!current || current.sourceBotExists === false || current.targetBotExists === false)
          throw new Error("参与协作的 Bot 已删除，不能创建新的协作发送；历史回执仍保留。");
      }
      assertBotContactAdmission(this.options.db, source,
        review ? botContactIntent(this.options.db, source) : configuration?.organizationIntentId, row.collaborationId);
      guard?.();
      if (this.messages.peers.origin(source.user_message_id)) throw new Error("协作不能把 Bot 转述作为新的用户授权");
      this.messages.peers.prepare(this.options.userId, operationId, origin, text, row.targetBotId);
      this.repo.appendMessage(this.options.userId, row.collaborationId, { operationId, exchangeId: operationId,
        senderBotId: row.sourceBotId, senderDisplayName: row.sourceDisplayName, kind: "request", text });
      this.repo.event(this.options.userId, row.collaborationId, { operationId, exchangeId: operationId, kind: "sent" });
    });
    await this.deliver(operationId, guard);
  }

  private deliver(operationId: string, guard?: () => void): Promise<void> {
    const running = this.inflight.get(operationId);
    if (running) return running;
    const task = this.perform(operationId, guard).finally(() => this.inflight.delete(operationId));
    this.inflight.set(operationId, task);
    return task;
  }
  private async perform(operationId: string, guard?: () => void): Promise<void> {
    const delivery = this.messages.peers.get(operationId);
    if (this.closing || !delivery || delivery.accepted_message_id || delivery.cancelled_at !== null || !this.options.isAuthority()) return;
    const origin = botPeerOriginSchema.parse(JSON.parse(delivery.origin_json));
    try {
      if (origin.kind === "request") {
        const earlier = this.messages.peers.earlier(this.options.userId, origin.collaborationId, operationId);
        if (earlier) await this.deliver(earlier.operation_id);
      }
      if (this.closing) return;
      guard?.();
      await this.host.accept(delivery, guard);
      if (this.closing) return;
      this.options.db.prepare("UPDATE bot_peer_deliveries SET error=NULL WHERE operation_id=?").run(operationId);
    } catch (error) {
      if (this.closing) return;
      const detail = error instanceof Error ? error.message : String(error);
      this.options.db.prepare("UPDATE bot_peer_deliveries SET error=? WHERE operation_id=?").run(detail, operationId);
      if (this.messages.peers.get(operationId)?.cancelled_at !== null) return;
      this.repo.event(this.options.userId, origin.collaborationId, { operationId: `${operationId}:delivery-failure`,
        version: peerKey(detail), kind: "unknown", detail: `前台${origin.kind === "request" ? "受理" : "回传"}待恢复：${detail}` });
      throw error;
    } finally { if (!this.closing) this.publish(origin.sourceAssistantMessageId); }
  }

  /** Called after a foreground message is durably updated, including recovery. */
  observe(messageId: string): void {
    if (this.closing) return;
    const message = this.messages.message(messageId), origin = this.messages.peers.origin(messageId);
    if (!message || message.role !== "assistant" || !origin || !this.options.isAuthority()) return;
    const row = this.repo.get(this.options.userId, origin.collaborationId);
    if (!row) return;
    if (this.messages.peers.get(origin.exchangeId)?.cancelled_at != null) return;
    if (this.messages.peers.get(origin.exchangeId)?.returned_at != null) return;
    if (origin.kind === "return") {
      if (message.status === "completed") {
        const operation = `external:${origin.exchangeId}`;
        if (!this.inflight.has(operation)) {
          const returning = Promise.resolve().then(async () => {
            const delivered = await this.options.deliverPeerReturn?.(origin.sourceUserMessageId, origin.exchangeId, message.text);
            if (delivered === "pending") return;
            if (this.closing || !this.options.isAuthority()) return;
            this.acknowledge(origin.exchangeId);
          }).catch(error => {
            if (this.closing || !this.options.isAuthority()) return;
            const detail = error instanceof Error ? error.message : String(error);
            this.repo.event(this.options.userId, row.collaborationId, { operationId: `${origin.exchangeId}:channel-return`,
              version: peerKey(detail), kind: "unknown", detail: `原渠道回传待核对，正文保留：${detail}` });
          }).finally(() => this.inflight.delete(operation));
          this.inflight.set(operation, returning);
        }
      }
      else if (["failed", "cancelled", "unknown"].includes(message.status)) this.repo.event(this.options.userId, row.collaborationId,
        { operationId: `${origin.exchangeId}:return-failure`, version: peerKey(message.status, message.error ?? ""),
          kind: "unknown", detail: `A 前台整理${message.status === "cancelled" ? "已停止" : "未完成"}，原结果保留，未重新执行业务：${message.error ?? message.status}` });
      return;
    }
    if (message.status === "running") {
      this.repo.event(this.options.userId, row.collaborationId, { operationId: origin.exchangeId, exchangeId: origin.exchangeId, kind: "started" });
      if (message.text.trim()) this.repo.setPreview(this.options.userId, row.collaborationId,
        { exchangeId: origin.exchangeId, senderBotId: row.targetBotId, senderDisplayName: row.targetDisplayName, text: message.text });
      this.options.db.prepare("UPDATE bot_peer_deliveries SET observed_status='running' WHERE operation_id=?").run(origin.exchangeId);
      return;
    }
    if (["cancelled", "failed", "unknown"].includes(message.status)) {
      this.repo.clearPreview(this.options.userId, row.collaborationId, origin.exchangeId);
      this.repo.event(this.options.userId, row.collaborationId, { operationId: `${origin.exchangeId}:${message.status}`,
        kind: message.status === "cancelled" ? "cancelled" : message.status === "failed" ? "failed" : "unknown", detail: message.error,
        version: peerKey(message.error ?? "") });
      this.options.db.prepare("UPDATE bot_peer_deliveries SET observed_status=? WHERE operation_id=?").run(message.status, origin.exchangeId);
      return;
    }
    if (message.status !== "completed") return;
    this.options.works.transaction(() => {
      this.repo.clearPreview(this.options.userId, row.collaborationId, origin.exchangeId);
      const reply = this.repo.appendMessage(this.options.userId, row.collaborationId,
        { operationId: `${origin.exchangeId}:reply`, exchangeId: origin.exchangeId, senderBotId: row.targetBotId,
          senderDisplayName: row.targetDisplayName, kind: row.workId ? "progress" : "reply", text: message.text });
      // Foreground completion never closes a delegated Work.
      this.repo.event(this.options.userId, row.collaborationId,
        { operationId: origin.exchangeId, kind: "ended", exchangeId: origin.exchangeId, createdAt: message.updatedAt,
          detail: row.workId ? "B 前台答复结束；Work 是否结束以执行记录为准" : "B 前台答复结束" });
      this.prepareReturn(row, reply.messageId, message.text);
      this.options.db.prepare("UPDATE bot_peer_deliveries SET observed_status='completed' WHERE operation_id=?").run(origin.exchangeId);
    });
    this.flushReturns();
    this.publish(row.sourceAssistantMessageId);
  }

  private prepareReturn(row: BotCollaborationDto, identity: string, text: string): void {
    const work = row.workId ? this.options.works.getWork(row.workId) : undefined;
    if (work?.lifecycle === "closed" && work.closureConclusion === "cancelled") return;
    if (!this.messages.peers.deliveries(this.options.userId, row.collaborationId).some(delivery =>
      delivery.cancelled_at === null && botPeerOriginSchema.parse(JSON.parse(delivery.origin_json)).kind === "request")) return;
    const operationId = `peer-return:${peerKey(row.collaborationId, identity)}`;
    const origin: BotPeerOrigin = { kind: "return", replyMessageId: identity, collaborationId: row.collaborationId, exchangeId: operationId,
      senderBotId: row.targetBotId, senderDisplayName: row.targetDisplayName,
      sourceBotId: row.sourceBotId, sourceConversationId: row.sourceConversationId, sourceRequestId: row.sourceRequestId,
      sourceUserMessageId: row.sourceUserMessageId, sourceAssistantMessageId: row.sourceAssistantMessageId };
    const body = text.length > 24000 ? `${text.slice(0, 24000)}\n[正文已截断；完整内容保留在原协作记录，可用 bot_collaborate query 读取。]` : text;
    this.messages.peers.prepare(this.options.userId, operationId, origin, body || "目标 Bot 本次没有返回正文。", row.sourceBotId, row.sourceConversationId, identity);
    this.repo.event(this.options.userId, row.collaborationId, { operationId, kind: "returning", ...(row.workId ? { workId: row.workId } : {}) });
  }
  work(workId: string): void {
    if (this.closing) return;
    const row = this.repo.byWork(this.options.userId, workId);
    if (!row || !this.hasIngress(row.collaborationId)) return;
    // Existing Work feedback owns evidence/versioning. Deliver its accepted
    // public reports to A's foreground without replaying the completed business.
    const reports = this.options.db.prepare(`SELECT m.value_json FROM bot_collaboration_messages m
      WHERE m.collaboration_id=? AND json_extract(m.value_json,'$.workFeedback.report') IS NOT NULL
      AND NOT EXISTS(SELECT 1 FROM bot_peer_deliveries d WHERE d.journal_message_id=m.message_id) ORDER BY m.ordinal`).all(row.collaborationId);
    for (const value of reports) {
      const report = botCollaborationMessageSchema.parse(JSON.parse(z.object({ value_json: z.string() }).parse(value).value_json));
      const publicReport = report.workFeedback?.report;
      if (!publicReport) continue;
      this.prepareReturn(row, report.messageId, `${publicReport.title}\n${publicReport.summary}\n成果文件：${JSON.stringify(publicReport.files ?? [])}\n说明：${JSON.stringify(publicReport.notices)}`);
    }
    this.flushReturns();
  }
  hasIngress(collaborationId: string): boolean {
    return Boolean(this.options.db.prepare(`SELECT 1 FROM bot_peer_deliveries
      WHERE user_id=? AND json_extract(origin_json,'$.collaborationId')=? AND json_extract(origin_json,'$.kind')='request'`)
      .get(this.options.userId, collaborationId));
  }
  receipts(collaborationId: string): import("../../../shared/bot-collaboration").BotCollaborationReceiver[] {
    const schema = z.object({ exchangeId: z.string(), botId: z.string(), conversationId: z.string(), requestId: z.string(),
      userMessageId: z.string(), assistantMessageId: z.string(), status: botMessageSchema.shape.status,
      acceptedAt: z.number(), startedAt: z.number().nullable(), endedAt: z.number().nullable() });
    return this.options.db.prepare(`SELECT d.operation_id exchangeId,r.bot_id botId,r.conversation_id conversationId,r.request_id requestId,
      r.user_message_id userMessageId,r.assistant_message_id assistantMessageId,m.status,m.created_at acceptedAt,q.created_at startedAt,
      CASE WHEN m.status IN ('completed','failed','cancelled') THEN m.updated_at ELSE NULL END endedAt
      FROM bot_peer_deliveries d JOIN bot_send_receipts r ON r.assistant_message_id=d.accepted_message_id AND r.user_id=d.user_id
      JOIN bot_messages m ON m.message_id=d.accepted_message_id LEFT JOIN bot_request_runs q ON q.message_id=m.message_id
      WHERE d.user_id=? AND json_extract(d.origin_json,'$.collaborationId')=? AND json_extract(d.origin_json,'$.kind')='request'
      ORDER BY d.rowid DESC LIMIT 30`).all(this.options.userId, collaborationId).map(row => schema.parse(row)).reverse();
  }
  acknowledge(operationId: string): void {
    if (this.closing || !this.options.isAuthority()) return;
    const delivery = this.messages.peers.get(operationId);
    if (!delivery?.accepted_message_id || delivery.returned_at !== null || delivery.cancelled_at !== null) return;
    const origin = botPeerOriginSchema.parse(JSON.parse(delivery.origin_json));
    if (origin.kind !== "return" || this.messages.message(delivery.accepted_message_id)?.status !== "completed") return;
    const row = this.repo.get(this.options.userId, origin.collaborationId);
    if (!row) return;
    this.options.works.transaction(() => {
      this.repo.event(this.options.userId, row.collaborationId, { operationId, kind: "returned", ...(row.workId ? { workId: row.workId } : {}) });
      this.options.db.prepare("UPDATE bot_peer_deliveries SET returned_at=? WHERE operation_id=?").run(Date.now(), operationId);
    });
    this.publish(row.sourceAssistantMessageId);
  }
  private flushReturns(): void {
    for (const delivery of this.messages.peers.pending(this.options.userId)) {
      if (delivery.accepted_message_id || delivery.cancelled_at !== null) continue;
      const origin = botPeerOriginSchema.parse(JSON.parse(delivery.origin_json));
      if (origin.kind === "return") void this.deliver(delivery.operation_id).catch(error => console.warn("[Bot] 协作回传等待恢复", error));
    }
  }
  recover(): void {
    if (this.closing || !this.options.isAuthority()) return;
    // Work can also be cancelled through its owner's ordinary controls. Persist
    // the communication fence before normal foreground recovery can resume it.
    const cancelledWorks = this.options.db.prepare(`SELECT c.collaboration_id FROM bot_collaborations c
      JOIN works w ON w.work_id=c.work_id AND w.lifecycle='closed' AND w.closure_conclusion='cancelled'
      WHERE c.user_id=? AND EXISTS(SELECT 1 FROM bot_peer_deliveries d WHERE d.user_id=c.user_id
        AND json_extract(d.origin_json,'$.collaborationId')=c.collaboration_id AND d.cancelled_at IS NULL)`)
      .all(this.options.userId).map(row => z.object({ collaboration_id: z.string() }).parse(row));
    for (const row of cancelledWorks) this.options.works.transaction(() => this.markCancelled(row.collaboration_id));
    for (const delivery of this.messages.peers.cancelledRequests(this.options.userId))
      void this.host.cancel(delivery.target_bot_id, delivery.request_id).catch(error => console.warn("[Bot] 协作取消等待恢复", error));
    const reports = this.options.db.prepare(`SELECT c.work_id FROM bot_collaborations c WHERE c.user_id=? AND c.work_id IS NOT NULL
      AND EXISTS(SELECT 1 FROM bot_peer_deliveries d WHERE d.user_id=c.user_id AND json_extract(d.origin_json,'$.collaborationId')=c.collaboration_id
        AND json_extract(d.origin_json,'$.kind')='request' AND d.cancelled_at IS NULL)
      AND EXISTS(SELECT 1 FROM bot_collaboration_messages m WHERE m.collaboration_id=c.collaboration_id
        AND json_extract(m.value_json,'$.workFeedback.report') IS NOT NULL
        AND NOT EXISTS(SELECT 1 FROM bot_peer_deliveries p WHERE p.journal_message_id=m.message_id))`).all(this.options.userId);
    for (const value of reports) this.work(z.object({ work_id: z.string() }).parse(value).work_id);
    for (const delivery of [...this.messages.peers.pending(this.options.userId), ...this.messages.peers.unobserved(this.options.userId)]) {
      if (delivery.accepted_message_id) this.observe(delivery.accepted_message_id);
      else if (delivery.cancelled_at === null) void this.deliver(delivery.operation_id).catch(error => console.warn("[Bot] 协作受理等待恢复", error));
    }
  }
  markCancelled(collaborationId: string): void {
    if (!this.options.db.inTransaction) throw new Error("协作取消意图必须与控制结果原子保存");
    if (!this.options.isAuthority()) throw new Error("当前宿主不持有协作取消权");
    this.options.db.prepare(`UPDATE bot_peer_deliveries SET cancelled_at=COALESCE(cancelled_at,?)
      WHERE user_id=? AND json_extract(origin_json,'$.collaborationId')=?`).run(Date.now(), this.options.userId, collaborationId);
  }
  async cancel(collaborationId: string): Promise<void> {
    const pending = this.messages.peers.deliveries(this.options.userId, collaborationId);
    this.options.works.transaction(() => this.markCancelled(collaborationId));
    await Promise.all(pending.filter(delivery => delivery.accepted_message_id).map(delivery => this.host.cancel(delivery.target_bot_id, delivery.request_id)));
  }
}
