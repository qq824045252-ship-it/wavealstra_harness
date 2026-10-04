import type { AppDatabase } from "../db/AppDatabase";
import type { MemoryRecordDto } from "../../shared/memory-kernel";
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
}

/** Shared BGE-M3 runtime, separate Memory index truth. */
export class MemorySemanticProvider {
  private readonly runtime: ReturnType<typeof getSemanticRuntime>;

  constructor(private readonly db: AppDatabase) {
    const manager = new SemanticModelManager();
    this.runtime = getSemanticRuntime(manager);
  }

  async index(record: MemoryRecordDto): Promise<void> {
    if (record.status !== "active") return;
    const conn = this.db.connection;
    if (!conn.open) return;
    const existing = conn.prepare(
      `SELECT content_hash FROM memory_embeddings WHERE memory_id=? AND model_id=? AND model_version=?`,
    ).get(record.id, SEMANTIC_MODEL_ID, SEMANTIC_MODEL_VERSION) as { content_hash: string } | undefined;
    if (existing?.content_hash === record.contentHash) return;
    const vector = await this.runtime.embed(`${record.kind}: ${record.title}\n${record.content}`.trim());
    if (vector.length !== SEMANTIC_DIMENSION) throw new Error(`Memory embedding dimension mismatch: ${vector.length}`);
    if (!conn.open) return;
    const current = conn.prepare("SELECT content_hash,status FROM memory_records WHERE id=?").get(record.id) as
      { content_hash: string; status: string } | undefined;
    // Late vectors must not resurrect forgotten records or overwrite a newer revision.
    // This check and upsert are synchronous, so no JS mutation can interleave them.
    if (!current || current.status !== "active" || current.content_hash !== record.contentHash) return;
    conn.prepare(
      `INSERT INTO memory_embeddings (memory_id,model_id,model_version,content_hash,dimension,embedding,created_at)
       VALUES (?,?,?,?,?,?,?)
       ON CONFLICT(memory_id,model_id,model_version) DO UPDATE SET
         content_hash=excluded.content_hash, dimension=excluded.dimension, embedding=excluded.embedding, created_at=excluded.created_at`,
    ).run(record.id, SEMANTIC_MODEL_ID, SEMANTIC_MODEL_VERSION, record.contentHash, SEMANTIC_DIMENSION, f32ToBlob(vector), Date.now());
  }

  async search(query: string, allowedMemoryIds: string[], limit = 20, threshold = 0.50): Promise<MemorySemanticHit[]> {
    const q = query.trim();
    const allowed = [...new Set(allowedMemoryIds)].filter(Boolean);
    if (!q || allowed.length === 0) return [];
    const queryVec = await this.runtime.embed(q);
    const conn = this.db.connection;
    if (!conn.open) return [];
    const hits: MemorySemanticHit[] = [];
    const batchSize = 350;
    for (let offset = 0; offset < allowed.length; offset += batchSize) {
      const batch = allowed.slice(offset, offset + batchSize);
      const placeholders = batch.map(() => "?").join(",");
      const rows = conn.prepare(
        `SELECT e.memory_id,e.embedding,e.dimension,e.content_hash,m.content_hash AS current_hash
         FROM memory_embeddings e JOIN memory_records m ON m.id=e.memory_id
         WHERE e.memory_id IN (${placeholders}) AND e.model_id=? AND e.model_version=? AND m.status='active'`,
      ).all(...batch, SEMANTIC_MODEL_ID, SEMANTIC_MODEL_VERSION) as Array<{
        memory_id: string; embedding: Buffer; dimension: number; content_hash: string; current_hash: string;
      }>;
      for (const row of rows) {
        if (row.dimension !== SEMANTIC_DIMENSION || row.content_hash !== row.current_hash) continue;
        if (row.embedding.byteLength !== SEMANTIC_DIMENSION * 4) continue;
        const score = cosine(queryVec, blobToF32(row.embedding));
        if (Number.isFinite(score) && score >= threshold) hits.push({ memoryId: row.memory_id, score });
      }
    }
    return hits.sort((a, b) => b.score - a.score).slice(0, Math.max(1, Math.min(50, limit)));
  }
}
