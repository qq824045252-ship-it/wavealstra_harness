/**
 * Project Knowledge Runtime 测试（v8）：
 * - Project Shared Context：goal/currentStage CRUD（复用 updateProject）、pinned refs CRUD 与级联；
 * - A↔B 隔离：pin/evidence/retrieval 双向拒绝；personal 可跨项目使用；
 * - Memory evidence：有效引用、跨项目拒绝、item 删除后 memory 保留且 evidence 解析为 missing；
 * - Prompt assembly：Shared Context/Pinned 段顺序与预算、任务附加去重；
 * - Retrieval：FTS 正文命中、标题 exact/prefix 排名、项目过滤、二进制 metadata-only；
 * - current-only schema：Project Memory 只落统一 Memory Kernel，不保留 legacy 双写表。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase, CURRENT_DATABASE_SCHEMA_VERSION } from "../src/main/db/AppDatabase";
import { MemoryService } from "../src/main/memory/MemoryService";
import JSZip from "jszip";
import * as XLSX from "xlsx";
import { LibraryService } from "../src/main/library/LibraryService";
import { ProjectRepository } from "../src/main/project/ProjectRepository";
import { ProjectService } from "../src/main/project/ProjectService";
import { createProjectContextExtension } from "../src/main/project/project-context-extension";
import { createProjectKnowledgeExtension } from "../src/main/project/project-knowledge-extension";
import { ProjectKnowledgeRetrieval } from "../src/main/project/ProjectKnowledgeRetrieval";
import { ProjectContextResolver } from "../src/main/project/ProjectContextResolver";
import {
  assemblePrompt,
  assembleProjectContextSegments,
  mapBtwProjectContextSegments,
  renderProjectPinnedRefs,
  renderProjectSharedContext,
} from "../src/main/agent/PromptAssembly";
import { emptyModePolicy, type ModeProfileDto } from "../src/shared/mode-profile";
import { LIBRARY_PERSONAL_SPACE_ID } from "../src/shared/library-ipc";

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

/** 测试用 zip 构造（jszip 实例 API，避免 bundler interop 差异） */
async function makeZip(entries: Record<string, string | Uint8Array>): Promise<Buffer> {
  const zip = new JSZip();
  for (const [name, content] of Object.entries(entries)) zip.file(name, content);
  return zip.generateAsync({ type: "nodebuffer" });
}

const root = mkdtempSync(join(tmpdir(), "mybuddy-knowledge-"));
const db = new AppDatabase(join(root, "app.db"));
const memory = new MemoryService(db, { semantic: false });
const repository = new ProjectRepository(db.connection);
const projects = new ProjectService(repository, memory);
const library = new LibraryService(db, { libraryRoot: join(root, "lib") });
const resolver = new ProjectContextResolver(db, repository, memory);

