import { randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ApiProviderError, normalizeApiBaseUrl, requiredText, type ResolvedApiConnection } from "./providers/ApiServiceConnection";

export interface VideoConnectionSnapshot {
  id: string;
  label: string;
  baseUrl: string;
  protocol: ResolvedApiConnection["protocol"];
  model: string;
  timeoutMs: number;
}

export interface VideoGenerationJob {
  id: string;
  remoteId?: string;
  taskId: string;
  toolCallId: string;
  producerMessageId?: string;
  lastToolCallId: string;
  connection: VideoConnectionSnapshot;
  /** Digest of the submitted parameters; prompts, reference images and credentials are not persisted. */
  requestDigest: string;
  state: "submitting" | "submission-unknown" | "queued" | "in_progress" | "completed" | "failed";
  /** Pausing this local wait never cancels the remote job. */
  waitState: "waiting" | "paused" | "finished";
  createdAt: number;
  updatedAt: number;
  /** A bounded category only, never the upstream message or response body. */
  lastError?: string;
}

export interface VideoGenerationJobStore {
  get(id: string): VideoGenerationJob | undefined;
  list(taskId?: string): VideoGenerationJob[];
  findByInvocation(taskId: string, toolCallId: string): VideoGenerationJob | undefined;
  put(job: VideoGenerationJob): void;
}

export class VideoJobPendingError extends Error {
  constructor(public readonly jobId: string, public readonly reason: string, public readonly remoteId?: string) {
    super(reason === "submission-unknown"
      ? `video submission-unknown: jobId=${jobId}; the request may have been accepted. It will not be submitted again automatically. Inspect the service before creating another job.`
      : `video ${reason}: jobId=${jobId}${remoteId ? `; remoteId=${remoteId}` : ""}; stopped waiting locally. Remote generation was not cancelled. Resume with video_generate(job_id="${jobId}").`);
    this.name = "VideoJobPendingError";
  }
}

const STATES = ["submitting", "submission-unknown", "queued", "in_progress", "completed", "failed"];
const WAIT_STATES = ["waiting", "paused", "finished"];

export function assertVideoJobId(id: string): void {
  if (!/^video-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(id)) {
    throw new ApiProviderError("input", "invalid video job ID");
  }
}

export function newVideoJobId(): string { return `video-${randomUUID()}`; }

export function videoConnectionSnapshot(connection: ResolvedApiConnection, model: string): VideoConnectionSnapshot {
  // Explicit allowlist: object spread here would persist Authorization headers.
  return { id: connection.id, label: connection.label, baseUrl: connection.baseUrl, protocol: connection.protocol, model, timeoutMs: connection.timeoutMs };
}

function cleanJob(value: VideoGenerationJob): VideoGenerationJob {
  if (!value || typeof value !== "object" || !value.connection) throw new ApiProviderError("storage", "invalid video job record");
  assertVideoJobId(value.id);
  if (!STATES.includes(value.state) || !WAIT_STATES.includes(value.waitState) || !/^[a-f0-9]{64}$/.test(value.requestDigest)
    || !Number.isSafeInteger(value.createdAt) || !Number.isSafeInteger(value.updatedAt)
    || value.createdAt < 0 || value.updatedAt < value.createdAt) throw new ApiProviderError("storage", "invalid video job record");
  if (value.remoteId !== undefined && !/^[a-zA-Z0-9_.-]{1,200}$/.test(value.remoteId)) throw new ApiProviderError("storage", "invalid remote video ID");
  if (["queued", "in_progress", "completed"].includes(value.state) && !value.remoteId) throw new ApiProviderError("storage", "video job is missing its remote ID");
  if (!["openai-compatible", "openrouter", "magpie"].includes(value.connection.protocol)) throw new ApiProviderError("storage", "invalid video connection protocol");
  if (!Number.isSafeInteger(value.connection.timeoutMs) || value.connection.timeoutMs < 1 || value.connection.timeoutMs > 30 * 60_000) throw new ApiProviderError("storage", "invalid video timeout");
  return {
    id: value.id, remoteId: value.remoteId,
    taskId: requiredText(value.taskId, "task ID", 300),
    toolCallId: requiredText(value.toolCallId, "tool call ID", 300),
    lastToolCallId: requiredText(value.lastToolCallId, "tool call ID", 300),
    producerMessageId: value.producerMessageId === undefined ? undefined : requiredText(value.producerMessageId, "message ID", 300),
    connection: {
      id: requiredText(value.connection.id, "service ID", 200), label: requiredText(value.connection.label, "service label", 200),
      baseUrl: normalizeApiBaseUrl(value.connection.baseUrl), protocol: value.connection.protocol,
      model: requiredText(value.connection.model, "model", 300), timeoutMs: value.connection.timeoutMs,
    },
    requestDigest: value.requestDigest, state: value.state, waitState: value.waitState,
    createdAt: value.createdAt, updatedAt: value.updatedAt,
    lastError: typeof value.lastError === "string" && /^[a-z-]{1,40}$/.test(value.lastError) ? value.lastError : undefined,
  };
}

