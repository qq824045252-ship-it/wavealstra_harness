/**
 * Project Autopilot 测试：ProjectStatusSnapshot（纯派生）与 project_status_get / project_review 工具。
 * 覆盖：A/B 隔离、派生规则（逾期/停滞/风险/下一步）、改绑/解绑、readonly/归档门禁、
 * 删除级联、重启一致性、工具入口 scope。真实 SQLite + service + extension execute。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DbIpc } from "../src/shared/agent-ipc";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { MemoryService } from "../src/main/memory/MemoryService";
import { ProjectRepository } from "../src/main/project/ProjectRepository";
import { ProjectService } from "../src/main/project/ProjectService";
import { createProjectAutopilotExtension } from "../src/main/project/project-autopilot-extension";

let passed = 0;
function ok(cond: unknown, label: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    console.error(`  ✗ ${label}`);
    process.exitCode = 1;
  }
}

interface Tool {
  name: string;
  execute: (t: string, p: never) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
    details?: unknown;
  }>;
}

function makeTools(projectId: string | null, permissionMode = "default"): Map<string, Tool> {
  const tools = new Map<string, Tool>();
  const api = {
    registerTool: (tool: never) => {
      const t = tool as unknown as Tool;
      tools.set(t.name, t);
    },
    on: () => undefined,
  } as unknown as ExtensionAPI;
  createProjectAutopilotExtension({
    taskId: "task-ap",
    resolveProjectId: () => projectId,
    projectService: projects,
    getPermissionMode: () => permissionMode as never,
  })(api);
  return tools;
}

const root = mkdtempSync(join(tmpdir(), "mybuddy-autopilot-"));
const db = new AppDatabase(join(root, "app.db"));
const projects = new ProjectService(new ProjectRepository(db.connection), new MemoryService(db, { semantic: false }));

const NOW = 1_800_000_000_000; // 固定时钟（2027-01-18 前后）
const DAY = 24 * 3600 * 1000;

db.connection
  .prepare(`INSERT INTO projects (id, name, created_at, updated_at) VALUES ('proj-a', '项目A', 1, 1), ('proj-b', '项目B', 1, 1)`)
  .run();
db.connection
  .prepare(`INSERT INTO tasks (id, title, updated_at, project_id, status, archived) VALUES
    ('task-a1', 'A进行中任务', ${NOW - 2 * DAY}, 'proj-a', 'in_progress', 0),
    ('task-a2', 'A停滞任务', ${NOW - 20 * DAY}, 'proj-a', 'in_progress', 0),
    ('task-a3', 'A完成任务', ${NOW - 3 * DAY}, 'proj-a', 'completed', 0),
    ('task-b1', 'B任务', ${NOW - 1 * DAY}, 'proj-b', 'in_progress', 0)`)
  .run();

async function main(): Promise<void> {
  ok(DbIpc.getProjectStatus === "db:getProjectStatus" && DbIpc.recordProjectReview === "db:recordProjectReview", "0. UI IPC 通道常量已注册（Cockpit 接线契约）");

  /* 1. 派生规则：任务/计划/记忆 → blockers/atRisks/nextActions/health */
  const todoOverdue = projects.createTodo({ projectId: "proj-a", title: "逾期交付项", status: "doing", dueAt: NOW - 5 * DAY, priority: "high" });
  const todoDoing = projects.createTodo({ projectId: "proj-a", title: "正常进行项", status: "doing", dueAt: NOW + 2 * DAY });
  projects.createTodo({ projectId: "proj-a", title: "已完成项", status: "done" });
  projects.createMemory({ projectId: "proj-a", kind: "risk", title: "供应商风险", importance: 2 }, { sourceType: "agent", sourceTaskId: "task-a1" });
  projects.createMemory({ projectId: "proj-a", kind: "open_question", title: "交付范围待确认", importance: 3 }, { sourceType: "manual" });

  const snap = projects.buildStatusSnapshot("proj-a", NOW);
  ok(snap.health === "red", "1. 有阻塞 → health=red");
  ok(snap.blockers.some((b) => b.source === "plan" && b.refId === todoOverdue.id && b.reason.includes("逾期")), "1b. 逾期计划项入 blockers");
  ok(snap.atRisks.some((b) => b.source === "task" && b.refId === "task-a2" && b.reason.includes("7 天")), "1c. 停滞任务入 atRisks");
  ok(snap.atRisks.some((b) => b.source === "memory" && b.title === "供应商风险"), "1d. active risk 记忆入 atRisks");
  ok(snap.atRisks.some((r) => r.source === "memory" && r.title === "交付范围待确认"), "1e. 高重要度 open_question 入 atRisks");
  ok(snap.nextActions.some((a) => a.refId === todoOverdue.id || a.refId === todoDoing.id), "1f. 计划 doing 入 nextActions");
  ok(snap.nextActions.some((a) => a.source === "task" && a.refId === "task-a1"), "1g. 任务 doing 入 nextActions");
  ok(snap.tasks.total === 3 && snap.tasks.active === 2 && snap.tasks.doing === 2 && snap.tasks.stale === 1, "1h. 任务统计正确（completed 不计 active）");
  ok(snap.plan.total === 3 && snap.plan.overdue === 1, "1i. 计划统计正确");
  ok(snap.memory.openQuestions === 1 && snap.memory.risks === 1, "1j. 记忆统计正确");

  /* 2. 状态变化 → 快照实时派生（无缓存） */
  projects.updateTodo({ id: todoOverdue.id, status: "done" });
  const snap2 = projects.buildStatusSnapshot("proj-a", NOW);
  ok(snap2.blockers.every((b) => b.refId !== todoOverdue.id), "2. 逾期项完成后 blockers 即时消失（派生无缓存）");
  ok(snap2.health === "yellow" || snap2.health === "red", "2b. 停滞任务仍保持非 green");
  projects.updateTodo({ id: todoOverdue.id, status: "doing", dueAt: NOW - 5 * DAY });

  /* 3. A/B 隔离：B 快照不含 A 内容 */
  const snapB = projects.buildStatusSnapshot("proj-b", NOW);
  ok(snapB.tasks.total === 1 && snapB.blockers.length === 0 && snapB.plan.total === 0, "3. B 快照独立（不含 A 数据）");

  /* 4. review：记录 + lastReviewedAt + 门禁 */
  ok(snap.lastReviewedAt === null, "4. 初始无 review");
  assert.throws(() => projects.recordReview("proj-a", "x".repeat(501), "task:t"), /备注不能超过 500/);
  projects.recordReview("proj-a", "本周评审：跟进供应商", "task:task-a1");
  const snapRev = projects.buildStatusSnapshot("proj-a", NOW);
  ok(snapRev.lastReviewedAt !== null, "4b. review 后 lastReviewedAt 更新（审计标记）");
  ok(projects.listReviews("proj-a").length === 1, "4c. review 历史可查");
  // review 不影响派生数据
  ok(snapRev.tasks.total === snap.tasks.total, "4d. review 不改变派生统计");

  /* 5. 工具入口：scope / 未绑定 / readonly / 归档 */
  const toolsA = makeTools("proj-a");
  ok(!toolsA.has("project_action_apply"), "5a. recommendation-only：不注册建议执行工具");
  const status = await toolsA.get("project_status_get")!.execute("tc", {} as never);
  ok(status.isError === undefined && status.content[0].text.includes("健康度"), "5. status_get 输出实时健康度");
  ok(status.content[0].text.includes("逾期交付项") && status.content[0].text.includes("id="), "5b. 输出带来源引用 id");
  const toolsNone = makeTools(null);
  const noneStatus = await toolsNone.get("project_status_get")!.execute("tc", {} as never);
  ok(noneStatus.isError === true && noneStatus.content[0].text.includes("未绑定"), "5c. 未绑定任务受控错误");
  const reviewOk = await toolsA.get("project_review")!.execute("tc", { note: "第二轮评审" } as never);
  ok(reviewOk.isError === undefined, "5d. review 写入正常");
  const toolsRo = makeTools("proj-a", "readonly");
  const roStatus = await toolsRo.get("project_status_get")!.execute("tc", {} as never);
  ok(roStatus.isError === undefined, "5e. readonly 允许读状态");
  const roReview = await toolsRo.get("project_review")!.execute("tc", { note: "x" } as never);
  ok(roReview.isError !== true, "5f. legacy readonly no longer blocks the requested operation");
  projects.archive("proj-a", true);
  const archReview = await toolsA.get("project_review")!.execute("tc", { note: "x" } as never);
  ok(archReview.isError === true && archReview.content[0].text.includes("归档"), "5g. 归档项目拒绝 review");
  const archStatus = await toolsA.get("project_status_get")!.execute("tc", {} as never);
  ok(archStatus.isError === undefined, "5h. 归档项目仍可读状态");
  projects.archive("proj-a", false);

  /* 6. 删除级联：项目删除 → reviews 随 FK 清理 */
  db.connection.prepare(`INSERT INTO projects (id, name, created_at, updated_at) VALUES ('proj-del', '待删', 1, 1)`).run();
  projects.recordReview("proj-del", "r", "task:x");
  new ProjectRepository(db.connection).delete("proj-del");
  const orphanCount = db.connection.prepare(`SELECT COUNT(*) AS n FROM project_reviews WHERE project_id = 'proj-del'`).get() as { n: number };
  ok(orphanCount.n === 0, "6. 项目删除后 reviews 级联清理（无孤儿）");

  /* 7. 任务改绑：快照跟随新项目 */
  db.upsertTask({ id: "task-a1", title: "A进行中任务", updatedAt: NOW - 2 * DAY, projectId: "proj-b", status: "in_progress", welcomeMode: "coding" });
  const snapRebind = projects.buildStatusSnapshot("proj-a", NOW);
  ok(snapRebind.tasks.total === 2, "7. 改绑后 A 快照任务数减少");
  const snapB2 = projects.buildStatusSnapshot("proj-b", NOW);
  ok(snapB2.tasks.total === 2, "7b. B 快照包含改绑来的任务");
  db.upsertTask({ id: "task-a1", title: "A进行中任务", updatedAt: NOW - 2 * DAY, projectId: "proj-a", status: "in_progress", welcomeMode: "coding" });

  /* 8. 重启一致性：reviews 持久化 */
  db.close();
  const db2 = new AppDatabase(join(root, "app.db"));
  const proj2 = new ProjectService(new ProjectRepository(db2.connection), new MemoryService(db2, { semantic: false }));
  const snapRestart = proj2.buildStatusSnapshot("proj-a", NOW);
  ok(snapRestart.lastReviewedAt !== null, "8. 重启后 review 持久（lastReviewedAt 保留）");
  ok(snapRestart.atRisks.some((b) => b.title === "供应商风险"), "8b. 重启后派生快照一致");

  /* 9. Action Proposals：生成规则 / 幂等 / stale（recommendation-only） */
  proj2.updateTodo({ id: todoOverdue.id, status: "todo", dueAt: NOW - 5 * DAY });
  const proposalsA = proj2.generateActionProposals("proj-a", NOW);
  const fpCount = new Map<string, number>();
  for (const p of proposalsA) fpCount.set(`${p.actionType}:${p.targetRef ?? ""}`, (fpCount.get(`${p.actionType}:${p.targetRef ?? ""}`) ?? 0) + 1);
  ok([...fpCount.values()].every((n) => n === 1), "9. 指纹幂等：同源同动作不重复");
  const planProposal = proposalsA.find((p) => p.actionType === "locate_plan" && p.targetRef === todoOverdue.id);
  ok(planProposal !== undefined && planProposal.executable === false, "9b. 逾期 todo 只生成定位建议，不自动推断 doing");
  ok(proposalsA.some((p) => p.actionType === "locate_task" && p.targetRef === "task-a2"), "9c. 停滞任务生成 locate_task");
  ok(proposalsA.some((p) => p.actionType === "needs_confirmation" && p.title.includes("供应商风险")), "9d. 风险生成 needs_confirmation（仅建议）");
  const again = proj2.generateActionProposals("proj-a", NOW);
  ok(again.length === proposalsA.length, "9e. 重复生成不堆叠（同指纹 upsert）");
  ok(proj2.getTodo(planProposal!.targetRef!)?.status === "todo", "9f. 建议生成不写入计划状态");
  // 源变化 → obsolete/stale，而非悬空。
  proj2.updateTodo({ id: planProposal!.targetRef!, status: "done" });
  const regen = proj2.generateActionProposals("proj-a", NOW);
  ok(regen.some((p) => p.id === planProposal!.id && (p.status === "stale" || p.status === "obsolete")), "9h. 源完成后建议失效但保留审计");
  ok(!toolsA.has("project_action_apply"), "9k. 建议层没有任何 apply 入口");

  /* 10. Action Proposals：跨项目隔离 / 删除级联 */
  const proposalsB = proj2.generateActionProposals("proj-b", NOW);
  ok(!proposalsB.some((p) => p.title.includes("A") || p.targetRef === planProposal!.targetRef), "10. B 项目建议不包含 A 内容");
  ok(!makeTools("proj-b").has("project_action_apply"), "10b. B 同样不存在建议执行入口");
  db2.connection.prepare(`INSERT INTO projects (id, name, created_at, updated_at) VALUES ('proj-del2', '待删2', 1, 1)`).run();
  proj2.generateActionProposals("proj-del2", NOW);
  new ProjectRepository(db2.connection).delete("proj-del2");
  const propOrphan = db2.connection
    .prepare(`SELECT COUNT(*) AS n FROM project_action_proposals WHERE project_id = 'proj-del2'`)
    .get() as { n: number };
  ok(propOrphan.n === 0, "10c. 项目删除后 proposals 级联清理（无孤儿）");

  /* 11. Attention：派生 / 去重 / 确认 / 隔离 / 自动收敛 */
  const { ProjectAttentionTracker } = require("../src/main/project/ProjectAttention") as typeof import("../src/main/project/ProjectAttention");
  const tracker = new ProjectAttentionTracker(proj2);
  const att1 = tracker.getAttention("proj-a", NOW);
  ok(att1 !== null && att1.health === "yellow" && att1.blockerCount === 0 && att1.atRiskCount > 0, "11. 风险项目 attention=yellow，非强制 blocker");
  ok(att1!.seen === false, "11b. 初始未确认");
  ok(tracker.onChange("proj-a", NOW) === null, "11c. 无变化不重复广播（指纹去重）");
  const acked = tracker.acknowledge("proj-a", NOW);
  ok(acked !== null && acked.seen === true, "11d. 确认后 seen=true");
  ok(acked!.fingerprint === att1!.fingerprint, "11e. 确认指纹与当前一致");
  // 状态变化 → 新指纹 → 重新未确认 + 广播（完成停滞任务，blocker 减少）
  db2.upsertTask({ id: "task-a2", title: "A停滞任务", updatedAt: NOW - 20 * DAY, projectId: "proj-a", status: "completed" });
  const att2 = tracker.onChange("proj-a", NOW);
  ok(att2 !== null && att2.fingerprint !== att1!.fingerprint && att2.seen === false, "11f. 状态变化后重新未确认并广播");
  ok(att2!.atRiskCount < att1!.atRiskCount, "11g1. 完成停滞任务后 atRisk 减少");
  // 再解决记忆风险 → 完全收敛（badge 消失语义）
  const riskItem = proj2.listMemory("proj-a").find((m) => m.title === "供应商风险")!;
  proj2.updateMemory({ projectId: "proj-a", id: riskItem.id, status: "resolved" });
  const att3 = tracker.onChange("proj-a", NOW);
  ok(att3 !== null && att3!.blockerCount === 0 && att3!.health !== "red", "11g2. 全部阻塞解决后 attention 自动收敛");
  // 隔离：B 的 attention 独立（B 无阻塞）
  const attB = tracker.getAttention("proj-b", NOW);
  ok(attB !== null && attB.blockerCount === 0 && attB.health !== "red", "11h. B 项目 attention 独立且无阻塞");
  // 不存在项目 → null（受控）
  ok(tracker.getAttention("proj-nope", NOW) === null, "11i. 不存在项目返回 null");
  db2.close();
  rmSync(root, { recursive: true, force: true });
  if (process.exitCode) {
    console.error("project-autopilot-test: FAILED");
  } else {
    console.log(`project-autopilot-test: PASS (${passed})`);
  }
}

void main().catch((err) => {
  console.error("project-autopilot-test: FAILED", err);
  process.exitCode = 1;
});


