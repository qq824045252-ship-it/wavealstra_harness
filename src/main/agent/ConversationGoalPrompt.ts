import type { ConversationGoalDto, GoalContinuationDeferReason, GoalCriterionDto, GoalCriterionStatus } from "../../shared/conversation-goal";

/**
 * Live Goal section of the foreground system prompt.
 *
 * A conversation Goal is a Work projection, and a foreground conversation has no
 * execution binding: nothing else in the runtime tells the model that a long-term
 * goal with unmet criteria is still in force, and nothing stops it from ending the
 * turn as if it were done. This section is the only place where the current
 * requirement reaches the model. It is rendered per model request, never cached
 * with the static assembly capsule, so criterion states changed mid-turn are
 * visible on the next request.
 */

const GOAL_SECTION_MAX_CHARS = 4_000;
const TRUNCATION_SUFFIX = "\n（Goal 段已截断；完整验收条件用 conversation_goal_get 读取）";

const CRITERION_LABEL: Record<GoalCriterionStatus, string> = {
  pending: "待满足",
  met: "已满足",
  waived: "已豁免",
  not_met: "未满足",
};

const UNMET_RULES = `执行约束：
- 验收条件没有全部满足之前，不要以「完成 / 已交付 / 需要你确认 / 你先看看」之类的收尾结束本轮；继续调用工具推进下一个未满足的条件。
- 只有三种情况允许结束本轮：1) 全部验收条件已满足，且已用 conversation_goal_propose_complete 提交结论，由工具按原交办的验收约定处理；2) 需要只有用户能提供的输入（凭据、账号、授权、取舍、缺失资料）；3) 外部依赖确实未就绪，且能给出观测到的事实与恢复条件。
- 结束本轮必须写清：已完成项、仍未满足的条件、卡在哪一步、下一步需要什么。计划、口头说明和未执行的命令都不算完成。
- 普通对话的验收事实（met / waived）由用户确认。用 conversation_goal_update 提交进展时，携带 conversation_goal_get 返回的版本守卫。关联 Dots 的原交办达到条件后，读取工具返回的结项方式与版本，用 conversation_goal_propose_complete 提交本次实际成果的原文及逐项依据。该工具会按用户的约定处理验收。`;

const ALL_MET_RULES = `执行约束：
- 验收条件已全部满足。用 conversation_goal_propose_complete 提交结论与证据，并按工具返回结果交付或等待用户确认。不要自行宣称 Goal 已完成。`;

const PAUSED_RULES = `执行约束：
- 用户暂停了这个 Goal：不要自行推进它的验收条件，也不要把本轮的普通问答当成恢复信号。
- 只处理用户在当前消息里明确要求的事；需要恢复长期目标时请用户确认。`;

/** Criterion text is user-owned requirement language, so it is quoted verbatim, never re-summarized. */
function criterionLine(criterion: GoalCriterionDto): string {
  return `- [${CRITERION_LABEL[criterion.status]}] ${criterion.text.trim()}`;
}

export function renderConversationGoalSection(goal: ConversationGoalDto | null | undefined, originalMessage?: string): string | null {
  // Closed goals constrain nothing; an achieved/cancelled chip is history, not a mandate.
  if (!goal || goal.status === "achieved" || goal.status === "cancelled") return null;
  const title = goal.title.trim();
  if (!title) return null;

  const unmet = goal.criteria.filter(criterion => criterion.status === "pending" || criterion.status === "not_met");
  const rules = goal.status === "paused" ? PAUSED_RULES : goal.criteria.length > 0 && unmet.length === 0 ? ALL_MET_RULES : UNMET_RULES;
  const autoStop = goal.continuation?.state === "exhausted" ? exhaustedRule(goal.continuation.deferReason) : "";
  const lines = [
    "## 对话 Goal（本 Task 的长期目标，跨轮有效）",
    `- 标题：${title}`,
    ...(goal.description?.trim() ? [`- 目标说明：${goal.description.trim()}`] : []),
    ...(goal.criteria.length > 0
      ? ["- 验收条件：", ...goal.criteria.map(criterionLine)]
      : ["- 验收条件：用户没有设置验收条件，按目标说明推进；不要因为没有验收条件就提前收尾。"]),
    ...(goal.progressSummary?.trim() ? [`- 当前进展：${goal.progressSummary.trim()}`] : []),
    "",
    rules,
    ...(autoStop ? ["", autoStop] : []),
    ...(originalMessage ? ["", "建立 Goal 时选中的原始用户消息（后来明确更新的要求优先）：", originalMessage] : []),
  ];
  const body = lines.join("\n");
  return body.length > GOAL_SECTION_MAX_CHARS
    ? `${body.slice(0, GOAL_SECTION_MAX_CHARS - TRUNCATION_SUFFIX.length).trimEnd()}${TRUNCATION_SUFFIX}`
    : body;
}

function exhaustedRule(reason: GoalContinuationDeferReason | undefined): string {
  return reason === "budget"
    ? "宿主自动续跑已停止（token 预算用尽）：不会再有自动轮次。按用户当前消息处理；如需继续推进，写清剩余条件、下一步和所需输入，由用户手动「继续」。"
    : "宿主自动续跑已停止（自动轮次用尽）：不会再有自动轮次。按用户当前消息处理；如需继续推进，写清剩余条件、下一步和所需输入，由用户手动「继续」。";
}