/** Atomic, fsynced job ledger. The caller supplies the path; this module never opens a real profile by itself. */
export class VideoGenerationJobs implements VideoGenerationJobStore {
  constructor(public readonly path: string) {}

  private read(): VideoGenerationJob[] {
    if (!existsSync(this.path)) return [];
    try {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as { version?: unknown; jobs?: unknown };
      if (parsed.version !== 1 || !Array.isArray(parsed.jobs)) throw new Error();
      const jobs = parsed.jobs.map(job => cleanJob(job));
      if (new Set(jobs.map(job => job.id)).size !== jobs.length) throw new Error();
      if (new Set(jobs.map(job => JSON.stringify([job.taskId, job.toolCallId]))).size !== jobs.length) throw new Error();
      return jobs;
    } catch {
      // A broken ledger must fail closed: resetting it could submit the same paid job twice.
      throw new ApiProviderError("storage", "video job ledger could not be read; existing submissions will not be repeated");
    }
  }

  get(id: string): VideoGenerationJob | undefined { assertVideoJobId(id); return this.read().find(job => job.id === id); }
  list(taskId?: string): VideoGenerationJob[] { return this.read().filter(job => taskId === undefined || job.taskId === taskId); }
  findByInvocation(taskId: string, toolCallId: string): VideoGenerationJob | undefined {
    return this.read().find(job => job.taskId === taskId && job.toolCallId === toolCallId);
  }

  put(input: VideoGenerationJob): void {
    const job = cleanJob(input);
    const jobs = this.read();
    const index = jobs.findIndex(item => item.id === job.id);
    const previous = jobs[index];
    if (previous && (previous.taskId !== job.taskId || previous.toolCallId !== job.toolCallId || previous.requestDigest !== job.requestDigest
      || JSON.stringify(previous.connection) !== JSON.stringify(job.connection) || (previous.remoteId && previous.remoteId !== job.remoteId))) {
      throw new ApiProviderError("storage", "video job ownership and connection cannot be changed");
    }
    if (index < 0 && jobs.some(item => item.taskId === job.taskId && item.toolCallId === job.toolCallId)) {
      throw new ApiProviderError("storage", "a video submission already exists for this tool invocation");
    }
    if (previous && ["completed", "failed"].includes(previous.state) && job.state !== previous.state) {
      throw new ApiProviderError("storage", "a terminal video job cannot return to a pending state");
    }
    if (index < 0) jobs.push(job); else jobs[index] = job;
    const temporary = `${this.path}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
      fd = openSync(temporary, "wx", 0o600);
      writeFileSync(fd, `${JSON.stringify({ version: 1, jobs })}\n`, "utf8");
      fsyncSync(fd);
      closeSync(fd);
      fd = undefined;
      renameSync(temporary, this.path);
    } catch {
      throw new ApiProviderError("storage", "video job ledger could not be saved; do not resubmit the request");
    } finally {
      if (fd !== undefined) try { closeSync(fd); } catch { /* best effort */ }
      try { rmSync(temporary, { force: true }); } catch { /* best effort */ }
    }
  }
}
