import type Database from "better-sqlite3";
import { z } from "zod";
import type { ModelRequestDiagnostic, TaskDiagnosticsDto, ToolDiagnosticEvent, WaitDiagnostic } from "../../shared/task-diagnostics";
import type { CacheTraceRecord } from "./CacheRequestTracer";
import type { DiagnosticModel } from "./CacheRequestTrace";
import { unknownTokenUsage } from "./ReportedTokenUsage";

const nullableNumber = z.number().finite().nullable();
const usageSchema = z.object({ input: nullableNumber, output: nullableNumber, cacheRead: nullableNumber, cacheWrite: nullableNumber });
const sourceSchema = z.enum(["main", "subagent", "auxiliary"]);
const requestSchema = z.object({
  id: z.string(), taskId: z.string().nullable(), executionScope: z.string(), conversationId: z.string(), generationTaskId: z.number(),
  sourceKind: sourceSchema, provider: z.string(), model: z.string(), startedAt: z.number(), firstResponseAt: nullableNumber,
  finishedAt: nullableNumber, modelMs: nullableNumber, status: z.enum(["running", "completed", "failed", "aborted", "interrupted"]),
  outcome: z.string().nullable(), error: z.string().nullable(), usage: usageSchema, usageSource: z.string().nullable(),
  knownCostUsd: nullableNumber, costComplete: z.boolean(),
  attempts: z.array(z.object({ number: z.number(), startedAt: z.number(), finishedAt: nullableNumber, httpStatus: nullableNumber })),
  cacheContext: z.object({ previousRequestId: z.string().nullable(), prefixStable: z.boolean().nullable(), changedFields: z.array(z.string()), coverage: z.string() }),
});
const traceSchema = z.object({
  request: z.string(), at: z.number(), event: z.string(), taskId: z.string().optional(), conversationId: z.string().optional(),
  generationTaskId: z.number().optional(), sourceKind: sourceSchema.optional(), executionScope: z.string().optional(),
  startedAt: z.number().optional(), firstResponseAt: nullableNumber.optional(), modelMs: z.number().optional(),
  reportedUsage: usageSchema.optional(), usageSource: z.string().nullable().optional(), outcome: z.string().optional(), error: z.string().optional(),
  stage: z.string().optional(), attempt: z.number().optional(), status: nullableNumber.optional(), coverage: z.string().optional(),
  previous: z.object({ request: z.string(), prefix: z.boolean().nullable(), changedFields: z.array(z.string()) }).nullable().optional(),
});
const recordRow = z.object({ record_json: z.string() });
const intervalSchema = z.object({ start: z.number(), end: z.number() });
const toolSchema = z.object({
  id: z.string(), taskId: z.string(), conversationId: z.string(), executionId: z.string(), sourceKind: sourceSchema,
  name: z.string(), callId: z.string(), startedAt: z.number(), finishedAt: nullableNumber,
  status: z.enum(["running", "completed", "failed", "interrupted"]), complete: z.boolean(),
  intervals: z.array(intervalSchema), segmentStartedAt: nullableNumber, diagnostics: z.array(z.string()),
});
type Interval = z.infer<typeof intervalSchema>;
type StoredTool = z.infer<typeof toolSchema>;
type ConversationUsage = { count: number; totals: ModelRequestDiagnostic["usage"] };
function addUsage(target: ConversationUsage, usage: ModelRequestDiagnostic["usage"]): void {
  target.count++;
  for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
    const previous = target.totals[key], next = usage[key];
    target.totals[key] = previous === null || next === null ? null : previous + next;
  }
}
const waitRow = z.object({ id: z.string(), execution_id: z.string(), title: z.string(), created_at: z.number(), resolved_at: nullableNumber, status: z.string() });

