/**
 * 回答调度的版本管理：保存记录、改动摘要、恢复生成新版本、备注、两版对比、保留上限、并发校验。
 * 只用临时数据库，不接触用户数据。
 */
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { AnswerRoutingService } from "../src/main/agent/AnswerRoutingService";
import { DOTS_TASK_ID } from "../src/shared/dots";
import { defaultAnswerRuleId, maxAnswerRuleVersions } from "../src/shared/answer-routing";

const dir = await mkdtemp(join(tmpdir(), "mybuddy-answer-versions-"));
const db = new AppDatabase(join(dir, "app.db"));
const routing = new AnswerRoutingService(db, () => undefined);

const baseline = routing.list().find(rule => rule.id === defaultAnswerRuleId);
assert.ok(baseline?.policy, "默认调度策略应带策略");
const seed = routing.versions(defaultAnswerRuleId);
assert.deepEqual(seed.map(version => version.revision), [baseline.revision]);
assert.equal(seed[0].source, "baseline");
assert.equal(seed[0].note, "", "默认没有备注");
assert.equal(seed[0].uses, 0, "还没被任何对话使用");

const changed = routing.save({
  ...baseline,
  policy: { ...baseline.policy, foregroundReadLimits: { characters: 8_000, sources: 2, calls: 2 } },
}, baseline);
assert.equal(changed.revision, baseline.revision + 1);

const unchanged = routing.save({ ...changed }, changed);
assert.equal(unchanged.revision, changed.revision, "重复保存相同内容不新增版本");

const history = routing.versions(defaultAnswerRuleId);
assert.equal(history.length, 2, "无改动的保存不进入版本历史");
assert.equal(history[0].revision, changed.revision);
assert.match(history[0].changes.join("；"), /读取上限 24000 字\/4 来源\/6 次 → 8000 字\/2 来源\/2 次/);
assert.match(history[0].summary, /读取上限 8000 字\/2 来源\/2 次/);

// 两版对比：逐项列出差异，不重复展示相同项。
const diff = routing.compare(defaultAnswerRuleId, baseline.revision, changed.revision);
assert.deepEqual(diff.entries.map(entry => entry.label), ["前台读取上限"]);
assert.equal(diff.entries[0].before, "24000 字/4 来源/6 次");
assert.equal(diff.entries[0].after, "8000 字/2 来源/2 次");
assert.throws(() => routing.compare(defaultAnswerRuleId, baseline.revision, 999), /找不到第 999 版/);

// 备注只属于那一版。
routing.annotate(defaultAnswerRuleId, changed.revision, "  临时提高读取上限  ");
const noted = routing.versions(defaultAnswerRuleId).find(version => version.revision === changed.revision);
assert.equal(noted?.note, "临时提高读取上限");
assert.throws(() => routing.annotate(defaultAnswerRuleId, 999, "x"), /找不到这个版本/);

// 按版本统计跑了多少轮。
db.upsertTask({ id: DOTS_TASK_ID, title: "调度对话", cwd: dir, modelId: "fixture/fixture", updatedAt: 1 });
db.connection.prepare(`INSERT INTO answer_rule_turns(task_id,input_id,rule_id,revision,title,at,detail,phrase,evidence,scope,status,snapshot)
  VALUES(?,?,?,?,?,?,?,?,?,?,?,?)`).run(DOTS_TASK_ID, "input-1", defaultAnswerRuleId, changed.revision,
  "默认调度策略", Date.now(), "采用默认调度策略", "", null, "{}", "applied", null);
assert.equal(routing.versions(defaultAnswerRuleId).find(version => version.revision === changed.revision)?.uses, 1);

const restored = routing.restore(defaultAnswerRuleId, baseline.revision);
assert.equal(restored.revision, changed.revision + 1);
assert.deepEqual(restored.policy?.foregroundReadLimits, baseline.policy?.foregroundReadLimits);
const afterRestore = routing.versions(defaultAnswerRuleId);
assert.equal(afterRestore[0].source, "restore");
assert.equal(afterRestore[0].note, "", "恢复不复制旧版备注");
assert.match(afterRestore[0].changes.join("；"), /读取上限 8000 字\/2 来源\/2 次 → 24000 字\/4 来源\/6 次/);
assert.throws(() => routing.restore(defaultAnswerRuleId, restored.revision), /这已经是当前版本/);

const rule = routing.save({ title: "天气", include: ["天气"], exclude: [], instruction: "按出行时段回答",
  evidenceFile: "", enabled: true, projectId: null, sourceMemoryId: null });
const edited = routing.save({ ...rule, include: ["天气", "气温"] }, rule);
assert.equal(edited.revision, 2);
assert.match(routing.versions(rule.id)[0].changes.join("；"), /触发短语 1 条 → 2 条/);
assert.match(routing.versions(rule.id)[0].summary, /2 个触发短语/);

const ruleDiff = routing.compare(rule.id, 1, 2);
assert.deepEqual(ruleDiff.entries.map(entry => entry.label), ["触发短语"]);
assert.equal(ruleDiff.entries[0].before, "天气");
assert.equal(ruleDiff.entries[0].after, "天气、气温");

const back = routing.restore(rule.id, 1);
assert.equal(back.revision, 3);
assert.deepEqual(back.include, ["天气"]);
assert.match(routing.versions(rule.id)[0].changes.join("；"), /触发短语 2 条 → 1 条/);
assert.throws(() => routing.save({ ...back, title: "改名" }, { id: rule.id, revision: 1 }), /规则已变化/);

// 保留上限：只留最近 maxAnswerRuleVersions 版，删最旧的。
let churn = routing.save({ title: "保留测试", include: ["保留"], exclude: [], instruction: "测试",
  evidenceFile: "", enabled: true, projectId: null, sourceMemoryId: null });
for (let index = 1; index <= maxAnswerRuleVersions + 10; index += 1)
  churn = routing.save({ ...churn, title: `保留测试 ${index}` }, churn);
assert.equal(churn.revision, 1 + maxAnswerRuleVersions + 10);
const kept = routing.versions(churn.id);
assert.equal(kept.length, maxAnswerRuleVersions, "只保留最近 " + maxAnswerRuleVersions + " 版");
assert.equal(kept[kept.length - 1].revision, churn.revision - maxAnswerRuleVersions + 1, "删除最旧的版本");

console.log("answer-routing versions ok");
db.close();
