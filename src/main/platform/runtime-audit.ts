import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { TaskDiagnosticsDto, ToolDiagnosticEvent } from "../../shared/task-diagnostics";
import type { TaskUserQuestionsDto } from "../../shared/agent-ipc";
import type { LibraryItemDto } from "../../shared/library-ipc";
import type { RuntimeSnapshotMutation, RuntimeSnapshotPage } from "../agent/RuntimeContextSnapshotRepository";
import type { RuntimeDiagnosticTrace } from "../agent/TaskDiagnosticsRepository";
import type { TaskRow } from "../db/AppDatabase";
import type { StoredArtifactSnapshot } from "../artifact/ArtifactRepository";
import type { TaskExpertBindingDto } from "../../shared/expert-binding";
import type { RuntimeMemoryCapture } from "../memory/MemoryTurnRepository";
import type { ContentExtractionStatus } from "../library/ContentExtractorRegistry";
import type { SemanticInstallation } from "../retrieval/SemanticModelManager";
import type { RuntimeUsageJob, RuntimeUsageReport, UsageReportResult } from "../usage/UsageStatsService";
import { currentPlatformId } from "./index";

export function locateRuntimeAudit(appPath: string, resources?: string): string | undefined {
  if (process.arch !== "x64" || currentPlatformId === "macos") return undefined;
  const windows = currentPlatformId === "windows";
  const directory = resources
    ? join(resources, "runtime-audit")
    : join(appPath, "out", "native", windows ? "win-x64" : "linux-x64");
  return join(directory, windows ? "mybuddy-runtime-audit.exe" : "mybuddy-runtime-audit");
}

export function locateSemanticInferenceLibrary(): string | undefined {
  if (process.arch !== "x64" || currentPlatformId === "macos") return undefined;
  try {
    const windows = currentPlatformId === "windows";
    const root = resolve(dirname(require.resolve("onnxruntime-node")), "..")
      .replace(/([\\/])app\.asar([\\/])/i, "$1app.asar.unpacked$2");
    const library = join(root, "bin", "napi-v6", windows ? "win32" : "linux", "x64",
      windows ? "onnxruntime.dll" : "libonnxruntime.so.1");
    if (existsSync(library)) return library;
  } catch { /* Existing JavaScript fallback owns model availability. */ }
}

export type RuntimeDiagnosticWrite =
  | { kind: "trace"; request: { id: string; provider: string; model: string; startedAt: number; events: RuntimeDiagnosticTrace[] } }
  | { kind: "tool"; event: ToolDiagnosticEvent };

/** One worker per host database for read-only queries and bounded writes. */
export class RuntimeAuditReader {
  private tail: Promise<unknown> = Promise.resolve();
  private inferenceTail: Promise<unknown> = Promise.resolve();
  private inferenceCapability?: Promise<boolean>;
  private embeddingIndexCapability?: Promise<boolean>;
  private embeddingPlannerCapability?: Promise<boolean>;
  private modelProbeCapability?: Promise<boolean>;
  private inferenceFailed = false;
  private session?: AuditSession;
  private closed = false;
  private state?: "ready" | "unavailable";
  private stopping?: Promise<void>;
  private diagnosticWriterReady = false;
  private snapshotWriterReady = false;
  private usageReaderReady = false;
  private usageHistoryReady = false;
  private usageCsvReady = false;
  private liveUsageReady = false;
  private memoryCaptureReady = false;
  private libraryIndexWriterReady = false;
  private embeddingIndexWriterReady = false;
  private embeddingPlannerReady = false;
  private modelProbeReady = false;
  private taskListReady = false;
  private artifactSnapshotsReady = false;
  private taskBoardReady = false;
  private libraryMetadataReady = false;
  private projectMetadataReady = false;
  private cronDataReady = false;

  constructor(private readonly executable: string | undefined, private readonly dbPath: string) {}

