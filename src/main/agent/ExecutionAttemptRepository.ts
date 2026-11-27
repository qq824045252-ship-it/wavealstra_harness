import { createHash, randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type Database from "better-sqlite3";
import type { ConversationExecutionContext } from "./ConversationExecutionContext";
import type { ExecutionVerificationResult } from "../../shared/execution-verification";
import type { NativeExecutionReceipt } from "../../shared/native-execution-receipt";

export const EXECUTION_ATTEMPT_SCHEMA = `
  CREATE TABLE IF NOT EXISTS execution_attempts (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
    execution_id TEXT NOT NULL,
    assistant_message_id TEXT NOT NULL,
    tool_call_id TEXT NOT NULL,
    target TEXT NOT NULL,
    status TEXT NOT NULL CHECK(status IN ('running','passed','failed','inconclusive')),
    record_json TEXT NOT NULL CHECK(json_valid(record_json)),
    created_at INTEGER NOT NULL,
    finished_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_execution_attempt_scope
    ON execution_attempts(task_id, execution_id, assistant_message_id, target);
`;

export interface ExecutionAttempt extends ConversationExecutionContext {
  id: string;
  toolCallId: string;
  toolName: string;
  target: string;
  expectedExitCode?: number;
  observedExitCode?: number;
  commandHash?: string;
  providerId?: string;
  shortToolName?: string;
  transportStatus?: "succeeded" | "failed";
  verifierId: string;
  verifierVersion: number;
  verification?: ExecutionVerificationResult;
  nativeReceipt?: NativeExecutionReceipt;
  protocolVersion?: 1;
  status: "running" | "passed" | "failed" | "inconclusive";
  phase: "executing" | "verifying" | "finished";
  causeCode?: string;
  recovery?: "retryable" | "recoverable" | "requires-user-action" | "terminal";
  startedAt: number;
  finishedAt?: number;
}

type ExecutionAttemptBegin = Omit<ExecutionAttempt, "id" | "startedAt" | "status" | "phase" | "verifierId" | "verifierVersion">
  & Partial<Pick<ExecutionAttempt, "verifierId" | "verifierVersion">>;

export class ExecutionAttemptRepository {
  private writeTail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly fixture: Database.Database | undefined,
    private readonly reader?: import("../platform/runtime-audit").RuntimeAuditReader,
  ) {}

  private get db(): Database.Database {
    if (!this.fixture) throw new Error("执行尝试记录需要通过 Rust Core 读取或写入");
    return this.fixture;
  }

  flush(): Promise<void> {
    return this.writeTail.then(() => undefined, () => undefined);
  }

  private get rustRequired(): boolean {
    return !this.fixture || Boolean(this.fixture.readonly || this.reader?.supervised);
  }

  private enqueueRustWrite(request: Record<string, unknown>): void {
    const next = this.writeTail.then(() => this.writeRust(request));
    this.writeTail = next.catch(error => {
      console.warn(`[ExecutionAttempts] Rust write failed: ${error instanceof Error ? error.message : String(error)}`);
    });
  }

  private async writeRust<T>(request: Record<string, unknown>): Promise<T> {
    if (!this.reader) throw new Error("ExecutionAttemptRepository 缺少 Rust 写入通道");
    const reply = await this.reader.batch1Write<T>(request);
    if (reply === undefined) throw new Error(`执行尝试写入未获 Rust 确认: ${String(request.kind)}`);
    return reply;
  }

  begin(input: ExecutionAttemptBegin): ExecutionAttempt {
    return this.insert(input, `attempt-${randomUUID()}`);
  }

  beginDurable(input: ExecutionAttemptBegin): ExecutionAttempt {
    return this.findDurable(input, input.toolCallId) ?? this.insert(input, durableAttemptId(input, input.toolCallId));
  }

  findDurable(context: ConversationExecutionContext, toolCallId: string): ExecutionAttempt | undefined {
    const row = this.db.prepare("SELECT record_json FROM execution_attempts WHERE id=?")
      .get(durableAttemptId(context, toolCallId)) as { record_json: string } | undefined;
    return row ? JSON.parse(row.record_json) as ExecutionAttempt : undefined;
  }

  async beginDurableAsync(input: ExecutionAttemptBegin): Promise<ExecutionAttempt> {
    if (!this.rustRequired) return this.beginDurable(input);
    const record = this.runningRecord(input, durableAttemptId(input, input.toolCallId));
    const reply = await this.writeRust<{ ok: true; recordJson: string }>({ ...this.insertRequest(record), ifAbsent: true });
    const saved = JSON.parse(reply.recordJson) as ExecutionAttempt;
    if (!matchesIdentity(saved, record, record.toolCallId) || saved.id !== record.id ||
      saved.target !== record.target || saved.toolName !== record.toolName) throw new Error("Durable execution attempt identity is already in use");
    return saved;
  }

  async findDurableAsync(context: ConversationExecutionContext, toolCallId: string): Promise<ExecutionAttempt | undefined> {
    if (!this.rustRequired) return this.findDurable(context, toolCallId);
    const id = durableAttemptId(context, toolCallId);
    const record = await this.reader?.readExecutionAttempt(id, context, toolCallId);
    if (record === undefined) throw new Error("执行尝试读取未获 Rust 核心确认");
    if (record === null) return undefined;
    if (record.id !== id || !matchesIdentity(record, context, toolCallId)) throw new Error("Invalid durable execution identity");
    return record;
  }

  private runningRecord(input: ExecutionAttemptBegin, id: string): ExecutionAttempt {
    return {
      ...input,
      protocolVersion: 1,
      id,
      startedAt: Date.now(),
      status: "running",
      phase: "executing",
      verifierId: input.verifierId ?? "unassigned",
      verifierVersion: input.verifierVersion ?? 0,
    };
  }

  private insertRequest(record: ExecutionAttempt) {
    return {
      kind: "executionAttemptInsert",
      id: record.id,
      taskId: record.taskId,
      executionId: record.executionId,
      assistantMessageId: record.assistantMessageId,
      toolCallId: record.toolCallId,
      target: record.target,
      status: record.status,
      recordJson: JSON.stringify(record),
      createdAt: record.startedAt,
    };
  }

  private insert(input: ExecutionAttemptBegin, id: string): ExecutionAttempt {
    const record = this.runningRecord(input, id);
    if (this.reader && this.rustRequired) {
      this.enqueueRustWrite(this.insertRequest(record));
      return record;
    }
    if (this.db.readonly) throw new Error("只读数据库模式下无法写入 execution_attempts");
    this.db.prepare(`INSERT INTO execution_attempts
      (id,task_id,execution_id,assistant_message_id,tool_call_id,target,status,record_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(record.id, record.taskId, record.executionId,
      record.assistantMessageId, record.toolCallId, record.target, record.status, JSON.stringify(record), record.startedAt);
    return record;
  }

  /** A recovered native result can settle an attempt marked uncertain during startup. */
  settleDurable(record: ExecutionAttempt): void {
    const prior = this.findDurable(record, record.toolCallId);
    if (!this.validateDurableSettlement(record, prior)) return;
    if (this.reader && this.rustRequired) {
      this.enqueueRustWrite(this.settlementRequest(record));
      return;
    }
    if (prior.status === "running") { this.update(record); return; }
    if (this.db.readonly) throw new Error("只读数据库模式下无法写入 execution_attempts");
    this.db.prepare("UPDATE execution_attempts SET status=?,record_json=?,finished_at=? WHERE id=? AND status='inconclusive'")
      .run(record.status, JSON.stringify(record), record.finishedAt ?? null, record.id);
  }

  async settleDurableAsync(record: ExecutionAttempt): Promise<void> {
    if (!this.rustRequired) return this.settleDurable(record);
    const prior = await this.findDurableAsync(record, record.toolCallId);
    if (!this.validateDurableSettlement(record, prior)) return;
    await this.writeRust(this.settlementRequest(record));
  }

  private settlementRequest(record: ExecutionAttempt) {
    return {
      kind: "executionAttemptSettleDurable",
      id: record.id,
      taskId: record.taskId,
      executionId: record.executionId,
      assistantMessageId: record.assistantMessageId,
      toolCallId: record.toolCallId,
      target: record.target,
      status: record.status,
      recordJson: JSON.stringify(record),
      finishedAt: record.finishedAt ?? null,
      allowInconclusiveSettle: true,
    };
  }

  private validateDurableSettlement(record: ExecutionAttempt, prior: ExecutionAttempt | undefined): prior is ExecutionAttempt {
    if (record.id !== durableAttemptId(record, record.toolCallId)) throw new Error("Invalid durable execution identity");
    if (!prior) throw new Error("Durable execution attempt is missing");
    const receipt = record.nativeReceipt;
    if (receipt && (!this.matchesVerification(record) || receipt.attemptId !== prior.id || receipt.taskId !== prior.taskId ||
      receipt.executionId !== prior.executionId || receipt.executionId !== `durable:${receipt.taskId}:${receipt.conversationId}:${receipt.toolTaskId}` ||
      receipt.assistantMessageId !== prior.assistantMessageId || receipt.callId !== prior.toolCallId ||
      receipt.status !== record.status || receipt.verifierId !== record.verifierId || receipt.verifierVersion !== record.verifierVersion ||
      receipt.checkedAt !== record.verification?.checkedAt || receipt.checkedAt < prior.startedAt ||
      receipt.checkedAt !== record.finishedAt || receipt.exitCode !== record.observedExitCode || receipt.causeCode !== record.causeCode ||
      (receipt.transport === "returned" ? "succeeded" : "failed") !== record.transportStatus))
      throw new Error("Durable execution attempt disagrees with its native receipt");
    if (prior.nativeReceipt && !isDeepStrictEqual(prior.nativeReceipt, receipt))
      throw new Error("Durable execution receipt cannot be replaced");
    if (prior.status !== "running" && (prior.status !== "inconclusive" || prior.causeCode !== "application-restarted")) return false;
    if (record.status === "passed" && (prior.status === "inconclusive" || record.protocolVersion === 1) && !this.hasMatchingVerification(record)) {
      throw new Error(prior.status === "inconclusive" ? "Durable result has no matching verifier evidence" : "Execution attempt has no matching passed verifier evidence");
    }
    return true;
  }

  update(record: ExecutionAttempt): void {
    if (!this.db.prepare("SELECT 1 FROM execution_attempts WHERE id=? AND task_id=? AND execution_id=? AND assistant_message_id=? AND tool_call_id=? AND target=? AND status='running'").get(record.id, record.taskId, record.executionId, record.assistantMessageId, record.toolCallId, record.target)) throw new Error("Stale execution attempt update");
    if (record.status === "passed" && record.protocolVersion === 1 && !this.hasMatchingVerification(record)) throw new Error("Execution attempt has no matching passed verifier evidence");
    const recordJson = JSON.stringify(record);
    if (this.reader && this.rustRequired) {
      this.enqueueRustWrite({
        kind: "executionAttemptUpdate",
        id: record.id,
        taskId: record.taskId,
        executionId: record.executionId,
        assistantMessageId: record.assistantMessageId,
        toolCallId: record.toolCallId,
        target: record.target,
        status: record.status,
        recordJson,
        finishedAt: record.finishedAt ?? null,
      });
      return;
    }
    if (this.db.readonly) throw new Error("只读数据库模式下无法写入 execution_attempts");
    const changed = this.db.prepare(`UPDATE execution_attempts SET status=?,record_json=?,finished_at=?
      WHERE id=? AND task_id=? AND execution_id=? AND assistant_message_id=? AND status='running'`)
      .run(record.status, recordJson, record.finishedAt ?? null, record.id,
        record.taskId, record.executionId, record.assistantMessageId).changes;
    if (changed !== 1) throw new Error("Stale execution attempt update");
  }

  private matchesVerification(record: ExecutionAttempt): boolean {
    const result = record.verification;
    return result?.status === record.status && result.attemptId === record.id && result.taskId === record.taskId
      && result.executionId === record.executionId && result.assistantMessageId === record.assistantMessageId
      && result.verifierId === record.verifierId && result.verifierVersion === record.verifierVersion
      && result.checkedAt >= record.startedAt && result.target === record.target;
  }

  private hasMatchingVerification(record: ExecutionAttempt): boolean {
    const result = record.verification;
    return this.matchesVerification(record) && result?.status === "passed"
      && (result.verifierId !== "process-exit-code" || result.expected.exitCode === record.expectedExitCode
        && result.observed?.exitCode === record.observedExitCode && record.observedExitCode === record.expectedExitCode);
  }

  list(ctx: ConversationExecutionContext): ExecutionAttempt[] {
    return (this.db.prepare(`SELECT record_json FROM execution_attempts
      WHERE task_id=? AND execution_id=? AND assistant_message_id=? ORDER BY rowid`)
      .all(ctx.taskId, ctx.executionId, ctx.assistantMessageId) as Array<{ record_json: string }>)
      .map((row) => JSON.parse(row.record_json) as ExecutionAttempt);
  }

  async recoverInterruptedAsync(): Promise<ExecutionAttempt[]> {
    if (!this.reader) return this.recoverInterrupted();
    const res = await this.writeTail.then(() =>
      this.reader!.batch1Write<{ recovered?: ExecutionAttempt[] }>({
        kind: "executionAttemptRecoverInterrupted",
        at: Date.now(),
      }));
    if (res && Array.isArray(res.recovered)) return res.recovered;
    if (!this.rustRequired) return this.recoverInterrupted();
    throw new Error("执行中断恢复未获 Rust 核心确认");
  }

  recoverInterrupted(): ExecutionAttempt[] {
    const rows = this.db.prepare("SELECT record_json FROM execution_attempts WHERE status='running'").all() as Array<{ record_json: string }>;
    const recovered: ExecutionAttempt[] = [];
    for (const row of rows) {
      const record = JSON.parse(row.record_json) as ExecutionAttempt;
      const interrupted = { ...record, status: "inconclusive" as const, phase: "finished" as const, causeCode: "application-restarted",
        recovery: "recoverable" as const, finishedAt: Date.now() };
      this.update(interrupted);
      recovered.push(interrupted);
    }
    return recovered;
  }
}

function matchesIdentity(record: ExecutionAttempt, context: ConversationExecutionContext, toolCallId: string): boolean {
  return record.taskId === context.taskId && record.executionId === context.executionId &&
    record.assistantMessageId === context.assistantMessageId && record.toolCallId === toolCallId;
}

function durableAttemptId(context: ConversationExecutionContext, toolCallId: string): string {
  if (!context.executionId.startsWith("durable:")) throw new Error("Durable execution identity is required");
  return `attempt-durable-${createHash("sha256").update(JSON.stringify([
    context.taskId, context.executionId, context.assistantMessageId, toolCallId,
  ])).digest("hex")}`;
}
