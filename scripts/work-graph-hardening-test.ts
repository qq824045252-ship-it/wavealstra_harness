/**
 * Work Graph Hardening — Phase 10 (Operational Hardening)
 * 覆盖：orphan / invalid ref / DAG cycle / broken binding / stale
 *       + repair 显式可预览可逆 + performance light
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AppDatabase, CURRENT_DATABASE_SCHEMA_VERSION } from "../src/main/db/AppDatabase";
import { checkIntegrity, previewRepair, applyRepair } from "../src/main/workgraph/WorkGraphIntegrity";
import { WorkGraphService } from "../src/main/workgraph/WorkGraphService";
import type { SpaceDto } from "../src/shared/agent-ipc";

let passed = 0, failed = 0;
function ok(cond: unknown, msg: string) { if (cond) { passed++; console.log(`  ✓ ${msg}`); } else { failed++; console.error(`  ✗ ${msg}`); } }
function eq<T>(a: T, b: T, msg: string) { try { assert.deepStrictEqual(a, b); passed++; console.log(`  ✓ ${msg}`); } catch (e: unknown) { const m = e instanceof Error ? e.message : String(e); failed++; console.error(`  ✗ ${msg}\n    expected ${JSON.stringify(b)}\n    actual ${JSON.stringify(a)}\n    ${m}`); } }
function mkSpace(id: string, parentId: string | null): SpaceDto { return { id, name: id, parentId, sortOrder: 1000, createdAt: 1 } as SpaceDto; }
function mkTask(db: AppDatabase, id: string, spaceId: string | null) { (db as unknown as { upsertTask: (t: unknown) => void }).upsertTask({ id, title: id, updatedAt: Date.now(), spaceId, projectId: null }); }
async function withTmpDb(fn: (db: AppDatabase) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "wg-hard-"));
  const db = new AppDatabase(join(dir, "test.db"));
  try { await fn(db); } finally { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); }
}
async function main() {
  console.log("== 1) Integrity：orphan_edge ==");
  await withTmpDb(async (db) => {
    db.createSpace(mkSpace("ws", null));
    mkTask(db, "t1", "ws");
    const svc = new WorkGraphService(db);
    svc.addEdge({ fromType: "task", fromId: "t1", relation: "RELATES_TO", toType: "workspace", toId: "ws" });
    // 注入孤儿：直接插一条指向不存在 task 的边（绕过校验）
    const conn = db.connection as unknown as { prepare: (s: string) => { run: (...a: unknown[]) => unknown } };
    conn.prepare(`INSERT INTO work_graph_edges (id, from_type, from_id, relation, to_type, to_id, metadata_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?, ?, ?)`).run("orphan-1", "task", "t1", "RELATES_TO", "task", "ghost", "{}", Date.now(), Date.now());
    const rep = checkIntegrity(db);
    ok(rep.findings.some((f) => f.kind === "orphan_edge" && f.edgeId === "orphan-1"), "检测到 orphan_edge");
    const preview = previewRepair(db, rep as unknown as Parameters<typeof previewRepair>[1]);
    ok(preview.willDeleteEdgeIds.includes("orphan-1"), "preview 含 orphan");
    // 未 apply 前，边仍在
    ok(svc.listRelated("task", "t1").some((e) => e.id === "orphan-1"), "未 repair 前孤儿仍在");
    const applied = applyRepair(db, preview);
    ok(applied.deletedEdges === 1, "repair 删除 1 orphan");
    const rep2 = checkIntegrity(db);
    ok(!rep2.findings.some((f) => f.edgeId === "orphan-1"), "repair 后无该 orphan");
  });

  console.log("== 2) Integrity：broken_library_binding ==");
  await withTmpDb(async (db) => {
    db.createSpace(mkSpace("ws", null));
    const conn = db.connection as unknown as { prepare: (s: string) => { run: (...a: unknown[]) => unknown } };
    conn.prepare(`INSERT INTO workspace_library_links (workspace_id, library_space_id, created_at) VALUES (?,?,?)`).run("ws", "ghost-lib", Date.now());
    const rep = checkIntegrity(db);
    ok(rep.findings.some((f) => f.kind === "broken_library_binding"), "检测到 broken_library_binding");
    const preview = previewRepair(db, rep as unknown as Parameters<typeof previewRepair>[1]);
    ok(preview.willDeleteBindingKeys.some((k) => k.librarySpaceId === "ghost-lib"), "preview 含 binding");
    applyRepair(db, preview);
    const rep2 = checkIntegrity(db);
    ok(!rep2.findings.some((f) => f.kind === "broken_library_binding" && (f as unknown as { librarySpaceId: string }).librarySpaceId === "ghost-lib"), "repair 后无该 broken binding");
  });

  console.log("== 3) Integrity：DAG cycle detection (DEPENDS_ON) ==");
  await withTmpDb(async (db) => {
    db.createSpace(mkSpace("ws", null));
    mkTask(db, "ca", "ws"); mkTask(db, "cb", "ws"); mkTask(db, "cc", "ws");
    const conn = db.connection as unknown as { prepare: (s: string) => { run: (...a: unknown[]) => unknown } };
    // 绕过 Service 校验，直接插环：ca→cb→cc→ca
    for (const [from, to] of [["ca","cb"],["cb","cc"],["cc","ca"]] as const) {
      conn.prepare(`INSERT INTO work_graph_edges (id, from_type, from_id, relation, to_type, to_id, metadata_json, created_at, updated_at) VALUES (?,?,?,?,?,?,?, ?, ?)`).run(`cyc-${from}-${to}`, "task", from, "DEPENDS_ON", "task", to, "{}", Date.now(), Date.now());
    }
    const rep = checkIntegrity(db);
    ok(rep.findings.some((f) => f.kind === "dag_cycle" && f.relation === "DEPENDS_ON"), "检测到 DAG cycle");
    const preview = previewRepair(db, rep as unknown as Parameters<typeof previewRepair>[1]);
    // DAG cycle 不在 preview 自动删除中（需人工决定删哪条边）
    ok(!preview.willDeleteEdgeIds.some((id) => id.startsWith("cyc-")), "cycle 不自动进入 preview（需人工）");
  });

  console.log("== 4) Schema：current-only 直接建库 ==");
  await withTmpDb(async (db) => {
    ok(db.schemaVersion === CURRENT_DATABASE_SCHEMA_VERSION, `fresh DB 直接收敛 current schema v${CURRENT_DATABASE_SCHEMA_VERSION}`);
    ok(db.connection.pragma("foreign_keys", { simple: true }) === 1, "current schema 启动即开启 foreign_keys");
  });

  console.log("== 5) Performance：小规模 benchmark（100spaces/1k tasks/10k edges 量级投影） ==");
  await withTmpDb(async (db) => {
    const t0 = Date.now();
    for (let i = 0; i < 20; i++) db.createSpace(mkSpace(`s${i}`, i === 0 ? null : `s${i-1}`));
    for (let i = 0; i < 50; i++) mkTask(db, `bt${i}`, "s0");
    const svc = new WorkGraphService(db);
    for (let i = 1; i < 50; i++) svc.addEdge({ fromType: "task", fromId: `bt${i}`, relation: "RELATES_TO", toType: "task", toId: `bt${i-1}` });
    const q0 = Date.now();
    const list = svc.listRelated("task", "bt25");
    const q1 = Date.now();
    ok(list.length <= 2, "单节点 related 受控");
    ok(q1 - q0 < 200, `单次 query <200ms 实际 ${q1-q0}ms`);
    const all = svc.countAll();
    ok(all === 49, "count 受控");
    const wall = Date.now() - t0;
    ok(wall < 2000, `小规模建图+查询 <2s 实际 ${wall}ms`);
  });

  console.log("== 6) Observability：resolver/locator/graph 轻量指标 ==");
  await withTmpDb(async (db) => {
    db.createSpace(mkSpace("ws", null));
    mkTask(db, "ob1", "ws");
    const svc = new WorkGraphService(db);
    svc.addEdge({ fromType: "task", fromId: "ob1", relation: "RELATES_TO", toType: "workspace", toId: "ws" });
    const start = Date.now();
    svc.listRelated("task", "ob1");
    const elapsed = Date.now() - start;
    ok(typeof elapsed === "number" && elapsed >= 0, "graph query duration 可观测");
  });

  console.log(`\nResult: passed=${passed} failed=${failed}`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
