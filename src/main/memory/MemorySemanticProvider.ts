import { isDotsSearch, searchEpoch } from "./MemorySearchEpoch";
import { searchDotsVectors } from "./DotsVectorSearch";
import type { AppDatabase } from "../db/AppDatabase";
import type { MemoryIndexResult, MemoryRecordDto } from "../../shared/memory-kernel";
import { memorySearchWhere, type MemorySearchScope } from "./MemorySearchScope";
import { setImmediate as yieldThread } from "node:timers/promises";
import { randomUUID } from "node:crypto";
import pLimit from "p-limit";
import {
  SEMANTIC_DIMENSION,
  SEMANTIC_MODEL_ID,
  SEMANTIC_MODEL_VERSION,
  SemanticModelManager,
} from "../retrieval/SemanticModelManager";
import { getSemanticRuntime, SemanticUnavailableError } from "../retrieval/SemanticRuntime";

export { SemanticUnavailableError };

function f32ToBlob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}
function blobToF32(blob: Buffer | Uint8Array): Float32Array {
  const raw = blob as Buffer;
  return new Float32Array(raw.buffer, raw.byteOffset, Math.floor(raw.byteLength / 4));
}
function cosine(a: Float32Array, b: Float32Array): number {
  let score = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) score += a[i]! * b[i]!;
  return score;
}

export interface MemorySemanticHit {
  memoryId: string;
  score: number;
  contentHash: string;
}

type IndexableMemory = Pick<MemoryRecordDto, "id" | "status" | "contentHash" | "kind" | "title" | "content">;
type IndexOutcome = "indexed" | "current" | "skipped";
const INDEX_MODEL = { modelId: SEMANTIC_MODEL_ID, modelVersion: SEMANTIC_MODEL_VERSION, dimension: SEMANTIC_DIMENSION };
const MEMORY_INDEX_PAGE_SIZE = 64;
const limitMemoryIndex = pLimit(4);
const pendingByDatabase = new WeakMap<AppDatabase, Map<string, Promise<IndexOutcome>>>();

function indexIssue(error: unknown): NonNullable<MemoryIndexResult["issue"]> {
  return error instanceof SemanticUnavailableError
    ? { kind: error.kind, detail: error.message, modelDirectory: error.modelDirectory }
    : { kind: "runtime", detail: error instanceof Error ? error.message : String(error) };
}

/** Shared BGE-M3 runtime, separate Memory index truth. */
export class MemorySemanticProvider {
  private readonly runtime: ReturnType<typeof getSemanticRuntime>;

  constructor(private readonly db: AppDatabase) {
    const manager = new SemanticModelManager();
    this.runtime = getSemanticRuntime(manager, db.runtimeAuditReader);
  }

  async index(record: IndexableMemory): Promise<IndexOutcome> {
    if (record.status !== "active" || !this.db.isOpen) return "skipped";
    return this.scheduleIndex(record.id, record.contentHash, () => this.indexCurrent(record));
  }

  private async indexCurrent(record: IndexableMemory): Promise<IndexOutcome> {
    if (this.db.runtimeAuditReader?.supervised) return this.indexSupervised(record.id, record.contentHash);
    const conn = this.db.fixtureConnection;
    if (!conn) throw new SemanticUnavailableError("Core 未确认记忆语义索引");
    if (!conn.open) return "skipped";
    const existing = conn.prepare(
      `SELECT 1 FROM memory_embeddings WHERE memory_id=? AND model_id=? AND model_version=?
       AND content_hash=? AND dimension=? AND length(embedding)=?`,
    ).get(record.id, SEMANTIC_MODEL_ID, SEMANTIC_MODEL_VERSION, record.contentHash, SEMANTIC_DIMENSION, SEMANTIC_DIMENSION * 4);
    if (existing) return "current";
    return await this.indexNative(record.id, record.contentHash) ?? this.indexOnHost(record);
  }

  private scheduleIndex(id: string, hash: string, index: () => Promise<IndexOutcome>): Promise<IndexOutcome> {
    let pending = pendingByDatabase.get(this.db);
    if (!pending) {
      pending = new Map();
      pendingByDatabase.set(this.db, pending);
    }
    const key = JSON.stringify([id, hash]);
    const existing = pending.get(key);
    if (existing) return existing;
    const operation = limitMemoryIndex(index).finally(() => pending.delete(key));
    pending.set(key, operation);
    return operation;
  }

