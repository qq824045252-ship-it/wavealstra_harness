import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  RuntimeMaterialUseDto,
  RuntimeAuditInstructionDto,
  RuntimeContextSnapshotDto,
} from "../../shared/agent-ipc";
import { normalizeWelcomeMode, type AssemblySegmentDto } from "../../shared/mode-profile";
import type { ResolvedCapabilityDto } from "../../shared/runtime-policy";
import {
  compactRuntimeAuditInstructions,
  normalizeStoredAuditInstructions,
  RUNTIME_AUDIT_MAX_AGE_MS,
  RUNTIME_AUDIT_MAX_BYTES_PER_TASK,
  RUNTIME_AUDIT_MAX_RECORDS_PER_TASK,
  runtimeAuditStorageBytes,
} from "./RuntimeAuditStorage";

interface SnapshotRow {
  id: string;
  task_id: string;
  user_message_id: string;
  assistant_message_id: string;
  created_at: number;
  schema_version: number;
  welcome_mode: string;
  tag_id: string | null;
  project_id: string | null;
  project_updated_at: number | null;
  resolved_instructions_json: string;
  resolved_capabilities_json: string;
  warnings_json: string;
  execution_id: string | null;
  status: string;
  started_at: number | null;
  completed_at: number | null;
  error: string | null;
  assembly_hash: string | null;
  model_id: string | null;
  permission_mode: string | null;
  working_directory: string | null;
  material_usage_json: string | null;
  storage_bytes: number | null;
}

function parseArray<T>(value: string): T[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed as T[] : [];
  } catch {
    return [];
  }
}

function mapRow(row: SnapshotRow): RuntimeContextSnapshotDto {
  const parsedInstructions = parseArray<RuntimeAuditInstructionDto>(row.resolved_instructions_json);
  return {
    materialUsage: parseMaterialUsage(row.material_usage_json),
    id: row.id,
    workingDirectory: row.working_directory ?? undefined,
    executionId: row.execution_id ?? row.id,
    taskId: row.task_id,
    userMessageId: row.user_message_id,
    assistantMessageId: row.assistant_message_id,
    createdAt: row.created_at,
    schemaVersion: row.schema_version,
    status: (["running", "completed", "failed", "aborted"].includes(row.status)
      ? row.status
      : "completed") as RuntimeContextSnapshotDto["status"],
    startedAt: row.started_at ?? row.created_at,
    completedAt: row.completed_at ?? undefined,
    error: row.error ?? undefined,
    assemblyHash: row.assembly_hash ?? "",
    modelId: row.model_id ?? undefined,
    permissionMode: (row.permission_mode as RuntimeContextSnapshotDto["permissionMode"]) ?? undefined,
    mode: normalizeWelcomeMode(row.welcome_mode) ?? "working",
    tagId: row.tag_id ?? undefined,
    projectId: row.project_id ?? undefined,
    projectUpdatedAt: row.project_updated_at ?? undefined,
    resolvedInstructions: normalizeStoredAuditInstructions(parsedInstructions),
    resolvedCapabilities: parseArray<ResolvedCapabilityDto>(row.resolved_capabilities_json),
    warnings: parseArray<string>(row.warnings_json),
    storageBytes: row.storage_bytes ?? runtimeAuditStorageBytes([
      row.resolved_instructions_json,
      row.resolved_capabilities_json,
      row.warnings_json,
    ]),
  };
}

function parseMaterialUsage(json: string | null): RuntimeContextSnapshotDto["materialUsage"] {
  if (!json) return undefined;
  try {
    const value = JSON.parse(json);
    if (!value || !Array.isArray(value.items) || !Number.isSafeInteger(value.omitted) || value.omitted < 0) return undefined;
    if (value.items.length > 100 || !value.items.every((item: RuntimeMaterialUseDto) => item &&
      ["file-content", "knowledge-content", "web-content", "search-snippet", "metadata"].includes(item.kind) &&
      [item.toolCallId, item.toolName, item.title, item.target, item.outputHash].every((text) => typeof text === "string") &&
      [item.at, item.returnedChars, item.images].every((number) => Number.isFinite(number) && number >= 0))) return undefined;
    return value;
  } catch { return undefined; }
}

