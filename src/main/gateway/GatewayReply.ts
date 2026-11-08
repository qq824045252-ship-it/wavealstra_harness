import { z } from "zod";

const identifier = z.string().min(1).max(2048);
const snowflake = z.string().regex(/^\d+$/).max(32);
const sealed = z.string().min(1).max(32_768);

/** Injected by the Electron host. Adapters never import safeStorage or fall back
 * to writing plaintext capabilities when a keyring is unavailable. */
export interface GatewayRouteCodec {
  seal(plaintext: string): string;
  open(ciphertext: string): string;
}

/** A capability cannot fit the supported encoding. Retrying identical input
 * cannot fix it. Keyring availability and encryption failures must NOT use this
 * type, so receivers retain those inputs for a later retry. */
export class GatewayRouteEncodingError extends Error {
  constructor(readonly reason: "invalid" | "too-large") {
    super(reason === "too-large" ? "Gateway 回复凭据超过安全存储限制" : "Gateway 回复凭据无法安全编码");
    this.name = "GatewayRouteEncodingError";
  }
}

/** Public routing identifiers plus optional OS-encrypted capabilities. Plaintext
 * session webhooks/context tokens must never enter the transport journal. */
export const gatewayReplyRouteSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("feishu"), chatId: identifier, messageId: identifier.optional(), inThread: z.boolean() }).strict(),
  z.object({ kind: z.literal("telegram"), chatId: z.string().regex(/^-?\d+$/), replyToMessageId: z.number().int().positive().optional(),
    messageThreadId: z.number().int().positive().optional(), directMessagesTopicId: z.number().int().nonnegative().optional() }).strict(),
  z.object({ kind: z.literal("wecom"), chatId: identifier, userId: identifier }).strict(),
  z.object({ kind: z.literal("wechat"), openId: identifier }).strict(),
  z.object({ kind: z.literal("discord"), channelId: snowflake, messageId: snowflake,
    replyToMode: z.enum(["off", "first", "all"]), nonceKey: z.string().min(1).max(4096) }).strict(),
  z.object({ kind: z.literal("qq"), recipient: identifier, group: z.boolean(), messageId: identifier,
    expiresAt: z.number().finite().positive() }).strict(),
  z.object({ kind: z.literal("weixin"), peer: identifier, expiresAt: z.number().finite().positive().optional(), encryptedCapability: sealed.optional() }).strict(),
  z.object({ kind: z.literal("dingtalk"), chatId: identifier, expiresAt: z.number().finite().positive(), encryptedCapability: sealed.optional() }).strict(),
]);
export type GatewayReplyRoute = z.infer<typeof gatewayReplyRouteSchema>;

export interface GatewayReplyRestoreInput {
  deliveryId: string;
  chatId: string;
  messageId: string;
  sender?: { id: string; name?: string };
  route?: GatewayReplyRoute;
}

/** Only use when the adapter can prove no reply was accepted by the provider.
 * Transport exceptions / lost receipts remain ordinary errors and are UNKNOWN. */
export class GatewayReplyNotSentError extends Error {
  constructor(message: string, readonly retryable = false, readonly retryAfterMs?: number) {
    super(message);
    this.name = "GatewayReplyNotSentError";
  }
}
