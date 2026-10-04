/**
 * Project Event Triage / Promotion Loop 集成测试：
 * ingest → list/read → 显式 promote → 真实真源可见（memory/todo/library）→ provenance →
 * Autopilot 派生 → 幂等去重 → A/B 隔离 → readonly/archive → 事件保留淘汰后目标仍在 →
 * 重启持久化 → ref 幂等 ingest → cron 适配器（纯翻译 + CronService 集成）→ 扩展工具面。
 * 真实 SQLite + 注入时钟（确定性）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { MemoryService } from "../src/main/memory/MemoryService";
import { ProjectRepository } from "../src/main/project/ProjectRepository";
import { ProjectService } from "../src/main/project/ProjectService";
import { ProjectEventIngestor, cronRunEventInput } from "../src/main/project/ProjectEventIngestor";
import { ProjectEventPromoter } from "../src/main/project/ProjectEventPromoter";
import { ProjectAttentionTracker } from "../src/main/project/ProjectAttention";
import { createProjectEventExtension } from "../src/main/project/project-event-extension";
import { LibraryService } from "../src/main/library/LibraryService";
import { CronService } from "../src/main/cron/CronService";
import {
  PROJECT_EVENT_RETENTION_PER_PROJECT,
  type ProjectEventDto,
  type ProjectEventPromotionTargetKind,
} from "../src/shared/project-domain";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ProjectEventExtensionBridge } from "../src/main/project/project-event-extension";

let passed = 0;
let failed = 0;
function ok(cond: unknown, label: string): void {
  if (cond) {
    passed += 1;
    console.log(`  ✓ ${label}`);
  } else {
    failed += 1;
    console.error(`  ✗ ${label}`);
  }
}
function throws(fn: () => unknown, label: string): void {
  try {
    fn();
    ok(false, label);
  } catch {
    ok(true, label);
  }
}

const root = mkdtempSync(join(tmpdir(), "mybuddy-promotion-"));
const dbPath = join(root, "app.db");
const db = new AppDatabase(dbPath);
const projects = new ProjectService(new ProjectRepository(db.connection), new MemoryService(db, { semantic: false }));
const library = new LibraryService(db);
const NOW = 1_800_000_000_000;
const DAY = 24 * 3600 * 1000;
let clock = NOW;

db.connection
  .prepare(`INSERT INTO projects (id, name, created_at, updated_at) VALUES ('proj-a', 'A项目', 1, 1), ('proj-b', 'B项目', 1, 1)`)
  .run();

const tick = (): number => (clock += 1);
const ingestor = new ProjectEventIngestor(projects, { now: tick });
const promoter = new ProjectEventPromoter(projects, library, { now: () => clock });

function eventA(): ProjectEventDto {
  return ingestor.ingest("proj-a", { source: "gateway", kind: "message", title: "外部消息（alice）", body: "客户反馈：交付验收标准需确认", ref: "gw-1" });
}
function eventB(): ProjectEventDto {
  return ingestor.ingest("proj-b", { source: "gateway", kind: "message", title: "B 的消息", body: "B 项目内容", ref: "gw-b1" });
}

async function main(): Promise<void> {
  /* ============ 1. promote → memory：真源可见 + provenance（链接表 + memory evidence） ============ */
  const ev = eventA();
  const r1 = promoter.promote(ev.id, {
    targetKind: "memory",
    memoryKind: "risk",
    memoryTitle: "验收标准未确认",
    memoryContent: "客户反馈：交付验收标准需确认",
  });
  ok(!r1.reused && r1.targetKind === "memory", "1. 提升为记忆成功");
  const mem = projects.getMemory("proj-a", r1.targetId);
  ok(mem !== undefined && mem.kind === "risk" && mem.title === "验收标准未确认", "1b. 真源可见（memory 条目按给定字段创建）");
  ok(mem?.sourceType === "manual", "1c. UI 路径来源 manual");
  const memEvidence = mem?.evidence.find((e) => e.evidenceKind === "event");
  ok(memEvidence?.refId === ev.id && memEvidence.refTitle === ev.title, "1d. 目标侧溯源：memory evidence kind=event");
  const listA = projects.listProjectEvents("proj-a");
  const withPromo = listA.find((e) => e.id === ev.id);
  ok(withPromo?.promotions?.length === 1 && withPromo.promotions[0]!.targetId === r1.targetId, "1e. 事件侧溯源：list 带 promotion 链接");
  ok(withPromo?.promotions[0]!.eventTitle === ev.title, "1f. 链接带事件标题快照");

  /* ============ 2. 幂等：同事件同类型重复 promote → 复用，无重复垃圾 ============ */
  const beforeMemCount = projects.listMemory("proj-a").length;
  const r1b = promoter.promote(ev.id, { targetKind: "memory", memoryKind: "fact", memoryTitle: "另一个标题" });
  ok(r1b.reused && r1b.targetId === r1.targetId, "2. 重复 promote 幂等复用（忽略新字段）");
  ok(projects.listMemory("proj-a").length === beforeMemCount, "2b. 不产生重复 memory");
  const linkCount = (db.connection
    .prepare(`SELECT COUNT(*) AS c FROM project_event_promotions WHERE project_id='proj-a' AND event_id=? AND target_kind='memory'`)
    .get(ev.id) as { c: number }).c;
  ok(linkCount === 1, "2c. 链接唯一（UNIQUE 兜底）");

  /* ============ 3. promote → todo + library；跨类型允许 ============ */
  const r2 = promoter.promote(ev.id, {
    targetKind: "todo",
    todoTitle: "确认交付验收标准",
    todoDueAt: NOW + 2 * DAY,
    todoPriority: "high",
  });
  const todo = projects.getTodo(r2.targetId);
  ok(todo !== undefined && todo.title === "确认交付验收标准" && todo.dueAt === NOW + 2 * DAY && todo.priority === "high", "3. 提升为计划项（显式字段全落真源）");
  const r3 = promoter.promote(ev.id, { targetKind: "library", libraryTitle: "客户反馈记录", libraryContent: "客户反馈：交付验收标准需确认\n- 来源：gateway" });
  ok(!r3.reused, "3b. 提升为项目资料成功");
  const libItem = library.getItem(r3.targetId);
  ok(libItem !== undefined && libItem.title === "客户反馈记录", "3c. 资料真源可见");
  const libContent = library.getItem(r3.targetId) !== undefined;
  ok(libContent, "3d. 资料条目存在（正文经 writeContent 落受管文件）");
  ok(projects.listProjectEvents("proj-a").find((e) => e.id === ev.id)?.promotions?.length === 3, "3e. 同一事件三种目标共 3 条链接");

  /* ============ 4. Autopilot 派生：promotion 落真源后既有派生自然重算 ============ */
  const tracker = new ProjectAttentionTracker(projects);
  const digest = tracker.getAttention("proj-a", NOW + 3 * DAY);
  ok(digest !== null && digest.atRiskCount >= 1, "4. 非进行中的逾期 todo → at-risk（派生生效）");
  const snapshot = projects.buildStatusSnapshot("proj-a", NOW + 3 * DAY);
  ok(snapshot.atRisks.some((risk) => risk.source === "plan" && risk.refId === r2.targetId), "4b. snapshot risk 指向提升出的计划项");

  /* ============ 5. A/B 隔离：提升目标 = 事件所属项目（构造上无 projectId 参数） ============ */
  const evB = eventB();
  const rB = promoter.promote(evB.id, { targetKind: "todo", todoTitle: "B 的计划" });
  ok(rB.promotion.projectId === "proj-b" && projects.getTodo(rB.targetId)?.projectId === "proj-b", "5. B 事件提升 → B 项目（不可能跨项目）");
  ok(projects.listProjectEvents("proj-a").find((e) => e.id === ev.id)?.promotions?.length === 3, "5b. A 的链接未被 B 污染");
  throws(() => promoter.promote("no-such-event", { targetKind: "todo", todoTitle: "x" }), "5c. 不存在事件拒绝");

  /* ============ 6. 归档：拒绝写入、事件仍可读 ============ */
  db.connection.prepare(`UPDATE projects SET archived=1 WHERE id='proj-b'`).run();
  throws(() => promoter.promote(evB.id, { targetKind: "memory", memoryKind: "fact", memoryTitle: "x" }), "6. 归档项目拒绝提升（写门禁）");
  ok(ingestor.list("proj-b").length >= 1, "6b. 归档项目事件仍可读");
  db.connection.prepare(`UPDATE projects SET archived=0 WHERE id='proj-b'`).run();

  /* ============ 7. 字段必填/越界（service 强校验透传） ============ */
  const evVal = ingestor.ingest("proj-a", { source: "manual", kind: "note", title: "校验用事件", ref: "val-1" });
  throws(() => promoter.promote(evVal.id, { targetKind: "memory" }), "7. memory 缺 kind/title 拒绝");
  throws(() => promoter.promote(evVal.id, { targetKind: "todo" }), "7b. todo 缺标题拒绝");
  throws(() => promoter.promote(evVal.id, { targetKind: "library", libraryTitle: "x" }), "7c. library 缺正文拒绝");
  throws(() => promoter.promote(evVal.id, { targetKind: "todo", todoTitle: "x".repeat(501) }), "7d. 超长标题经 service 拒绝");

  /* ============ 8. 事件保留淘汰后：目标仍在、链接仍在、memory evidence 仍在 ============ */
  const evKeep = ingestor.ingest("proj-a", { source: "cron", kind: "run", title: "保留目标的事件", ref: "keep-1" });
  const rKeep = promoter.promote(evKeep.id, { targetKind: "memory", memoryKind: "fact", memoryTitle: "保留目标记忆" });
  let capClock = clock;
  const flood = new ProjectEventIngestor(projects, { now: () => ++capClock });
  for (let i = 0; i < PROJECT_EVENT_RETENTION_PER_PROJECT + 5; i += 1) {
    flood.ingest("proj-a", { source: "manual", kind: "note", title: `溢出 ${i}`, ref: `flood-${i}` });
  }
  ok(projects.getProjectEvent(evKeep.id) === undefined, "8. 源事件已被滚动淘汰");
  ok(projects.getMemory("proj-a", rKeep.targetId) !== undefined, "8b. 已提升目标不被误删");
  const keepLink = (db.connection
    .prepare(`SELECT COUNT(*) AS c FROM project_event_promotions WHERE project_id='proj-a' AND event_id=?`)
    .get(evKeep.id) as { c: number }).c;
  ok(keepLink === 1, "8c. 提升链接不随事件淘汰级联（目标侧追溯保留）");
  const keepMem = projects.getMemory("proj-a", rKeep.targetId)!;
  ok(keepMem.evidence.some((e) => e.evidenceKind === "event" && e.refId === evKeep.id), "8d. memory evidence 保留（refTitle 快照优雅降级）");
  // 事件淘汰后：同 ref 重新 ingest 会新建事件（保留窗口内幂等；窗口外允许重来）——先推进时钟越过洪峰时间戳
  clock += 10_000;
  const reIngest = ingestor.ingest("proj-a", { source: "cron", kind: "run", title: "保留目标的事件", ref: "keep-1" });
  ok(reIngest.id !== evKeep.id, "8e. 淘汰窗口外同 ref 可重新落库（新事件 id）");
  const rSurvive = promoter.promote(reIngest.id, { targetKind: "todo", todoTitle: "重启持久化 todo" });
  ok(!rSurvive.reused, "8f. 幸存事件可提升（淘汰后新事件不受旧链接约束）");

  /* ============ 9. ref 幂等 ingest（重复 callback 不堆事件） ============ */
  const dup = ingestor.ingest("proj-a", { source: "gateway", kind: "message", title: "重复消息", ref: "dup-1" });
  const dup2 = ingestor.ingest("proj-a", { source: "gateway", kind: "message", title: "重复消息", ref: "dup-1" });
  ok(dup.id === dup2.id, "9. 同 (project, source, ref) 重复 ingest 返回既有事件");
  const dupCount = (db.connection
    .prepare(`SELECT COUNT(*) AS c FROM project_events WHERE project_id='proj-a' AND source='gateway' AND ref='dup-1'`)
    .get() as { c: number }).c;
  ok(dupCount === 1, "9b. 不重复落库");
  // 不同项目同 ref 互不影响（A/B）
  const dupB = ingestor.ingest("proj-b", { source: "gateway", kind: "message", title: "重复消息", ref: "dup-1" });
  ok(dupB.id !== dup.id, "9c. 跨项目同 ref 独立");

  /* ============ 10. cron 适配器：纯翻译函数 ============ */
  const input = cronRunEventInput({ runId: "r1", jobName: "每日巡检", status: "success" });
  ok(input.source === "cron" && input.kind === "run" && input.ref === "r1", "10. cron 摘要翻译（source/kind/ref）");
  ok(input.title.includes("每日巡检") && input.title.includes("完成"), "10b. 标题含任务名与状态");
  ok(input.body === undefined, "10c. 成功无正文");
  const failInput = cronRunEventInput({ runId: "r2", jobName: "同步", status: "failed", error: "x".repeat(5000) });
  ok(failInput.body !== undefined && failInput.body.length <= 4000, "10d. 失败错误有界截断（≤4000，绝不无界写入）");
  ok(cronRunEventInput({ runId: "r3", jobName: "", status: "success" }).title.includes("定时任务"), "10e. 空任务名兜底");

  /* ============ 11. 扩展工具面：注册/作用域/readonly/归档 ============ */
  interface RegisteredTool {
    name: string;
    parameters: unknown;
    execute: (toolCallId: string, params: never) => Promise<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
      details?: unknown;
    }>;
  }
  const tools: RegisteredTool[] = [];
  const api = {
    registerTool: (tool: never) => {
      tools.push(tool as unknown as RegisteredTool);
    },
    on: () => undefined,
  } as unknown as ExtensionAPI;
  const bridge: ProjectEventExtensionBridge = {
    taskId: "task-a",
    resolveProjectId: () => "proj-a",
    service: projects,
    promoter,
    getPermissionMode: () => "default",
  };
  createProjectEventExtension(bridge)(api);
  const names = tools.map((t) => t.name).sort();
  ok(
    JSON.stringify(names) ===
      JSON.stringify([
        "project_event_dismiss",
        "project_event_import_file",
        "project_event_ingest_document",
        "project_event_list",
        "project_event_promote_to_library",
        "project_event_promote_to_memory",
        "project_event_promote_to_todo",
        "project_event_read",
        "project_event_reopen",
      ]),
    "11. 工具注册面 = list/read + ingest/import + triage×2 + 3 个窄 promote（无万能工具）",
  );
  const byName = (n: string): RegisteredTool => tools.find((t) => t.name === n)!;
  // 第 8 节洪峰已淘汰早期事件；本节一律用新事件，避免测试顺序耦合
  const ev11 = ingestor.ingest("proj-a", { source: "manual", kind: "note", title: "11 段用事件", ref: "s11-1" });

  // 未绑定任务 → 拒绝
  const unboundBridge: ProjectEventExtensionBridge = { ...bridge, resolveProjectId: () => null };
  const unboundTools: RegisteredTool[] = [];
  const unboundApi = { registerTool: (t: never) => unboundTools.push(t as unknown as RegisteredTool), on: () => undefined } as unknown as ExtensionAPI;
  createProjectEventExtension(unboundBridge)(unboundApi);
  const unboundList = unboundTools.find((t) => t.name === "project_event_list")!;
  const unboundRes = await unboundList.execute("c1", {} as never);
  ok(unboundRes.isError === true && (unboundRes.content[0]?.text ?? "").includes("未绑定"), "11b. 未绑定任务 → list 受控错误");
  const unboundPromote = unboundTools.find((t) => t.name === "project_event_promote_to_todo")!;
  const unboundPromoteRes = await unboundPromote.execute("c2", { eventId: ev11.id, title: "x" } as never);
  ok(unboundPromoteRes.isError === true, "11c. 未绑定任务 → promote 拒绝");

  // readonly → list 可读、promote 拒绝
  const roBridge: ProjectEventExtensionBridge = { ...bridge, getPermissionMode: () => "readonly" };
  const roTools: RegisteredTool[] = [];
  const roApi = { registerTool: (t: never) => roTools.push(t as unknown as RegisteredTool), on: () => undefined } as unknown as ExtensionAPI;
  createProjectEventExtension(roBridge)(roApi);
  const roList = roTools.find((t) => t.name === "project_event_list")!;
  const roListRes = await roList.execute("c3", {} as never);
  ok(roListRes.isError !== true, "11d. readonly 下 list 可读");
  const roPromote = roTools.find((t) => t.name === "project_event_promote_to_memory")!;
  const roPromoteRes = await roPromote.execute("c4", { eventId: ev11.id, kind: "fact", title: "x" } as never);
  ok(roPromoteRes.isError === true && (roPromoteRes.content[0]?.text ?? "").includes("只读"), "11e. readonly 下 promote 拒绝");

  // 跨项目 eventId（A 的 event 在 B 任务上下文）→ 拒绝
  const bBridge: ProjectEventExtensionBridge = { ...bridge, resolveProjectId: () => "proj-b" };
  const bTools: RegisteredTool[] = [];
  const bApi = { registerTool: (t: never) => bTools.push(t as unknown as RegisteredTool), on: () => undefined } as unknown as ExtensionAPI;
  createProjectEventExtension(bBridge)(bApi);
  const bRead = bTools.find((t) => t.name === "project_event_read")!;
  const bReadRes = await bRead.execute("c5", { eventId: ev11.id } as never);
  ok(bReadRes.isError === true && (bReadRes.content[0]?.text ?? "").includes("不属于当前任务"), "11f. A 事件 id 在 B 上下文读取被拒");
  const bPromote = bTools.find((t) => t.name === "project_event_promote_to_todo")!;
  const bPromoteRes = await bPromote.execute("c6", { eventId: ev11.id, title: "x" } as never);
  ok(bPromoteRes.isError === true, "11g. A 事件 id 在 B 上下文提升被拒");

  // Agent 提升（走扩展）→ promotedBy=agent + sourceTaskId
  const agentPromote = tools.find((t) => t.name === "project_event_promote_to_memory")!;
  const evAgent = ingestor.ingest("proj-a", { source: "manual", kind: "note", title: "Agent 将提升此事件", ref: "agent-1" });
  const agentRes = await agentPromote.execute("c7", { eventId: evAgent.id, kind: "decision", title: "Agent 决策记录", content: "内容" } as never);
  ok(agentRes.isError !== true, "11h. Agent 提升成功");
  const agentMem = projects.listMemory("proj-a").find((m) => m.title === "Agent 决策记录")!;
  ok(agentMem.sourceType === "agent" && agentMem.sourceTaskId === "task-a", "11i. 来源自动注入（agent + taskId，不可伪造）");
  const agentLink = (db.connection
    .prepare(`SELECT promoted_by FROM project_event_promotions WHERE project_id='proj-a' AND event_id=? AND target_kind='memory'`)
    .get(evAgent.id) as { promoted_by: string }).promoted_by;
  ok(agentLink === "agent", "11j. 提升主体记录 agent");

  /* ============ 12. 重启持久化（关闭重开，事件/链接/目标全在） ============ */
  db.close();
  const db2 = new AppDatabase(dbPath);
  const projects2 = new ProjectService(new ProjectRepository(db2.connection), new MemoryService(db2, { semantic: false }));
  const library2 = new LibraryService(db2);
  const evAfter = projects2.getProjectEvent(reIngest.id);
  ok(evAfter !== undefined && evAfter.promotions === undefined, "12. 重启后事件仍在（get 单条不含链接）");
  const listAfter = projects2.listProjectEvents("proj-a");
  const evWithPromo = listAfter.find((e) => e.id === reIngest.id);
  ok(evWithPromo?.promotions?.length === 1 && evWithPromo.promotions[0]!.targetId === rSurvive.targetId, "12b. 重启后提升链接仍在（list 带链接）");
  ok(projects2.getMemory("proj-a", r1.targetId) !== undefined, "12c. 重启后目标真源仍在");
  ok(library2.getItem(r3.targetId) !== undefined, "12d. 重启后资料条目仍在");
  const promoter2 = new ProjectEventPromoter(projects2, library2, { now: () => clock });
  const rAgain = promoter2.promote(reIngest.id, { targetKind: "todo", todoTitle: "再点一次" });
  ok(rAgain.reused && rAgain.targetId === rSurvive.targetId, "12e. 重启后幂等仍成立");

  /* ============ 13. CronService 集成：project-bound run → 事件；unbound 不污染 ============ */
  // 注意：upsert 会 arm 真实定时器（scheduleType=at，约 1 小时后触发）。任何断言失败/异常都必须
  // 经 finally 停止定时器，否则 setTimeout 撑住事件循环 → 进程永不退出（历史 hang 根因）。
  let cron: CronService | undefined;
  let cronFail: CronService | undefined;
  const cronDb = new AppDatabase(join(root, "cron.db"));
  try {
    const runEvents: Array<{ projectId: string; summary: { runId: string; jobName: string; status: "success" | "failed"; error?: string } }> = [];
    const cronPrompts: Array<{ expertId?: string }> = [];
    const fakeAgent = {
      prompt: async (req: { expertId?: string }): Promise<void> => { cronPrompts.push(req); },
      loadTaskHistory: async (): Promise<{ messages: Array<{ role: string; text: string }> }> => ({
        messages: [{ role: "assistant", text: "巡检完成" }],
      }),
      listSkills: (): unknown[] => [],
      listConnectors: (): unknown[] => [],
      getAppSettings: (): { defaultModelId?: string } => ({}),
    } as never;
    cron = new CronService(cronDb, fakeAgent, (projectId, summary) => runEvents.push({ projectId, summary }));

    // Expert Team removal contract: new Cron writes reject team:*; legacy persisted rows degrade to no expert.
    let teamCronError = "";
    try {
      cron.upsert({
        id: "job-team-rejected", name: "旧专家团任务", prompt: "do", scheduleType: "at",
        scheduleExpr: new Date(Date.now() + 3600_000).toISOString(), timezone: "Asia/Shanghai", enabled: false,
        expertId: "team:legacy-review-team", createdAt: 1, updatedAt: 1,
      });
    } catch (error) {
      teamCronError = error instanceof Error ? error.message : String(error);
    }
    ok(teamCronError.includes("Expert teams are no longer supported"), "13a0. 新 Cron 写入 team:* 明确拒绝");

    cronDb.upsertCronJob({
      id: "job-team-legacy", name: "旧专家团遗留", prompt: "do", scheduleType: "at",
      scheduleExpr: new Date(Date.now() + 3600_000).toISOString(), timezone: "Asia/Shanghai", enabled: false,
      expertId: "team:legacy-review-team", createdAt: 1, updatedAt: 1,
    });
    ok(cron.list().find((job) => job.id === "job-team-legacy")?.expertId === undefined, "13a1. 旧 Cron team:* 列表投影降级为无专家");
    await cron.runNow("job-team-legacy");
    await waitFor(() => cronDb.listCronRuns(50).some((r) => r.jobId === "job-team-legacy"), 3000);
    const legacyRun = cronDb.listCronRuns(50).find((r) => r.jobId === "job-team-legacy");
    await waitFor(() => Boolean(legacyRun?.taskId && cronDb.getTask(legacyRun.taskId)?.status !== "in_progress"), 3000);
    ok(cronPrompts.some((req) => req.expertId === undefined), "13a2. 旧 Cron team:* 执行时不传入 Agent");
    ok(Boolean(legacyRun?.taskId) && cronDb.getTask(legacyRun!.taskId!)?.expertId === undefined, "13a3. 旧 Cron team:* 不污染新建 Task expertId");
    // proj-cron 需同时存在于 cronDb（upsertTask 校验项目存在）与主测试库（13d 的 ingest 走 projects2）
    cronDb.connection
      .prepare(`INSERT OR IGNORE INTO projects (id, name, created_at, updated_at) VALUES ('proj-cron', 'Cron项目', 1, 1)`)
      .run();
    db2.connection
      .prepare(`INSERT OR IGNORE INTO projects (id, name, created_at, updated_at) VALUES ('proj-cron', 'Cron项目', 1, 1)`)
      .run();
    const jobBound = cron.upsert({
      id: "job-bound",
      name: "每日巡检",
      prompt: "do",
      scheduleType: "at",
      scheduleExpr: new Date(Date.now() + 3600_000).toISOString(),
      timezone: "Asia/Shanghai",
      enabled: true,
      projectId: "proj-cron",
      createdAt: 1,
      updatedAt: 1,
    });
    const jobUnbound = cron.upsert({
      id: "job-unbound",
      name: "全局任务",
      prompt: "do",
      scheduleType: "at",
      scheduleExpr: new Date(Date.now() + 3600_000).toISOString(),
      timezone: "Asia/Shanghai",
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
    });
    await cron.runNow(jobBound.id);
    await waitFor(() => runEvents.length > 0, 3000);
    ok(runEvents.some((e) => e.projectId === "proj-cron" && e.summary.status === "success"), "13. project-bound run 成功 → 摘要事件");
    await cron.runNow(jobUnbound.id);
    await waitFor(() => cronDb.listCronRuns(50).some((r) => r.jobId === "job-unbound"), 3000);
    ok(runEvents.every((e) => e.projectId === "proj-cron"), "13b. unbound cron 不产生项目事件（不污染）");
    // 失败路径：prompt 抛错 → failed 事件
    const failAgent = {
      ...fakeAgent,
      prompt: async (): Promise<void> => {
        throw new Error("网络超时");
      },
    } as never;
    const failEvents: Array<{ projectId: string; summary: { status: string; error?: string } }> = [];
    cronFail = new CronService(cronDb, failAgent, (projectId, summary) => failEvents.push({ projectId, summary }));
    const jobFail = cronFail.upsert({
      id: "job-fail",
      name: "同步",
      prompt: "do",
      scheduleType: "at",
      scheduleExpr: new Date(Date.now() + 3600_000).toISOString(),
      timezone: "Asia/Shanghai",
      enabled: true,
      projectId: "proj-cron",
      createdAt: 1,
      updatedAt: 1,
    });
    await cronFail.runNow(jobFail.id);
    await waitFor(() => failEvents.length >= 1, 3000);
    ok(failEvents[0]?.summary.status === "failed" && failEvents[0]?.summary.error === "网络超时", "13c. run 失败 → failed 摘要（含错误）");
    // Project lifecycle gate：归档会停用且任何入口都不能重启；恢复后需人工启用。
    cronDb.connection.prepare("UPDATE projects SET archived=1 WHERE id='proj-cron'").run();
    cron.disableProject("proj-cron");
    ok(cronDb.getCronJob(jobBound.id)?.enabled === false, "13c1. 项目归档停用所属自动化");
    let archivedRunError = "";
    try { await cron.runNow(jobBound.id); } catch (error) {
      archivedRunError = error instanceof Error ? error.message : String(error);
    }
    ok(archivedRunError.includes("归档"), "13c2. 归档项目不能手动运行自动化");
    let archivedEnableError = "";
    try { cron.setEnabled(jobBound.id, true); } catch (error) {
      archivedEnableError = error instanceof Error ? error.message : String(error);
    }
    ok(archivedEnableError.includes("归档"), "13c3. 归档项目不能重新启用自动化");
    cronDb.connection.prepare("UPDATE projects SET archived=0 WHERE id='proj-cron'").run();
    ok(cronDb.getCronJob(jobBound.id)?.enabled === false, "13c4. 恢复项目不偷偷重启自动化");
    cron.setEnabled(jobBound.id, true);
    ok(cronDb.getCronJob(jobBound.id)?.enabled === true, "13c5. 恢复后可人工重新启用");
    cron.removeProject("proj-cron");
    ok(cronDb.getCronJob(jobBound.id) === undefined && cronDb.getCronJob(jobFail.id) === undefined, "13c6. 删除项目清理所属自动化");
    // cron 事件经同一 ingestor 落库（第二真实 source adapter 端到端）
    const cronIngestor = new ProjectEventIngestor(projects2, { now: () => clock });
    for (const e of runEvents.filter((x) => x.projectId === "proj-cron")) {
      cronIngestor.ingest(e.projectId, cronRunEventInput(e.summary));
    }
    ok(cronIngestor.list("proj-cron").length >= 1 && cronIngestor.list("proj-cron")[0]!.source === "cron", "13d. cron 摘要落库为项目事件");
  } finally {
    cron?.stop();
    cronFail?.stop();
    cronDb.close();
  }
  db2.close();
  rmSync(root, { recursive: true, force: true });
  if (failed > 0) {
    console.error(`project-event-promotion-test: FAILED (${passed} passed, ${failed} failed)`);
    process.exitCode = 1;
  } else {
    console.log(`project-event-promotion-test: PASS (${passed})`);
  }
}

function waitFor(cond: () => boolean, timeoutMs: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = (): void => {
      if (cond()) return resolve();
      if (Date.now() - started > timeoutMs) return reject(new Error("waitFor 超时"));
      setTimeout(tick, 25);
    };
    tick();
  });
}

void main().catch((err) => {
  console.error("project-event-promotion-test: FAILED", err);
  process.exitCode = 1;
});
