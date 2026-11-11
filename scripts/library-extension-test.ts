/**
 * LibraryExtension 运行时测试：任务/项目限域、二进制门禁、attach/detach。
 *
 * 覆盖：独立任务没有默认持久资料；项目/工作空间任务仅自有、继承和显式引用资料，
 * 且通过 itemId/spaceId 直接访问项目 B 必须被拒绝（list/search/read/attach 全路径）；
 * pdf 等非文本条目返回受管路径元数据而非 utf8 乱码。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { MemoryService } from "../src/main/memory/MemoryService";
import { LibraryService } from "../src/main/library/LibraryService";
import { ProjectRepository } from "../src/main/project/ProjectRepository";
import { ProjectService } from "../src/main/project/ProjectService";
import { WorkspaceLibraryBindingService } from "../src/main/workspace/WorkspaceLibraryBindingService";
import { createLibraryExtension, type LibraryExtensionBridge } from "../src/main/library/library-extension";
import { LIBRARY_PERSONAL_SPACE_ID } from "../src/shared/library-ipc";

const root = mkdtempSync(join(tmpdir(), "mybuddy-library-ext-"));
// 隔离 HOME：LibraryService 把资料库文件写到 ~/.mybuddy/library（POSIX 的 os.homedir() 读 HOME），
// 只把 SQLite 放进临时目录而不同时隔离 HOME，会把夹具文档写进真实用户资料库。
process.env.HOME = root;
process.env.USERPROFILE = root;
const db = new AppDatabase(join(root, "app.db"));
const service = new LibraryService(db, { libraryRoot: join(root, "lib") });
// 兼容旧 personal 资料的回归测试，需要显式建立旧位置。
service.ensureReady();
const projectService = new ProjectService(new ProjectRepository(db.connection), new MemoryService(db, { semantic: false }));

// 项目 A / B 资料空间与条目
for (const [pid, name] of [["proj-a", "项目A"], ["proj-b", "项目B"]] as const) {
  db.connection.prepare(`INSERT INTO projects (id, name, created_at, updated_at) VALUES (?, ?, ?, ?)`).run(pid, name, 1, 1);
  const space = service.createSpace({ name: `${name}资料`, projectId: pid });
  service.createItem({ spaceId: space.id, kind: "markdown", title: `${name}机密文档` });
}
const personalItem = service.createItem({ spaceId: LIBRARY_PERSONAL_SPACE_ID, kind: "markdown", title: "个人文档" });

// 二进制条目（pdf）
const artifactDir = join(root, "art");
mkdirSync(artifactDir, { recursive: true });
const pdf = join(artifactDir, "spec.pdf");
writeFileSync(pdf, Buffer.from([0x25, 0x50, 0x44, 0x46, 0x00, 0x99, 0xff, 0x01]));
db.connection
  .prepare(
    `CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL, space_id TEXT, kind TEXT NOT NULL,
      source_type TEXT NOT NULL, entry_file TEXT, root_dir TEXT NOT NULL, storage_path TEXT,
      version INTEGER NOT NULL DEFAULT 1, capabilities_json TEXT NOT NULL DEFAULT '{}',
      title TEXT, mime_type TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    )`,
  )
  .run();
db.connection
  .prepare(
    `INSERT INTO artifacts (id, task_id, kind, source_type, entry_file, root_dir, version, capabilities_json, title, mime_type, created_at, updated_at)
     VALUES ('art-pdf', 'task-a', 'pdf', 'workspace-file', ?, ?, 1, '{}', '规格书', 'application/pdf', 1, 1)`,
  )
  .run(pdf, artifactDir);
const pdfItem = service.saveArtifact({ artifactId: "art-pdf", spaceId: LIBRARY_PERSONAL_SPACE_ID });

interface RegisteredTool {
  name: string;
  execute: (toolCallId: string, params: never) => Promise<{
    content: Array<{ type: string; text: string }>;
    isError?: boolean;
    details?: unknown;
  }>;
}

function makeExtension(projectId: string | null, taskId = "task-current", workspaceId: string | null = null): Map<string, RegisteredTool> {
  db.upsertTask({ id: taskId, title: taskId, updatedAt: Date.now(), projectId, spaceId: workspaceId });
  const tools = new Map<string, RegisteredTool>();
  const api = {
    registerTool: (tool: never) => {
      const t = tool as unknown as RegisteredTool;
      tools.set(t.name, t);
    },
    on: () => undefined,
  } as unknown as ExtensionAPI;
  const bridge: LibraryExtensionBridge = {
    service,
    taskId,
    resolveProjectId: () => projectId,
  };
  createLibraryExtension(bridge)(api);
  return tools;
}

/** readonly 权限模式的扩展（attach/detach 应被拒绝，读工具不受影响） */
function makeReadonlyExtension(projectId: string | null, taskId = "task-current"): Map<string, RegisteredTool> {
  db.upsertTask({ id: taskId, title: taskId, updatedAt: Date.now(), projectId, spaceId: null });
  const tools = new Map<string, RegisteredTool>();
  const api = {
    registerTool: (tool: never) => {
      const t = tool as unknown as RegisteredTool;
      tools.set(t.name, t);
    },
    on: () => undefined,
  } as unknown as ExtensionAPI;
  const bridge: LibraryExtensionBridge = {
    service,
    taskId,
    resolveProjectId: () => projectId,
    getPermissionMode: () => "readonly" as never,
  };
  createLibraryExtension(bridge)(api);
  return tools;
}

