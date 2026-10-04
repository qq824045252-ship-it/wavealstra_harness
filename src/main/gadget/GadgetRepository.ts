import type Database from "better-sqlite3";
import type { GadgetDescriptor, GadgetScope } from "../../shared/gadget-types";
import { assertGadgetScope } from "../../shared/gadget-types";

interface GadgetRow {
  id: string;
  name: string;
  description: string | null;
  scope_type: "global" | "workspace" | "task";
  scope_id: string | null;
  type: "web";
  manifest_path: string;
  source_path: string;
  created_by_task_id: string | null;
  blueprint_id: string | null;
  metadata_json: string;
  created_at: number;
  updated_at: number;
}

function scopeColumns(scope: GadgetScope): { scopeType: GadgetRow["scope_type"]; scopeId: string | null } {
  assertGadgetScope(scope);
  if (scope.type === "global") return { scopeType: "global", scopeId: null };
  if (scope.type === "workspace") return { scopeType: "workspace", scopeId: scope.workspaceId.trim() };
  return { scopeType: "task", scopeId: scope.taskId.trim() };
}

function mapRow(row: GadgetRow): GadgetDescriptor {
  const scope: GadgetScope = row.scope_type === "global"
    ? { type: "global" }
    : row.scope_type === "workspace"
      ? { type: "workspace", workspaceId: row.scope_id! }
      : { type: "task", taskId: row.scope_id! };
  let metadata: Record<string, unknown> = {};
  try {
    const parsed = JSON.parse(row.metadata_json) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) metadata = parsed as Record<string, unknown>;
  } catch {
    metadata = {};
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    scope,
    type: row.type,
    manifestPath: row.manifest_path,
    sourcePath: row.source_path,
    createdByTaskId: row.created_by_task_id ?? undefined,
    blueprintId: row.blueprint_id ?? undefined,
    metadata,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class GadgetRepository {
  constructor(private readonly db: Database.Database) {}

  create(descriptor: GadgetDescriptor): GadgetDescriptor {
    const { scopeType, scopeId } = scopeColumns(descriptor.scope);
    this.db.prepare(
      `INSERT INTO gadgets (
         id, name, description, scope_type, scope_id, type, manifest_path, source_path,
         created_by_task_id, blueprint_id, metadata_json, created_at, updated_at
       ) VALUES (
         @id, @name, @description, @scopeType, @scopeId, @type, @manifestPath, @sourcePath,
         @createdByTaskId, @blueprintId, @metadataJson, @createdAt, @updatedAt
       )`,
    ).run({
      id: descriptor.id,
      name: descriptor.name,
      description: descriptor.description ?? null,
      scopeType,
      scopeId,
      type: descriptor.type,
      manifestPath: descriptor.manifestPath,
      sourcePath: descriptor.sourcePath,
      createdByTaskId: descriptor.createdByTaskId ?? null,
      blueprintId: descriptor.blueprintId ?? null,
      metadataJson: JSON.stringify(descriptor.metadata ?? {}),
      createdAt: descriptor.createdAt,
      updatedAt: descriptor.updatedAt,
    });
    return descriptor;
  }

  get(id: string): GadgetDescriptor | null {
    const row = this.db.prepare("SELECT * FROM gadgets WHERE id = ?").get(id) as GadgetRow | undefined;
    return row ? mapRow(row) : null;
  }

  update(descriptor: GadgetDescriptor): GadgetDescriptor {
    const result = this.db.prepare(
      `UPDATE gadgets
       SET name = @name, description = @description, metadata_json = @metadataJson, updated_at = @updatedAt
       WHERE id = @id`,
    ).run({
      id: descriptor.id,
      name: descriptor.name,
      description: descriptor.description ?? null,
      metadataJson: JSON.stringify(descriptor.metadata ?? {}),
      updatedAt: descriptor.updatedAt,
    });
    if (result.changes !== 1) throw new Error(`Gadget 不存在：${descriptor.id}`);
    return descriptor;
  }

  list(scope?: GadgetScope): GadgetDescriptor[] {
    let rows: GadgetRow[];
    if (!scope) {
      rows = this.db.prepare("SELECT * FROM gadgets ORDER BY updated_at DESC, id").all() as GadgetRow[];
    } else {
      const { scopeType, scopeId } = scopeColumns(scope);
      rows = scopeId === null
        ? this.db.prepare("SELECT * FROM gadgets WHERE scope_type = ? AND scope_id IS NULL ORDER BY updated_at DESC, id").all(scopeType) as GadgetRow[]
        : this.db.prepare("SELECT * FROM gadgets WHERE scope_type = ? AND scope_id = ? ORDER BY updated_at DESC, id").all(scopeType, scopeId) as GadgetRow[];
    }
    return rows.map(mapRow);
  }

  moveScope(id: string, scope: GadgetScope): GadgetDescriptor {
    const { scopeType, scopeId } = scopeColumns(scope);
    const updatedAt = Date.now();
    const result = this.db.transaction(() => this.db.prepare(
      "UPDATE gadgets SET scope_type = ?, scope_id = ?, updated_at = ? WHERE id = ?",
    ).run(scopeType, scopeId, updatedAt, id))();
    if (result.changes !== 1) throw new Error(`Gadget 不存在：${id}`);
    return this.get(id)!;
  }

  delete(id: string): boolean {
    return this.db.prepare("DELETE FROM gadgets WHERE id = ?").run(id).changes === 1;
  }
}
