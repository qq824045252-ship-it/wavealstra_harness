import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ExecutionFailureDto } from "../../shared/execution-recovery";
import { isAutomationObservationFailure } from "./AutomationObservationFailure";

export interface ExecutionFailureRow {
  recordJson: string;
  resolvedAt: number | null;
  dismissedAt: number | null;
}

export type ExecutionFailureDismissReply =
  | { status: "saved"; dismissed: boolean }
  | { status: "rejected"; message: string }
  | { status: "needsHost" };

interface ExecutionFailureNativeStore {
  readonly supervised?: boolean;
  executionFailures(taskId: string): Promise<ExecutionFailureRow[] | undefined>;
  dismissExecutionFailure(taskId: string, id: string, at: number): Promise<ExecutionFailureDismissReply | undefined>;
  readDurableTaskBinding?(taskId: string): Promise<{ directory: string } | null | undefined>;
  writeExecutionFailures?<T = unknown>(request: Record<string, unknown>): Promise<T | undefined>;
}

type FailureInput = Omit<ExecutionFailureDto, "id" | "createdAt" | "resolvedAt" | "dismissedAt">;
type FailureMatch = { target?: string; causeCodes?: readonly string[]; sideEffects?: ExecutionFailureDto["sideEffects"] };

/**
 * 已完成 schema 保障与一次性遗留清理的连接。
 * 同一连接重复构造（组合根与 AgentService 各持一份）不得重放构造副作用：下面那条遗留清理
 * 是按「构造时刻」生效的数据写，重放会得到两个不同的影响行集合。
 */
const initializedConnections = new WeakSet<Database.Database>();

export class ExecutionFailureRepository {
  private writeTail: Promise<unknown> = Promise.resolve();

  constructor(private readonly fixture: Database.Database | undefined, private readonly native?: ExecutionFailureNativeStore) {
    const db = fixture;
    if (!db || db.readonly || initializedConnections.has(db)) return;
    db.exec(`CREATE TABLE IF NOT EXISTS execution_failures (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE, cause_code TEXT NOT NULL,
      record_json TEXT NOT NULL, created_at INTEGER NOT NULL, resolved_at INTEGER
    ); CREATE INDEX IF NOT EXISTS idx_execution_failures_task ON execution_failures(task_id, created_at);`);
    const columns = db.prepare("PRAGMA table_info(execution_failures)").all() as Array<{ name: string }>;
    if (!columns.some((column) => column.name === "dismissed_at")) db.exec("ALTER TABLE execution_failures ADD COLUMN dismissed_at INTEGER");
    // 已观测到退出码的非零退出是普通工具失败，不是未决的恢复状态（旧 shell 覆盖层与 execute_code
    // 都曾把它写成 Recovery 卡片）。新写入已停止，这里只把仍可见的历史行一次性隐藏，避免升级后
    // 聊天顶部残留「副作用未知」的旧卡。
    db.prepare("UPDATE execution_failures SET dismissed_at = COALESCE(dismissed_at, ?) WHERE cause_code IN ('shell-exit-nonzero', 'code-execution-exit-nonzero') AND resolved_at IS NULL AND dismissed_at IS NULL").run(Date.now());
    initializedConnections.add(db);
  }

  private get db(): Database.Database {
    if (!this.fixture) throw new Error("执行失败记录需要通过 Rust Core 读取或写入");
    return this.fixture;
  }

  flush(): Promise<void> {
    return this.writeTail.then(() => undefined, () => undefined);
  }

  private get rustRequired(): boolean {
    return !this.fixture || Boolean(this.fixture.readonly || this.native?.supervised);
  }

