/**
 * 回答调度的版本管理：保存记录、改动摘要、恢复生成新版本、备注、两版对比、保留上限、并发校验。
 * 只用临时数据库，不接触用户数据。
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { AnswerRoutingService } from "../src/main/agent/AnswerRoutingService";
import { locateRuntimeAudit } from "../src/main/platform/runtime-audit";
import { DOTS_TASK_ID } from "../src/shared/dots";
import { defaultAnswerRuleId, maxAnswerRuleVersions } from "../src/shared/answer-routing";

const dir = await mkdtemp(join(tmpdir(), "mybuddy-answer-versions-"));
const useNative = process.argv.includes("--native");
const runtimeAuditExecutable = useNative ? locateRuntimeAudit(process.cwd()) : undefined;
if (useNative) assert.ok(runtimeAuditExecutable && existsSync(runtimeAuditExecutable));
const db = new AppDatabase(join(dir, "app.db"), { runtimeAuditExecutable });
const routing = new AnswerRoutingService(db, () => undefined);
const sqlite = db.connection;

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

async function settingsWrite<T>(write: () => Promise<T>): Promise<T> {
  if (useNative) sqlite.pragma("query_only = ON");
  try { return await write(); }
  finally { if (useNative) sqlite.pragma("query_only = OFF"); }
}

const savedSettings = await settingsWrite(() => routing.saveSettings({ title: "会议安排", include: ["会议"], exclude: [],
  instruction: "列出时间", evidenceFile: "agenda.txt", enabled: true, projectId: null, sourceMemoryId: null }));
const changedSettings = await settingsWrite(() => routing.saveSettings({ ...savedSettings, instruction: "列出时区" }, savedSettings));
assert.equal(changedSettings.revision, 2);
assert.equal((await settingsWrite(() => routing.saveSettings(changedSettings, changedSettings))).revision, 2);
await assert.rejects(settingsWrite(() => routing.saveSettings({ ...savedSettings, instruction: "旧版修改" }, savedSettings)), /规则已变化/);

const currentUse = sqlite.prepare("INSERT INTO answer_rule_turns(task_id,input_id,rule_id,revision,title,at,detail,phrase,evidence,scope,status,snapshot) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)");
const oldUse = sqlite.prepare("INSERT INTO answer_rule_uses(task_id,input_id,rule_id,revision,title,at,detail) VALUES (?,?,?,?,?,?,?)");
currentUse.run(DOTS_TASK_ID, "routing-new", savedSettings.id, 2, "会议安排", 50, "按时区核对", "会议",
  JSON.stringify({ kind: "task-file", reference: "agenda.txt", status: "read" }), "{}", "applied", null);
oldUse.run(DOTS_TASK_ID, "routing-new", savedSettings.id, 1, "旧记录", 60, "会被当前记录覆盖");
oldUse.run(DOTS_TASK_ID, "routing-old", savedSettings.id, 1, "会议安排", 30, "旧格式记录");

const retired = await settingsWrite(() => routing.saveSettings({ ...changedSettings, enabled: false }, changedSettings));
assert.equal(retired.revision, 3);
if (useNative) {
  sqlite.exec("CREATE TEMP TABLE answer_rules AS SELECT * FROM main.answer_rules WHERE 0; "
    + "CREATE TEMP TABLE answer_rule_versions AS SELECT * FROM main.answer_rule_versions WHERE 0; "
    + "CREATE TEMP TABLE answer_rule_turns AS SELECT * FROM main.answer_rule_turns WHERE 0; "
    + "CREATE TEMP TABLE answer_rule_uses AS SELECT * FROM main.answer_rule_uses WHERE 0");
}
try {
  const [latest] = await routing.readList();
  assert.deepEqual([latest.id, latest.title, latest.revision, latest.enabled], [savedSettings.id, "会议安排", 3, false]);
  assert.equal((await routing.readPreview("天气", null))?.rule.title, "天气");
  const settingsHistory = await routing.readVersions(savedSettings.id);
  assert.deepEqual(settingsHistory.map(version => [version.revision, version.source, version.uses]),
    [[3, "save", 0], [2, "save", 0], [1, "save", 0]]);
  const receipts = await routing.readHistory({ taskId: DOTS_TASK_ID, inputIds: ["routing-old", "routing-new", "routing-new"] });
  assert.deepEqual(receipts.map(r => [r.inputId, r.detail, r.routeStatus, r.evidence?.reference]), [
    ["routing-new", "按时区核对", "revoked", "agenda.txt"],
    ["routing-old", "旧格式记录", undefined, undefined],
  ]);
} finally {
  if (useNative) sqlite.exec("DROP TABLE temp.answer_rule_uses; DROP TABLE temp.answer_rule_turns; "
    + "DROP TABLE temp.answer_rule_versions; DROP TABLE temp.answer_rules");
}
const restoredSettings = await settingsWrite(() => routing.restoreSettings(savedSettings.id, 1));
assert.deepEqual([restoredSettings.revision, restoredSettings.instruction, restoredSettings.enabled], [4, "列出时间", true]);
assert.deepEqual((await routing.readVersions(savedSettings.id)).slice(0, 2).map(({ revision, source }) => [revision, source]),
  [[4, "restore"], [3, "save"]]);
await assert.rejects(settingsWrite(() => routing.removeSettings(savedSettings.id, 1)), /规则已变化/);
await settingsWrite(() => routing.removeSettings(savedSettings.id, 4));
assert.equal((await routing.readList()).some(rule => rule.id === savedSettings.id), false);
assert.ok((await routing.readList()).some(rule => rule.title === "天气"));
assert.deepEqual(await routing.readVersions(savedSettings.id), []);
await db.runtimeAuditReader?.close();
console.log("answer-routing versions ok");
db.close();
