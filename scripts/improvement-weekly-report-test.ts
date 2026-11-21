import assert from "node:assert/strict";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { writeImprovementWeek } from "../src/main/agent/hooks/ImprovementWeeklyReport.ts";
import type { ImprovementReport } from "../src/shared/native-improvement.ts";

const dir = await mkdtemp(join(tmpdir(), "improvement-week-"));
try {
  const week = "2026-11-16";
  const report: ImprovementReport = { runs: [{week, at: 1, scanned: 2, added: 1, published: 1, issues: [], followup: []}], items: [], children: [], packages: [], outcomes: [], progress: {phase:"idle", done:0, total:0}, weeklyMetrics: [{week, opportunities:2, accepted:1, corrections:0, unassisted:1, recurrences:0, exposed:2, used:1, errors:0, falseTriggers:null, durationMs:12, modelRequests:3, toolCalls:4, userInputs:1}] };
  report.versionEvidence = [
    {packageId:"p1", revision:1, active:false, retired:true, week, previous:null, useCount:9, uses:[], cases:[{name:"原契约漏项",passed:true}],
      source:{taskId:"t",conversationId:"c",entry:2,trigger:1,input:1,actor:"main",at:1}},
    {packageId:"p1", revision:2, active:true, retired:false, week, previous:1, useCount:0, uses:[], cases:[]},
  ];
  report.outcomes = [{week, packageId:"p1", revision:1, state:"regressed", accepted:0, opportunities:2, corrections:1, errors:1,
    assets:[{kind:"memory",state:"pending",opportunities:2,used:0,accepted:0,corrections:0,errors:0},
      {kind:"tool",state:"ineffective",opportunities:2,used:2,accepted:0,corrections:1,errors:0}]}];
  const replays = [{ packageId:"p1", revision:1, source:{taskId:"t",conversationId:"c",entry:2,path:"C:/SECRET/report.md"}, hash:"a".repeat(64),
    cases:[{name:"原契约漏项", expected:"SECRET", observed:"SECRET", passed:true},{name:"C:/SECRET/item",passed:false}] }];
  await writeImprovementWeek(dir, report, week, replays);
  const pointer = JSON.parse(await readFile(join(dir,week,"current.json"), "utf8"));
  const base = join(dir,week,pointer.snapshot);
  assert.equal(JSON.parse(await readFile(join(base,"metrics.jsonl"), "utf8")).falseTriggers, null);
  const replay = await readFile(join(base,"replays", "summary.json"), "utf8");
  assert(!replay.includes("SECRET"));
  assert.equal(JSON.parse(replay)[0].cases[0].passed, true);
  assert.equal(JSON.parse(replay)[0].cases[0].name, "原契约漏项");
  assert.deepEqual(JSON.parse(replay)[0].source,{taskId:"t",conversationId:"c",entry:2});
  const changes = await readFile(join(base,"ledger","changes.md"), "utf8");
  assert.match(changes, /v1 · 已撤回 .*回放 1\/1 通过 · 运行回执 9 条 · 来源 t\/c #2/);
  assert.match(changes, /v2 · 启用 · 上一版本 1/);
  const retro = await readFile(join(base,"retro.md"), "utf8");
  assert.match(retro, /实际使用 1\/2（50\.0%）/);
  assert.match(retro, /误触发 未测量/);
  assert.match(retro, /p1 v1 · 退化／失效/);
  assert.match(retro, /记忆 · 待验证 · 使用 0\/2/);
  assert.match(retro, /脚本／工具 · 无效 · 使用 2\/2/);
  await writeImprovementWeek(dir, report, week, replays);
  assert.equal((await readdir(join(dir,week,"snapshots"))).length, 1);
  report.weeklyMetrics[0].accepted = 2;
  await writeImprovementWeek(dir, report, week, replays);
  assert.equal((await readdir(join(dir,week,"snapshots"))).length, 2);
  assert.equal(JSON.parse(await readFile(join(base,"metrics.jsonl"), "utf8")).accepted, 1);
  await writeImprovementWeek(dir, {...report, weeklyMetrics: []}, "2026-11-23", []);
  assert.equal((await readdir(dir)).length, 2);
  await assert.rejects(writeImprovementWeek(dir, report, "../escape", []));
  console.log("weekly improvement export checks passed");
} finally { await rm(dir, {recursive:true, force:true}); }
