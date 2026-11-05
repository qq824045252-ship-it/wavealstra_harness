import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { ConversationExecutionContext } from "./ConversationExecutionContext";
import type { ExecutionVerificationResult } from "../../shared/execution-verification";

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
  constructor(private readonly db: Database.Database) {}

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

  private insert(input: ExecutionAttemptBegin, id: string): ExecutionAttempt {
    const record: ExecutionAttempt = {
      ...input,
      protocolVersion: 1,
      id,
      startedAt: Date.now(),
      status: "running",
      phase: "executing",
      verifierId: input.verifierId ?? "unassigned",
      verifierVersion: input.verifierVersion ?? 0,
    };
    this.db.prepare(`INSERT INTO execution_attempts
      (id,task_id,execution_id,assistant_message_id,tool_call_id,target,status,record_json,created_at)
      VALUES (?,?,?,?,?,?,?,?,?)`).run(record.id, record.taskId, record.executionId,
      record.assistantMessageId, record.toolCallId, record.target, record.status, JSON.stringify(record), record.startedAt);
    return record;
  }

  /** A recovered native result can settle an attempt marked uncertain during startup. */
  settleDurable(record: ExecutionAttempt): void {
    if (record.id !== durableAttemptId(record, record.toolCallId)) throw new Error("Invalid durable execution identity");
    const prior = this.findDurable(record, record.toolCallId);
    if (!prior) throw new Error("Durable execution attempt is missing");
    if (prior.status === "running") { this.update(record); return; }
    if (prior.status !== "inconclusive" || prior.causeCode !== "application-restarted") return;
    if (record.status === "passed" && !this.hasMatchingVerification(record)) throw new Error("Durable result has no matching verifier evidence");
    this.db.prepare("UPDATE execution_attempts SET status=?,record_json=?,finished_at=? WHERE id=? AND status='inconclusive'")
      .run(record.status, JSON.stringify(record), record.finishedAt ?? null, record.id);
  }

  update(record: ExecutionAttempt): void {
    if (!this.db.prepare("SELECT 1 FROM execution_attempts WHERE id=? AND task_id=? AND execution_id=? AND assistant_message_id=? AND tool_call_id=? AND target=? AND status='running'").get(record.id, record.taskId, record.executionId, record.assistantMessageId, record.toolCallId, record.target)) throw new Error("Stale execution attempt update");
    if (record.status === "passed" && record.protocolVersion === 1 && !this.hasMatchingVerification(record)) throw new Error("Execution attempt has no matching passed verifier evidence");
    const changed = this.db.prepare(`UPDATE execution_attempts SET status=?,record_json=?,finished_at=?
      WHERE id=? AND task_id=? AND execution_id=? AND assistant_message_id=? AND status='running'`)
      .run(record.status, JSON.stringify(record), record.finishedAt ?? null, record.id,
        record.taskId, record.executionId, record.assistantMessageId).changes;
    if (changed !== 1) throw new Error("Stale execution attempt update");
  }

  private hasMatchingVerification(record: ExecutionAttempt): boolean {
    const result = record.verification;
    return result?.status === "passed" && result.attemptId === record.id && result.taskId === record.taskId
      && result.executionId === record.executionId && result.assistantMessageId === record.assistantMessageId
      && result.verifierId === record.verifierId && result.verifierVersion === record.verifierVersion
      && result.checkedAt >= record.startedAt
      && (result.verifierId === "process-exit-code"
        ? result.target === record.target && result.expected.exitCode === record.expectedExitCode
          && result.observed?.exitCode === record.observedExitCode && record.observedExitCode === record.expectedExitCode
        : result.target === record.target);
  }

  list(ctx: ConversationExecutionContext): ExecutionAttempt[] {
    return (this.db.prepare(`SELECT record_json FROM execution_attempts
      WHERE task_id=? AND execution_id=? AND assistant_message_id=? ORDER BY rowid`)
      .all(ctx.taskId, ctx.executionId, ctx.assistantMessageId) as Array<{ record_json: string }>)
      .map((row) => JSON.parse(row.record_json) as ExecutionAttempt);
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

function durableAttemptId(context: ConversationExecutionContext, toolCallId: string): string {
  if (!context.executionId.startsWith("durable:")) throw new Error("Durable execution identity is required");
  return `attempt-durable-${createHash("sha256").update(JSON.stringify([
    context.taskId, context.executionId, context.assistantMessageId, toolCallId,
  ])).digest("hex")}`;
}
