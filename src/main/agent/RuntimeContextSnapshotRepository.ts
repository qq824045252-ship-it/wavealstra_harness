import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type {
  RuntimeMaterialUseDto,
  RuntimeAuditInstructionDto,
  RuntimeContextSnapshotDto,
} from "../../shared/agent-ipc";
import { normalizeWelcomeMode, type AssemblySegmentDto } from "../../shared/mode-profile";
import type { ResolvedCapabilityDto } from "../../shared/runtime-policy";
import { TaskWriteQueue } from "../db/TaskWriteQueue";
import { RuntimeAuditUnknownOperationError, type RuntimeAuditReader } from "../platform/runtime-audit";
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

const selectSnapshots = `
  SELECT s.id, s.task_id, s.user_message_id, s.assistant_message_id, s.created_at, s.schema_version,
         s.welcome_mode, s.tag_id, s.project_id, s.project_updated_at,
         COALESCE(instructions.body, s.resolved_instructions_json) AS resolved_instructions_json,
         COALESCE(capabilities.body, s.resolved_capabilities_json) AS resolved_capabilities_json,
         s.warnings_json, s.execution_id, s.status, s.started_at, s.completed_at, s.error,
         s.assembly_hash, s.model_id, s.permission_mode, s.working_directory, s.material_usage_json, s.storage_bytes
  FROM task_runtime_context_snapshots s
  LEFT JOIN runtime_audit_payloads instructions ON instructions.hash = s.instructions_hash
  LEFT JOIN runtime_audit_payloads capabilities ON capabilities.hash = s.capabilities_hash
`;

type SnapshotPayloadKey = "resolved_instructions_json" | "resolved_capabilities_json" | "warnings_json" | "material_usage_json";
type SnapshotMetadata = Omit<SnapshotRow, SnapshotPayloadKey>;

export interface RuntimeSnapshotPage {
  rows: Array<SnapshotMetadata & Record<SnapshotPayloadKey, number | null>>;
  payloads: unknown[];
  rawPayloads?: Record<number, string>;
}

function parseJson(value: string | null): unknown {
  if (value === null) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch { return undefined; }
}

function asArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value as T[] : [];
}

function mapRow(row: SnapshotRow): RuntimeContextSnapshotDto {
  return mapSnapshot(row, {
    instructions: normalizeStoredAuditInstructions(parseJson(row.resolved_instructions_json)),
    capabilities: parseJson(row.resolved_capabilities_json),
    warnings: parseJson(row.warnings_json),
    materialUsage: parseJson(row.material_usage_json),
    bytes: row.storage_bytes ?? runtimeAuditStorageBytes([
      row.resolved_instructions_json,
      row.resolved_capabilities_json,
      row.warnings_json,
    ]),
  });
}

export function decodeRuntimeSnapshotPage(page: RuntimeSnapshotPage): RuntimeContextSnapshotDto[] {
  const instructions = new Map<number | null, RuntimeAuditInstructionDto[]>();
  const payload = (index: number | null): unknown => {
    if (index === null) return undefined;
    if (!Number.isSafeInteger(index) || index < 0 || index >= page.payloads.length) {
      throw new Error("Invalid audit snapshot payload reference");
    }
    const raw = page.rawPayloads?.[index];
    if (typeof raw === "string") return parseJson(raw);
    return page.payloads[index];
  };
  return page.rows.map(row => {
    let normalized = instructions.get(row.resolved_instructions_json);
    if (!normalized) {
      normalized = normalizeStoredAuditInstructions(payload(row.resolved_instructions_json));
      instructions.set(row.resolved_instructions_json, normalized);
    }
    return mapSnapshot(row, {
      instructions: normalized,
      capabilities: payload(row.resolved_capabilities_json),
      warnings: payload(row.warnings_json),
      materialUsage: payload(row.material_usage_json),
      bytes: row.storage_bytes ?? 0,
    });
  });
}

function mapSnapshot(row: SnapshotMetadata, payload: {
  instructions: RuntimeAuditInstructionDto[];
  capabilities: unknown;
  warnings: unknown;
  materialUsage: unknown;
  bytes: number;
}): RuntimeContextSnapshotDto {
  return {
    materialUsage: parseMaterialUsage(payload.materialUsage),
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
    resolvedInstructions: payload.instructions,
    resolvedCapabilities: asArray<ResolvedCapabilityDto>(payload.capabilities),
    warnings: asArray<string>(payload.warnings),
    storageBytes: payload.bytes,
  };
}

