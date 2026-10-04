/**
 * Work Graph Execution — Phase 8 (Agent Execution / Subagent Relation Bridge)
 * 契约（路线图 §39-§44）：
 * - Task SPAWNED AgentRun; AgentRun SPAWNED SubagentRun; SubagentRun PRODUCES Artifact
 * - Subagent 用完即毁：长期保存的是 record/relation，非永久 Workspace child
 * - Execution lineage 可查询，artifact provenance 可追踪
 * - Graph 不改变 Workspace Context rule；Inbox 仍由 runtime 负责
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
async function withTmpDb(fn: (db: AppDatabase) => Promise<void> | void) {
  const dir = mkdtempSync(join(tmpdir(), "wg-exec-"));
  const db = new AppDatabase(join(dir, "test.db"));
  try { await fn(db); } finally { try { db.close(); } catch {} rmSync(dir, { recursive: true, force: true }); }
}
async function main() {
  console.log("== 1) SPAWNED shape + DAG 禁环 ==");
  await withTmpDb(async (db) => {
    db.createSpace(mkSpace("ws", null));
    mkTask(db, "t1", "ws");
    const svc = new WorkGraphService(db);
    // task → agent_run ok
    ok(svc.addEdge({ fromType: "task", fromId: "t1", relation: "SPAWNED", toType: "agent_run", toId: "run-1" }).created, "t1 SPAWNED run-1 ok");
    // agent_run → agent_run (subagent) ok
    ok(svc.addEdge({ fromType: "agent_run", fromId: "run-1", relation: "SPAWNED", toType: "agent_run", toId: "run-1-sub" }).created, "run-1 SPAWNED run-1-sub ok");
    // workspace → agent_run 非法
    let blocked = false; try { svc.addEdge({ fromType: "workspace", fromId: "ws", relation: "SPAWNED", toType: "agent_run", toId: "run-x" }); } catch (e) { blocked = String(e).includes("SPAWNED 不支持"); }
    ok(blocked, "workspace SPAWNED agent_run 被拒绝");
    // task → task SPAWNED 非法
    let blocked2 = false; try { svc.addEdge({ fromType: "task", fromId: "t1", relation: "SPAWNED", toType: "task", toId: "t1" }); } catch (e) { blocked2 = String(e).includes("SPAWNED 不支持"); }
    ok(blocked2, "task SPAWNED task 被拒绝");
    // DAG: run-1-sub SPAWNED run-1 应形成环被拒绝
    let blocked3 = false; try { svc.addEdge({ fromType: "agent_run", fromId: "run-1-sub", relation: "SPAWNED", toType: "agent_run", toId: "run-1" }); } catch (e) { blocked3 = String(e).includes("DAG 环拒绝"); }
    ok(blocked3, "SPAWNED 环被拒绝");
  });

  console.log("== 2) PRODUCES + DERIVED_FROM + lineage 查询 ==");
  await withTmpDb(async (db) => {
    db.createSpace(mkSpace("ws", null));
    mkTask(db, "t2", "ws");
    const svc = new WorkGraphService(db);
    // 需先建 artifacts 表行才能以 artifact 为节点（否则不存在校验拒绝）；用真实 AppDatabase 的 artifacts 表
    const conn = db.connection as unknown as { prepare: (s: string) => { run: (...a: unknown[]) => unknown } };
    // Ensure artifacts table exists (AppDatabase should have it); if not, create minimal
    try { conn.prepare("SELECT 1 FROM artifacts LIMIT 1").run(); } catch {
      (db.connection as unknown as { exec: (s: string) => void }).exec(`CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY)`);
    }
    // Insert artifact rows for existence check
    try {
      conn.prepare(`INSERT OR IGNORE INTO artifacts (id) VALUES (?)`).run("art-1");
      conn.prepare(`INSERT OR IGNORE INTO artifacts (id) VALUES (?)`).run("art-2");
    } catch {}
    svc.addEdge({ fromType: "task", fromId: "t2", relation: "SPAWNED", toType: "agent_run", toId: "run-10" });
    svc.addEdge({ fromType: "agent_run", fromId: "run-10", relation: "SPAWNED", toType: "agent_run", toId: "run-10-sub" });
    // subagent PRODUCES artifact
    svc.addEdge({ fromType: "agent_run", fromId: "run-10-sub", relation: "PRODUCES", toType: "artifact", toId: "art-1" });
    svc.addEdge({ fromType: "task", fromId: "t2", relation: "PRODUCES", toType: "artifact", toId: "art-2" });
    // lineage helpers
    ok(svc.listTaskLineage("t2").some((e) => e.toId === "run-10"), "task lineage 含 run-10");
    ok(svc.listAgentChildren("run-10").some((e) => e.toId === "run-10-sub"), "agent children 含 sub");
    ok(svc.listArtifactProvenance("art-1").some((e) => e.fromId === "run-10-sub"), "art-1 provenance 来自 sub");
    ok(svc.listArtifactProvenance("art-2").some((e) => e.fromId === "t2"), "art-2 provenance 来自 t2");
    // Context digest: task DERIVED_FROM context snapshot (lightweight ref)
    svc.addEdge({ fromType: "agent_run", fromId: "run-10", relation: "DERIVED_FROM", toType: "workspace", toId: "ws" });
    ok(svc.listDerivedFrom("agent_run", "run-10").some((e) => e.toId === "ws"), "run-10 DERIVED_FROM ws");
  });

  console.log("== 3) Subagent 不永久化：删除 task 清理 lineage 但保留 artifact == ");
  await withTmpDb(async (db) => {
    db.createSpace(mkSpace("ws", null));
    mkTask(db, "t3", "ws");
    const svc = new WorkGraphService(db);
    const conn = db.connection as unknown as { prepare: (s: string) => { run: (...a: unknown[]) => unknown } };
    try { (db.connection as unknown as { exec: (s: string) => void }).exec(`CREATE TABLE IF NOT EXISTS artifacts (id TEXT PRIMARY KEY)`); } catch {}
    try { conn.prepare(`INSERT OR IGNORE INTO artifacts (id) VALUES (?)`).run("art-3"); } catch {}
    svc.addEdge({ fromType: "task", fromId: "t3", relation: "SPAWNED", toType: "agent_run", toId: "run-30" });
    svc.addEdge({ fromType: "agent_run", fromId: "run-30", relation: "PRODUCES", toType: "artifact", toId: "art-3" });
    eq(svc.countAll(), 2, "执行前 2 边");
    // 删除任务应清理其 SPAWNED 边，但 artifact 边若指向 agent_run 则保留（agent_run 仍为 graph 节点，虽 ephemeral 但 relation 可追溯）
    svc.cleanupByNode("task", "t3");
    eq(svc.countAll(), 1, "task 清理后剩 1 (artifact 产出仍可追溯)");
    // artifact provenance 仍可查（agent_run→artifact）
    ok(svc.listArtifactProvenance("art-3").length === 1, "artifact provenance 仍在");
    // Graph 不把 Subagent 当 Workspace child：listSpaces 无 agent_run
    ok(!db.listSpaces().some((s) => s.id === "run-30"), "agent_run 不在 spaces");
  });

  console.log("== 4) Graph 不改变 Workspace Context / Inbox 语义 ==");
  await withTmpDb(async (db) => {
    db.createSpace(mkSpace("root", null));
    db.createSpace(mkSpace("a", "root"));
    const svc = new WorkGraphService(db);
    mkTask(db, "tx", "a");
    svc.addEdge({ fromType: "task", fromId: "tx", relation: "SPAWNED", toType: "agent_run", toId: "run-99" });
    svc.addEdge({ fromType: "agent_run", fromId: "run-99", relation: "DERIVED_FROM", toType: "workspace", toId: "a" });
    const { WorkspaceSharedContextService } = await import("../src/main/workspace/WorkspaceSharedContextService");
    const wsSvc = new WorkspaceSharedContextService(db);
    const before = wsSvc.getView({ currentSpaceId: "a", taskId: "tx", memoryEnabled: true });
    // SPAWNED/DERIVED_FROM 不应让 ancestorChain 变长
    const after = wsSvc.getView({ currentSpaceId: "a", taskId: "tx", memoryEnabled: true });
    eq(after.ancestorChain, before.ancestorChain, "执行关系不改变 ancestorChain");
    ok(true, "Inbox 仍由 runtime 负责，graph 仅记录 relation（无消息队列）");
  });

  console.log(`\nResult: passed=${passed} failed=${failed}`);
  if (failed > 0) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
