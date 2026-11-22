import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { GatewayBotOrigin } from "../agent/work/BotTurnOrigins";
import { gatewayConversationId } from "./GatewayConversation";

type Origin = Pick<GatewayBotOrigin, "channelId" | "connectionKey" | "chatId" | "senderId" | "messageId" | "personalMemoryBindingId">;
type SessionRow = { task_id: string; kind: "turn" | "new" | "obsolete_new"; accepted_at: number };
export type ConversationAdmission = { acceptedAt: number; recovered?: boolean };
export type ConversationRoute = { taskId: string; currentTaskId: string; command: boolean };
export const NEW_CONVERSATION_REPLY = "已开始新会话。下一条消息会使用新对话，旧任务和历史保留。";

export function isNewConversationCommand(text: string): boolean { return text.trim() === "/new"; }
export function hasStableConversationMessageId(id?: string): boolean { return Boolean(id?.trim() && !id.startsWith("local:")); }

const digest = (value: object): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
function identity(origin: Origin): { base: string; receipt: string } {
  const base = gatewayConversationId(origin);
  return { base, receipt: digest(["gateway-delivery-route-v1", origin.messageId]) };
}

function prior(db: Database.Database, base: string, receipt: string): SessionRow | undefined {
  return db.prepare("SELECT task_id,kind,accepted_at FROM gateway_conversation_routes WHERE scope_id=? AND delivery_key=?")
    .get(base, receipt) as SessionRow | undefined;
}

function current(db: Database.Database, base: string, before?: number): SessionRow | undefined {
  const row = before === undefined
    ? db.prepare("SELECT task_id,kind,accepted_at FROM gateway_conversation_routes WHERE scope_id=? AND kind='new' ORDER BY seq DESC LIMIT 1").get(base)
    : db.prepare("SELECT task_id,kind,accepted_at FROM gateway_conversation_routes WHERE scope_id=? AND kind='new' AND accepted_at<? ORDER BY seq DESC LIMIT 1").get(base, before);
  return row as SessionRow | undefined;
}

/** Deterministic before queue admission; duplicate deliveries never pick up a newer generation. */
export function reserveGatewayConversation(db: Database.Database, origin: Origin, command: boolean,
  admission?: ConversationAdmission): ConversationRoute {
  const { base, receipt } = identity(origin);
  if (command && !hasStableConversationMessageId(origin.messageId)) throw new Error("此渠道消息缺少稳定标识，无法安全执行 /new");
  const acceptedAt = admission?.acceptedAt ?? Date.now();
  return db.transaction(() => {
    const existing = prior(db, base, receipt);
    const latest = current(db, base);
    const active = latest?.task_id ?? base;
    if (existing) return { taskId: existing.task_id, currentTaskId: active, command: existing.kind !== "turn" };

    // A pre-feature or interrupted inbox can discover an older delivery after a reset.
    // Use its host journal time conservatively (same-ms ambiguity goes to the older context).
    const recoveredTask = admission?.recovered ? current(db, base, acceptedAt)?.task_id ?? base : active;
    const taskId = command ? `gateway-chat-${digest(["gateway-conversation-generation-v1", base, receipt])}` : recoveredTask;
    const obsolete = Boolean(command && admission?.recovered && latest && acceptedAt <= latest.accepted_at);
    db.prepare("INSERT INTO gateway_conversation_routes(scope_id, delivery_key, task_id, kind, accepted_at) VALUES(?,?,?,?,?)")
      .run(base, receipt, taskId, command ? (obsolete ? "obsolete_new" : "new") : "turn", acceptedAt);
    return { taskId, currentTaskId: command && !obsolete ? taskId : active, command };
  }).immediate();
}

/** The Agent re-validates the assignment, not the currently active pointer or caller-supplied task ID. */
export function assignedGatewayConversation(db: Database.Database, origin: Origin): string | undefined {
  const { base, receipt } = identity(origin);
  const reserved = prior(db, base, receipt);
  if (reserved) return reserved.kind === "turn" ? reserved.task_id : undefined;
  return current(db, base) ? undefined : base; // No unreserved replay into a rotated scope.
}
