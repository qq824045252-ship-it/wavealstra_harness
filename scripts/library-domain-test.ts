/**
 * 资料库域测试（current schema）：schema、个人空间引导文、集合/条目 CRUD、URL、收藏、
 * 内容搜索、版本快照、任务引用、产物保存（provenance/幂等/大小上限）、
 * 二进制门禁、项目删除级联、任务删除清理、集合递归删除/跨项目移动拒绝、
 * symlink/junction 逃逸拒绝、原子写、旧 schema current-only 重建策略。
 */
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase, CURRENT_DATABASE_SCHEMA_VERSION } from "../src/main/db/AppDatabase";
import { LibraryService, LIBRARY_MAX_IMPORT_BYTES } from "../src/main/library/LibraryService";
import { atomicWriteFileSync, assertManagedPathSafe } from "../src/main/library/library-file-io";
import { LIBRARY_PERSONAL_SPACE_ID } from "../src/shared/library-ipc";
import { assemblePrompt } from "../src/main/agent/PromptAssembly";
import { emptyModePolicy, type ModeProfileDto } from "../src/shared/mode-profile";

const root = mkdtempSync(join(tmpdir(), "mybuddy-library-"));
// 隔离 HOME：LibraryService 把资料库文件写到 ~/.mybuddy/library（POSIX 的 os.homedir() 读 HOME），
// 只把 SQLite 放进临时目录而不同时隔离 HOME，会把夹具文档写进真实用户资料库。
process.env.HOME = root;
process.env.USERPROFILE = root;
const db = new AppDatabase(join(root, "app.db"));
const libraryRoot = join(root, "library");
const service = new LibraryService(db, { libraryRoot });
const pendingAsyncChecks: Promise<void>[] = [];

