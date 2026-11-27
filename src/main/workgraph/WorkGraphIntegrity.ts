/**
 * WorkGraphIntegrity — Phase 10 Operational Hardening
 * Read-only checks + explicit previewable repair (no silent mutation on boot).
 */
import type { AppDatabase } from "../db/AppDatabase";
import { WORK_GRAPH_DAG_RELATIONS, type WorkGraphEdgeDto, type WorkGraphRelation } from "../../shared/work-graph";

export interface IntegrityFinding {
  kind:
    | "orphan_edge" // entity missing on either end
    | "invalid_ref" // unknown node_type/relation
    | "dag_cycle" // DEPENDS_ON / SPAWNED cycle
    | "broken_library_binding" // workspace_library_links references missing space
    | "broken_cwd"; // tasks.space_id references missing/trashed space (informational)
  edgeId?: string;
  relation?: WorkGraphRelation;
  fromType?: string;
  fromId?: string;
  toType?: string;
  toId?: string;
  workspaceId?: string;
  librarySpaceId?: string;
  detail: string;
}

export interface IntegrityReport {
  checkedAt: number;
  findings: IntegrityFinding[];
  summary: Record<string, number>;
}

function hasEntity(db: AppDatabase, type: string, id: string): boolean {
  const conn = db.connection;
  switch (type) {
    case "workspace": return Boolean(conn.prepare(`SELECT 1 FROM spaces WHERE id=? LIMIT 1`).get(id));
    case "task": return Boolean(conn.prepare(`SELECT 1 FROM tasks WHERE id=? LIMIT 1`).get(id));
    case "project": return Boolean(conn.prepare(`SELECT 1 FROM projects WHERE id=? LIMIT 1`).get(id));
    case "plan": return Boolean(conn.prepare(`SELECT 1 FROM project_todos WHERE id=? LIMIT 1`).get(id));
    case "artifact": {
      const hasTable = conn.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='artifacts'`).get();
      if (!hasTable) return true;
      return Boolean(conn.prepare(`SELECT 1 FROM artifacts WHERE id=? LIMIT 1`).get(id));
    }
    case "library_item": {
      const hasTable = conn.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='library_items'`).get();
      if (!hasTable) return true;
      return Boolean(conn.prepare(`SELECT 1 FROM library_items WHERE id=? LIMIT 1`).get(id));
    }
    case "agent_run": return true; // ephemeral, no table
    default: return false;
  }
}

export async function scanIntegrity(db: AppDatabase): Promise<IntegrityReport> {
  const report = await db.runtimeAuditReader?.scanWorkGraphIntegrity();
  if (report) return report;
  if (!db.fixtureConnection) throw new Error("Core 未确认关联图完整性检查");
  return checkIntegrity(db);
}

