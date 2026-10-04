/**
 * WorkGraphService — Phase 6/7 (ADR-001)
 *
 * Centralized validation for typed relation graph.
 * - Entity existence validation (real Service/DB existence)
 * - Relation validation (only allowed relations)
 * - Duplicate validation (unique constraint idempotent)
 * - Cycle validation (only DEPENDS_ON is DAG; others may cycle)
 * - Shape validation for BELONGS_TO / CONTAINS (domain bridge, Phase 7)
 * - Delete cleanup (explicit, no FK cascade on business data)
 *
 * Graph never changes Workspace Context or Permission.
 * Phase 7 bridge relations (BELONGS_TO/CONTAINS) are graph-owned;
 * tasks.space_id / project_todos.project_id remain Source of Truth (not dual-written).
 */
import { randomUUID } from "node:crypto";
import type { AppDatabase } from "../db/AppDatabase";
import {
  WORK_GRAPH_DAG_RELATIONS,
  WORK_GRAPH_NODE_TYPES,
  WORK_GRAPH_RELATIONS,
  type WorkGraphAddEdgeRequest,
  type WorkGraphEdgeDto,
  type WorkGraphNodeType,
  type WorkGraphRelation,
} from "../../shared/work-graph";
import { WorkGraphRepository } from "./WorkGraphRepository";

const NODE_TYPES = new Set<string>(WORK_GRAPH_NODE_TYPES as unknown as string[]);
const RELATIONS = new Set<string>(WORK_GRAPH_RELATIONS as unknown as string[]);

export class WorkGraphService {
  private readonly repo: WorkGraphRepository;

  constructor(private readonly db: AppDatabase) {
    this.repo = new WorkGraphRepository(db);
  }

  /** Add typed edge with full validation; returns existing edge on duplicate (idempotent). */
  addEdge(req: WorkGraphAddEdgeRequest): { edge: WorkGraphEdgeDto; created: boolean } {
    const fromType = this.requireNodeType(req.fromType);
    const toType = this.requireNodeType(req.toType);
    const relation = this.requireRelation(req.relation);
    const fromId = this.requireNonEmpty(req.fromId, "fromId");
    const toId = this.requireNonEmpty(req.toId, "toId");
    if (fromType === toType && fromId === toId && relation === "DEPENDS_ON") {
      throw new Error("DEPENDS_ON 不允许自环");
    }
    // Phase 7 shape validation
    this.assertRelationShape(fromType, toType, relation);

    this.assertEntityExists(fromType, fromId);
    this.assertEntityExists(toType, toId);

    // Duplicate check (idempotent)
    const existing = this.repo.findByUnique(fromType, fromId, relation, toType, toId);
    if (existing) {
      const dto = this.toDto(existing);
      return { edge: dto, created: false };
    }

    // DAG cycle check only for DAG relations
    if (WORK_GRAPH_DAG_RELATIONS.has(relation)) {
      if (this.wouldCreateDagCycle(fromType, fromId, toType, toId, relation)) {
        throw new Error(`DAG 环拒绝：${fromType}:${fromId} --${relation}--> ${toType}:${toId} 将形成环`);
      }
    }

    const now = Date.now();
    const id = randomUUID();
    const metadata = this.normalizeMetadata(req.metadata);
    this.repo.insertEdge(
      WorkGraphRepository.toRow({
        id,
        fromType,
        fromId,
        relation,
        toType,
        toId,
        metadata,
        now,
      }),
    );
    const row = this.repo.findById(id);
    if (!row) throw new Error("写入后未找到 edge");
    return { edge: this.toDto(row), created: true };
  }

  removeEdge(id: string): boolean {
    const trimmed = id?.trim();
    if (!trimmed) throw new Error("id 不能为空");
    return this.repo.deleteById(trimmed) > 0;
  }