function parseMaterialUsage(input: unknown): RuntimeContextSnapshotDto["materialUsage"] {
  const value = input as RuntimeContextSnapshotDto["materialUsage"];
  if (!value || !Array.isArray(value.items) || !Number.isSafeInteger(value.omitted) || value.omitted < 0) return undefined;
  if (value.items.length > 100 || !value.items.every(item => item &&
    ["file-content", "knowledge-content", "web-content", "search-snippet", "metadata"].includes(item.kind) &&
    [item.toolCallId, item.toolName, item.title, item.target, item.outputHash].every(text => typeof text === "string") &&
    [item.at, item.returnedChars, item.images].every(number => Number.isFinite(number) && number >= 0))) return undefined;
  return value;
}

type RuntimeContextSnapshotRecordInput = Omit<
  RuntimeContextSnapshotDto,
  "id" | "executionId" | "createdAt" | "schemaVersion" | "resolvedInstructions" | "storageBytes"
> & { executionId?: string; resolvedInstructions: AssemblySegmentDto[] };

type SnapshotIdentity = { taskId: string; executionId: string; assistantMessageId: string };
type SnapshotFinish = Exclude<RuntimeContextSnapshotDto["status"], "running">;

export type RuntimeSnapshotMutation =
  | { kind: "insert"; snapshot: ReturnType<typeof prepareSnapshot>["row"] }
  | { kind: "appendMaterials"; identity: SnapshotIdentity; items: RuntimeMaterialUseDto[]; at: number }
  | { kind: "finish"; taskId: string; executionId: string; status: SnapshotFinish; error?: string; at: number }
  | { kind: "finishByMessage"; taskId: string; assistantMessageId: string; status: SnapshotFinish; error?: string; at: number }
  | { kind: "bindMessage"; identity: SnapshotIdentity }
  | { kind: "abort"; taskId: string; at: number }
  | { kind: "clear"; taskId?: string };

function prepareSnapshot(input: RuntimeContextSnapshotRecordInput) {
  const id = `rsnap_${randomUUID()}`;
  const resolvedInstructions = compactRuntimeAuditInstructions(input.resolvedInstructions);
  const instructions = JSON.stringify(resolvedInstructions);
  const capabilities = JSON.stringify(input.resolvedCapabilities);
  const warnings = JSON.stringify(input.warnings);
  const materialUsage = '{"items":[],"omitted":0}';
  const snapshot: RuntimeContextSnapshotDto = {
    ...input,
    materialUsage: { items: [], omitted: 0 },
    resolvedInstructions,
    id,
    executionId: input.executionId ?? id,
    createdAt: Date.now(),
    schemaVersion: 3,
    storageBytes: runtimeAuditStorageBytes([instructions, capabilities, warnings, input.workingDirectory ?? "", materialUsage]),
  };
  const row = {
    id: snapshot.id, executionId: snapshot.executionId, taskId: snapshot.taskId,
    userMessageId: snapshot.userMessageId, assistantMessageId: snapshot.assistantMessageId,
    createdAt: snapshot.createdAt, schemaVersion: snapshot.schemaVersion,
    mode: snapshot.mode, tagId: snapshot.tagId ?? null, projectId: snapshot.projectId ?? null,
    projectUpdatedAt: snapshot.projectUpdatedAt ?? null, instructions, capabilities, warnings, materialUsage,
    status: snapshot.status, startedAt: snapshot.startedAt, completedAt: snapshot.completedAt ?? null,
    error: snapshot.error ?? null, assemblyHash: snapshot.assemblyHash, modelId: snapshot.modelId ?? null,
    permissionMode: snapshot.permissionMode ?? null, workingDirectory: snapshot.workingDirectory ?? null,
    storageBytes: snapshot.storageBytes,
  };
  return { snapshot, row };
}

export class RuntimeContextSnapshotRepository {
  private readonly writes = new TaskWriteQueue();
  private closed = false;

  constructor(private readonly fixture: Database.Database | undefined, private readonly reader?: RuntimeAuditReader) {}

  private get db(): Database.Database {
    if (!this.fixture) throw new Error("运行上下文需要通过 Rust Core 读取或写入");
    return this.fixture;
  }

  flush(taskId?: string): Promise<void> { return this.writes.flush(taskId); }

