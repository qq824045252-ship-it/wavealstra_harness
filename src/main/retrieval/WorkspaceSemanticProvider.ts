/**
 * R3.1 WorkspaceSemanticProvider — scoped semantic search (production)
 * 冻结契约：
 * - Scope：统一任务范围（整库/文件夹/单条引用）在 SQL 排名之前约束，禁止全库后 filter
 * - 仅定位：返回 SemanticCandidate {itemId,chunkId,chunkIndex,charOffset,score,preview}，不含全文
 * - 真模型：onnxruntime-node CPU via SemanticRuntime (lazy singleton), BGE-M3 INT8 sentence_embedding 1024d L2-normalized
 * - 无模型时：抛出 SemanticUnavailableError，绝不回退 hash（hash 仅在 tests 中通过专用 helper 使用）
 * - 检索：brute-force cosine on allowed chunks WHERE item.space_id IN (allowed) + model/version 过滤，非全库 Top1000 后 filter
 * - 读侧安全：过滤 model_id/version/dimension，且要求 embedding chunk_hash == library_chunks.hash（stale 自动忽略）
 */
import type { AppDatabase } from "../db/AppDatabase";
import { SemanticModelManager, SEMANTIC_DIMENSION, SEMANTIC_MODEL_ID, SEMANTIC_MODEL_VERSION } from "./SemanticModelManager";
import { getSemanticRuntime, SemanticUnavailableError } from "./SemanticRuntime";

export { SEMANTIC_MODEL_ID, SEMANTIC_MODEL_VERSION, SEMANTIC_DIMENSION };
export const SEMANTIC_THRESHOLD = 0.50; // cosine global: neg max 0.496 => 0.50 neg FP 0, semantic pos min 0.614 (semantic/long) safe; alias 0.408 filtered but abbreviation 3/3 via lexical
export { SemanticUnavailableError };

export interface SemanticCandidate {
  itemId: string;
  chunkId: string;
  chunkIndex: number;
  charOffset: number;
  score: number; // cosine 0..1 (relevance)
  preview: string;
}
export interface SemanticSearchInput {
  query: string;
  /** 整库 scope */
  allowedLibrarySpaceIds: string[];
  /** 已展开到子树的文件夹 id scope */
  allowedLibraryCollectionIds?: string[];
  /** 显式单条引用，不授予同一资料位置的其他条目 */
  allowedLibraryItemIds?: string[];
  limit: number;
  threshold?: number; // cosine; 0 = disabled (return all)
}

