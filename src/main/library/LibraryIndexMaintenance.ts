import { existsSync, readFileSync, statSync } from "node:fs";
import type { AppDatabase } from "../db/AppDatabase";
import type { LibraryItemDto, LibraryItemKind } from "../../shared/library-ipc";
import type { LibraryRepository } from "./LibraryRepository";
import { hybridLibrarySpaceIds } from "./MaterialRetrievalSettings";
import { chunkText, chunkTextParts } from "./library-chunker";
import { readUtf8Prefix } from "./library-file-io";
import { LARGE_LIBRARY_TEXT_BYTES, readLibraryTextParts } from "./library-text-parts";
import { getSemanticRuntime } from "../retrieval/SemanticRuntime";
import {
  ContentExtractorRegistry,
  EXTRACT_MAX_OUTPUT_CHARS,
  libraryIndexExtractionBudget,
  type ExtractionResult,
} from "./ContentExtractorRegistry";
import {
  SEMANTIC_DIMENSION,
  SEMANTIC_MODEL_ID,
  SEMANTIC_MODEL_VERSION,
} from "../retrieval/SemanticModelManager";

const TEXT_FTS_COVERAGE_VERSION = 4;

const SEMANTIC_INDEX_JOIN = `
  LEFT JOIN library_chunk_embeddings e ON e.chunk_id = c.id AND e.chunk_hash = c.hash
    AND e.model_id = ? AND e.model_version = ? AND e.dimension = ? AND length(e.embedding) = ?
`;
const SEMANTIC_INDEX_PARAMS = [SEMANTIC_MODEL_ID, SEMANTIC_MODEL_VERSION, SEMANTIC_DIMENSION, SEMANTIC_DIMENSION * 4] as const;

interface LibraryIndexFiles {
  absolutePath(item: LibraryItemDto): string;
  assertManagedFile(path: string): void;
  isManagedFileSafe(path: string): boolean;
}

/** Maintains derived Library FTS, chunks and embeddings. Managed file ownership stays with LibraryService. */
export class LibraryIndexMaintenance {
  private readonly extractors: ContentExtractorRegistry = new ContentExtractorRegistry();
  /** 抽取缓存（itemId → 内容；按 size+mtime 失效；容量上限 8 条，防会话内重复解析） */
  private readonly extractCache = new Map<string, { key: string; result: ExtractionResult }>();
  /** 进行中的异步抽取（写入后 fire-and-forget；测试/关闭前可 flush） */
  private readonly pendingIndexes = new Set<Promise<void>>();
  /** per-item in-flight 去重：同一条目并发 search/read 只解析一次 */
  private readonly inflightExtract = new Map<string, Promise<ExtractionResult>>();
  /** 仅保存需要文件级 targeted fallback 的文本条目；健康 FTS 搜索不做额外 DB 反查。 */
  private readonly textFtsFallbackIds = new Set<string>();

  constructor(
    private readonly db: AppDatabase,
    private readonly repo: LibraryRepository,
    private readonly files: LibraryIndexFiles,
  ) {
    this.refreshTextFtsFallbackState();
  }

  get pendingTextFtsIds(): ReadonlySet<string> { return this.textFtsFallbackIds; }

  forgetItem(id: string): void {
    this.extractCache.delete(id);
    this.textFtsFallbackIds.delete(id);
  }

  private refreshTextFtsFallbackState(): void {
    this.textFtsFallbackIds.clear();
    if (!this.repo.ftsAvailable()) return;
    for (const id of this.repo.listTextFtsMissingCandidates()) this.textFtsFallbackIds.add(id);
    if (Number(this.repo.getIndexState("text-fts-coverage-version") ?? 0) < TEXT_FTS_COVERAGE_VERSION) {
      for (const id of this.repo.listTextFtsCoverageUpgradeCandidates()) this.textFtsFallbackIds.add(id);
    }
  }