  listOutgoing(
    type: WorkGraphNodeType,
    id: string,
    relation?: WorkGraphRelation,
  ): WorkGraphEdgeDto[] {
    this.requireNodeType(type);
    const nid = this.requireNonEmpty(id, "id");
    if (relation) this.requireRelation(relation);
    return this.repo.listOutgoing(type, nid, relation);
  }

  listIncoming(
    type: WorkGraphNodeType,
    id: string,
    relation?: WorkGraphRelation,
  ): WorkGraphEdgeDto[] {
    this.requireNodeType(type);
    const nid = this.requireNonEmpty(id, "id");
    if (relation) this.requireRelation(relation);
    return this.repo.listIncoming(type, nid, relation);
  }

  listRelated(
    type: WorkGraphNodeType,
    id: string,
    relation?: WorkGraphRelation,
  ): WorkGraphEdgeDto[] {
    this.requireNodeType(type);
    const nid = this.requireNonEmpty(id, "id");
    if (relation) this.requireRelation(relation);
    const out = this.repo.listOutgoing(type, nid, relation);
    const inn = this.repo.listIncoming(type, nid, relation);
    // Dedup by id (should not overlap except self-loop appearing in both)
    const map = new Map<string, WorkGraphEdgeDto>();
    for (const e of [...out, ...inn]) map.set(e.id, e);
    return [...map.values()].sort((a, b) => a.createdAt - b.createdAt || a.id.localeCompare(b.id));
  }

  /** Explicit cleanup when an entity is deleted. Call from deleteTask/deleteSpace/deleteProject etc. */
  cleanupByNode(type: WorkGraphNodeType, id: string): number {
    this.requireNodeType(type);
    const nid = this.requireNonEmpty(id, "id");
    return this.repo.deleteByNode(type, nid);
  }

  countAll(): number {
    return this.repo.countAll();
  }

  // --- Phase 7 bridge helpers (read-only projections, no hierarchy mutation) ---

  /** Project → Workspaces it relates to (via RELATES_TO or BELONGS_TO) */
  listProjectWorkspaces(projectId: string): WorkGraphEdgeDto[] {
    return [
      ...this.listOutgoing("project", projectId, "RELATES_TO").filter((e) => e.toType === "workspace"),
      ...this.listOutgoing("project", projectId, "BELONGS_TO").filter((e) => e.toType === "workspace"),
    ];
  }

  /** Plan CONTAINS Tasks */
  listPlanTasks(planId: string): WorkGraphEdgeDto[] {
    return this.listOutgoing("plan", planId, "CONTAINS").filter((e) => e.toType === "task");
  }

  /** Which Plan(s) contain a Task */
  listTaskPlans(taskId: string): WorkGraphEdgeDto[] {
    return this.listIncoming("task", taskId, "CONTAINS").filter((e) => e.fromType === "plan");
  }

  /** Workspace → Projects via incoming (project RELATES_TO/BELONGS_TO workspace) */
  listWorkspaceProjects(workspaceId: string): WorkGraphEdgeDto[] {
    const inc = [
      ...this.listIncoming("workspace", workspaceId, "RELATES_TO"),
      ...this.listIncoming("workspace", workspaceId, "BELONGS_TO"),
    ];
    return inc.filter((e) => e.fromType === "project");
  }

  /** Upstream / Downstream by DEPENDS_ON */
  listDependsOn(taskId: string): WorkGraphEdgeDto[] {
    return this.listOutgoing("task", taskId, "DEPENDS_ON");
  }
  listDependents(taskId: string): WorkGraphEdgeDto[] {
    return this.listIncoming("task", taskId, "DEPENDS_ON");
  }

  // --- Phase 8 execution lineage (record, not lifecycle) ---