{
  assert.equal(db.schemaVersion, CURRENT_DATABASE_SCHEMA_VERSION);
  const tables = db.connection
    .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('library_spaces','library_items','library_collections','library_versions','task_library_references')`)
    .all() as Array<{ name: string }>;
  assert.equal(tables.length, 5, `v${CURRENT_DATABASE_SCHEMA_VERSION} 应创建全部资料库表`);
  const itemCols = new Set(
    (db.connection.prepare("PRAGMA table_info(library_items)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  assert.ok(itemCols.has("collection_id") && !itemCols.has("parent_id"), "items 用 collection_id，无 parent_id");
  const itemKindSql = (db.connection.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='library_items'").get() as { sql: string }).sql;
  assert.ok(!itemKindSql.includes("'folder'"), "items kind 不再含 folder");
}

{
  const snap = service.snapshot();
  assert.ok(snap.spaces.some((s) => s.id === LIBRARY_PERSONAL_SPACE_ID && s.kind === "personal"));
  assert.ok(snap.items.some((i) => i.title === "一分钟玩转资料库" && i.kind === "markdown"));
  assert.ok(Array.isArray(snap.collections));
  assert.ok(snap.recent.length >= 1);
  assert.ok(snap.ownerName.length > 0);
  const welcome = snap.items.find((i) => i.title === "一分钟玩转资料库")!;
  const content = service.readContent(welcome.id);
  assert.match(content.content, /Markdown、CSV、HTML/);

  // 回归：引导文允许真正删除，后续 snapshot 不得因为个人空间为空而重新播种。
  service.deleteItem(welcome.id);
  const afterDelete = service.snapshot();
  assert.equal(afterDelete.items.some((i) => i.title === "一分钟玩转资料库"), false);
  assert.equal(afterDelete.recent.some((i) => i.id === welcome.id), false);
}

/* ---- 集合/条目分层 + 引用解析 ---- */
{
  const space = service.createSpace({ name: "生活工作台" });
  assert.equal(space.kind, "team");
  const folder = service.createCollection({ spaceId: space.id, name: "归档" });
  assert.equal(folder.parentId, null);
  const childFolder = service.createCollection({ spaceId: space.id, parentId: folder.id, name: "子归档" });
  assert.equal(childFolder.parentId, folder.id);
  const md = service.createItem({ spaceId: space.id, collectionId: folder.id, kind: "markdown", title: "生活工作台" });
  const csv = service.createItem({ spaceId: space.id, collectionId: folder.id, kind: "csv", title: "待买清单" });
  const html = service.createItem({ spaceId: space.id, collectionId: childFolder.id, kind: "html", title: "看板" });
  assert.equal(md.collectionId, folder.id);
  assert.equal(html.collectionId, childFolder.id);
  assert.ok(existsSync(service.absolutePath(csv)));

  service.writeContent({ id: csv.id, content: "物品,数量\n牛奶,2\n" });
  const resolved = service.resolvePreview(html.id, "待买清单.csv");
  assert.ok(resolved);
  assert.equal(resolved!.path, service.absolutePath(csv));

  assert.equal(service.resolvePreview(html.id, "../secret.csv"), null);
  assert.equal(service.resolvePreview(html.id, "a/b.csv"), null);

  // 跨项目/跨作用域移动拒绝
  db.connection
    .prepare(`INSERT INTO projects (id, name, created_at, updated_at) VALUES ('proj-other', '其它项目', 1, 1)`)
    .run();
  assert.throws(() => service.moveCollection({ id: folder.id, parentId: childFolder.id }), /子集合/);
  assert.throws(() => service.moveCollection({ id: folder.id, parentId: folder.id }), /自身/);
  const otherSpace = service.createSpace({ name: "另一个项目", projectId: "proj-other" });
  assert.throws(() => service.moveCollection({ id: folder.id, parentId: "nope" }), /不属于同一空间/);
  assert.throws(
    () => service.createItem({ spaceId: otherSpace.id, collectionId: folder.id, kind: "markdown", title: "越界" }),
    /不属于同一空间/,
  );

  const hits = service.search("待买");
  assert.ok(hits.some((h) => h.title === "待买清单"));

  service.markVisited(html.id);
  const recent = service.snapshot().recent;
  assert.equal(recent[0]?.id, html.id);

  // 集合递归删除：子集合 + 全部条目 + 受管文件
  const child = service.createItem({ spaceId: space.id, collectionId: childFolder.id, kind: "markdown", title: "旧稿" });
  const childPath = service.absolutePath(child);
  service.deleteCollection(folder.id);
  assert.equal(service.getItem(child.id), null);
  assert.equal(service.getItem(md.id), null);
  assert.ok(!existsSync(childPath), "递归删除后受管文件清理");
  const snapAfter = service.snapshot();
  assert.ok(!snapAfter.collections.some((c) => c.id === folder.id || c.id === childFolder.id));

  const src = join(root, "note.md");
  writeFileSync(src, "# imported\n");
  const imported = service.importFile({ spaceId: space.id, sourcePath: src });
  assert.equal(imported.kind, "markdown");
  assert.match(service.readContent(imported.id).content, /imported/);
  service.deleteSpace(space.id);
  assert.equal(service.snapshot().spaces.some((s) => s.id === space.id), false);
  service.deleteSpace(otherSpace.id);
}

/* ---- 项目资料作用域 ---- */
{
  db.connection
    .prepare(`INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`)
    .run("proj-1", "仪表项目", 1, 1);
  const project = service.createSpace({ name: "仪表项目资料", projectId: "proj-1" });
  assert.equal(project.projectId, "proj-1");
  assert.ok(service.listProjectSpaces("proj-1").some((s) => s.id === project.id));
  assert.throws(() => service.createSpace({ name: "幽灵项目", projectId: "proj-nope" }), /项目不存在/);
  const snap = service.snapshot();
  assert.ok(snap.spaces.some((s) => s.id === project.id && s.projectName === "仪表项目"));
  service.deleteSpace(project.id);
}

/* ---- URL + 收藏 ---- */
{
  const urlItem = service.createUrl({
    spaceId: LIBRARY_PERSONAL_SPACE_ID,
    url: "https://example.com/docs?q=1",
    title: "示例文档",
  });
  assert.equal(urlItem.kind, "url");
  assert.throws(() => service.createUrl({ spaceId: LIBRARY_PERSONAL_SPACE_ID, url: "ftp://x" }), /http/);
  const content = service.readContent(urlItem.id);
  assert.equal(content.previewUrl, urlItem.url);
  assert.throws(() => service.writeContent({ id: urlItem.id, content: "x" }), /没有可写正文|非文本/);
  assert.throws(() => service.showInFolder(urlItem.id), /没有本地文件/);
  const fav = service.favorite({ id: urlItem.id, favorite: true });
  assert.equal(fav.favorite, true);
  service.favorite({ id: urlItem.id, favorite: false });
  service.deleteItem(urlItem.id);
}

/* ---- 内容搜索 + 版本快照 ---- */
{
  const md = service.createItem({ spaceId: LIBRARY_PERSONAL_SPACE_ID, kind: "markdown", title: "内容搜索目标" });
  service.writeContent({ id: md.id, content: "# 内容搜索目标\n\n关键句：氯丁橡胶密封圈。\n" });
  assert.ok(service.search("氯丁橡胶").some((h) => h.id === md.id), "内容全文搜索命中");
  const tail = service.createItem({ spaceId: LIBRARY_PERSONAL_SPACE_ID, kind: "markdown", title: "FTS 尾部覆盖" });
  service.writeContent({ id: tail.id, content: "A".repeat(220 * 1024) + "\nTAIL-FTS-UNIQUE-220K\n" });
  assert.ok(service.search("TAIL-FTS-UNIQUE-220K").some((h) => h.id === tail.id), "FTS 覆盖 200KB 之后、256KB 上限内的正文");
  db.connection.prepare(`UPDATE library_fts SET body = substr(body, 1, ?) WHERE item_id = ?`).run(200 * 1024, tail.id);
  db.connection.prepare(`INSERT INTO library_index_state(key,value,updated_at) VALUES ('text-fts-coverage-version','1',?) ON CONFLICT(key) DO UPDATE SET value='1', updated_at=excluded.updated_at`).run(Date.now());
  const legacyService = new LibraryService(db, { libraryRoot });
  assert.ok(legacyService.search("TAIL-FTS-UNIQUE-220K").some((h) => h.id === tail.id), "重启后 v2 未完成时只扫描迁移候选，旧 200KB FTS 仍保留尾部搜索语义");
  pendingAsyncChecks.push((async () => {
    const upgraded = await legacyService.recoverTextFtsCoverageV2({ batchSize: 1 });
    assert.equal(upgraded.processed, 1, "FTS v2 只重建受影响尺寸带条目");
    assert.equal(upgraded.failed, 0);
    assert.ok(legacyService.search("TAIL-FTS-UNIQUE-220K").some((h) => h.id === tail.id), "FTS v2 升级恢复 200–256KB 历史正文覆盖");
    assert.deepEqual(await legacyService.recoverTextFtsCoverageV2({ batchSize: 1 }), { processed: 0, failed: 0 }, "FTS v2 checkpoint 后重复启动零重建");
    db.connection.prepare(`DELETE FROM library_fts WHERE item_id = ?`).run(tail.id);
    const restartedService = new LibraryService(db, { libraryRoot });
    assert.ok(restartedService.search("TAIL-FTS-UNIQUE-220K").some((h) => h.id === tail.id), "重启后缺 FTS 行只对缺失条目 targeted fallback，不漏搜正文");
    const repairedMissing = await restartedService.recoverTextFtsCoverageV2({ batchSize: 1 });
    assert.deepEqual(repairedMissing, { processed: 1, failed: 0 }, "v2 checkpoint 后仍修复新出现的缺 FTS 行");
    assert.deepEqual(await restartedService.recoverTextFtsCoverageV2({ batchSize: 1 }), { processed: 0, failed: 0 }, "缺失行修复后再次恢复零工作");
    restartedService.deleteItem(tail.id);

  })());
  assert.equal(service.search("").length, 0);
  assert.equal(service.listVersions(md.id).length, 1, "真实变更快照上一版本");
  service.writeContent({ id: md.id, content: "# 内容搜索目标\n\n更新后。\n" });
  assert.equal(service.listVersions(md.id).length, 2);
  const noop = service.writeContent({ id: md.id, content: "# 内容搜索目标\n\n更新后。\n" });
  assert.equal(service.listVersions(md.id).length, 2, "同内容写入不产生新版本");
  assert.equal(noop.contentHash, service.getItem(md.id)!.contentHash);
  service.deleteItem(md.id);
}

/* ---- TaskLibraryReference + 任务删除清理 ---- */
{
  db.connection.exec(`INSERT INTO tasks(id,title,status,updated_at) VALUES ('task-x','引用测试','pending',1),('task-del','待删除引用测试','pending',1)`);
  const md = service.createItem({ spaceId: LIBRARY_PERSONAL_SPACE_ID, kind: "markdown", title: "接力文档" });
  service.attachToTask({ itemId: md.id, taskId: "task-x" });
  service.attachToTask({ itemId: md.id, taskId: "task-x" });
  assert.equal(service.listTaskReferences("task-x").items.length, 1, "重复附加幂等");
  const ctx = service.formatTaskAttachments("task-x");
  assert.ok(ctx && ctx.includes("接力文档") && ctx.includes("已附加到本任务"));
  assert.equal(service.formatTaskAttachments("task-empty"), null);
  service.detachFromTask({ itemId: md.id, taskId: "task-x" });
  assert.equal(service.listTaskReferences("task-x").items.length, 0);
  service.attachToTask({ itemId: md.id, taskId: "task-del" });
  db.deleteTask("task-del");
  assert.equal(service.listTaskReferences("task-del").items.length, 0, "删除任务清理引用");
  service.attachToTask({ itemId: md.id, taskId: "task-x" });
  service.deleteItem(md.id);
  assert.equal(service.listTaskReferences("task-x").items.length, 0, "条目删除后引用级联清理");
}

/* ---- Artifact → 保存：provenance / 幂等 / 大小上限 / 二进制门禁 ---- */
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
  const artifactDir = join(root, "artifact-task");
  mkdirSync(artifactDir, { recursive: true });
  const artifactFile = join(artifactDir, "report.md");
  writeFileSync(artifactFile, "# 产物报告\n");
  const binFile = join(artifactDir, "drawing.pdf");
  writeFileSync(binFile, Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x01, 0x02, 0xff]));
  db.connection
    .prepare(
      `INSERT INTO artifacts (id, task_id, space_id, kind, source_type, entry_file, root_dir,
         storage_path, version, capabilities_json, title, mime_type, created_at, updated_at)
       VALUES ('art-1', 'task-art', NULL, 'markdown', 'workspace-file', ?, ?, NULL, 1, '{}', '产物报告', 'text/markdown', 1, 1),
              ('art-2', 'task-art', NULL, 'pdf', 'workspace-file', ?, ?, NULL, 1, '{}', '图纸', 'application/pdf', 1, 1)`,
    )
    .run(artifactFile, artifactDir, binFile, artifactDir);

  const saved = service.saveArtifact({ artifactId: "art-1", spaceId: LIBRARY_PERSONAL_SPACE_ID });
  assert.equal(saved.sourceType, "artifact");
  assert.equal(saved.sourceTaskId, "task-art");
  assert.equal(saved.sourceArtifactId, "art-1");
  assert.ok(existsSync(artifactFile), "原始产物文件不被移动/删除");
  const again = service.saveArtifact({ artifactId: "art-1", spaceId: LIBRARY_PERSONAL_SPACE_ID });
  assert.equal(again.id, saved.id, "同 artifact 同目标空间幂等（返回已有条目）");
  db.connection
    .prepare(`INSERT INTO projects (id, name, created_at, updated_at) VALUES ('proj-save', '产物项目', 1, 1)`)
    .run();
  const otherSpace = service.createSpace({ name: "产物落点", projectId: "proj-save" });
  const otherTarget = service.saveArtifact({ artifactId: "art-1", spaceId: otherSpace.id });
  assert.notEqual(otherTarget.id, saved.id, "不同目标空间允许另存");
  service.deleteSpace(otherSpace.id);

  // 二进制门禁：readContent 不得 utf8 直读
  const bin = service.saveArtifact({ artifactId: "art-2", spaceId: LIBRARY_PERSONAL_SPACE_ID });
  const binContent = service.readContent(bin.id);
  assert.equal(binContent.requiresFileAccess, true);
  assert.equal(binContent.content, "");
  assert.ok(binContent.managedPath && existsSync(binContent.managedPath!));
  assert.throws(() => service.writeContent({ id: bin.id, content: "x" }), /非文本/);

  // 大小上限
  const huge = join(root, "huge.bin");
  const fd = require("node:fs").openSync(huge, "w");
  require("node:fs").ftruncateSync(fd, LIBRARY_MAX_IMPORT_BYTES + 1);
  require("node:fs").closeSync(fd);
  assert.throws(() => service.importFile({ spaceId: LIBRARY_PERSONAL_SPACE_ID, sourcePath: huge }), /过大/);

  service.deleteItem(saved.id);
  service.deleteItem(bin.id);
}

/* ---- 项目删除：级联清理项目资料（personal 不受影响） ---- */
{
  db.connection.prepare(`INSERT INTO projects (id, name, created_at, updated_at) VALUES ('proj-del', '待删项目', 1, 1)`).run();
  db.connection.prepare(`INSERT INTO tasks(id,title,status,updated_at,project_id) VALUES ('task-proj-del','项目资料删除测试','pending',1,'proj-del')`).run();
  const space = service.createSpace({ name: "待删资料", projectId: "proj-del" });
  const folder = service.createCollection({ spaceId: space.id, name: "归档" });
  const item = service.createItem({ spaceId: space.id, collectionId: folder.id, kind: "markdown", title: "项目文档" });
  const itemPath = service.absolutePath(item);
  service.attachToTask({ itemId: item.id, taskId: "task-proj-del" });
  service.deleteProjectLibrary("proj-del");
  assert.equal(service.snapshot().spaces.some((s) => s.id === space.id), false, "项目资料空间被删除");
  assert.equal(service.getItem(item.id), null);
  assert.ok(!existsSync(itemPath), "项目受管文件被清理");
  assert.equal(service.listTaskReferences("task-proj-del").items.length, 0, "项目条目引用级联清理");
  assert.ok(service.snapshot().spaces.some((s) => s.id === LIBRARY_PERSONAL_SPACE_ID), "personal 不受影响");
}

/* ---- symlink/junction 逃逸拒绝 ---- */
{
  const outside = join(root, "outside-secret");
  mkdirSync(outside, { recursive: true });
  writeFileSync(join(outside, "secret.md"), "secret");
  const md = service.createItem({ spaceId: LIBRARY_PERSONAL_SPACE_ID, kind: "markdown", title: "symlink 目标" });
  const targetPath = service.absolutePath(md);
  // 用真实文件顶替受管文件位置，再把库内路径换成指向库外的 junction/symlink
  writeFileSync(targetPath, "normal");
  rmSync(targetPath, { force: true });
  let linked = false;
  try {
    symlinkSync(outside, targetPath, "junction");
    linked = true;
  } catch {
    /* 环境不支持 junction/symlink → 跳过 */
  }
  if (linked) {
    assert.throws(() => service.readContent(md.id), /符号链接|junction/, "读取拒绝 symlink 逃逸");
    const leaked = service.search("secret");
    assert.ok(!leaked.some((row) => row.id === md.id), "搜索跳过 symlink 文件，不泄露库外内容");
    rmSync(targetPath, { force: true });
  }
  service.deleteItem(md.id);
}

/* ---- 写路径守卫：空间目录被 junction 替换 → create/import/saveArtifact/write 拒绝，库外零新文件 ---- */
{
  const outside = join(root, "outside-write");
  mkdirSync(outside, { recursive: true });
  db.connection
    .prepare(`INSERT INTO projects (id, name, created_at, updated_at) VALUES ('proj-junc', 'junction项目', 1, 1)`)
    .run();
  const space = service.createSpace({ name: "junction资料", projectId: "proj-junc" });
  const victim = service.createItem({ spaceId: space.id, kind: "markdown", title: "受害文档" });
  const spaceDir = join(libraryRoot, space.id);
  const outsideCount = (): number => readdirSync(outside).length;
  rmSync(spaceDir, { recursive: true, force: true });
  let linked = false;
  try {
    symlinkSync(outside, spaceDir, "junction");
    linked = true;
  } catch {
    /* 环境不支持 junction → 跳过 */
  }
  if (linked) {
    console.log("  [library-domain] junction 写路径守卫分支已执行（本机支持 junction）");
    const before = outsideCount();
    assert.throws(
      () => service.createItem({ spaceId: space.id, kind: "markdown", title: "越界新建" }),
      /符号链接|junction/,
      "createItem 拒绝 junction 空间目录",
    );
    assert.throws(
      () => service.writeContent({ id: victim.id, content: "越界写入" }),
      /符号链接|junction/,
      "writeContent 拒绝 junction 空间目录",
    );
    const src2 = join(root, "note2.md");
    writeFileSync(src2, "import");
    assert.throws(
      () => service.importFile({ spaceId: space.id, sourcePath: src2 }),
      /符号链接|junction/,
      "importFile 拒绝 junction 空间目录",
    );
    assert.throws(
      () => service.saveArtifact({ artifactId: "art-1", spaceId: space.id }),
      /符号链接|junction/,
      "saveArtifact 拒绝 junction 空间目录",
    );
    assert.equal(outsideCount(), before, "库外目录无任何新文件（写入被完整拦截）");
    rmSync(spaceDir, { force: true });
  }
  service.deleteSpace(space.id);
}

/* ---- 原子写 helper（成功 + 失败路径） ---- */
{
  const target = join(root, "atomic", "doc.md");
  atomicWriteFileSync(target, "v1");
  assert.equal(require("node:fs").readFileSync(target, "utf8"), "v1");
  atomicWriteFileSync(target, "v2");
  assert.equal(require("node:fs").readFileSync(target, "utf8"), "v2", "覆盖写原子完成");
  const leftovers = require("node:fs")
    .readdirSync(join(root, "atomic"))
    .filter((f: string) => f.includes(".tmp-"));
  assert.equal(leftovers.length, 0, "无 tmp 残留");
  assert.throws(
    () => atomicWriteFileSync(join(root, "atomic", "doc.md", "x.md"), "x"),
    /ENOTDIR|EEXIST|ENOENT/,
    "目标父路径是文件应抛错且清理 tmp",
  );

  // 路径边界
  assert.throws(() => assertManagedPathSafe(libraryRoot, join(root, "outside-secret", "secret.md")), /越界/);
}

/* ---- catalog 限域 + 装配段 ---- */
{
  db.connection.prepare(`INSERT INTO projects (id, name, created_at, updated_at) VALUES ('proj-cat', '目录项目', 1, 1)`).run();
  const space = service.createSpace({ name: "目录项目资料", projectId: "proj-cat" });
  service.createItem({ spaceId: space.id, kind: "markdown", title: "项目机密文档" });
  service.createItem({ spaceId: LIBRARY_PERSONAL_SPACE_ID, kind: "markdown", title: "个人文档甲" });
  const catPersonal = service.formatCatalog(36, { projectId: null });
  assert.ok(catPersonal.includes("个人文档甲"));
  assert.ok(!catPersonal.includes("项目机密文档"), "未绑定任务不注入项目资料");
  const catProject = service.formatCatalog(36, { projectId: "proj-cat" });
  assert.ok(catProject.includes("个人文档甲") && catProject.includes("项目机密文档"), "绑定项目可见 personal + 本项目");
  const catOther = service.formatCatalog(36, { projectId: "proj-1" });
  assert.ok(!catOther.includes("项目机密文档"), "其他项目不可见");
  service.deleteSpace(space.id);

  const profile: ModeProfileDto = {
    id: "working",
    labelZh: "日常办公",
    version: "1",
    blocks: [],
    policy: emptyModePolicy(),
    hasUserOverride: false,
    totalChars: 0,
    userDir: "",
    policyPath: "",
  };
  const trace = assemblePrompt({
    welcomeMode: "working",
    profile,
    soul: { name: "测", alias: "你", persona: "助手" },
    permissionMode: "default",
    platform: "win32",
    memoryEnabled: false,
    libraryCatalog: catPersonal,
    libraryAttachments: service.formatTaskAttachments("task-x"),
  });
  assert.ok(trace.segments.some((s) => s.id === "library" && s.content.includes("资料库")));
}

/* ---- 旧 schema 策略：current-only，v6 整库重建，不再执行 folder→collection 原地迁移 ---- */
{
  const legacyPath = join(root, "legacy-v6.db");
  const raw = new (require("better-sqlite3") as typeof import("better-sqlite3"))(legacyPath);
  raw.exec(`
    CREATE TABLE library_spaces (
      id TEXT PRIMARY KEY, name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('personal', 'team')),
      project_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE library_items (
      id TEXT PRIMARY KEY, space_id TEXT NOT NULL, parent_id TEXT,
      kind TEXT NOT NULL CHECK (kind IN ('folder','markdown','html','csv','office','pdf','image','file','url')),
      title TEXT NOT NULL, filename TEXT NOT NULL, mime_type TEXT NOT NULL DEFAULT '',
      size_bytes INTEGER NOT NULL DEFAULT 0, owner TEXT NOT NULL DEFAULT '',
      favorite INTEGER NOT NULL DEFAULT 0, url TEXT,
      source_type TEXT NOT NULL DEFAULT 'created', source_task_id TEXT, source_artifact_id TEXT,
      original_path TEXT, content_hash TEXT, extract_status TEXT,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, last_visited_at INTEGER,
      FOREIGN KEY (space_id) REFERENCES library_spaces(id) ON DELETE CASCADE,
      FOREIGN KEY (parent_id) REFERENCES library_items(id) ON DELETE CASCADE
    );
    INSERT INTO library_spaces (id, name, kind, created_at, updated_at) VALUES ('personal', '我的文档', 'personal', 1, 1);
    INSERT INTO library_items (id, space_id, parent_id, kind, title, filename, created_at, updated_at)
      VALUES ('folder-a', 'personal', NULL, 'folder', '归档', '归档', 1, 1),
             ('item-1', 'personal', 'folder-a', 'markdown', '老文档', '老文档.md', 1, 1);
    PRAGMA user_version = 6;
  `);
  raw.close();

  const up = new AppDatabase(legacyPath);
  const upService = new LibraryService(up, { libraryRoot: join(root, "legacy-library-files") });
  assert.equal(up.schemaVersion, CURRENT_DATABASE_SCHEMA_VERSION, "旧 v6 schema 重建为 current schema");
  const cols = new Set(
    (up.connection.prepare("PRAGMA table_info(library_items)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  assert.ok(cols.has("collection_id") && !cols.has("parent_id"), "重建后只保留 current collection_id 契约");
  assert.equal(upService.getItem("folder-a"), null, "旧 folder 行不会伪装成已迁移 collection");
  assert.equal(upService.getItem("item-1"), null, "不兼容旧库数据按 current-only 策略清空");
  up.close();

  const again = new AppDatabase(legacyPath);
  assert.equal(again.schemaVersion, CURRENT_DATABASE_SCHEMA_VERSION, "current schema 二次启动保持稳定");
  again.close();
}

// 收敛：等待写入触发的异步抽取完成后再关库（避免与关库竞态）
void Promise.all([service.flushPendingIndexes(), ...pendingAsyncChecks]).then(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
  console.log("library-domain-test: ok");
});

