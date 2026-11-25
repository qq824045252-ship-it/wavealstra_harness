/**
 * Project Event Triage（disposition）可运营化集成测试：
 * open/dismissed 状态 → dismiss/reopen 幂等 → 项目作用域 → 列表 triage 筛选（open/handled）→
 * 有效状态推导（dismissed 或已提升 = handled）→ readonly/archived 门禁 → 工具面 →
 * ★ 派生隔离（dismiss 前后 snapshot/attention 深度相等，triage 绝不进入真源）→
 * 保留淘汰/重启持久化。真实 SQLite + 注入时钟；必须经 scripts/test-guard.mjs 执行。
 */
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { MemoryService } from "../src/main/memory/MemoryService";
import { ProjectRepository } from "../src/main/project/ProjectRepository";
import { ProjectService } from "../src/main/project/ProjectService";
import { ProjectEventIngestor } from "../src/main/project/ProjectEventIngestor";
import { ProjectEventPromoter } from "../src/main/project/ProjectEventPromoter";
import { ProjectAttentionTracker } from "../src/main/project/ProjectAttention";
import { createProjectEventExtension } from "../src/main/project/project-event-extension";
import { LibraryService } from "../src/main/library/LibraryService";
import { locateRuntimeAudit } from "../src/main/platform/runtime-audit";
import { PROJECT_EVENT_RETENTION_PER_PROJECT } from "../src/shared/project-domain";
import type { ProjectEventTriageStatus } from "../src/shared/project-domain";
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
const root = mkdtempSync(join(tmpdir(), "mybuddy-triage-"));
// 隔离 HOME：LibraryService 把资料库文件写到 ~/.mybuddy/library（POSIX 的 os.homedir() 读 HOME），
// 只把 SQLite 放进临时目录而不同时隔离 HOME，会把夹具文档写进真实用户资料库。
process.env.HOME = root;
process.env.USERPROFILE = root;
const dbPath = join(root, "app.db");
const native = process.argv.includes("--native");
const runtimeAuditExecutable = native ? locateRuntimeAudit(process.cwd()) : undefined;
if (native) assert(runtimeAuditExecutable && existsSync(runtimeAuditExecutable), "Rust worker executable is required");
const db = new AppDatabase(dbPath, { runtimeAuditExecutable });
const projects = new ProjectService(new ProjectRepository(db.connection, db.runtimeAuditReader), new MemoryService(db, { semantic: false }));
const library = new LibraryService(db, { libraryRoot: join(root, "lib") });
const NOW = 1_800_000_000_000;
let clock = NOW;
const ingestor = new ProjectEventIngestor(projects, { now: () => ++clock });
const promoter = new ProjectEventPromoter(projects, library, { now: () => clock });

db.connection
  .prepare(`INSERT INTO projects (id, name, created_at, updated_at) VALUES ('proj-a', 'A项目', 1, 1), ('proj-b', 'B项目', 1, 1)`)
  .run();

let seq = 0;
function eventA() {
  return ingestor.ingest("proj-a", { source: "gateway", kind: "message", title: `消息 A${seq}`, body: "正文", ref: `t-a-${seq++}` });
}
function eventB(): { id: string } {
  return ingestor.ingest("proj-b", { source: "gateway", kind: "message", title: `消息 B${seq}`, ref: `t-b-${seq++}` });
}

async function triage(projectId: string, eventId: string, status: ProjectEventTriageStatus) {
  if (native) db.connection.pragma("query_only = ON");
  try { return await projects.writeProjectEventTriage(projectId, eventId, status); }
  finally { if (native) db.connection.pragma("query_only = OFF"); }
}