  closeWrites(): Promise<void> {
    this.closed = true;
    return this.flush();
  }

  private write(mutation: RuntimeSnapshotMutation, fallback: () => number): number | Promise<number> {
    if (this.closed) return 0;
    if (this.fixture && !this.fixture.readonly && !this.reader?.supervised) {
      return fallback();
    }
    const reader = this.reader;
    if (!reader) throw new Error("运行时快照写入需要 Rust Core");
    const writeId = randomUUID();
    const taskId = mutation.kind === "insert" ? mutation.snapshot.taskId
      : "identity" in mutation ? mutation.identity.taskId : mutation.taskId;
    const write = async () => {
      try {
        const result = await reader.mutateSnapshot(writeId, mutation);
        if (result !== undefined) return result;
      } catch (error) {
        if (!(error instanceof RuntimeAuditUnknownOperationError)) throw error;
      }
      const receipt = await reader.snapshotReceipt(writeId);
      if (receipt != null) return receipt;
      throw new Error("运行时上下文快照写入未获 Rust 核心确认");
    };
    const pending = taskId === undefined ? this.writes.runExclusive(write) : this.writes.run([taskId], write);
    void pending.catch(() => { console.warn("[RuntimeAudit] Snapshot mutation could not be saved"); });
    return pending;
  }

  capture(input: RuntimeContextSnapshotRecordInput & { executionId: string }): void {
    const { row } = prepareSnapshot(input);
    void this.write({ kind: "insert", snapshot: row }, () => this.insertRow(row, true));
  }

  recordOnce(input: RuntimeContextSnapshotRecordInput & { executionId: string }): RuntimeContextSnapshotDto {
    const row = this.db.prepare(`${selectSnapshots} WHERE s.task_id = ? AND s.execution_id = ? LIMIT 1`)
      .get(input.taskId, input.executionId) as SnapshotRow | undefined;
    return row ? mapRow(row) : this.record(input);
  }

  record(input: RuntimeContextSnapshotRecordInput): RuntimeContextSnapshotDto {
    const { row, snapshot } = prepareSnapshot(input);
    this.insertRow(row, false);
    return snapshot;
  }

  private insertRow(row: ReturnType<typeof prepareSnapshot>["row"], once: boolean): number {
    const insertSnapshot = this.db.prepare(
      `INSERT INTO task_runtime_context_snapshots
         (id, task_id, user_message_id, assistant_message_id, created_at, schema_version,
          welcome_mode, tag_id, project_id, project_updated_at,
          resolved_instructions_json, resolved_capabilities_json, instructions_hash, capabilities_hash, warnings_json,
          execution_id, status, started_at, completed_at, error, assembly_hash, model_id, permission_mode,
          working_directory, material_usage_json, storage_bytes)
       VALUES (@id, @taskId, @userMessageId, @assistantMessageId, @createdAt, @schemaVersion,
               @mode, @tagId, @projectId, @projectUpdatedAt,
               '[]', '[]', @instructionsHash, @capabilitiesHash, @warnings,
               @executionId, @status, @startedAt, @completedAt, @error, @assemblyHash, @modelId, @permissionMode,
               @workingDirectory, @materialUsage, @storageBytes)`,
    );
    const { instructions, capabilities, ...fields } = row;
    const instructionsHash = createHash("sha256").update(instructions).digest("hex");
    const capabilitiesHash = createHash("sha256").update(capabilities).digest("hex");
    const insertPayload = this.db.prepare(
      "INSERT INTO runtime_audit_payloads(hash, body) VALUES (?, ?) ON CONFLICT(hash) DO NOTHING",
    );
    return this.db.transaction(() => {
      if (once && (!this.db.prepare("SELECT 1 FROM tasks WHERE id=?").get(row.taskId)
        || this.db.prepare("SELECT 1 FROM task_runtime_context_snapshots WHERE execution_id=?").get(row.executionId))) return 0;
      insertPayload.run(instructionsHash, instructions);
      insertPayload.run(capabilitiesHash, capabilities);
      insertSnapshot.run({ ...fields, instructionsHash, capabilitiesHash });
      this.prune(row.taskId, row.createdAt);
      return 1;
    }).immediate();
  }