function intervalMs(intervals: Interval[]): number {
  let end = -Infinity;
  let total = 0;
  for (const interval of [...intervals].sort((a, b) => a.start - b.start)) {
    total += Math.max(0, interval.end - Math.max(end, interval.start));
    end = Math.max(end, interval.end);
  }
  return total;
}
function overlapMs(intervals: Interval[], waits: Interval[]): number {
  return intervalMs(intervals.flatMap(interval => waits.flatMap(wait => {
    const start = Math.max(interval.start, wait.start); const end = Math.min(interval.end, wait.end);
    return end > start ? [{ start, end }] : [];
  })));
}

/** A bounded, idempotent projection of observations; it never owns or resumes work. */
export class TaskDiagnosticsRepository {
  private readonly pending = new Map<string, ModelRequestDiagnostic>();
  private readonly conversationUsage = new Map<string, ConversationUsage>();
  private unavailable: string | undefined;
  constructor(private readonly db: Database.Database) {
    try {
    db.exec(`CREATE TABLE IF NOT EXISTS task_request_diagnostics (
      request_id TEXT PRIMARY KEY, task_id TEXT REFERENCES tasks(id) ON DELETE CASCADE,
      started_at INTEGER NOT NULL, record_json TEXT NOT NULL CHECK(json_valid(record_json)));
      CREATE INDEX IF NOT EXISTS idx_task_request_diagnostics ON task_request_diagnostics(task_id, started_at);
      CREATE TABLE IF NOT EXISTS task_tool_diagnostics (
      id TEXT PRIMARY KEY, task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
      started_at INTEGER NOT NULL, record_json TEXT NOT NULL CHECK(json_valid(record_json)));
      CREATE INDEX IF NOT EXISTS idx_task_tool_diagnostics ON task_tool_diagnostics(task_id, started_at);
      CREATE INDEX IF NOT EXISTS idx_task_diagnostic_waits ON conversation_interactions(task_id, execution_id);`);
    // A process restart loses the observation interval. Keep that gap unknown rather than charging downtime.
    db.prepare(`UPDATE task_request_diagnostics SET record_json=json_set(record_json,'$.status','interrupted')
      WHERE json_extract(record_json,'$.status')='running'`).run();
    db.prepare(`UPDATE task_tool_diagnostics SET record_json=json_set(record_json,'$.status','interrupted','$.complete',json('false'),'$.segmentStartedAt',NULL)
      WHERE json_extract(record_json,'$.status')='running'`).run();
    } catch { this.unavailable = "本次启动未能打开诊断存储，执行功能仍可使用"; }
  }

  observeTrace(record: CacheTraceRecord, model: DiagnosticModel): void {
    if (this.unavailable) return;
    try { this.applyTrace(record, model); } catch { /* Diagnostics must not affect execution. */ }
  }