  snapshots(taskId: string, limit: number): Promise<RuntimeSnapshotPage | undefined> {
    if (!Number.isFinite(limit)) return Promise.resolve(undefined);
    return this.read({ operation: "snapshots", taskId, limit: Math.max(1, Math.min(200, Math.trunc(limit))) });
  }

  async artifactSnapshots(taskIds: readonly string[]): Promise<StoredArtifactSnapshot[] | undefined> {
    const rows = await this.read<StoredArtifactSnapshot[]>({ operation: "artifactSnapshots", taskIds });
    if (Array.isArray(rows)) {
      if (!this.artifactSnapshotsReady) {
        this.artifactSnapshotsReady = true;
        console.info("[RuntimeAudit] Rust artifact snapshots ready");
      }
      return rows;
    }
  }

  async taskList(dotsTaskId: string, includeExpertBindings: boolean): Promise<Array<TaskRow & {
    expertBinding?: TaskExpertBindingDto;
  }> | undefined> {
    const rows = await this.read<Array<TaskRow & { expertBinding?: TaskExpertBindingDto }>>({
      operation: "taskList", dotsTaskId, includeExpertBindings,
    });
    if (Array.isArray(rows)) {
      if (!this.taskListReady) {
        this.taskListReady = true;
        console.info("[RuntimeAudit] Rust task list ready");
      }
      return rows;
    }
  }

  async taskBoard<Row>(query: RuntimeTaskBoardQuery): Promise<RuntimeTaskBoardPage<Row> | undefined> {
    const page = await this.read<RuntimeTaskBoardPage<Row>>({ operation: "taskBoard", query });
    if (page && Array.isArray(page.rows)) {
      if (!this.taskBoardReady) {
        this.taskBoardReady = true;
        console.info("[RuntimeAudit] Rust task board ready");
      }
      return page;
    }
  }

  async libraryMetadata<T>(query: RuntimeLibraryMetadataQuery): Promise<T | undefined> {
    const result = await this.read<T>({ operation: "libraryMetadata", query });
    if (result !== undefined && !this.libraryMetadataReady) {
      this.libraryMetadataReady = true;
      console.info("[RuntimeAudit] Rust library metadata ready");
    }
    return result;
  }

  async projectMetadata<T>(query: RuntimeProjectMetadataQuery): Promise<T | undefined> {
    const result = await this.read<T>({ operation: "projectMetadata", query });
    if (result !== undefined && !this.projectMetadataReady) {
      this.projectMetadataReady = true;
      console.info("[RuntimeAudit] Rust project metadata ready");
    }
    return result;
  }

  async cronData<T>(query: RuntimeCronDataQuery): Promise<T | undefined> {
    const result = await this.read<T>({ operation: "cronData", query });
    if (result !== undefined && !this.cronDataReady) {
      this.cronDataReady = true;
      console.info("[RuntimeAudit] Rust automation data ready");
    }
    return result;
  }

  async compactSnapshots(): Promise<number> {
    const batchSize = 16;
    let total = 0;
    while (!this.closed) {
      const migrated = await this.read<number>({ operation: "compactSnapshots", limit: batchSize });
      if (migrated === undefined) break;
      total += migrated;
      if (migrated < batchSize) break;
      await delay(100, undefined, { ref: false });
    }
    return total;
  }

  async usageReport(report: RuntimeUsageReport, coverage: boolean): Promise<UsageReportResult | undefined> {
    const result = await this.read<UsageReportResult>({ operation: "usageReport", report, coverage });
    if (result !== undefined && !this.usageReaderReady) {
      this.usageReaderReady = true;
      console.info("[RuntimeAudit] Rust usage reports ready");
    }
    return result;
  }

  async usageCsv(since: number, coverage: boolean): Promise<string | undefined> {
    if (!Number.isSafeInteger(since)) return undefined;
    const result = await this.read<string>({ operation: "usageCsv", since, coverage });
    if (typeof result !== "string") return undefined;
    if (!this.usageCsvReady) {
      this.usageCsvReady = true;
      console.info("[RuntimeAudit] Rust usage CSV ready");
    }
    return result;
  }

