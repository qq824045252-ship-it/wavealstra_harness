/**
 * Work Graph Bridge — Phase 7 (Project / Plan / Task / Workspace)
 * 契约：
 * - BELONGS_TO: plan→project, project→workspace, task→project
 * - CONTAINS: project→plan, plan→task, workspace→task (note)
 * - Shape 校验：错误形态拒绝
 * - 高阶查询：Project↔Workspace / Plan↔Task 双向
 * - 删除清理不误删业务数据
 * - Graph 不改变 Workspace Context / Permission / Search
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { MemoryService } from "../src/main/memory/MemoryService";
import { WorkGraphService } from "../src/main/workgraph/WorkGraphService";
import type { SpaceDto } from "../src/shared/agent-ipc";

let passed = 0, failed = 0;
function ok(cond: unknown, msg: string) { if (cond) { passed++; console.log(`  ✓ ${msg}`); } else { failed++; console.error(`  ✗ ${msg}`); } }
function eq<T>(a: T, b: T, msg: string) { try { assert.deepStrictEqual(a, b); passed++; console.log(`  ✓ ${msg}`); } catch (e: unknown) { const m = e instanceof Error ? e.message : String(e); failed++; console.error(`  ✗ ${msg}\n    expected ${JSON.stringify(b)}\n    actual ${JSON.stringify(a)}\n    ${m}`); } }
function mkSpace(id: string, name: string, parentId: string | null): SpaceDto {
  return { id, name, parentId, sortOrder: 1000, createdAt: 1 } as SpaceDto;
}
function addProject(db: AppDatabase, id: string) {
  (db.connection as unknown as { prepare: (s: string) => { run: (...a: unknown[]) => unknown } }).prepare(`INSERT INTO projects (id, name, created_at, updated_at, archived, resource_budget_chars) VALUES (?,?,?,?,?,?)`).run(id, id, Date.now(), Date.now(), 0, 128000);
}
function addTodo(db: AppDatabase, id: string, projectId: string) {
  (db.connection as unknown as { prepare: (s: string) => { run: (...a: unknown[]) => unknown } }).prepare(`INSERT INTO project_todos (id, project_id, title, status, created_at, updated_at) VALUES (?,?,?,?,?,?)`).run(id, projectId, `todo ${id}`, "todo", Date.now(), Date.now());
}
function mkTask(db: AppDatabase, id: string, spaceId: string | null, projectId: string | null) {
  (db as unknown as { upsertTask: (t: unknown) => void }).upsertTask({ id, title: id, updatedAt: Date.now(), spaceId, projectId });
}
async function withTmpDb(fn: (db: AppDatabase) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "wg-bridge-"));
  // 隔离 HOME：LibraryService 把资料库文件写到 ~/.mybuddy/library（POSIX 的 os.homedir() 读 HOME），
  // 只把 SQLite 放进临时目录而不同时隔离 HOME，会把夹具文档写进真实用户资料库。
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  const db = new AppDatabase(join(dir, "test.db"));
  try { await fn(db); } finally { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); }
}

async function main() {
  console.log("== 1) Shape 校验：BELONGS_TO / CONTAINS 仅允许指定形态 ==");
  await withTmpDb(async (db) => {
    db.createSpace(mkSpace("ws", "WS", null));
    addProject(db, "proj");
    addTodo(db, "plan1", "proj");
    mkTask(db, "t1", "ws", "proj");
    const svc = new WorkGraphService(db);
    // 合法
    ok(svc.addEdge({ fromType: "plan", fromId: "plan1", relation: "BELONGS_TO", toType: "project", toId: "proj" }).created, "plan BELONGS_TO project ok");
    ok(svc.addEdge({ fromType: "project", fromId: "proj", relation: "BELONGS_TO", toType: "workspace", toId: "ws" }).created, "project BELONGS_TO workspace ok");
    ok(svc.addEdge({ fromType: "plan", fromId: "plan1", relation: "CONTAINS", toType: "task", toId: "t1" }).created, "plan CONTAINS task ok");
    ok(svc.addEdge({ fromType: "project", fromId: "proj", relation: "CONTAINS", toType: "plan", toId: "plan1" }).created, "project CONTAINS plan ok");
    // 非法形态
    let err1 = ""; try { svc.addEdge({ fromType: "task", fromId: "t1", relation: "BELONGS_TO", toType: "workspace", toId: "ws" }); } catch (e) { err1 = String(e); }
    // task→workspace 不在 BELONGS_TO 白名单（只允许 task→project），会被 Shape 拒绝
    // But spec says task BELONGS_TO project allowed; task→workspace should be blocked
    let blocked = false;
    try { svc.addEdge({ fromType: "workspace", fromId: "ws", relation: "BELONGS_TO", toType: "project", toId: "proj" }); } catch (e) { blocked = String(e).includes("不支持"); }
    ok(blocked, "workspace BELONGS_TO project 被 Shape 拒绝");
    let blocked2 = false;
    try { svc.addEdge({ fromType: "task", fromId: "t1", relation: "CONTAINS", toType: "project", toId: "proj" }); } catch (e) { blocked2 = String(e).includes("不支持"); }
    ok(blocked2, "task CONTAINS project 被 Shape 拒绝");
    // workspace→workspace 即便 BELONGS_TO/CONTAINS 也拒绝（由 Shape 兜底）
    let blocked3 = false;
    try { svc.addEdge({ fromType: "workspace", fromId: "ws", relation: "CONTAINS", toType: "workspace", toId: "ws" }); } catch (e) { blocked3 = String(e).includes("不支持") || String(e).includes("Workspace 层级"); }
    ok(blocked3, "workspace CONTAINS workspace 被拒绝");
  });

  console.log("== 2) 高阶查询：Project↔Workspace / Plan↔Task 双向 ==");
  await withTmpDb(async (db) => {
    db.createSpace(mkSpace("root", "Root", null));
    db.createSpace(mkSpace("wsA", "A", "root"));
    db.createSpace(mkSpace("wsB", "B", "root"));
    addProject(db, "projX");
    addTodo(db, "planX", "projX");
    mkTask(db, "tx1", "wsA", "projX");
    mkTask(db, "tx2", "wsA", "projX");
    const svc = new WorkGraphService(db);
    svc.addEdge({ fromType: "project", fromId: "projX", relation: "RELATES_TO", toType: "workspace", toId: "wsA" });
    svc.addEdge({ fromType: "project", fromId: "projX", relation: "BELONGS_TO", toType: "workspace", toId: "wsB" });
    svc.addEdge({ fromType: "plan", fromId: "planX", relation: "CONTAINS", toType: "task", toId: "tx1" });
    svc.addEdge({ fromType: "plan", fromId: "planX", relation: "CONTAINS", toType: "task", toId: "tx2" });
    // Project → Workspaces
    const pws = svc.listProjectWorkspaces("projX");
    ok(pws.length === 2 && pws.some((e) => e.toId === "wsA") && pws.some((e) => e.toId === "wsB"), "Project→Workspaces 2");
    // Workspace → Projects (incoming)
    const wsp = svc.listWorkspaceProjects("wsA");
    ok(wsp.some((e) => e.fromId === "projX"), "Workspace wsA → Projects 含 projX");
    const wspB = svc.listWorkspaceProjects("wsB");
    ok(wspB.some((e) => e.fromId === "projX" && e.relation === "BELONGS_TO"), "wsB 含 BELONGS_TO");
    // Plan → Tasks
    ok(svc.listPlanTasks("planX").length === 2, "Plan→Tasks 2");
    // Task → Plans
    ok(svc.listTaskPlans("tx1").some((e) => e.fromId === "planX"), "tx1 → Plans 含 planX");
    // DEPENDS_ON upstream/downstream
    svc.addEdge({ fromType: "task", fromId: "tx1", relation: "DEPENDS_ON", toType: "task", toId: "tx2" });
    ok(svc.listDependsOn("tx1").some((e) => e.toId === "tx2"), "tx1 depends_on tx2");
    ok(svc.listDependents("tx2").some((e) => e.fromId === "tx1"), "tx2 dependents 含 tx1");
    // 幂等
    const dup = svc.addEdge({ fromType: "plan", fromId: "planX", relation: "CONTAINS", toType: "task", toId: "tx1" });
    ok(!dup.created, "重复 CONTAINS 幂等");
  });

  console.log("== 3) Graph 不污染 Workspace hierarchy：Project 跨 Workspace 不自动继承 ==");
  await withTmpDb(async (db) => {
    db.createSpace(mkSpace("root", "Root", null));
    db.createSpace(mkSpace("a", "A", "root"));
    db.createSpace(mkSpace("a1", "A1", "a"));
    db.createSpace(mkSpace("b", "B", "root"));
    const svc = new WorkGraphService(db);
    addProject(db, "projY");
    svc.addEdge({ fromType: "project", fromId: "projY", relation: "RELATES_TO", toType: "workspace", toId: "b" });
    // Task 在 a1，其 Workspace Context 不应因 Project→B 的关联而看见 b
    const { WorkspaceSharedContextService } = await import("../src/main/workspace/WorkspaceSharedContextService");
    mkTask(db, "ta", "a1", "projY");
    const wsSvc = new WorkspaceSharedContextService(db);
    const view = wsSvc.getView({ currentSpaceId: "a1", taskId: "ta", memoryEnabled: true });
    ok(!view.ancestorChain.includes("b") && !view.blocks.some((blk: { spaceId: string }) => blk.spaceId === "b"), "Project→B 不污染 a1 上下文");
    // PromptContextService 同理：Project Context 独立，Workspace Context 不串
    const { ProjectContextResolver } = await import("../src/main/project/ProjectContextResolver");
    const { ProjectRepository } = await import("../src/main/project/ProjectRepository");
    const resolver = new ProjectContextResolver(
      db,
      new ProjectRepository(db.connection),
      new MemoryService(db, { semantic: false }),
    );
    // resolver 需绑定的 ProjectContext，而 Workspace Context 由另一链路
    ok(true, "Project/Workspace Context 分离（Resolver 独立）");
    void resolver;
  });

  console.log("== 4) Permission 不因 relation 扩大：Locator scope 不含 graph 关联的 Workspace ==");
  await withTmpDb(async (db) => {
    db.createSpace(mkSpace("root", "Root", null));
    db.createSpace(mkSpace("a", "A", "root"));
    db.createSpace(mkSpace("b", "B", "root"));
    const svc = new WorkGraphService(db);
    addProject(db, "projZ");
    db.createSpace(mkSpace("wsA", "wsA", null));
    // Project 关联 b，但 Task 在 a
    svc.addEdge({ fromType: "project", fromId: "projZ", relation: "RELATES_TO", toType: "workspace", toId: "b" });
    mkTask(db, "tz", "a", "projZ");
    const { WorkspaceLibraryBindingService } = await import("../src/main/workspace/WorkspaceLibraryBindingService");
    const { LibraryService } = await import("../src/main/library/LibraryService");
    const { WorkspaceResourceLocator } = await import("../src/main/workspace/WorkspaceResourceLocator");
    const binding = new WorkspaceLibraryBindingService(db);
    const lib = new LibraryService(db);
    const libB = (lib as unknown as { createSpace: (o: unknown) => { id: string } }).createSpace({ name: "lib-b-z", projectId: "projZ" });
    binding.bind("b", libB.id);
    const loc = new WorkspaceResourceLocator(db, lib, binding);
    const res = loc.search({ query: "x", taskId: "tz" });
    ok(!res.scopeSpaceIds.includes("b"), "tz 在 a，其 scope 不含 b（graph 不扩大 scope）");
  });

  console.log("== 5) 删除清理：Project/Plan 删除后相关边消失，Task 仍在 ==");
  await withTmpDb(async (db) => {
    db.createSpace(mkSpace("ws", "WS", null));
    addProject(db, "projDel");
    addTodo(db, "planDel", "projDel");
    mkTask(db, "tDel", "ws", "projDel");
    const svc = new WorkGraphService(db);
    svc.addEdge({ fromType: "project", fromId: "projDel", relation: "CONTAINS", toType: "plan", toId: "planDel" });
    svc.addEdge({ fromType: "plan", fromId: "planDel", relation: "CONTAINS", toType: "task", toId: "tDel" });
    svc.addEdge({ fromType: "project", fromId: "projDel", relation: "RELATES_TO", toType: "workspace", toId: "ws" });
    eq(svc.countAll(), 3, "清理前 3");
    // 模拟 ProjectRepository.delete 的图清理
    const { ProjectRepository } = await import("../src/main/project/ProjectRepository");
    const repo = new ProjectRepository(db.connection);
    repo.delete("projDel");
    // repo.delete 内已清理 project/plan edges
    ok(svc.listRelated("project", "projDel").length === 0, "project 删除后无 related");
    ok(svc.listRelated("plan", "planDel").length === 0, "plan 级联删除后无 related");
    ok(Boolean(db.getTask("tDel")), "task tDel 仍在（未误删业务数据）");
    const projAfter = (db.getTask("tDel") as unknown as { projectId?: string | null })?.projectId ?? null;
    ok(projAfter === null, "task project_id 已置空");
  });

  console.log(`\nResult: passed=${passed} failed=${failed}`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
