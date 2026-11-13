import { z } from "zod";
import { botCollaborationMessageSchema } from "../../../shared/bot-collaboration";
import { botPeerOriginSchema, type BotPeerOrigin } from "../../../shared/bot-peer-origin";
import type { BotConversationServiceOptions } from "./BotConversationService";
import type { BotConversationRepository, BotMessageReceipt } from "./BotConversationRepository";
import type { BotCollaborationRepository } from "./BotCollaborationRepository";
import type { BotCollaborationDelivery } from "./BotCollaborationDelivery";
import { peerKey } from "./BotPeerIngress";
import { botDelegationInput } from "./BotDelegationInput";
import { workRequestIncludes } from "./WorkRequestEvidence";
import { classifyMcpToolCall } from "../../security/McpSideEffectPolicy";
import { durableMcpToolName } from "../durable/DurableMcp";
import { isDurableContextToolName } from "../durable/context/DurableContextTools";
import type { BotCollaborationDto } from "../../../shared/bot-collaboration";

const id = z.string().trim().min(1).max(500), quote = z.string().trim().min(1).max(4000);
export const botReviewResultCommandSchema = z.object({ action: z.literal("review_result"), collaborationId: id,
  replyMessageId: id, requestExcerpt: quote, evidenceQuote: quote, gap: z.string().trim().min(1).max(8000) }).strict();
type ReviewCommand = z.infer<typeof botReviewResultCommandSchema>;
export function collaborationReviewUserRequest(options: BotConversationServiceOptions, messages: BotConversationRepository, relation: BotCollaborationDto) {
  const work = relation.workId ? options.works.getWork(relation.workId) : undefined;
  if (work) return botDelegationInput(options.db, work, work.sourceVersion);
  const human = messages.receipt(options.userId, relation.sourceBotId, relation.sourceRequestId);
  const user = human && messages.message(human.user_message_id);
  return user && user.messageId === relation.sourceUserMessageId && !messages.peers.origin(user.messageId)
    ? { messages: [user] } : undefined;
}
const readTools = new Set(["read", "ls", "find", "grep", "web_search", "fetch_content", "memory_search", "work_query_status",
  "read_skill", "mcp_list_tools", "mcp_list_resources", "mcp_read_resource", "mcp_status", "acp_status", "acp_search", "acp_retrieve"]);
export const peerReviewToolAllowed = (name: string) => readTools.has(name) || name === "mcp_call_tool" || isDurableContextToolName(name);
export function assertPeerReviewReadTool(name: string, args: unknown, mcpIds: string[]): void {
  if (!peerReviewToolAllowed(name)) throw Error("成果补查仅可读取已有成果和来源，不能重新执行、委派或修改事项");
  if (name !== "mcp_call_tool") return;
  const call = z.object({ server: z.string(), tool: z.string(), arguments: z.record(z.string(), z.unknown()) }).parse(args);
  const verdict = classifyMcpToolCall(durableMcpToolName(call.server, call.tool), call.arguments, mcpIds);
  if (!verdict?.clearlyReadonly || verdict.sideEffect) throw Error("成果补查拒绝不能证明只读的实际 MCP 调用");
}

export function assertPeerReviewCurrent(options: BotConversationServiceOptions, messages: BotConversationRepository,
  repo: BotCollaborationRepository, origin: BotPeerOrigin): void {
  if (origin.kind !== "request" || !origin.review) return;
  const relation = repo.get(options.userId, origin.collaborationId), review = origin.review;
  const delivery = messages.peers.get(origin.exchangeId), returned = messages.peers.get(review.returnExchangeId);
  const human = messages.receipt(options.userId, origin.sourceBotId, origin.sourceRequestId);
  const conversation = human && messages.conversation(options.userId, human.bot_id, human.conversation_id);
  if (!options.isAuthority() || !relation || relation.status === "cancelled" || !delivery || delivery.cancelled_at !== null
    || !returned || returned.cancelled_at !== null || relation.sourceUserMessageId !== origin.sourceUserMessageId
    || !human || human.user_message_id !== origin.sourceUserMessageId || !conversation || conversation.archived_at !== null)
    throw Error("原协作或成果补查已取消，未启动新的读取");
  const returnOrigin = botPeerOriginSchema.parse(JSON.parse(returned.origin_json));
  if (returnOrigin.kind !== "return" || returnOrigin.collaborationId !== origin.collaborationId || returnOrigin.replyMessageId !== review.replyMessageId)
    throw Error("成果补查的原回流身份不可核对");
  if (review.work) {
    const work = options.works.getWork(review.work.workId);
    if (!work || relation.workId !== work.workId || work.ownerBotId !== relation.targetBotId || work.userId !== options.userId || work.intentRevision !== review.work.intentRevision
      || work.inputSnapshotId !== review.work.inputSnapshotId || work.ownerEpoch !== review.work.ownerEpoch
      || ["paused", "closing"].includes(work.lifecycle) || work.closureConclusion === "cancelled")
      throw Error("原事项要求或执行归属已变化，本次补查不再适用");
  } else if (relation.workId) throw Error("原协作已进入新的执行，本次旧答复补查不再适用");
}

