import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { BlueprintCreateRequest, BlueprintDescriptor, BlueprintUpdateRequest } from "../../shared/blueprint-types";
import { normalizeBlueprintDefinition } from "../../shared/blueprint-types";
import { migrateBlueprintDefinition } from "./BlueprintDefinitionMigrator";
import type { RuntimeAuditReader } from "../platform/runtime-audit";
import { writeWorkbench } from "../db/workbench-writes";

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
  private readonly fixture?: Database.Database;
  private readonly native?: RuntimeAuditReader;

  constructor(source: { core: RuntimeAuditReader } | Database.Database, reader?: RuntimeAuditReader) {
    if ("core" in source) this.native = source.core;
    else {
      this.fixture = source;
      this.native = reader;
    }
  }

  private get db(): Database.Database {
    if (!this.fixture || this.native?.supervised) throw new Error("Blueprint 需要通过 Rust Core 访问");
    return this.fixture;
  }

  async create(request: BlueprintCreateRequest): Promise<BlueprintDescriptor> {
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
    const serialized = {
      kind: definition.kind, schemaVersion: definition.schemaVersion, definitionJson: JSON.stringify(definition),
    };
    const result = await writeWorkbench(this.fixture, this.native, {
      kind: "createBlueprint",
      blueprint: { id: descriptor.id, name, description: descriptor.description ?? null, definition: serialized, createdAt: now, updatedAt: now },
    });
    if (result === "changed") return descriptor;
    if (result !== undefined) throw new Error("Blueprint 保存失败");
    this.db.prepare(
      `INSERT INTO blueprints (id, name, description, kind, schema_version, definition_json, created_at, updated_at)
       VALUES (@id, @name, @description, @kind, @schemaVersion, @definitionJson, @createdAt, @updatedAt)`,
    ).run({
      id: descriptor.id,
      name: descriptor.name,
      description: descriptor.description ?? null,
      ...serialized,
      createdAt: now,
      updatedAt: now,
    });
    return descriptor;
  }

  get(id: string): BlueprintDescriptor | null {
    const row = this.db.prepare("SELECT * FROM blueprints WHERE id = ?").get(id) as BlueprintRow | undefined;
    return row ? mapRow(row) : null;
  }

  async read(id: string): Promise<BlueprintDescriptor | null> {
    if (!this.native?.supervised && this.fixture?.inTransaction) return this.get(id);
    const rows = await this.native?.workbenchData<BlueprintRow>({ kind: "blueprint", id });
    if (rows === undefined) return this.get(id);
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async update(request: BlueprintUpdateRequest): Promise<BlueprintDescriptor> {
    const current = await this.read(request.blueprintId);
    if (!current) throw new Error(`Blueprint 不存在：${request.blueprintId}`);
    const name = request.name === undefined ? current.name : request.name.trim();
    if (!name) throw new Error("Blueprint 名称不能为空");
    if (name.length > 120) throw new Error("Blueprint 名称不能超过 120 字符");
    if ((request.description?.length ?? 0) > 2_000) throw new Error("Blueprint 描述不能超过 2000 字符");
    const definition = request.definition === undefined ? undefined : normalizeBlueprintDefinition(request.definition);
    const description = request.description === undefined ? undefined : { value: request.description?.trim() || null };
    const serialized = definition && {
      kind: definition.kind, schemaVersion: definition.schemaVersion, definitionJson: JSON.stringify(definition),
    };
    const updatedAt = Date.now();
    const changedName = request.name === undefined ? undefined : name;
    const result = await writeWorkbench(this.fixture, this.native, {
      kind: "patchBlueprint", id: current.id, name: changedName, description, definition: serialized, updatedAt,
    });
    if (result === undefined) {
      this.db.prepare(
        `UPDATE blueprints SET name=coalesce(?,name),description=CASE WHEN ? THEN ? ELSE description END,
            kind=coalesce(?,kind),schema_version=coalesce(?,schema_version),definition_json=coalesce(?,definition_json),
            updated_at=max(updated_at,?) WHERE id=?`,
      ).run(changedName ?? null, description ? 1 : 0, description?.value ?? null,
        serialized?.kind ?? null, serialized?.schemaVersion ?? null, serialized?.definitionJson ?? null, updatedAt, current.id);
    }
    const saved = result === "missing" ? null : await this.read(current.id);
    if (!saved) throw new Error("Blueprint 不存在：" + current.id);
    return saved;
  }

  list(): BlueprintDescriptor[] {
    return (this.db.prepare("SELECT * FROM blueprints ORDER BY updated_at DESC, id").all() as BlueprintRow[]).map(mapRow);
  }

  async readList(): Promise<BlueprintDescriptor[]> {
    const rows = await this.native?.workbenchData<BlueprintRow>({ kind: "blueprints" });
    return rows?.map(mapRow) ?? this.list();
  }

  async delete(id: string): Promise<boolean> {
    const result = await writeWorkbench(this.fixture, this.native, { kind: "deleteBlueprint", id });
    return result === undefined ? this.db.prepare("DELETE FROM blueprints WHERE id = ?").run(id).changes === 1 : result === "changed";
  }
}
