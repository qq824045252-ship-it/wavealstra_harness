import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type { AppDatabase } from "../db/AppDatabase";
import type { LibraryItemDto, LibraryItemKind } from "../../shared/library-ipc";
import type {
  RuntimeLibraryDocumentContent,
  RuntimeEmbeddingStats,
  RuntimeLibraryIndexStatus,
  RuntimeLibrarySourceVersion,
} from "../platform/runtime-audit";
import { toItem, type LibraryCatalogRows, type LibraryRepository } from "./LibraryRepository";
import pLimit from "p-limit";
import { hybridLibrarySpaceIds } from "./MaterialRetrievalSettings";
import { chunkText, chunkTextParts, LIBRARY_CHUNK_DEFAULTS } from "./library-chunker";
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
const INDEX_CONCURRENCY = 4;

const SEMANTIC_INDEX_JOIN = `
  LEFT JOIN library_chunk_embeddings e ON e.chunk_id = c.id AND e.chunk_hash = c.hash
    AND e.model_id = ? AND e.model_version = ? AND e.dimension = ? AND length(e.embedding) = ?
`;
const SEMANTIC_INDEX_PARAMS = [SEMANTIC_MODEL_ID, SEMANTIC_MODEL_VERSION, SEMANTIC_DIMENSION, SEMANTIC_DIMENSION * 4] as const;
const SEMANTIC_INDEX_MODEL = { modelId: SEMANTIC_MODEL_ID, modelVersion: SEMANTIC_MODEL_VERSION, dimension: SEMANTIC_DIMENSION };

function indexItemVersion(item: LibraryItemDto) {
  const { id, spaceId, title, filename, kind, mimeType, contentHash, updatedAt, sizeBytes, extractStatus } = item;
  return { id, spaceId, title, filename, kind, mimeType, contentHash, updatedAt, sizeBytes, extractStatus };
}

function extractableKind(kind: LibraryItemKind): boolean {
  return kind === "office" || kind === "pdf";
}

interface LibraryIndexFiles {
  absolutePath(item: LibraryItemDto): string;
  assertManagedFile(path: string): void;
  isManagedFileSafe(path: string): boolean;
}

export interface LibraryTextStage {
  stagingPath: string;
  contentHash: string;
  chunkCount: number;
  updatedAt: number;
  sourceSize: number;
  sourceModifiedNanos: string;
}

/** Maintains derived Library FTS, chunks and embeddings. Managed file ownership stays with LibraryService. */
export class LibraryIndexMaintenance {
  private readonly extractors: ContentExtractorRegistry = new ContentExtractorRegistry();
  /** 抽取缓存（itemId → 内容；按 size+mtime 失效；容量上限 8 条，防会话内重复解析） */
  private readonly extractCache = new Map<string, { key: string; result: ExtractionResult }>();
  /** 进行中的异步抽取（写入后 fire-and-forget；测试/关闭前可 flush） */
  private readonly pendingIndexes = new Set<Promise<void>>();
  private readonly indexWork = pLimit(INDEX_CONCURRENCY);
  private readonly documentWork = pLimit(INDEX_CONCURRENCY);
  /** per-item in-flight 去重：同一条目并发 search/read 只解析一次 */
  private readonly inflightExtract = new Map<string, Promise<ExtractionResult>>();
  /** 仅保存需要文件级 targeted fallback 的文本条目；健康 FTS 搜索不做额外 DB 反查。 */
  private readonly textFtsFallbackIds = new Set<string>();

  constructor(
    private readonly db: AppDatabase,
    private readonly repo: LibraryRepository,
    private readonly files: LibraryIndexFiles,
  ) {
    if (db.fixtureConnection) this.refreshTextFtsFallbackState();
  }

  get pendingTextFtsIds(): ReadonlySet<string> { return this.textFtsFallbackIds; }

  private async readIndexItem(id: string): Promise<LibraryItemDto | undefined> {
    if (this.db.fixtureConnection) return this.repo.getItem(id) ?? undefined;
    const catalog = await this.db.runtimeAuditReader?.libraryMetadata<LibraryCatalogRows>({ kind: "catalog", itemId: id });
    if (!catalog) throw new Error("Core 未确认资料索引来源");
    const item = catalog.items[0];
    return item && toItem(item);
  }