  private applyTrace(record: CacheTraceRecord, model: DiagnosticModel): void {
    const parsed = traceSchema.safeParse(record);
    if (!parsed.success) return;
    const event = parsed.data;
    let value = this.pending.get(event.request);
    if (!value) {
      const row = recordRow.optional().parse(this.db.prepare("SELECT record_json FROM task_request_diagnostics WHERE request_id=?").get(event.request));
      value = row ? requestSchema.parse(JSON.parse(row.record_json)) : {
        id: event.request, taskId: null, executionScope: "", conversationId: "", generationTaskId: 0, sourceKind: "main",
        provider: model.provider, model: model.id, startedAt: event.startedAt ?? event.at, firstResponseAt: null, finishedAt: null,
        modelMs: null, status: "running", outcome: null, error: null, usage: unknownTokenUsage(), usageSource: null,
        knownCostUsd: null, costComplete: false, attempts: [],
        cacheContext: { previousRequestId: null, prefixStable: null, changedFields: [], coverage: "unobserved" },
      };
    }
    if (event.event === "execution" && event.conversationId && event.generationTaskId !== undefined) {
      value.taskId = event.taskId && this.db.prepare("SELECT 1 FROM tasks WHERE id=?").get(event.taskId) ? event.taskId : null;
      value.executionScope = event.executionScope ?? event.taskId ?? "global";
      value.conversationId = event.conversationId; value.generationTaskId = event.generationTaskId;
      value.sourceKind = event.sourceKind ?? "main";
    }
    if (event.event === "first-response") value.firstResponseAt ??= event.at;
    if (event.event === "request") {
      if (event.stage === "http" && event.attempt && !value.attempts.some(item => item.number === event.attempt)) {
        value.attempts.push({ number: event.attempt, startedAt: event.at, finishedAt: null, httpStatus: null });
      }
      if (event.previous?.request !== value.id && (event.stage === "http" || value.cacheContext.coverage === "unobserved")) value.cacheContext = {
        previousRequestId: event.previous?.request ?? null, prefixStable: event.previous?.prefix ?? null,
        changedFields: event.previous?.changedFields ?? [], coverage: event.coverage ?? "unobserved",
      };
    }
    if (event.event === "http-result") {
      const attempt = value.attempts.find(item => item.number === event.attempt);
      if (attempt) { attempt.finishedAt = event.at; attempt.httpStatus = event.status ?? null; }
    }
    if (event.event === "result") {
      if (value.finishedAt !== null) return;
      value.finishedAt = event.at; value.modelMs = event.modelMs ?? null; value.outcome = event.outcome ?? null;
      value.status = event.outcome === "error" ? "failed" : event.outcome === "aborted" ? "aborted" : event.outcome === "observation-failed" ? "interrupted" : "completed";
      value.error = event.error ?? null;
      value.usage = event.reportedUsage ?? unknownTokenUsage(); value.usageSource = event.usageSource ?? null;
      const rates = model.cost;
      const keys: Array<keyof typeof value.usage> = ["input", "output", "cacheRead", "cacheWrite"];
      const parts = rates ? keys.map(key => {
        const tokens = value.usage[key]; const rate = rates[key];
        return tokens !== null && Number.isFinite(rate) && rate >= 0 ? tokens * rate / 1_000_000 : null;
      }) : [];
      value.knownCostUsd = parts.some(part => part !== null) ? parts.reduce<number>((sum, part) => sum + (part ?? 0), 0) : null;
      value.costComplete = parts.length === 4 && parts.every(part => part !== null);
    }
    this.pending.set(value.id, value);
    while (this.pending.size > 256) this.pending.delete(this.pending.keys().next().value!);
    if (value.conversationId) {
      this.db.prepare(`INSERT INTO task_request_diagnostics VALUES(?,?,?,?) ON CONFLICT(request_id)
        DO UPDATE SET record_json=excluded.record_json,task_id=excluded.task_id`).run(value.id, value.taskId, value.startedAt, JSON.stringify(value));
      if (event.event === "result" && value.taskId && value.executionScope === value.taskId) {
        const summary = this.conversationUsage.get(JSON.stringify([value.taskId, value.conversationId]));
        if (summary) addUsage(summary, value.usage);
      }
    }
  }

  observeTool(event: ToolDiagnosticEvent): void {
    if (this.unavailable) return;
    try {
      if (!event.taskId || !this.db.prepare("SELECT 1 FROM tasks WHERE id=?").get(event.taskId)) return;
      const id = `${event.executionScope ?? event.taskId}:${event.conversationId}:${event.toolTaskId}`;
      const row = recordRow.optional().parse(this.db.prepare("SELECT record_json FROM task_tool_diagnostics WHERE id=?").get(id));
      let value: StoredTool = row ? toolSchema.parse(JSON.parse(row.record_json)) : {
        id, taskId: event.taskId, conversationId: event.conversationId, executionId: `durable:${event.taskId}:${event.conversationId}:${event.toolTaskId}`,
        sourceKind: event.sourceKind, name: event.name, callId: event.callId, startedAt: event.at, finishedAt: null,
        status: "running", intervals: [], segmentStartedAt: null, complete: true, diagnostics: [],
      };
      if (value.status === "completed" || value.status === "failed") return;
      if (event.phase === "start") { value.segmentStartedAt ??= event.at; value.status = "running"; }
      else {
        if (value.segmentStartedAt !== null) value.intervals.push({ start: value.segmentStartedAt, end: Math.max(value.segmentStartedAt, event.at) });
        else value.complete = false;
        value.segmentStartedAt = null; value.finishedAt = event.at;
        value.status = event.isError ? "failed" : "completed"; value.diagnostics = event.diagnostics ?? [];
      }
      this.db.prepare(`INSERT INTO task_tool_diagnostics VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET record_json=excluded.record_json`)
        .run(value.id, value.taskId, value.startedAt, JSON.stringify(value));
    } catch { /* Observation cannot affect the tool outcome. */ }
  }

