/**
 * R2 Chunk-level Locator — Chunker
 * 设计原则（§28-30）：
 * - 仅定位辅助，≠ Source of Truth；Hit 仍指向 Library Item，Top-K chunk 不自动塞 Prompt
 * - 参数由真实文档 benchmark 决定；此处提供可扫描的 chunker 实现，默认参数见 LIBRARY_CHUNK_DEFAULTS
 * - 生产链：LibraryService.writeContent/refreshFts 之后走 chunker → library_chunks + library_chunks_fts
 */
import { createHash } from "node:crypto";

export interface LibraryChunk {
  id: string;
  itemId: string;
  chunkIndex: number;
  content: string;
  charOffset: number;
  hash: string;
  updatedAt: number;
}

export interface LibraryChunkerOptions {
  /** 每 chunk 字符数（默认 800，适合中文/中英混排；R2-2 网格扫描域 400/600/800/1000/1200） */
  chunkSize: number;
  /** 重叠字符数（默认 120，约 15% 覆盖，保证跨边界短查询命中；扫描域 0/80/120/200） */
  overlap: number;
}

export const LIBRARY_CHUNK_DEFAULTS: LibraryChunkerOptions = {
  chunkSize: 800,
  overlap: 120,
};

/**
 * 选参依据（R2-2 benchmark 框架所需指标）：
 * - 定位精度：已知锚点查询在 Top-1/Top-3 是否命中正确 item/正确 chunk 邻域
 * - 索引体积：library_chunks 行数 × 平均长度
 * - 建索引耗时： chunker + writeChunks 耗时
 * - 检索延迟：chunk FTS 单次 MATCH 耗时（P50/P95）
 */
export function normalizeChunkerOptions(opts?: Partial<LibraryChunkerOptions>): LibraryChunkerOptions {
  const chunkSize = Math.max(200, Math.min(4000, Math.round(opts?.chunkSize ?? LIBRARY_CHUNK_DEFAULTS.chunkSize)));
  const overlap = Math.max(0, Math.min(Math.floor(chunkSize * 0.5), Math.round(opts?.overlap ?? LIBRARY_CHUNK_DEFAULTS.overlap)));
  return { chunkSize, overlap };
}

function hashContent(content: string): string {
  return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
}

/**
 * 按字符窗口切 chunk（重叠滑动窗口）：
 * - 输入 text 已是 extractor 输出（≤200KB，truncated 标记由调用方知会）
 * - 按 charOffset 记录在原 text 中的起始偏移（用于 hit location）
 * - 空文本返回 0 chunk
 */
export function chunkText(
  itemId: string,
  text: string,
  opts?: Partial<LibraryChunkerOptions>,
  nowMs = Date.now(),
): LibraryChunk[] {
  const { chunkSize, overlap } = normalizeChunkerOptions(opts);
  if (!text || text.length === 0) return [];
  const chunks: LibraryChunk[] = [];
  const step = Math.max(1, chunkSize - overlap);
  let offset = 0;
  let index = 0;
  while (offset < text.length) {
    const end = Math.min(text.length, offset + chunkSize);
    const content = text.slice(offset, end);
    if (content.trim().length === 0) {
      offset += step;
      continue;
    }
    chunks.push({
      id: `${itemId}#${index}`,
      itemId,
      chunkIndex: index,
      content,
      charOffset: offset,
      hash: hashContent(content),
      updatedAt: nowMs,
    });
    if (end >= text.length) break;
    offset += step;
    index += 1;
  }
  return chunks;
}
