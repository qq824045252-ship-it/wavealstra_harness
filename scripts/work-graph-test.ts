/**
 * Work Graph — Phase 6 Foundation 测试（真实 AppDatabase + WorkGraphService）
 * 契约（ADR-001 + 路线图 §26-§29）：
 * - Graph = typed relation，Workspace = context hierarchy，不互相污染
 * - 仅 work_graph_edges 持久化，无 work_graph_nodes
 * - 首版仅 RELATES_TO / DEPENDS_ON / PRODUCES / DERIVED_FROM
 * - DEPENDS_ON 需 DAG 环检测，RELATES_TO 可环
 * - Entity existence 校验；重复幂等；删除显式清理；查询确定性
 * - 不改变 Workspace Context / Permission
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase, CURRENT_DATABASE_SCHEMA_VERSION } from "../src/main/db/AppDatabase";
import { WorkGraphService } from "../src/main/workgraph/WorkGraphService";
import type { SpaceDto } from "../src/shared/agent-ipc";

let passed = 0, failed = 0;
function ok(cond: unknown, msg: string) { if (cond) { passed++; console.log(`  ✓ ${msg}`); } else { failed++; console.error(`  ✗ ${msg}`); } }
function eq<T>(a: T, b: T, msg: string) { try { assert.deepStrictEqual(a, b); passed++; console.log(`  ✓ ${msg}`); } catch (e: unknown) { const m = e instanceof Error ? e.message : String(e); failed++; console.error(`  ✗ ${msg}\n    expected ${JSON.stringify(b)}\n    actual ${JSON.stringify(a)}\n    ${m}`); } }

function mkSpace(id: string, name: string, parentId: string | null): SpaceDto {
  return { id, name, parentId, sortOrder: 1000, createdAt: 1 } as SpaceDto;
}
function addProject(db: AppDatabase, id: string) {
  (db.connection as unknown as { prepare: (s: string) => { run: (...a: unknown[]) => unknown } })
    .prepare(`INSERT INTO projects (id, name, created_at, updated_at, archived, resource_budget_chars) VALUES (?,?,?,?,?,?)`)
    .run(id, id, Date.now(), Date.now(), 0, 128000);
}
function addTodo(db: AppDatabase, id: string, projectId: string) {
  (db.connection as unknown as { prepare: (s: string) => { run: (...a: unknown[]) => unknown } })
    .prepare(`INSERT INTO project_todos (id, project_id, title, status, created_at, updated_at) VALUES (?,?,?,?,?,?)`)
    .run(id, projectId, `todo ${id}`, "todo", Date.now(), Date.now());
}
function mkTask(db: AppDatabase, id: string, spaceId: string | null, projectId: string | null) {
  (db as unknown as { upsertTask: (t: unknown) => void }).upsertTask({ id, title: id, updatedAt: Date.now(), spaceId, projectId });
}
async function withTmpDb(fn: (db: AppDatabase, dir: string) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "wg-"));
  // 隔离 HOME：LibraryService 把资料库文件写到 ~/.mybuddy/library（POSIX 的 os.homedir() 读 HOME），
  // 只把 SQLite 放进临时目录而不同时隔离 HOME，会把夹具文档写进真实用户资料库。
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  const db = new AppDatabase(join(dir, "test.db"));
  try { await fn(db, dir); } finally { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); }
}

async function main() {
  console.log("== 1) DB/migration：work_graph_edges + 索引 + v17 ==");
  await withTmpDb(async (db) => {
    const hasTable = (n: string) => (db.connection as unknown as { prepare: (s: string) => { get: (...a: unknown[]) => unknown } }).prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name=?`).get(n) !== undefined;
    ok(hasTable("work_graph_edges"), "work_graph_edges 存在");
    eq(db.schemaVersion, CURRENT_DATABASE_SCHEMA_VERSION, `schemaVersion=${CURRENT_DATABASE_SCHEMA_VERSION}`);
    const idx = (name: string) => (db.connection as unknown as { prepare: (s: string) => { get: (...a: unknown[]) => unknown } }).prepare(`SELECT 1 FROM sqlite_master WHERE type='index' AND name=?`).get(name) !== undefined;
    ok(idx("idx_wge_from"), "idx_wge_from 存在");
    ok(idx("idx_wge_to"), "idx_wge_to 存在");
    ok(idx("idx_wge_rel"), "idx_wge_rel 存在");
    // 幂等：重建不会丢
    const before = new WorkGraphService(db).countAll();
    // reopen simulation: ensureWorkGraphTables is idempotent within same DB instance via second service
    ok(before === 0, "初始 count 0");
  });

  console.log("== 2) Entity existence 校验 ==");
  await withTmpDb(async (db) => {
    db.createSpace(mkSpace("ws1", "WS1", null));
    mkTask(db, "t1", "ws1", null);
    const svc = new WorkGraphService(db);
    // 合法
    const r1 = svc.addEdge({ fromType: "task", fromId: "t1", relation: "RELATES_TO", toType: "workspace", toId: "ws1" });
    ok(r1.created && r1.edge.id, "合法 from/to 通过");
    // 非法 to
    let threw = false;
    try { svc.addEdge({ fromType: "task", fromId: "t1", relation: "RELATES_TO", toType: "task", toId: "nope" }); } catch (e) { threw = String(e).includes("不存在"); }
    ok(threw, "不存在的 task 拒绝");
    // 非法 relation（用真正不存在的 relation 验证校验）
    let threw2 = false;
    try { svc.addEdge({ fromType: "task", fromId: "t1", relation: "UNKNOWN_REL" as unknown as "RELATES_TO", toType: "workspace", toId: "ws1" }); } catch (e) { threw2 = String(e).includes("非法 relation"); }
    ok(threw2, "非法 relation 拒绝");
    // 非法 node type
    let threw3 = false;
    try { svc.addEdge({ fromType: "human" as unknown as "task", fromId: "t1", relation: "RELATES_TO", toType: "workspace", toId: "ws1" }); } catch (e) { threw3 = String(e).includes("非法 node type"); }
    ok(threw3, "非法 node type 拒绝");
  });

  console.log("== 3) Edge write + duplicate 幂等 ==");
  await withTmpDb(async (db) => {
    db.createSpace(mkSpace("ws", "WS", null));
    mkTask(db, "ta", "ws", null);
    mkTask(db, "tb", "ws", null);
    const svc = new WorkGraphService(db);
    const r1 = svc.addEdge({ fromType: "task", fromId: "ta", relation: "DEPENDS_ON", toType: "task", toId: "tb" });
    ok(r1.created, "首次创建 created=true");
    const r2 = svc.addEdge({ fromType: "task", fromId: "ta", relation: "DEPENDS_ON", toType: "task", toId: "tb" });
    ok(!r2.created && r2.edge.id === r1.edge.id, "重复添加幂等，返回同一 id");
    eq(svc.countAll(), 1, "重复不增加 count");
    // 不同 relation 视为不同边
    const r3 = svc.addEdge({ fromType: "task", fromId: "ta", relation: "RELATES_TO", toType: "task", toId: "tb" });
    ok(r3.created, "不同 relation 视为不同边");
    eq(svc.countAll(), 2, "不同 relation count=2");
  });

  console.log("== 4) Query：direction + determinism ==");
  await withTmpDb(async (db) => {
    db.createSpace(mkSpace("ws", "WS", null));
    mkTask(db, "a", "ws", null);
    mkTask(db, "b", "ws", null);
    mkTask(db, "c", "ws", null);
    const svc = new WorkGraphService(db);
    svc.addEdge({ fromType: "task", fromId: "a", relation: "RELATES_TO", toType: "task", toId: "b" });
    svc.addEdge({ fromType: "task", fromId: "a", relation: "PRODUCES", toType: "task", toId: "c" });
    const out = svc.listOutgoing("task", "a");
    eq(out.length, 2, "outgoing 2");
    const outRel = svc.listOutgoing("task", "a", "RELATES_TO");
    eq(outRel.length, 1, "outgoing filtered by relation");
    const inn = svc.listIncoming("task", "b");
    eq(inn.length, 1, "incoming 1");
    const related = svc.listRelated("task", "a");
    eq(related.length, 2, "related 2");
    // related 对 b 也应包含 a→b
    const relB = svc.listRelated("task", "b");
    ok(relB.some((e) => e.fromId === "a" && e.toId === "b"), "b related 包含 a→b");
    // determinism: repeat same order
    const rep1 = svc.listOutgoing("task", "a").map((e) => e.id);
    const rep2 = svc.listOutgoing("task", "a").map((e) => e.id);
    eq(rep1, rep2, "重复查询确定性");
  });

  console.log("== 5) DAG 环：DEPENDS_ON 禁环，RELATES_TO 可环 ==");
  await withTmpDb(async (db) => {
    db.createSpace(mkSpace("ws", "WS", null));
    mkTask(db, "x", "ws", null);
    mkTask(db, "y", "ws", null);
    mkTask(db, "z", "ws", null);
    const svc = new WorkGraphService(db);
    svc.addEdge({ fromType: "task", fromId: "x", relation: "DEPENDS_ON", toType: "task", toId: "y" });
    svc.addEdge({ fromType: "task", fromId: "y", relation: "DEPENDS_ON", toType: "task", toId: "z" });
    let blocked = false;
    try { svc.addEdge({ fromType: "task", fromId: "z", relation: "DEPENDS_ON", toType: "task", toId: "x" }); } catch (e) { blocked = String(e).includes("DAG 环拒绝"); }
    ok(blocked, "DEPENDS_ON 环被拒绝");
    eq(svc.countAll(), 2, "环拒绝后 count 仍 2");
    // 间接环：x→y, y→z, 若 z→x 拒绝，x→z 直接也应？ x 已可达 y→z，但 z 不可达 x，故 x→z 仍应成功（不形成环）
    // 但需验证 x→z 不应被误杀
    const okDirect = svc.addEdge({ fromType: "task", fromId: "x", relation: "DEPENDS_ON", toType: "task", toId: "z" });
    ok(okDirect.created, "x→z 非环，允许");
    // RELATES_TO 环允许
    const r1 = svc.addEdge({ fromType: "task", fromId: "y", relation: "RELATES_TO", toType: "task", toId: "x" });
    ok(r1.created, "RELATES_TO y→x 允许（与 x→y DEPENDS_ON 并存）");
    const r2 = svc.addEdge({ fromType: "task", fromId: "z", relation: "RELATES_TO", toType: "task", toId: "y" });
    ok(r2.created, "RELATES_TO z→y 允许");
    // RELATES_TO 自环也可？验证
    const self = svc.addEdge({ fromType: "task", fromId: "x", relation: "RELATES_TO", toType: "task", toId: "x" });
    ok(self.created, "RELATES_TO 自环允许");
    // DEPENDS_ON 自环拒绝
    let selfDepBlocked = false;
    try { svc.addEdge({ fromType: "task", fromId: "x", relation: "DEPENDS_ON", toType: "task", toId: "x" }); } catch (e) { selfDepBlocked = String(e).includes("自环"); }
    ok(selfDepBlocked, "DEPENDS_ON 自环拒绝");
  });

  console.log("== 6) Delete cleanup：显式清理，不误删业务数据 ==");
  await withTmpDb(async (db) => {
    db.createSpace(mkSpace("ws", "WS", null));
    mkTask(db, "da", "ws", null);
    mkTask(db, "db2", "ws", null);
    const svc = new WorkGraphService(db);
    svc.addEdge({ fromType: "task", fromId: "da", relation: "RELATES_TO", toType: "task", toId: "db2" });
    svc.addEdge({ fromType: "task", fromId: "db2", relation: "DEPENDS_ON", toType: "task", toId: "da" });
    eq(svc.countAll(), 2, "清理前 2");
    // 删除任务 da 的 graph 清理
    const removed = svc.cleanupByNode("task", "da");
    ok(removed >= 2, `cleanup da 移除 >=2：${removed}`);
    eq(svc.countAll(), 0, "清理后 0");
    // 业务数据：db2 任务仍在
    const still = db.getTask("db2");
    ok(still?.id === "db2", "业务 task db2 仍在");
    // workspace 删除同理
    db.createSpace(mkSpace("ws2", "WS2", null));
    const proj = "proj-gc";
    addProject(db, proj);
    const ws2ExistsBefore = Boolean(db.getSpace("ws2"));
    ok(ws2ExistsBefore, "ws2 存在");
    // workspace 节点关联边可被清理（即使 workspace 类型多）
    mkTask(db, "t3", "ws", null);
    // 建立 workspace 相关的边（需真实 workspace 存在）
    svc.addEdge({ fromType: "task", fromId: "t3", relation: "RELATES_TO", toType: "workspace", toId: "ws2" });
    eq(svc.countAll(), 1, "workspace 边 1");
    svc.cleanupByNode("workspace", "ws2");
    eq(svc.countAll(), 0, "workspace 清理后 0");
  });

  console.log("== 7) Metadata + 全部 4 relation 支持 ==");
  await withTmpDb(async (db) => {
    db.createSpace(mkSpace("ws", "WS", null));
    mkTask(db, "ma", "ws", null);
    mkTask(db, "mb", "ws", null);
    const svc = new WorkGraphService(db);
    const relations: Array<"RELATES_TO" | "DEPENDS_ON" | "PRODUCES" | "DERIVED_FROM"> = ["RELATES_TO", "DEPENDS_ON", "PRODUCES", "DERIVED_FROM"];
    // PRODUCES / DERIVED_FROM 间无 DAG 约束，连续建边不应环误杀
    for (const rel of relations) {
      // 用不同对避免 DAG 交叉：ma→mb 每种 relation 一条（DEPENDS_ON 自环除外已测）
      // 为避免 RELATES_TO 与 DEPENDS_ON 在同一 pair 影响，需新 pair；这里复用但不同 relation 唯一键允许
      svc.addEdge({ fromType: "task", fromId: "ma", relation: rel, toType: "task", toId: "mb", metadata: { via: rel } });
    }
    eq(svc.countAll(), 4, "4 种 relation 各一条");
    const fetched = svc.listOutgoing("task", "ma");
    for (const rel of relations) {
      const hit = fetched.find((e) => e.relation === rel);
      ok(hit?.metadata?.via === rel, `metadata 保留 via=${rel}`);
    }
    // removeEdge
    const toRemove = fetched.find((e) => e.relation === "PRODUCES")!;
    ok(svc.removeEdge(toRemove.id), "removeEdge 成功");
    eq(svc.countAll(), 3, "移除后 3");
    ok(!svc.removeEdge(toRemove.id), "二次移除 false");
  });

  console.log("== 8) Graph 不改变 Workspace Context / Permission（隔离证明） ==");
  await withTmpDb(async (db) => {
    // 复用现有 workspace_shared_context 真实逻辑：graph 边不进入 assembly
    const { WorkspaceSharedContextService } = await import("../src/main/workspace/WorkspaceSharedContextService");
    db.createSpace(mkSpace("root", "Root", null));
    db.createSpace(mkSpace("a", "A", "root"));
    db.createSpace(mkSpace("a1", "A1", "a"));
    db.createSpace(mkSpace("b", "B", "root"));
    const svc = new WorkGraphService(db);
    mkTask(db, "ta", "a1", null);
    const wsSvc = new WorkspaceSharedContextService(db);
    const before = wsSvc.getView({ currentSpaceId: "a1", taskId: "ta", memoryEnabled: true });
    // 添加一条跨 sibling 的图关联：a1 的任务关联 b 空间的资源（但不应让 ta 的上下文看到 b）
    mkTask(db, "tb", "b", null);
    svc.addEdge({ fromType: "task", fromId: "ta", relation: "RELATES_TO", toType: "task", toId: "tb" });
    svc.addEdge({ fromType: "task", fromId: "ta", relation: "RELATES_TO", toType: "workspace", toId: "b" });
    const after = wsSvc.getView({ currentSpaceId: "a1", taskId: "ta", memoryEnabled: true });
    // ancestorChain 不应被 graph 改变
    eq(after.ancestorChain, before.ancestorChain, "graph 不改变 ancestorChain");
    ok(!after.blocks.some((blk: { spaceId: string }) => blk.spaceId === "b"), "graph 不污染 WorkspaceSharedContext blocks（sibling b 不进入）");
    // Permission：Locator scope 不应因 graph 扩大（workspace 相关即便 graph 有 b，也不自动扩 scope）
    const { WorkspaceLibraryBindingService } = await import("../src/main/workspace/WorkspaceLibraryBindingService");
    const { LibraryService } = await import("../src/main/library/LibraryService");
    const { WorkspaceResourceLocator } = await import("../src/main/workspace/WorkspaceResourceLocator");
    const binding = new WorkspaceLibraryBindingService(db);
    const lib = new LibraryService(db);
    const projLib = "proj-loc-wg";
    addProject(db, projLib);
    const libB = (lib as unknown as { createSpace: (o: unknown) => { id: string } }).createSpace({ name: "lib-b", projectId: projLib });
    binding.bind("b", libB.id);
    const loc = new WorkspaceResourceLocator(db, lib, binding);
    const res = loc.search({ query: "test", taskId: "ta" });
    // ta 在 a1，scope 不含 b，故 lib-b 不应被搜到（graph 也不应让它被搜到）
    ok(!res.scopeSpaceIds.includes("b"), "graph 不扩大 Locator scope（b 不在 ta scope）");
  });

  console.log("== 9) Plan / Project 节点存在性与清理 ==");
  await withTmpDb(async (db) => {
    db.createSpace(mkSpace("ws", "WS", null));
    addProject(db, "proj1");
    addTodo(db, "plan1", "proj1");
    mkTask(db, "pt", "ws", "proj1");
    const svc = new WorkGraphService(db);
    const e1 = svc.addEdge({ fromType: "plan", fromId: "plan1", relation: "RELATES_TO", toType: "task", toId: "pt" });
    ok(e1.created, "plan→task 边创建");
    const e2 = svc.addEdge({ fromType: "project", fromId: "proj1", relation: "RELATES_TO", toType: "plan", toId: "plan1" });
    ok(e2.created, "project→plan 边创建");
    // 删除 plan 应清理相关边
    svc.cleanupByNode("plan", "plan1");
    ok(!svc.listRelated("plan", "plan1").length, "plan 清理后无 related");
    // project 清理
    svc.cleanupByNode("project", "proj1");
    ok(!svc.listRelated("project", "proj1").length, "project 清理后无 related");
  });

  console.log(`\nResult: passed=${passed} failed=${failed}`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => { console.error(e); process.exit(1); });
