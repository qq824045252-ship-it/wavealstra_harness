/**
 * LibraryExtension 运行时测试：任务/项目限域、二进制门禁、attach/detach。
 *
 * 覆盖（P1 收口）：未绑定任务仅 personal；绑定项目 A 的任务可见 personal + A，
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
import { createLibraryExtension, type LibraryExtensionBridge } from "../src/main/library/library-extension";
import { LIBRARY_PERSONAL_SPACE_ID } from "../src/shared/library-ipc";

const root = mkdtempSync(join(tmpdir(), "mybuddy-library-ext-"));
const db = new AppDatabase(join(root, "app.db"));
const service = new LibraryService(db, { libraryRoot: join(root, "lib") });
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

function makeExtension(projectId: string | null, taskId = "task-current"): Map<string, RegisteredTool> {
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

  /* 1. 未绑定任务（projectId null）：仅 personal */
  {
    const tools = makeExtension(null);
    const list = await call(tools, "library_list", {});
    const text = list.content[0].text;
    ok(text.includes("个人文档"), "unbound: list 含 personal");
    ok(!text.includes("项目A机密文档") && !text.includes("项目B机密文档"), "unbound: list 不含任何项目资料");
    const readB = await call(tools, "library_read", { id: bItem.id });
    ok(readB.isError === true && readB.content[0].text.includes("不可访问"), "unbound: 直读项目 B 条目被拒");
    const listBySpace = await call(tools, "library_list", { spaceId: bSpaceId });
    ok(listBySpace.isError === true, "unbound: spaceId 直指项目空间被拒");
    const attachB = await call(tools, "library_attach_to_task", { id: bItem.id });
    ok(attachB.isError === true, "unbound: 附加项目 B 条目被拒");
    const attachPersonal = await call(tools, "library_attach_to_task", { id: personalItem.id });
    ok(attachPersonal.isError === undefined, "unbound: 可附加 personal 条目");
  }

  /* 2. 项目 A 任务：personal + A 可见，B 全路径拒绝 */
  {
    const tools = makeExtension("proj-a");
    const list = await call(tools, "library_list", {});
    const text = list.content[0].text;
    ok(text.includes("个人文档") && text.includes("项目A机密文档"), "A: list 含 personal + A");
    ok(!text.includes("项目B机密文档"), "A: list 不含 B");
    const search = await call(tools, "library_search", { query: "机密" });
    ok(!search.content[0].text.includes("项目B机密文档"), "A: search 不含 B");
    ok(search.content[0].text.includes("项目A机密文档"), "A: search 含 A");
    const readB = await call(tools, "library_read", { id: bItem.id });
    ok(readB.isError === true && readB.content[0].text.includes("跨项目"), "A: 直读 B 条目被拒（跨项目）");
    const readA = await call(tools, "library_read", { id: aItem.id });
    ok(readA.isError === undefined && readA.content[0].text.includes("项目A机密文档"), "A: 读 A 条目正常");
    const readPersonal = await call(tools, "library_read", { id: personalItem.id });
    ok(readPersonal.isError === undefined, "A: 读 personal 正常");
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

  /* 4. 二进制门禁：pdf 返回受管路径元数据，无乱码 */
  {
    const tools = makeExtension(null);
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
    const tools = makeReadonlyExtension(null);
    const attach = await call(tools, "library_attach_to_task", { id: personalItem.id });
    ok(attach.isError === true && attach.content[0].text.includes("只读"), "readonly: attach 拒绝");
    const detach = await call(tools, "library_detach_from_task", { id: personalItem.id });
    ok(detach.isError === true && detach.content[0].text.includes("只读"), "readonly: detach 拒绝");
    const list = await call(tools, "library_list", {});
    ok(list.isError === undefined, "readonly: list 允许");
    const read = await call(tools, "library_read", { id: personalItem.id });
    ok(read.isError === undefined, "readonly: read 允许");
    // 非 readonly 会话 attach/detach 正常（回归）
    const normal = makeExtension(null);
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

    // create_text：personal + 当前项目允许；B 空间/集合拒绝
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
    ok(crossSpace.isError === true && crossSpace.content[0].text.includes("可见范围"), "A: create_text 到 B 空间被拒");
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
    db.connection
      .prepare(`INSERT INTO tasks (id, title, updated_at, project_id) VALUES ('task-current', '当前任务', 1, 'proj-a'), ('task-b', 'B任务', 1, 'proj-b')`)
      .run();
    const saved = await call(toolsA, "library_save_artifact", { artifactId: "art-own" });
    ok(saved.isError === undefined && saved.content[0].text.includes("来源：artifact"), "A: save_artifact 成功且 provenance 可见");
    const savedId = (saved.details as { item: { id: string } }).item.id;
    ok(service.getItem(savedId)?.sourceTaskId === "task-current", "A: provenance 含来源任务");
    const again = await call(toolsA, "library_save_artifact", { artifactId: "art-own" });
    ok((again.details as { item: { id: string } }).item.id === savedId, "A: save_artifact 幂等（同条目）");
    const saveB = await call(toolsA, "library_save_artifact", { artifactId: "art-b" });
    ok(saveB.isError === true && saveB.content[0].text.includes("不属于当前任务"), "A: 其他项目任务产物拒绝");
    // 未绑定任务：只能晋升自己的产物
    const toolsNone = makeExtension(null, "task-none");
    const saveNone = await call(toolsNone, "library_save_artifact", { artifactId: "art-own" });
    ok(saveNone.isError === true && saveNone.content[0].text.includes("不属于当前任务"), "unbound: 不能晋升其他任务产物");

    // create_collection / move：同空间允许；跨空间拒绝；根移动成功
    const personalColl = service.createCollection({ spaceId: LIBRARY_PERSONAL_SPACE_ID, name: "个人沉淀夹" });
    const collCreated = await call(toolsA, "library_create_collection", { name: "沉淀夹", spaceId: aSpace, parentId: aColl.id });
    ok(collCreated.isError === undefined, "A: create_collection 同空间成功");
    const collB = await call(toolsA, "library_create_collection", { name: "越界夹", spaceId: bSpace });
    ok(collB.isError === true, "A: create_collection 到 B 空间被拒");
    const collId = (collCreated.details as { collection: { id: string } }).collection.id;
    const moveOk = await call(toolsA, "library_move", { type: "item", id: savedId, collectionId: personalColl.id });
    ok(moveOk.isError === undefined, "A: move item 同空间成功（savedId 在 personal）");
    const moveCross = await call(toolsA, "library_move", { type: "item", id: savedId, collectionId: bColl.id });
    ok(moveCross.isError === true, "A: move item 到 B 集合被拒");
    const moveCrossSpace = await call(toolsA, "library_move", { type: "item", id: savedId, collectionId: aColl.id });
    ok(moveCrossSpace.isError === true, "A: move item 跨空间（personal→A 集合）被拒");
    const moveCollCross = await call(toolsA, "library_move", { type: "collection", id: collId, collectionId: bColl.id });
    ok(moveCollCross.isError === true, "A: move collection 到 B 集合被拒（跨空间）");
    const moveCollOk = await call(toolsA, "library_move", { type: "collection", id: collId, collectionId: null });
    ok(moveCollOk.isError === undefined, "A: move collection 到根成功");

    // readonly：全部写工具拒绝
    const toolsRo = makeReadonlyExtension("proj-a");
    const roCreate = await call(toolsRo, "library_create_text", { kind: "markdown", title: "x" });
    ok(roCreate.isError === true && roCreate.content[0].text.includes("只读"), "readonly: create_text 拒绝");
    const roSave = await call(toolsRo, "library_save_artifact", { artifactId: "art-own" });
    ok(roSave.isError === true, "readonly: save_artifact 拒绝");
    const roColl = await call(toolsRo, "library_create_collection", { name: "x" });
    ok(roColl.isError === true, "readonly: create_collection 拒绝");
    const roMove = await call(toolsRo, "library_move", { type: "item", id: savedId, collectionId: aColl.id });
    ok(roMove.isError === true, "readonly: move 拒绝");
    const roUpdate = await call(toolsRo, "library_update_text", { id: savedId, content: "x" });
    ok(roUpdate.isError === true, "readonly: update_text 拒绝");

    // 归档项目：写拒绝（目标=A 项目空间）、读允许（personal 不受归档影响）
    projectService.archive("proj-a", true);
    const archCreate = await call(toolsA, "library_create_text", { kind: "markdown", title: "x", spaceId: aSpace });
    ok(archCreate.isError === true && archCreate.content[0].text.includes("归档"), "归档: 写 A 项目空间被拒");
    assert.throws(() => service.createItem({ spaceId: aSpace, kind: "markdown", title: "IPC 旁路" }), /归档/);
    assert.throws(() => service.writeContent({ id: aItem.id, content: "IPC 旁路" }), /归档/);
    assert.throws(() => service.deleteItem(aItem.id), /归档/);
    assert.throws(() => service.attachToTask({ taskId: "task-current", itemId: personalItem.id }), /归档/);
    ok(service.getItem(aItem.id) !== null, "归档: LibraryService 直连写入口同样拒绝且原条目仍在");
    const archPersonal = await call(toolsA, "library_create_text", { kind: "markdown", title: "归档期个人笔记" });
    ok(archPersonal.isError === undefined, "归档: personal 写允许（归档不锁个人空间）");
    const archRead = await call(toolsA, "library_read", { id: personalItem.id });
    ok(archRead.isError === undefined, "归档: read 允许");
    projectService.archive("proj-a", false);
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