  async usageHistory(job: RuntimeUsageJob): Promise<number | "changed" | undefined> {
    const result = await this.read<number | "changed">({ operation: "usageHistory", job });
    if (result === "changed") return result;
    if (typeof result !== "number" || !Number.isSafeInteger(result) || result < 0) {
      await this.stopping;
      return undefined;
    }
    if (job.kind === "live" && !this.liveUsageReady && result > 0) {
      this.liveUsageReady = true;
      console.info("[RuntimeAudit] Rust live usage writer ready");
    }
    if ((job.kind === "session" || job.kind === "subagents") && !this.usageHistoryReady && result > 0) {
      this.usageHistoryReady = true;
      console.info("[RuntimeAudit] Rust usage history writer ready");
    }
    return result;
  }

  async captureMemory(capture: RuntimeMemoryCapture): Promise<number | undefined> {
    const saved = await this.read<number>({ operation: "captureMemory", capture });
    if (typeof saved !== "number" || !Number.isSafeInteger(saved) || saved < 0) {
      await this.stopping;
      return undefined;
    }
    if (saved > 0 && !this.memoryCaptureReady) {
      this.memoryCaptureReady = true;
      console.info("[RuntimeAudit] Rust memory capture ready");
    }
    return saved;
  }

  async mutateSnapshot(epoch: number, writeId: string, mutation: RuntimeSnapshotMutation): Promise<number | undefined> {
    const count = await this.read<number>({ operation: "mutateSnapshot", epoch, writeId, mutation });
    if (count === undefined || !Number.isSafeInteger(count) || count < 0) {
      await this.stopping;
      return undefined;
    }
    if (!this.snapshotWriterReady) {
      this.snapshotWriterReady = true;
      console.info("[RuntimeAudit] Rust snapshot writer ready");
    }
    return count;
  }

  diagnostics(taskId: string, limit?: number, offset = 0): Promise<TaskDiagnosticsDto | undefined> {
    const bound = typeof limit === "number" && Number.isFinite(limit) && limit > 0
      ? Math.max(1, Math.min(500, Math.floor(limit))) : undefined;
    const skip = Number.isSafeInteger(offset) && offset >= 0 ? offset : 0;
    return this.read({ operation: "diagnostics", taskId, limit: bound, offset: skip, capturedAt: Date.now() });
  }

  async writeDiagnostics(epoch: number, sequence: number, writes: RuntimeDiagnosticWrite[]): Promise<boolean> {
    const committed = await this.read<boolean>({ operation: "writeDiagnostics", epoch, sequence, writes });
    if (committed === true && !this.diagnosticWriterReady) {
      this.diagnosticWriterReady = true;
      console.info("[RuntimeAudit] Rust diagnostics writer ready");
    }
    return committed === true;
  }

  semantic(search: RuntimeSemanticSearch): Promise<RuntimeSemanticHit[] | undefined> {
    if (!Number.isFinite(search.threshold) || search.query.length !== search.dimension
        || search.query.some(value => !Number.isFinite(value))) return Promise.resolve(undefined);
    return this.read({ ...search, operation: "semantic", query: Array.from(search.query) });
  }

  async semanticInference(model: RuntimeSemanticModel, text?: string | number[]): Promise<RuntimeSemanticEmbedding | undefined> {
    if (this.inferenceFailed) return undefined;
    this.inferenceCapability ??= this.read<boolean>({ operation: "nativeInferenceSupported" }).then(value => value === true);
    if (!await this.inferenceCapability) return undefined;
    return this.read({ operation: "semanticInference", request: { model, text } }, "inference");
  }