  usageForConversation(taskId: string, conversationId: string) {
    const unknown = { inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheHitRate: null };
    if (this.unavailable) return unknown;
    try {
    const key = JSON.stringify([taskId, conversationId]);
    let records = this.conversationUsage.get(key);
    if (!records) {
      const rows = this.db.prepare(`SELECT record_json FROM task_request_diagnostics WHERE task_id=?
      AND json_extract(record_json,'$.conversationId')=? AND json_extract(record_json,'$.executionScope')=?
      AND json_extract(record_json,'$.status')!='running'`).all(taskId, conversationId, taskId)
      .map(row => requestSchema.parse(JSON.parse(recordRow.parse(row).record_json)));
      records = { count: 0, totals: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };
      for (const row of rows) addUsage(records, row.usage);
      this.conversationUsage.set(key, records);
      while (this.conversationUsage.size > 32) this.conversationUsage.delete(this.conversationUsage.keys().next().value!);
    }
    const summary = records;
    const sum = (key: keyof ModelRequestDiagnostic["usage"]) => summary.count ? summary.totals[key] : null;
    const inputTokens = sum("input"), outputTokens = sum("output"), cacheReadTokens = sum("cacheRead"), writes = sum("cacheWrite");
    const total = inputTokens !== null && cacheReadTokens !== null && writes !== null ? inputTokens + cacheReadTokens + writes : null;
    return { inputTokens, outputTokens, cacheReadTokens, cacheHitRate: total && cacheReadTokens !== null ? cacheReadTokens / total : null };
    } catch { return unknown; }
  }

  usageForGeneration(taskId: string | undefined, conversationId: string, generationTaskId: number, executionScope = taskId ?? "global") {
    if (this.unavailable) return { ...unknownTokenUsage(), costTotal: null };
    try {
    const row = recordRow.optional().parse(this.db.prepare(`SELECT record_json FROM task_request_diagnostics WHERE task_id IS ?
      AND json_extract(record_json,'$.conversationId')=? AND json_extract(record_json,'$.generationTaskId')=?
      AND json_extract(record_json,'$.executionScope')=? ORDER BY started_at DESC LIMIT 1`).get(taskId ?? null, conversationId, generationTaskId, executionScope));
    const value = row ? requestSchema.parse(JSON.parse(row.record_json)) : undefined;
    return { ...(value?.usage ?? unknownTokenUsage()), costTotal: value?.costComplete ? value.knownCostUsd : null };
    } catch { return { ...unknownTokenUsage(), costTotal: null }; }
  }

  list(taskId: string, limit = 200, offset = 0): TaskDiagnosticsDto {
    try { return this.readList(taskId, limit, offset); }
    catch { return this.emptyList(taskId, "诊断记录暂时无法读取，执行功能仍可使用"); }
  }

  private emptyList(taskId: string, unavailable: string): TaskDiagnosticsDto {
    return { taskId, capturedAt: Date.now(), offset: 0, requests: [], tools: [], waits: [], truncated: false, unavailable,
      totals: { modelMs: null, toolMs: null, waitingMs: 0, knownCostUsd: null, costComplete: false, unknownUsageRequests: 0 } };
  }

