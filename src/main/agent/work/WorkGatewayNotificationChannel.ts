import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { WorkNotificationDto } from "../../../shared/bot-work";
import { capabilityOfGuarantee } from "../../../shared/bot-work-phase5";
import { GatewayWorkTargets, type GatewayWorkRoute } from "../../gateway/GatewayWorkTargets";
import { GatewayWorkNotSentError, type GatewayWorkTarget, type GatewayWorkSendInput, type GatewayWorkSendResult } from "../../gateway/work-outbound";
import type { AsyncWorkNotificationChannel } from "./WorkNotificationDelivery";
import type { WorkService } from "./WorkService";
import { closureCorrectionNotice } from "./WorkClosureCorrectionDelivery";

export interface WorkGatewayPort {
  checkWorkTarget(target: GatewayWorkTarget): string | undefined;
  sendWorkNotification(input: GatewayWorkSendInput): Promise<GatewayWorkSendResult>;
}

/** Same semantic card, separately addressed notification intents in the existing ledger. */
export class WorkGatewayNotificationChannels {
  private readonly targets: GatewayWorkTargets;
  private cursor = 0;
  constructor(private readonly db: Database.Database, private readonly works: WorkService,
    private readonly gateway: WorkGatewayPort, private readonly options: { isAuthority: () => boolean }) {
    this.targets = new GatewayWorkTargets(db);
  }

  channels(): AsyncWorkNotificationChannel[] {
    if (!this.options.isAuthority()) return [];
    this.materialize();
    const rows = this.db.prepare(`SELECT DISTINCT target_key FROM work_notifications
      WHERE channel LIKE 'gateway:%' AND target_key IS NOT NULL AND delivery IN ('pending','unknown') ORDER BY target_key`)
      .all() as Array<{ target_key: string }>;
    if (!rows.length) return [];
    // Rotate a bounded batch so one unavailable route cannot starve later recipients.
    const start = this.cursor % rows.length;
    const selected = [...rows.slice(start), ...rows.slice(0, start)].slice(0, 64);
    this.cursor = (start + selected.length) % rows.length;
    return selected.map(row => this.createChannel(row.target_key));
  }

  materialize(): number {
    if (!this.options.isAuthority()) return 0;
    const candidates = this.db.prepare(`SELECT DISTINCT n.notification_id,t.target_key FROM work_notifications n
      JOIN works w ON w.work_id=n.work_id
      JOIN work_conversations c ON c.work_id=w.work_id
      JOIN gateway_work_targets t ON t.user_id=w.user_id AND t.conversation_id=c.conversation_id AND t.source_message_id=w.source_message_id
      JOIN work_notification_identity i ON i.notification_id=n.notification_id
      WHERE n.card_key IS NOT NULL AND (n.channel IS NULL OR n.channel='desktop') AND i.semantic_validity='active'
        AND n.intent_revision=w.intent_revision AND i.input_snapshot_id=w.input_snapshot_id
        AND NOT EXISTS (SELECT 1 FROM work_notifications existing WHERE existing.card_key=n.card_key
          AND existing.target_key=t.target_key AND existing.channel='gateway:' || t.channel_id)
      ORDER BY n.notification_id,t.target_key LIMIT 200`).all() as Array<{ notification_id: string; target_key: string }>;
    let inserted = 0;
    this.works.transaction(() => {
      if (!this.options.isAuthority()) throw new Error("当前宿主不持有 Work 通知权威");
      for (const candidate of candidates) {
        const source = this.works.repo.getNotification(candidate.notification_id);
        if (!source?.cardKey) continue;
        const work = this.works.getWork(source.workId);
        const route = this.targets.get(candidate.target_key);
        const identity = this.works.notifications.identity(source.notificationId);
        if (!work || !route || route.userId !== work.userId || !identity || identity.semanticValidity !== "active"
          || !this.targets.forWork(work.workId, work.userId).some(item => item.targetKey === route.targetKey)) continue;
        const card = this.works.cards.list(work).find(item => item.cardKey === source.cardKey);
        if (!card || card.currency === "historical") continue;
        const hash = createHash("sha256").update(JSON.stringify(["work-gateway-intent-v1", work.workId,
          source.cardKey, route.target.channelId, route.targetKey])).digest("hex");
        const notificationId = `notification:gateway:${hash}`;
        const added = this.works.repo.insertNotification({ ...source, notificationId, semanticKey: `work:gateway:${hash}`,
          channel: `gateway:${route.target.channelId}`, targetKey: route.targetKey,
          delivery: "pending", attemptCount: 0, idempotencyKey: undefined, effectKey: undefined,
          externalReceipt: undefined, sentAt: undefined, readAt: undefined });
        if (!added) continue;
        this.db.prepare(`UPDATE work_notification_identity SET input_snapshot_id=?,owner_epoch=?,sender_bot_id=?,semantic_validity=?
          WHERE notification_id=?`).run(identity.inputSnapshotId, identity.ownerEpoch, identity.senderBotId, identity.semanticValidity, notificationId);
        inserted++;
      }
    });
    return inserted;
  }