for (const [pid, name] of [["proj-a", "项目A"], ["proj-b", "项目B"]] as const) {
  db.connection.prepare(`INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(pid, name, 1, 1);
}

/* ---- 1. Shared Context：goal/currentStage + pins CRUD 与隔离 ---- */
{
  const updated = projects.update({ id: "proj-a", goal: "交付仪表选型方案", currentStage: "方案确认中" });
  ok(updated.goal === "交付仪表选型方案" && updated.currentStage === "方案确认中", "goal/currentStage 经 updateProject 落库");

  const personalItem = library.createItem({ spaceId: LIBRARY_PERSONAL_SPACE_ID, kind: "markdown", title: "个人基线资料" });
  const bSpace = library.createSpace({ name: "B资料", projectId: "proj-b" });
  const bItem = library.createItem({ spaceId: bSpace.id, kind: "markdown", title: "B机密资料" });

  const pinPersonal = projects.pinProjectItem({ projectId: "proj-a", itemId: personalItem.id });
  ok(pinPersonal.itemTitle === "个人基线资料", "personal 条目可被项目 A pin（跨项目主动引用允许）");
  const pinB = projects.pinProjectItem({ projectId: "proj-b", itemId: bItem.id });
  ok(pinB.itemId === bItem.id, "B 项目可 pin 自己项目条目");
  ok(projects.listProjectPins("proj-a").length === 1, "A pins 只有 personal");
  assert.throws(
    () => projects.pinProjectItem({ projectId: "proj-a", itemId: bItem.id }),
    /跨项目/,
    "A 不能 pin B 的条目（跨项目拒绝）",
  );
  const again = projects.pinProjectItem({ projectId: "proj-a", itemId: personalItem.id });
  ok(projects.listProjectPins("proj-a").length === 1, "重复 pin 幂等（UNIQUE）");
  projects.unpinProjectItem({ projectId: "proj-a", itemId: personalItem.id });
  ok(projects.listProjectPins("proj-a").length === 0, "unpin 生效");
  projects.pinProjectItem({ projectId: "proj-a", itemId: personalItem.id });

  // item 删除 → pin 级联清理（memory 不受影响）
  library.deleteItem(bItem.id);
  ok(projects.listProjectPins("proj-b").length === 0, "item 删除后 pin 级联清理");

  // 项目删除 → pins 级联
  db.connection.prepare(`INSERT INTO projects (id, name, created_at, updated_at) VALUES ('proj-del', '待删', 1, 1)`).run();
  const delSpace = library.createSpace({ name: "待删资料", projectId: "proj-del" });
  const delItem = library.createItem({ spaceId: delSpace.id, kind: "markdown", title: "待删条目" });
  projects.pinProjectItem({ projectId: "proj-del", itemId: delItem.id });
  projects.update({ id: "proj-del", goal: "x" });
  projects.createMemory({ projectId: "proj-del", kind: "fact", title: "待删记忆" });
  // 与应用接线一致：先清项目资料，再由 ProjectService 清理 Memory scope 和项目行。
  library.deleteProjectLibrary("proj-del");
  projects.delete("proj-del");
  ok(projects.listProjectPins("proj-del").length === 0, "项目删除后 pins 级联清理");
  const memCount = db.connection
    .prepare(`SELECT COUNT(*) AS n FROM memory_scopes WHERE scope_type = 'project' AND scope_id = 'proj-del'`)
    .get() as { n: number };
  ok(memCount.n === 0, "项目删除后 Memory Kernel project scope 清空");
  const ftsCount = db.connection
    .prepare(`SELECT COUNT(*) AS n FROM library_fts WHERE item_id = ?`)
    .get(delItem.id) as { n: number };
  ok(ftsCount.n === 0, "项目资料删除后 FTS 检索行同步清理（无孤儿）");
}

/* ---- 2. Memory evidence：有效/跨项目拒绝/item 删除后 memory 保留 ---- */
{
  const personalItem = library.createItem({ spaceId: LIBRARY_PERSONAL_SPACE_ID, kind: "markdown", title: "证据-个人" });
  const aSpace = library.createSpace({ name: "A资料", projectId: "proj-a" });
  const aItem = library.createItem({ spaceId: aSpace.id, kind: "markdown", title: "证据-A" });
  const bSpace = library.createSpace({ name: "B资料2", projectId: "proj-b" });
  const bItem = library.createItem({ spaceId: bSpace.id, kind: "markdown", title: "证据-B" });
  db.connection.prepare(`INSERT INTO tasks (id, title, updated_at, project_id) VALUES ('task-x', 'X任务', 1, 'proj-a')`).run();

  const m1 = projects.createMemory(
    { projectId: "proj-a", kind: "decision", title: "选型结论", evidenceItemIds: [personalItem.id, aItem.id], evidenceTaskId: "task-x" },
    { sourceType: "agent", sourceTaskId: "task-x" },
  );
  ok(m1.evidence.length === 3, "evidence 结构化落库（library×2 + task×1）");
  ok(m1.evidence.some((e) => e.evidenceKind === "library" && e.refTitle === "证据-A"), "library evidence 带标题快照");
  assert.throws(
    () => projects.createMemory({ projectId: "proj-a", kind: "fact", title: "越界", evidenceItemIds: [bItem.id] }),
    /其他项目/,
    "跨项目 evidence 拒绝",
  );
  ok(projects.listMemory("proj-a").length === 1, "拒绝后 memory 未写入");

  // item 删除 → memory 保留，evidence 解析为 missing
  library.deleteItem(aItem.id);
  const after = projects.getMemory("proj-a", m1.id)!;
  ok(after !== undefined, "evidence 指向的 item 删除后 memory 保留");
  const libEv = after.evidence.filter((e) => e.evidenceKind === "library");
  ok(libEv.some((e) => e.refId === personalItem.id && e.refTitle === "证据-个人"), "存活 evidence 标题可解析");
  ok(libEv.some((e) => e.refId === aItem.id && e.refTitle === "证据-A"), "已删 evidence 保留来源标题快照");

  // progress kind + importance + memory search
  const progress = projects.createMemory(
    { projectId: "proj-a", kind: "progress", title: "样机已完成", importance: 3 },
    { sourceType: "agent", sourceTaskId: "task-x" },
  );
  ok(progress.kind === "progress" && progress.importance === 3, "progress kind + importance 落库");
  const hits = projects.searchMemory("proj-a", "样机");
  ok(hits.some((h) => h.id === progress.id), "memory search 命中（importance 优先）");

  const doomed = projects.createMemory({
    projectId: "proj-a",
    kind: "fact",
    title: "错误沉淀",
    evidenceItemIds: [personalItem.id],
  });
  ok(doomed.evidence.length === 1, "待删记忆带证据");
  projects.deleteMemory({ projectId: "proj-a", id: doomed.id });
  ok(projects.getMemory("proj-a", doomed.id) === undefined, "人手删除记忆后条目消失");
  const leftover = db.connection
    .prepare(`SELECT COUNT(*) AS n FROM memory_evidence WHERE memory_id = ?`)
    .get(doomed.id) as { n: number };
  ok(leftover.n === 0, "人手删除记忆后证据清理");
  projects.deleteMemory({ projectId: "proj-a", id: "mem_missing" });
  ok(true, "删除不存在的记忆幂等");
}

/* ---- 3. Retrieval：FTS/排名/项目过滤/二进制 metadata-only ---- */
{
  const aSpace = library.listProjectSpaces("proj-a")[0]!;
  library.createItem({ spaceId: aSpace.id, kind: "markdown", title: "仪表密封选型" });
  const md = library.createItem({ spaceId: LIBRARY_PERSONAL_SPACE_ID, kind: "markdown", title: "通用指南" });
  library.writeContent({ id: md.id, content: "# 通用指南\n\n乙腈介质的密封圈选型要点：氯丁橡胶。\n" });
  const bin = library.createItem({ spaceId: aSpace.id, kind: "csv", title: "对照表" });
  library.writeContent({ id: bin.id, content: "材料,适配\n氯丁橡胶,是\n" });

  // FTS 正文命中（项目 A 范围）
  const ftsHits = library.retrieve("氯丁橡胶", { projectId: "proj-a", limit: 10 });
  ok(ftsHits.some((h) => h.itemId === md.id && h.snippet.length > 0), "FTS 正文命中并带 snippet");
  ok(ftsHits.every((h) => h.spaceId === aSpace.id || h.spaceId === LIBRARY_PERSONAL_SPACE_ID), "检索范围 = personal + 当前项目");
  // 项目 B 检索不得命中 A 的项目资料（personal 对 B 恒可见，属冻结规则）
  const bHits = library.retrieve("氯丁橡胶", { projectId: "proj-b", limit: 10 });
  ok(!bHits.some((h) => h.spaceId === aSpace.id), "项目 B 检索不命中 A 的项目资料");
  ok(bHits.some((h) => h.spaceId === LIBRARY_PERSONAL_SPACE_ID), "项目 B 检索仍可见 personal（冻结规则）");
  // 标题 exact 排名优先于 FTS
  const titleHits = library.retrieve("仪表密封选型", { projectId: "proj-a", limit: 10 });
  const exact = titleHits.find((h) => h.title === "仪表密封选型");
  ok(exact && exact.rank === 0, "标题 exact 命中 rank=0");
  const prefix = library.retrieve("仪表", { projectId: "proj-a", limit: 10 });
  ok(prefix.find((h) => h.title === "仪表密封选型")?.rank === 1, "标题 prefix 命中 rank=1");
  // 二进制/非文本：metadata-only（snippet 空，不伪造已理解）
  library.writeContent({ id: bin.id, content: "材料,适配\n氯丁橡胶,是\n" });
  const binHits = library.retrieve("对照表", { projectId: "proj-a", limit: 10 });
  const binHit = binHits.find((h) => h.itemId === bin.id);
  ok(binHit && binHit.snippet === "", "csv 命中 snippet 空（检索只给元数据，正文按需 library_read）");
  // 未绑定任务 → 仅 personal
  const unbound = library.retrieve("氯丁橡胶", { projectId: null, limit: 10 });
  ok(!unbound.some((h) => h.spaceId === aSpace.id), "未绑定任务检索不含项目资料");
}

/* ---- 4. Prompt assembly：Shared Context/Pinned 段、预算、去重 ---- */
{
  const aSpace = library.listProjectSpaces("proj-a")[0]!;
  const pinnedItem = library.createItem({ spaceId: aSpace.id, kind: "markdown", title: "固定文档" });
  projects.pinProjectItem({ projectId: "proj-a", itemId: pinnedItem.id });
  projects.pinProjectItem({ projectId: "proj-a", itemId: library.createItem({ spaceId: LIBRARY_PERSONAL_SPACE_ID, kind: "markdown", title: "固定-个人" }).id });

  const ctx = resolver.resolveProject("proj-a")!;
  ok(ctx.sharedContext?.goal === "交付仪表选型方案" && ctx.sharedContext.pinned.length >= 2, "resolver 产出 sharedContext");
  const shared = renderProjectSharedContext(ctx.sharedContext!);
  ok(shared && shared.includes("交付仪表选型方案") && shared.includes("方案确认中"), "Shared Context 段含 goal/stage");
  const pinned = renderProjectPinnedRefs(ctx.sharedContext!);
  ok(pinned && pinned.includes("固定文档") && pinned.includes("id="), "Pinned 段含标题与 id");
  const dedup = renderProjectPinnedRefs(ctx.sharedContext!, new Set([pinnedItem.id]));
  ok(dedup && !dedup.includes("固定文档"), "任务已附加条目从 Pinned 段去重");

  const segments = assembleProjectContextSegments(ctx);
  ok(segments.some((s) => s.id === "projectSharedContext"), "装配含 projectSharedContext 段");
  ok(segments.some((s) => s.id === "projectPinnedRefs"), "装配含 projectPinnedRefs 段");
  ok(!segments.some((s) => s.id === "projectMemory"), "装配不重复注入 Project Memory 摘要");

  const profile: ModeProfileDto = {
    id: "coding",
    labelZh: "代码",
    version: "1",
    blocks: [],
    policy: emptyModePolicy(),
    hasUserOverride: false,
    totalChars: 0,
    userDir: "",
    policyPath: "",
  };
  const trace = assemblePrompt({
    welcomeMode: "coding",
    profile,
    soul: { name: "测", alias: "你", persona: "助手" },
    permissionMode: "default",
    platform: "win32",
    memoryEnabled: false,
    projectContext: ctx,
    libraryAttachedItemIds: new Set([pinnedItem.id]),
  });
  const all = trace.segments;
  ok(all.some((s) => s.id === "projectSharedContext"), "assemblePrompt 主路径含 Shared Context");
  ok(all.some((s) => s.id === "projectPinnedRefs"), "assemblePrompt 主路径含 Pinned");
  const pinnedSeg = all.find((s) => s.id === "projectPinnedRefs")!;
  ok(!pinnedSeg.content.includes("固定文档"), "主路径 Pinned 段已按任务附加去重");
  ok(!all.some((s) => s.id === "projectMemory"), "主路径由统一 Memory Kernel 独立装配记忆");
  const order = all.map((s) => s.id);
  const rank = (id: string): number => order.indexOf(id);
  ok(rank("project") < rank("projectSharedContext"), "段顺序：Project Identity < SharedContext");
}

/* ---- 5. current-only schema：旧库直接重建，不迁移旧内容 ---- */
{
  const legacyPath = join(root, "legacy-v7.db");
  const raw = new (require("better-sqlite3") as typeof import("better-sqlite3"))(legacyPath);
  raw.exec(`
    CREATE TABLE projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT, instructions TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
      resource_budget_chars INTEGER NOT NULL DEFAULT 128000, template_id TEXT
    );
    INSERT INTO projects (id, name, created_at, updated_at) VALUES ('proj-legacy', '老项目', 1, 1);
    CREATE TABLE library_spaces (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('personal','team')),
      project_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    INSERT INTO library_spaces (id, name, kind, project_id, created_at, updated_at)
      VALUES ('personal', '我的文档', 'personal', NULL, 1, 1);
    CREATE TABLE library_items (
      id TEXT PRIMARY KEY, space_id TEXT NOT NULL, collection_id TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('markdown','html','csv','office','pdf','image','file','url')),
      title TEXT NOT NULL, filename TEXT NOT NULL, mime_type TEXT NOT NULL DEFAULT '',
      size_bytes INTEGER NOT NULL DEFAULT 0, owner TEXT NOT NULL DEFAULT '',
      favorite INTEGER NOT NULL DEFAULT 0, url TEXT,
      source_type TEXT NOT NULL DEFAULT 'created', source_task_id TEXT, source_artifact_id TEXT,
      original_path TEXT, content_hash TEXT, extract_status TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_visited_at INTEGER
    );
    INSERT INTO library_items (id, space_id, kind, title, filename, created_at, updated_at)
      VALUES ('item-legacy', 'personal', 'markdown', '老文档', '老文档.md', 1, 1);
    CREATE TABLE project_memory (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('fact','decision','constraint','risk','open_question')),
      title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','resolved')),
      tags_json TEXT NOT NULL DEFAULT '[]',
      source_type TEXT NOT NULL DEFAULT 'manual' CHECK (source_type IN ('agent','manual')),
      source_task_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    INSERT INTO project_memory (id, project_id, kind, title, created_at, updated_at)
      VALUES ('mem-legacy', 'proj-legacy', 'decision', '老决策', 1, 1);
    PRAGMA user_version = 7;
  `);
  raw.close();

  const up = new AppDatabase(legacyPath);
  ok(up.schemaVersion === CURRENT_DATABASE_SCHEMA_VERSION, "v7 老库直接重建为 current schema");
  const pCols = new Set((up.connection.prepare("PRAGMA table_info(projects)").all() as Array<{ name: string }>).map((c) => c.name));
  ok(pCols.has("goal") && pCols.has("current_stage"), "current projects 含 goal/current_stage 列");
  const tables = up.connection
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('project_context_pins','library_fts')`)
    .all() as Array<{ name: string }>;
  ok(tables.length === 2, "current pins/FTS 表已创建");
  ok(up.connection.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_memory'`).get() === undefined, "legacy project_memory 不再创建");
  ok(up.connection.prepare(`SELECT id FROM projects WHERE id='proj-legacy'`).get() === undefined, "旧项目内容按 current-only 契约丢弃");
  ok(up.connection.prepare(`SELECT id FROM library_items WHERE id='item-legacy'`).get() === undefined, "旧资料内容按 current-only 契约丢弃");
  up.close();

  const again = new AppDatabase(legacyPath);
  ok(again.schemaVersion === CURRENT_DATABASE_SCHEMA_VERSION, "二次启动幂等");
  ok(again.connection.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='project_memory'`).get() === undefined, "二次启动不恢复 legacy 表");
  again.close();
}

/* ---- 6. Hardening：FTS rename/特殊字符/空查询/pin 上限/只读文案/事务回滚 ---- */
{
  // FTS rename 同步：重命名后 FTS 标题随动
  const md = library.createItem({ spaceId: LIBRARY_PERSONAL_SPACE_ID, kind: "markdown", title: "旧标题文档" });
  library.writeContent({ id: md.id, content: "# 旧标题文档\n\n独特内容甲。\n" });
  library.updateItem({ id: md.id, title: "新标题文档" });
  const byNewTitle = library.retrieve("新标题文档", { limit: 10 });
  ok(byNewTitle.some((h) => h.itemId === md.id && h.rank === 0), "FTS/索引重命名同步（新标题 exact）");
  const byNewFts = library.retrieve("独特内容甲", { limit: 10 });
  ok(byNewFts.some((h) => h.itemId === md.id), "重命名后 FTS 正文仍可命中");

  // 特殊字符 / 引号 / 标点 / 空查询
  const special = library.createItem({ spaceId: LIBRARY_PERSONAL_SPACE_ID, kind: "markdown", title: `引号\"测试` });
  library.writeContent({ id: special.id, content: `内容含引号 \" 与反斜杠 \\\\。` });
  let threw = false;
  try {
    library.retrieve(`引号\"测试`, { limit: 10 });
    library.retrieve("!!!", { limit: 10 });
    library.retrieve("——", { limit: 10 });
  } catch {
    threw = true;
  }
  ok(!threw, "特殊字符/标点/纯符号查询不抛错（FTS catch 降级）");
  ok(library.retrieve("", { limit: 10 }).length === 0, "空查询返回空");
  ok(library.retrieve("   ", { limit: 10 }).length === 0, "纯空白查询返回空");

  // pin 硬上限（独立项目，避免与既有 pin 干扰）
  db.connection.prepare(`INSERT INTO projects (id, name, created_at, updated_at) VALUES ('proj-cap', '上限项目', 1, 1)`).run();
  const capSpace = library.createSpace({ name: "上限测试资料", projectId: "proj-cap" });
  for (let i = 0; i < 10; i += 1) {
    const item = library.createItem({ spaceId: capSpace.id, kind: "markdown", title: `上限条目${i}` });
    projects.pinProjectItem({ projectId: "proj-cap", itemId: item.id });
  }
  const extra = library.createItem({ spaceId: capSpace.id, kind: "markdown", title: "第 11 条" });
  ok(projects.listProjectPins("proj-cap").length === 10, "pin 达到上限 10");
  assert.throws(() => projects.pinProjectItem({ projectId: "proj-cap", itemId: extra.id }), /上限/, "第 11 条 pin 拒绝");
  // 重复 pin 已有条目不受上限影响（幂等早退）
  const first = projects.listProjectPins("proj-cap")[0]!;
  ok(projects.pinProjectItem({ projectId: "proj-cap", itemId: first.itemId }).itemId === first.itemId, "重复 pin 幂等早退，不受上限影响");

  // 只读文案：libraryReadable=false 时 pinned 段不提示 library_read
  const ctx = resolver.resolveProject("proj-a")!;
  const roPinned = renderProjectPinnedRefs(ctx.sharedContext!, undefined, false);
  ok(roPinned && !roPinned.includes("library_read") && roPinned.includes("只读分支"), "只读面 pinned 文案不提示不存在的工具");
  const rwPinned = renderProjectPinnedRefs(ctx.sharedContext!, undefined, true);
  ok(rwPinned && rwPinned.includes("library_read"), "可读面 pinned 文案提示 library_read");
  const catalogRo = library.formatCatalog(36, { projectId: "proj-a", toolsAvailable: false });
  ok(!catalogRo.includes("library_search") && catalogRo.includes("告知用户"), "只读面目录文案不提示不存在的工具");

  // 超长 instructions budget
  projects.update({ id: "proj-a", instructions: "规".repeat(5000) });
  const ctxLong = resolver.resolveProject("proj-a")!;
  const segsLong = assembleProjectContextSegments(ctxLong);
  const projectSeg = segsLong.find((s) => s.id === "project")!;
  ok(projectSeg.chars <= 2100, `超长 instructions 被预算截断（${projectSeg.chars} 字符）`);
  ok(projectSeg.content.includes("已截断"), "截断带可读提示");
  projects.update({ id: "proj-a", instructions: null });

  // 事务回滚：非法 evidence kind → Memory Kernel 不留半成品
  assert.throws(
    () =>
      memory.create({
        scopeType: "project",
        scopeId: "proj-a",
        kind: "fact",
        title: "回滚测试",
        evidence: [{
          evidenceKind: "bogus" as never,
          refId: "x",
        }],
      }),
    /证据类型非法|CHECK|constraint/,
    "非法 evidence 抛错",
  );
  const rollbackCount = db.connection
    .prepare(`SELECT COUNT(*) AS n FROM memory_records WHERE title = '回滚测试'`)
    .get() as { n: number };
  ok(rollbackCount.n === 0, "evidence 失败 → memory 整体回滚（不留半成品）");
}

/* ---- 7. Hardening：task/artifact evidence missing + artifact 重存一致 ---- */
{
  db.connection.exec(`
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      space_id TEXT,
      kind TEXT NOT NULL,
      source_type TEXT NOT NULL,
      entry_file TEXT,
      root_dir TEXT NOT NULL,
      storage_path TEXT,
      version INTEGER NOT NULL DEFAULT 1,
      capabilities_json TEXT NOT NULL DEFAULT '{}',
      title TEXT,
      mime_type TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
  `);
  db.connection.prepare(`INSERT INTO tasks (id, title, updated_at, project_id) VALUES ('task-ev', '证据任务', 1, 'proj-a')`).run();
  const artDir = join(root, "art-ev");
  mkdirSync(artDir, { recursive: true });
  const artFile = join(artDir, "report.md");
  writeFileSync(artFile, "# v1\n");
  db.connection
    .prepare(
      `INSERT INTO artifacts (id, task_id, kind, source_type, entry_file, root_dir, version, capabilities_json, title, mime_type, created_at, updated_at)
       VALUES ('art-ev', 'task-ev', 'markdown', 'workspace-file', ?, ?, 1, '{}', '证据产物', 'text/markdown', 1, 1)`,
    )
    .run(artFile, artDir);

  const m = projects.createMemory(
    { projectId: "proj-a", kind: "fact", title: "带任务与产物证据", evidenceTaskId: "task-ev", evidenceArtifactIds: ["art-ev"] },
    { sourceType: "agent", sourceTaskId: "task-ev" },
  );
  ok(m.evidence.some((e) => e.evidenceKind === "task") && m.evidence.some((e) => e.evidenceKind === "artifact"), "task/artifact 证据落库");
  // 跨项目 task/artifact 拒绝
  db.connection.prepare(`INSERT INTO tasks (id, title, updated_at, project_id) VALUES ('task-b-ev', 'B任务', 1, 'proj-b')`).run();
  assert.throws(
    () => projects.createMemory({ projectId: "proj-a", kind: "fact", title: "越界", evidenceTaskId: "task-b-ev" }),
    /其他项目/,
    "跨项目 task evidence 拒绝",
  );
  assert.throws(
    () => projects.createMemory({ projectId: "proj-a", kind: "fact", title: "越界", evidenceArtifactIds: ["art-b"] }),
    /不存在/,
    "不存在的 artifact evidence 拒绝",
  );

  // artifact 重存一致性：源变化 → 副本更新 + 版本；跨 collection → 移动
  const saved = library.saveArtifact({ artifactId: "art-ev", spaceId: LIBRARY_PERSONAL_SPACE_ID });
  const hashV1 = saved.contentHash;
  writeFileSync(artFile, "# v2 内容已更新\n");
  const resaved = library.saveArtifact({ artifactId: "art-ev", spaceId: LIBRARY_PERSONAL_SPACE_ID });
  ok(resaved.id === saved.id, "同空间重存复用同一条目");
  ok(resaved.contentHash !== hashV1, "源内容变化后 contentHash 更新（不静默返回旧副本）");
  ok(library.listVersions(saved.id).length === 1, "内容变化记录 LibraryVersion（旧 hash）");
  ok(library.readContent(saved.id).content.includes("v2"), "受管副本已更新为 v2");
  const coll = library.createCollection({ spaceId: LIBRARY_PERSONAL_SPACE_ID, name: "归档夹" });
  const moved = library.saveArtifact({ artifactId: "art-ev", spaceId: LIBRARY_PERSONAL_SPACE_ID, collectionId: coll.id });
  ok(moved.id === saved.id && moved.collectionId === coll.id, "跨 collection 保存 = 移动现有条目");
  const sameHash = library.saveArtifact({ artifactId: "art-ev", spaceId: LIBRARY_PERSONAL_SPACE_ID, collectionId: coll.id });
  ok(sameHash.updatedAt === moved.updatedAt, "内容未变且集合未变 → 幂等 no-op（不写不 bump）");

  // 删除 task/artifact → evidence 保留（intended missing，memory 不删）
  db.deleteTask("task-ev");
  db.connection.prepare(`DELETE FROM artifacts WHERE id = 'art-ev'`).run();
  const afterDel = projects.getMemory("proj-a", m.id)!;
  ok(afterDel !== undefined, "task/artifact 删除后 memory 保留");
  ok(
    afterDel.evidence.some((e) => e.evidenceKind === "task" && e.refId === "task-ev") &&
      afterDel.evidence.some((e) => e.evidenceKind === "artifact" && e.refId === "art-ev"),
    "证据行保留（missing 语义）",
  );
}

/* ---- 8. current-only reset：旧 v8 内容不进入当前库 ---- */
{
  const repairPath = join(root, "repair.db");
  const raw = new (require("better-sqlite3") as typeof import("better-sqlite3"))(repairPath);
  raw.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    INSERT INTO projects (id, name, created_at, updated_at) VALUES ('proj-keep', '存活项目', 1, 1);
    CREATE TABLE library_spaces (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('personal','team')),
      project_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    INSERT INTO library_spaces (id, name, kind, project_id, created_at, updated_at)
      VALUES ('personal', '我的文档', 'personal', NULL, 1, 1),
             ('space-orphan', '孤儿空间', 'team', 'proj-gone', 1, 1),
             ('space-keep', '存活空间', 'team', 'proj-keep', 1, 1);
    CREATE TABLE library_collections (
      id TEXT PRIMARY KEY, space_id TEXT NOT NULL, parent_id TEXT, name TEXT NOT NULL,
      owner TEXT NOT NULL DEFAULT '', created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE library_items (
      id TEXT PRIMARY KEY, space_id TEXT NOT NULL, collection_id TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('markdown','html','csv','office','pdf','image','file','url')),
      title TEXT NOT NULL, filename TEXT NOT NULL, mime_type TEXT NOT NULL DEFAULT '',
      size_bytes INTEGER NOT NULL DEFAULT 0, owner TEXT NOT NULL DEFAULT '',
      favorite INTEGER NOT NULL DEFAULT 0, url TEXT,
      source_type TEXT NOT NULL DEFAULT 'created', source_task_id TEXT, source_artifact_id TEXT,
      original_path TEXT, content_hash TEXT, extract_status TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_visited_at INTEGER
    );
    INSERT INTO library_items (id, space_id, collection_id, kind, title, filename, created_at, updated_at)
      VALUES ('item-orphan-ref', 'personal', 'coll-gone', 'markdown', '悬挂集合条目', 'x.md', 1, 1),
             ('item-keep', 'space-orphan', NULL, 'markdown', '孤儿空间条目', 'y.md', 1, 1),
             ('item-alive', 'space-keep', NULL, 'markdown', '存活条目', 'z.md', 1, 1);
    CREATE TABLE task_library_references (
      task_id TEXT NOT NULL, item_id TEXT NOT NULL, project_id TEXT,
      added_at INTEGER NOT NULL, added_by TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (task_id, item_id)
    );
    INSERT INTO task_library_references (task_id, item_id, added_at)
      VALUES ('task-x', 'item-gone', 1), ('task-x', 'item-alive', 1);
    CREATE TABLE library_items_next (id TEXT PRIMARY KEY);
    CREATE TABLE project_memory (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('fact','decision','constraint','risk','open_question','progress')),
      title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','superseded','resolved')),
      tags_json TEXT NOT NULL DEFAULT '[]',
      source_type TEXT NOT NULL DEFAULT 'manual' CHECK (source_type IN ('agent','manual')),
      source_task_id TEXT, importance INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    PRAGMA user_version = 8;
  `);
  raw.close();

  const mkdirSync2 = require("node:fs").mkdirSync;
  mkdirSync2(join(root, "repair-lib", "space-orphan"), { recursive: true });
  require("node:fs").writeFileSync(join(root, "repair-lib", "space-orphan", "y.md"), "x");

  const up = new AppDatabase(repairPath);
  ok(
    (up.connection.prepare(`SELECT COUNT(*) AS n FROM task_library_references`).get() as { n: number }).n === 0,
    "current-only：旧任务资料引用全部丢弃",
  );
  ok(
    (up.connection.prepare(`SELECT COUNT(*) AS n FROM library_items WHERE collection_id = 'coll-gone'`).get() as { n: number }).n === 0,
    "修复：悬挂 collection_id 归一为 NULL",
  );
  ok(
    up.connection.prepare(`SELECT id FROM library_spaces WHERE id = 'space-orphan'`).get() === undefined,
    "修复：孤儿项目资料空间被级联清理",
  );
  ok(
    up.connection.prepare(`SELECT id FROM library_items WHERE id = 'item-keep'`).get() === undefined,
    "修复：孤儿空间条目被清理",
  );
  // 注：孤儿空间磁盘目录清理使用 getLibraryDir()（生产路径）；测试用自定义 libraryRoot 无法注入，
  // 故仅断言 DB 级清理；磁盘清理为 best-effort（rmSync force，失败不阻塞）。
  ok(
    up.connection.prepare(`SELECT id FROM library_items WHERE id = 'item-alive'`).get() === undefined,
    "current-only：旧库内容不按对象级别择优保留",
  );
  ok(
    up.connection.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name='library_items_next'`).get() === undefined,
    "修复：library_items_next 残留清理",
  );
  up.close();
  const up2 = new AppDatabase(repairPath);
  ok(up2.schemaVersion === CURRENT_DATABASE_SCHEMA_VERSION, "修复后二次启动幂等");
  up2.close();
}

