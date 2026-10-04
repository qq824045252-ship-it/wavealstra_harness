import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { AppDatabase } from "../db/AppDatabase";
import type {
  WorkGraphEdgeDto,
  WorkGraphNodeType,
  WorkGraphRelation,
} from "../../shared/work-graph";

interface EdgeRow {
  id: string;
  from_type: string;
  from_id: string;
  relation: string;
  to_type: string;
  to_id: string;
  metadata_json: string;
  created_at: number;
  updated_at: number;
}

function parseRow(r: EdgeRow): WorkGraphEdgeDto {
  let meta: Record<string, unknown> = {};
  try {
    meta = JSON.parse(r.metadata_json) as Record<string, unknown>;
    if (!meta || typeof meta !== "object") meta = {};
  } catch { meta = {}; }
  return {
    id: r.id,
    fromType: r.from_type as WorkGraphNodeType,
    fromId: r.from_id,
    relation: r.relation as WorkGraphRelation,
    toType: r.to_type as WorkGraphNodeType,
    toId: r.to_id,
    metadata: meta,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

export class WorkGraphRepository {
  constructor(private readonly db: AppDatabase) {}

  private get conn(): Database.Database {
    return this.db.connection;
  }

  insertEdge(row: EdgeRow): void {
    this.conn
      .prepare(
        `INSERT INTO work_graph_edges (id, from_type, from_id, relation, to_type, to_id, metadata_json, created_at, updated_at)
         VALUES (@id, @from_type, @from_id, @relation, @to_type, @to_id, @metadata_json, @created_at, @updated_at)`,
      )
      .run(row as unknown as Record<string, unknown>);
  }

  findByUnique(
    fromType: string,
    fromId: string,
    relation: string,
    toType: string,
    toId: string,
  ): EdgeRow | undefined {
    return this.conn
      .prepare(
        `SELECT * FROM work_graph_edges
         WHERE from_type=? AND from_id=? AND relation=? AND to_type=? AND to_id=?
         LIMIT 1`,
      )
      .get(fromType, fromId, relation, toType, toId) as EdgeRow | undefined;
  }

  findById(id: string): EdgeRow | undefined {
    return this.conn.prepare(`SELECT * FROM work_graph_edges WHERE id=? LIMIT 1`).get(id) as
      | EdgeRow
      | undefined;
  }

  deleteById(id: string): number {
    return this.conn.prepare(`DELETE FROM work_graph_edges WHERE id=?`).run(id).changes;
  }

  /** Cleanup orphan edges when an entity is deleted (no FK, explicit). */
  deleteByNode(type: WorkGraphNodeType, id: string): number {
    const a = this.conn
      .prepare(`DELETE FROM work_graph_edges WHERE from_type=? AND from_id=?`)
      .run(type, id).changes;
    const b = this.conn
      .prepare(`DELETE FROM work_graph_edges WHERE to_type=? AND to_id=?`)
      .run(type, id).changes;
    return a + b;
  }

  listOutgoing(
    fromType: WorkGraphNodeType,
    fromId: string,
    relation?: WorkGraphRelation,
  ): WorkGraphEdgeDto[] {
    const rows = relation
      ? (this.conn
          .prepare(
            `SELECT * FROM work_graph_edges WHERE from_type=? AND from_id=? AND relation=? ORDER BY created_at, id`,
          )
          .all(fromType, fromId, relation) as EdgeRow[])
      : (this.conn
          .prepare(`SELECT * FROM work_graph_edges WHERE from_type=? AND from_id=? ORDER BY created_at, id`)
          .all(fromType, fromId) as EdgeRow[]);
    return rows.map(parseRow);
  }

  listIncoming(
    toType: WorkGraphNodeType,
    toId: string,
    relation?: WorkGraphRelation,
  ): WorkGraphEdgeDto[] {
    const rows = relation
      ? (this.conn
          .prepare(
            `SELECT * FROM work_graph_edges WHERE to_type=? AND to_id=? AND relation=? ORDER BY created_at, id`,
          )
          .all(toType, toId, relation) as EdgeRow[])
      : (this.conn
          .prepare(`SELECT * FROM work_graph_edges WHERE to_type=? AND to_id=? ORDER BY created_at, id`)
          .all(toType, toId) as EdgeRow[]);
    return rows.map(parseRow);
  }

  listByRelation(relation: WorkGraphRelation): WorkGraphEdgeDto[] {
    const rows = this.conn
      .prepare(`SELECT * FROM work_graph_edges WHERE relation=? ORDER BY created_at, id`)
      .all(relation) as EdgeRow[];
    return rows.map(parseRow);
  }

  /** All outgoing edges for a node (for DAG reachability). */
  listOutgoingAll(fromType: WorkGraphNodeType, fromId: string): WorkGraphEdgeDto[] {
    return this.listOutgoing(fromType, fromId);
  }

  countAll(): number {
    const r = this.conn.prepare(`SELECT COUNT(*) as n FROM work_graph_edges`).get() as { n: number };
    return r.n;
  }

  static toRow(dto: {
    id: string;
    fromType: string;
    fromId: string;
    relation: string;
    toType: string;
    toId: string;
    metadata: Record<string, unknown>;
    now: number;
  }): EdgeRow {
    return {
      id: dto.id,
      from_type: dto.fromType,
      from_id: dto.fromId,
      relation: dto.relation,
      to_type: dto.toType,
      to_id: dto.toId,
      metadata_json: JSON.stringify(dto.metadata ?? {}),
      created_at: dto.now,
      updated_at: dto.now,
    };
  }
}