  private createChannel(targetKey: string): AsyncWorkNotificationChannel {
    const route = this.targets.get(targetKey);
    if (!route) throw new Error("Gateway 通知的原始目标记录缺失");
    return {
      channel: `gateway:${route.target.channelId}`, targetKey,
      // Current adapters provide a response to one send, but no durable replay/query
      // contract for a lost response. client_msg_id alone does not change this guarantee.
      ...capabilityOfGuarantee("best-effort-unqueryable"),
      admit: notification => this.admit(route, notification),
      send: async input => {
        try {
          const rejected = this.admit(route, input.notification);
          if (rejected) return { ok: false, retryable: true, responseLost: false, error: rejected };
          const correction = closureCorrectionNotice(this.db, input.notification);
          return await this.gateway.sendWorkNotification({ target: route.target, text: workGatewayText(correction
            ? { ...input.notification, body: input.notification.deliveryFiles?.length ? correction : input.notification.body, deliveryFiles: undefined } : input.notification),
            qqMessageSequence: route.target.channelType === "qq" ? qqWorkMessageSequence(this.db, route.targetKey, `gateway:${route.target.channelId}`, input.idempotencyKey) : undefined,
            files: correction ? [] : input.notification.deliveryFiles, recordProgress: input.recordProgress, effectKey: input.idempotencyKey, signal: input.signal, assertCurrent: input.assertCurrent });
        } catch (error) {
          return error instanceof GatewayWorkNotSentError
            ? { ok: false, retryable: error.retryable, responseLost: false, error: error.message }
            : { ok: false, retryable: false, responseLost: true, error: "Gateway 投递回执未确认，已停止自动重发" };
        }
      },
    };
  }

  private admit(route: GatewayWorkRoute, notification: WorkNotificationDto): string | undefined {
    if (!this.options.isAuthority()) return "当前宿主不持有 Work 通知权威";
    if (notification.targetKey !== route.targetKey || notification.channel !== `gateway:${route.target.channelId}`) return "通知目标作用域不一致";
    const work = this.works.getWork(notification.workId);
    if (!work || work.userId !== route.userId || !this.targets.forWork(work.workId, work.userId).some(item => item.targetKey === route.targetKey)) {
      return "通知目标不属于当前用户与原始 Work 输入";
    }
    const bot = z.object({ user_id: z.string(), status: z.string() }).optional()
      .parse(this.db.prepare("SELECT user_id,status FROM bots WHERE bot_id=?").get(work.ownerBotId));
    if (!bot || bot.user_id !== work.userId || bot.status !== "active") return "负责 Bot 已暂停、停用或不属于当前用户";
    return this.gateway.checkWorkTarget(route.target);
  }
}

/** One bounded plain-text request avoids untracked partial chunk sends. */
export function workGatewayText(notification: Pick<WorkNotificationDto, "title" | "body" | "deliveryFiles"> & Partial<Pick<WorkNotificationDto, "kind">>): string {
  const suffix = "\n\n完整成果、待决事项和验证范围请在 MyBuddy 结果卡中查看。";
  // A model's desktop summary can say "attached" before this channel has sent anything.
  // External delivery wording is derived from this immutable request's actual files.
  const attachmentStatus = notification.deliveryFiles === undefined ? undefined
    : notification.deliveryFiles.length ? `本次请求包含文件：${notification.deliveryFiles.map(file => file.name).join("、")}。文件送达以渠道实际附件和回执为准。`
      : "本次通知没有附件。";
  // Preserve the actual answer (including text-only results). Keep model claims
  // separate from transport facts rather than discarding the whole answer.
  const body = notification.deliveryFiles !== undefined && notification.body
    ? `执行方说明（不代表渠道投递回执）：\n${notification.body.split("\n").map(line => `> ${line}`).join("\n")}`
    : notification.body;
  const content = [notification.title, body, attachmentStatus].filter(Boolean).join("\n\n");
  let text = "";
  let bytes = Buffer.byteLength(suffix, "utf8");
  for (const character of content) {
    const length = Buffer.byteLength(character, "utf8");
    if (bytes + length > 1797) { text += "…"; break; }
    text += character; bytes += length;
  }
  return text + suffix;
}

/** Effect row order is the reservation: retries retain a slot; different Works sharing one source cannot collide. */
export function qqWorkMessageSequence(db: Database.Database, targetKey: string, channel: string, effectKey: string): number {
  const effect = z.object({ rowid: z.number() }).optional().parse(db.prepare(
    "SELECT rowid FROM work_notification_effects WHERE effect_key=? AND target_key=? AND channel=?").get(effectKey, targetKey, channel));
  if (!effect) throw new GatewayWorkNotSentError("QQ 通知缺少原始目标的持久投递意图，未发送");
  const prior = z.object({ count: z.number() }).parse(db.prepare(
    "SELECT COUNT(*) count FROM work_notification_effects WHERE target_key=? AND channel=? AND rowid<?").get(targetKey, channel, effect.rowid));
  const sequence = prior.count + 2;
  if (sequence > 5) throw new GatewayWorkNotSentError("QQ 原消息最多回复 5 次，Work 通知槽位已用完，未发送");
  return sequence;
}