  /** Task lineage: Task → … → AgentRun → … */
  listTaskLineage(taskId: string): WorkGraphEdgeDto[] {
    return this.listOutgoing("task", taskId, "SPAWNED").filter((e) => e.toType === "agent_run");
  }
  /** AgentRun spawned children */
  listAgentChildren(agentRunId: string): WorkGraphEdgeDto[] {
    return this.listOutgoing("agent_run", agentRunId, "SPAWNED").filter((e) => e.toType === "agent_run");
  }
  /** Artifact provenance: which Task/AgentRun produced it */
  listArtifactProvenance(artifactId: string): WorkGraphEdgeDto[] {
    return this.listIncoming("artifact", artifactId, "PRODUCES");
  }
  /** Context snapshot provenance (DERIVED_FROM) */
  listDerivedFrom(nodeType: WorkGraphNodeType, nodeId: string): WorkGraphEdgeDto[] {
    return this.listOutgoing(nodeType, nodeId, "DERIVED_FROM");
  }

  // --- validation helpers ---

  private requireNonEmpty(v: string, label: string): string {
    const t = v?.trim();
    if (!t) throw new Error(`${label} 不能为空`);
    return t;
  }

  private requireNodeType(t: string): WorkGraphNodeType {
    if (!NODE_TYPES.has(t)) throw new Error(`非法 node type：${t}`);
    return t as WorkGraphNodeType;
  }

  private requireRelation(r: string): WorkGraphRelation {
    if (!RELATIONS.has(r)) throw new Error(`非法 relation：${r}`);
    return r as WorkGraphRelation;
  }

  private assertRelationShape(
    fromType: WorkGraphNodeType,
    toType: WorkGraphNodeType,
    relation: WorkGraphRelation,
  ): void {
    if (relation === "SPAWNED") {
      // Execution lineage: task SPAWNED agent_run; agent_run SPAWNED agent_run (subagent); task/agent_run SPAWNED is DAG tree
      const ok =
        (fromType === "task" && toType === "agent_run") ||
        (fromType === "agent_run" && toType === "agent_run");
      if (!ok) throw new Error(`SPAWNED 不支持：${fromType} → ${toType}`);
      return;
    }
    // BELONGS_TO / CONTAINS are Phase-7 bridge relations with stricter shapes.
    // All other relations remain permissive (ADR: RELATES_TO flexible).
    if (relation === "BELONGS_TO") {
      // Allowed: plan BELONGS_TO project (plan is child of project); project BELONGS_TO workspace (optional bridge)
      const ok =
        (fromType === "plan" && toType === "project") ||
        (fromType === "project" && toType === "workspace") ||
        (fromType === "task" && toType === "project"); // optional: task BELONGS_TO project (informational, not ownership)
      if (!ok) throw new Error(`BELONGS_TO 不支持：${fromType} → ${toType}`);
      return;
    }
    if (relation === "CONTAINS") {
      // Allowed: project CONTAINS plan; plan CONTAINS task; workspace CONTAINS task (rare, but allowed as relation note)
      const ok =
        (fromType === "project" && toType === "plan") ||
        (fromType === "plan" && toType === "task") ||
        (fromType === "workspace" && toType === "task");
      if (!ok) throw new Error(`CONTAINS 不支持：${fromType} → ${toType}`);
      return;
    }
    // Forbid misusing hierarchy ownership as graph edge (unreachable due to early return, but kept for future DAG relations)
    // Workspace parent is spaces.parent_id, not graph edge.
  }

  private normalizeMetadata(m: unknown): Record<string, unknown> {
    if (!m || typeof m !== "object" || Array.isArray(m)) return {};
    return m as Record<string, unknown>;
  }

