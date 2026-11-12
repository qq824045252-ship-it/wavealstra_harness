import type Database from "better-sqlite3";
import { z } from "zod";
import type { WorkExecutionBindingDto } from "../../../shared/bot-work";
import { GATEWAY_CAPABILITIES } from "../../gateway/GatewayCapabilities";
import { readGatewayWorkRoutes } from "../../gateway/GatewayWorkTargets";

type DeliveryState = "not_requested" | "pending" | "sent" | "unknown" | "failed";
const workSchema = z.object({ user_id: z.string() });
const channelSchema = z.object({ connected: z.number() });
const deliverySchema = z.object({ kind: z.string(), delivery: z.string(), status: z.string().nullable(), receipt: z.string().nullable(), payload_json: z.string().nullable(), artifact_refs_json: z.string().nullable() });
const partsSchema = z.array(z.object({ part: z.string(), receipt: z.string().optional(), code: z.string().optional() }));
const payloadSchema = z.object({ deliveryFiles: z.array(z.object({ sha256: z.string() })).optional() });
function json(value: string | null): unknown { try { return value ? JSON.parse(value) : undefined; } catch { return undefined; } }

/** Host-owned reply facts only. Never exposes transport addresses or exempts other business sends. */
export function workDeliveryContext(db: Database.Database, binding: WorkExecutionBindingDto) {
  if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gateway_work_targets'").get()) return;
  const work = workSchema.optional().parse(db.prepare(`SELECT w.user_id FROM works w
    JOIN work_execution_bindings b ON b.work_id=w.work_id JOIN bots bot ON bot.bot_id=b.bot_id AND bot.user_id=w.user_id
    WHERE b.binding_id=? AND b.work_id=? AND b.bot_id=? AND b.invalidated_at IS NULL
      AND b.intent_revision=? AND b.owner_epoch=? AND b.input_snapshot_id=?
      AND w.intent_revision=b.intent_revision AND w.owner_epoch=b.owner_epoch AND w.input_snapshot_id=b.input_snapshot_id`)
    .get(binding.bindingId, binding.workId, binding.botId, binding.intentRevision, binding.ownerEpoch, binding.inputSnapshotId));
  if (!work) return;
  const routes = readGatewayWorkRoutes(db, binding.workId, work.user_id);
  if (!routes.length) return;
  return {
    provenance: "host_persisted_delivery_route" as const,
    responsibility: "host" as const,
    scope: "reply_to_original_request_only" as const,
    routes: routes.map(route => {
      const capability = GATEWAY_CAPABILITIES[route.target.channelType];
      const channel = channelSchema.optional().parse(db.prepare("SELECT connected FROM gateway_channels WHERE id=? AND type=?")
        .get(route.target.channelId, route.target.channelType));
      const delivery = deliverySchema.optional().parse(db.prepare(`SELECT n.kind,n.delivery,a.status,a.receipt,a.payload_json,c.artifact_refs_json
        FROM work_notifications n JOIN work_notification_identity i ON i.notification_id=n.notification_id
        LEFT JOIN work_result_cards c ON c.card_key=n.card_key
        LEFT JOIN work_notification_attempts a ON a.notification_id=n.notification_id
          AND a.ordinal=(SELECT MAX(last.ordinal) FROM work_notification_attempts last WHERE last.notification_id=n.notification_id)
        WHERE n.work_id=? AND n.target_key=? AND n.channel=? AND n.intent_revision=?
          AND i.input_snapshot_id=? AND i.owner_epoch=? AND i.semantic_validity='active'
        ORDER BY n.created_at DESC,n.rowid DESC LIMIT 1`).get(binding.workId,route.targetKey,`gateway:${route.target.channelId}`,
          binding.intentRevision,binding.inputSnapshotId,binding.ownerEpoch));
      const parts = partsSchema.safeParse(json(delivery?.receipt ?? null));
      const receipts = parts.success ? parts.data : [];
      const payload = payloadSchema.safeParse(json(delivery?.payload_json ?? null));
      const files = payload.success ? payload.data.deliveryFiles ?? [] : [];
      const cardRefs = z.array(z.string()).safeParse(json(delivery?.artifact_refs_json ?? null));
      const filesRequested = files.length > 0 || cardRefs.success && cardRefs.data.length > 0;
      const fullReceipt = delivery?.status === "sent" && Boolean(delivery.receipt?.trim());
      const fallback: DeliveryState = !delivery ? "not_requested" : (delivery.status === "unknown" || delivery.status === "sent" && !fullReceipt) ? "unknown"
        : delivery.status === "failed" || delivery.delivery === "failed" ? "failed" : "pending";
      const textState: DeliveryState = fullReceipt || receipts.some(part => part.part === "text" && part.receipt?.trim()) ? "sent" : fallback;
      const filesSent = files.length > 0 && (fullReceipt || files.every(file => receipts.some(part => part.part === `file:${file.sha256}` && part.receipt?.trim())));
      const fileState: DeliveryState | "unsupported" = receipts.some(part => part.part === "files" && part.code === "fileunsupported") ? "unsupported"
        : filesSent ? "sent" : filesRequested ? fallback : "not_requested";
      return {
        channel: route.target.channelType,
        receiptScope: "latest_notification_for_current_work_version" as const,
        ...(delivery ? { notificationKind: delivery.kind } : {}),
        connection: !channel ? "unknown" as const : channel.connected ? "last_observed_connected" as const : "disconnected" as const,
        summaryDelivery: { capability: capability.workNotifications ? "supported" as const : "unsupported" as const, state: textState },
        fileDelivery: { capability: capability.media === "bidirectional" ? "supported" as const : "unsupported" as const, state: fileState },
        ...(route.target.channelType === "qq" ? { replyWindow: Date.now() < route.target.address.expiresAt ? "open" as const : "expired" as const } : {}),
      };
    }),
    instructions: "仅当前事项向原始请求会话返回成果由宿主负责：执行者创建、核验并登记成果文件，宿主使用原路线和通知账本投递，无需执行者另找渠道发送工具。已登记文件不等于已送达；只有实际回执才能说明送达。回执状态仅指当前事项版本最近一条通知，先前部分成果送达不证明本次新成果已经送达。渠道不支持文件或暂时离线时应如实说明限制，不把执行者缺少该返回渠道工具当作文件创建失败。这不免除用户要求向其他渠道、其他收件人发送消息或文件的业务义务；那些动作仍需实际执行和核验。",
  };
}
export type WorkDeliveryContext = NonNullable<ReturnType<typeof workDeliveryContext>>;