  private async indexSupervised(id: string, hash: string): Promise<IndexOutcome> {
    if (!this.db.isOpen) return "skipped";
    const outcome = await this.indexNative(id, hash);
    if (!outcome) throw new SemanticUnavailableError("Core 未确认记忆语义索引");
    return outcome;
  }

  private async indexNative(id: string, hash: string): Promise<IndexOutcome | undefined> {
    const reader = this.db.runtimeAuditReader;
    if (!reader || this.db.inTransaction || !this.db.isOpen) return;
    const staged = await this.runtime.stageIndex({ kind: "memory", id, hash });
    if (staged?.status === "current" || staged?.status === "skipped") return staged.status;
    if (staged?.status === "staged") {
      const published = await reader.publishEmbeddings([staged.token]);
      if (published) return published.indexed ? "indexed" : published.current ? "current" : "skipped";
      await reader.discardEmbeddings([staged.token]);
    }
  }

  private async indexOnHost(record: IndexableMemory): Promise<IndexOutcome> {
    const conn = this.db.connection;
    if (!conn.open) return "skipped";
    const vector = await this.runtime.embed(`${record.kind}: ${record.title}\n${record.content}`.trim());
    if (vector.length !== SEMANTIC_DIMENSION) throw new Error(`Memory embedding dimension mismatch: ${vector.length}`);
    if (!conn.open) return "skipped";
    const current = conn.prepare("SELECT content_hash,status FROM memory_records WHERE id=?").get(record.id) as
      { content_hash: string; status: string } | undefined;
    // Late vectors must not resurrect forgotten records or overwrite a newer revision.
    // This check and upsert are synchronous, so no JS mutation can interleave them.
    if (!current || current.status !== "active" || current.content_hash !== record.contentHash) return "skipped";
    if (conn.readonly || this.db.runtimeAuditReader?.supervised) {
      const reader = this.db.runtimeAuditReader;
      if (!reader) throw new Error("写入记忆语义索引：Rust 写入核心未就绪");
      const reply = await reader.batch3Write<{ outcome?: IndexOutcome }>({
        kind: "memoryUpsertEmbedding",
        memoryId: record.id,
        modelId: SEMANTIC_MODEL_ID,
        modelVersion: SEMANTIC_MODEL_VERSION,
        contentHash: record.contentHash,
        dimension: SEMANTIC_DIMENSION,
        embeddingBase64: f32ToBlob(vector).toString("base64"),
        createdAt: Date.now(),
      });
      if (reply === undefined) throw new Error("写入记忆语义索引未收到确认");
      return reply.outcome ?? "indexed";
    }
    const saved = conn.prepare(
      `INSERT INTO memory_embeddings (memory_id,model_id,model_version,content_hash,dimension,embedding,created_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(memory_id,model_id,model_version) DO UPDATE SET
         content_hash=excluded.content_hash, dimension=excluded.dimension, embedding=excluded.embedding, created_at=excluded.created_at
       WHERE content_hash<>excluded.content_hash OR dimension<>excluded.dimension OR length(embedding)<>length(excluded.embedding)`,
    ).run(record.id, SEMANTIC_MODEL_ID, SEMANTIC_MODEL_VERSION, record.contentHash, SEMANTIC_DIMENSION, f32ToBlob(vector), Date.now());
    return saved.changes ? "indexed" : "current";
  }

  async backfill(limit?: number): Promise<MemoryIndexResult> {
    const result = await this.backfillNative(limit);
    if (result) return result;
    if (!this.db.fixtureConnection || this.db.runtimeAuditReader?.supervised) {
      throw new SemanticUnavailableError("Core 未确认记忆索引队列");
    }
    return this.backfillOnHost(limit);
  }

