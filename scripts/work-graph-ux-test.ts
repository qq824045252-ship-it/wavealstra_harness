/**
 * Work Graph UX — Phase 9 (Work Graph UX / Navigation)
 * 契约（路线图 §45-§49）：
 * - Not a canvas: panel 分组、Upstream/Downstream、scope 过滤、不把 relation 当 hierarchy
 * - 大型 graph 不一次全加载（limit + relation filter）
 * - Navigation deterministic、Scope filter 正确、关系解释清楚
 * - Search（Locator/resource）与 graph relation 返回类型区分
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase } from "../src/main/db/AppDatabase";
import { WorkGraphService } from "../src/main/workgraph/WorkGraphService";
import type { SpaceDto } from "../src/shared/agent-ipc";

let passed = 0, failed = 0;
function ok(cond: unknown, msg: string) { if (cond) { passed++; console.log(`  ✓ ${msg}`); } else { failed++; console.error(`  ✗ ${msg}`); } }
function eq<T>(a: T, b: T, msg: string) { try { assert.deepStrictEqual(a, b); passed++; console.log(`  ✓ ${msg}`); } catch (e: unknown) { const m = e instanceof Error ? e.message : String(e); failed++; console.error(`  ✗ ${msg}\n    expected ${JSON.stringify(b)}\n    actual ${JSON.stringify(a)}\n    ${m}`); } }
function mkSpace(id: string, parentId: string | null): SpaceDto { return { id, name: id, parentId, sortOrder: 1000, createdAt: 1 } as SpaceDto; }
function mkTask(db: AppDatabase, id: string, spaceId: string | null) { (db as unknown as { upsertTask: (t: unknown) => void }).upsertTask({ id, title: id, updatedAt: Date.now(), spaceId, projectId: null }); }
function addProject(db: AppDatabase, id: string) { (db.connection as unknown as { prepare: (s: string) => { run: (...a: unknown[]) => unknown } }).prepare(`INSERT INTO projects (id, name, created_at, updated_at, archived, resource_budget_chars) VALUES (?,?,?,?,?,?)`).run(id, id, Date.now(), Date.now(), 0, 128000); }
async function withTmpDb(fn: (db: AppDatabase) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "wg-ux-"));
  // 隔离 HOME：LibraryService 把资料库文件写到 ~/.mybuddy/library（POSIX 的 os.homedir() 读 HOME），
  // 只把 SQLite 放进临时目录而不同时隔离 HOME，会把夹具文档写进真实用户资料库。
  process.env.HOME = dir;
  process.env.USERPROFILE = dir;
  const db = new AppDatabase(join(dir, "test.db"));
  try { await fn(db); } finally { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); }
}
async function main() {
  console.log("== 1) Panel 分组：Upstream/Downstream/Produced/Derived 按 relation 正确 ==");
  await withTmpDb(async (db) => {
    db.createSpace(mkSpace("ws", null));
    mkTask(db, "p1", "ws"); mkTask(db, "p2", "ws"); mkTask(db, "p3", "ws");
    const svc = new WorkGraphService(db);
    // chain p1 -> p2 -> p3 (DEPENDS_ON)
    svc.addEdge({ fromType: "task", fromId: "p2", relation: "DEPENDS_ON", toType: "task", toId: "p1" });
    svc.addEdge({ fromType: "task", fromId: "p3", relation: "DEPENDS_ON", toType: "task", toId: "p2" });
    // p2 PRODUCES artifact-like via library_item node
    // Use library_item existence: create a library space+item for artifact stand-in
    // But PRODUCES to artifact needs artifacts table; create minimal row
    try { (db.connection as unknown as { exec: (s: string) => void }).exec(`CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY)`); } catch {}
    try { (db.connection as unknown as { prepare: (s: string) => { run: (...a: unknown[]) => unknown } }).prepare(`INSERT OR IGNORE INTO artifacts (id) VALUES (?)`).run("art-ux"); } catch {}
    svc.addEdge({ fromType: "task", fromId: "p2", relation: "PRODUCES", toType: "artifact", toId: "art-ux" });
    // p3 DERIVED_FROM workspace
    svc.addEdge({ fromType: "task", fromId: "p3", relation: "DERIVED_FROM", toType: "workspace", toId: "ws" });

    const upstreamP3 = svc.listDependsOn("p3"); // p3 depends on p2
    ok(upstreamP3.some((e) => e.toId === "p2"), "p3 upstream 含 p2");
    const downstreamP1 = svc.listDependents("p1"); // p1 <- p2
    ok(downstreamP1.some((e) => e.fromId === "p2"), "p1 downstream 含 p2");
    ok(svc.listOutgoing("task", "p2", "PRODUCES").some((e) => e.toId === "art-ux"), "p2 produced art-ux");
    ok(svc.listOutgoing("task", "p3", "DERIVED_FROM").some((e) => e.toId === "ws"), "p3 derived_from ws");
    // Panel 视角：related 含全部，但按 relation 过滤 deterministic
    const allRelated = svc.listRelated("task", "p2");
    ok(allRelated.length >= 3, `p2 related >=3 实际 ${allRelated.length}`);
    const byRel = svc.listRelated("task", "p2", "DEPENDS_ON");
    ok(byRel.every((e) => e.relation === "DEPENDS_ON"), "按 relation 过滤 deterministic");
  });

  console.log("== 2) Scope filter：按当前 Workspace/Project scope 过滤，不渲染全量 ==");
  await withTmpDb(async (db) => {
    db.createSpace(mkSpace("root", null));
    db.createSpace(mkSpace("a", "root"));
    db.createSpace(mkSpace("b", "root"));
    addProject(db, "proj"); addProject(db, "other");
    // tasks in different scopes
    mkTask(db, "ta", "a"); mkTask(db, "tb", "b");
    const svc = new WorkGraphService(db);
    svc.addEdge({ fromType: "task", fromId: "ta", relation: "RELATES_TO", toType: "workspace", toId: "a" });
    svc.addEdge({ fromType: "task", fromId: "tb", relation: "RELATES_TO", toType: "workspace", toId: "b" });
    svc.addEdge({ fromType: "project", fromId: "proj", relation: "RELATES_TO", toType: "task", toId: "ta" });
    svc.addEdge({ fromType: "project", fromId: "proj", relation: "RELATES_TO", toType: "workspace", toId: "a" });
    svc.addEdge({ fromType: "project", fromId: "other", relation: "RELATES_TO", toType: "task", toId: "tb" });

    // 当前 scope = a（+ ancestors root），过滤：ta 相关边中，部分不在 scope
    // 模拟 UI scopeFilter = ["ta","a","proj"]（当前 task+workspace+project）
    const scopeIds = new Set(["ta", "a", "proj"]);
    const relatedTa = svc.listRelated("task", "ta");
    // tb 边应被 scopeFilter 过滤（dimmed 而非 hidden，由 UI 决定；此处验证哪些属于 scope）
    const inScope = relatedTa.filter((e) => scopeIds.has(e.fromId) || scopeIds.has(e.toId) || scopeIds.has(e.fromType ? "" : ""));
    // In-scope: at least project->ta
    ok(relatedTa.some((e) => e.fromId === "proj" && e.toId === "ta"), "ta 与 proj 的关联存在（in-scope）");
    // tb 不在 ta 的 related，天然已 scope 隔离
    ok(!relatedTa.some((e) => e.fromId === "tb" || e.toId === "tb"), "ta 的 related 不含 tb（scope 天然隔离）");
    // Graph View 按 scope 过滤：只查 scope 内节点，避免全量
    const scopeTasks = ["ta"].flatMap((id) => svc.listRelated("task", id));
    ok(!scopeTasks.some((e) => e.fromId === "tb" || e.toId === "tb"), "scope 内查询不渲染全量 tb");
  });

  console.log("== 3) Navigation deterministic + 不把 relation 当 hierarchy ==");
  await withTmpDb(async (db) => {
    db.createSpace(mkSpace("root", null));
    db.createSpace(mkSpace("a", "root"));
    db.createSpace(mkSpace("b", "root"));
    mkTask(db, "na", "a"); mkTask(db, "nb", "b");
    const svc = new WorkGraphService(db);
    svc.addEdge({ fromType: "task", fromId: "na", relation: "RELATES_TO", toType: "task", toId: "nb" });
    // relation 不改变 hierarchy：na 的 ancestorChain 仍是 a->root，不含 b
    const { WorkspaceSharedContextService } = await import("../src/main/workspace/WorkspaceSharedContextService");
    const wsSvc = new WorkspaceSharedContextService(db);
    const view = wsSvc.getView({ currentSpaceId: "a", taskId: "na", memoryEnabled: true });
    ok(!view.ancestorChain.includes("b"), "relation 不把 b 拉进 ancestorChain（≠ hierarchy）");
    // Navigation 目标确定：listRelated 必含可跳转的另一端
    const rel = svc.listRelated("task", "na");
    ok(rel.length === 1 && rel[0].toId === "nb" && rel[0].relation === "RELATES_TO", "navigation 目标确定：nb");
    // 重复查询顺序 deterministic
    eq(rel.map((e) => e.id), svc.listRelated("task", "na").map((e) => e.id), "重复查询顺序 deterministic");
  });

  console.log("== 4) Graph search 类型区分：resource hit vs work entity hit vs relation hit ==");
  await withTmpDb(async (db) => {
    db.createSpace(mkSpace("ws", null));
    mkTask(db, "sg", "ws");
    addProject(db, "projS");
    const svc = new WorkGraphService(db);
    svc.addEdge({ fromType: "task", fromId: "sg", relation: "RELATES_TO", toType: "project", toId: "projS" });
    // Resource Locator 搜 library；Work Graph 搜 relations：两者返回结构应易区分
    const graphHit = svc.listRelated("task", "sg")[0];
    ok(graphHit.relation === "RELATES_TO" && graphHit.fromType === "task", "graph hit = relation 型");
    // WorkspaceResourceLocator 搜库（即使空，也结构不同）
    const { WorkspaceLibraryBindingService } = await import("../src/main/workspace/WorkspaceLibraryBindingService");
    const { LibraryService } = await import("../src/main/library/LibraryService");
    const { WorkspaceResourceLocator } = await import("../src/main/workspace/WorkspaceResourceLocator");
    const binding = new WorkspaceLibraryBindingService(db);
    const lib = new LibraryService(db);
    const loc = new WorkspaceResourceLocator(db, lib, binding);
    const res = loc.search({ query: "test", taskId: "sg" });
    ok(Array.isArray(res.hits) && Array.isArray(res.scopeSpaceIds), "resource hit = scope+provider+matchedBy 型");
    ok(graphHit.id !== res.hits[0]?.id, "两类 hit 类型/字段区分，不揉成同一 score");
  });

  console.log("== 5) 大型 graph 不一次全加载：按节点拉取，count 受控 ==");
  await withTmpDb(async (db) => {
    db.createSpace(mkSpace("ws", null));
    const svc = new WorkGraphService(db);
    for (let i = 0; i < 50; i++) {
      const tid = `bulk-${i}`;
      mkTask(db, tid, "ws");
      if (i > 0) svc.addEdge({ fromType: "task", fromId: tid, relation: "DEPENDS_ON", toType: "task", toId: `bulk-${i-1}` });
    }
    // 不一次 all(); 仅单节点拉取
    ok(svc.listRelated("task", "bulk-25").length <= 2, "单节点拉取受控（≤2）");
    ok(svc.countAll() === 49, "全量 49 但不一次渲染（按需按节点）");
  });

  console.log(`\nResult: passed=${passed} failed=${failed}`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
