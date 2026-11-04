/**
 * Knowledge Lifecycle 集成测试（端到端链，无 Electron UI）：
 * Agent 写回 → FTS 索引 → project_knowledge 检索/读取 → Memory evidence → prompt assembly
 * → 更新（FTS 新旧切换 + evidence 仍指向同 item）→ 删除（retrieval 不悬空 + evidence missing）
 * → 负向跨项目全链路 → 改绑/解绑 scope 刷新 → readonly/归档门禁 → 重启恢复。
 * 真实 SQLite + 真实 service/repository/resolver/retrieval + 扩展 execute 直调 + 真实装配。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSZip from "jszip";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { MemoryService } from "../src/main/memory/MemoryService";
import { LibraryService } from "../src/main/library/LibraryService";
import { createLibraryExtension } from "../src/main/library/library-extension";
import { createProjectMemoryExtension } from "../src/main/project/project-memory-extension";
import { createProjectContextExtension } from "../src/main/project/project-context-extension";
import { createProjectKnowledgeExtension } from "../src/main/project/project-knowledge-extension";
import { ProjectKnowledgeRetrieval } from "../src/main/project/ProjectKnowledgeRetrieval";
import { ProjectRepository } from "../src/main/project/ProjectRepository";
import { ProjectService } from "../src/main/project/ProjectService";
import { ProjectContextResolver } from "../src/main/project/ProjectContextResolver";
import { assemblePrompt } from "../src/main/agent/PromptAssembly";
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

interface Tool {
  name: string;
  execute: (t: string, p: never) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
    details?: unknown;
  }>;
}

function registerExtension(
  factory: (api: ExtensionAPI) => void,
  map: Map<string, Tool>,
): void {
  const api = {
    registerTool: (tool: never) => {
      const t = tool as unknown as Tool;
      map.set(t.name, t);
    },
    on: () => undefined,
  } as unknown as ExtensionAPI;
  factory(api);
}

const root = mkdtempSync(join(tmpdir(), "mybuddy-lifecycle-"));
// 隔离 HOME：LibraryService 把资料库文件写到 ~/.mybuddy/library（POSIX 的 os.homedir() 读 HOME），
// 只把 SQLite 放进临时目录而不同时隔离 HOME，会把夹具文档写进真实用户资料库。
process.env.HOME = root;
process.env.USERPROFILE = root;
const dbPath = join(root, "app.db");
const libraryRoot = join(root, "lib");
const db = new AppDatabase(dbPath);
const memory = new MemoryService(db, { semantic: false });
const library = new LibraryService(db, { libraryRoot });
const projects = new ProjectService(new ProjectRepository(db.connection), memory);
const resolver = new ProjectContextResolver(db, new ProjectRepository(db.connection), memory);
const retrieval = new ProjectKnowledgeRetrieval(db, library, projects);

for (const [pid, name] of [["proj-a", "项目A"], ["proj-b", "项目B"]] as const) {
  db.connection.prepare(`INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(pid, name, 1, 1);
}
const aSpace = library.createSpace({ name: "A资料", projectId: "proj-a" }).id;
const bSpace = library.createSpace({ name: "B资料", projectId: "proj-b" }).id;
const aColl = library.createCollection({ spaceId: aSpace, name: "A沉淀夹" });
db.connection
  .prepare(`INSERT INTO tasks (id, title, updated_at, project_id) VALUES ('task-a', 'A任务', 1, 'proj-a'), ('task-b', 'B任务', 1, 'proj-b'), ('task-none', '无项目', 1, NULL)`)
  .run();

// 工具面（A 任务）
const libA = new Map<string, Tool>();
registerExtension(createLibraryExtension({ service: library, taskId: "task-a", resolveProjectId: () => "proj-a" }), libA);
const memA = new Map<string, Tool>();
registerExtension(
  createProjectMemoryExtension({
    taskId: "task-a",
    resolveProjectId: () => "proj-a",
    service: projects,
    getPermissionMode: () => "default" as never,
  }),
  memA,
);
const ctxA = new Map<string, Tool>();
registerExtension(
  createProjectContextExtension({
    taskId: "task-a",
    resolveProjectId: () => "proj-a",
    projectService: projects,
    getPermissionMode: () => "default" as never,
  }),
  ctxA,
);
const knowA = new Map<string, Tool>();
registerExtension(createProjectKnowledgeExtension({ taskId: "task-a", retrieval }), knowA);

const call = async (tools: Map<string, Tool>, name: string, params: Record<string, unknown> = {}) =>
  tools.get(name)!.execute("tc", params as never);

async function main(): Promise<void> {
  /* 1. Agent 写回 Project Library */
  const created = await call(libA, "library_create_text", {
    kind: "markdown",
    title: "生命周期沉淀文档",
    content: "# 生命周期沉淀文档\n\n关键术语密封圈乙腈选型结论。\n",
    spaceId: aSpace,
    collectionId: aColl.id,
  });
  ok(created.isError === undefined, "1. Agent create_text 写回 A 项目资料");
  const createdId = (created.details as { item: { id: string } }).item.id;

  // save_artifact（本任务产物）
  mkdirSync(join(root, "life-art"), { recursive: true });
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
  const zip = new JSZip();
  zip.file("word/document.xml", '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>生命周期产物文档乙腈</w:t></w:r></w:p></w:body></w:document>');
  const docxBuf = await zip.generateAsync({ type: "nodebuffer" });
  const artFile = join(root, "life-art", "产物.docx");
  writeFileSync(artFile, docxBuf as unknown as Uint8Array);
  db.connection
    .prepare(
      `INSERT INTO artifacts (id, task_id, kind, source_type, entry_file, root_dir, version, capabilities_json, title, mime_type, created_at, updated_at)
       VALUES ('life-art', 'task-a', 'office', 'workspace-file', ?, ?, 1, '{}', '生命周期产物', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', 1, 1)`,
    )
    .run(artFile, join(root, "life-art"));
  const saved = await call(libA, "library_save_artifact", { artifactId: "life-art", spaceId: aSpace });
  ok(saved.isError === undefined, "1b. Agent save_artifact 晋升产物到 A 项目资料");
  const savedId = (saved.details as { item: { id: string } }).item.id;
  await library.indexExtractedText(savedId);

  /* 2. 索引收敛后可立即检索/读取 */
  const hit1 = await call(knowA, "project_knowledge_search", { query: "密封圈乙腈选型结论" });
  ok(hit1.isError === undefined && hit1.content[0].text.includes("生命周期沉淀文档"), "2. 新建文本立即可检索");
  const read1 = await call(knowA, "project_knowledge_read", { id: createdId });
  ok(read1.isError === undefined && read1.content[0].text.includes("关键术语密封圈乙腈选型结论"), "2b. 新建文本可读取");
  const hitArt = await call(knowA, "project_knowledge_search", { query: "生命周期产物文档乙腈" });
  ok(hitArt.isError === undefined && hitArt.content[0].text.includes("生命周期产物"), "2c. office 产物抽取后立即可检索");

  /* 3. 命中 item → Memory evidence；Project 装配不重复注入 Memory */
  const mem = await call(memA, "project_memory_create", {
    kind: "decision",
    title: "密封圈选型决策",
    content: "选定乙腈介质密封圈方案（见沉淀文档与产物）。",
    evidenceItemIds: [createdId, savedId],
  });
  ok(mem.isError === undefined, "3. 命中 item 写入 Memory evidence");
  const memId = (mem.details as { item: { id: string } }).item.id;
  const memoryItem = projects.getMemory("proj-a", memId)!;
  ok(memoryItem.evidence.some((e) => e.refId === createdId) && memoryItem.evidence.some((e) => e.refId === savedId), "3b. evidence 结构化关联两条目");
  // pin 产物到项目上下文（顺带接入 pin 链路）
  const pin = await call(ctxA, "project_context_pin", { itemId: savedId });
  ok(pin.isError === undefined, "3b2. Agent pin 产物到项目上下文");
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
  const ctx = resolver.resolveTask("task-a")!;
  const trace = assemblePrompt({
    welcomeMode: "coding",
    profile,
    soul: { name: "测", alias: "你", persona: "助手" },
    permissionMode: "default",
    platform: "win32",
    memoryEnabled: false,
    projectContext: ctx,
  });
  const memSeg = trace.segments.find((s) => s.id === "projectMemory");
  ok(memSeg === undefined, "3c. Project prompt 不重复注入 Memory（统一 Kernel 由独立装配链负责）");
  const pinnedSeg = trace.segments.find((s) => s.id === "projectPinnedRefs");
  ok(pinnedSeg !== undefined && pinnedSeg.content.includes("生命周期产物"), "3d. 装配注入 pinned 引用段（含刚 pin 的产物）");

  /* 4. 更新：FTS 新旧切换 + evidence 仍指向同 item */
  const updated = await call(libA, "library_update_text", { id: createdId, content: "# 生命周期沉淀文档 v2\n\n新术语氟橡胶密封圈结论。\n" });
  ok(updated.isError === undefined, "4. Agent update_text 更新正文");
  const newHit = await call(knowA, "project_knowledge_search", { query: "氟橡胶密封圈结论" });
  ok(newHit.content[0].text.includes("生命周期沉淀文档"), "4b. 新词可检索");
  const oldHit = await call(knowA, "project_knowledge_search", { query: "密封圈乙腈选型结论" });
  ok(!oldHit.content[0].text.includes("生命周期沉淀文档"), "4c. 旧词不再命中（FTS 无残留）");
  const memAfter = projects.getMemory("proj-a", memId)!;
  ok(memAfter.evidence.some((e) => e.refId === createdId), "4d. evidence 仍指向同 item（不悬空）");

  /* 5. 删除：retrieval 不悬空 + evidence missing 保留 */
  library.deleteItem(createdId);
  const afterDel = await call(knowA, "project_knowledge_search", { query: "氟橡胶密封圈结论" });
  ok(!afterDel.content[0].text.includes("生命周期沉淀文档"), "5. 删除后检索不悬空");
  const memMissing = projects.getMemory("proj-a", memId)!;
  ok(memMissing.evidence.some((e) => e.refId === createdId && e.refTitle === "生命周期沉淀文档"), "5b. evidence missing 时保留标题快照与 memory");
  ok(memMissing.evidence.some((e) => e.refId === savedId && e.refTitle !== undefined), "5c. 存活 evidence 仍解析");

  /* 6. 负向全链路：B 任务不能写/读/evidence/pin A 资源 */
  const libB = new Map<string, Tool>();
  registerExtension(createLibraryExtension({ service: library, taskId: "task-b", resolveProjectId: () => "proj-b" }), libB);
  const memB = new Map<string, Tool>();
  registerExtension(
    createProjectMemoryExtension({ taskId: "task-b", resolveProjectId: () => "proj-b", service: projects, getPermissionMode: () => "default" as never }),
    memB,
  );
  const knowB = new Map<string, Tool>();
  registerExtension(createProjectKnowledgeExtension({ taskId: "task-b", retrieval }), knowB);
  const writeB = await call(libB, "library_create_text", { kind: "markdown", title: "越界", spaceId: aSpace });
  ok(writeB.isError === true, "6. B 任务写 A 空间被拒");
  const saveB = await call(libB, "library_save_artifact", { artifactId: "life-art", spaceId: bSpace });
  ok(saveB.isError === true, "6b. B 任务不能晋升 A 任务产物");
  const searchB = await call(knowB, "project_knowledge_search", { query: "生命周期产物文档乙腈" });
  ok(!searchB.content[0].text.includes("产物.docx"), "6c. B 搜不到 A 的 office 产物");
  const evB = await call(memB, "project_memory_create", { kind: "fact", title: "越界", evidenceItemIds: [savedId] });
  ok(evB.isError === true, "6d. B 不能把 A 条目作为 evidence");
  const pinB = await call(memB, "project_memory_create", { kind: "fact", title: "越界2", evidenceItemIds: [savedId] });
  ok(pinB.isError === true, "6e. B 不能引用 A 条目（负向双确认）");

  /* 7. 改绑/解绑：scope 按当前 task 状态刷新 */
  db.upsertTask({ id: "task-a", title: "A任务", updatedAt: 2, projectId: "proj-b", welcomeMode: "coding" });
  const rebindSearch = await call(knowA, "project_knowledge_search", { query: "生命周期产物文档乙腈" });
  ok(!rebindSearch.content[0].text.includes("产物.docx"), "7. 改绑到 B 后 A 的产物不再可见");
  db.upsertTask({ id: "task-a", title: "A任务", updatedAt: 3, projectId: null, welcomeMode: "coding" });
  const unboundSearch = await call(knowA, "project_knowledge_search", { query: "生命周期产物文档乙腈" });
  ok(unboundSearch.content[0].text.includes("范围：个人资料，独立任务"), "7b. 解绑项目且无工作空间后使用个人资料");
  db.upsertTask({ id: "task-a", title: "A任务", updatedAt: 4, projectId: "proj-a", welcomeMode: "coding" });

  /* 8. readonly/归档门禁：library/context/memory/pin/attach 一致 */
  const libRo = new Map<string, Tool>();
  registerExtension(
    createLibraryExtension({ service: library, taskId: "task-a", resolveProjectId: () => "proj-a", getPermissionMode: () => "readonly" as never }),
    libRo,
  );
  const ctxRo = new Map<string, Tool>();
  registerExtension(
    createProjectContextExtension({ taskId: "task-a", resolveProjectId: () => "proj-a", projectService: projects, getPermissionMode: () => "readonly" as never }),
    ctxRo,
  );
  const memRo = new Map<string, Tool>();
  registerExtension(
    createProjectMemoryExtension({ taskId: "task-a", resolveProjectId: () => "proj-a", service: projects, getPermissionMode: () => "readonly" as never }),
    memRo,
  );
  ok((await call(libRo, "library_create_text", { kind: "markdown", title: "x" })).isError === true, "8. readonly: create_text 拒");
  ok((await call(libRo, "library_attach_to_task", { id: savedId })).isError === true, "8b. readonly: attach 拒");
  ok((await call(ctxRo, "project_context_update", { goal: "x" })).isError === true, "8c. readonly: context update 拒");
  ok((await call(ctxRo, "project_context_pin", { itemId: savedId })).isError === true, "8d. readonly: pin 拒");
  ok((await call(memRo, "project_memory_create", { kind: "fact", title: "x" })).isError === true, "8e. readonly: memory create 拒");
  projects.archive("proj-a", true);
  const archWrite = await call(libA, "library_create_text", { kind: "markdown", title: "x", spaceId: aSpace });
  ok(archWrite.isError === true && archWrite.content[0].text.includes("归档") && archWrite.content[0].text.includes("个人资料不受影响"), "8f. 归档统一文案（明确 personal 不受影响）");
  const archPersonal = await call(libA, "library_create_text", { kind: "markdown", title: "归档期笔记" });
  ok(archPersonal.isError === true, "8g. 归档项目任务的默认写入被拒，不偷偷改存个人库");
  const personalTools = new Map<string, Tool>();
  registerExtension(createLibraryExtension({ service: library, taskId: "task-none" }), personalTools);
  ok((await call(personalTools, "library_create_text", { kind: "markdown", title: "独立个人笔记" })).isError === undefined, "8g2. 其他独立个人任务仍可正常写入个人资料");
  projects.archive("proj-a", false);

  /* 8h. 服务层长度上限（渲染器/工具/IPC 任何入口不可绕过） */
  assert.throws(() => library.createItem({ spaceId: aSpace, kind: "markdown", title: "长".repeat(201) }), /标题不能超过 200/);
  assert.throws(() => library.createCollection({ spaceId: aSpace, name: "长".repeat(101) }), /集合名称不能超过 100/);
  const capText = library.createItem({ spaceId: aSpace, kind: "markdown", title: "上限文本" });
  assert.throws(() => library.writeContent({ id: capText.id, content: "x".repeat(1_000_001) }), /正文不能超过 1000000/);
  const capTitle = library.createItem({ spaceId: aSpace, kind: "markdown", title: "长".repeat(200) });
  ok(capTitle.title.length === 200, "8h2. 标题恰好 200 允许");

  /* 8i. pdfjs 噪音抑制：抽取期间已知噪音不入 console.warn，真实 warn 放行，抽取后恢复
   *  （collector 必须先于导入安装：fire-and-forget 抽取在导入时启动，过滤器叠加在 collector 之上） */
  const corruptPdfPath = join(root, "noise.pdf");
  writeFileSync(corruptPdfPath, Buffer.from("%PDF-1.4 broken truncated noise test"));
  const warns: string[] = [];
  const origWarn = console.warn;
  console.warn = (...args: unknown[]) => warns.push(args.map(String).join(" "));
  let noiseItemId = "";
  try {
    const noiseItem = library.importFile({ spaceId: aSpace, sourcePath: corruptPdfPath });
    noiseItemId = noiseItem.id;
    await library.indexExtractedText(noiseItem.id);
  } finally {
    console.warn = origWarn;
  }
  ok(
    !warns.some((w) => /Cannot access the `require` function|Cannot polyfill|Indexing all PDF objects|standardFontDataUrl/i.test(w)),
    "8i. pdfjs 已知噪音被过滤（不再污染主进程日志）",
  );
  if (warns.length > 0) console.error("DEBUG warns:", JSON.stringify(warns));
  const noiseStatus = await retrieval.getExtractionStatus(library.getItem(noiseItemId)!);
  ok(noiseStatus.status !== "extracted", "8i2. 真实解析失败仍以 error/unsupported 状态传播（不吞错误）");
  // 过滤不影响正常 warn（抽取结束后 console.warn 恢复）
  const probe: string[] = [];
  const w2 = console.warn;
  console.warn = (m?: unknown) => probe.push(String(m));
  console.warn("普通告警探针");
  console.warn = w2;
  ok(probe.includes("普通告警探针"), "8i3. 抽取结束后 console.warn 恢复正常透传");

  /* 9. 重启恢复：FTS/evidence/pins 持久，pending 恢复入队 */
  await library.flushPendingIndexes();
  db.close();
  const db2 = new AppDatabase(dbPath);
  const memory2 = new MemoryService(db2, { semantic: false });
  const lib2 = new LibraryService(db2, { libraryRoot });
  const proj2 = new ProjectService(new ProjectRepository(db2.connection), memory2);
  const retr2 = new ProjectKnowledgeRetrieval(db2, lib2, proj2);
  await lib2.recoverPendingExtractions();
  await lib2.flushPendingIndexes();
  const restartHit = retr2.search("task-a", "生命周期产物文档乙腈");
  ok(restartHit.hits.some((h) => h.itemId === savedId), "9. 重启后 FTS 仍可检索（持久化）");
  const memAfterRestart = proj2.getMemory("proj-a", memId)!;
  ok(
    memAfterRestart.evidence.some((e) => e.refId === savedId && e.refTitle !== undefined),
    "9b. 重启后 evidence 仍解析",
  );
  db2.close();
  rmSync(root, { recursive: true, force: true });
  if (process.exitCode) {
    console.error("knowledge-lifecycle-integration-test: FAILED");
  } else {
    console.log(`knowledge-lifecycle-integration-test: PASS (${passed})`);
  }
}

void main().catch((err) => {
  console.error("knowledge-lifecycle-integration-test: FAILED", err);
  process.exitCode = 1;
});