  private enqueueRustWrite(request: Record<string, unknown>): void {
    const next = this.writeTail.then(() => this.writeRust(request));
    this.writeTail = next.catch((error) => {
      console.warn(`[ExecutionFailures] Rust write failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private async writeRust<T>(request: Record<string, unknown>): Promise<T> {
    if (!this.native?.writeExecutionFailures) throw new Error("ExecutionFailureRepository 缺少 Rust 写入通道");
    const reply = await this.native.writeExecutionFailures<T>(request);
    if (reply === undefined) throw new Error(`执行失败记录写入未获 Rust 确认: ${String(request.kind)}`);
    return reply;
  }

  record(input: FailureInput): ExecutionFailureDto {
    const record = prepareRecord(input);
    const recordJson = JSON.stringify(record);
    if (this.native?.writeExecutionFailures && this.rustRequired) {
      this.enqueueRustWrite({ kind: "record", id: record.id, taskId: record.taskId, causeCode: record.causeCode, recordJson, createdAt: record.createdAt });
      return record;
    }
    if (this.db.readonly) throw new Error("只读数据库模式下无法写入 execution_failures");
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO execution_failures(id,task_id,cause_code,record_json,created_at) VALUES (?,?,?,?,?)")
        .run(record.id, record.taskId, record.causeCode, recordJson, record.createdAt);
      this.db.prepare("DELETE FROM execution_failures WHERE task_id = ? AND id NOT IN (SELECT id FROM execution_failures WHERE task_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 100)").run(record.taskId, record.taskId);
    })();
    return record;
  }

  recordIfAbsent(input: FailureInput): ExecutionFailureDto {
    // Dismissed failures are intentionally absent from list(); if the same failure happens again,
    // create a fresh visible record instead of reviving or silently swallowing the old one.
    const existing = this.list(input.taskId).find((item) => !item.resolvedAt && item.causeCode === input.causeCode
      && item.target === input.target && item.recovery === input.recovery && item.phase === input.phase);
    if (existing) return existing;
    if (this.native?.writeExecutionFailures && this.rustRequired) {
      const record = prepareRecord(input);
      this.enqueueRustWrite(recordIfAbsentRequest(record));
      return record;
    }
    return this.record(input);
  }

  async recordIfAbsentAsync(input: FailureInput): Promise<ExecutionFailureDto> {
    if (!this.rustRequired) return this.recordIfAbsent(input);
    const { recordJson } = await this.writeRust<{ recordJson: string }>(recordIfAbsentRequest(prepareRecord(input)));
    return JSON.parse(recordJson) as ExecutionFailureDto;
  }

  list(taskId: string, { includeDismissed = false, limit = 100 } = {}): ExecutionFailureDto[] {
    const rows = this.db.prepare(`SELECT record_json AS recordJson, resolved_at AS resolvedAt, dismissed_at AS dismissedAt FROM execution_failures
      WHERE task_id = ? AND (? OR dismissed_at IS NULL) ORDER BY created_at DESC, rowid DESC LIMIT ?`)
      .all(taskId, Number(includeDismissed), limit) as ExecutionFailureRow[];
    return this.projectRows(taskId, rows);
  }

  private projectRows(taskId: string, rows: ExecutionFailureRow[]): ExecutionFailureDto[] {
    return rows.flatMap((row) => {
      try {
        const record = JSON.parse(row.recordJson) as ExecutionFailureDto;
        if (record.taskId !== taskId || typeof record.id !== "string" || typeof record.message !== "string"
          || typeof record.causeCode !== "string" || typeof record.nextAction !== "string"
          || !["retryable", "recoverable", "requires-user-action", "terminal"].includes(record.recovery)
          || !["prepare", "execute", "observe", "verify", "recover"].includes(record.phase)
          || !["none", "known", "unknown"].includes(record.sideEffects) || !Number.isFinite(record.createdAt)) return [];
        // Apply the same classification to existing rows. Retain their tool
        // history and database evidence without claiming the failure resolved.
        if (isAutomationObservationFailure(record)) return [];
        return [{ ...record, resolvedAt: row.resolvedAt ?? undefined, dismissedAt: row.dismissedAt ?? undefined }];
      } catch { return []; } // Keep the original corrupt row for diagnosis.
    });
  }

  async listForDisplay(taskId: string): Promise<ExecutionFailureDto[]> {
    const rows = await this.native?.executionFailures(taskId);
    if (rows === undefined && this.rustRequired) throw new Error("执行失败记录读取未获 Rust 核心确认");
    const records = rows === undefined ? this.list(taskId) : this.projectRows(taskId, rows);
    const candidates = records.filter(row => !row.resolvedAt && row.phase === "verify" && row.recovery === "recoverable"
      && row.sideEffects !== "unknown" && row.executionId?.startsWith(`durable:${taskId}:`)
      && ["computer-semantic-verification-failed", "computer-semantic-verification-unavailable"].includes(row.causeCode)
      && row.message.startsWith("Computer Use ") && row.message.includes("the requested semantic postcondition"));
    if (!candidates.length) return records;
    try {
      const binding = this.rustRequired ? await this.native?.readDurableTaskBinding?.(taskId)
        : this.db.prepare("SELECT directory FROM durable_bot_bindings WHERE task_id=?").get(taskId) as { directory: string } | undefined;
      if (binding) {
        const { computerToolFeedbackIds } = await import("./durable/DurableComputerUseFeedback");
        const feedback = await computerToolFeedbackIds(binding.directory, candidates);
        return records.filter(row => !feedback.has(row.id));
      }
    } catch { /* An inaccessible receipt cannot justify hiding a recovery notice. */ }
    return records;
  }

  resolveWorkspaceFailures(taskId: string): void {
    const at = Date.now();
    if (this.native?.writeExecutionFailures && this.rustRequired) {
      this.enqueueRustWrite({ kind: "resolveWorkspaceFailures", taskId, at });
      return;
    }
    if (this.db.readonly) throw new Error("只读数据库模式下无法修改 execution_failures");
    this.db.prepare("UPDATE execution_failures SET resolved_at = ? WHERE task_id = ? AND resolved_at IS NULL AND cause_code IN ('workspace-path-missing','workspace-path-invalid','workspace-binding-missing','workspace-binding-cycle')").run(at, taskId);
  }

  /** Hide one recovery card without claiming the underlying failure is resolved. */
  dismiss(taskId: string, id: string): boolean {
    if (this.db.readonly) throw new Error("只读数据库模式下请使用 dismissForDisplay");
    const change = this.db.prepare("UPDATE execution_failures SET dismissed_at = ? WHERE id = ? AND task_id = ? AND resolved_at IS NULL AND dismissed_at IS NULL").run(Date.now(), id, taskId);
    return change.changes > 0;
  }

  async dismissForDisplay(taskId: string, id: string): Promise<boolean> {
    if (!this.native) return this.dismiss(taskId, id);
    const result = await this.native.dismissExecutionFailure(taskId, id, Date.now());
    if (result?.status === "saved") return result.dismissed;
    if (result?.status === "needsHost" && !this.rustRequired) return this.dismiss(taskId, id);
    if (result?.status === "rejected") throw new Error(result.message);
    throw new Error("无法确认恢复提示已隐藏");
  }

  resolveMatching(taskId: string, input: FailureMatch): number {
    const rows = this.db.prepare("SELECT id, cause_code, record_json FROM execution_failures WHERE task_id = ? AND resolved_at IS NULL ORDER BY created_at DESC, rowid DESC").all(taskId) as Array<{ id: string; cause_code: string; record_json: string }>;
    const ids = rows.flatMap((row) => {
      if (input.causeCodes?.length && !input.causeCodes.includes(row.cause_code)) return [];
      if (input.target !== undefined || input.sideEffects !== undefined) {
        try {
          const record = JSON.parse(row.record_json) as ExecutionFailureDto;
          if (input.target !== undefined && record.target !== input.target) return [];
          if (input.sideEffects !== undefined && record.sideEffects !== input.sideEffects) return [];
        } catch { return []; }
      }
      return [row.id];
    });
    const now = Date.now();
    if (this.native?.writeExecutionFailures && this.rustRequired) {
      this.enqueueRustWrite(resolveMatchingRequest(taskId, input, now));
      return ids.length;
    }
    if (!ids.length) return 0;
    if (this.db.readonly) throw new Error("只读数据库模式下无法修改 execution_failures");
    const update = this.db.prepare("UPDATE execution_failures SET resolved_at = ? WHERE id = ? AND task_id = ? AND resolved_at IS NULL");
    return this.db.transaction(() => ids.reduce((count, id) => count + update.run(now, id, taskId).changes, 0))();
  }

  async resolveMatchingAsync(taskId: string, input: FailureMatch): Promise<number> {
    if (!this.rustRequired) return this.resolveMatching(taskId, input);
    const { changes } = await this.writeRust<{ changes: number }>(resolveMatchingRequest(taskId, input, Date.now()));
    return changes;
  }
}

function prepareRecord(input: FailureInput): ExecutionFailureDto {
  return { ...input, message: input.message.slice(0, 8000), nextAction: input.nextAction.slice(0, 2000), id: randomUUID(), createdAt: Date.now() };
}

function recordIfAbsentRequest(record: ExecutionFailureDto) {
  return {
    kind: "recordIfAbsent",
    id: record.id,
    taskId: record.taskId,
    causeCode: record.causeCode,
    target: record.target ?? null,
    recovery: record.recovery,
    phase: record.phase,
    recordJson: JSON.stringify(record),
    createdAt: record.createdAt,
  };
}

function resolveMatchingRequest(taskId: string, input: FailureMatch, at: number) {
  return { kind: "resolveMatching", taskId, target: input.target ?? null,
    causeCodes: input.causeCodes ? [...input.causeCodes] : null, sideEffects: input.sideEffects ?? null, at };
}