function checkIntegrity(db: AppDatabase): IntegrityReport {
  const findings: IntegrityFinding[] = [];
  const conn = db.connection as unknown as {
    prepare: (s: string) => { all: (...a: unknown[]) => Array<Record<string, unknown>>; get: (...a: unknown[]) => unknown };
  };

  // 1) All edges: invalid ref + orphan + DAG cycles (by scanning outgoing)
  const allEdges: WorkGraphEdgeDto[] = (() => {
    try {
      const rows = conn.prepare(`SELECT * FROM work_graph_edges ORDER BY created_at, id`).all() as Array<{
        id: string; from_type: string; from_id: string; relation: string; to_type: string; to_id: string; metadata_json: string; created_at: number; updated_at: number;
      }>;
      return rows.map((r) => {
        let meta: Record<string, unknown> = {};
        try { meta = JSON.parse(r.metadata_json) as Record<string, unknown>; } catch {}
        return { id: r.id, fromType: r.from_type as WorkGraphEdgeDto["fromType"], fromId: r.from_id, relation: r.relation as WorkGraphEdgeDto["relation"], toType: r.to_type as WorkGraphEdgeDto["toType"], toId: r.to_id, metadata: meta, createdAt: r.created_at, updatedAt: r.updated_at };
      });
    } catch { return []; }
  })();

  for (const e of allEdges) {
    let orphan = true;
    try { orphan = !hasEntity(db, e.fromType, e.fromId) || !hasEntity(db, e.toType, e.toId); } catch {}
    if (orphan) {
      findings.push({
        kind: "orphan_edge",
        edgeId: e.id,
        relation: e.relation,
        fromType: e.fromType,
        fromId: e.fromId,
        toType: e.toType,
        toId: e.toId,
        detail: `orphan: ${e.fromType}:${e.fromId} --${e.relation}--> ${e.toType}:${e.toId}`,
      });
    }
  }

  // DAG cycles for DEPENDS_ON/SPAWNED (BFS per component)
  for (const rel of WORK_GRAPH_DAG_RELATIONS) {
    const edges = allEdges.filter((e) => e.relation === rel);
    // Build adjacency
    const adj = new Map<string, string[]>();
    const key = (t: string, id: string) => `${t}:${id}`;
    for (const e of edges) {
      const k = key(e.fromType, e.fromId);
      const v = key(e.toType, e.toId);
      const arr = adj.get(k) ?? [];
      arr.push(v);
      adj.set(k, arr);
    }
    // DFS cycle detection
    const visited = new Set<string>();
    const stack = new Set<string>();
    const dfs = (node: string, path: string[]): boolean => {
      if (stack.has(node)) {
        findings.push({
          kind: "dag_cycle",
          relation: rel,
          detail: `cycle ${rel}: ${[...path, node].join(" -> ")}`,
        });
        return true;
      }
      if (visited.has(node)) return false;
      visited.add(node);
      stack.add(node);
      for (const nb of adj.get(node) ?? []) {
        dfs(nb, [...path, node]);
        // continue to find all cycles, not early exit
      }
      stack.delete(node);
      return false;
    };
    for (const k of adj.keys()) dfs(k, []);
  }

  // 2) broken library bindings
  try {
    const bindings = conn.prepare(`SELECT workspace_id, library_space_id FROM workspace_library_links`).all() as Array<{ workspace_id: string; library_space_id: string }>;
    for (const b of bindings) {
      const wsExists = Boolean(conn.prepare(`SELECT 1 FROM spaces WHERE id=? LIMIT 1`).get(b.workspace_id));
      // library_spaces may be in separate table; not all libs have table, check via LibraryService fallback: just test library_spaces
      let libExists = true;
      try {
        const hasLibTable = conn.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='library_spaces'`).get();
        if (hasLibTable) libExists = Boolean(conn.prepare(`SELECT 1 FROM library_spaces WHERE id=? LIMIT 1`).get(b.library_space_id));
      } catch {}
      if (!wsExists || !libExists) {
        findings.push({
          kind: "broken_library_binding",
          workspaceId: b.workspace_id,
          librarySpaceId: b.library_space_id,
          detail: `binding ${b.workspace_id} ↔ ${b.library_space_id} missing ${!wsExists ? "workspace" : "library_space"}`,
        });
      }
    }
  } catch {}

  // 3) tasks.space_id dangling (informational, not auto-repaired)
  try {
    const tasks = conn.prepare(`SELECT id, space_id FROM tasks WHERE space_id IS NOT NULL`).all() as Array<{ id: string; space_id: string | null }>;
    for (const t of tasks) {
      if (!t.space_id) continue;
      const exists = Boolean(conn.prepare(`SELECT 1 FROM spaces WHERE id=? LIMIT 1`).get(t.space_id));
      if (!exists) {
        findings.push({
          kind: "broken_cwd",
          detail: `task ${t.id} space_id ${t.space_id} missing`,
        });
      }
    }
  } catch {}

  const summary: Record<string, number> = {};
  for (const f of findings) summary[f.kind] = (summary[f.kind] ?? 0) + 1;
  return { checkedAt: Date.now(), findings, summary };
}

export interface RepairPreview {
  willDeleteEdgeIds: string[];
  willDeleteBindingKeys: Array<{ workspaceId: string; librarySpaceId: string }>;
  note: string;
}

interface RepairCounts {
  deletedEdges: number;
  deletedBindings: number;
}

export type RuntimeWorkGraphRepairReply =
  | ({ status: "applied" } & RepairCounts)
  | { status: "rejected"; message: string }
  | { status: "needsHost" };

export function previewRepair(db: AppDatabase, report: IntegrityReport): RepairPreview {
  const willDeleteEdgeIds: string[] = [];
  const willDeleteBindingKeys: Array<{ workspaceId: string; librarySpaceId: string }> = [];
  for (const f of report.findings) {
    if (f.kind === "orphan_edge" && f.edgeId) willDeleteEdgeIds.push(f.edgeId);
    if (f.kind === "broken_library_binding" && f.workspaceId && f.librarySpaceId) {
      willDeleteBindingKeys.push({ workspaceId: f.workspaceId, librarySpaceId: f.librarySpaceId });
    }
  }
  // DAG cycles are not auto-repaired (need human decision); preview excludes them.
  return {
    willDeleteEdgeIds: [...new Set(willDeleteEdgeIds)],
    willDeleteBindingKeys,
    note: "Preview only: orphan edges + broken bindings. DAG cycles require manual edge removal.",
  };
}

export async function applyRepair(db: AppDatabase, preview: RepairPreview): Promise<RepairCounts> {
  if (!db.runtimeAuditReader) {
    if (!db.fixtureConnection) throw new Error("Core 关联图修复服务未连接");
    return applyRepairOnHost(db, preview);
  }
  const result = await db.runtimeAuditReader.applyWorkGraphRepair(preview);
  if (result?.status === "needsHost" && db.fixtureConnection) return applyRepairOnHost(db, preview);
  if (result?.status === "applied") {
    return { deletedEdges: result.deletedEdges, deletedBindings: result.deletedBindings };
  }
  throw new Error((result?.status === "rejected" && result.message) || "无法确认工作关系图修复结果，请重新扫描");
}

function applyRepairOnHost(db: AppDatabase, preview: RepairPreview): RepairCounts {
  const conn = db.connection;
  return conn.transaction(() => {
    let deletedEdges = 0;
    let deletedBindings = 0;
    const readEdge = conn.prepare<[string], {
      from_type: string; from_id: string; to_type: string; to_id: string;
    }>("SELECT from_type, from_id, to_type, to_id FROM work_graph_edges WHERE id=?");
    const deleteEdge = conn.prepare("DELETE FROM work_graph_edges WHERE id=?");
    for (const id of preview.willDeleteEdgeIds) {
      const edge = readEdge.get(id);
      if (edge && (!hasEntity(db, edge.from_type, edge.from_id) || !hasEntity(db, edge.to_type, edge.to_id))) {
        deletedEdges += deleteEdge.run(id).changes;
      }
    }
    const hasLibraryTable = conn.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='library_spaces'").get();
    const validLibrary = hasLibraryTable ? "AND EXISTS(SELECT 1 FROM library_spaces WHERE id=@librarySpaceId)" : "";
    const deleteBinding = conn.prepare(`DELETE FROM workspace_library_links
      WHERE workspace_id=@workspaceId AND library_space_id=@librarySpaceId
        AND NOT (EXISTS(SELECT 1 FROM spaces WHERE id=@workspaceId) ${validLibrary})`);
    for (const { workspaceId, librarySpaceId } of preview.willDeleteBindingKeys) {
      deletedBindings += deleteBinding.run({ workspaceId, librarySpaceId }).changes;
    }
    return { deletedEdges, deletedBindings };
  }).immediate();
}