  private readList(taskId: string, limit: number, offset: number): TaskDiagnosticsDto {
    const bound = Math.max(1, Math.min(500, Math.floor(limit) || 200)); const now = Date.now();
    const skip = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
    if (this.unavailable) return this.emptyList(taskId, this.unavailable);
    const requestRows = this.db.prepare("SELECT record_json FROM task_request_diagnostics WHERE task_id=? ORDER BY started_at DESC,request_id DESC LIMIT ? OFFSET ?").all(taskId, bound + 1, skip);
    const requests = requestRows.slice(0, bound).flatMap(row => {
      const result = requestSchema.safeParse(JSON.parse(recordRow.parse(row).record_json)); return result.success ? [result.data] : [];
    });
    const waitRows = this.db.prepare("SELECT id,execution_id,title,created_at,resolved_at,status FROM conversation_interactions WHERE task_id=? ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?").all(taskId, bound + 1, skip);
    const waits: WaitDiagnostic[] = waitRows.slice(0, bound).map(row => { const item = waitRow.parse(row); return { id: item.id, executionId: item.execution_id, title: item.title,
        startedAt: item.created_at, finishedAt: item.resolved_at, status: item.status }; });
    const stored = this.db.prepare("SELECT record_json FROM task_tool_diagnostics WHERE task_id=? ORDER BY started_at DESC,id DESC LIMIT ? OFFSET ?").all(taskId, bound + 1, skip)
      .map(row => toolSchema.parse(JSON.parse(recordRow.parse(row).record_json)));
    const toolWaiting = new Map<string, Interval[]>();
    const executionIds = stored.slice(0, bound).map(value => value.executionId);
    if (executionIds.length) {
      const rows = this.db.prepare(`SELECT execution_id,created_at AS start,COALESCE(resolved_at,?) AS end
        FROM conversation_interactions WHERE task_id=? AND execution_id IN (${executionIds.map(() => "?").join(",")})`).all(now, taskId, ...executionIds);
      for (const row of rows) {
        const interval = intervalSchema.extend({ execution_id: z.string() }).parse(row);
        const existing = toolWaiting.get(interval.execution_id) ?? [];
        existing.push(interval); toolWaiting.set(interval.execution_id, existing);
      }
    }
    const tools = stored.slice(0, bound).map(value => {
      const intervals = [...value.intervals, ...(value.segmentStartedAt !== null ? [{ start: value.segmentStartedAt, end: now }] : [])];
      const observedMs = intervalMs(intervals);
      const waitingMs = overlapMs(intervals, toolWaiting.get(value.executionId) ?? []);
      return { id: value.id, conversationId: value.conversationId, executionId: value.executionId, sourceKind: value.sourceKind,
        name: value.name, callId: value.callId, startedAt: value.startedAt, finishedAt: value.finishedAt, status: value.status,
        observedMs, activeMs: Math.max(0, observedMs - waitingMs), waitingMs, complete: value.complete, diagnostics: value.diagnostics };
    });
    return { taskId, capturedAt: now, offset: skip, requests, tools, waits, truncated: requestRows.length > bound || stored.length > bound || waitRows.length > bound,
      totals: { modelMs: requests.some(value => value.modelMs !== null) ? requests.reduce((sum, value) => sum + (value.modelMs ?? 0), 0) : null,
        toolMs: tools.some(value => value.complete || value.observedMs > 0) ? tools.reduce((sum, value) => sum + value.activeMs, 0) : null,
        waitingMs: intervalMs(waits.map(wait => ({ start: wait.startedAt, end: wait.finishedAt ?? now }))),
        knownCostUsd: requests.some(value => value.knownCostUsd !== null) ? requests.reduce((sum, value) => sum + (value.knownCostUsd ?? 0), 0) : null,
        costComplete: requests.length > 0 && requests.every(value => value.costComplete),
        unknownUsageRequests: requests.filter(value => Object.values(value.usage).some(count => count === null)).length } };
  }
}