  refreshFts(item: LibraryItemDto): void {
    this.extractCache.delete(item.id);
    if (this.repo.isTextSearchable(item.kind)) {
      const abs = this.files.absolutePath(item);
      if (item.sizeBytes > LARGE_LIBRARY_TEXT_BYTES) {
        this.indexLargeText(item, abs);
        return;
      }
      let body = "";
      try {
        if (existsSync(abs)) {
          this.files.assertManagedFile(abs);
          const st = statSync(abs);
          if (st.isFile()) {
            body = readFileSync(abs, "utf8");
          }
        }
      } catch {
        body = "";
      }
      this.repo.upsertFts(item.id, item.title, item.filename, body);
      this.textFtsFallbackIds.delete(item.id);
      // R2：同步 chunk 化（文本类直接基于 body）
      this.refreshChunksForItem(item.id, body);
      return;
    }
    if (this.isExtractableKind(item.kind)) {
      // 先清旧 FTS + chunks（绝不返回陈旧索引），置 pending，异步抽取后重建
      this.repo.deleteFts(item.id);
      this.repo.deleteChunks(item.id);
      this.repo.updateExtractStatus(item.id, "pending");
      const pending = this.indexExtractedText(item.id).catch((err) => {
        console.warn(`[Library] 文档抽取索引失败 ${item.id}：`, err);
      });
      this.pendingIndexes.add(pending);
      void pending.finally(() => this.pendingIndexes.delete(pending));
      return;
    }
    this.repo.deleteFts(item.id);
    this.repo.deleteChunks(item.id);
    this.repo.updateExtractStatus(item.id, "unsupported");
  }

  private indexLargeText(item: LibraryItemDto, path: string): void {
    this.files.assertManagedFile(path);
    this.repo.replaceLargeTextIndex(item, chunkTextParts(item.id, readLibraryTextParts(path)));
    this.textFtsFallbackIds.delete(item.id);
    this.scheduleSemanticIndex();
  }

  /** R2+R3：基于文本 body 刷新 chunks，同步失效 stale embeddings */
  private refreshChunksForItem(itemId: string, text: string | null): void {
    let oldChunkIds = new Set<string>();
    let oldHashes = new Map<string, string>();
    try {
      const prev = this.repo.listChunks(itemId);
      for (const c of prev) { oldChunkIds.add(c.id); oldHashes.set(c.id, c.hash); }
    } catch (err) {
      // Non-fatal: without the previous chunk snapshot we can only do a full stale sweep.
      console.warn(`[Library] 读取旧 chunk 快照失败 ${itemId}（退化为全量 stale 清扫）：`, err);
    }
    try {
      if (!text || text.trim().length === 0) {
        try { this.deleteStaleEmbeddingsForItem(itemId); } catch (err) {
          console.warn(`[Library] embedding 失效失败（空正文）${itemId}：`, err);
        }
        this.repo.deleteChunks(itemId);
        return;
      }
      const chunks = chunkText(itemId, text);
      const newIds = new Set(chunks.map((c) => c.id));
      try { this.deleteStaleEmbeddingsForItem(itemId); } catch (err) {
        console.warn(`[Library] embedding 失效失败 ${itemId}：`, err);
      }
      // Removed chunks are handled by the stale sweep above (their embeddings no longer join to library_chunks).
      try {
        const removedIds = [...oldChunkIds].filter((id) => !newIds.has(id));
        if (removedIds.length > 0) this.deleteEmbeddingsForChunkIds(removedIds);
      } catch (err) {
        console.warn(`[Library] 移除 chunk 的 embedding 清理失败 ${itemId}：`, err);
      }
      this.repo.upsertChunks(itemId, chunks as any);
      this.scheduleSemanticIndex();
    } catch (err) {
      console.warn(`[Library] chunk 写入失败 ${itemId}：`, err);
    }
  }