  async probeSemanticModel(probe: RuntimeSemanticModelProbe): Promise<SemanticInstallation | undefined> {
    this.modelProbeCapability ??= this.read<boolean>({ operation: "nativeModelProbeSupported" }).then(value => value === true);
    if (!await this.modelProbeCapability) return undefined;
    const status = await this.read<SemanticInstallation>({ operation: "semanticModelProbe", probe }, "inference", true);
    if (status?.status === "ready" && !this.modelProbeReady) {
      this.modelProbeReady = true;
      console.info("[RuntimeAudit] Rust semantic model verification ready");
    }
    return status;
  }

  async stageEmbedding(model: RuntimeSemanticModel, modelId: string, modelVersion: string,
    source: RuntimeEmbeddingSource): Promise<RuntimeEmbeddingStage | undefined> {
    if (this.inferenceFailed) return undefined;
    this.embeddingIndexCapability ??= this.read<boolean>({ operation: "nativeEmbeddingIndexSupported" })
      .then(value => value === true);
    if (!await this.embeddingIndexCapability) return undefined;
    const token = randomUUID();
    const status = await this.read<RuntimeEmbeddingStage["status"]>({
      operation: "stageEmbedding", request: { token, model, modelId, modelVersion, source },
    }, "inference");
    if (status === "staged") return { status, token };
    if (status === "current" || status === "skipped") return { status };
    return undefined;
  }

  async publishEmbeddings(tokens: string[]): Promise<RuntimeEmbeddingCounts | undefined> {
    const result = await this.read<RuntimeEmbeddingCounts>({ operation: "publishEmbeddings", tokens, at: Date.now() });
    if (!result) {
      await this.stopping;
      return undefined;
    }
    if (!this.embeddingIndexWriterReady && result.indexed > 0) {
      this.embeddingIndexWriterReady = true;
      console.info("[RuntimeAudit] Rust semantic index writer ready");
    }
    return result;
  }

  async discardEmbeddings(tokens: string[]): Promise<void> {
    if (tokens.length) await this.read<boolean>({ operation: "discardEmbeddings", tokens });
  }

  async embeddingIndex<Q extends RuntimeEmbeddingQuery>(query: Q): Promise<RuntimeEmbeddingQueryResults[Q["kind"]] | undefined> {
    this.embeddingPlannerCapability ??= this.read<boolean>({ operation: "nativeEmbeddingPlannerSupported" })
      .then(value => value === true);
    if (!await this.embeddingPlannerCapability) return undefined;
    const result = await this.read<RuntimeEmbeddingQueryResults[Q["kind"]]>({ operation: "embeddingIndex", query });
    if (result !== undefined && !this.embeddingPlannerReady) {
      this.embeddingPlannerReady = true;
      console.info("[RuntimeAudit] Rust semantic index planner ready");
    }
    return result;
  }

  memoryLexical(search: RuntimeMemoryLexicalSearch): Promise<RuntimeMemoryLexicalCandidates | undefined> {
    // The bundled ICU tables follow Unicode 17. Use the host tables if Electron's version changes.
    if (process.versions.unicode !== "17.0") return Promise.resolve(undefined);
    const units = (text: string) => Array.from({ length: text.length }, (_, index) => text.charCodeAt(index));
    return this.read({
      ...search, operation: "memoryLexical", compact: units(search.compact),
      terms: search.terms.map(units), ftsQuery: search.ftsQuery === null ? null : units(search.ftsQuery),
    });
  }

  async stageLibraryText(input: { path: string; stagingPath: string; expectedSize: number; chunkSize: number; overlap: number;
    copyTo?: string; refuseMarkdownLinks?: boolean }) {
    const result = await this.read<{ status: "ready"; contentHash: string; chunkCount: number } | { status: "needsLinkRewrite" }>({
      ...input, operation: "libraryText",
    });
    if (!result) await this.stopping;
    return result?.status === "ready" ? result : undefined;
  }

