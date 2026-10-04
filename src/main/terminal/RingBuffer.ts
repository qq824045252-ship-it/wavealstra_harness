/**
 * ByteBoundedRingBuffer — 终端输出有界环形缓冲（纯内存）
 *
 * P0 用途：
 *  - 供 xterm 重连/切回恢复（open/attach 时回放尾部）
 *  - 为 Chat Context Source（terminal:tail）提供「最近输出」数据源
 *
 * 约束：按 utf8 字节上限裁剪（Buffer.byteLength），丢弃最旧整块；
 * 绝不无限增长。块内部不裁剪（避免拆散多字节字符/ANSI 序列）。
 */

export interface RingChunk {
  data: string;
  bytes: number;
}

export class ByteBoundedRingBuffer {
  private chunks: RingChunk[] = [];
  private totalBytes = 0;
  private droppedBytes = 0;

  constructor(private readonly maxBytes: number) {}

  get size(): number {
    return this.totalBytes;
  }

  /** 因超限丢弃的总字节数（>0 表示有更早输出被裁掉） */
  get dropped(): number {
    return this.droppedBytes;
  }

  push(data: string): void {
    if (!data) return;
    const bytes = Buffer.byteLength(data, "utf8");
    if (bytes > this.maxBytes) {
      // 单块超上限：先按块丢弃更早内容（计入 dropped），保留该块整体（不拆散 ANSI/多字节字符）
      this.droppedBytes += this.totalBytes;
      this.chunks = [];
      this.totalBytes = 0;
      this.chunks.push({ data, bytes });
      this.totalBytes = bytes;
      return;
    }
    this.chunks.push({ data, bytes });
    this.totalBytes += bytes;
    this.dropHeadWhileOverflow();
  }

  /** 按当前上限合并尾部（全部内容；调用方自行按需截断） */
  tail(): string {
    return this.chunks.map((c) => c.data).join("");
  }

  /** 尾部有界截取：字节预算内、UTF-8 安全（不拆代理对、不超预算） */
  tailBounded(maxBytes: number): string {
    return tailBounded(this.chunks, maxBytes);
  }

  /** 清空（restart 时使用） */
  clear(): void {
    this.chunks = [];
    this.totalBytes = 0;
    this.droppedBytes = 0;
  }

  private dropHeadWhileOverflow(): void {
    while (this.totalBytes > this.maxBytes && this.chunks.length > 1) {
      const head = this.chunks.shift()!;
      this.totalBytes -= head.bytes;
      this.droppedBytes += head.bytes;
    }
  }
}

/* ------------------------------------------------------------------ */
/* 模块级纯函数（可单测）                                              */
/* ------------------------------------------------------------------ */

/** 单字符 UTF-8 编码字节数（按 code unit 判断；代理对在 takeTailBytes 中合并处理） */
function utf8Width(code: number): number {
  if (code < 0x80) return 1;
  if (code < 0x800) return 2;
  if (code < 0x10000) return 3; // 含孤立代理（UTF-8 编码为 3 字节）
  return 4; // 代理对（codeUnit 单独出现时按 4 字节近似，实际由 pair 分支处理）
}

/**
 * 取字符串尾部、字节数不超过 maxBytes 且不拆散代理对的子串。
 * 从尾向前按字符累积 UTF-8 字节数，超预算即停；结果始终 ≤ 预算。
 */
export function takeTailBytes(s: string, maxBytes: number): string {
  if (!s || maxBytes <= 0) return "";
  let bytes = 0;
  let start = s.length;
  while (start > 0) {
    const code = s.charCodeAt(start - 1);
    if (code >= 0xdc00 && code <= 0xdfff && start >= 2) {
      // 低代理：与前一 code unit 合并为完整代理对（4 字节），不拆散
      const hi = s.charCodeAt(start - 2);
      if (hi >= 0xd800 && hi <= 0xdbff) {
        if (bytes + 4 > maxBytes) break;
        start -= 2;
        bytes += 4;
        continue;
      }
    }
    const w = utf8Width(code);
    if (bytes + w > maxBytes) break;
    start -= 1;
    bytes += w;
  }
  return s.slice(start);
}

/**
 * 尾部有界截取：从尾向前累积块，直到字节预算用尽；
 * 边界块按 UTF-8 字节安全截断（takeTailBytes）：不超预算、不拆代理对。
 */
export function tailBounded(chunks: RingChunk[], maxBytes: number): string {
  if (chunks.length === 0) return "";
  const budget = Math.max(1, maxBytes);
  const parts: string[] = [];
  let used = 0;
  for (let i = chunks.length - 1; i >= 0; i -= 1) {
    const chunk = chunks[i];
    if (used + chunk.bytes <= budget) {
      parts.unshift(chunk.data);
      used += chunk.bytes;
    } else {
      const room = budget - used;
      if (room > 0) parts.unshift(takeTailBytes(chunk.data, room));
      break;
    }
  }
  return parts.join("");
}
