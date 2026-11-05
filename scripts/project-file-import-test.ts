/**
 * Project File Import Adapter 集成测试（文件级文档导入：Library-first）。
 * 覆盖：md 导入 → 资料库真源 + document 事件（引用+截取摘要）→ 内容哈希幂等 → A/B 隔离 →
 * 不支持类型（png 无 OCR）优雅降级 → 路径/大小校验 → archived 门禁 → 长文截断/长文件名截断 →
 * 文件事件不可再 promote 为资料（不复制真源）但可提升记忆 → 保留淘汰后真源存活 →
 * Agent 工具面（未绑定/readonly/archived/幂等）→ 重启持久化。
 * 真实 SQLite + 注入 libraryRoot；必须经 scripts/test-guard.mjs 执行。
 */
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { MemoryService } from "../src/main/memory/MemoryService";
import { ProjectRepository } from "../src/main/project/ProjectRepository";
import { ProjectService } from "../src/main/project/ProjectService";
import { ProjectEventIngestor, PROJECT_EVENT_BODY_MAX_CHARS, PROJECT_EVENT_TITLE_MAX_CHARS } from "../src/main/project/ProjectEventIngestor";
import { ProjectEventPromoter } from "../src/main/project/ProjectEventPromoter";
import { ProjectDocumentImporter } from "../src/main/project/ProjectDocumentImporter";
import { createProjectEventExtension } from "../src/main/project/project-event-extension";
import { LibraryService } from "../src/main/library/LibraryService";
import { PROJECT_EVENT_RETENTION_PER_PROJECT } from "../src/shared/project-domain";
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

const root = mkdtempSync(join(tmpdir(), "mybuddy-file-import-"));
// 隔离 HOME：LibraryService 把资料库文件写到 ~/.mybuddy/library（POSIX 的 os.homedir() 读 HOME），
// 只把 SQLite 放进临时目录而不同时隔离 HOME，会把夹具文档写进真实用户资料库。
process.env.HOME = root;
process.env.USERPROFILE = root;
const libRoot = join(root, "lib");
const dbPath = join(root, "app.db");
const db = new AppDatabase(dbPath);
const projects = new ProjectService(new ProjectRepository(db.connection), new MemoryService(db, { semantic: false }));
const library = new LibraryService(db, { libraryRoot: libRoot });
const NOW = 1_800_000_000_000;
let clock = NOW;
const ingestor = new ProjectEventIngestor(projects, { now: () => ++clock });
const promoter = new ProjectEventPromoter(projects, library, { now: () => clock });
const importer = new ProjectDocumentImporter(projects, library, ingestor);

db.connection
  .prepare(`INSERT INTO projects (id, name, created_at, updated_at) VALUES ('proj-a', 'A项目', 1, 1), ('proj-b', 'B项目', 1, 1)`)
  .run();

// 测试用文件
const minutesPath = join(root, "Q3-例会纪要.md");
writeFileSync(minutesPath, "例会纪要：确认 Q3 交付范围与验收标准。\n风险：上游数据源可能延期一周。", "utf8");
const longPath = join(root, "长文.md");
writeFileSync(longPath, "段落。" + "x".repeat(5000), "utf8");
const pngPath = join(root, "示意图.png");
writeFileSync(pngPath, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]));
// 长文件名：Windows 上限是 255 个字符，POSIX(ext4) 上限是 255 个字节；中文 3 字节/字，
// 250 个中文会超过 POSIX 上限直接 ENAMETOOLONG。改用 ASCII 250 字符：两端都合法，且 >200 触发标题截断。
const longNamePath = join(root, `${"n".repeat(250)}.md`);
writeFileSync(longNamePath, "内容", "utf8");
const dirPath = join(root, "目录");