  async publishLibraryIndex(publication: RuntimeLibraryIndexPublication): Promise<RuntimeLibraryIndexStatus | undefined> {
    return this.writeLibraryIndex({ operation: "publishLibraryIndex", publication });
  }

  async publishLibraryDocument(publication: RuntimeLibraryDocumentPublication): Promise<RuntimeLibraryIndexStatus | undefined> {
    return this.writeLibraryIndex({ operation: "publishLibraryDocument", publication });
  }

  private async writeLibraryIndex(request: object): Promise<RuntimeLibraryIndexStatus | undefined> {
    const status = await this.read<RuntimeLibraryIndexStatus>(request);
    if (status === "indexed" && !this.libraryIndexWriterReady) {
      this.libraryIndexWriterReady = true;
      console.info("[RuntimeAudit] Rust library index writer ready");
    }
    if (status === "indexed" || status === "skipped" || status === "sourceChanged") return status;
    await this.stopping;
    return undefined;
  }

  async openDurable(path: string): Promise<RuntimeAuditDurableSnapshot | undefined> {
    const session = randomUUID();
    const request = <T>(action: object) => this.read<T>({ operation: "durable", session, ...action });
    if (await request<boolean>({ action: "open", path }) !== true) return undefined;
    return {
      select: (sql, parameters, first) => request({ action: "select", sql, parameters, first }),
      head: (conversationId, maxTokens) => request({ action: "head", conversationId, maxTokens }),
      questions: (conversationId, beforeEntryId) => request({ action: "questions", conversationId, beforeEntryId }),
      close: async () => {
        if (this.session && await request<boolean>({ action: "close" }) !== true && this.session) this.stop(this.session);
        await this.stopping;
      },
    };
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.session) this.stop(this.session);
    await this.stopping;
  }

  private read<T>(request: object, lane: AuditLane = "database", allowAfterInferenceFailure = false): Promise<T | undefined> {
    const executable = this.executable;
    if (!executable || !this.dbPath || this.dbPath === ":memory:") return Promise.resolve(undefined);
    const previous = lane === "inference" ? this.inferenceTail : this.tail;
    const pending = previous.then(() => new Promise<T | undefined>(resolve => {
      if (this.closed || (lane === "inference" && this.inferenceFailed && !allowAfterInferenceFailure)) {
        resolve(undefined);
        return;
      }
      const session = this.session ?? this.start(executable);
      session.pending[lane] = {
        resolve: value => resolve(value as T | undefined),
        timer: setTimeout(() => this.stop(session), lane === "inference" ? 120_000 : 10_000).unref(),
      };
      session.child.stdin.write(JSON.stringify(request) + "\n", error => {
        if (error) this.stop(session);
      });
    })).catch(() => { this.unavailable(); return undefined; });
    if (lane === "inference") this.inferenceTail = pending;
    else this.tail = pending;
    return pending;
  }

  private start(executable: string): AuditSession {
    const child = spawn(executable, [this.dbPath], {
      windowsHide: true,
      env: {
        ...(process.env.SystemRoot && { SystemRoot: process.env.SystemRoot }),
        ...(process.env.TZ && { TZ: process.env.TZ }),
      },
    });
    const closed = new Promise<void>(resolve => child.once("close", resolve));
    const session: AuditSession = { child, closed, pending: {}, chunks: [], bytes: 0 };
    this.session = session;
    child.on("error", () => this.stop(session));
    child.on("exit", () => this.stop(session));
    child.stdin.on("error", () => this.stop(session));
    child.stdout.on("data", (chunk: Buffer) => this.receive(session, chunk));
    child.stderr.resume();
    return session;
  }

  private receive(session: AuditSession, chunk: Buffer): void {
    let offset = 0;
    while (this.session === session && offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const part = chunk.subarray(offset, newline < 0 ? chunk.length : newline + 1);
      session.bytes += part.length;
      if (session.bytes > 32 * 1024 * 1024) { this.stop(session); return; }
      session.chunks.push(part);
      if (newline < 0) return;
      const line = Buffer.concat(session.chunks, session.bytes).toString("utf8");
      session.chunks = [];
      session.bytes = 0;
      this.receiveReply(session, line);
      offset = newline + 1;
    }
  }

  private receiveReply(session: AuditSession, line: string): void {
    let reply: { status?: string; data?: unknown; inference?: boolean };
    try { reply = JSON.parse(line); } catch { this.stop(session); return; }
    const lane = reply?.inference === true ? "inference" : "database";
    const pending = session.pending[lane];
    if (!pending) { this.stop(session); return; }
    if (reply?.status !== "ok" || reply.data === undefined) {
      if (lane === "database") this.unavailable();
      else this.inferenceFailed = true;
    }
    else {
      if (this.state !== "ready") console.info("[RuntimeAudit] Rust reader ready");
      this.state = "ready";
    }
    clearTimeout(pending.timer);
    delete session.pending[lane];
    pending.resolve(reply?.status === "ok" ? reply.data : undefined);
  }

  private stop(session: AuditSession): void {
    if (this.session !== session) return;
    this.session = undefined;
    this.inferenceCapability = undefined;
    this.embeddingIndexCapability = undefined;
    this.embeddingPlannerCapability = undefined;
    this.modelProbeCapability = undefined;
    if (session.pending.inference) this.inferenceFailed = true;
    this.stopping = session.closed;
    if (session.child.exitCode === null && session.child.signalCode === null) session.child.kill();
    for (const pending of Object.values(session.pending)) {
      clearTimeout(pending.timer);
      pending.resolve(undefined);
    }
    if (session.pending.database) this.unavailable();
    session.pending = {};
  }

  private unavailable(): void {
    if (this.closed || this.state === "unavailable") return;
    this.state = "unavailable";
    console.warn("[RuntimeAudit] Rust reader unavailable, using the host reader");
  }
}