/* ---- 9. Project Context Agent 工具：隔离/未绑定/readonly/上限（async 段） ---- */
void (async () => {
  const bItem = library.createItem({
    spaceId: library.createSpace({ name: "B资料3", projectId: "proj-b" }).id,
    kind: "markdown",
    title: "B机密上下文测试",
  });
  const personalCtxItem = library.createItem({ spaceId: LIBRARY_PERSONAL_SPACE_ID, kind: "markdown", title: "个人可固定条目" });

  interface CtxTool {
    name: string;
    execute: (toolCallId: string, params: never) => Promise<{
      content: Array<{ type: string; text: string }>;
      isError?: boolean;
      details?: unknown;
    }>;
  }
  const makeCtxExtension = (projectId: string | null, permissionMode: string): Map<string, CtxTool> => {
    const tools = new Map<string, CtxTool>();
    const api = {
      registerTool: (tool: never) => {
        const t = tool as unknown as CtxTool;
        tools.set(t.name, t);
      },
      on: () => undefined,
    } as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;
    createProjectContextExtension({
      taskId: "task-ctx",
      resolveProjectId: () => projectId,
      projectService: projects,
      getPermissionMode: () => permissionMode as never,
    })(api);
    return tools;
  };
  const callCtx = async (
    tools: Map<string, CtxTool>,
    name: string,
    params: Record<string, unknown> = {},
  ): Promise<Awaited<ReturnType<CtxTool["execute"]>>> => {
    const tool = tools.get(name);
    ok(tool !== undefined, `context 工具已注册：${name}`);
    return tool!.execute("tc", params as never);
  };

  // 项目 A 任务：读取自身上下文 + 更新 + pin（personal/自身条目）
  const toolsA = makeCtxExtension("proj-a", "default");
  const names = [...toolsA.keys()].sort();
  ok(
    JSON.stringify(names) ===
      JSON.stringify(["project_context_get", "project_context_pin", "project_context_unpin", "project_context_update"]),
    `context 工具集正确（${names.join(",")}）`,
  );
  const got = await callCtx(toolsA, "project_context_get");
  ok(got.isError === undefined && got.content[0].text.includes("交付仪表选型方案"), "A: 读取自身 Shared Context");
  const updated = await callCtx(toolsA, "project_context_update", { goal: "新目标：通过验收" });
  ok(updated.isError === undefined && updated.content[0].text.includes("新目标"), "A: 局部更新 goal");
  ok(projects.getSharedContext("proj-a").goal === "新目标：通过验收", "A: 更新真实落库");
  const cleared = await callCtx(toolsA, "project_context_update", { goal: null });
  ok(cleared.isError === undefined && cleared.content[0].text.includes("未设置"), "A: null 清空字段");
  ok(projects.getSharedContext("proj-a").goal === null, "A: 清空真实落库");
  const longGoal = await callCtx(toolsA, "project_context_update", { goal: "长".repeat(301) });
  ok(longGoal.isError === true, "A: goal 超限（301 字符）被拒");
  const noop = projects.updateSharedContext("proj-a", {});
  ok(noop.goal === null && noop.currentStage === "方案确认中", "service: 空 patch no-op 返回现状");
  // 恢复 goal 供后续断言
  projects.updateSharedContext("proj-a", { goal: "交付仪表选型方案" });

  const pinOwn = await callCtx(toolsA, "project_context_pin", { itemId: personalCtxItem.id });
  ok(pinOwn.isError === undefined, "A: pin personal 条目允许");
  const pinCross = await callCtx(toolsA, "project_context_pin", { itemId: bItem.id });
  ok(pinCross.isError === true && pinCross.content[0].text.includes("跨项目"), "A: pin B 条目拒绝（跨项目）");
  const unpinOwn = await callCtx(toolsA, "project_context_unpin", { itemId: personalCtxItem.id });
  ok(unpinOwn.isError === undefined, "A: unpin 正常");
  ok(!projects.listProjectPins("proj-a").some((p) => p.itemId === personalCtxItem.id), "A: unpin 真实落库");

  // 未绑定任务：所有工具受控错误（不泄露任何项目上下文）
  const toolsUnbound = makeCtxExtension(null, "default");
  const unboundGet = await callCtx(toolsUnbound, "project_context_get");
  ok(unboundGet.isError === true && unboundGet.content[0].text.includes("未绑定"), "unbound: get 受控错误");
  const unboundPin = await callCtx(toolsUnbound, "project_context_pin", { itemId: personalCtxItem.id });
  ok(unboundPin.isError === true, "unbound: pin 受控错误");

  // B 项目任务读取 A 上下文被拒（projectId 由绑定解析，无参数注入面）
  const toolsB = makeCtxExtension("proj-b", "default");
  const bGet = await callCtx(toolsB, "project_context_get");
  ok(bGet.isError === undefined && bGet.content[0].text.includes("未设置"), "B: 只看到 B 自己的上下文（A 的目标不泄露）");
  ok(!bGet.content[0].text.includes("交付仪表选型方案"), "B: A 的上下文内容不泄露");

  // readonly：读取允许、写入拒绝
  const toolsRo = makeCtxExtension("proj-a", "readonly");
  const roGet = await callCtx(toolsRo, "project_context_get");
  ok(roGet.isError === undefined, "readonly: get 允许");
  const roUpdate = await callCtx(toolsRo, "project_context_update", { goal: "x" });
  ok(roUpdate.isError === true && roUpdate.content[0].text.includes("只读"), "readonly: update 拒绝");
  const roPin = await callCtx(toolsRo, "project_context_pin", { itemId: personalCtxItem.id });
  ok(roPin.isError === true, "readonly: pin 拒绝");

  // pin 上限经工具同样拒绝（复用 service 上限）
  const toolsCap = makeCtxExtension("proj-cap", "default");
  const capPin = await callCtx(toolsCap, "project_context_pin", { itemId: personalCtxItem.id });
  ok(capPin.isError === true && capPin.content[0].text.includes("上限"), "pin 上限经工具拒绝（proj-cap 已满）");
})().then(() => {
  /* ---- 10. Project Knowledge Retrieval：统一层 + 工具 scope/分层/预算/生命周期 ---- */
  return (async () => {
  const retrieval = new ProjectKnowledgeRetrieval(db, library, projects);

  // 准备任务与资料
  db.connection.prepare(`INSERT INTO tasks (id, title, updated_at, project_id) VALUES ('task-ka', 'A任务', 1, 'proj-a')`).run();
  db.connection.prepare(`INSERT INTO tasks (id, title, updated_at, project_id) VALUES ('task-kb', 'B任务', 1, 'proj-b')`).run();
  db.connection.prepare(`INSERT INTO tasks (id, title, updated_at) VALUES ('task-knone', '无项目任务', 1)`).run();
  const aSpace = library.listProjectSpaces("proj-a")[0]!;
  const bSpace = library.listProjectSpaces("proj-b")[0]!;
  const aDoc = library.createItem({ spaceId: aSpace.id, kind: "markdown", title: "A密封件技术文档" });
  library.writeContent({ id: aDoc.id, content: "# A文档\n\n乙腈介质高温密封圈选型记录。\n" });
  const bDoc = library.createItem({ spaceId: bSpace.id, kind: "markdown", title: "B财务机密文档" });
  library.writeContent({ id: bDoc.id, content: "# B文档\n\n预算与报价机密内容。\n" });
  const personalDoc = library.createItem({ spaceId: LIBRARY_PERSONAL_SPACE_ID, kind: "markdown", title: "个人通用知识库" });
  library.writeContent({ id: personalDoc.id, content: "# 个人\n\n通用密封材料对比表。\n" });
  const pinnedA = library.createItem({ spaceId: aSpace.id, kind: "markdown", title: "A固定基线" });
  projects.pinProjectItem({ projectId: "proj-a", itemId: pinnedA.id });
  library.attachToTask({ itemId: aDoc.id, taskId: "task-ka" });

  // 1. scope：A 任务可见 personal + A，不可见 B（3 字符查询走 FTS）
  const rA = retrieval.search("task-ka", "密封圈");
  ok(rA.scope === "project" && rA.projectId === "proj-a", "A: scope=project");
  ok(rA.hits.some((h) => h.itemId === aDoc.id), "A: 命中 A 资料（FTS 正文）");
  ok(!rA.hits.some((h) => h.title.includes("B财务")), "A: 绝不命中 B 项目资料");
  // 2. 分层：aDoc 已附加到任务 → task-explicit；pinnedA → pinned；personalDoc → plain
  ok(rA.hits.find((h) => h.itemId === aDoc.id)?.tier === "task-explicit", "A: 附加条目 tier=task-explicit");
  const rPin = retrieval.search("task-ka", "固定基线");
  ok(rPin.hits.find((h) => h.itemId === pinnedA.id)?.tier === "pinned", "A: 固定引用 tier=pinned");
  const rPlain = retrieval.search("task-ka", "知识库");
  ok(rPlain.hits.find((h) => h.itemId === personalDoc.id)?.tier === "plain", "A: 普通命中 tier=plain");
  // 同一 item 同时附加+固定 → 只出现一次且取最高层 task-explicit
  projects.pinProjectItem({ projectId: "proj-a", itemId: aDoc.id });
  const rDedup = retrieval.search("task-ka", "乙腈介质");
  const dedupHits = rDedup.hits.filter((h) => h.itemId === aDoc.id);
  ok(dedupHits.length === 1 && dedupHits[0]!.tier === "task-explicit", "A: 同 item 去重且取最高层");
  // 3. 未绑定任务：仅 personal
  const rNone = retrieval.search("task-knone", "知识库");
  ok(rNone.scope === "personal" && rNone.projectId === null, "unbound: scope=personal");
  ok(rNone.hits.every((h) => h.spaceId === LIBRARY_PERSONAL_SPACE_ID), "unbound: 仅 personal 命中");
  ok(rNone.hits.some((h) => h.itemId === personalDoc.id), "unbound: personal 可检索");
  // 4. B 任务不能搜到 A
  const rB = retrieval.search("task-kb", "密封圈");
  ok(!rB.hits.some((h) => h.itemId === aDoc.id), "B: 搜不到 A 的文档");
  ok(!rB.hits.some((h) => h.title.includes("A密封")), "B: A 标题不泄露");
  // 5. 预算：limit clamp + snippet 截断
  const rCap = retrieval.search("task-ka", "文档", { limit: 100 });
  ok(rCap.hits.length <= 20 && rCap.budget.effectiveLimit === 20, "limit 超限被钳制到 20");
  const longDoc = library.createItem({ spaceId: aSpace.id, kind: "markdown", title: "长文档" });
  library.writeContent({ id: longDoc.id, content: `# 长文档\n\n${"片".repeat(6000)}` });
  const rLong = retrieval.search("task-ka", "片片片");
  const longHit = rLong.hits.find((h) => h.itemId === longDoc.id);
  ok(longHit && longHit.snippet.length <= 300, "snippet ≤300 字符");
  // 6. read：文本预算截断 / 二进制 requiresFileAccess / 跨项目拒绝
  const readText = await retrieval.read("task-ka", longDoc.id);
  ok(readText.truncated && readText.content.length <= 4100, "read 文本截断预算内");
  const readPersonal = await retrieval.read("task-ka", personalDoc.id);
  ok(!readPersonal.requiresFileAccess && readPersonal.content.includes("密封材料"), "read personal 允许");
  const artDir = join(root, "kart");
  mkdirSync(artDir, { recursive: true });
  const binFile = join(artDir, "drawing.pdf");
  writeFileSync(binFile, Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x99, 0xff]));
  db.connection
    .prepare(
      `INSERT INTO artifacts (id, task_id, kind, source_type, entry_file, root_dir, version, capabilities_json, title, mime_type, created_at, updated_at)
       VALUES ('art-k', 'task-ka', 'pdf', 'workspace-file', ?, ?, 1, '{}', '图纸', 'application/pdf', 1, 1)`,
    )
    .run(binFile, artDir);
  const binItem = library.saveArtifact({ artifactId: "art-k", spaceId: aSpace.id });
  const readBin = await retrieval.read("task-ka", binItem.id);
  ok(readBin.requiresFileAccess && readBin.content === "" && !readBin.content.includes("�"), "二进制 read: requiresFileAccess 且无乱码");
  ok(readBin.managedPath !== undefined, "二进制 read: 给出受管路径（供文件工具）");
  let readCross = "";
  try {
    await retrieval.read("task-kb", aDoc.id);
  } catch (e) {
    readCross = (e as Error).message;
  }
  ok(readCross.includes("跨项目"), "B 读 A 条目被拒");
  let readNoneErr = "";
  try {
    await retrieval.read("task-knone", aDoc.id);
  } catch (e) {
    readNoneErr = (e as Error).message;
  }
  ok(readNoneErr.includes("可见范围"), "unbound 读 A 条目被拒");
  // 7. evidence 闭环：检索命中 → memory evidence（复用既有校验）
  const ev = projects.createMemory(
    { projectId: "proj-a", kind: "fact", title: "检索结论", evidenceItemIds: [aDoc.id] },
    { sourceType: "agent", sourceTaskId: "task-ka" },
  );
  ok(ev.evidence.some((e) => e.evidenceKind === "library" && e.refId === aDoc.id), "检索命中可作 evidence 闭环");
  // 8. 生命周期：删除 item → 检索不悬空；删除 task → tier 回落；项目删除 → 全部消失
  const rBeforeDel = retrieval.search("task-ka", "固定基线");
  ok(rBeforeDel.hits.some((h) => h.itemId === pinnedA.id), "删除前可检索");
  library.deleteItem(pinnedA.id);
  const rAfterDel = retrieval.search("task-ka", "固定基线");
  ok(!rAfterDel.hits.some((h) => h.itemId === pinnedA.id), "item 删除后检索不返回悬空条目");
  library.deleteItem(aDoc.id);
  const rAfterTaskDel = retrieval.search("task-ka", "乙腈介质");
  ok(!rAfterTaskDel.hits.some((h) => h.itemId === aDoc.id), "item 删除后 FTS/refs 不悬空");
  db.deleteTask("task-ka");
  db.connection.prepare(`INSERT INTO tasks (id, title, updated_at, project_id) VALUES ('task-ka', 'A任务', 2, 'proj-a')`).run();
  const rAfterDetach = retrieval.search("task-ka", "知识库");
  ok(rAfterDetach.hits.every((h) => h.tier !== "task-explicit"), "任务删除后无 task-explicit tier");
  // 9. 工具层 scope（mock 扩展直调）
  const kTools = new Map<string, { name: string; execute: (t: string, p: never) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> }>();
  const kApi = {
    registerTool: (tool: never) => {
      const t = tool as unknown as { name: string; execute: (t: string, p: never) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> };
      kTools.set(t.name, t);
    },
    on: () => undefined,
  } as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;
  createProjectKnowledgeExtension({ taskId: "task-ka", retrieval })(kApi);
  const kNames = [...kTools.keys()].sort();
  ok(
    JSON.stringify(kNames) === JSON.stringify(["project_knowledge_read", "project_knowledge_search"]),
    `知识工具集正确（${kNames.join(",")}）`,
  );
  const kSearch = await kTools.get("project_knowledge_search")!.execute("tc", { query: "密封圈" } as never);
  ok(kSearch.isError === undefined && kSearch.content[0].text.includes("范围：personal + 当前项目"), "工具: 检索输出 scope 标注");
  ok(!kSearch.content[0].text.includes("B财务"), "工具: B 内容不出现");
  const kSearchUnbound = await (() => {
    const tools2 = new Map<string, { name: string; execute: (t: string, p: never) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> }>();
    const api2 = {
      registerTool: (tool: never) => {
        const t = tool as unknown as { name: string; execute: (t: string, p: never) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }> };
        tools2.set(t.name, t);
      },
      on: () => undefined,
    } as unknown as import("@earendil-works/pi-coding-agent").ExtensionAPI;
    createProjectKnowledgeExtension({ taskId: "task-knone", retrieval })(api2);
    return tools2.get("project_knowledge_search")!.execute("tc", { query: "知识库" } as never);
  })();
  ok(kSearchUnbound.content[0].text.includes("仅 personal"), "工具: 未绑定任务降级 personal-only 标注");
  // 10. registry：文本抽取 + 二进制 unsupported + symlink 守卫
  ok((await retrieval.getExtractionStatus(longDoc)).status === "extracted", "registry: 文本类抽取成功");
  ok((await retrieval.getExtractionStatus(binItem)).status !== "extracted", "registry: 损坏 pdf 抽取失败（降级 requiresFileAccess）");
  // symlink/junction 守卫：受管文件被替换为指向库外的 junction → 抽取必须拒绝（不读取库外）
  const juncOutside = join(root, "k-outside");
  mkdirSync(juncOutside, { recursive: true });
  writeFileSync(join(juncOutside, "secret.txt"), "库外机密");
  const guardItem = library.createItem({ spaceId: aSpace.id, kind: "markdown", title: "守卫目标" });
  const guardPath = library.absolutePath(guardItem);
  require("node:fs").rmSync(guardPath, { force: true });
  let guardLinked = false;
  try {
    require("node:fs").symlinkSync(juncOutside, guardPath, "junction");
    guardLinked = true;
  } catch {
    /* 环境不支持 junction → 跳过 */
  }
  if (guardLinked) {
    ok((await retrieval.getExtractionStatus(guardItem)).status === "unsupported", "registry: junction 路径不读取（守卫生效）");
    ok((await retrieval.read("task-ka", guardItem.id)).requiresFileAccess === true, "registry: junction 读取按非文本降级");
    require("node:fs").rmSync(guardPath, { force: true });
  }
  // 11. prompt 不整库注入：knowledge 工具存在性不影响装配段（无新增段）
  const ctxK = resolver.resolveProject("proj-a")!;
  const segsK = assembleProjectContextSegments(ctxK);
  ok(!segsK.some((s) => s.id.includes("knowledge")), "装配无新增 knowledge 段（检索按需，不预注入）");
  ok(segsK.some((s) => s.id === "projectPinnedRefs"), "装配保留 pinned 引用段（分层语义不变）");

  // 12. catalog 不注入绝对路径（无差别暴露关闭）
  const catNoPath = library.formatCatalog(36, { projectId: "proj-a", toolsAvailable: true });
  ok(!catNoPath.includes("path="), "catalog 不含绝对路径（读取走工具）");
  ok(catNoPath.includes("library_search"), "catalog 含检索工具指引");

  // 13. BTW 重映射纯函数：任务改绑后旧项目内容绝不残留（段级动态重渲染）
  const oldSegs = [
    { id: "projectSharedContext", content: "旧项目X的目标与阶段" },
    { id: "projectPinnedRefs", content: "X固定资料清单" },
    { id: "library", content: "X目录：旧项目内容" },
    { id: "libraryAttachments", content: "X附加资料" },
    { id: "projectPlan", content: "project_plan_create 读写指引" },
    { id: "projectMemory", content: "project_memory_create 读写指引" },
    { id: "workspace", content: "工作目录段" },
    { id: "expert", content: "专家角色" },
  ];
  const ctxBtw = resolver.resolveProject("proj-a")!;
  const outBtw = mapBtwProjectContextSegments(oldSegs, ctxBtw, {
    catalog: "## 资料库（当前项目重算）",
    attachments: "## 已附加到本任务的资料（当前任务重算）",
  });
  ok(!outBtw.some((s) => s.includes("旧项目X") || s.includes("X目录") || s.includes("X附加")), "BTW: 旧项目 sharedContext/pins/catalog/attachments 全部重算，无残留");
  ok(outBtw.some((s) => s.includes("交付仪表选型方案")), "BTW: 新项目 goal 渲染（sharedContext 重渲染）");
  ok(outBtw.some((s) => s.includes("当前项目重算")), "BTW: catalog 重算替换");
  ok(outBtw.some((s) => s.includes("当前任务重算")), "BTW: attachments 重算替换");
  ok(!outBtw.some((s) => s.includes("project_plan_create")), "BTW: plan 只读变体（无写工具名）");
  ok(!outBtw.some((s) => s.includes("工作目录段")), "BTW: workspace 段移除");
  ok(outBtw.some((s) => s.includes("专家角色")), "BTW: 非项目段原样透传");
  const outUnbound = mapBtwProjectContextSegments(oldSegs, null, { catalog: null, attachments: "## 已附加" });
  ok(!outUnbound.some((s) => s.includes("旧项目X")), "BTW: 解绑后项目段全移除（无残留）");
  ok(!outUnbound.some((s) => s.includes("## 资料库")), "BTW: 解绑后无目录段");

  // 15. Office/PDF 抽取：DOCX/PPTX/XLSX/PDF 真实样例 → FTS 检索 + read 内联 + 跨项目 + 损坏/炸弹/更新/删除
  {
    const JSZipLib = JSZip;
    const XLSXLib = XLSX;

    // 构造样例文件
    const docxBuf = await makeZip({
      "[Content_Types].xml": "<?xml version=\"1.0\"?><Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"/>",
      "word/document.xml": `<?xml version="1.0"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>密封圈选型 DOCX 文档内容乙腈</w:t></w:r></w:p></w:body></w:document>`,
    });
    const pptxBuf = await makeZip({
      "[Content_Types].xml": "<Types xmlns=\"http://schemas.openxmlformats.org/package/2006/content-types\"/>",
      "ppt/slides/slide1.xml": `<?xml version="1.0"?><p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:t>PPTX 演示内容乙腈方案</a:t></p:sld>`,
    });
    const xlsxWb = XLSXLib.utils.book_new();
    XLSXLib.utils.book_append_sheet(
      xlsxWb,
      XLSXLib.utils.aoa_to_sheet([["材料", "适配"], ["氯丁橡胶", "是"], ["乙腈介质", "耐腐蚀"]]),
      "Sheet1",
    );
    const xlsxBuf = XLSXLib.write(xlsxWb, { type: "buffer" });
    // PDF：手写最小合法 PDF（精确 xref 偏移与流长度）
    function buildMinimalPdf(text: string): Buffer {
      const streamData = `BT /F1 12 Tf 20 100 Td (${text}) Tj ET\n`;
      const objects = [
        "<< /Type /Catalog /Pages 2 0 R >>",
        "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
        `<< /Length ${Buffer.byteLength(streamData, "utf8")} >>\nstream\n${streamData}endstream`,
        "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
      ];
      let body = "%PDF-1.4\n";
      const offsets: number[] = [];
      objects.forEach((obj, i) => {
        offsets.push(Buffer.byteLength(body, "utf8"));
        body += `${i + 1} 0 obj ${obj} endobj\n`;
      });
      const xref = Buffer.byteLength(body, "utf8");
      body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
      for (const off of offsets) body += `${String(off).padStart(10, "0")} 00000 n \n`;
      body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
      return Buffer.from(body, "utf8");
    }
    const pdfBuf = buildMinimalPdf("sealplan2026 pdf extraction text");

    const offDir = join(root, "office-samples");
    mkdirSync(offDir, { recursive: true });
    const docxFile = join(offDir, "选型.docx");
    const pptxFile = join(offDir, "演示.pptx");
    const xlsxFile = join(offDir, "对照.xlsx");
    const pdfFile = join(offDir, "方案.pdf");
    writeFileSync(docxFile, docxBuf as unknown as Uint8Array);
    writeFileSync(pptxFile, pptxBuf as unknown as Uint8Array);
    writeFileSync(xlsxFile, xlsxBuf as unknown as Uint8Array);
    writeFileSync(pdfFile, pdfBuf as unknown as Uint8Array);

    const docxItem = library.importFile({ spaceId: aSpace.id, sourcePath: docxFile });
    const pptxItem = library.importFile({ spaceId: aSpace.id, sourcePath: pptxFile });
    const xlsxItem = library.importFile({ spaceId: aSpace.id, sourcePath: xlsxFile });
    const pdfItem = library.importFile({ spaceId: aSpace.id, sourcePath: pdfFile });
    ok(docxItem.kind === "office" && pdfItem.kind === "pdf" && xlsxItem.kind === "office", "office/pdf 导入 kind 正确");
    ok(/wordprocessingml/.test(docxItem.mimeType), "docx 精确 mime（抽取器匹配）");
    for (const item of [docxItem, pptxItem, xlsxItem, pdfItem]) {
      await library.indexExtractedText(item.id); // 确定性等待异步抽取索引
    }

    // 检索命中 + read 内联（含抽取标注）
    const docxHit = retrieval.search("task-ka", "密封圈选型");
    ok(docxHit.hits.some((h) => h.itemId === docxItem.id), "FTS: docx 正文可检索");
    const docxRead = await retrieval.read("task-ka", docxItem.id);
    ok(
      !docxRead.requiresFileAccess && docxRead.content.includes("密封圈选型 DOCX 文档内容乙腈") && docxRead.content.includes("office 抽取文本"),
      "read: docx 抽取文本内联（非原始排版标注）",
    );
    const pptxRead = await retrieval.read("task-ka", pptxItem.id);
    ok(pptxRead.content.includes("PPTX 演示内容乙腈方案"), "read: pptx 抽取文本");
    const xlsxRead = await retrieval.read("task-ka", xlsxItem.id);
    ok(xlsxRead.content.includes("氯丁橡胶") && xlsxRead.content.includes("乙腈介质"), "read: xlsx 抽取文本");
    const pdfRead = await retrieval.read("task-ka", pdfItem.id);
    ok(!pdfRead.requiresFileAccess && pdfRead.content.includes("sealplan2026 pdf extraction text"), "read: pdf（pdfjs）抽取文本");
    const pdfSearch = retrieval.search("task-ka", "sealplan2026");
    ok(pdfSearch.hits.some((h) => h.itemId === pdfItem.id), "FTS: pdf 正文可检索");

    // 跨项目隔离：B 任务搜不到 A 的 office 文档
    const officeB = retrieval.search("task-kb", "密封圈选型");
    ok(!officeB.hits.some((h) => h.itemId === docxItem.id), "B: office 文档不可检索");
    let officeCross = "";
    try {
      await retrieval.read("task-kb", docxItem.id);
    } catch (e) {
      officeCross = (e as Error).message;
    }
    ok(officeCross.includes("可见范围"), "B: office 文档不可读（跨项目）");

    // 损坏样例：截断 docx / 加密 zip / 损坏 pdf
    const corruptFile = join(offDir, "corrupt.docx");
    writeFileSync(corruptFile, (docxBuf as unknown as Uint8Array).slice(0, 30));
    const corruptItem = library.importFile({ spaceId: aSpace.id, sourcePath: corruptFile });
    await library.indexExtractedText(corruptItem.id);
    ok((await retrieval.getExtractionStatus(corruptItem)).status !== "extracted", "损坏 docx → 抽取失败（降级）");
    const corruptRead = await retrieval.read("task-ka", corruptItem.id);
    ok(corruptRead.requiresFileAccess === true && corruptRead.content === "", "损坏 docx read 降级 requiresFileAccess");
    const corruptPdfFile = join(offDir, "corrupt.pdf");
    writeFileSync(corruptPdfFile, Buffer.from("%PDF-1.4 broken truncated"));
    const corruptPdf = library.importFile({ spaceId: aSpace.id, sourcePath: corruptPdfFile });
    await library.indexExtractedText(corruptPdf.id);
    ok((await retrieval.getExtractionStatus(corruptPdf)).status !== "extracted", "损坏 pdf → 抽取失败（降级）");

    // 加密 zip（传统弱加密）：jszip 透明处理（无密码可读），抽取正常即可；无需特殊降级
    const encZip = new JSZip();
    encZip.file("word/document.xml", "<w:document><w:body><w:p><w:r><w:t>机密加密文档内容</w:t></w:r></w:p></w:body></w:document>");
    const encBuf = await encZip.generateAsync({ type: "nodebuffer", password: "secret123" });
    const encFile = join(offDir, "enc.docx");
    writeFileSync(encFile, encBuf as unknown as Uint8Array);
    const encItem = library.importFile({ spaceId: aSpace.id, sourcePath: encFile });
    await library.indexExtractedText(encItem.id);
    const encStatus = await retrieval.getExtractionStatus(encItem);
    ok(encStatus.status === "extracted", "加密 docx（传统弱加密）jszip 透明抽取正常");
    const encRead = await retrieval.read("task-ka", encItem.id);
    ok(!encRead.requiresFileAccess && encRead.content.includes("机密加密文档内容"), "加密 docx read 正常（jszip 透明处理）");

    // zip bomb：高压缩比条目（解压总量超限拒绝）
    const bombBuf = await makeZip(
      {
        "word/document.xml": Buffer.alloc(80 * 1024 * 1024, 0x61), // 80MB 解压后（输入约 80KB）
      },
    );
    const bombFile = join(offDir, "bomb.docx");
    writeFileSync(bombFile, bombBuf as unknown as Uint8Array);
    const bombItem = library.importFile({ spaceId: aSpace.id, sourcePath: bombFile });
    await library.indexExtractedText(bombItem.id);
    const bombStatus = await retrieval.getExtractionStatus(bombItem);
    ok(bombStatus.status !== "extracted", `zip bomb 被拒（${bombStatus.error ?? "uncompressed 超限"}）`);

    // 输出超限：大文本 docx → 200KB 预算截断标记
    const bigText = "字".repeat(300 * 1024);
    const bigBuf = await makeZip(
      {
        "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>${bigText}</w:t></w:r></w:p></w:body></w:document>`,
      },
    );
    const bigFile = join(offDir, "big.docx");
    writeFileSync(bigFile, bigBuf as unknown as Uint8Array);
    const bigItem = library.importFile({ spaceId: aSpace.id, sourcePath: bigFile });
    await library.indexExtractedText(bigItem.id);
    const bigStatus = await retrieval.getExtractionStatus(bigItem);
    ok(bigStatus.status === "extracted" && bigStatus.truncated === true, "大文本 docx → extracted + truncated（200KB 预算）");

    // 更新重索引：saveArtifact 刷新副本后 FTS 跟随新内容
    const artDir2 = join(root, "office-art");
    mkdirSync(artDir2, { recursive: true });
    const artDocx = join(artDir2, "报告.docx");
    writeFileSync(artDocx, docxBuf as unknown as Uint8Array);
    db.connection
      .prepare(
        `INSERT INTO artifacts (id, task_id, kind, source_type, entry_file, root_dir, version, capabilities_json, title, mime_type, created_at, updated_at)
         VALUES ('art-office', 'task-ka', 'office', 'workspace-file', ?, ?, 1, '{}', '报告', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 1, 1)`,
      )
      .run(artDocx, artDir2);
    const savedOffice = library.saveArtifact({ artifactId: "art-office", spaceId: aSpace.id });
    await library.indexExtractedText(savedOffice.id);
    ok(retrieval.search("task-ka", "密封圈选型 DOCX 文档内容乙腈").hits.some((h) => h.itemId === savedOffice.id), "saveArtifact docx 可检索");
    // 改写源文件 → 重新保存 → 副本与索引更新（不返回陈旧索引）
    const v2Buf = await makeZip(
      {
        "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>更新后的 V2 文档新术语</w:t></w:r></w:p></w:body></w:document>`,
      },
    );
    writeFileSync(artDocx, v2Buf as unknown as Uint8Array);
    const refreshed = library.saveArtifact({ artifactId: "art-office", spaceId: aSpace.id });
    await library.indexExtractedText(refreshed.id);
    ok(retrieval.search("task-ka", "更新后的 V2 文档新术语").hits.some((h) => h.itemId === refreshed.id), "更新后 FTS 不陈旧（新术语可检索）");
    ok(!retrieval.search("task-ka", "密封圈选型 DOCX 文档内容乙腈").hits.some((h) => h.itemId === refreshed.id), "更新后旧术语不再命中（旧索引已清）");

    // 删除：office 条目删除后检索不悬空
    library.deleteItem(docxItem.id);
    ok(!retrieval.search("task-ka", "密封圈选型").hits.some((h) => h.itemId === docxItem.id), "删除后 office 检索不悬空");

    // junction 守卫：office 受管文件被替换为 junction → 抽取拒绝（不读库外）
    const jOff = join(root, "office-outside");
    mkdirSync(jOff, { recursive: true });
    writeFileSync(join(jOff, "secret.txt"), "库外机密");
    const officeGuardItem = library.importFile({ spaceId: aSpace.id, sourcePath: docxFile });
    const officeGuardPath = library.absolutePath(officeGuardItem);
    require("node:fs").rmSync(officeGuardPath, { force: true });
    let officeLinked = false;
    try {
      require("node:fs").symlinkSync(jOff, officeGuardPath, "junction");
      officeLinked = true;
    } catch {
      /* 环境不支持 junction → 跳过 */
    }
    if (officeLinked) {
      ok(
        (await retrieval.getExtractionStatus(officeGuardItem)).status === "unsupported",
        "office junction 路径不读取（守卫生效）",
      );
      require("node:fs").rmSync(officeGuardPath, { force: true });
    }
    // 收敛：等待全部 fire-and-forget 抽取完成（避免与关库竞态）
    await library.flushPendingIndexes();

    // 16. 启动恢复：pending/error/缺 FTS 的 office 条目重新入队；unsupported 不再重试
    const recItem = library.importFile({ spaceId: aSpace.id, sourcePath: docxFile });
    // 模拟中断：status=pending 且无 FTS 行
    db.connection
      .prepare(`UPDATE library_items SET extract_status = 'pending' WHERE id = ?`)
      .run(recItem.id);
    db.connection.prepare(`DELETE FROM library_fts WHERE item_id = ?`).run(recItem.id);
    const recovered = await library.recoverPendingExtractions();
    ok(recovered >= 1, `启动恢复入队 ${recovered} 条`);
    await library.flushPendingIndexes();
    const recStatus = await retrieval.getExtractionStatus(recItem);
    ok(recStatus.status === "extracted", "恢复后抽取完成（pending → extracted）");
    ok(
      retrieval.search("task-ka", "密封圈选型 DOCX 文档内容乙腈").hits.some((h) => h.itemId === recItem.id),
      "恢复后 FTS 可检索（重启自愈）",
    );
    // 已 extracted 但 FTS 行缺失 → 恢复补索引
    const ftsMissing = library.importFile({ spaceId: aSpace.id, sourcePath: pptxFile });
    await library.indexExtractedText(ftsMissing.id);
    db.connection.prepare(`DELETE FROM library_fts WHERE item_id = ?`).run(ftsMissing.id);
    await library.recoverPendingExtractions();
    await library.flushPendingIndexes();
    ok(
      retrieval.search("task-ka", "PPTX 演示内容乙腈方案").hits.some((h) => h.itemId === ftsMissing.id),
      "extracted 但缺 FTS → 恢复补索引",
    );
    // unsupported 条目不被重复入队（不无限重试损坏文档）
    const unsupCount = db.connection
      .prepare(`SELECT COUNT(*) AS n FROM library_items WHERE kind IN ('office','pdf') AND extract_status = 'unsupported'`)
      .get() as { n: number };
    ok(unsupCount.n >= 1, "存在 unsupported 条目（损坏样例）");
    const before = db.connection
      .prepare(`SELECT COUNT(*) AS n FROM library_items WHERE kind IN ('office','pdf') AND (extract_status IS NULL OR extract_status = 'pending')`)
      .get() as { n: number };
    ok(before.n === 0, "恢复后无遗留瞬时态 NULL/pending（error 为合法终态，损坏文档每次启动重试一次）");

    // 17. readable 状态语义：损坏 office 命中 readable=false（模型不得误以为可内联）
    const corruptHit = retrieval.search("task-ka", "corrupt");
    const corruptHitItem = corruptHit.hits.find((h) => h.itemId === corruptItem.id);
    ok(corruptHitItem === undefined || corruptHitItem.readable === false, "损坏 office 命中 readable=false");

    // 18. 并发读取去重 smoke：同一条目并行 read 结果一致且不崩溃
    const [r1, r2] = await Promise.all([
      retrieval.read("task-ka", ftsMissing.id),
      retrieval.read("task-ka", ftsMissing.id),
    ]);
    ok(r1.content === r2.content && r1.requiresFileAccess === r2.requiresFileAccess, "并发 read 结果一致（in-flight 去重）");
  }

  const beforeRebind = retrieval.search("task-ka", "财务机密");
  ok(!beforeRebind.hits.some((h) => h.title.includes("B财务")), "改绑前 A 任务搜不到 B 资料");
  db.upsertTask({ id: "task-ka", title: "A任务", updatedAt: 3, projectId: "proj-b", welcomeMode: "coding" });
  const afterRebind = retrieval.search("task-ka", "财务机密");
  ok(afterRebind.projectId === "proj-b", "改绑后 scope 跟随新项目");
  ok(afterRebind.hits.some((h) => h.title.includes("B财务")), "改绑后 B 资料可检索");
  db.upsertTask({ id: "task-ka", title: "A任务", updatedAt: 4, projectId: "proj-a", welcomeMode: "coding" });

  })().then(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
    if (process.exitCode) {
      console.error("project-knowledge-test: FAILED");
    } else {
      console.log(`project-knowledge-test: PASS (${passed})`);
    }
  });
  });