type RuntimeContextSnapshotRecordInput = Omit<
  RuntimeContextSnapshotDto,
  "id" | "executionId" | "createdAt" | "schemaVersion" | "resolvedInstructions" | "storageBytes"
> & { executionId?: string; resolvedInstructions: AssemblySegmentDto[] };

export class RuntimeContextSnapshotRepository {
  constructor(private readonly db: Database.Database) {}

  recordOnce(input: RuntimeContextSnapshotRecordInput & { executionId: string }): RuntimeContextSnapshotDto {
    const row = this.db.prepare("SELECT * FROM task_runtime_context_snapshots WHERE task_id = ? AND execution_id = ? LIMIT 1").get(input.taskId, input.executionId) as SnapshotRow | undefined;
    return row ? mapRow(row) : this.record(input);
  }

  record(input: RuntimeContextSnapshotRecordInput): RuntimeContextSnapshotDto {
    const id = `rsnap_${randomUUID()}`;
    const resolvedInstructions = compactRuntimeAuditInstructions(input.resolvedInstructions);
    const instructions = JSON.stringify(resolvedInstructions);
    const capabilities = JSON.stringify(input.resolvedCapabilities);
    const warnings = JSON.stringify(input.warnings);
    const snapshot: RuntimeContextSnapshotDto = {
      ...input,
      materialUsage: { items: [], omitted: 0 },
      resolvedInstructions,
      id,
      executionId: input.executionId ?? id,
      createdAt: Date.now(),
      schemaVersion: 3,
      storageBytes: runtimeAuditStorageBytes([instructions, capabilities, warnings, input.workingDirectory ?? "", JSON.stringify({ items: [], omitted: 0 })]),
    };
    this.db.prepare(
      `INSERT INTO task_runtime_context_snapshots
         (id, task_id, user_message_id, assistant_message_id, created_at, schema_version,
          welcome_mode, tag_id, project_id, project_updated_at,
          resolved_instructions_json, resolved_capabilities_json, warnings_json,
          execution_id, status, started_at, completed_at, error, assembly_hash, model_id, permission_mode,
          working_directory, material_usage_json, storage_bytes)
       VALUES (@id, @taskId, @userMessageId, @assistantMessageId, @createdAt, @schemaVersion,
               @mode, @tagId, @projectId, @projectUpdatedAt,
               @instructions, @capabilities, @warnings,
               @executionId, @status, @startedAt, @completedAt, @error, @assemblyHash, @modelId, @permissionMode,
               @workingDirectory, @materialUsage, @storageBytes)`,
    ).run({
      id: snapshot.id,
      taskId: snapshot.taskId,
      userMessageId: snapshot.userMessageId,
      assistantMessageId: snapshot.assistantMessageId,
      createdAt: snapshot.createdAt,
      schemaVersion: snapshot.schemaVersion,
      mode: snapshot.mode,
      tagId: snapshot.tagId ?? null,
      projectId: snapshot.projectId ?? null,
      projectUpdatedAt: snapshot.projectUpdatedAt ?? null,
      instructions,
      capabilities,
      warnings,
      executionId: snapshot.executionId,
      status: snapshot.status,
      startedAt: snapshot.startedAt,
      completedAt: snapshot.completedAt ?? null,
      error: snapshot.error ?? null,
      assemblyHash: snapshot.assemblyHash,
      modelId: snapshot.modelId ?? null,
      permissionMode: snapshot.permissionMode ?? null,
      materialUsage: JSON.stringify(snapshot.materialUsage),
      workingDirectory: snapshot.workingDirectory ?? null,
      storageBytes: snapshot.storageBytes,
    });
    this.prune(snapshot.taskId);
    return snapshot;
  }

  appendMaterials(ctx: { taskId: string; executionId: string; assistantMessageId: string }, items: RuntimeMaterialUseDto[]): void {
    if (!items.length) return;
    this.db.transaction(() => {
      const row = this.db.prepare(`SELECT id, material_usage_json FROM task_runtime_context_snapshots
        WHERE task_id = ? AND execution_id = ? AND assistant_message_id = ? AND status = 'running'`)
        .get(ctx.taskId, ctx.executionId, ctx.assistantMessageId) as { id: string; material_usage_json: string | null } | undefined;
      if (!row?.material_usage_json) return;
      const usage = parseMaterialUsage(row.material_usage_json);
      if (!usage) return;
      for (const item of items) {
        if (usage.items.some((old) => old.toolCallId === item.toolCallId && old.target === item.target && old.kind === item.kind)) continue;
        if (usage.items.length >= 100) { usage.omitted++; continue; }
        usage.items.push(item);
      }
      const json = JSON.stringify(usage);
      this.db.prepare(`UPDATE task_runtime_context_snapshots SET material_usage_json = ?, storage_bytes = storage_bytes + ? WHERE id = ?`)
        .run(json, Buffer.byteLength(json) - Buffer.byteLength(row.material_usage_json), row.id);
    })();
    this.prune(ctx.taskId);
  }