export async function reviewCollaborationResult(options: BotConversationServiceOptions, messages: BotConversationRepository,
  repo: BotCollaborationRepository, delivery: BotCollaborationDelivery | undefined, source: BotMessageReceipt, command: ReviewCommand,
  assertSource: () => void): Promise<unknown> {
  if (!delivery) throw Error("协作补查接收器不可用");
  const origin = messages.peers.origin(source.user_message_id);
  if (origin?.kind !== "return" || command.collaborationId !== origin.collaborationId || command.replyMessageId !== origin.replyMessageId)
    throw Error("只能核对当前成果回流对应的原协作和答复");
  const operationId = `peer-review:${peerKey(origin.collaborationId, origin.replyMessageId)}`;
  const prepare = () => {
    assertSource();
    const relation = repo.scoped(options.userId, source.bot_id, origin.collaborationId);
    const returned = messages.peers.get(origin.exchangeId);
    const previous = messages.peers.get(operationId);
    if (relation.sourceBotId !== source.bot_id || relation.status === "cancelled" || !returned || returned.cancelled_at !== null)
      throw Error("原协作回流已取消");
    const raw = z.object({ value_json: z.string() }).optional().parse(options.db.prepare(
      "SELECT value_json FROM bot_collaboration_messages WHERE collaboration_id=? AND message_id=?")
      .get(relation.collaborationId, command.replyMessageId));
    const reply = raw && botCollaborationMessageSchema.parse(JSON.parse(raw.value_json));
    if (!reply || reply.senderBotId !== relation.targetBotId || !reply.text.includes(command.evidenceQuote))
      throw Error("补查缺口必须引用当前对方答复中实际存在的证据");
    const latest = z.object({ message_id: z.string() }).optional().parse(options.db.prepare(
      "SELECT message_id FROM bot_collaboration_messages WHERE collaboration_id=? AND json_extract(value_json,'$.senderBotId')=? AND json_extract(value_json,'$.kind')<>'request' ORDER BY ordinal DESC LIMIT 1")
      .get(relation.collaborationId, relation.targetBotId));
    if (!previous && latest?.message_id !== reply.messageId) throw Error("已有更新的成果，不能沿旧回流重新补查");
    const human = messages.receipt(options.userId, relation.sourceBotId, relation.sourceRequestId);
    const user = human && messages.message(human.user_message_id);
    if (!human || !user || user.messageId !== relation.sourceUserMessageId || messages.peers.origin(user.messageId))
      throw Error("原用户要求已不可核对，Bot 回流不能成为新授权");
    const work = relation.workId ? options.works.getWork(relation.workId) : undefined;
    const original = { userRequest: collaborationReviewUserRequest(options, messages, relation) };
    if (!workRequestIncludes(original, command.requestExcerpt)) throw Error("补查必须对应原用户已授权的要求");
    if (work && (["paused", "closing"].includes(work.lifecycle) || work.closureConclusion === "cancelled"
      || reply.workFeedback && (reply.workFeedback.intentRevision !== work.intentRevision || reply.workFeedback.inputSnapshotId !== work.inputSnapshotId
        || reply.workFeedback.report?.current === false))) throw Error("原事项或报告版本已失效，不能补查旧要求");
    const count = z.object({ count: z.number() }).parse(options.db.prepare(
      "SELECT count(*) count FROM bot_peer_deliveries WHERE user_id=? AND json_extract(origin_json,'$.collaborationId')=? AND json_type(origin_json,'$.review')='object'")
      .get(options.userId, relation.collaborationId)).count;
    if (!previous && count >= 2) throw Error("本协作已完成两次只读补查，保留真实缺口，不继续重复核验");
    const review = { returnExchangeId: origin.exchangeId, replyMessageId: reply.messageId, requestExcerpt: command.requestExcerpt,
      evidenceQuote: command.evidenceQuote, gap: command.gap,
      ...(work ? { work: { workId: work.workId, intentRevision: work.intentRevision, inputSnapshotId: work.inputSnapshotId, ownerEpoch: work.ownerEpoch } } : {}) };
    if (previous) {
      const prior = botPeerOriginSchema.parse(JSON.parse(previous.origin_json));
      if (prior.kind !== "request" || JSON.stringify(prior.review) !== JSON.stringify(review)) throw Error("同一成果回流只能保留已受理的补查，不能改写后重复派发");
    }
    return { relation, human, review };
  };
  const prepared = options.works.transaction(prepare);
  await delivery.send(prepared.relation, prepared.human, operationId,
    `这是原协作的只读成果核对，不是新的用户要求。只读取并核验已有成果/来源，不重跑业务，不创建或修改Work。原要求摘录：${prepared.review.requestExcerpt}\n当前答复证据：${prepared.review.evidenceQuote}\n须核对的具体缺口：${prepared.review.gap}`,
    () => { prepare(); }, undefined, prepared.review);
  return { collaborationId: prepared.relation.collaborationId, operationId, accepted: true, readOnly: true,
    description: "已交原 Bot 核对已有成果，答案稍后沿原协作返回；没有重开或重做业务。" };
}