function cosine(a: Float32Array, b: Float32Array): number {
  let s = 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) s += a[i]! * b[i]!;
  return s;
}
function blobToF32(blob: Buffer | Uint8Array): Float32Array {
  if (blob instanceof Uint8Array && !(blob instanceof Buffer)) {
    return new Float32Array(blob.buffer, blob.byteOffset, Math.floor(blob.byteLength / 4));
  }
  const buf = blob as Buffer;
  return new Float32Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 4));
}
export function f32ToBlob(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

export class WorkspaceSemanticProvider {
  private readonly manager: SemanticModelManager;
  private readonly runtime: ReturnType<typeof getSemanticRuntime>;

  constructor(private readonly db: AppDatabase, opts?: { manager?: SemanticModelManager; runtime?: ReturnType<typeof getSemanticRuntime> }) {
    this.manager = opts?.manager ?? new SemanticModelManager();
    this.runtime = opts?.runtime ?? getSemanticRuntime(this.manager);
  }

  /** 仅定位，不含全文；调用方从统一任务范围提供三类明确的读取授权。 */
  async search(input: SemanticSearchInput): Promise<SemanticCandidate[]> {
    const q = input.query.trim();
    if (!q) return [];
    const allowed = [...new Set(input.allowedLibrarySpaceIds)].filter(Boolean);
    const allowedCollections = [...new Set(input.allowedLibraryCollectionIds ?? [])].filter(Boolean);
    const allowedItems = [...new Set(input.allowedLibraryItemIds ?? [])].filter(Boolean);
    if (allowed.length === 0 && allowedCollections.length === 0 && allowedItems.length === 0) return [];
    const limit = Math.max(1, Math.min(50, Math.round(input.limit ?? 10)));
    let qVec: Float32Array;
    try {
      qVec = await this.embed(q);
    } catch (e) {
      if (e instanceof SemanticUnavailableError) throw e;
      throw e;
    }
    const dbAny = this.db as any;
    const conn = dbAny.connection ?? dbAny.db ?? dbAny;
    if (!conn || typeof conn.prepare !== "function") return [];
    try {
      const hasEmb = conn.prepare(`SELECT 1 FROM sqlite_master WHERE type='table' AND name='library_chunk_embeddings'`).get() != null;
      if (!hasEmb) return [];
    } catch { return []; }

    let rows: Array<{
      chunk_id: string; item_id: string; chunk_index: number; char_offset: number;
      chunk_hash: string; embedding: Uint8Array | Buffer; content: string; space_id: string;
      dimension: number; cur_hash: string;
    }> = [];
    {
      const scopeClauses: string[] = [];
      const scopeParams: string[] = [];
      if (allowed.length > 0) {
        scopeClauses.push(`li.space_id IN (${allowed.map(() => "?").join(",")})`);
        scopeParams.push(...allowed);
      }
      if (allowedCollections.length > 0) {
        scopeClauses.push(`li.collection_id IN (${allowedCollections.map(() => "?").join(",")})`);
        scopeParams.push(...allowedCollections);
      }
      if (allowedItems.length > 0) {
        scopeClauses.push(`li.id IN (${allowedItems.map(() => "?").join(",")})`);
        scopeParams.push(...allowedItems);
      }
      try {
        rows = conn.prepare(
          `SELECT e.chunk_id, c.item_id AS item_id, c.chunk_index AS chunk_index, c.char_offset AS char_offset,
                  e.chunk_hash, e.embedding, e.dimension,
                  c.content AS content, c.hash AS cur_hash, li.space_id AS space_id
           FROM library_chunk_embeddings e
           JOIN library_chunks c ON c.id = e.chunk_id
           JOIN library_items li ON li.id = c.item_id
           WHERE (${scopeClauses.join(" OR ")})
             AND e.model_id = ? AND e.model_version = ?`
        ).all(...scopeParams, SEMANTIC_MODEL_ID, SEMANTIC_MODEL_VERSION) as any;
      } catch (e) {
        console.error("[SemanticProvider] SQL failed:", e instanceof Error ? e.message : String(e));
        throw e;
      }
    }
    if (rows.length === 0) return [];

    const scored: Array<{ r: (typeof rows)[number]; s: number }> = [];
    for (const r of rows) {
      try {
        if (r.dimension !== SEMANTIC_DIMENSION) continue;
        if (r.chunk_hash !== r.cur_hash) continue;
        const raw = r.embedding as any;
        const byteLen = raw?.byteLength ?? raw?.length ?? 0;
        if (byteLen !== 4 * SEMANTIC_DIMENSION) continue;
        const vec = blobToF32(raw);
        if (vec.length !== SEMANTIC_DIMENSION) continue;
        let finiteVec = true; for (let k = 0; k < vec.length; k++) if (!Number.isFinite(vec[k]!)) { finiteVec = false; break; } if (!finiteVec) continue;
        const s = cosine(qVec, vec);
        if (!Number.isFinite(s)) continue;
        scored.push({ r, s });
      } catch { continue; }
    }
    const threshold = input.threshold ?? SEMANTIC_THRESHOLD;
    const filtered = scored.filter((x) => x.s >= threshold);
    const toRank = filtered.length > 0 ? filtered : []; // allow 0 result for negatives
    toRank.sort((a, b) => b.s - a.s);
    const bestByItem = new Map<string, (typeof scored)[number]>();
    for (const it of toRank) {
      const prev = bestByItem.get(it.r.item_id);
      if (!prev || it.s > prev.s) bestByItem.set(it.r.item_id, it);
    }
    const best = [...bestByItem.values()].sort((a, b) => b.s - a.s).slice(0, limit);
    return best.map(({ r, s }) => ({
      itemId: r.item_id,
      chunkId: r.chunk_id,
      chunkIndex: r.chunk_index,
      charOffset: r.char_offset,
      score: s,
      preview: (r.content ?? "").slice(0, 160).replace(/\s+/g, " ").trim(),
    }));
  }

  async embed(text: string): Promise<Float32Array> {
    return this.runtime.embed(text);
  }

  f32ToBlob = f32ToBlob;
  getLoadMs(): number | null { return this.runtime.getLoadMs(); }
}

// Backwards-compat helpers for tests that previously imported hash export — kept thin, not used in production paths
export function blobToF32Export(b: Buffer | Uint8Array): Float32Array { return blobToF32(b); }
export function cosineExport(a: Float32Array, b: Float32Array): number { return cosine(a, b); }
// hashEmbeddingExport is intentionally NOT provided here; tests should import from ./hashEmbeddingForTests
