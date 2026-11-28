import assert from "node:assert/strict";
import { defaultAnswerRuleId, defaultDotsSchedulingPolicy, newAnswerRule } from "../src/shared/answer-routing";
import { DOTS_TASK_ID } from "../src/shared/dots";
import type { AppDatabase } from "../src/main/db/AppDatabase";
import { AnswerRoutingService } from "../src/main/agent/AnswerRoutingService";

export async function verifyDotsRoutingTurns(db: AppDatabase, workspace: string) {
  const core = db.runtimeAuditReader!;
  const state = async (inputId: string) => {
    const result = await core.answerRoutingData({ kind: "turnState", taskId: DOTS_TASK_ID, inputId });
    assert(result?.status === "turnState");
    return result;
  };
  const fresh = await state("dots-ordinary-fresh");
  assert.equal(fresh.prior?.rule_id, defaultAnswerRuleId);
  assert.equal(fresh.prior?.status, "applied");
  assert(fresh.prior.snapshot);
  assert.deepEqual(JSON.parse(fresh.prior.snapshot).policy, defaultDotsSchedulingPolicy());
  const service = () => new AnswerRoutingService(db, () => { throw new Error("该测试规则没有记忆来源"); });
  const first = service();
  const draft = { ...newAnswerRule(), title: "Replay verification", include: ["routing-transaction-709"],
    instruction: "Use revision one." };
  const rule = await first.saveSettings(draft);
  const turn = (inputId: string) => ({ inputId, taskId: DOTS_TASK_ID, cwd: workspace,
    query: "routing-transaction-709", canRead: () => false });
  const turnOne = turn("routing-replay-one");
  const turnTwo = turn("routing-replay-two");
  const prepared = await first.prepare(turnOne);
  assert.equal(prepared?.rule.id, rule.id);
  assert.equal(prepared?.rule.instruction, draft.instruction);
  const revisedDraft = { ...draft, instruction: "Use revision two." };
  const updated = await first.saveSettings(revisedDraft, rule);
  const replayed = await service().prepare(turnOne);
  assert.equal(replayed?.rule.revision, rule.revision);
  assert.equal(replayed?.rule.instruction, draft.instruction);
  const next = await service().prepare(turnTwo);
  assert.equal(next?.rule.revision, updated.revision);
  assert.equal(next?.rule.instruction, revisedDraft.instruction);
  await first.saveSettings({ ...revisedDraft, enabled: false }, updated);
  await assert.rejects(() => prepared!.validate(), /撤销|停用/);
  await assert.rejects(() => service().prepare(turnOne), /无法恢复|撤销/);
  await assert.rejects(() => service().prepare(turnTwo), /无法恢复|撤销/);
  assert.equal((await state(turnOne.inputId)).prior?.status, "revoked");
  assert.equal((await state(turnTwo.inputId)).prior?.status, "revoked");
  const staleInput = "routing-stale-first-write";
  const stale = await core.answerRoutingData({ kind: "recordTurn", taskId: DOTS_TASK_ID, inputId: staleInput,
    ruleId: updated.id, revision: updated.revision, title: updated.title, at: Date.now(), detail: "Late first write",
    phrase: draft.include[0], evidence: null, scope: JSON.stringify({ projectId: null, cwd: workspace }),
    status: "applied", snapshot: JSON.stringify(next!.rule) });
  assert.equal(stale?.status, "conflict");
  assert.equal((await state(staleInput)).prior, null);
  const latest = await service().prepare(turn("routing-after-withdrawal"));
  assert.equal(latest?.rule.id, defaultAnswerRuleId);
  console.log("PASS Core cold-start policy, two distinct revision receipts, replay, and revoked-rule exclusion");
}