  private assertEntityExists(type: WorkGraphNodeType, id: string): void {
    const conn = this.db.connection;
    switch (type) {
      case "workspace": {
        const r = conn.prepare(`SELECT 1 FROM spaces WHERE id=? LIMIT 1`).get(id) as unknown;
        if (!r) throw new Error(`workspace 不存在：${id}`);
        break;
      }
      case "task": {
        const r = conn.prepare(`SELECT 1 FROM tasks WHERE id=? LIMIT 1`).get(id) as unknown;
        if (!r) throw new Error(`task 不存在：${id}`);
        break;
      }
      case "project": {
        const r = conn.prepare(`SELECT 1 FROM projects WHERE id=? LIMIT 1`).get(id) as unknown;
        if (!r) throw new Error(`project 不存在：${id}`);
        break;
      }
      case "plan": {
        const r = conn.prepare(`SELECT 1 FROM project_todos WHERE id=? LIMIT 1`).get(id) as unknown;
        if (!r) throw new Error(`plan 不存在：${id}`);
        break;
      }
      case "artifact": {
        // artifacts 表若不存在则跳过存在性校验（允许测试/旧库）；但若存在则校验
        try {
          const hasTable = conn
            .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='artifacts'`)
            .get() as unknown;
          if (hasTable) {
            const r = conn.prepare(`SELECT 1 FROM artifacts WHERE id=? LIMIT 1`).get(id) as unknown;
            if (!r) throw new Error(`artifact 不存在：${id}`);
          }
        } catch (e) {
          if (e instanceof Error && e.message.includes("artifact 不存在")) throw e;
        }
        break;
      }
      case "library_item": {
        try {
          const hasTable = conn
            .prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='library_items'`)
            .get() as unknown;
          if (hasTable) {
            const r = conn.prepare(`SELECT 1 FROM library_items WHERE id=? LIMIT 1`).get(id) as unknown;
            if (!r) throw new Error(`library_item 不存在：${id}`);
          }
        } catch (e) {
          if (e instanceof Error && e.message.includes("library_item 不存在")) throw e;
        }
        break;
      }
      case "agent_run": {
        // Phase 8: agent_run id is ephemeral (run-*). No DB table; validate non-empty only.
        // Existence = caller provided deterministic id; cleanup handles orphan edges.
        if (!id.trim()) throw new Error(`agent_run id 不能为空`);
        break;
      }
      default:
        throw new Error(`未处理的 node type：${type}`);
    }
  }

  /**
   * DAG reachability: would adding (from --relation--> to) create a cycle?
   * Check if `from` is reachable from `to` via existing edges of the same relation.
   */
  private wouldCreateDagCycle(
    fromType: WorkGraphNodeType,
    fromId: string,
    toType: WorkGraphNodeType,
    toId: string,
    relation: WorkGraphRelation,
  ): boolean {
    // BFS from `to` following `relation` outgoing, see if we can reach `from`
    const key = (t: string, i: string) => `${t}:${i}`;
    const targetKey = key(fromType, fromId);
    const visited = new Set<string>();
    const queue: Array<{ type: WorkGraphNodeType; id: string }> = [{ type: toType, id: toId }];
    visited.add(key(toType, toId));
    while (queue.length > 0) {
      const cur = queue.shift()!;
      const outgoing = this.repo.listOutgoing(cur.type, cur.id, relation);
      for (const e of outgoing) {
        const nk = key(e.toType, e.toId);
        if (nk === targetKey) return true;
        if (!visited.has(nk)) {
          visited.add(nk);
          queue.push({ type: e.toType as WorkGraphNodeType, id: e.toId });
        }
      }
    }
    return false;
  }

  private toDto(row: { id: string; from_type: string; from_id: string; relation: string; to_type: string; to_id: string; metadata_json: string; created_at: number; updated_at: number }): WorkGraphEdgeDto {
    let meta: Record<string, unknown> = {};
    try { meta = JSON.parse(row.metadata_json) as Record<string, unknown>; } catch { meta = {}; }
    return {
      id: row.id,
      fromType: row.from_type as WorkGraphNodeType,
      fromId: row.from_id,
      relation: row.relation as WorkGraphRelation,
      toType: row.to_type as WorkGraphNodeType,
      toId: row.to_id,
      metadata: meta && typeof meta === "object" ? meta : {},
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }
}