async function main(): Promise<void> {
  /* ============ 1. 默认 open；dismiss → dismissed；reopen → open ============ */
  const ev = eventA();
  ok(ev.triageStatus === "open", "1. 新事件默认 triage=open");
  const dismissed = await triage("proj-a", ev.id, "dismissed");
  ok(dismissed.triageStatus === "dismissed", "1b. dismiss 后 triage=dismissed");
  if (native) db.connection.exec("CREATE TEMP TABLE project_events AS SELECT * FROM main.project_events WHERE 0");
  try {
    assert.deepEqual(await projects.readProjectEvent(ev.id), {
      id: ev.id,
      projectId: "proj-a",
      source: "gateway",
      kind: "message",
      title: "消息 A0",
      body: "正文",
      ref: "t-a-0",
      payload: {},
      triageStatus: "dismissed",
      createdAt: NOW + 1,
    });
    assert.deepEqual(await projects.readProjectEvents("proj-a", 1), [dismissed]);
  } finally {
    if (native) db.connection.exec("DROP TABLE temp.project_events");
  }
  console.log("  ✓ 1c. 持久化（读取事件详情与活动流）");
  const reopened = await triage("proj-a", ev.id, "open");
  ok(reopened.triageStatus === "open", "1d. reopen 恢复 open");

  /* ============ 2. 幂等 ============ */
  await triage("proj-a", ev.id, "dismissed");
  const again = await triage("proj-a", ev.id, "dismissed");
  ok(again.triageStatus === "dismissed", "2. 重复 dismiss 幂等");
  await triage("proj-a", ev.id, "open");
  ok((await triage("proj-a", ev.id, "open")).triageStatus === "open", "2b. 重复 reopen 幂等");

  /* ============ 3. 项目作用域：跨项目/不存在拒绝 ============ */
  await assert.rejects(triage("proj-b", ev.id, "dismissed"), /事件不存在或不属于该项目/);
  await assert.rejects(triage("proj-b", ev.id, "open"), /事件不存在或不属于该项目/);
  await assert.rejects(triage("proj-a", "pevt_no_such", "dismissed"), /事件不存在或不属于该项目/);
  await assert.rejects(triage("absent-project", ev.id, "dismissed"), /项目不存在：absent-project/);

  /* ============ 4. ★ 派生隔离：dismiss 前后 snapshot/attention 深度相等 ============ */
  const evIsolation = eventA();
  const tracker = new ProjectAttentionTracker(projects);
  const snapshotBefore = JSON.stringify(projects.buildStatusSnapshot("proj-a", NOW + 3 * 24 * 3600 * 1000));
  const attentionBefore = JSON.stringify(tracker.getAttention("proj-a", NOW + 3 * 24 * 3600 * 1000));
  await triage("proj-a", evIsolation.id, "dismissed");
  await triage("proj-a", ev.id, "dismissed");
  const snapshotAfter = JSON.stringify(projects.buildStatusSnapshot("proj-a", NOW + 3 * 24 * 3600 * 1000));
  const attentionAfter = JSON.stringify(tracker.getAttention("proj-a", NOW + 3 * 24 * 3600 * 1000));
  ok(snapshotBefore === snapshotAfter, "4. dismiss 前后 StatusSnapshot 深度相等（triage 不参与派生）");
  ok(attentionBefore === attentionAfter, "4b. dismiss 前后 Attention 深度相等（triage 不参与派生）");
  projects.reopenProjectEvent("proj-a", evIsolation.id);
  projects.reopenProjectEvent("proj-a", ev.id);

  /* ============ 5. 有效状态推导 + 列表筛选 ============ */
  const evPromoted = eventA();
  promoter.promote(evPromoted.id, { targetKind: "todo", todoTitle: "提升的计划" });
  const evDismissed = eventA();
  projects.dismissProjectEvent("proj-a", evDismissed.id);
  const evOpen = eventA();
  const list = projects.listProjectEvents("proj-a");
  const byId = (id: string): { triageStatus: string; promotions?: unknown[] } => list.find((e) => e.id === id)!;
  ok(byId(evPromoted.id).triageStatus === "open" && (byId(evPromoted.id).promotions?.length ?? 0) === 1, "5. 已提升事件 triage 仍 open（有效状态由消费方推导）");
  ok(byId(evDismissed.id).triageStatus === "dismissed", "5b. dismissed 状态入列表 DTO");

  // 工具面 triage 筛选
  interface RegisteredTool {
    name: string;
    execute: (toolCallId: string, params: never) => Promise<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
      details?: unknown;
    }>;
  }
  const tools: RegisteredTool[] = [];
  const api = { registerTool: (t: never) => tools.push(t as unknown as RegisteredTool), on: () => undefined } as unknown as ExtensionAPI;
  const bridge: ProjectEventExtensionBridge = {
    taskId: "task-triage",
    resolveProjectId: () => "proj-a",
    service: projects,
    promoter,
    ingestor,
    getPermissionMode: () => "default",
  };
  createProjectEventExtension(bridge)(api);
  const listTool = tools.find((t) => t.name === "project_event_list")!;
  const listOpen = await listTool.execute("c1", { triage: "open" } as never);
  const openIds = ((listOpen.details as { events?: Array<{ id: string }> })?.events ?? []).map((e) => e.id);
  ok(openIds.includes(evOpen.id) && !openIds.includes(evDismissed.id) && !openIds.includes(evPromoted.id), "5c. triage=open 排除 dismissed 与已提升");
  const listHandled = await listTool.execute("c2", { triage: "handled" } as never);
  const handledIds = ((listHandled.details as { events?: Array<{ id: string }> })?.events ?? []).map((e) => e.id);
  ok(handledIds.includes(evDismissed.id) && handledIds.includes(evPromoted.id) && !handledIds.includes(evOpen.id), "5d. triage=handled 含 dismissed 与已提升");

  /* ============ 6. 工具门禁：unbound/readonly/归档 ============ */
  const dismissTool = tools.find((t) => t.name === "project_event_dismiss")!;
  const reopenTool = tools.find((t) => t.name === "project_event_reopen")!;
  ok(!!dismissTool && !!reopenTool, "6. 注册 project_event_dismiss / project_event_reopen");

  const unboundBridge: ProjectEventExtensionBridge = { ...bridge, resolveProjectId: () => null };
  const unboundTools: RegisteredTool[] = [];
  const unboundApi = { registerTool: (t: never) => unboundTools.push(t as unknown as RegisteredTool), on: () => undefined } as unknown as ExtensionAPI;
  createProjectEventExtension(unboundBridge)(unboundApi);
  const unboundDismiss = unboundTools.find((t) => t.name === "project_event_dismiss")!;
  const unboundRes = await unboundDismiss.execute("c3", { eventId: ev.id } as never);
  ok(unboundRes.isError === true && (unboundRes.content[0]?.text ?? "").includes("未绑定"), "6b. 未绑定任务 → 拒绝");

  const roBridge: ProjectEventExtensionBridge = { ...bridge, getPermissionMode: () => "readonly" };
  const roTools: RegisteredTool[] = [];
  const roApi = { registerTool: (t: never) => roTools.push(t as unknown as RegisteredTool), on: () => undefined } as unknown as ExtensionAPI;
  createProjectEventExtension(roBridge)(roApi);
  const roDismiss = roTools.find((t) => t.name === "project_event_dismiss")!;
  const roRes = await roDismiss.execute("c4", { eventId: ev.id } as never);
  ok(roRes.isError !== true, "6c. legacy readonly no longer blocks the requested operation");

  // 归档项目：已有事件仍可读，但 triage 也是持久化写入，必须拒绝。
  const evArch = eventB();
  db.connection.prepare(`UPDATE projects SET archived=1 WHERE id='proj-b'`).run();
  await assert.rejects(triage("proj-b", evArch.id, "dismissed"), /归档/);
  assert.equal((await projects.readProjectEvent(evArch.id))?.triageStatus, "open");
  const archBridge: ProjectEventExtensionBridge = { ...bridge, resolveProjectId: () => "proj-b" };
  const archTools: RegisteredTool[] = [];
  const archApi = { registerTool: (t: never) => archTools.push(t as unknown as RegisteredTool), on: () => undefined } as unknown as ExtensionAPI;
  createProjectEventExtension(archBridge)(archApi);
  const archDismiss = archTools.find((t) => t.name === "project_event_dismiss")!;
  const archRes = await archDismiss.execute("c5", { eventId: evArch.id } as never);
  ok(archRes.isError === true && projects.getProjectEvent(evArch.id)!.triageStatus === "open", "6d. 归档项目拒绝 dismiss，已有事件保持可读");
  db.connection.prepare(`UPDATE projects SET archived=0 WHERE id='proj-b'`).run();

  // 跨项目 eventId（A 的事件在 B 上下文）→ 拒绝
  const bBridge: ProjectEventExtensionBridge = { ...bridge, resolveProjectId: () => "proj-b" };
  const bTools: RegisteredTool[] = [];
  const bApi = { registerTool: (t: never) => bTools.push(t as unknown as RegisteredTool), on: () => undefined } as unknown as ExtensionAPI;
  createProjectEventExtension(bBridge)(bApi);
  const bDismiss = bTools.find((t) => t.name === "project_event_dismiss")!;
  const bRes = await bDismiss.execute("c6", { eventId: ev.id } as never);
  ok(bRes.isError === true && (bRes.content[0]?.text ?? "").includes("不属于当前任务"), "6e. A 事件 id 在 B 上下文 dismiss 被拒");

  /* ============ 7. 工具正常路径 + 幂等 ============ */
  const evTool = eventA();
  const okRes = await dismissTool.execute("c7", { eventId: evTool.id } as never);
  ok(okRes.isError !== true && (okRes.details as { event?: { triageStatus?: string } })?.event?.triageStatus === "dismissed", "7. dismiss 成功");
  const okRes2 = await dismissTool.execute("c8", { eventId: evTool.id } as never);
  ok(okRes2.isError !== true, "7b. 重复 dismiss 幂等");
  const reopenRes = await reopenTool.execute("c9", { eventId: evTool.id } as never);
  ok(reopenRes.isError !== true && (reopenRes.details as { event?: { triageStatus?: string } })?.event?.triageStatus === "open", "7c. reopen 成功");

  /* ============ 8. 保留淘汰 + 重启持久化 ============ */
  const evKeep = eventA();
  projects.dismissProjectEvent("proj-a", evKeep.id);
  let capClock = clock;
  const flood = new ProjectEventIngestor(projects, { now: () => ++capClock });
  for (let i = 0; i < PROJECT_EVENT_RETENTION_PER_PROJECT + 5; i += 1) {
    flood.ingest("proj-a", { source: "manual", kind: "note", title: `洪峰 ${i}`, ref: `flood-tr-${i}` });
  }
  ok(projects.getProjectEvent(evKeep.id) === undefined, "8. dismissed 事件随保留正常淘汰");
  clock = capClock + 10_000;

  // 洪峰之后的新事件（dismissed 与 open 各一）验证重启持久化
  const evPersistDismissed = eventA();
  await triage("proj-a", evPersistDismissed.id, "dismissed");
  const evPersistOpen = eventA();
  await db.runtimeAuditReader?.close();
  db.close();
  const db2 = new AppDatabase(dbPath);
  const projects2 = new ProjectService(new ProjectRepository(db2.connection), new MemoryService(db2, { semantic: false }));
  const after = projects2.getProjectEvent(evPersistDismissed.id);
  ok(after?.triageStatus === "dismissed", "8b. 重启后 dismissed 状态持久");
  const afterOpen = projects2.getProjectEvent(evPersistOpen.id);
  ok(afterOpen?.triageStatus === "open", "8c. 重启后 open 状态持久");
  db2.close();
  rmSync(root, { recursive: true, force: true });

  if (failed > 0) {
    console.error(`project-event-triage-test: FAILED (${passed} passed, ${failed} failed)`);
    process.exitCode = 1;
  } else {
    console.log(`project-event-triage-test: PASS (${passed})`);
  }
}

void main().catch(async (err) => {
  console.error("project-event-triage-test: FAILED", err);
  process.exitCode = 1;
  await db.runtimeAuditReader?.close();
  if (db.connection.open) db.close();
});
