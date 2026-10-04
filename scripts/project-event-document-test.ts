/**
 * Project Event Document Adapter 集成测试（source=document 输入适配器）：
 * ingestDocument 基础契约 → 内容哈希 ref 幂等 → 显式 ref → A/B 隔离 → 有界校验（拒绝非截断）→
 * archived 只读语义 → document 事件可 promotion（双向溯源）→ 保留淘汰后目标仍在 →
 * Agent 工具面（project_event_ingest_document：未绑定/readonly/archived/幂等）→ 重启持久化。
 * 真实 SQLite + 注入时钟；必须经 scripts/test-guard.mjs 执行。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { MemoryService } from "../src/main/memory/MemoryService";
import { ProjectRepository } from "../src/main/project/ProjectRepository";
import { ProjectService } from "../src/main/project/ProjectService";
import { ProjectEventIngestor } from "../src/main/project/ProjectEventIngestor";
import { ProjectEventPromoter } from "../src/main/project/ProjectEventPromoter";
import { createProjectEventExtension } from "../src/main/project/project-event-extension";
import { LibraryService } from "../src/main/library/LibraryService";
import {
  PROJECT_EVENT_RETENTION_PER_PROJECT,
} from "../src/shared/project-domain";
import {
  PROJECT_EVENT_BODY_MAX_CHARS,
  PROJECT_EVENT_REF_MAX_CHARS,
  PROJECT_EVENT_TITLE_MAX_CHARS,
} from "../src/main/project/ProjectEventIngestor";
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

const root = mkdtempSync(join(tmpdir(), "mybuddy-doc-"));
const dbPath = join(root, "app.db");
const db = new AppDatabase(dbPath);
const projects = new ProjectService(new ProjectRepository(db.connection), new MemoryService(db, { semantic: false }));
const library = new LibraryService(db);
const NOW = 1_800_000_000_000;
let clock = NOW;
const ingestor = new ProjectEventIngestor(projects, { now: () => ++clock });
const promoter = new ProjectEventPromoter(projects, library, { now: () => clock });

db.connection
  .prepare(`INSERT INTO projects (id, name, created_at, updated_at) VALUES ('proj-a', 'A项目', 1, 1), ('proj-b', 'B项目', 1, 1)`)
  .run();

const MINUTES = "例会纪要：确认 Q3 交付范围与验收标准；风险：上游数据源可能延期一周。";
const MINUTES_TITLE = "Q3 例会纪要 2026-08-15";

async function main(): Promise<void> {
  /* ============ 1. ingestDocument 基础契约 ============ */
  const ev = ingestor.ingestDocument("proj-a", { title: MINUTES_TITLE, body: MINUTES });
  ok(ev.source === "document" && ev.kind === "note", "1. source=document / kind=note");
  ok(ev.title === MINUTES_TITLE && ev.body === MINUTES, "1b. title/body 原样落库");
  ok(/^[0-9a-f]{64}$/.test(ev.ref ?? ""), "1c. ref 缺省 = sha256 内容哈希（64 hex）");
  const inList = ingestor.list("proj-a").find((e) => e.id === ev.id);
  ok(inList !== undefined && inList.source === "document", "1d. 列表可见（source=document）");

  /* ============ 2. 同文幂等（内容哈希去重，不堆事件） ============ */
  const ev2 = ingestor.ingestDocument("proj-a", { title: MINUTES_TITLE, body: MINUTES });
  ok(ev2.id === ev.id, "2. 同标题+同正文重复导入 → 返回既有事件");
  const countA = (db.connection
    .prepare(`SELECT COUNT(*) AS c FROM project_events WHERE project_id='proj-a' AND source='document'`)
    .get() as { c: number }).c;
  ok(countA === 1, "2b. 不重复落库");

  /* ============ 3. 显式 ref：以调用方为准；同 ref 去重 ============ */
  const evR1 = ingestor.ingestDocument("proj-a", { title: "外部纪要 A", body: "内容一", ref: "ext-meeting-001" });
  ok(evR1.ref === "ext-meeting-001", "3. 显式 ref 原样使用");
  const evR2 = ingestor.ingestDocument("proj-a", { title: "外部纪要 A", body: "内容二（不同正文）", ref: "ext-meeting-001" });
  ok(evR2.id === evR1.id, "3b. 同 ref 不同内容 → 按 ref 去重返回既有");

  /* ============ 4. A/B 隔离：同内容不同项目互不影响 ============ */
  const evB = ingestor.ingestDocument("proj-b", { title: MINUTES_TITLE, body: MINUTES });
  ok(evB.id !== ev.id, "4. 同文档在 B 项目 = 独立事件");
  const countB = (db.connection
    .prepare(`SELECT COUNT(*) AS c FROM project_events WHERE project_id='proj-b' AND source='document'`)
    .get() as { c: number }).c;
  ok(countB === 1, "4b. B 项目仅 1 条");

  /* ============ 5. 有界校验：拒绝而非截断 ============ */
  throws(() => ingestor.ingestDocument("proj-a", { title: "  ", body: "x" }), "5. 空标题拒绝");
  throws(() => ingestor.ingestDocument("proj-a", { title: "x", body: "  " }), "5b. 空正文拒绝");
  throws(() => ingestor.ingestDocument("proj-a", { title: "x".repeat(PROJECT_EVENT_TITLE_MAX_CHARS + 1), body: "x" }), "5c. 超长标题拒绝");
  throws(
    () => ingestor.ingestDocument("proj-a", { title: "x", body: "x".repeat(PROJECT_EVENT_BODY_MAX_CHARS + 1) }),
    "5d. 超长正文拒绝（4000 上限，绝不截断）",
  );
  throws(
    () => ingestor.ingestDocument("proj-a", { title: "x", body: "x", ref: "r".repeat(PROJECT_EVENT_REF_MAX_CHARS + 1) }),
    "5e. 超长 ref 拒绝",
  );
  // 自身插入保护：即使注入时钟回拨（created_at 比既有事件都旧），新事件不被自己的剪枝删除
  const backdated = new ProjectEventIngestor(projects, { now: () => 1_000_000_000 });
  const evBack = backdated.ingest("proj-a", { source: "manual", kind: "note", title: "回拨事件", ref: "back-1" });
  ok(projects.getProjectEvent(evBack.id) !== undefined, "5f. 时间戳回拨的插入不被自身剪枝立即删除");

  /* ============ 6. archived 项目：服务层只读 ============ */
  db.connection.prepare(`UPDATE projects SET archived=1 WHERE id='proj-b'`).run();
  throws(() => ingestor.ingestDocument("proj-b", { title: "归档期纪要", body: "不应写入" }), "6. 归档项目拒绝 ingest");
  db.connection.prepare(`UPDATE projects SET archived=0 WHERE id='proj-b'`).run();

  /* ============ 7. document 事件可 promotion（走既有提升链路 + 双向溯源） ============ */
  const rPromo = promoter.promote(ev.id, {
    targetKind: "memory",
    memoryKind: "decision",
    memoryTitle: "Q3 交付范围确认",
    memoryContent: MINUTES,
  });
  ok(!rPromo.reused && rPromo.promotion.eventId === ev.id, "7. document 事件提升为记忆成功");
  const mem = projects.getMemory("proj-a", rPromo.targetId);
  ok(mem !== undefined && mem.evidence.some((e) => e.evidenceKind === "event" && e.refId === ev.id), "7b. 目标侧溯源 evidence kind=event");
  const evWithPromo = ingestor.list("proj-a").find((e) => e.id === ev.id);
  ok(evWithPromo?.promotions?.length === 1 && evWithPromo.promotions[0]!.targetId === rPromo.targetId, "7c. 事件侧溯源链接");

  /* ============ 8. 保留淘汰：源事件消失，目标/链接仍在 ============ */
  const evKeep = ingestor.ingestDocument("proj-a", { title: "保留目标纪要", body: "将被洪峰淘汰" });
  const rKeep = promoter.promote(evKeep.id, { targetKind: "todo", todoTitle: "跟进纪要事项" });
  let capClock = clock;
  const flood = new ProjectEventIngestor(projects, { now: () => ++capClock });
  for (let i = 0; i < PROJECT_EVENT_RETENTION_PER_PROJECT + 5; i += 1) {
    flood.ingest("proj-a", { source: "manual", kind: "note", title: `洪峰 ${i}`, ref: `flood-doc-${i}` });
  }
  ok(projects.getProjectEvent(evKeep.id) === undefined, "8. 源事件被滚动淘汰");
  ok(projects.getTodo(rKeep.targetId) !== undefined, "8b. 已提升目标不被误删");
  const keepLink = (db.connection
    .prepare(`SELECT COUNT(*) AS c FROM project_event_promotions WHERE project_id='proj-a' AND event_id=?`)
    .get(evKeep.id) as { c: number }).c;
  ok(keepLink === 1, "8c. 提升链接保留（无 event FK，不级联）");
  // 主时钟越过洪峰时间戳：后续事件必须比洪峰事件新，否则会被自身插入时的保留剪枝立即淘汰
  clock = capClock + 10_000;

  /* ============ 9. Agent 工具面：project_event_ingest_document ============ */
  interface RegisteredTool {
    name: string;
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
    taskId: "task-doc",
    resolveProjectId: () => "proj-a",
    service: projects,
    promoter,
    ingestor,
    getPermissionMode: () => "default",
  };
  createProjectEventExtension(bridge)(api);
  ok(tools.some((t) => t.name === "project_event_ingest_document"), "9. 注册 project_event_ingest_document");
  const ingestTool = tools.find((t) => t.name === "project_event_ingest_document")!;

  // 未绑定任务 → 拒绝
  const unboundBridge: ProjectEventExtensionBridge = { ...bridge, resolveProjectId: () => null };
  const unboundTools: RegisteredTool[] = [];
  const unboundApi = { registerTool: (t: never) => unboundTools.push(t as unknown as RegisteredTool), on: () => undefined } as unknown as ExtensionAPI;
  createProjectEventExtension(unboundBridge)(unboundApi);
  const unboundTool = unboundTools.find((t) => t.name === "project_event_ingest_document")!;
  const unboundRes = await unboundTool.execute("c1", { title: "x", body: "y" } as never);
  ok(unboundRes.isError === true && (unboundRes.content[0]?.text ?? "").includes("未绑定"), "9b. 未绑定任务 → 受控错误");

  // readonly → 拒绝（审计层写入也是写）
  const roBridge: ProjectEventExtensionBridge = { ...bridge, getPermissionMode: () => "readonly" };
  const roTools: RegisteredTool[] = [];
  const roApi = { registerTool: (t: never) => roTools.push(t as unknown as RegisteredTool), on: () => undefined } as unknown as ExtensionAPI;
  createProjectEventExtension(roBridge)(roApi);
  const roTool = roTools.find((t) => t.name === "project_event_ingest_document")!;
  const roRes = await roTool.execute("c2", { title: "x", body: "y" } as never);
  ok(roRes.isError === true && (roRes.content[0]?.text ?? "").includes("只读"), "9c. readonly → 拒绝");

  // archived → 拒绝（服务层只读）
  db.connection.prepare(`UPDATE projects SET archived=1 WHERE id='proj-a'`).run();
  const archRes = await ingestTool.execute("c3", { title: "归档期文档", body: "不应写入" } as never);
  ok(archRes.isError === true, "9d. archived 项目 → 拒绝记录");
  db.connection.prepare(`UPDATE projects SET archived=0 WHERE id='proj-a'`).run();

  // 正常路径 + 幂等（工具层重复调用 → 同事件）
  const okRes = await ingestTool.execute("c4", { title: "工具纪要", body: "由 Agent 记录" } as never);
  ok(okRes.isError !== true, "9e. 正常路径成功");
  const firstId = (okRes.details as { event?: { id: string } })?.event?.id;
  const okRes2 = await ingestTool.execute("c5", { title: "工具纪要", body: "由 Agent 记录" } as never);
  const secondId = (okRes2.details as { event?: { id: string } })?.event?.id;
  ok(!!firstId && firstId === secondId, "9f. 重复调用幂等（同内容 → 同事件）");

  /* ============ 10. 重启持久化 ============ */
  db.close();
  const db2 = new AppDatabase(dbPath);
  const projects2 = new ProjectService(new ProjectRepository(db2.connection), new MemoryService(db2, { semantic: false }));
  const after = projects2.getProjectEvent(firstId);
  ok(after !== undefined && after.source === "document" && after.ref?.length === 64, "10. 重启后 document 事件仍在（含哈希 ref）");
  ok(projects2.getMemory("proj-a", rPromo.targetId) !== undefined, "10b. 重启后提升目标仍在");
  db2.close();
  rmSync(root, { recursive: true, force: true });

  if (failed > 0) {
    console.error(`project-event-document-test: FAILED (${passed} passed, ${failed} failed)`);
    process.exitCode = 1;
  } else {
    console.log(`project-event-document-test: PASS (${passed})`);
  }
}

void main().catch((err) => {
  console.error("project-event-document-test: FAILED", err);
  process.exitCode = 1;
});
