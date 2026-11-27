import type Database from "better-sqlite3";
import type { GadgetDescriptor, GadgetScope } from "../../shared/gadget-types";
import { assertGadgetScope } from "../../shared/gadget-types";
import type { RuntimeAuditReader, RuntimeGadgetInsert, RuntimeGadgetOrigin, RuntimeGadgetPatch } from "../platform/runtime-audit";
import { writeWorkbench } from "../db/workbench-writes";

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

function descriptorValues(descriptor: GadgetDescriptor) {
  return {
    id: descriptor.id,
    name: descriptor.name,
    description: descriptor.description ?? null,
    metadataJson: JSON.stringify(descriptor.metadata ?? {}),
    updatedAt: descriptor.updatedAt,
  };
}

export function gadgetInsertValues(descriptor: GadgetDescriptor): RuntimeGadgetInsert {
  return {
    ...descriptorValues(descriptor), scope: scopeColumns(descriptor.scope),
    manifestPath: descriptor.manifestPath, sourcePath: descriptor.sourcePath,
    createdByTaskId: descriptor.createdByTaskId ?? null,
    blueprintId: descriptor.blueprintId ?? null, createdAt: descriptor.createdAt,
  };
}

export class GadgetRepository {
  private readonly fixture?: Database.Database;
  private readonly native?: RuntimeAuditReader;

  constructor(source: { core: RuntimeAuditReader } | Database.Database, reader?: RuntimeAuditReader) {
    if ("core" in source) this.native = source.core;
    else {
      this.fixture = source;
      this.native = reader;
    }
  }

  get usesCore(): boolean {
    return !this.fixture || Boolean(this.native?.supervised);
  }

  private get db(): Database.Database {
    if (!this.fixture || this.usesCore) throw new Error("Gadget 需要通过 Rust Core 访问");
    return this.fixture;
  }

  private assertHostWriteAllowed(action: string): void {
    if (this.usesCore || this.db.readonly) {
      throw new Error(`Gadget 同步写入（${action}）已由 Rust 接管，请使用异步路径`);
    }
  }

  create(descriptor: GadgetDescriptor): GadgetDescriptor {
    this.assertHostWriteAllowed("create");
    const values = gadgetInsertValues(descriptor);
    this.db.prepare(
      `INSERT INTO gadgets (
         id, name, description, scope_type, scope_id, type, manifest_path, source_path,
         created_by_task_id, blueprint_id, metadata_json, created_at, updated_at
       ) VALUES (
         @id, @name, @description, @scopeType, @scopeId, @type, @manifestPath, @sourcePath,
         @createdByTaskId, @blueprintId, @metadataJson, @createdAt, @updatedAt
       )`,
    ).run({
      ...values,
      ...values.scope,
      type: descriptor.type,
    });
    return descriptor;
  }

  async createAsync(descriptor: GadgetDescriptor, origin: RuntimeGadgetOrigin): Promise<GadgetDescriptor> {
    const result = await writeWorkbench(this.fixture, this.native, {
      kind: "createGadget", origin,
      gadget: gadgetInsertValues(descriptor),
    });
    if (result === undefined) return this.create(descriptor);
    if (result !== "changed") throw new Error("Gadget 目标或来源作用域已变化，请刷新后重试");
    return descriptor;
  }

  get(id: string): GadgetDescriptor | null {
    const row = this.db.prepare("SELECT * FROM gadgets WHERE id = ?").get(id) as GadgetRow | undefined;
    return row ? mapRow(row) : null;
  }