  appendMaterials(ctx: SnapshotIdentity, items: RuntimeMaterialUseDto[]): void {
    if (!items.length) return;
    const at = Date.now();
    const materials = items.map(item => ({ ...item }));
    void this.write({ kind: "appendMaterials", identity: { ...ctx }, items: materials, at }, () => this.db.transaction(() => {
      const row = this.db.prepare(`SELECT id, material_usage_json FROM task_runtime_context_snapshots
        WHERE task_id = ? AND execution_id = ? AND assistant_message_id = ? AND status = 'running'`)
        .get(ctx.taskId, ctx.executionId, ctx.assistantMessageId) as { id: string; material_usage_json: string | null } | undefined;
      const usage = row && parseMaterialUsage(parseJson(row.material_usage_json));
      if (row?.material_usage_json && usage) {
        for (const item of materials) {
          if (usage.items.some((old) => old.toolCallId === item.toolCallId && old.target === item.target && old.kind === item.kind)) continue;
          if (usage.items.length >= 100) { usage.omitted++; continue; }
          usage.items.push(item);
        }
        const json = JSON.stringify(usage);
        this.db.prepare(`UPDATE task_runtime_context_snapshots SET material_usage_json = ?, storage_bytes = storage_bytes + ? WHERE id = ?`)
          .run(json, Buffer.byteLength(json) - Buffer.byteLength(row.material_usage_json), row.id);
      }
      this.prune(ctx.taskId, at);
      return 0;
    }).immediate());
  }

  finish(taskId: string, executionId: string, status: SnapshotFinish, error?: string): void {
    const at = Date.now();
    void this.write({ kind: "finish", taskId, executionId, status, error, at }, () => this.db.prepare(
      `UPDATE task_runtime_context_snapshots
       SET status = ?, completed_at = ?, error = ?
       WHERE task_id = ? AND execution_id = ? AND status = 'running'`,
    ).run(status, at, error ?? null, taskId, executionId).changes);
  }

  finishByAssistantMessage(taskId: string, assistantMessageId: string, status: SnapshotFinish, error?: string): void {
    const at = Date.now();
    void this.write({ kind: "finishByMessage", taskId, assistantMessageId, status, error, at }, () => this.db.prepare(
      `UPDATE task_runtime_context_snapshots
       SET status = ?, completed_at = ?, error = ?
       WHERE task_id = ? AND assistant_message_id = ? AND status = 'running'`,
    ).run(status, at, error ?? null, taskId, assistantMessageId).changes);
  }

  bindAssistantMessage(identity: SnapshotIdentity): void {
    const { taskId, executionId, assistantMessageId } = identity;
    void this.write({ kind: "bindMessage", identity: { ...identity } }, () => this.db.prepare(
      `UPDATE task_runtime_context_snapshots SET assistant_message_id = ? WHERE task_id = ? AND execution_id = ?`,
    ).run(assistantMessageId, taskId, executionId).changes);
  }

  abortRunningForTask(taskId: string): void {
    const at = Date.now();
    void this.write({ kind: "abort", taskId, at }, () => this.db.prepare(
      `UPDATE task_runtime_context_snapshots
       SET status = 'aborted', completed_at = ?
       WHERE task_id = ? AND status = 'running'`,
    ).run(at, taskId).changes);
  }

  private prune(taskId: string, at: number): void {
    const cutoff = at - RUNTIME_AUDIT_MAX_AGE_MS;
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
      `${selectSnapshots} WHERE s.task_id = ? ORDER BY s.created_at DESC, s.rowid DESC LIMIT ?`,
    ).all(taskId, safeLimit) as SnapshotRow[];
    return rows.map(mapRow);
  }

  async readList(taskId: string, limit = 50): Promise<RuntimeContextSnapshotDto[]> {
    await this.flush(taskId);
    if (this.fixture && !this.reader?.supervised) return this.list(taskId, limit);
    const page = await this.reader?.snapshots(taskId, limit);
    if (!page) throw new Error("运行上下文读取未获 Rust Core 确认");
    return decodeRuntimeSnapshotPage(page);
  }

  clear(taskId?: string): number {
    const result = taskId
      ? this.db.prepare("DELETE FROM task_runtime_context_snapshots WHERE task_id = ?").run(taskId)
      : this.db.prepare("DELETE FROM task_runtime_context_snapshots").run();
    return result.changes;
  }

  async clearSaved(taskId?: string): Promise<number> {
    return this.write({ kind: "clear", taskId }, () => this.clear(taskId));
  }
}