  /** Unified lifecycle API — explicit, no scattered copies */
  private deleteEmbeddingsForItem(itemId: string): void {
    try { (this.db as any).deleteChunkEmbeddings?.(itemId); } catch (err) {
      console.warn(`[Library] deleteChunkEmbeddings 失败 ${itemId}：`, err);
    }
    try {
      const conn = ((this.db as any).connection ?? (this.db as any).db ?? (this.db as any));
      conn.prepare(`DELETE FROM library_chunk_embeddings WHERE chunk_id IN (SELECT id FROM library_chunks WHERE item_id=?)`).run(itemId);
    } catch (err) {
      console.warn(`[Library] 删除条目 embedding 失败 ${itemId}：`, err);
    }
  }
  private deleteEmbeddingsForChunkIds(chunkIds: string[]): void {
    if (chunkIds.length === 0) return;
    const conn = ((this.db as any).connection ?? (this.db as any).db ?? (this.db as any));
    const ph = chunkIds.map(() => "?").join(",");
    conn.prepare(`DELETE FROM library_chunk_embeddings WHERE chunk_id IN (${ph})`).run(...chunkIds);
  }
  /**
   * Delete every embedding for `itemId` whose `chunk_hash` no longer matches its chunk's current hash.
   *
   * NOTE: this is a DB-level sweep, not a per-chunk diff. It intentionally takes no chunk-id inputs —
   * an earlier signature accepted (newIds, oldIds, oldHashes) but ignored all three, which made the
   * caller look like it was doing a precise incremental invalidation when it was not. Keep it honest:
   * call it BEFORE upsertChunks to drop embeddings for still-joined chunks whose text changed.
   */
  private deleteStaleEmbeddingsForItem(itemId: string): void {
    const conn = ((this.db as any).connection ?? (this.db as any).db ?? (this.db as any));
    conn.prepare(`DELETE FROM library_chunk_embeddings WHERE chunk_id IN (SELECT id FROM library_chunks WHERE item_id = ?) AND chunk_hash != (SELECT hash FROM library_chunks WHERE library_chunks.id = library_chunk_embeddings.chunk_id)`).run(itemId);
  }

  /** 文本 body 读取（复用 refreshFts/refreshChunksForItem 的读取路径）：文本类→文件；office/pdf→抽取正文 */
  private async resolveBackfillText(item: LibraryItemDto): Promise<string | null> {
    if (this.repo.isTextSearchable(item.kind)) {
      const abs = this.files.absolutePath(item);
      try {
        if (existsSync(abs)) {
          this.files.assertManagedFile(abs);
          const st = statSync(abs);
          if (st.isFile()) {
            return readFileSync(abs, "utf8");
          }
        }
      } catch {}
      return null;
    }
    if (this.isExtractableKind(item.kind)) {
      const abs = this.files.absolutePath(item);
      if (!abs || !this.files.isManagedFileSafe(abs)) return null;
      try {
        const result = await this.getIndexExtractedText(item);
        return result.status === "extracted" && result.text ? result.text : null;
      } catch {
        return null;
      }
    }
    return null;
  }


