import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { BlueprintCreateRequest, BlueprintDescriptor, BlueprintUpdateRequest } from "../../shared/blueprint-types";
import { normalizeBlueprintDefinition } from "../../shared/blueprint-types";
import { migrateBlueprintDefinition } from "./BlueprintDefinitionMigrator";

interface BlueprintRow {
  id: string;
  name: string;
  description: string | null;
  kind: BlueprintDescriptor["kind"];
  schema_version: number;
  definition_json: string;
  created_at: number;
  updated_at: number;
}

function mapRow(row: BlueprintRow): BlueprintDescriptor {
  const definition = migrateBlueprintDefinition(JSON.parse(row.definition_json));
  if (definition.kind !== row.kind || definition.schemaVersion !== row.schema_version) {
    throw new Error(`Blueprint ${row.id} 行元数据与 definition 不一致`);
  }
  return {
    id: row.id,
    name: row.name,
    description: row.description ?? undefined,
    kind: row.kind,
    schemaVersion: row.schema_version,
    definition,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export class BlueprintRepository {
  constructor(private readonly db: Database.Database) {}

  create(request: BlueprintCreateRequest): BlueprintDescriptor {
    const name = request.name.trim();
    if (!name) throw new Error("Blueprint 名称不能为空");
    if (name.length > 120) throw new Error("Blueprint 名称不能超过 120 字符");
    if ((request.description?.length ?? 0) > 2_000) throw new Error("Blueprint 描述不能超过 2000 字符");
    const definition = normalizeBlueprintDefinition(request.definition);
    const now = Date.now();
    const descriptor: BlueprintDescriptor = {
      id: `bp-${randomUUID()}`,
      name,
      description: request.description?.trim() || undefined,
      kind: definition.kind,
      schemaVersion: definition.schemaVersion,
      definition,
      createdAt: now,
      updatedAt: now,
    };
    this.db.prepare(
      `INSERT INTO blueprints (id, name, description, kind, schema_version, definition_json, created_at, updated_at)
       VALUES (@id, @name, @description, @kind, @schemaVersion, @definitionJson, @createdAt, @updatedAt)`,
    ).run({
      id: descriptor.id,
      name: descriptor.name,
      description: descriptor.description ?? null,
      kind: descriptor.kind,
      schemaVersion: descriptor.schemaVersion,
      definitionJson: JSON.stringify(definition),
      createdAt: now,
      updatedAt: now,
    });
    return descriptor;
  }

  get(id: string): BlueprintDescriptor | null {
    const row = this.db.prepare("SELECT * FROM blueprints WHERE id = ?").get(id) as BlueprintRow | undefined;
    return row ? mapRow(row) : null;
  }

  update(request: BlueprintUpdateRequest): BlueprintDescriptor {
    const current = this.get(request.blueprintId);
    if (!current) throw new Error(`Blueprint 不存在：${request.blueprintId}`);
    const name = request.name === undefined ? current.name : request.name.trim();
    if (!name) throw new Error("Blueprint 名称不能为空");
    if (name.length > 120) throw new Error("Blueprint 名称不能超过 120 字符");
    if ((request.description?.length ?? 0) > 2_000) throw new Error("Blueprint 描述不能超过 2000 字符");
    const definition = request.definition === undefined ? current.definition : normalizeBlueprintDefinition(request.definition);
    const updatedAt = Date.now();
    this.db.prepare(
      `UPDATE blueprints
       SET name = ?, description = ?, kind = ?, schema_version = ?, definition_json = ?, updated_at = ?
       WHERE id = ?`,
    ).run(
      name,
      request.description === undefined ? current.description ?? null : request.description?.trim() || null,
      definition.kind,
      definition.schemaVersion,
      JSON.stringify(definition),
      updatedAt,
      current.id,
    );
    return this.get(current.id)!;
  }

  list(): BlueprintDescriptor[] {
    return (this.db.prepare("SELECT * FROM blueprints ORDER BY updated_at DESC, id").all() as BlueprintRow[]).map(mapRow);
  }

  delete(id: string): boolean {
    return this.db.prepare("DELETE FROM blueprints WHERE id = ?").run(id).changes === 1;
  }
}