export interface RuntimeTaskBoardQuery {
  sql: string;
  countSql?: string;
  parameters: Record<string, string | number | null>;
  size: number;
  hasCursor: boolean;
}

export interface RuntimeTaskBoardPage<Row> {
  rows: Row[];
  total?: number;
}

type RuntimeLibraryMetadataQuery =
  | { kind: "catalog"; spaceIds?: string[]; itemId?: string }
  | { kind: "trash"; spaceIds: string[] }
  | { kind: "versions"; itemId: string };

type RuntimeProjectMetadataQuery =
  | { kind: "list"; includeArchived: boolean }
  | { kind: "todos"; projectId: string }
  | { kind: "events"; projectId: string; limit: number }
  | { kind: "status"; projectId: string; now: number };

type RuntimeCronDataQuery =
  | { kind: "jobs" }
  | { kind: "runs"; limit: number; jobIds?: string[] }
  | { kind: "jobRuns"; jobId: string; limit: number; before?: { startedAt: number; id: string } }
  | { kind: "runInput"; runId: string };

export type RuntimeLibraryIndexStatus = "indexed" | "skipped" | "sourceChanged";

type RuntimeLibraryIndexItem = Pick<LibraryItemDto,
  "id" | "spaceId" | "title" | "filename" | "kind" | "mimeType" | "contentHash" | "updatedAt" | "sizeBytes" | "extractStatus">;

export interface RuntimeLibrarySourceVersion {
  sourcePath: string;
  sourceSize: number;
  sourceModifiedNanos: string;
}

interface RuntimeLibraryIndexPublication extends RuntimeLibrarySourceVersion {
  item: RuntimeLibraryIndexItem;
  stagingUri: string;
  chunkCount: number;
  indexedAt: number;
  onlyMissing: boolean;
}

export type RuntimeLibraryDocumentContent =
  | { kind: "textFile" }
  | { kind: "extracted"; status: ContentExtractionStatus; text: string | null };