  finish(executionId: string, status: "completed" | "failed" | "aborted", error?: string): void {
    this.db.prepare(
      `UPDATE task_runtime_context_snapshots
       SET status = ?, completed_at = ?, error = ?
       WHERE execution_id = ? AND status = 'running'`,
    ).run(status, Date.now(), error ?? null, executionId);
  }

  finishByAssistantMessage(taskId: string, assistantMessageId: string, status: "completed" | "failed" | "aborted", error?: string): void {
    this.db.prepare(
      `UPDATE task_runtime_context_snapshots
       SET status = ?, completed_at = ?, error = ?
       WHERE task_id = ? AND assistant_message_id = ? AND status = 'running'`,
    ).run(status, Date.now(), error ?? null, taskId, assistantMessageId);
  }

  abortRunningForTask(taskId: string): void {
    this.db.prepare(
      `UPDATE task_runtime_context_snapshots
       SET status = 'aborted', completed_at = ?
       WHERE task_id = ? AND status = 'running'`,
    ).run(Date.now(), taskId);
  }

  private prune(taskId: string): void {
    const cutoff = Date.now() - RUNTIME_AUDIT_MAX_AGE_MS;
    this.db.prepare("DELETE FROM task_runtime_context_snapshots WHERE task_id = ? AND created_at < ?")
      .run(taskId, cutoff);
    this.db.prepare(
      `DELETE FROM task_runtime_context_snapshots
       WHERE task_id = ? AND id NOT IN (
         SELECT id FROM task_runtime_context_snapshots WHERE task_id = ?
         ORDER BY created_at DESC, rowid DESC LIMIT ?
       )`,
    ).run(taskId, taskId, RUNTIME_AUDIT_MAX_RECORDS_PER_TASK);
    const rows = this.db.prepare(
      `SELECT id, COALESCE(storage_bytes, 0) AS storage_bytes
       FROM task_runtime_context_snapshots WHERE task_id = ?
       ORDER BY created_at DESC, rowid DESC`,
    ).all(taskId) as Array<{ id: string; storage_bytes: number }>;
    let bytes = 0;
    const overflow: string[] = [];
    rows.forEach((row, index) => {
      bytes += row.storage_bytes;
      if (index > 0 && bytes > RUNTIME_AUDIT_MAX_BYTES_PER_TASK) overflow.push(row.id);
    });
    const remove = this.db.prepare("DELETE FROM task_runtime_context_snapshots WHERE id = ?");
    this.db.transaction(() => overflow.forEach((id) => remove.run(id)))();
  }

  list(taskId: string, limit = 50): RuntimeContextSnapshotDto[] {
    const safeLimit = Math.max(1, Math.min(200, Math.trunc(limit)));
    const rows = this.db.prepare(
      `SELECT id, task_id, user_message_id, assistant_message_id, created_at, schema_version,
              welcome_mode, tag_id, project_id, project_updated_at,
              resolved_instructions_json, resolved_capabilities_json, warnings_json,
              execution_id, status, started_at, completed_at, error, assembly_hash, model_id, permission_mode,
              working_directory, material_usage_json, storage_bytes
       FROM task_runtime_context_snapshots WHERE task_id = ?
       ORDER BY created_at DESC, rowid DESC LIMIT ?`,
    ).all(taskId, safeLimit) as SnapshotRow[];
    return rows.map(mapRow);
  }

  clear(taskId?: string): number {
    const result = taskId
      ? this.db.prepare("DELETE FROM task_runtime_context_snapshots WHERE task_id = ?").run(taskId)
      : this.db.prepare("DELETE FROM task_runtime_context_snapshots").run();
    return result.changes;
  }
}