  /**
   * FTS text recovery：分批补齐旧版限长索引和缺失的派生行，完成后记录覆盖版本。
   */
  async recoverTextFtsCoverageV2(opts?: { batchSize?: number; signal?: AbortSignal }): Promise<{ processed: number; failed: number }> {
    if (!this.repo.ftsAvailable()) return { processed: 0, failed: 0 };
    const stateKey = "text-fts-coverage-version";
    const needsCoverageUpgrade = Number(this.repo.getIndexState(stateKey) ?? 0) < TEXT_FTS_COVERAGE_VERSION;
    this.refreshTextFtsFallbackState();
    const ids = [...this.textFtsFallbackIds];
    const batchSize = Math.max(1, Math.min(100, Math.floor(opts?.batchSize ?? 20)));
    let processed = 0;
    let failed = 0;
    for (let offset = 0; offset < ids.length; offset += batchSize) {
      if (opts?.signal?.aborted) return { processed, failed };
      for (const id of ids.slice(offset, offset + batchSize)) {
        try {
          const item = this.repo.getItem(id);
          if (item) this.refreshFts(item);
          processed += 1;
        } catch (error) {
          failed += 1;
          console.warn(`[Library] FTS text recovery failed ${id}:`, error);
        }
      }
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0));
    }
    if (!opts?.signal?.aborted && failed === 0 && needsCoverageUpgrade) this.repo.setIndexState(stateKey, String(TEXT_FTS_COVERAGE_VERSION));
    if (!opts?.signal?.aborted) this.refreshTextFtsFallbackState();
    return { processed, failed };
  }
  /**
   * R2 P2：旧数据 chunk backfill（幂等、可中断恢复、失败隔离、不阻塞启动）。
   * - 幂等：候选 = 无 chunk 的 item（listChunkBackfillCandidates）；已有 chunk 的跳过
   * - 可中断恢复：状态推导（无 pending 表），中断后下次启动剩余候选仍被查询到
   * - 失败隔离：逐 item try/catch，单项失败记录并跳过，继续下一项
   * - 不阻塞启动：调用方 fire-and-forget；内部按 batch 分批 + 每批让出事件循环
   * - 不污染 library_fts：只写 library_chunks / library_chunks_fts
   * - 不自动注入 Prompt：仅维护索引，Search 仍只返回 lightweight hit
   */
  async backfillMissingChunks(opts?: { batchSize?: number; signal?: AbortSignal; onProgress?: (done: number, totalHint: number) => void }): Promise<{ processed: number; succeeded: number; failed: number; skipped: number }> {
    const batchSize = Math.max(1, Math.min(100, Math.round(opts?.batchSize ?? 20)));
    const signal = opts?.signal;
    let processed = 0, succeeded = 0, failed = 0, skipped = 0;
    // 空笔记、附件和失败项可能仍没有 chunk。本次运行只处理每个候选一次。
    let totalHint = 0;
    let afterRowId = 0;
    try {
      totalHint = this.repo.listChunkBackfillCandidates(100000).length;
    } catch { totalHint = 0; }
    while (!signal?.aborted) {
      let batch: ReturnType<LibraryRepository["listChunkBackfillCandidates"]>;
      try {
        batch = this.repo.listChunkBackfillCandidates(batchSize, afterRowId);
      } catch (err) {
        console.warn("[Library] chunk backfill 查询失败：", err);
        break;
      }
      if (batch.length === 0) break;
      for (const { id: itemId, rowId } of batch) {
        if (signal?.aborted) break;
        afterRowId = rowId;
        processed++;
        try {
          if (this.repo.hasChunks(itemId)) { skipped++; continue; }
          const item = this.repo.getItem(itemId);
          if (!item) { skipped++; continue; }
          // URL/file/image 等无可索引正文的类型不产生 chunk
          if (!this.repo.isTextSearchable(item.kind) && !this.isExtractableKind(item.kind)) { skipped++; continue; }
          if (this.repo.isTextSearchable(item.kind) && item.sizeBytes > LARGE_LIBRARY_TEXT_BYTES) {
            this.indexLargeText(item, this.files.absolutePath(item));
            succeeded++;
            continue;
          }
          const text = await this.resolveBackfillText(item);
          const current = this.repo.getItem(itemId);
          if (!current || current.contentHash !== item.contentHash || current.updatedAt !== item.updatedAt) { skipped++; continue; }
          if (!text || text.trim().length === 0) { this.repo.deleteChunks(itemId); skipped++; continue; }
          // 幂等双检：并发写入刚好补上的情况
          if (this.repo.hasChunks(itemId)) { skipped++; continue; }
          const chunks = chunkText(itemId, text);
          this.repo.upsertChunks(itemId, chunks as any);
          this.scheduleSemanticIndex();
          succeeded++;
        } catch (err) {
          failed++;
          console.warn(`[Library] chunk backfill 单项失败 ${itemId}，已跳过：`, err);
        }
      }
      opts?.onProgress?.(processed, totalHint);
      // 每批让出事件循环，避免老用户几千份文档卡主线程
      await new Promise<void>((r) => setTimeout(r, 0));
    }
    return { processed, succeeded, failed, skipped };
  }

  private semanticBackfillRunning = false;
  private semanticIndexController?: AbortController;
  private semanticIndexFlight?: Promise<void>;
  private semanticIndexRequested = false;
  private semanticIndexFailures = 0;

  startSemanticIndexing(): void {
    this.semanticIndexController ??= new AbortController();
    this.scheduleSemanticIndex();
  }

  scheduleSemanticIndex(): void {
    const controller = this.semanticIndexController;
    if (!controller || controller.signal.aborted) return;
    this.semanticIndexRequested = true;
    if (this.semanticIndexFlight) return;
    this.semanticIndexFlight = Promise.resolve().then(async () => {
      while (this.semanticIndexRequested && !controller.signal.aborted) {
        this.semanticIndexRequested = false;
        try {
          await this.backfillEmbeddings({ signal: controller.signal });
        } catch (err) {
          console.warn("[Library] 语义索引失败：", err);
        }
      }
    }).finally(() => {
      this.semanticIndexFlight = undefined;
      if (this.semanticIndexRequested) this.scheduleSemanticIndex();
    });
  }

  async stopSemanticIndexing(): Promise<void> {
    this.semanticIndexController?.abort();
    this.semanticIndexRequested = false;
    await this.semanticIndexFlight;
    this.semanticIndexController = undefined;
  }

  get semanticIndexStats(): { running: boolean; pending: number; failed: number; processed: number; total: number; completed: number } {
    const row = this.db.connection.prepare(`
      SELECT COUNT(*) AS total, COUNT(e.chunk_id) AS completed
      FROM library_chunks c JOIN library_items i ON i.id = c.item_id
      ${SEMANTIC_INDEX_JOIN}
      WHERE i.trashed_at IS NULL AND i.space_id IN (SELECT value FROM json_each(?))
    `).get(...SEMANTIC_INDEX_PARAMS, JSON.stringify(hybridLibrarySpaceIds(this.db))) as { total: number; completed: number };
    return {
      ...row,
      running: this.semanticBackfillRunning,
      pending: row.total - row.completed,
      failed: this.semanticIndexFailures,
      processed: row.completed,
    };
  }

  async backfillEmbeddings(opts?: { batchSize?: number; signal?: AbortSignal; onProgress?: (done: number, totalHint: number) => void }): Promise<{ processed: number; succeeded: number; failed: number; skipped: number }> {
    const result = { processed: 0, succeeded: 0, failed: 0, skipped: 0 };
    if (this.semanticBackfillRunning || opts?.signal?.aborted) return result;
    const runtime = getSemanticRuntime();
    if (runtime.getModelStatus().status !== "ready") return result;
    const batchSize = Math.max(1, Math.min(100, Math.round(opts?.batchSize ?? 20)));
    this.semanticBackfillRunning = true;
    try {
      const totalHint = this.semanticIndexStats.pending;
      if (totalHint === 0) return result;
      await runtime.ensureSession();
      const conn = this.db.connection;
      const select = conn.prepare(`
        SELECT c.id, c.hash, c.content
        FROM library_chunks c JOIN library_items i ON i.id = c.item_id
        ${SEMANTIC_INDEX_JOIN}
        WHERE e.chunk_id IS NULL AND i.trashed_at IS NULL
          AND i.space_id IN (SELECT value FROM json_each(?))
          AND (? IS NULL OR c.id > ?)
        ORDER BY c.id LIMIT ?
      `);
      const store = conn.prepare(`
        INSERT OR REPLACE INTO library_chunk_embeddings
          (chunk_id, model_id, model_version, chunk_hash, dimension, embedding, created_at)
        SELECT c.id, ?, ?, c.hash, ?, ?, ?
        FROM library_chunks c JOIN library_items i ON i.id = c.item_id
        WHERE c.id = ? AND c.hash = ? AND i.trashed_at IS NULL
          AND i.space_id IN (SELECT value FROM json_each(?))
      `);
      let cursor: string | null = null;
      while (!opts?.signal?.aborted) {
        const eligible = JSON.stringify(hybridLibrarySpaceIds(this.db));
        const batch = select.all(...SEMANTIC_INDEX_PARAMS, eligible, cursor, cursor, batchSize) as Array<{
          id: string; hash: string; content: string;
        }>;
        if (!batch.length) break;
        const embeddings: Array<{ chunk: typeof batch[number]; bytes: Buffer }> = [];
        for (const chunk of batch) {
          if (opts?.signal?.aborted) return result;
          result.processed++;
          cursor = chunk.id;
          try {
            const vector = await runtime.embed(chunk.content);
            if (vector.length !== SEMANTIC_DIMENSION) throw new Error("语义向量维度不匹配");
            embeddings.push({ chunk, bytes: Buffer.from(new Uint8Array(vector.buffer, vector.byteOffset, vector.byteLength)) });
          } catch (err) {
            result.failed++;
            console.warn("[Library] 片段语义索引失败：", chunk.id, err);
          }
        }
        if (opts?.signal?.aborted) return result;
        const currentEligible = JSON.stringify(hybridLibrarySpaceIds(this.db));
        conn.transaction(() => {
          for (const { chunk, bytes } of embeddings) {
            const { changes } = store.run(SEMANTIC_MODEL_ID, SEMANTIC_MODEL_VERSION, SEMANTIC_DIMENSION,
              bytes, Date.now(), chunk.id, chunk.hash, currentEligible);
            if (changes) result.succeeded++;
            else result.skipped++;
          }
        })();
        opts?.onProgress?.(result.processed, totalHint);
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
    } finally {
      this.semanticBackfillRunning = false;
      this.semanticIndexFailures = result.failed;
    }
    return result;
  }

  /** 可抽取的 Office/PDF 类型（文本类直接内联；image/file 不抽取） */
  private isExtractableKind(kind: LibraryItemKind): boolean {
    return kind === "office" || kind === "pdf";
  }

  /**
   * 异步抽取并建立 FTS 索引（写入后 fire-and-forget 调用；读取路径亦可显式调用）。
   * 与 getExtractedText 共享 per-item in-flight 去重与缓存（并发 search/read 只解析一次）；
   * 受管路径守卫前置：越界/symlink → unsupported + 清 FTS。
   */
  async indexExtractedText(itemId: string): Promise<void> {
    const item = this.repo.getItem(itemId);
    if (!item) return;
    if (!this.isExtractableKind(item.kind)) return;
    const abs = this.files.absolutePath(item);
    if (!abs || !this.files.isManagedFileSafe(abs)) {
      this.repo.updateExtractStatus(item.id, "unsupported");
      this.repo.deleteFts(item.id);
      this.repo.deleteChunks(item.id);
      return;
    }
    const key = this.extractCacheKey(abs, item);
    const result = await this.getIndexExtractedText(item);
    const current = this.repo.getItem(item.id);
    if (!current || this.extractCacheKey(abs, current) !== key || this.files.absolutePath(current) !== abs) return;
    this.repo.updateExtractStatus(current.id, result.status);
    if (result.status === "extracted" && result.text) {
      this.repo.upsertFts(item.id, current.title, current.filename, result.text);
      this.refreshChunksForItem(item.id, result.text);
    } else {
      this.repo.deleteFts(item.id);
      this.repo.deleteChunks(item.id);
    }
  }

  /**
   * 获取文档抽取正文（带缓存：size+mtime+contentHash 变化即失效重抽；per-item 并发去重）。
   * extracted → 返回正文（≤200KB，truncated 标记）；unsupported/error → text=null。
   */
  async getExtractedText(item: LibraryItemDto, textMaxChars?: number): Promise<ExtractionResult> {
    if (this.repo.isTextReadable(item.kind)) {
      const abs = this.files.absolutePath(item);
      if (!abs || !this.files.isManagedFileSafe(abs)) {
        return { status: "unsupported", text: null, truncated: false, error: "受管文件不可安全读取" };
      }
      const prefix = readUtf8Prefix(abs, textMaxChars ?? EXTRACT_MAX_OUTPUT_CHARS);
      return { status: "extracted", text: prefix.content, truncated: prefix.contentTruncated };
    }
    const result = await this.getIndexExtractedText(item);
    if (result.text === null || result.text.length <= EXTRACT_MAX_OUTPUT_CHARS) return result;
    return { ...result, text: result.text.slice(0, EXTRACT_MAX_OUTPUT_CHARS), truncated: true };
  }

  private async getIndexExtractedText(item: LibraryItemDto): Promise<ExtractionResult> {
    const abs = this.files.absolutePath(item);
    if (!abs || !this.files.isManagedFileSafe(abs)) {
      return { status: "unsupported", text: null, truncated: false, error: "受管文件不可安全读取" };
    }
    const key = this.extractCacheKey(abs, item);
    const cached = this.extractCache.get(item.id);
    if (cached && cached.key === key) return cached.result;
    const inflightKey = `${item.id}:${key}`;
    const inflight = this.inflightExtract.get(inflightKey);
    if (inflight) return inflight;
    const promise = this.extractors.extract(item.kind, item.mimeType, abs, libraryIndexExtractionBudget());
    this.inflightExtract.set(inflightKey, promise);
    try {
      const result = await promise;
      if (this.extractCacheKey(abs, item) === key) this.cacheExtraction(item.id, key, result);
      return result;
    } finally {
      this.inflightExtract.delete(inflightKey);
    }
  }

  private cacheExtraction(itemId: string, key: string, result: ExtractionResult): void {
    this.extractCache.set(itemId, { key, result });
    if (this.extractCache.size > 8) {
      const oldest = this.extractCache.keys().next().value;
      if (oldest !== undefined) this.extractCache.delete(oldest);
    }
  }

  /** 等待全部进行中的异步抽取完成（测试确定性 / 关库前收敛） */
  async flushPendingIndexes(): Promise<void> {
    await Promise.allSettled([...this.pendingIndexes]);
  }

  /**
   * 启动恢复：把中断/重启遗留的 office/pdf 条目重新入队抽取（status NULL/pending/error，
   * 或已 extracted 但 FTS 行缺失）。返回入队数量；调用方 fire-and-forget。
   * 与 chunk backfill 的恢复边界：本方法负责 library_fts/extract_status，backfillMissingChunks
   * 负责 library_chunks/library_chunks_fts；office/pdf 的“完整自愈”由两者先后触发共同覆盖。
   */
  async recoverPendingExtractions(): Promise<number> {
    this.repo.prepareLargeOfficeExtractionUpgrade(EXTRACT_MAX_OUTPUT_CHARS);
    const candidates = this.repo.listExtractionRecoveryCandidates();
    if (candidates.length) {
      const pending = (async () => {
        for (const { id } of candidates) {
          await this.indexExtractedText(id).catch((err) => console.warn(`[Library] 恢复抽取失败 ${id}：`, err));
          await new Promise<void>(resolve => setImmediate(resolve));
        }
      })();
      this.pendingIndexes.add(pending);
      void pending.finally(() => this.pendingIndexes.delete(pending));
    }
    return candidates.length;
  }

  private extractCacheKey(abs: string, item: LibraryItemDto): string {
    try {
      const st = statSync(abs);
      return `${st.size}:${st.mtimeMs}:${item.contentHash ?? ""}`;
    } catch {
      return "missing";
    }
  }
}