interface RuntimeLibraryDocumentPublication {
  item: RuntimeLibraryIndexItem;
  source?: RuntimeLibrarySourceVersion;
  content: RuntimeLibraryDocumentContent;
  indexedAt: number;
  onlyMissing: boolean;
  chunkSize: number;
  overlap: number;
}

export interface RuntimeAuditDurableSnapshot {
  select(sql: string, parameters: Array<string | number | null>, first: boolean): Promise<unknown>;
  head(conversationId: number, maxTokens: number): Promise<string | undefined>;
  questions(conversationId: number, beforeEntryId?: number): Promise<(Omit<TaskUserQuestionsDto, "nextBefore"> & { nextBefore: number | null }) | undefined>;
  close(): Promise<void>;
}

type RuntimeSemanticSearch = {
  modelId: string;
  modelVersion: string;
  dimension: number;
  query: Float32Array;
  threshold: number;
  scope: { sql: string; args: Array<string | number> };
} & ({ target: "memory" } | { target: "library"; limit: number });

export interface RuntimeSemanticHit { id: string; hash: string; score: number }

export interface RuntimeSemanticModel {
  libraryPath: string;
  modelPath: string;
  tokenizerPath: string;
  dimension: number;
  revision?: string;
}

export interface RuntimeSemanticModelProbe {
  roots: string[];
  fallbackRoot: string;
  modelId: string;
  modelVersion: string;
  dimension: number;
  requiredFiles: readonly string[];
}

export interface RuntimeEmbeddingSource {
  kind: "memory" | "library";
  id: string;
  hash: string;
}

export type RuntimeEmbeddingStage = { status: "staged"; token: string } | { status: "current" | "skipped" };

type RuntimeEmbeddingIndexModel = { modelId: string; modelVersion: string; dimension: number };
export interface RuntimeEmbeddingStats { total: number; completed: number }
type RuntimeEmbeddingCandidate = { id: string; hash: string | null };

type RuntimeEmbeddingQuery =
  | { kind: "libraryStats"; model: RuntimeEmbeddingIndexModel }
  | { kind: "libraryPage"; model: RuntimeEmbeddingIndexModel; after: string | null; limit: number }
  | { kind: "openMemoryQueue"; model: RuntimeEmbeddingIndexModel; queueId: string; limit?: number }
  | { kind: "memoryPage"; queueId: string; limit: number }
  | { kind: "closeMemoryQueue"; queueId: string };

interface RuntimeEmbeddingQueryResults {
  libraryStats: RuntimeEmbeddingStats;
  libraryPage: Array<{ id: string; hash: string }>;
  openMemoryQueue: RuntimeEmbeddingStats;
  memoryPage: RuntimeEmbeddingCandidate[];
  closeMemoryQueue: boolean;
}

interface RuntimeEmbeddingCounts {
  indexed: number;
  current: number;
  skipped: number;
}

interface RuntimeSemanticEmbedding {
  loadMs: number;
  vector?: number[] | null;
}

type RuntimeMemoryLexicalSearch = {
  scope: { sql: string; args: Array<string | number> };
  compact: string;
  terms: string[];
  ftsQuery: string | null;
  exactIdentifier: boolean;
};

export interface RuntimeMemoryLexicalMatch {
  id: string;
  content_hash: string;
  importance: number;
  updated_at: number;
  exact: number;
  relevance: number;
}

export interface RuntimeMemoryLexicalCandidates {
  fts: string[];
  lexical: RuntimeMemoryLexicalMatch[];
}

type AuditLane = "database" | "inference";

interface AuditSession {
  child: ChildProcessWithoutNullStreams;
  closed: Promise<void>;
  chunks: Buffer[];
  bytes: number;
  pending: Partial<Record<AuditLane, {
    resolve(value: unknown): void;
    timer: ReturnType<typeof setTimeout>;
  }>>;
}
