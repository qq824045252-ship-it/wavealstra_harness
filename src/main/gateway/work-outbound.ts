import { createHash } from "node:crypto";
import { z } from "zod";
import type { GatewayChannelType } from "../../shared/agent-ipc";

const identifier = z.string().trim().min(1).max(512);
const base = z.object({
  version: z.literal(1), channelId: identifier, connectionKey: z.string().regex(/^[a-f0-9]{64}$/),
  chatId: identifier, senderId: identifier,
});

/** Only routing identities enter the database; message text and credentials never do. */
export const gatewayWorkTargetSchema = z.discriminatedUnion("channelType", [
  base.extend({ channelType: z.literal("feishu"), address: z.object({ chatId: identifier, replyToMessageId: identifier.optional(), threadId: identifier.optional() }).strict() }).strict(),
  base.extend({ channelType: z.literal("wecom"), address: z.object({ chatId: identifier, userId: identifier }).strict() }).strict(),
  base.extend({ channelType: z.literal("wechat"), address: z.object({ openId: identifier }).strict() }).strict(),
  base.extend({ channelType: z.literal("telegram"), address: z.object({
    chatId: z.string().regex(/^-?\d+$/), messageThreadId: z.number().int().positive().optional(),
    directMessagesTopicId: z.number().int().nonnegative().optional(),
  }).strict() }).strict(),
  base.extend({ channelType: z.literal("slack"), address: z.object({
    teamId: z.string().regex(/^T[A-Z0-9]+$/), appId: z.string().regex(/^A[A-Z0-9]+$/),
    channel: z.string().regex(/^[CDG][A-Z0-9]+$/), threadTs: z.string().regex(/^\d+\.\d+$/),
  }).strict() }).strict(),
]).refine(target => {
  if (target.channelType === "slack") return target.chatId === [target.address.teamId, target.address.channel, target.address.threadTs].join(":");
  if (target.channelType === "wechat") return target.address.openId === target.chatId && target.senderId === target.chatId;
  if (target.channelType === "wecom") return target.address.chatId === target.chatId && target.address.userId === target.senderId;
  return target.address.chatId === target.chatId;
}, "Gateway 通知地址与已认证会话不一致");
export type GatewayWorkTarget = z.infer<typeof gatewayWorkTargetSchema>;
export type GatewayWorkSendResult = { ok: true; receipt: string }
  | { ok: false; retryable: boolean; responseLost: boolean; error: string };
export interface GatewayWorkSendInput {
  target: GatewayWorkTarget;
  text: string;
  effectKey: string;
  signal?: AbortSignal;
  /** Rechecks Work/authority/target immediately before the actual provider request. */
  assertCurrent: () => void;
}

export class GatewayWorkNotSentError extends Error {
  constructor(message: string, readonly retryable = false) { super(message); }
}

export function gatewayConnectionKey(type: GatewayChannelType, publicIdentity: string[]): string {
  if (!publicIdentity.length || publicIdentity.some(value => !value.trim())) throw new Error("Gateway 缺少已核验的公开连接身份");
  return createHash("sha256").update(JSON.stringify(["gateway-connection-v1", type, ...publicIdentity])).digest("hex");
}

export function gatewayWorkTarget(value: unknown): GatewayWorkTarget | undefined {
  const result = gatewayWorkTargetSchema.safeParse(value);
  return result.success ? result.data : undefined;
}

export function assertGatewayWorkSend(input: GatewayWorkSendInput, adapter: {
  id: string; type: GatewayChannelType; isConnected(): boolean; workConnectionKey(): string | undefined;
}): void {
  if (input.signal?.aborted) throw new GatewayWorkNotSentError("通知宿主已停止，本次未发送");
  if (!adapter.isConnected() || input.target.channelId !== adapter.id || input.target.channelType !== adapter.type
    || input.target.connectionKey !== adapter.workConnectionKey()) throw new GatewayWorkNotSentError("渠道连接或账号身份已改变，本次未发送");
  try { input.assertCurrent(); }
  catch { throw new GatewayWorkNotSentError("事项或目标授权已改变，本次未发送"); }
}

export function workRequestSignal(signal?: AbortSignal): AbortSignal {
  return signal ? AbortSignal.any([signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
}

/** One HTTP request, no hidden retries/chunk loop and no independent delivery journal. */
export async function postGatewayWork(input: {
  url: string; body: Record<string, unknown>; headers?: Record<string, string>; signal?: AbortSignal;
  fetcher?: typeof fetch; label: string;
  interpret: (data: Record<string, unknown>, response: Response) => GatewayWorkSendResult;
}): Promise<GatewayWorkSendResult> {
  try {
    const response = await (input.fetcher ?? fetch)(input.url, {
      method: "POST", redirect: "error", signal: workRequestSignal(input.signal),
      headers: { "Content-Type": "application/json", ...input.headers }, body: JSON.stringify(input.body),
    });
    const data: unknown = await response.json();
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("invalid provider receipt");
    return input.interpret(data as Record<string, unknown>, response);
  } catch {
    // A timeout, malformed body or transport exception says nothing about whether the
    // provider accepted the message. Never leak token-bearing URLs in diagnostics.
    return { ok: false, retryable: false, responseLost: true, error: `${input.label} 回执未确认，已停止自动重发` };
  }
}

export function providerRejected(label: string, code: string | number): GatewayWorkSendResult {
  const safeCode = String(code).replace(/[^A-Za-z0-9_-]/g, "").slice(0, 80) || "rejected";
  return { ok: false, retryable: false, responseLost: false, error: `${label} 拒绝通知（${safeCode}）` };
}

export function unknownProviderReceipt(label: string): GatewayWorkSendResult {
  return { ok: false, retryable: false, responseLost: true, error: `${label} 未提供可核验的成功回执` };
}