  async read(id: string): Promise<GadgetDescriptor | null> {
    if (!this.usesCore && this.fixture?.inTransaction) return this.get(id);
    const rows = await this.native?.workbenchData<GadgetRow>({ kind: "gadget", id });
    if (rows === undefined) return this.get(id);
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async readForTask(id: string, taskId: string): Promise<GadgetDescriptor | null> {
    const rows = await this.native?.workbenchData<GadgetRow>({ kind: "gadgetForTask", id, taskId });
    if (!rows) throw new Error("Gadget 可见性未获 Rust Core 确认");
    return rows[0] ? mapRow(rows[0]) : null;
  }

  async readInherited(scope: GadgetScope): Promise<Array<{ descriptor: GadgetDescriptor; scopeIndex: number }>> {
    const rows = await this.native?.workbenchData<GadgetRow & { scope_index: number }>({
      kind: "inheritedGadgets", scope: scopeColumns(scope),
    });
    if (!rows) throw new Error("Gadget 继承列表未获 Rust Core 确认");
    return rows.map(row => ({ descriptor: mapRow(row), scopeIndex: row.scope_index }));
  }

  private async readSaved(id: string): Promise<GadgetDescriptor> {
    const descriptor = await this.read(id);
    if (!descriptor) throw new Error("Gadget 不存在：" + id);
    return descriptor;
  }

  update(descriptor: GadgetDescriptor): GadgetDescriptor {
    this.assertHostWriteAllowed("update");
    const result = this.db.prepare(
      `UPDATE gadgets
       SET name = @name, description = @description, metadata_json = @metadataJson, updated_at = @updatedAt
       WHERE id = @id`,
    ).run(descriptorValues(descriptor));
    if (result.changes !== 1) throw new Error(`Gadget 不存在：${descriptor.id}`);
    return descriptor;
  }

  async updateAsync(descriptor: GadgetDescriptor, patch: RuntimeGadgetPatch): Promise<GadgetDescriptor> {
    const result = await writeWorkbench(this.fixture, this.native, {
      kind: "updateGadget", id: descriptor.id, updatedAt: descriptor.updatedAt, ...patch,
    });
    if (result === undefined) return this.update(descriptor);
    if (result !== "changed") throw new Error("Gadget 不存在：" + descriptor.id);
    return this.readSaved(descriptor.id);
  }

  async touchAsync(id: string, updatedAt: number): Promise<GadgetDescriptor> {
    const result = await writeWorkbench(this.fixture, this.native, { kind: "touchGadget", id, updatedAt });
    const touched = result === undefined
      ? this.db.prepare("UPDATE gadgets SET updated_at=? WHERE id=?").run(updatedAt, id).changes === 1
      : result === "changed";
    if (!touched) throw new Error("Gadget 不存在：" + id);
    return this.readSaved(id);
  }

  storageIds(): ReadonlySet<string> {
    return new Set(this.db.prepare("SELECT id FROM gadgets").pluck().all() as string[]);
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

  listScoped(scopes?: GadgetScope[]): Array<{ descriptor: GadgetDescriptor; scopeIndex: number }> {
    if (!scopes) return this.list().map(descriptor => ({ descriptor, scopeIndex: 0 }));
    return scopes.flatMap((scope, scopeIndex) => this.list(scope).map(descriptor => ({ descriptor, scopeIndex })));
  }

  async readScoped(scopes?: GadgetScope[]): Promise<Array<{ descriptor: GadgetDescriptor; scopeIndex: number }>> {
    const rows = await this.native?.workbenchData<GadgetRow & { scope_index: number }>({
      kind: "gadgets", scopes: scopes?.map(scopeColumns),
    });
    return rows?.map(row => ({ descriptor: mapRow(row), scopeIndex: row.scope_index })) ?? this.listScoped(scopes);
  }

  moveScope(id: string, scope: GadgetScope): GadgetDescriptor {
    this.assertHostWriteAllowed("moveScope");
    const { scopeType, scopeId } = scopeColumns(scope);
    const updatedAt = Date.now();
    const result = this.db.transaction(() => this.db.prepare(
      "UPDATE gadgets SET scope_type = ?, scope_id = ?, updated_at = ? WHERE id = ?",
    ).run(scopeType, scopeId, updatedAt, id))();
    if (result.changes !== 1) throw new Error(`Gadget 不存在：${id}`);
    return this.get(id)!;
  }

  async moveScopeAsync(id: string, scope: GadgetScope): Promise<GadgetDescriptor> {
    const result = await writeWorkbench(this.fixture, this.native, { kind: "moveGadget", id, scope: scopeColumns(scope), updatedAt: Date.now() });
    if (result === undefined) return this.moveScope(id, scope);
    if (result === "scopeChanged") throw new Error("Gadget 目标作用域已变化，请刷新后重试");
    if (result !== "changed") throw new Error("Gadget 不存在：" + id);
    return this.readSaved(id);
  }

  delete(id: string): boolean {
    this.assertHostWriteAllowed("delete");
    return this.db.prepare("DELETE FROM gadgets WHERE id = ?").run(id).changes === 1;
  }

  async deleteAsync(id: string): Promise<boolean> {
    const result = await writeWorkbench(this.fixture, this.native, { kind: "deleteGadget", id });
    return result === undefined ? this.delete(id) : result === "changed";
  }
}
