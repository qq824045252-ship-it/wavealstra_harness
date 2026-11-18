import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * A foreground conversation Goal has no execution binding, so the only thing that can
 * carry its requirement into a turn is the system prompt. This test drives the real
 * AgentService → durable session → model request path and asserts what the model
 * actually receives as the Goal changes: unmet, partially attested, all met, paused,
 * cancelled and absent.
 */

const root = mkdtempSync(join(tmpdir(), "mybuddy-conversation-goal-prompt-"));
process.env.MYBUDDY_DISABLE_GOAL_CONTINUATION = "1";
process.env.USERPROFILE = root;
process.env.HOME = root;
mkdirSync(join(root, ".mybuddy", "plugins", "mcp"), { recursive: true });

const { AppDatabase } = await import("../src/main/db/AppDatabase");
const { createAgentDurableFixture } = await import("./agent-durable-fixture");
const { renderConversationGoalSection } = await import("../src/main/agent/ConversationGoalPrompt");

const db = new AppDatabase(join(root, "app.db"));
db.upsertTask({ id: "goal-task", title: "Goal", updatedAt: 1, welcomeMode: "coding" });
db.upsertTask({ id: "plain-task", title: "Plain", updatedAt: 1, welcomeMode: "coding" });

const fixture = await createAgentDurableFixture(root, db);
const { agent, requests } = fixture;

let turn = 0;
const prompt = async (taskId: string): Promise<string> => {
  turn += 1;
  await fixture.prompt({ taskId, text: `turn ${turn}`, userMessageId: `user-${turn}`, assistantMessageId: `assistant-${turn}` });
  const instructions = requests.at(-1)?.instructions ?? "";
  assert(instructions, "每一次模型请求都必须带系统提示词");
  return instructions;
};
const lastPromptHasGoalSection = (instructions: string): boolean => instructions.includes("## 对话 Goal");

const work = (id: string) => {
  const current = agent.getConversationGoals().workService.getWork(id);
  assert(current, "Goal 应存在");
  return current;
};
const criterion = (id: string) => work(id).criteria;
const attest = (goalId: string, id: string, evidence: string) => {
  const result = agent.updateConversationGoal({ goalId, criterionUpdates: [{ id, status: "met", evidence }] });
  assert(result.ok, `用户确认验收项应成功：${result.ok ? "" : result.message}`);
};

try {
  const created = agent.createConversationGoal({
    taskId: "goal-task", title: "修好登录超时", description: "定位并修复登录接口偶发超时，交付可复现的验证。",
    criteria: [{ text: "复现登录超时" }, { text: "修复后回归通过" }],
  });
  assert(created.ok, "创建 Goal 应成功");
  const goalId = created.goal.id;
  const [first, second] = criterion(goalId);
  assert(first && second, "Goal 应带两条验收条件");

  // 1. Unmet criteria reach the model with an explicit no-early-finish mandate.
  const unmetPrompt = await prompt("goal-task");
  assert(lastPromptHasGoalSection(unmetPrompt), "有活跃 Goal 时系统提示词必须包含 Goal 段");
  for (const expected of ["修好登录超时", "定位并修复登录接口偶发超时", "复现登录超时", "修复后回归通过", "[待满足]"]) {
    assert(unmetPrompt.includes(expected), `Goal 段应包含「${expected}」`);
  }
  assert(unmetPrompt.includes("不要以「完成 / 已交付 / 需要你确认 / 你先看看」之类的收尾结束本轮"),
    "未满足时必须禁止提前收尾");
  assert(unmetPrompt.includes("conversation_goal_propose_complete"), "未满足时必须说明唯一的收尾方式");
  assert(unmetPrompt.includes("conversation_goal_get 返回的版本守卫"), "模型必须知道汇报进展需要版本守卫");

  // 2. Attesting one criterion is visible on the very next model request.
  attest(goalId, first.id, "本地复现命令复现出 504");
  const partialPrompt = await prompt("goal-task");
  assert(partialPrompt.includes(`[已满足] ${first.text}`), "用户确认后的验收项应显示已满足");
  assert(partialPrompt.includes(`[待满足] ${second.text}`), "未确认的验收项仍应显示待满足");
  assert(partialPrompt.includes("继续调用工具推进下一个未满足的条件"), "仍有未满足条件时不得提前收尾");

  // 3. All criteria met switches to the completion-proposal contract.
  attest(goalId, second.id, "回归用例 12/12 通过");
  const allMetPrompt = await prompt("goal-task");
  assert(allMetPrompt.includes("验收条件已全部满足"), "全部满足后应改为提交结论的规则");
  assert(!allMetPrompt.includes("继续调用工具推进下一个未满足的条件"), "全部满足后不再要求继续推进");
  assert(allMetPrompt.includes("不要自行宣称 Goal 已完成"), "结论必须等用户确认");

  // 4. A paused Goal must not push the model to advance acceptance.
  const paused = agent.updateConversationGoal({ goalId, status: "paused" });
  assert(paused.ok, `暂停 Goal 应成功：${paused.ok ? "" : paused.message}`);
  const pausedPrompt = await prompt("goal-task");
  assert(pausedPrompt.includes("用户暂停了这个 Goal"), "暂停状态必须告诉模型");
  assert(!pausedPrompt.includes("继续调用工具推进下一个未满足的条件"), "暂停后不得继续推进验收条件");

  // 5. A cancelled Goal constrains nothing.
  const cancelled = agent.updateConversationGoal({ goalId, status: "cancelled" });
  assert(cancelled.ok, `取消 Goal 应成功：${cancelled.ok ? "" : cancelled.message}`);
  const cancelledPrompt = await prompt("goal-task");
  assert(!lastPromptHasGoalSection(cancelledPrompt), "已结束的 Goal 不应再进入提示词");

  // 6. Conversations without a Goal stay unchanged.
  const plainPrompt = await prompt("plain-task");
  assert(!lastPromptHasGoalSection(plainPrompt), "没有 Goal 的会话不应出现 Goal 段");
  assert(!plainPrompt.includes("继续调用工具推进下一个未满足的条件"), "没有 Goal 时不得附加 Goal 规则");

  // 7. Renderer contract: closed or empty goals render nothing, long goals stay bounded.
  const base = agent.getConversationGoals().toGoal(work(goalId), "goal-task");
  assert.equal(renderConversationGoalSection({ ...base, status: "achieved" }), null, "已达成 Goal 不产生约束");
  assert.equal(renderConversationGoalSection({ ...base, status: "cancelled" }), null, "已取消 Goal 不产生约束");
  assert.equal(renderConversationGoalSection(null), null, "无 Goal 时不渲染");
  const longGoal = renderConversationGoalSection({
    ...base, status: "active", description: "x".repeat(8_000),
    criteria: Array.from({ length: 12 }, (_, index) => ({ id: `c${index}`, text: `条件 ${index} ${"y".repeat(200)}`, status: "pending" as const })),
  })!;
  assert(longGoal.length < 4_100, "Goal 段必须有长度上界");
  assert(longGoal.endsWith("完整验收条件用 conversation_goal_get 读取）"), "截断时提示完整来源");

  console.log("PASS conversation Goal reaches the model with unmet criteria, attestation, completion, pause, cancel and absent states");
} finally {
  await fixture.close();
  db.close?.();
}