  private async coreIndexPage(work: "documents" | "text" | "chunks", after: string | undefined, limit: number): Promise<LibraryItemDto[]> {
    const rows = await this.db.runtimeAuditReader?.libraryMetadata<LibraryCatalogRows["items"]>({ kind: "indexCandidates", work, after, limit });
    if (!rows) throw new Error("Core 未确认待恢复的资料索引");
    return rows.map(toItem);
  }

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

  refreshFts(item: LibraryItemDto, stage?: LibraryTextStage): void {
    this.extractCache.delete(item.id);
    if (this.repo.isTextSearchable(item.kind)) {
      const abs = this.files.absolutePath(item);
      if (item.sizeBytes > LARGE_LIBRARY_TEXT_BYTES) {
        this.indexLargeText(item, abs, stage);
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
    if (extractableKind(item.kind)) {
      // 先清旧 FTS + chunks（绝不返回陈旧索引），置 pending，异步抽取后重建
      this.repo.deleteFts(item.id);
      this.repo.deleteChunks(item.id);
      this.repo.updateExtractStatus(item.id, "pending");
      this.scheduleDocumentIndex(item.id);
      return;
    }
    this.repo.deleteFts(item.id);
    this.repo.deleteChunks(item.id);
    this.repo.updateExtractStatus(item.id, "unsupported");
  }

  private indexLargeText(item: LibraryItemDto, path: string, stage?: LibraryTextStage): void {
    this.files.assertManagedFile(path);
    if (stage) this.repo.replaceLargeTextIndexFromStage(item, stage.stagingPath, stage.chunkCount, stage.updatedAt);
    else this.repo.replaceLargeTextIndex(item, chunkTextParts(item.id, readLibraryTextParts(path)));
    this.completeTextIndex(item.id);
  }

  private completeTextIndex(id: string): void {
    this.textFtsFallbackIds.delete(id);
    this.scheduleSemanticIndex();
  }

  noteTextIndexed(id: string): void {
    this.extractCache.delete(id);
    this.completeTextIndex(id);
  }

  /** Hold the temporary index until the async publisher has finished using it. */
  async withLargeTextStage<T>(path: string, publish: (stage?: LibraryTextStage) => T | Promise<T>,
    copy?: { copyTo: string; refuseMarkdownLinks: boolean },
  ): Promise<T> {
    const reader = this.db.runtimeAuditReader;
    if (!reader || this.db.inTransaction) return publish();
    if (!copy) this.files.assertManagedFile(path);
    const before = statSync(path, { bigint: true });
    const stagingDir = await mkdtemp(join(tmpdir(), "mybuddy-library-index-"));
    const stagingPath = join(stagingDir, "chunks.sqlite");
    const updatedAt = Date.now();
    try {
      const result = await reader.stageLibraryText({
        path, stagingPath, expectedSize: Number(before.size), ...LIBRARY_CHUNK_DEFAULTS, ...copy,
      });
      if (!copy) this.files.assertManagedFile(path);
      else if (result) this.files.assertManagedFile(copy.copyTo);
      const after = statSync(path, { bigint: true });
      if (before.size !== after.size || before.mtimeNs !== after.mtimeNs || before.ctimeNs !== after.ctimeNs
          || before.dev !== after.dev || before.ino !== after.ino) throw new Error("资料文件在索引期间已变化");
      return await publish(result ? {
        ...result, stagingPath, updatedAt, sourceSize: Number(after.size), sourceModifiedNanos: after.mtimeNs.toString(),
      } : undefined);
    } finally {
      await rm(stagingDir, { recursive: true, force: true, maxRetries: 4, retryDelay: 50 })
        .catch(error => console.warn("[Library] 无法清理片段索引临时目录", error));
    }
  }

  private indexLargeTextAsync(item: LibraryItemDto, onlyMissing: boolean, signal?: AbortSignal): Promise<boolean> {
    const path = this.files.absolutePath(item);
    const currentVersion = (): LibraryItemDto | undefined => {
      if (signal?.aborted) return;
      const current = this.currentIndexItem(item);
      if (current && (!onlyMissing || !this.repo.hasChunks(item.id))) return current;
    };
    return this.withLargeTextStage(path, async stage => {
      if (signal?.aborted || !this.db.isOpen) return false;
      const current = this.db.fixtureConnection ? currentVersion() : item;
      if (!current) return false;
      if (stage) {
        const status = await this.db.runtimeAuditReader?.publishLibraryIndex({
          item: indexItemVersion(current),
          sourcePath: path, sourceSize: stage.sourceSize, sourceModifiedNanos: stage.sourceModifiedNanos,
          stagingUri: pathToFileURL(stage.stagingPath).href + "?mode=ro",
          chunkCount: stage.chunkCount, indexedAt: stage.updatedAt, onlyMissing,
        });
        if (status === "sourceChanged") throw new Error("资料文件在索引期间已变化");
        if (status === "skipped") return false;
        if (status === "indexed") {
          this.completeTextIndex(current.id);
          return true;
        }
        if (!this.db.fixtureConnection) throw new Error("Core 未确认大文本索引发布");
        // The fallback may run after another writer changed the source or item.
        if (!currentVersion()) return false;
        this.files.assertManagedFile(path);
        const source = statSync(path, { bigint: true });
        if (source.size !== BigInt(stage.sourceSize) || source.mtimeNs.toString() !== stage.sourceModifiedNanos) {
          throw new Error("资料文件在索引期间已变化");
        }
      }
      if (!this.db.fixtureConnection) throw new Error("Core 未确认大文本索引生成");
      this.indexLargeText(current, path, stage);
      return true;
    });
  }

  private currentIndexItem(item: LibraryItemDto): LibraryItemDto | undefined {
    if (!this.db.isOpen) return;
    const current = this.repo.getItem(item.id);
    if (!current || current.trashedAt != null) return;
    const expected = indexItemVersion(item);
    if (Object.entries(indexItemVersion(current)).every(([key, value]) => expected[key as keyof typeof expected] === value)
        && this.files.absolutePath(current) === this.files.absolutePath(item)) return current;
  }

  private sourceVersion(item: LibraryItemDto): RuntimeLibrarySourceVersion | undefined {
    const sourcePath = this.files.absolutePath(item);
    if (!sourcePath || !this.files.isManagedFileSafe(sourcePath)) return;
    try {
      const stamp = statSync(sourcePath, { bigint: true });
      if (stamp.isFile()) {
        return { sourcePath, sourceSize: Number(stamp.size), sourceModifiedNanos: stamp.mtimeNs.toString() };
      }
    } catch {
      // Files can be moved or removed between path validation and stat.
    }
  }

  private sourceUnchanged(item: LibraryItemDto, source: RuntimeLibrarySourceVersion | undefined): boolean {
    const current = this.sourceVersion(item);
    return current?.sourcePath === source?.sourcePath && current?.sourceSize === source?.sourceSize
      && current?.sourceModifiedNanos === source?.sourceModifiedNanos;
  }

  private publishDocument(
    item: LibraryItemDto, source: RuntimeLibrarySourceVersion | undefined,
    content: RuntimeLibraryDocumentContent, onlyMissing = false,
  ): Promise<RuntimeLibraryIndexStatus | undefined> | undefined {
    if (this.db.inTransaction) return;
    if (content.kind === "extracted" && content.text !== null) {
      // A parser's UTF-16 truncation can leave an unpaired surrogate. SQLite uses UTF-8.
      content = { ...content, text: content.text.replace(/[\uD800-\uDFFF]/gu, "\uFFFD") };
    }
    return this.db.runtimeAuditReader?.publishLibraryDocument({
      item: indexItemVersion(item), source, content, indexedAt: Date.now(), onlyMissing, ...LIBRARY_CHUNK_DEFAULTS,
    });
  }

  private async recoverTextIndex(item: LibraryItemDto, signal?: AbortSignal): Promise<boolean> {
    if (item.sizeBytes > LARGE_LIBRARY_TEXT_BYTES) return this.indexLargeTextAsync(item, false, signal);
    if (signal?.aborted) return false;
    const source = this.sourceVersion(item);
    if (!source && !this.db.fixtureConnection) return false;
    const status = await this.publishDocument(item, source, { kind: "textFile" });
    if (status === "indexed") {
      this.completeTextIndex(item.id);
      return true;
    }
    if (!this.db.fixtureConnection) {
      if (!status) throw new Error("Core 未确认文本全文索引发布");
      return false;
    }
    if (status || signal?.aborted || !this.currentIndexItem(item) || !this.sourceUnchanged(item, source)) return false;
    this.refreshFts(item);
    return true;
  }

  private async backfillDocumentChunks(item: LibraryItemDto, signal?: AbortSignal): Promise<boolean> {
    const source = this.sourceVersion(item);
    let content: RuntimeLibraryDocumentContent = { kind: "textFile" };
    if (extractableKind(item.kind)) {
      const result = source ? await this.getIndexExtractedText(item).catch(() => undefined) : undefined;
      content = { kind: "extracted", status: result?.status ?? "unsupported", text: result?.text ?? null };
    }
    if (signal?.aborted || !this.db.isOpen || !this.sourceUnchanged(item, source)
      || (this.db.fixtureConnection && !this.currentIndexItem(item))) return false;
    if (!source && !this.db.fixtureConnection) return false;
    const status = await this.publishDocument(item, source, content, true);
    if (status === "indexed") {
      this.scheduleSemanticIndex();
      return true;
    }
    if (!this.db.fixtureConnection) {
      if (!status) throw new Error("Core 未确认资料切片索引发布");
      return false;
    }
    if (status || signal?.aborted || !this.currentIndexItem(item)
        || !this.sourceUnchanged(item, source) || this.repo.hasChunks(item.id)) return false;
    let text: string | null = null;
    if (content.kind === "extracted") {
      if (content.status === "extracted") text = content.text;
    } else if (source) {
      try { text = readFileSync(source.sourcePath, "utf8"); } catch { /* Unreadable files have no indexable body. */ }
    }
    if (!text?.trim()) {
      this.repo.deleteChunks(item.id);
      return false;
    }
    this.repo.upsertChunks(item.id, chunkText(item.id, text));
    this.scheduleSemanticIndex();
    return true;
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
    if (this.repo.requiresRustWrites) {
      this.repo.enqueueBatch3("清理资料向量索引", {
        kind: "libraryChunkEmbeddings",
        upsert: [],
        deleteItemId: itemId,
        deleteChunkIds: [],
        pruneStaleItemId: null,
      });
      return;
    }
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
    if (this.repo.requiresRustWrites) {
      this.repo.enqueueBatch3("批量清理资料切片向量", {
        kind: "libraryChunkEmbeddings",
        upsert: [],
        deleteItemId: null,
        deleteChunkIds: chunkIds,
        pruneStaleItemId: null,
      });
      return;
    }
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
    if (this.repo.requiresRustWrites) {
      this.repo.enqueueBatch3("清理过期资料向量", {
        kind: "libraryChunkEmbeddings",
        upsert: [],
        deleteItemId: null,
        deleteChunkIds: [],
        pruneStaleItemId: itemId,
      });
      return;
    }
    const conn = ((this.db as any).connection ?? (this.db as any).db ?? (this.db as any));
    conn.prepare(`DELETE FROM library_chunk_embeddings WHERE chunk_id IN (SELECT id FROM library_chunks WHERE item_id = ?) AND chunk_hash != (SELECT hash FROM library_chunks WHERE library_chunks.id = library_chunk_embeddings.chunk_id)`).run(itemId);
  }

  /**
   * FTS text recovery：分批补齐旧版限长索引和缺失的派生行，完成后记录覆盖版本。
   */
  async recoverTextFtsCoverageV2(opts?: { batchSize?: number; signal?: AbortSignal }): Promise<{ processed: number; failed: number }> {
    if (!this.db.fixtureConnection) {
      const { processed, failed } = await this.backfillCoreIndex("text", opts);
      return { processed, failed };
    }
    if (!this.repo.ftsAvailable()) return { processed: 0, failed: 0 };
    const stateKey = "text-fts-coverage-version";
    const needsCoverageUpgrade = Number(this.repo.getIndexState(stateKey) ?? 0) < TEXT_FTS_COVERAGE_VERSION;
    this.refreshTextFtsFallbackState();
    const ids = [...this.textFtsFallbackIds];
    const batchSize = Math.max(1, Math.min(100, Math.floor(opts?.batchSize ?? 20)));
    let processed = 0;
    let failed = 0;
    let deferred = false;
    for (let offset = 0; offset < ids.length; offset += batchSize) {
      if (opts?.signal?.aborted) return { processed, failed };
      await Promise.all(ids.slice(offset, offset + batchSize).map(id => this.indexWork(async () => {
        if (opts?.signal?.aborted) return;
        try {
          const item = this.repo.getItem(id);
          if (item && this.repo.isTextSearchable(item.kind)) {
            const indexed = await this.recoverTextIndex(item, opts?.signal);
            if (!indexed && this.db.isOpen) {
              const current = this.repo.getItem(id);
              if (current && current.trashedAt == null) deferred = true;
            }
          }
          processed += 1;
        } catch (error) {
          failed += 1;
          console.warn(`[Library] FTS text recovery failed ${id}:`, error);
        }
      })));
      await new Promise<void>((resolvePromise) => setTimeout(resolvePromise, 0));
    }
    if (!opts?.signal?.aborted && failed === 0 && !deferred && needsCoverageUpgrade) {
      this.repo.setIndexState(stateKey, String(TEXT_FTS_COVERAGE_VERSION));
    }
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
    if (!this.db.fixtureConnection) return this.backfillCoreIndex("chunks", opts);
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
      afterRowId = batch.at(-1)!.rowId;
      await Promise.all(batch.map(({ id: itemId }) => this.indexWork(async () => {
        if (signal?.aborted) return;
        processed++;
        try {
          if (this.repo.hasChunks(itemId)) { skipped++; return; }
          const item = this.repo.getItem(itemId);
          if (!item) { skipped++; return; }
          // URL/file/image 等无可索引正文的类型不产生 chunk
          if (!this.repo.isTextSearchable(item.kind) && !extractableKind(item.kind)) { skipped++; return; }
          if (this.repo.isTextSearchable(item.kind) && item.sizeBytes > LARGE_LIBRARY_TEXT_BYTES) {
            if (await this.indexLargeTextAsync(item, true, signal)) succeeded++;
            else skipped++;
            return;
          }
          if (await this.backfillDocumentChunks(item, signal)) succeeded++;
          else skipped++;
        } catch (err) {
          failed++;
          console.warn(`[Library] chunk backfill 单项失败 ${itemId}，已跳过：`, err);
        }
      })));
      opts?.onProgress?.(processed, totalHint);
      // 每批让出事件循环，避免老用户几千份文档卡主线程
      await new Promise<void>((r) => setTimeout(r, 0));
    }
    return { processed, succeeded, failed, skipped };
  }

  private async backfillCoreIndex(work: "text" | "chunks", opts?: Parameters<LibraryIndexMaintenance["backfillMissingChunks"]>[0]) {
    const result = { processed: 0, succeeded: 0, failed: 0, skipped: 0 };
    const batchSize = Math.max(1, Math.min(100, Math.round(opts?.batchSize ?? 20)));
    let after: string | undefined;
    while (!opts?.signal?.aborted && this.db.isOpen) {
      const batch = await this.coreIndexPage(work, after, batchSize);
      if (!batch.length) break;
      after = batch.at(-1)!.id;
      await Promise.all(batch.map(item => this.indexWork(async () => {
        if (opts?.signal?.aborted || !this.db.isOpen) return;
        result.processed++;
        try {
          const indexed = work === "text" ? await this.recoverTextIndex(item, opts?.signal)
            : this.repo.isTextSearchable(item.kind) && item.sizeBytes > LARGE_LIBRARY_TEXT_BYTES
              ? await this.indexLargeTextAsync(item, true, opts?.signal)
              : await this.backfillDocumentChunks(item, opts?.signal);
          if (indexed) result.succeeded++;
          else result.skipped++;
        } catch (error) {
          result.failed++;
          console.warn(`[Library] 恢复资料索引失败 ${item.id}：`, error);
        }
      })));
      opts?.onProgress?.(result.processed, 0);
    }
    return result;
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

  get semanticIndexStats() {
    const row = this.db.connection.prepare(`
      SELECT COUNT(*) AS total, COUNT(e.chunk_id) AS completed
      FROM library_chunks c JOIN library_items i ON i.id = c.item_id
      ${SEMANTIC_INDEX_JOIN}
      WHERE i.trashed_at IS NULL AND i.space_id IN (SELECT value FROM json_each(?))
    `).get(...SEMANTIC_INDEX_PARAMS, JSON.stringify(hybridLibrarySpaceIds(this.db))) as { total: number; completed: number };
    return this.semanticIndexState(row);
  }

  async readSemanticIndexStats() {
    const native = await this.db.runtimeAuditReader?.embeddingIndex({ kind: "libraryStats", model: SEMANTIC_INDEX_MODEL });
    if (!native && !this.db.fixtureConnection) throw new Error("Core 未确认资料语义索引状态");
    return native ? this.semanticIndexState(native) : this.semanticIndexStats;
  }

  private semanticIndexState(counts: RuntimeEmbeddingStats) {
    return {
      ...counts,
      running: this.semanticBackfillRunning,
      pending: counts.total - counts.completed,
      failed: this.semanticIndexFailures,
      processed: counts.completed,
    };
  }

  async backfillEmbeddings(opts?: { batchSize?: number; signal?: AbortSignal; onProgress?: (done: number, totalHint: number) => void }): Promise<{ processed: number; succeeded: number; failed: number; skipped: number }> {
    const result = { processed: 0, succeeded: 0, failed: 0, skipped: 0 };
    if (this.semanticBackfillRunning || opts?.signal?.aborted) return result;
    const runtime = getSemanticRuntime(undefined, this.db.runtimeAuditReader);
    const batchSize = Math.max(1, Math.min(100, Math.round(opts?.batchSize ?? 20)));
    this.semanticBackfillRunning = true;
    try {
      if ((await runtime.getModelStatus()).status !== "ready" || opts?.signal?.aborted) return result;
      const totalHint = (await this.readSemanticIndexStats()).pending;
      if (totalHint === 0) return result;
      await runtime.ensureSession();
      const conn = this.db.fixtureConnection;
      const reader = this.db.runtimeAuditReader;
      const select = conn?.prepare(`
        SELECT c.id, c.hash
        FROM library_chunks c JOIN library_items i ON i.id = c.item_id
        ${SEMANTIC_INDEX_JOIN}
        WHERE e.chunk_id IS NULL AND i.trashed_at IS NULL
          AND i.space_id IN (SELECT value FROM json_each(?))
          AND (? IS NULL OR c.id > ?)
        ORDER BY c.id LIMIT ?
      `);
      const readContent = conn?.prepare("SELECT content FROM library_chunks WHERE id=? AND hash=?");
      const store = conn?.prepare(`
        INSERT OR REPLACE INTO library_chunk_embeddings
          (chunk_id, model_id, model_version, chunk_hash, dimension, embedding, created_at)
        SELECT c.id, ?, ?, c.hash, ?, ?, ?
        FROM library_chunks c JOIN library_items i ON i.id = c.item_id
        WHERE c.id = ? AND c.hash = ? AND i.trashed_at IS NULL
          AND i.space_id IN (SELECT value FROM json_each(?))
      `);
      let cursor: string | null = null;
      type Chunk = { id: string; hash: string };
      const embed = pLimit(INDEX_CONCURRENCY);
      while (!opts?.signal?.aborted) {
        const nativePage: Chunk[] | undefined = await reader?.embeddingIndex({
          kind: "libraryPage", model: SEMANTIC_INDEX_MODEL, after: cursor, limit: batchSize,
        });
        const batch: Chunk[] | undefined = nativePage ?? select?.all(...SEMANTIC_INDEX_PARAMS,
          JSON.stringify(hybridLibrarySpaceIds(this.db)), cursor, cursor, batchSize) as Chunk[] | undefined;
        if (!batch) throw new Error("Core 未确认资料语义索引待处理片段");
        if (!batch.length) break;
        cursor = batch.at(-1)!.id;
        const embeddings: Array<{ chunk: Chunk; bytes: Buffer }> = [];
        const staged: Array<{ chunk: Chunk; token: string }> = [];
        const computeFallback = async (chunk: Chunk) => {
          try {
            if (!readContent) throw new Error("Core 未确认资料片段向量生成");
            const content = (readContent.get(chunk.id, chunk.hash) as { content: string } | undefined)?.content;
            if (content === undefined) { result.skipped++; return; }
            const vector = await runtime.embed(content);
            if (vector.length !== SEMANTIC_DIMENSION) throw new Error("语义向量维度不匹配");
            embeddings.push({ chunk, bytes: Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength) });
          } catch (err) {
            result.failed++;
            console.warn("[Library] 片段语义索引失败：", chunk.id, err);
          }
        };
        try {
          await Promise.all(batch.map(chunk => embed(async () => {
            if (opts?.signal?.aborted) return;
            result.processed++;
            try {
              const native = await runtime.stageIndex({ kind: "library", id: chunk.id, hash: chunk.hash });
              if (native?.status === "staged") staged.push({ chunk, token: native.token });
              else if (native?.status === "skipped") result.skipped++;
              else if (native?.status === "current") result.succeeded++;
              else await computeFallback(chunk);
            } catch (error) {
              result.failed++;
              console.warn("[Library] 片段语义索引失败：", chunk.id, error);
            }
          })));
          if (opts?.signal?.aborted) return result;
          if (staged.length) {
            const published = await reader?.publishEmbeddings(staged.map(entry => entry.token));
            if (published) {
              result.succeeded += published.indexed + published.current;
              result.skipped += published.skipped;
              staged.length = 0;
            } else {
              if (!conn) throw new Error("Core 未确认资料片段语义索引发布");
              await Promise.all(staged.map(({ chunk }) => embed(async () => {
                if (!opts?.signal?.aborted) await computeFallback(chunk);
              })));
            }
          }
        } finally {
          if (staged.length) await reader?.discardEmbeddings(staged.map(entry => entry.token));
        }
        if (opts?.signal?.aborted) return result;
        if (embeddings.length) {
          const eligibleSpaceIds = hybridLibrarySpaceIds(this.db);
          if (this.repo.requiresRustWrites) {
            if (!reader) throw new Error("资料向量写入：Rust 核心未就绪");
            const now = Date.now();
            const res = await reader.batch3Write<{ succeeded: number }>({
              kind: "libraryChunkEmbeddings",
              upsert: embeddings.map(({ chunk, bytes }) => ({
                chunkId: chunk.id,
                modelId: SEMANTIC_MODEL_ID,
                modelVersion: SEMANTIC_MODEL_VERSION,
                chunkHash: chunk.hash,
                dimension: SEMANTIC_DIMENSION,
                embeddingBase64: bytes.toString("base64"),
                createdAt: now,
                eligibleSpaceIds,
              })),
              deleteItemId: null,
              deleteChunkIds: [],
              pruneStaleItemId: null,
            });
            if (!res) throw new Error("资料向量写入未收到 Rust 核心确认");
            result.succeeded += res.succeeded;
            result.skipped += embeddings.length - res.succeeded;
          } else if (conn && store) {
            const currentEligible = JSON.stringify(eligibleSpaceIds);
            conn.transaction(() => {
              for (const { chunk, bytes } of embeddings) {
                const { changes } = store.run(SEMANTIC_MODEL_ID, SEMANTIC_MODEL_VERSION, SEMANTIC_DIMENSION,
                  bytes, Date.now(), chunk.id, chunk.hash, currentEligible);
                if (changes) result.succeeded++;
                else result.skipped++;
              }
            })();
          }
        }
        opts?.onProgress?.(result.processed, totalHint);
        await new Promise<void>(resolve => setTimeout(resolve, 0));
      }
    } finally {
      this.semanticBackfillRunning = false;
      this.semanticIndexFailures = result.failed;
    }
    return result;
  }

  /**
   * 异步抽取并建立 FTS 索引（写入后 fire-and-forget 调用；读取路径亦可显式调用）。
   * 与 getExtractedText 共享 per-item in-flight 去重与缓存（并发 search/read 只解析一次）；
   * 受管路径守卫前置：越界/symlink → unsupported + 清 FTS。
   */
  async indexExtractedText(itemId: string): Promise<void> {
    const item = await this.readIndexItem(itemId);
    if (!item || !extractableKind(item.kind) || item.trashedAt != null) return;
    const source = this.sourceVersion(item);
    const result = source ? await this.getIndexExtractedText(item) : { status: "unsupported" as const, text: null };
    if (!this.db.fixtureConnection) {
      if (!this.db.isOpen || !this.sourceUnchanged(item, source)) return;
      const status = await this.publishDocument(item, source, { kind: "extracted", status: result.status, text: result.text });
      if (!status) throw new Error("Core 未确认文档索引发布");
      if (status === "indexed") this.scheduleSemanticIndex();
      return;
    }
    const currentSourceItem = (): LibraryItemDto | undefined => {
      if (!this.db.isOpen) return;
      const current = this.repo.getItem(itemId);
      if (current && current.trashedAt == null && current.kind === item.kind && current.mimeType === item.mimeType
          && current.contentHash === item.contentHash && this.files.absolutePath(current) === this.files.absolutePath(item)
          && this.sourceUnchanged(current, source)) return current;
    };
    const current = currentSourceItem();
    if (!current) return;
    const status = await this.publishDocument(current, source, { kind: "extracted", status: result.status, text: result.text });
    if (status === "indexed") this.scheduleSemanticIndex();
    if (status) return;
    const fallback = currentSourceItem();
    if (!fallback || fallback.extractStatus !== current.extractStatus) return;
    const text = result.status === "extracted" && result.text ? result.text : null;
    this.repo.replaceExtractedIndex(fallback, text, result.status, chunkText(fallback.id, text ?? ""));
    this.scheduleSemanticIndex();
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
    while (this.pendingIndexes.size) await Promise.allSettled(this.pendingIndexes);
  }

  private scheduleDocumentIndex(id: string): void {
    const pending = this.documentWork(async () => {
      if (this.db.isOpen) await this.indexExtractedText(id);
    })
      .catch(error => console.warn(`[Library] 文档抽取索引失败 ${id}：`, error));
    this.pendingIndexes.add(pending);
    void pending.finally(() => this.pendingIndexes.delete(pending));
  }

  /**
   * 启动恢复：把中断/重启遗留的 office/pdf 条目重新入队抽取（status NULL/pending/error，
   * 或已 extracted 但 FTS 行缺失）。返回入队数量；调用方 fire-and-forget。
   * 与 chunk backfill 的恢复边界：本方法负责 library_fts/extract_status，backfillMissingChunks
   * 负责 library_chunks/library_chunks_fts；office/pdf 的“完整自愈”由两者先后触发共同覆盖。
   */
  async recoverPendingExtractions(): Promise<number> {
    if (!this.db.fixtureConnection) {
      let after: string | undefined;
      let scheduled = 0;
      while (this.db.isOpen) {
        const items = await this.coreIndexPage("documents", after, 64);
        if (!items.length) break;
        after = items.at(-1)!.id;
        for (const item of items) this.scheduleDocumentIndex(item.id);
        scheduled += items.length;
      }
      return scheduled;
    }
    this.repo.prepareLargeOfficeExtractionUpgrade(EXTRACT_MAX_OUTPUT_CHARS);
    const candidates = this.repo.listExtractionRecoveryCandidates();
    for (const { id } of candidates) this.scheduleDocumentIndex(id);
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