async function main(): Promise<void> {
  /* ============ 1. md 导入：Library-first 基础契约 ============ */
  const r1 = await importer.importFile("proj-a", minutesPath);
  ok(!r1.reused && r1.item !== null, "1. 导入成功（新建资料条目 + 事件）");
  const ev = r1.event;
  ok(ev.source === "document" && ev.kind === "note", "1b. source=document / kind=note");
  ok(/^[0-9a-f]{64}$/.test(ev.ref ?? ""), "1c. ref = 文件内容 sha256（64 hex）");
  ok(ev.title === "Q3-例会纪要.md", "1d. 事件标题 = 文件名");
  ok(ev.body?.includes("交付范围") === true, "1e. 正文 = 抽取文本截取摘要（机械，非自动总结）");
  ok(typeof ev.payload?.libraryItemId === "string" && ev.payload.libraryItemId === r1.item!.id, "1f. provenance：payload.libraryItemId = 真源条目");
  ok(ev.payload?.sizeBytes === Buffer.byteLength("例会纪要：确认 Q3 交付范围与验收标准。\n风险：上游数据源可能延期一周。"), "1g. payload.sizeBytes");
  const item = library.getItem(r1.item!.id);
  ok(item !== null && item.title === "Q3-例会纪要" && item.kind === "markdown", "1h. 资料库真源条目存在（kind=markdown）");
  ok(library.listProjectSpaces("proj-a").some((s) => s.id === item!.spaceId), "1i. 条目位于项目资料空间");
  ok(existsSync(join(libRoot, item!.spaceId, `${item!.id}.md`)), "1j. 受管副本落盘（不依赖源路径）");

  /* ============ 2. 同文件幂等：不重复建条目/事件 ============ */
  const spaceItemsBefore = library.listAllItems(library.listProjectSpaces("proj-a")[0]!.id).length;
  const r2 = await importer.importFile("proj-a", minutesPath);
  ok(r2.reused === true && r2.event.id === ev.id, "2. 同文件重导 → 幂等复用既有事件");
  ok(library.listAllItems(library.listProjectSpaces("proj-a")[0]!.id).length === spaceItemsBefore, "2b. 不重复建资料条目");

  /* ============ 3. A/B 隔离 ============ */
  const rB = await importer.importFile("proj-b", minutesPath);
  ok(rB.event.id !== ev.id && rB.item !== null && rB.item.id !== r1.item!.id, "3. 同文件 B 项目 = 独立事件 + 独立条目");

  /* ============ 4. 不支持类型（无 OCR）：事件仍记录，正文缺省，状态入 payload ============ */
  const rPng = await importer.importFile("proj-a", pngPath);
  ok(rPng.event.body === undefined && rPng.event.payload?.extractStatus === "unsupported", "4. png（无 OCR）→ 事件创建、无正文、extractStatus=unsupported");

  /* ============ 5. 路径/文件校验 ============ */
  await throwsAsync(() => importer.importFile("proj-a", join(root, "不存在.md")), "5. 不存在文件拒绝");
  await throwsAsync(() => importer.importFile("proj-a", dirPath), "5b. 目录拒绝");

  /* ============ 6. 归档项目：写真源写门禁 ============ */
  db.connection.prepare(`UPDATE projects SET archived=1 WHERE id='proj-b'`).run();
  await throwsAsync(() => importer.importFile("proj-b", minutesPath), "6. 归档项目拒绝文件导入（真源写入）");
  db.connection.prepare(`UPDATE projects SET archived=0 WHERE id='proj-b'`).run();

  /* ============ 7. 长文：正文截断到 4000 并标记 ============ */
  const rLong = await importer.importFile("proj-a", longPath);
  ok(rLong.event.body?.length === PROJECT_EVENT_BODY_MAX_CHARS, "7. 长文正文截断到 4000");
  ok(rLong.event.payload?.extractTruncated === true, "7b. extractTruncated 标记（模型不得误以为已读全文）");

  /* ============ 8. 长文件名：标题截断到 200 ============ */
  const rName = await importer.importFile("proj-a", longNamePath);
  ok(rName.event.title.length === PROJECT_EVENT_TITLE_MAX_CHARS, "8. 超长文件名事件标题截断到 200");

  /* ============ 9. 文件事件 promotion 语义：不可再存为资料（不复制真源），可提升记忆 ============ */
  await throwsAsync(async () => promoter.promote(r1.event.id, { targetKind: "library", libraryTitle: "重复", libraryContent: "重复" }), "9. 文件事件提升为资料被拒（已关联真源）");
  const rMem = promoter.promote(r1.event.id, { targetKind: "memory", memoryKind: "risk", memoryTitle: "上游可能延期", memoryContent: "风险记录" });
  ok(!rMem.reused && projects.getMemory("proj-a", rMem.targetId) !== undefined, "9b. 文件事件提升为记忆成功");
  ok(
    projects.getMemory("proj-a", rMem.targetId)!.evidence.some((e) => e.evidenceKind === "event" && e.refId === r1.event.id),
    "9c. 溯源 evidence 指向文件事件",
  );

  /* ============ 10. 保留淘汰：事件消失，资料真源存活 ============ */
  const evKeepPath = join(root, "保留条目.md");
  writeFileSync(evKeepPath, "保留条目内容", "utf8");
  const rKeep = await importer.importFile("proj-a", evKeepPath);
  let capClock = clock;
  const flood = new ProjectEventIngestor(projects, { now: () => ++capClock });
  for (let i = 0; i < PROJECT_EVENT_RETENTION_PER_PROJECT + 5; i += 1) {
    flood.ingest("proj-a", { source: "manual", kind: "note", title: `洪峰 ${i}`, ref: `flood-fi-${i}` });
  }
  ok(projects.getProjectEvent(rKeep.event.id) === undefined, "10. 源事件被滚动淘汰");
  ok(library.getItem(rKeep.item!.id) !== null, "10b. 资料库真源条目不被事件淘汰误删");
  const keepRef = rKeep.event.ref;
  ok(typeof keepRef === "string" && projects.findProjectEventByRef("proj-a", "document", keepRef) === undefined, "10c. 事件表内已无该哈希引用");
  clock = capClock + 10_000;

  /* ============ 11. Agent 工具面：project_event_import_file ============ */
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
    taskId: "task-fi",
    resolveProjectId: () => "proj-a",
    service: projects,
    promoter,
    ingestor,
    importer,
    getPermissionMode: () => "default",
  };
  createProjectEventExtension(bridge)(api);
  const importTool = tools.find((t) => t.name === "project_event_import_file")!;
  ok(!!importTool, "11. 注册 project_event_import_file");

  const unboundBridge: ProjectEventExtensionBridge = { ...bridge, resolveProjectId: () => null };
  const unboundTools: RegisteredTool[] = [];
  const unboundApi = { registerTool: (t: never) => unboundTools.push(t as unknown as RegisteredTool), on: () => undefined } as unknown as ExtensionAPI;
  createProjectEventExtension(unboundBridge)(unboundApi);
  const unboundTool = unboundTools.find((t) => t.name === "project_event_import_file")!;
  const unboundRes = await unboundTool.execute("c2", { filePath: minutesPath } as never);
  ok(unboundRes.isError === true && (unboundRes.content[0]?.text ?? "").includes("未绑定"), "11b. 未绑定任务 → 拒绝");

  const roBridge: ProjectEventExtensionBridge = { ...bridge, getPermissionMode: () => "readonly" };
  const roTools: RegisteredTool[] = [];
  const roApi = { registerTool: (t: never) => roTools.push(t as unknown as RegisteredTool), on: () => undefined } as unknown as ExtensionAPI;
  createProjectEventExtension(roBridge)(roApi);
  const roTool = roTools.find((t) => t.name === "project_event_import_file")!;
  const roRes = await roTool.execute("c3", { filePath: minutesPath } as never);
  ok(roRes.isError === true && (roRes.content[0]?.text ?? "").includes("只读"), "11c. readonly → 拒绝（真源写入）");

  db.connection.prepare(`UPDATE projects SET archived=1 WHERE id='proj-a'`).run();
  const archRes = await importTool.execute("c4", { filePath: minutesPath } as never);
  ok(archRes.isError === true, "11d. 归档项目 → 拒绝（真源写入）");
  db.connection.prepare(`UPDATE projects SET archived=0 WHERE id='proj-a'`).run();

  const okPath = join(root, "工具导入.md");
  writeFileSync(okPath, "Agent 导入的内容", "utf8");
  const okRes = await importTool.execute("c5", { filePath: okPath } as never);
  ok(okRes.isError !== true, "11e. 正常路径成功");
  const firstId = (okRes.details as { event?: { id: string } })?.event?.id;
  const okRes2 = await importTool.execute("c6", { filePath: okPath } as never);
  const secondId = (okRes2.details as { event?: { id: string } })?.event?.id;
  ok(!!firstId && firstId === secondId, "11f. 重复调用幂等（同文件 → 同事件）");

  /* ============ 12. 重启持久化（事件 + 真源条目） ============ */
  db.close();
  const db2 = new AppDatabase(dbPath);
  const projects2 = new ProjectService(new ProjectRepository(db2.connection), new MemoryService(db2, { semantic: false }));
  const library2 = new LibraryService(db2, { libraryRoot: libRoot });
  if (!firstId) throw new Error("Fixture event was not persisted");
  const after = projects2.getProjectEvent(firstId);
  ok(after !== undefined && after.source === "document" && after.ref?.length === 64, "12. 重启后事件仍在（哈希 ref）");
  const afterItemId = typeof after?.payload?.libraryItemId === "string" ? after.payload.libraryItemId : undefined;
  ok(afterItemId !== undefined && library2.getItem(afterItemId) !== null, "12b. 重启后资料真源条目仍在");
  db2.close();
  rmSync(root, { recursive: true, force: true });

  if (failed > 0) {
    console.error(`project-file-import-test: FAILED (${passed} passed, ${failed} failed)`);
    process.exitCode = 1;
  } else {
    console.log(`project-file-import-test: PASS (${passed})`);
  }
}

async function throwsAsync(fn: () => Promise<unknown>, label: string): Promise<void> {
  try {
    await fn();
    ok(false, label);
  } catch {
    ok(true, label);
  }
}

void main().catch((err) => {
  console.error("project-file-import-test: FAILED", err);
  process.exitCode = 1;
});
