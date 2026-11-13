import type Database from "better-sqlite3";
import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import type { BotConversationRepository, BotMessageReceipt } from "./BotConversationRepository";
import { botDelegationSourceSchema } from "./BotDelegationSources";
const goalSchema = z.object({ goalId: z.string(), sources: z.array(botDelegationSourceSchema), question: z.string(),
  state: z.enum(["pending", "consumed", "cancelled"]), updatedBy: z.string(), workId: z.string().optional() });
const stateSchema = z.object({ version: z.literal(1), goals: z.array(goalSchema),
  operations: z.array(z.object({ operationId: z.string(), hash: z.string(), goalId: z.string(), action: z.enum(["ask", "cancel"]) })) });
type Goal = z.infer<typeof goalSchema>;
type State = z.infer<typeof stateSchema>;
const empty = (): State => ({ version: 1, goals: [], operations: [] });
export class BotClarificationGoals {
  constructor(private readonly db: Database.Database, private readonly messages: BotConversationRepository) {}
  private read(messageId: string) {
    const row = this.db.prepare("SELECT context_json FROM bot_request_runs WHERE message_id=?").get(messageId) as { context_json: string } | undefined;
    if (!row) throw Error("澄清必须绑定当前持久请求");
    const value = JSON.parse(row.context_json).clarificationState;
    return { json: row.context_json, state: value === undefined ? empty() : stateSchema.parse(value) };
  }
  private update(messageId: string, transform: (state: State) => void) {
    if (!this.db.inTransaction) throw Error("澄清状态必须与原始请求或 Work 受理同事务保存");
    const before = this.read(messageId); transform(before.state);
    const changed = this.db.prepare("UPDATE bot_request_runs SET context_json=json_set(context_json,'$.clarificationState',json(?)) WHERE message_id=? AND context_json=?")
      .run(JSON.stringify(before.state), messageId, before.json);
    if (changed.changes !== 1) throw Error("澄清目标已被另一请求修改，请重新读取");
  }
  private scoped(receipt: BotMessageReceipt) {
    return this.db.prepare(`SELECT r.message_id,r.context_json FROM bot_request_runs r
      JOIN bot_messages m ON m.message_id=r.message_id JOIN bot_conversations c ON c.conversation_id=m.conversation_id
      WHERE c.user_id=? AND m.bot_id=? AND m.conversation_id=? AND m.ordinal<? AND json_extract(r.context_json,'$.clarificationState.version')=1`)
      .all(receipt.user_id, receipt.bot_id, receipt.conversation_id, this.messages.message(receipt.user_message_id)?.ordinal ?? 0).flatMap(value => {
        const row = z.object({ message_id: z.string(), context_json: z.string() }).parse(value);
        return stateSchema.parse(JSON.parse(row.context_json).clarificationState).goals.map(goal => ({ messageId: row.message_id, goal }));
      });
  }
  sourceMessages(receipt: BotMessageReceipt) {
    const ids = new Set<string>();
    for (const {goal} of this.scoped(receipt)) {
      if (goal.state !== "pending") continue;
      const question = this.messages.message(goal.updatedBy);
      if (!question || question.status !== "completed") continue;
      for (const snapshot of goal.sources) {
        const current = this.messages.message(snapshot.messageId);
        if (current && JSON.stringify(botDelegationSourceSchema.parse(current)) === JSON.stringify(snapshot)) ids.add(current.messageId);
      }
      ids.add(question.messageId);
    }
    return [...ids].flatMap(id => { const message = this.messages.message(id); return message && message.conversationId === receipt.conversation_id && message.botId === receipt.bot_id ? [message] : []; });
  }
  pending(receipt: BotMessageReceipt) {
    return this.scoped(receipt).flatMap(({ goal }) => {
      if (goal.state !== "pending") return [];
      const sourceMessageIds = [...new Set([...goal.sources.map(source => source.messageId), goal.updatedBy])];
      let unavailable: string | undefined;
      const update = this.messages.message(goal.updatedBy);
      if (!update || update.status !== "completed") unavailable = "澄清问题已取消、失败或尚未完成";
      try {
        for (const snapshot of goal.sources) {
          const current = this.messages.message(snapshot.messageId);
          if (!current || JSON.stringify(botDelegationSourceSchema.parse(current)) !== JSON.stringify(snapshot)) throw Error("原始来源已变化或删除");
        }
        this.messages.validateWorkUserInput(receipt, sourceMessageIds);
      } catch (error) { unavailable = String(error); }
      return [{ goalId: goal.goalId, question: goal.question, sourceMessageIds, ...(unavailable ? {unavailable} : {}) }];
    });
  }
  private replay(receipt: BotMessageReceipt, operationId: string, payload: unknown) {
    const hash = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
    const prior = this.read(receipt.assistant_message_id).state.operations.find(item => item.operationId === operationId);
    if (prior && prior.hash !== hash) throw Error("澄清操作身份已绑定不同请求，未改写原始来源");
    return { hash, prior };
  }
  private record(receipt: BotMessageReceipt, operation: State["operations"][number]) {
    this.update(receipt.assistant_message_id, state => { state.operations.push(operation); });
  }
  clarify(receipt: BotMessageReceipt, operationId: string, question: string, sourceMessageIds: readonly string[], goalId?: string) {
    if (this.messages.peers.origin(receipt.user_message_id)) throw Error("Bot 转述不能登记用户待澄清目标");
    const { hash, prior } = this.replay(receipt, operationId, { action: "ask", question, sourceMessageIds, goalId });
    if (prior) return prior.goalId;
    const previous = goalId ? this.pending(receipt).find(value => value.goalId === goalId) : undefined;
    if (goalId && (!previous || previous.unavailable)) throw Error("待澄清目标已变化或不属于本轮可见上下文");
    if (previous) {
      const additions = sourceMessageIds.filter(id => !previous.sourceMessageIds.includes(id));
      if (this.pending(receipt).some(other => other.goalId !== previous.goalId && other.sourceMessageIds.some(id => additions.includes(id))))
        throw Error("延长待澄清目标不能混入另一个目标的来源");
    }
    const ids = [...new Set([...(previous?.sourceMessageIds ?? []), ...sourceMessageIds, receipt.user_message_id])];
    this.messages.validateWorkUserInput(receipt, ids);
    const sources = ids.map(id => botDelegationSourceSchema.parse(this.messages.message(id)));
    const id = goalId ?? `clarification:${randomUUID()}`;
    const stored = previous ? this.scoped(receipt).find(item => item.goal.goalId === id) : undefined;
    const next: Goal = { goalId: id, sources, question, state: "pending", updatedBy: receipt.assistant_message_id };
    this.update(stored?.messageId ?? receipt.assistant_message_id, state => {
      if (stored) {
        const index = state.goals.findIndex(item => item.goalId === id && JSON.stringify(item) === JSON.stringify(stored.goal));
        if (index < 0) throw Error("澄清目标已被另一请求修改");
        state.goals[index] = next;
      } else state.goals.push(next);
    });
    this.record(receipt, { operationId, hash, goalId: id, action: "ask" }); return id;
  }
  select(receipt: BotMessageReceipt, input: { sourceMessageIds?: string[]; clarificationGoalId?: string; independentGoal?: boolean }) {
    const pending = this.pending(receipt);
    if (input.independentGoal && input.clarificationGoalId) throw Error("新目标和补充待澄清目标不能同时选择");
    const explicit = input.clarificationGoalId ? pending.find(value => value.goalId === input.clarificationGoalId) : undefined;
    if (input.clarificationGoalId && (!explicit || explicit.unavailable)) throw Error("待澄清目标已失效、已派发或不属于本次会话");
    const selected = explicit ? [explicit] : pending.filter(value => value.sourceMessageIds.some(id => input.sourceMessageIds?.includes(id)));
    if (selected.some(goal => goal.unavailable)) throw Error("待澄清目标来源不可用，未以当前短回答替代原始要求");
    const referenced = pending.filter(goal => goal.sourceMessageIds.some(id => input.sourceMessageIds?.includes(id)));
    if (explicit && referenced.some(goal => goal.goalId !== explicit.goalId)) throw Error("一次委托不能混合多个待澄清目标，请分别处理");
    if (selected.length > 1) throw Error("一次委托不能混合多个待澄清目标，请分别处理");
    if (selected.length && input.independentGoal) throw Error("已引用待澄清目标，不能声明独立新目标");
    if (pending.length && !selected.length && !input.independentGoal) throw Error(`存在尚未完成的澄清：${JSON.stringify(pending)}。补充其中一个目标时选择 clarificationGoalId；明确无关的新目标才传 independentGoal:true。目标不明确时向用户问清，不能猜测或循环重试。`);
    return { sourceMessageIds: selected[0] ? [...new Set([...selected[0].sourceMessageIds, ...(input.sourceMessageIds ?? [])])] : input.sourceMessageIds, goalId: selected[0]?.goalId };
  }
  cancel(receipt: BotMessageReceipt, operationId: string, goalId: string) {
    if (this.messages.peers.origin(receipt.user_message_id)) throw Error("Bot 转述不能取消用户待澄清目标");
    const { hash, prior } = this.replay(receipt, operationId, { action: "cancel", goalId }); if (prior) return;
    const stored = this.scoped(receipt).find(item => item.goal.goalId === goalId);
    if (!stored || stored.goal.state !== "pending") throw Error("待澄清目标已失效或不属于本次会话");
    this.update(stored.messageId, state => {
      const goal = state.goals.find(item => item.goalId === goalId && JSON.stringify(item) === JSON.stringify(stored.goal));
      if (!goal) throw Error("澄清目标已被另一请求修改");
      goal.state = "cancelled"; goal.updatedBy = receipt.assistant_message_id;
    });
    this.record(receipt, { operationId, hash, goalId, action: "cancel" });
  }
  consume(receipt: BotMessageReceipt, goalId: string | undefined, workId: string) {
    if (!goalId) return;
    const stored = this.scoped(receipt).find(item => item.goal.goalId === goalId);
    if (!stored || stored.goal.state !== "pending") throw Error("待澄清目标已被另一请求受理");
    this.update(stored.messageId, state => {
      const goal = state.goals.find(item => item.goalId === goalId && JSON.stringify(item) === JSON.stringify(stored.goal));
      if (!goal || goal.state !== "pending") throw Error("待澄清目标已被另一请求受理");
      goal.state = "consumed"; goal.workId = workId;
    });
  }
}