  private async backfillNative(limit?: number): Promise<MemoryIndexResult | undefined> {
    const reader = this.db.runtimeAuditReader;
    if (!reader || this.db.inTransaction || !this.db.isOpen) return;
    const queueId = randomUUID();
    const boundedLimit = limit === undefined || limit === Infinity ? undefined
      : Number.isNaN(limit) ? 0 : Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(Math.max(1, limit)));
    const stats = await reader.embeddingIndex({ kind: "openMemoryQueue", queueId, model: INDEX_MODEL, limit: boundedLimit });
    if (!stats) return;
    const result: MemoryIndexResult = {
      indexed: 0, current: stats.completed, skipped: 0, failed: 0, pending: stats.total - stats.completed,
    };
    const queued = Math.min(result.pending, boundedLimit ?? result.pending);
    if (!queued) return result;
    try {
      await this.runtime.ensureSession();
      let remaining = queued;
      while (remaining > 0) {
        const page = await reader.embeddingIndex({ kind: "memoryPage", queueId, limit: Math.min(MEMORY_INDEX_PAGE_SIZE, remaining) });
        if (!page?.length) throw new Error("本次记忆索引队列已中断，可继续补齐其余记录");
        await this.indexPage(result, page, async ({ id, hash }) => {
          if (!hash || !this.db.isOpen) return "skipped";
          return this.scheduleIndex(id, hash, async () => {
            if (reader.supervised) return this.indexSupervised(id, hash);
            const outcome = await this.indexNative(id, hash);
            if (outcome) return outcome;
            const record = this.readIndexableMemory(id);
            return record ? this.indexOnHost(record) : "skipped";
          });
        });
        remaining -= page.length;
      }
    } catch (error) {
      result.issue = indexIssue(error);
    } finally {
      await reader.embeddingIndex({ kind: "closeMemoryQueue", queueId });
    }
    return result;
  }

  private readIndexableMemory(id: string): IndexableMemory | undefined {
    if (!this.db.connection.open) return;
    return this.db.connection.prepare(`SELECT id,status,kind,title,content,content_hash AS contentHash
      FROM memory_records WHERE id=? AND status='active'`).get(id) as IndexableMemory | undefined;
  }

  private async indexPending(result: MemoryIndexResult, index: () => Promise<IndexOutcome>): Promise<void> {
    try {
      result[await index()]++;
    } catch (error) {
      if (error instanceof SemanticUnavailableError) throw error;
      result.failed++;
      result.issue ??= { kind: "index", detail: error instanceof Error ? error.message : String(error) };
    }
    result.pending--;
  }

  private async indexPage<T>(result: MemoryIndexResult, rows: readonly T[], index: (row: T) => Promise<IndexOutcome>): Promise<void> {
    const outcomes = await Promise.allSettled(rows.map(row => this.indexPending(result, () => index(row))));
    const failed = outcomes.find(outcome => outcome.status === "rejected");
    if (failed) throw failed.reason;
  }

  private async backfillOnHost(limit?: number): Promise<MemoryIndexResult> {
    const conn = this.db.connection;
    const rows = conn.prepare(`SELECT m.id, e.memory_id IS NOT NULL AS ready FROM memory_records m
      LEFT JOIN memory_embeddings e ON e.memory_id=m.id AND e.model_id=? AND e.model_version=?
        AND e.content_hash=m.content_hash AND e.dimension=? AND length(e.embedding)=?
      WHERE m.status='active' ORDER BY m.updated_at DESC, m.id`)
      .all(SEMANTIC_MODEL_ID, SEMANTIC_MODEL_VERSION, SEMANTIC_DIMENSION, SEMANTIC_DIMENSION * 4) as Array<{ id: string; ready: number }>;
    const missing = rows.filter(row => !row.ready);
    const result: MemoryIndexResult = { indexed: 0, current: rows.length - missing.length, skipped: 0, failed: 0, pending: missing.length };
    if (!missing.length) return result;
    try {
      await this.runtime.ensureSession();
      const selected = missing.slice(0, limit === undefined ? missing.length : Math.max(1, limit));
      for (let offset = 0; offset < selected.length; offset += MEMORY_INDEX_PAGE_SIZE) {
        await this.indexPage(result, selected.slice(offset, offset + MEMORY_INDEX_PAGE_SIZE), async row => {
          const record = this.readIndexableMemory(row.id);
          return record ? this.index(record) : "skipped";
        });
      }
    } catch (error) {
      result.issue = indexIssue(error);
    }
    return result;
  }

  async search(query: string, scope: MemorySearchScope, accept: (id: string, contentHash: string) => boolean,
    limit = 20, threshold = 0.50): Promise<MemorySemanticHit[]> {
    const q = query.trim();
    if (!q || !scope.scopes.length) return [];
    const queryVec = await this.runtime.embed(q);
    const conn = this.db.connection;
    if (!conn.open) return [];
    const hits: MemorySemanticHit[] = [];
    const keep = Math.max(1, Math.min(100, limit));
    const reader = this.db.runtimeAuditReader;
    if (reader && !conn.inTransaction && Number.isFinite(keep)) {
      const textEpoch = searchEpoch(conn, "text_version");
      const vectorEpoch = searchEpoch(conn, "vector_version");
      const native = await reader.semantic({
        target: "memory", scope: memorySearchWhere(scope), modelId: SEMANTIC_MODEL_ID,
        modelVersion: SEMANTIC_MODEL_VERSION, dimension: SEMANTIC_DIMENSION, query: queryVec, threshold,
      });
      if (!conn.open) return [];
      if (native && textEpoch === searchEpoch(conn, "text_version") && vectorEpoch === searchEpoch(conn, "vector_version")) {
        const current = memorySearchWhere(scope);
        const exists = conn.prepare("SELECT 1 FROM memory_records m WHERE m.id=? AND m.content_hash=? AND " + current.sql);
        native.sort((a, b) => b.score - a.score || a.id.localeCompare(b.id));
        for (const hit of native) {
          if (!exists.get(hit.id, hit.hash, ...current.args) || !accept(hit.id, hit.hash)) continue;
          hits.push({ memoryId: hit.id, score: hit.score, contentHash: hit.hash });
          if (hits.length >= Math.floor(keep)) break;
        }
        return hits;
      }
    }
    if (isDotsSearch(scope)) {
      const indexed = await searchDotsVectors(conn,queryVec,scope,accept,keep,threshold);
      if (indexed) return indexed;
      if (!conn.open) return [];
    }
    const where = memorySearchWhere(scope);
    // Read each page completely before yielding, so writes and task cancellation
    // can run between pages without an active SQLite statement or transaction.
    const read = conn.prepare(
      `SELECT e.memory_id,e.embedding,e.dimension,e.content_hash,m.content_hash AS current_hash
       FROM memory_embeddings e CROSS JOIN memory_records m ON m.id=e.memory_id
       WHERE e.model_id=? AND e.model_version=? AND ${where.sql} AND e.memory_id>?
       ORDER BY e.memory_id LIMIT 128`,
    );
    let cursor = "", started = performance.now();
    while (conn.open) {
      const rows = read.all(SEMANTIC_MODEL_ID, SEMANTIC_MODEL_VERSION, ...where.args, cursor) as Array<{
        memory_id: string; embedding: Buffer; dimension: number; content_hash: string; current_hash: string;
      }>;
      if (!rows.length) break;
      cursor = rows[rows.length - 1].memory_id;
      for (const row of rows) {
        if (row.dimension !== SEMANTIC_DIMENSION || row.content_hash !== row.current_hash) continue;
        if (row.embedding.byteLength !== SEMANTIC_DIMENSION * 4) continue;
        const score = cosine(queryVec, blobToF32(row.embedding));
        const worst = hits.at(-1);
        const canImprove = hits.length < keep || !worst || score > worst.score
          || score === worst.score && row.memory_id.localeCompare(worst.memoryId) < 0;
        if (Number.isFinite(score) && score >= threshold && canImprove && accept(row.memory_id, row.content_hash)) {
          hits.push({ memoryId: row.memory_id, score, contentHash: row.content_hash });
          hits.sort((a, b) => b.score - a.score || a.memoryId.localeCompare(b.memoryId));
          if (hits.length > keep) hits.pop();
        }
      }
      if (performance.now() - started >= 4) {
        await yieldThread();
        if (!conn.open) return [];
        started = performance.now();
      }
    }
    const current = memorySearchWhere(scope);
    const exists = conn.prepare(`SELECT 1 FROM memory_records m WHERE m.id=? AND m.content_hash=? AND ${current.sql}`);
    return hits.filter(hit => exists.get(hit.memoryId, hit.contentHash, ...current.args) && accept(hit.memoryId, hit.contentHash));
  }
}
