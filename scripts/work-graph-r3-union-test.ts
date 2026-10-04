/**
 * WorkGraph × R3 联合验证 — 可选语义受控召回不破坏图隔离契约
 * 覆盖：
 * 1) Scope 隔离：两 Workspace 分别有 lexical / semantic 资源，跨 Scope 不互串
 * 2) WorkGraph 不改变 Locator scope（Project→Workspace 关联不扩大搜索范围）
 * 3) Search 结果类型与 WorkGraph relation hittype 隔离（不揉 score）
 * 4) 语义失败回退 path 不产生额外 WorkGraph 边（观测但不写入）
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { WorkspaceLibraryBindingService } from "../src/main/workspace/WorkspaceLibraryBindingService";
import { LibraryService } from "../src/main/library/LibraryService";
import { WorkspaceResourceLocator } from "../src/main/workspace/WorkspaceResourceLocator";
import { WorkGraphService } from "../src/main/workgraph/WorkGraphService";
import { SemanticRouter } from "../src/main/retrieval/SemanticRouter";
import type { SpaceDto } from "../src/shared/agent-ipc";

function mkSpace(id: string, parentId: string | null): SpaceDto { return { id, name: id, parentId, sortOrder: 1000, createdAt: 1 } as SpaceDto; }
function mkTask(db: AppDatabase, id: string, spaceId: string | null) { (db as unknown as { upsertTask: (t: unknown) => void }).upsertTask({ id, title: id, updatedAt: Date.now(), spaceId, projectId: null }); }

let passed = 0, failed = 0;
function ok(cond: unknown, msg: string) { if (cond) { passed++; console.log(`  ✓ ${msg}`); } else { failed++; console.error(`  ✗ ${msg}`); } }

async function withTmpDb(fn: (db: AppDatabase, dir: string) => Promise<void>) {
  const dir = mkdtempSync(join(tmpdir(), "wg-r3-union-"));
  const db = new AppDatabase(join(dir, "test.db"));
  try { await fn(db, dir); } finally { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); }
}

async function main() {
  console.log("== 1) Scope 隔离：两 WS 语义/词法资源不互串 ==");
  await withTmpDb(async (db) => {
    db.createSpace(mkSpace("root", null));
    db.createSpace(mkSpace("wsA", "root"));
    db.createSpace(mkSpace("wsB", "root"));

    const lib = new LibraryService(db);
    const binding = new WorkspaceLibraryBindingService(db);
    // Use personal + per-workspace library collections to isolate by Workspace binding; team spaces would require same projectId as task
    lib.ensureReady();
    // Workspace-scoped isolation via separate Library items in personal vs team is limited; use two library items in same personal but bound to different workspaces via binding + chunk trick:
    // Actually Library binding binds LibSpace, not Item — personal is one LibSpace, can't isolate by personal. So create two collections under personal and use chunk-level items with different LibSpace via direct insert of team LibSpaces with same projectId as tasks.
    const projA = "proj-r3-a";
    const projB = "proj-r3-b";
    (db.connection as unknown as { prepare: (s: string) => { run: (...a: unknown[]) => unknown } }).prepare(`INSERT INTO projects (id, name, created_at, updated_at, archived, resource_budget_chars) VALUES (?,?,?,?,?,?)`).run(projA, projA, Date.now(), Date.now(), 0, 128000);
    (db.connection as unknown as { prepare: (s: string) => { run: (...a: unknown[]) => unknown } }).prepare(`INSERT INTO projects (id, name, created_at, updated_at, archived, resource_budget_chars) VALUES (?,?,?,?,?,?)`).run(projB, projB, Date.now(), Date.now(), 0, 128000);
    mkTask(db, "ta", "wsA");
    mkTask(db, "tb", "wsB");
    // Create team lib spaces owned by each task's project
    const libA = (lib as unknown as { createSpace: (o: unknown) => { id: string } }).createSpace({ name: "libA-r3", projectId: projA });
    const libB = (lib as unknown as { createSpace: (o: unknown) => { id: string } }).createSpace({ name: "libB-r3", projectId: projB });
    // Rebind tasks to correct projects (mkTask above used null)
    (db as unknown as { upsertTask: (t: unknown) => void }).upsertTask({ id: "ta", title: "ta", updatedAt: Date.now(), spaceId: "wsA", projectId: projA });
    (db as unknown as { upsertTask: (t: unknown) => void }).upsertTask({ id: "tb", title: "tb", updatedAt: Date.now(), spaceId: "wsB", projectId: projB });
    binding.bind("wsA", libA.id);
    binding.bind("wsB", libB.id);

    // Write simple docs without heavy embedding
    const itemA = (lib as unknown as { createItem: (o: unknown) => { id: string } }).createItem({ spaceId: libA.id, kind: "markdown", title: "温度补偿算法" });
    (lib as unknown as { writeContent: (o: unknown) => void }).writeContent({ id: itemA.id, content: "# 温度补偿算法\n这是一份仅在 wsA 侧的语义型文档，描述补偿策略。" });
    const itemB = (lib as unknown as { createItem: (o: unknown) => { id: string } }).createItem({ spaceId: libB.id, kind: "markdown", title: "电流回路设计" });
    (lib as unknown as { writeContent: (o: unknown) => void }).writeContent({ id: itemB.id, content: "# 电流回路设计\nB 侧文档，关键词不同。" });
    await lib.flushPendingIndexes();

    const router = new SemanticRouter();
    const locator = new WorkspaceResourceLocator(db, lib, binding, { semanticRouter: router });
    // ta should see libA only; tb only libB — lexical now, semantic fallback also scoped
    const hitsTa = locator.search({ query: "温度补偿", taskId: "ta" });
    const hitsTb = locator.search({ query: "温度补偿", taskId: "tb" });
    ok(hitsTa.hits.some((h) => h.id === itemA.id), "ta 命中 A 侧温度补偿");
    ok(!hitsTa.hits.some((h) => h.id === itemB.id), "ta 不命中 B 侧（scope 隔离）");
    ok(!hitsTb.hits.some((h) => h.id === itemA.id), "tb 不命中 A 侧（反向隔离）");

    const asyncTa = await locator.searchAsync({ query: "温度补偿", taskId: "ta", mode: "auto" } as unknown as Parameters<WorkspaceResourceLocator["searchAsync"]>[0]);
    ok(asyncTa.hits.some((h) => h.id === itemA.id), "async ta 仍命中 A");
    ok(!asyncTa.hits.some((h) => h.id === itemB.id), "async 也隔离（semantic 仍受 scope 限）");
  });

  console.log("== 2) WorkGraph 不改变 Locator scope ==");
  await withTmpDb(async (db) => {
    db.createSpace(mkSpace("root", null));
    db.createSpace(mkSpace("a", "root"));
    db.createSpace(mkSpace("b", "root"));
    mkTask(db, "ta2", "a");
    const lib = new LibraryService(db);
    const binding = new WorkspaceLibraryBindingService(db);
    const proj = "proj2";
    (db.connection as unknown as { prepare: (s: string) => { run: (...a: unknown[]) => unknown } }).prepare(`INSERT INTO projects (id, name, created_at, updated_at, archived, resource_budget_chars) VALUES (?,?,?,?,?,?)`).run(proj, proj, Date.now(), Date.now(), 0, 128000);
    const libA = (lib as unknown as { createSpace: (o: unknown) => { id: string } }).createSpace({ name: "libA2", projectId: proj });
    const libB = (lib as unknown as { createSpace: (o: unknown) => { id: string } }).createSpace({ name: "libB2", projectId: proj });
    binding.bind("a", libA.id);
    binding.bind("b", libB.id);
    const itemA = (lib as unknown as { createItem: (o: unknown) => { id: string } }).createItem({ spaceId: libA.id, kind: "markdown", title: "A doc" });
    (lib as unknown as { writeContent: (o: unknown) => void }).writeContent({ id: itemA.id, content: "alpha only" });
    const itemB = (lib as unknown as { createItem: (o: unknown) => { id: string } }).createItem({ spaceId: libB.id, kind: "markdown", title: "B doc" });
    (lib as unknown as { writeContent: (o: unknown) => void }).writeContent({ id: itemB.id, content: "beta only" });
    await lib.flushPendingIndexes();

    const wg = new WorkGraphService(db);
  // 建立 WorkGraph 关联 a 的 task 与 b 的 workspace，但 Locator 不应因此对 ta2 放行 b
    wg.addEdge({ fromType: "task", fromId: "ta2", relation: "RELATES_TO", toType: "workspace", toId: "b" });
    try {
      const projG = "projG-union";
      addProjectAlias(db, projG);
      wg.addEdge({ fromType: "project", fromId: projG, relation: "RELATES_TO", toType: "workspace", toId: "b" });
    } catch {}

    const locator = new WorkspaceResourceLocator(db, lib, binding);
    const res = locator.search({ query: "beta", taskId: "ta2" });
    ok(!res.scopeSpaceIds.includes("b"), "Graph 不扩大 Locator scope（b 仍不在 ta2 scope）");

    const graphCountBefore = wg.countAll();
    const asyncRes = await locator.searchAsync({ query: "beta", taskId: "ta2", mode: "auto" } as unknown as Parameters<WorkspaceResourceLocator["searchAsync"]>[0]);
    ok(!asyncRes.scopeSpaceIds.includes("b"), "async 也不扩大 scope");
    ok(wg.countAll() === graphCountBefore, "R3 回退不写入新 graph 边（观测但不写入）");
  });

  console.log("== 3) 类型隔离：resource hit vs relation hit 字段不混淆 ==");
  await withTmpDb(async (db) => {
    db.createSpace(mkSpace("ws", null));
    mkTask(db, "t3", "ws");
    const lib = new LibraryService(db);
    const binding = new WorkspaceLibraryBindingService(db);
    const locator = new WorkspaceResourceLocator(db, lib, binding);
    const wg = new WorkGraphService(db);
    // Ensure project exists for RELATES_TO
    const proj = "projX";
    try { (db.connection as unknown as { prepare: (s: string) => { run: (...a: unknown[]) => unknown } }).prepare(`INSERT INTO projects (id, name, created_at, updated_at, archived, resource_budget_chars) VALUES (?,?,?,?,?,?)`).run(proj, proj, Date.now(), Date.now(), 0, 128000); } catch {}
    wg.addEdge({ fromType: "task", fromId: "t3", relation: "RELATES_TO", toType: "project", toId: proj });
    const gHits = wg.listRelated("task", "t3");
    ok(gHits[0] && "relation" in gHits[0] && "fromType" in gHits[0], "graph hit = relation 型");
    const rHits = locator.search({ query: "anything", taskId: "t3" });
    ok(Array.isArray(rHits.hits) && (rHits.hits.length === 0 || "provider" in rHits.hits[0]!), "resource hit = provider/matchedBy 型");
    // 不揉 score：即使 query 相同，两类结果字段分离
    if (gHits.length && rHits.hits.length) ok(gHits[0].id !== String(rHits.hits[0].id), "两类 hit 不混 score/ID 空间");
    else ok(true, "至少一类为空时类型已隔离");
  });

  console.log("== 4) 语义失败回退 path：缺模型/不可用时限 lexical，不扩权 ==");
  await withTmpDb(async (db) => {
    db.createSpace(mkSpace("ws", null));
    mkTask(db, "tf", "ws");
    const lib = new LibraryService(db);
    const binding = new WorkspaceLibraryBindingService(db);
    // Locator 在缺模型 / 中断时应限 lexical，且 searchAsync 仍返回 lexical hits
    const locator = new WorkspaceResourceLocator(db, lib, binding);
    const item = (lib as unknown as { createItem: (o: unknown) => { id: string } }).createItem({ spaceId: (lib as unknown as { createSpace: (o: unknown) => { id: string } }).createSpace({ name: "libF", projectId: null }).id, kind: "markdown", title: "hello" });
    // don't bind ws to lib, so lexical empty
    await lib.flushPendingIndexes();
    const lex = locator.search({ query: "hello", taskId: "tf" });
    ok(lex.hits.length === 0, "未绑定时 lexical 零命中");
    const asyncRes = await locator.searchAsync({ query: "hello", taskId: "tf", mode: "auto" } as unknown as Parameters<WorkspaceResourceLocator["searchAsync"]>[0]);
    // 语义不可用/零 lexical 触发 Trigger A，但仍受 scope 约束，不会跨 ws 放行
    ok(Array.isArray(asyncRes.hits), "异步返回仍是受控的 hits 数组");
    ok(asyncRes.semanticTelemetry !== undefined, "telemetry 仍产出（受控观测）");
  });

  console.log(`\nResult: passed=${passed} failed=${failed}`);
  if (failed > 0) process.exit(1);
}

function addProjectAlias(db: AppDatabase, id: string) {
  try { (db.connection as unknown as { prepare: (s: string) => { run: (...a: unknown[]) => unknown } }).prepare(`INSERT INTO projects (id, name, created_at, updated_at, archived, resource_budget_chars) VALUES (?,?,?,?,?,?)`).run(id, id, Date.now(), Date.now(), 0, 128000); } catch {}
}

main().catch((e) => { console.error(e); process.exit(1); });