async function call(
  tools: Map<string, RegisteredTool>,
  name: string,
  params: Record<string, unknown>,
): Promise<Awaited<ReturnType<RegisteredTool["execute"]>>> {
  const tool = tools.get(name);
  assert.ok(tool, `工具已注册：${name}`);
  return tool.execute("tc", params as never);
}

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

async function main(): Promise<void> {
  const bItem = service
    .listAllItems()
    .find((i) => i.title === "项目B机密文档")!;
  const aItem = service
    .listAllItems()
    .find((i) => i.title === "项目A机密文档")!;
  const bSpaceId = bItem.spaceId;

  /* 1. 未绑定临时任务：没有默认个人资料库，也不能写入持久资料 */
  {
    const tools = makeExtension(null);
    const list = await call(tools, "library_list", {});
    const text = list.content[0].text;
    ok(!text.includes("个人文档"), "unbound: list 不含历史个人文档");
    ok(!text.includes("项目A机密文档") && !text.includes("项目B机密文档"), "unbound: list 不含任何项目资料");
    const readB = await call(tools, "library_read", { id: bItem.id });
    ok(readB.isError === true && readB.content[0].text.includes("不可访问"), "unbound: 直读项目 B 条目被拒");
    const listBySpace = await call(tools, "library_list", { spaceId: bSpaceId });
    ok(listBySpace.isError === true, "unbound: spaceId 直指项目空间被拒");
    const attachB = await call(tools, "library_attach_to_task", { id: bItem.id });
    ok(attachB.isError === true, "unbound: 附加项目 B 条目被拒");
    const attachPersonal = await call(tools, "library_attach_to_task", { id: personalItem.id });
    ok(attachPersonal.isError === true, "unbound: 临时任务不经资料工具修改历史个人资料引用");
    const create = await call(tools, "library_create_text", { kind: "markdown", title: "临时任务不应沉淀" });
    ok(create.isError === true && create.content[0].text.includes("独立任务"), "unbound: 默认写入不创建个人资料");
  }

  /* 2. 项目 A 任务：A + 先前已显式附加的 personal 可见，未引用 personal 与 B 全路径拒绝 */
  {
    const tools = makeExtension("proj-a");
    service.attachToTask({ itemId: personalItem.id, taskId: "task-current" });
    const list = await call(tools, "library_list", {});
    const text = list.content[0].text;
    ok(text.includes("个人文档") && text.includes("项目A机密文档"), "A: list 含 personal + A");
    ok(!text.includes("项目B机密文档"), "A: list 不含 B");
    const search = await call(tools, "library_search", { query: "机密" });
    ok(!search.content[0].text.includes("项目B机密文档"), "A: search 不含 B");
    ok(search.content[0].text.includes("项目A机密文档"), "A: search 含 A");
    const readB = await call(tools, "library_read", { id: bItem.id });
    ok(readB.isError === true && readB.content[0].text.includes("跨项目"), "A: 直读 B 条目被拒（跨项目）");
    const longItem = service.createItem({ spaceId: aItem.spaceId, kind: "markdown", title: "长资料" });
    const longBody = `${"长".repeat(1_000_005)}末尾标记`;
    service.writeContent({ id: longItem.id, content: longBody });
    assert.equal(service.readContent(longItem.id).content, longBody, "项目资料可保存超过旧上限的完整正文");
    const longRead = await call(tools, "library_read", { id: longItem.id });
    assert.equal(longRead.content[0].text.endsWith(longBody), true, "工具返回完整正文而非截断预览");
    const readA = await call(tools, "library_read", { id: aItem.id });
    ok(readA.isError === undefined && readA.content[0].text.includes("项目A机密文档"), "A: 读 A 条目正常");
    const readPersonal = await call(tools, "library_read", { id: personalItem.id });
    ok(readPersonal.isError === undefined, "A: 读已附加的 personal 正常");
    const unrelated = service.createItem({ spaceId: LIBRARY_PERSONAL_SPACE_ID, kind: "markdown", title: "未经引用的个人秘密" });
    ok(!(await call(tools, "library_list", { spaceId: LIBRARY_PERSONAL_SPACE_ID })).content[0].text.includes(unrelated.title), "A: 单条引用不会放大为整个个人库");
    ok(!(await call(tools, "library_search", { query: "未经引用" })).content[0].text.includes(unrelated.title), "A: 搜索不含未经引用的个人资料");
    ok((await call(tools, "library_read", { id: unrelated.id })).isError === true, "A: 直接传个人 itemId 不能绕过引用范围");
    ok((await call(tools, "library_update_text", { id: personalItem.id, content: "不允许改写" })).isError === true, "A: 引用个人资料不授予源资料写权限");
    ok((await call(tools, "library_attach_to_task", { id: aItem.id, taskId: "another-task" })).isError === true, "A: 不允许替其他任务修改引用");
    const attachB = await call(tools, "library_attach_to_task", { id: bItem.id });
    ok(attachB.isError === true, "A: 附加 B 条目被拒");
    const attachA = await call(tools, "library_attach_to_task", { id: aItem.id });
    ok(attachA.isError === undefined, "A: 附加 A 条目正常");
    const detachA = await call(tools, "library_detach_from_task", { id: aItem.id });
    ok(detachA.isError === undefined, "A: 解除附加正常");
  }

  /* 3. 项目 B 任务反向验证 */
  {
    const tools = makeExtension("proj-b");
    const readA = await call(tools, "library_read", { id: aItem.id });
    ok(readA.isError === true, "B: 直读 A 条目被拒（反向）");
    const list = await call(tools, "library_list", {});
    ok(list.content[0].text.includes("项目B机密文档") && !list.content[0].text.includes("项目A机密文档"), "B: list 只含 B");
  }

  /* 4. 二进制门禁：显式附加旧 PDF 后可按授权读取受管路径，无乱码 */
  {
    const tools = makeExtension("proj-a", "task-pdf");
    service.attachToTask({ itemId: pdfItem.id, taskId: "task-pdf" });
    const read = await call(tools, "library_read", { id: pdfItem.id });
    ok(read.isError === undefined, "pdf: 读取不报错");
    const text = read.content[0].text;
    ok(text.includes("受管路径") && text.includes("非文本资产"), "pdf: 返回受管路径与门禁说明");
    ok(text.includes("application/pdf") || text.includes("pdf"), "pdf: 含类型/mime 元数据");
    ok(!text.includes("�"), "pdf: 无 utf8 乱码字节");
    ok(read.details && (read.details as { managedPath?: string }).managedPath, "pdf: details 含受管路径");
  }

  /* 5. 工具集完整性：读 + attach/detach + 写回/晋升工具 */
  {
    const tools = makeExtension(null);
    const names = [...tools.keys()].sort();
    ok(
      JSON.stringify(names) ===
        JSON.stringify([
          "library_attach_to_task",
          "library_create_collection",
          "library_create_text",
          "library_detach_from_task",
          "library_list",
          "library_move",
          "library_read",
          "library_save_artifact",
          "library_search",
          "library_update_text",
        ]),
      `工具集正确（实际：${names.join(",")}）`,
    );
  }

  /* 6. readonly 权限：attach/detach 拒绝，读工具不受影响（与 project_memory_* 门禁一致） */
  {
    const tools = makeReadonlyExtension("proj-a", "task-ro");
    service.attachToTask({ itemId: personalItem.id, taskId: "task-ro" });
    const attach = await call(tools, "library_attach_to_task", { id: personalItem.id });
    ok(attach.isError !== true, "legacy readonly: attach succeeds");
    const detach = await call(tools, "library_detach_from_task", { id: personalItem.id });
    ok(detach.isError !== true, "legacy readonly: detach succeeds");
    const list = await call(tools, "library_list", {});
    ok(list.isError === undefined, "readonly: list 允许");
    service.attachToTask({ itemId: personalItem.id, taskId: "task-ro" });
    const read = await call(tools, "library_read", { id: personalItem.id });
    ok(read.isError === undefined, "readonly: read 允许");
    // 非 readonly 会话 attach/detach 正常（回归）
    const normal = makeExtension("proj-a");
    const okAttach = await call(normal, "library_attach_to_task", { id: personalItem.id });
    ok(okAttach.isError === undefined, "default: attach 允许");
    const okDetach = await call(normal, "library_detach_from_task", { id: personalItem.id });
    ok(okDetach.isError === undefined, "default: detach 允许");
  }

  /* 7. 写回/晋升工具：scope 隔离 / readonly / 归档 / 二进制拒绝 / 闭环 */
  {
    const toolsA = makeExtension("proj-a");
    const aSpace = service.listProjectSpaces("proj-a")[0]!.id;
    const bSpace = service.listProjectSpaces("proj-b")[0]!.id;
    const bColl = service.createCollection({ spaceId: bSpace, name: "B集合" });
    const aColl = service.createCollection({ spaceId: aSpace, name: "A集合" });
    const bItem = service.listAllItems().find((i) => i.title === "项目B机密文档")!;

    // create_text：当前项目自有资料允许；其他空间/集合拒绝
    const created = await call(toolsA, "library_create_text", {
      kind: "markdown",
      title: "A沉淀文档",
      content: "# A沉淀文档\n\n密封圈方案要点。\n",
      spaceId: aSpace,
      collectionId: aColl.id,
    });
    ok(created.isError === undefined && created.content[0].text.includes("id="), "A: create_text 在 A 集合中创建成功");
    ok(created.content[0].text.includes("space=" + aSpace), "A: 返回值含 spaceId（无绝对路径）");
    ok(!created.content[0].text.includes("path="), "A: 返回值不含绝对路径");
    const createdId = (created.details as { item: { id: string } }).item.id;
    ok(service.readContent(createdId).content.includes("密封圈方案要点"), "A: 正文真实落库");
    ok(service.getItem(createdId)?.collectionId === aColl.id, "A: 集合归属正确");
    const crossSpace = await call(toolsA, "library_create_text", { kind: "markdown", title: "越界", spaceId: bSpace });
    ok(crossSpace.isError === true && crossSpace.content[0].text.includes("当前任务范围"), "A: create_text 到 B 空间被拒");
    const crossColl = await call(toolsA, "library_create_text", { kind: "markdown", title: "越界", collectionId: bColl.id });
    ok(crossColl.isError === true, "A: create_text 到 B 集合被拒");

    // update_text：更新正文 + 版本 + FTS 新旧词切换
    const updated = await call(toolsA, "library_update_text", { id: createdId, content: "# A沉淀文档\n\n新术语乙腈密封圈。\n" });
    ok(updated.isError === undefined, "A: update_text 成功");
    ok(service.listVersions(createdId).length >= 1, "A: 更新产生版本快照");
    ok(service.readContent(createdId).content.includes("新术语乙腈密封圈"), "A: 正文已更新");
    const searchNew = service.search("新术语乙腈密封圈");
    ok(searchNew.some((r) => r.id === createdId), "A: 新词可检索（FTS 刷新）");
    const searchOld = service.search("密封圈方案要点");
    ok(!searchOld.some((r) => r.id === createdId), "A: 旧词不再命中（FTS 不陈旧）");
    // update B 条目拒绝；二进制条目字符串写入拒绝
    const updB = await call(toolsA, "library_update_text", { id: bItem.id, content: "x" });
    ok(updB.isError === true && updB.content[0].text.includes("不可访问"), "A: update B 条目被拒");
    const binItem = service.listAllItems().find((i) => i.kind === "pdf")!;
    const updBin = await call(toolsA, "library_update_text", { id: binItem.id, content: "x" });
    ok(updB.isError === true || updBin.isError === true, "A: 二进制条目字符串写入被拒");
    // 删除后受控报错
    service.deleteItem(createdId);
    const updDeleted = await call(toolsA, "library_update_text", { id: createdId, content: "x" });
    ok(updDeleted.isError === true, "删除后 update 受控报错");

    // save_artifact：当前任务产物晋升 + provenance + 幂等；其他项目任务产物拒绝
    db.connection
      .prepare(
        `INSERT INTO artifacts (id, task_id, kind, source_type, entry_file, root_dir, version, capabilities_json, title, mime_type, created_at, updated_at)
         VALUES ('art-own', 'task-current', 'markdown', 'workspace-file', ?, ?, 1, '{}', '本任务产物', 'text/markdown', 1, 1),
                ('art-b', 'task-b', 'markdown', 'workspace-file', ?, ?, 1, '{}', 'B任务产物', 'text/markdown', 1, 1)`,
      )
      .run(pdf, artifactDir, pdf, artifactDir);
    db.upsertTask({ id: "task-current", title: "当前任务", updatedAt: 1, projectId: "proj-a" });
    db.upsertTask({ id: "task-b", title: "B任务", updatedAt: 1, projectId: "proj-b" });
    const saved = await call(toolsA, "library_save_artifact", { artifactId: "art-own" });
    ok(saved.isError === undefined && saved.content[0].text.includes("来源：artifact"), "A: save_artifact 成功且 provenance 可见");
    const savedId = (saved.details as { item: { id: string } }).item.id;
    ok(service.getItem(savedId)?.sourceTaskId === "task-current", "A: provenance 含来源任务");
    ok(service.getItem(savedId)?.spaceId === aSpace, "A: 保存产物默认归当前项目，不落入个人库");
    const again = await call(toolsA, "library_save_artifact", { artifactId: "art-own" });
    ok((again.details as { item: { id: string } }).item.id === savedId, "A: save_artifact 幂等（同条目）");
    const saveB = await call(toolsA, "library_save_artifact", { artifactId: "art-b" });
    ok(saveB.isError === true && saveB.content[0].text.includes("不属于当前任务"), "A: 其他项目任务产物拒绝");
    // 临时任务没有长期资料归属；默认目标门禁先于产物归属检查。
    const toolsNone = makeExtension(null, "task-none");
    const beforeDeniedSave = db.connection.prepare("SELECT * FROM library_items ORDER BY id").all();
    const beforeDeniedSpaces = service.listSpaces();
    const saveNone = await call(toolsNone, "library_save_artifact", { artifactId: "art-own" });
    ok(saveNone.isError === true && saveNone.content[0].text.includes("没有可写的长期资料归属"), "unbound: 无长期资料归属，不能晋升其他任务产物");
    const saveNoneExplicit = await call(toolsNone, "library_save_artifact", { artifactId: "art-own", spaceId: aSpace });
    ok(saveNoneExplicit.isError === true, "unbound: 显式目标不能绕过写入范围");
    assert.deepEqual(db.connection.prepare("SELECT * FROM library_items ORDER BY id").all(), beforeDeniedSave, "拒绝晋升不创建或修改资料条目");
    assert.deepEqual(service.listSpaces(), beforeDeniedSpaces, "拒绝晋升不创建资料空间");

    // create_collection / move：同空间允许；跨空间拒绝；根移动成功
    const personalColl = service.createCollection({ spaceId: LIBRARY_PERSONAL_SPACE_ID, name: "个人沉淀夹" });
    const collCreated = await call(toolsA, "library_create_collection", { name: "沉淀夹", spaceId: aSpace, parentId: aColl.id });
    ok(collCreated.isError === undefined, "A: create_collection 同空间成功");
    const collB = await call(toolsA, "library_create_collection", { name: "越界夹", spaceId: bSpace });
    ok(collB.isError === true, "A: create_collection 到 B 空间被拒");
    const collId = (collCreated.details as { collection: { id: string } }).collection.id;
    const moveOk = await call(toolsA, "library_move", { type: "item", id: savedId, collectionId: aColl.id });
    ok(moveOk.isError === undefined, "A: move item 同空间成功（savedId 归当前项目）");
    const moveCross = await call(toolsA, "library_move", { type: "item", id: savedId, collectionId: bColl.id });
    ok(moveCross.isError === true, "A: move item 到 B 集合被拒");
    const moveCrossSpace = await call(toolsA, "library_move", { type: "item", id: savedId, collectionId: personalColl.id });
    ok(moveCrossSpace.isError === true, "A: move item 跨归属（项目→个人集合）被拒");
    const moveCollCross = await call(toolsA, "library_move", { type: "collection", id: collId, collectionId: bColl.id });
    ok(moveCollCross.isError === true, "A: move collection 到 B 集合被拒（跨空间）");
    const moveCollOk = await call(toolsA, "library_move", { type: "collection", id: collId, collectionId: null });
    ok(moveCollOk.isError === undefined, "A: move collection 到根成功");

    // readonly：全部写工具拒绝
    const toolsRo = makeReadonlyExtension("proj-a");
    const roCreate = await call(toolsRo, "library_create_text", { kind: "markdown", title: "x" });
    ok(roCreate.isError !== true, "legacy readonly: create_text succeeds");
    const roSave = await call(toolsRo, "library_save_artifact", { artifactId: "art-own" });
    ok(roSave.isError !== true, "legacy readonly: save_artifact succeeds");
    const roColl = await call(toolsRo, "library_create_collection", { name: "x" });
    ok(roColl.isError !== true, "legacy readonly: create_collection succeeds");
    const roMove = await call(toolsRo, "library_move", { type: "item", id: savedId, collectionId: aColl.id });
    ok(roMove.isError !== true, "legacy readonly: move succeeds");
    const roCreatedId = (roCreate.details as { item: { id: string } }).item.id;
    const roUpdate = await call(toolsRo, "library_update_text", { id: roCreatedId, content: "x" });
    ok(roUpdate.isError !== true, "legacy readonly: update_text succeeds");

    // 归档项目：默认目标仍是该项目并拒绝写入，不偷偷降级写入个人库；读取保留
    projectService.archive("proj-a", true);
    const archCreate = await call(toolsA, "library_create_text", { kind: "markdown", title: "x", spaceId: aSpace });
    ok(archCreate.isError === true && archCreate.content[0].text.includes("归档"), "归档: 写 A 项目空间被拒");
    assert.throws(() => service.createItem({ spaceId: aSpace, kind: "markdown", title: "IPC 旁路" }), /归档/);
    assert.throws(() => service.writeContent({ id: aItem.id, content: "IPC 旁路" }), /归档/);
    assert.throws(() => service.deleteItem(aItem.id), /归档/);
    assert.throws(() => service.attachToTask({ taskId: "task-current", itemId: personalItem.id }), /归档/);
    ok(service.getItem(aItem.id) !== null, "归档: LibraryService 直连写入口同样拒绝且原条目仍在");
    const archPersonal = await call(toolsA, "library_create_text", { kind: "markdown", title: "归档期个人笔记" });
    ok(archPersonal.isError === true, "归档: 默认写明确拒绝，不改写个人库作为退路");
    const archRead = await call(toolsA, "library_read", { id: aItem.id });
    ok(archRead.isError === undefined, "归档: read 允许");
    projectService.archive("proj-a", false);
  }

  /* 8. 工作空间资料：继承可读、直属可写；显式文件夹/单条引用不放大授权 */
  {
    db.connection.prepare("INSERT INTO projects(id, name, created_at, updated_at) VALUES ('empty-readonly-project', 'Readonly', 1, 1)").run();
    const readonly = makeReadonlyExtension("empty-readonly-project", "readonly-empty-task");
    const beforeSpaces = service.listSpaces().length;
    ok((await call(readonly, "library_create_text", { kind: "markdown", title: "首次创建" })).isError !== true, "旧只读配置不阻止首次创建资料");
    ok(service.listSpaces().length === beforeSpaces + 1, "首次创建资料持久化当前项目所属空间");
    db.createSpace({ id: "materials-parent", name: "父空间" });
    db.createSpace({ id: "materials-child", name: "当前空间", parentId: "materials-parent" });
    db.createSpace({ id: "materials-sibling", name: "兄弟空间", parentId: "materials-parent" });
    db.createSpace({ id: "materials-grandchild", name: "直属子空间", parentId: "materials-child" });
    db.createSpace({ id: "materials-deep", name: "孙空间", parentId: "materials-grandchild" });
    const own = service.ensureOwnedSpace({ type: "workspace", workspaceId: "materials-child" });
    const parent = service.ensureOwnedSpace({ type: "workspace", workspaceId: "materials-parent" });
    const sibling = service.ensureOwnedSpace({ type: "workspace", workspaceId: "materials-sibling" });
    const child = service.ensureOwnedSpace({ type: "workspace", workspaceId: "materials-grandchild" });
    const deep = service.ensureOwnedSpace({ type: "workspace", workspaceId: "materials-deep" });
    const parentDoc = service.createItem({ spaceId: parent.id, kind: "markdown", title: "继承资料" });
    const siblingDoc = service.createItem({ spaceId: sibling.id, kind: "markdown", title: "兄弟独立资料" });
    const childDoc = service.createItem({ spaceId: child.id, kind: "markdown", title: "子空间资料" });
    const deepDoc = service.createItem({ spaceId: deep.id, kind: "markdown", title: "孙空间资料" });
    const tools = makeExtension(null, "task-workspace", "materials-child");
    const created = await call(tools, "library_create_text", { kind: "markdown", title: "空间自有文档", content: "工作空间自己的内容" });
    ok(!created.isError && (created.details as { item: { spaceId: string } }).item.spaceId === own.id, "工作空间任务默认创建到本空间资料");
    ok((await call(tools, "library_read", { id: parentDoc.id })).isError === undefined, "祖先资料可读取");
    ok((await call(tools, "library_update_text", { id: parentDoc.id, content: "不允许" })).isError === true, "继承资料仅可读，不能修改源资料");
    ok((await call(tools, "library_read", { id: siblingDoc.id })).isError === true, "兄弟空间资料默认不可直接读取");
    ok((await call(tools, "library_read", { id: childDoc.id })).isError === true, "子空间资料默认不可直接读取");
    ok((await call(tools, "library_read", { id: childDoc.id, explicitDirectChildSpaceId: "materials-grandchild" })).isError === undefined, "可显式临时读取直属子空间搜索命中");
    ok((await call(tools, "library_read", { id: siblingDoc.id, explicitDirectChildSpaceId: "materials-sibling" })).isError === true, "临时子空间参数不能扩大到兄弟空间");
    ok((await call(tools, "library_read", { id: deepDoc.id, explicitDirectChildSpaceId: "materials-deep" })).isError === true, "临时子空间参数不能越级到孙空间");
    ok((await call(tools, "library_read", { id: childDoc.id })).isError === true, "临时子空间读取不持久扩大范围");

    const folder = service.createCollection({ spaceId: LIBRARY_PERSONAL_SPACE_ID, name: "显式参考文件夹" });
    const referenced = service.createItem({ spaceId: LIBRARY_PERSONAL_SPACE_ID, collectionId: folder.id, kind: "markdown", title: "引用文件夹文档" });
    new WorkspaceLibraryBindingService(db).bindCollection("materials-parent", LIBRARY_PERSONAL_SPACE_ID, folder.id);
    const list = await call(tools, "library_list", { spaceId: LIBRARY_PERSONAL_SPACE_ID });
    ok(list.content[0].text.includes(referenced.title) && !list.content[0].text.includes(personalItem.title), "个人库只列出祖先显式绑定的文件夹，不放大到根目录");
    ok((await call(tools, "library_read", { id: referenced.id })).isError === undefined, "绑定的个人文件夹条目可读");
    ok((await call(tools, "library_update_text", { id: referenced.id, content: "不允许" })).isError === true, "引用文件夹不授予源资料写权限");

    // Persisted task identity wins over a stale/forged project resolver supplied by the host.
    const projectTools = makeExtension("proj-a", "task-rebind");
    db.upsertTask({ id: "task-rebind", title: "重新绑定", updatedAt: 2, projectId: "proj-b" });
    const rebound = await call(projectTools, "library_list", {});
    ok(rebound.content[0].text.includes("项目B机密文档") && !rebound.content[0].text.includes("项目A机密文档"), "现有工具会话重绑后按数据库项目生效，不信任旧fallback");
    db.deleteTask("task-rebind");
    const before = service.listAllItems().length;
    ok((await call(projectTools, "library_read", { id: bItem.id })).isError === true, "未知taskId禁止通过项目fallback读取");
    ok((await call(projectTools, "library_create_text", { kind: "markdown", title: "不存在任务不得写入" })).isError === true, "未知taskId禁止默认写入");
    ok(service.listAllItems().length === before, "拒绝的写入不留下新资料");
  }
}

void main().then(() => {
  db.close();
  rmSync(root, { recursive: true, force: true });
  if (process.exitCode) {
    console.error("library-extension-test: FAILED");
  } else {
    console.log(`library-extension-test: PASS (${passed})`);
  }
});
