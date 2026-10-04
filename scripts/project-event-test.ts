/**
 * ProjectEventIngestor 测试：外部输入入口层契约——
 * 指令解析（@项目 投递）、source/kind 白名单、长度/载荷有界、归档只读语义、
 * A/B 隔离、onIngested 收敛回调、列表顺序/上限、端到端 gateway 投递路径、
 * 事件不伪造 attention（不参与派生）。
 * 真实 SQLite + 注入时钟（确定性）。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { MemoryService } from "../src/main/memory/MemoryService";
import { ProjectRepository } from "../src/main/project/ProjectRepository";
import { ProjectService } from "../src/main/project/ProjectService";
import {
  parseProjectMessageDirective,
  PROJECT_EVENT_BODY_MAX_CHARS,
  PROJECT_EVENT_PAYLOAD_MAX_BYTES,
  PROJECT_EVENT_SOURCES,
  PROJECT_EVENT_TITLE_MAX_CHARS,
  ProjectEventIngestor,
} from "../src/main/project/ProjectEventIngestor";
import { PROJECT_EVENT_LIST_MAX_LIMIT, PROJECT_EVENT_RETENTION_PER_PROJECT } from "../src/shared/project-domain";
import { ProjectAttentionTracker } from "../src/main/project/ProjectAttention";
import type { ProjectEventDto } from "../src/shared/project-domain";

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

const root = mkdtempSync(join(tmpdir(), "mybuddy-project-event-"));
const db = new AppDatabase(join(root, "app.db"));
const projects = new ProjectService(new ProjectRepository(db.connection), new MemoryService(db, { semantic: false }));

const NOW = 1_800_000_000_000;
db.connection
  .prepare(`INSERT INTO projects (id, name, created_at, updated_at) VALUES ('proj-a', 'A项目', 1, 1), ('proj-b', 'B项目', 1, 1)`)
  .run();

let clock = NOW;
const ingested: Array<{ projectId: string; event: ProjectEventDto }> = [];
const ingestor = new ProjectEventIngestor(projects, {
  now: () => clock,
  onIngested: (projectId, event) => ingested.push({ projectId, event }),
});

function main(): void {
  /* ============ 1. 投递指令解析（纯函数） ============ */
  ok(parseProjectMessageDirective("@项目 A项目：明天上线前确认")?.projectName === "A项目", "1. 全角冒号：名称解析");
  ok(parseProjectMessageDirective("@项目 A项目：明天上线前确认")?.content === "明天上线前确认", "1b. 全角冒号：内容解析");
  const multi = parseProjectMessageDirective("@项目 A项目：第一行\n第二行");
  ok(multi?.content === "第一行\n第二行", "1c. 多行内容保留换行");
  ok(parseProjectMessageDirective("@项目 A项目")?.content === "", "1d. 无冒号 = ping（内容为空）");
  ok(parseProjectMessageDirective("  @项目 A项目: 半角冒号 ")?.content === "半角冒号", "1e. 半角冒号 + 首尾空白容错");
  ok(parseProjectMessageDirective("普通消息") === null, "1f. 无前缀 → null（不改写原消息流）");
  ok(parseProjectMessageDirective("@项目") === null, "1g. 只有前缀 → null");
  ok(parseProjectMessageDirective("@项目：无名称") === null, "1h. 冒号前无名称 → null");

  /* ============ 2. 契约校验（白名单/有界） ============ */
  throws(() => ingestor.ingest("proj-a", { source: "erp" as never, kind: "message", title: "x" }), "2. 未知 source 拒绝（白名单）");
  throws(() => ingestor.ingest("proj-a", { source: "gateway", kind: "alarm" as never, title: "x" }), "2b. 未知 kind 拒绝（白名单）");
  throws(() => ingestor.ingest("proj-a", { source: "gateway", kind: "message", title: "   " }), "2c. 空标题拒绝");
  throws(
    () => ingestor.ingest("proj-a", { source: "gateway", kind: "message", title: "x".repeat(PROJECT_EVENT_TITLE_MAX_CHARS + 1) }),
    "2d. 标题超长拒绝",
  );
  throws(
    () => ingestor.ingest("proj-a", { source: "gateway", kind: "message", title: "x", body: "y".repeat(PROJECT_EVENT_BODY_MAX_CHARS + 1) }),
    "2e. 正文超长拒绝",
  );
  throws(
    () => ingestor.ingest("proj-a", { source: "gateway", kind: "message", title: "x", payload: { big: "z".repeat(PROJECT_EVENT_PAYLOAD_MAX_BYTES) } }),
    "2f. 载荷超限拒绝",
  );
  throws(
    () => ingestor.ingest("proj-a", { source: "gateway", kind: "message", title: "x", ref: "r".repeat(201) }),
    "2f2. 来源引用超长拒绝",
  );
  throws(() => ingestor.ingest("no-such", { source: "gateway", kind: "message", title: "x" }), "2g. 项目不存在拒绝");
  ok(PROJECT_EVENT_SOURCES.includes("gateway") && PROJECT_EVENT_SOURCES.includes("mcp"), "2h. 契约含未来来源（mcp/cron/…）");

  /* ============ 3. 正常投递 + 列表语义 ============ */
  clock = NOW;
  const ev1 = ingestor.ingest("proj-a", {
    source: "gateway",
    kind: "message",
    title: "外部消息（alice）",
    body: "明天上线前确认",
    ref: "gw-msg-1",
    payload: { channel: "telegram-default", chatId: "123" },
  });
  clock = NOW + 1000;
  const ev2 = ingestor.ingest("proj-a", { source: "gateway", kind: "message", title: "外部消息（bob）", body: "风险提示" });
  ok(ev1.id.startsWith("pevt_") && ev1.createdAt === NOW, "3. 事件落库（id 前缀 + 注入时钟）");
  ok(ev1.ref === "gw-msg-1" && ev1.payload?.channel === "telegram-default", "3b. ref/payload 往返");
  const listA = ingestor.list("proj-a");
  ok(listA.length === 2 && listA[0]!.id === ev2.id && listA[1]!.id === ev1.id, "3c. 列表 created_at DESC");
  ok(ingested.length === 2 && ingested[1]!.projectId === "proj-a", "3d. onIngested 回调（projectId + event）");
  // onIngested 抛错不影响落库
  const flaky = new ProjectEventIngestor(projects, {
    now: () => clock,
    onIngested: () => {
      throw new Error("boom");
    },
  });
  const ev3 = flaky.ingest("proj-a", { source: "cron", kind: "run", title: "定时任务完成" });
  ok(ev3 !== undefined && flaky.list("proj-a").some((e) => e.title === "定时任务完成"), "3e. onIngested 抛错不阻断 ingest");

  /* ============ 4. A/B 隔离 + 归档只读语义 ============ */
  ingestor.ingest("proj-b", { source: "gateway", kind: "message", title: "B 的消息" });
  ok(ingestor.list("proj-a").every((e) => e.projectId === "proj-a"), "4. A/B 隔离（列表互不可见）");
  db.connection.prepare(`UPDATE projects SET archived=1 WHERE id='proj-b'`).run();
  throws(() => ingestor.ingest("proj-b", { source: "gateway", kind: "message", title: "归档后不应写入" }), "4b. 归档项目拒绝新增事件（服务层只读）");
  db.connection.prepare(`UPDATE projects SET archived=0 WHERE id='proj-b'`).run();

  /* ============ 5. 列表上限 ============ */
  const bulk = new ProjectEventIngestor(projects, { now: () => clock });
  for (let i = 0; i < 30; i += 1) {
    bulk.ingest("proj-a", { source: "manual", kind: "note", title: `批量 ${i}` });
  }
  ok(bulk.list("proj-a", 5).length === 5, "5. limit 生效");
  ok(bulk.list("proj-a", 99999).length <= PROJECT_EVENT_LIST_MAX_LIMIT, "5b. limit 钳制到上限");

  /* ============ 5c. 容量控制：每项目保留上限，超出淘汰最旧 ============ */
  let capClock = clock;
  const capped = new ProjectEventIngestor(projects, { now: () => ++capClock });
  for (let i = 0; i < PROJECT_EVENT_RETENTION_PER_PROJECT + 10; i += 1) {
    capped.ingest("proj-b", { source: "manual", kind: "note", title: `溢出 ${i}` });
  }
  const cappedList = capped.list("proj-b");
  const cappedTotal = (db.connection
    .prepare(`SELECT COUNT(*) AS c FROM project_events WHERE project_id = 'proj-b'`)
    .get() as { c: number }).c;
  ok(cappedTotal === PROJECT_EVENT_RETENTION_PER_PROJECT, "5c. 每项目事件保留上限（超出淘汰最旧）");
  ok(
    !cappedList.some((e) => e.title === "溢出 0" || e.title === "溢出 9"),
    "5d. 最旧事件被淘汰",
  );
  ok(cappedList.some((e) => e.title === `溢出 ${PROJECT_EVENT_RETENTION_PER_PROJECT + 9}`), "5e. 最新事件保留");

  /* ============ 6. 端到端 gateway 投递路径（parse → resolve → ingest） ============ */
  const directive = parseProjectMessageDirective("@项目 A项目：周五前完成联调")!;
  const project = projects.resolveProjectByName(directive.projectName);
  ok(project?.id === "proj-a", "6. resolveProjectByName 精确匹配");
  ok(projects.resolveProjectByName("不存在") === undefined, "6b. 未知项目 → undefined");
  const routed = project ? ingestor.ingest(project.id, {
    source: "gateway",
    kind: "message",
    title: "外部消息（alice）",
    body: directive.content,
    ref: "gw-msg-2",
  }) : null;
  const routedRow = ingestor.list("proj-a").find((e) => e.ref === "gw-msg-2");
  ok(routed !== null && routedRow?.body === "周五前完成联调" && routedRow.source === "gateway", "6c. 端到端：消息内容进入项目事件");

  /* ============ 7. 事件不伪造派生状态（不参与 snapshot/attention） ============ */
  const tracker = new ProjectAttentionTracker(projects);
  const digestBefore = tracker.getAttention("proj-a", clock);
  ingestor.ingest("proj-a", { source: "gateway", kind: "message", title: "又一条外部消息", body: "纯信息" });
  const after = tracker.onChange("proj-a", clock + 1);
  ok(digestBefore !== null && after === null, "7. 事件触发重算但不伪造健康变化（指纹去重）");
  const snapshot = projects.buildStatusSnapshot("proj-a", clock);
  ok(snapshot.blockers.length === 0 && snapshot.atRisks.length === 0, "7b. snapshot 不从事件取数（派生纯业务真源）");

  db.close();
  rmSync(root, { recursive: true, force: true });
  if (failed > 0) {
    console.error(`project-event-test: FAILED (${passed} passed, ${failed} failed)`);
    process.exitCode = 1;
  } else {
    console.log(`project-event-test: PASS (${passed})`);
  }
}

main();
