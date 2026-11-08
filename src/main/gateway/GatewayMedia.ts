import { createHash } from "node:crypto";
import { mkdir, readdir, lstat, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { getGatewayDir } from "../paths";

export class GatewayMediaError extends Error {
  constructor(message: string, readonly retryable = false) { super(message); this.name = "GatewayMediaError"; }
}

export interface GatewayMediaSource {
  url: string;
  name: string;
  allowedHosts: readonly string[];
  fetch?: typeof fetch;
  headers?: Record<string, string>;
  expectedSize?: number;
  /** Adapter-owned codec (e.g. authenticated platform media decryption), never user code. */
  transform?: (bytes: Uint8Array) => Uint8Array;
}
export const GATEWAY_MEDIA_LIMITS = { file: 20 * 1024 * 1024, batch: 40 * 1024 * 1024,
  cache: 256 * 1024 * 1024, count: 10, timeout: 30_000 } as const;
type Attachment = { name: string; path: string };
let tail: Promise<unknown> = Promise.resolve();

function safeName(name: string): string {
  const cleaned = name.replace(/[\\/\x00-\x1f\x7f]/g, "_").replace(/^\.+/, "");
  const extension = /\.[a-zA-Z0-9]{1,10}$/.exec(cleaned)?.[0] ?? "";
  return (cleaned.length <= 180 ? cleaned : cleaned.slice(0, 180 - extension.length) + extension) || "attachment.bin";
}
/** Only authenticated adapters construct sources. No arbitrary URL or local-path tool is exposed. */
async function download(source: GatewayMediaSource): Promise<Uint8Array> {
  let url: URL;
  try { url = new URL(source.url); } catch { throw new GatewayMediaError("Gateway 附件地址无效"); }
  if (url.protocol !== "https:" || url.username || url.password || (url.port && url.port !== "443")
    || !source.allowedHosts.includes(url.hostname) || url.hash) throw new GatewayMediaError("Gateway 附件来源不允许");
  if (source.expectedSize !== undefined && (!Number.isSafeInteger(source.expectedSize)
    || source.expectedSize < 0 || source.expectedSize > GATEWAY_MEDIA_LIMITS.file)) throw new GatewayMediaError("Gateway 附件超过大小限制");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GATEWAY_MEDIA_LIMITS.timeout);
  try {
    const response = await (source.fetch ?? fetch)(url.href, { redirect: "error", signal: controller.signal,
      headers: source.headers });
    if (!response.ok) throw new GatewayMediaError("Gateway 附件服务拒绝下载", response.status === 408 || response.status === 429 || response.status >= 500);
    if (response.redirected || !response.body) throw new GatewayMediaError("Gateway 附件响应无效");
    const declared = response.headers.get("content-length");
    if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > GATEWAY_MEDIA_LIMITS.file)) throw new GatewayMediaError("Gateway 附件超过大小限制");
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > GATEWAY_MEDIA_LIMITS.file) throw new GatewayMediaError("Gateway 附件超过大小限制");
        chunks.push(part.value);
      }
    } finally { await reader.cancel().catch(() => {}); }
    if (!size) throw new GatewayMediaError("Gateway 附件为空");
    const bytes = new Uint8Array(size);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    let decoded: Uint8Array;
    try { decoded = source.transform ? source.transform(bytes) : bytes; }
    catch { throw new GatewayMediaError("Gateway 附件解码失败"); }
    if (!(decoded instanceof Uint8Array) || !decoded.byteLength || decoded.byteLength > GATEWAY_MEDIA_LIMITS.file) throw new GatewayMediaError("Gateway 附件解码后超过限制");
    // Native image ingestion has a 12 MiB limit. Reject rather than silently omit it.
    if (/\.(png|jpe?g|gif|webp|bmp)$/i.test(source.name) && decoded.byteLength > 12 * 1024 * 1024) throw new GatewayMediaError("Gateway 图片超过原生Agent的12MiB限制");
    return decoded;
  } catch (error) {
    if (error instanceof GatewayMediaError) throw error;
    // Never propagate fetch errors containing provider credentials or signed URLs.
    throw new GatewayMediaError("Gateway 附件下载失败", true);
  } finally { clearTimeout(timer); }
}

async function prepare(items: GatewayMediaSource[], directory: string): Promise<Attachment[]> {
  if (items.length > GATEWAY_MEDIA_LIMITS.count) throw new GatewayMediaError("Gateway 附件数量超过限制");
  if (!items.length) return [];
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if (!(await lstat(directory)).isDirectory() || (await lstat(directory)).isSymbolicLink()) throw new GatewayMediaError("Gateway 附件目录无效");
  let used = 0;
  for (const file of await readdir(directory)) {
    const stat = await lstat(join(directory, file));
    if (stat.isFile()) used += stat.size;
  }
  const created: string[] = [];
  const attachments: Attachment[] = [];
  let batch = 0;
  try {
    for (const item of items) {
      const bytes = await download(item);
      batch += bytes.byteLength;
      if (batch > GATEWAY_MEDIA_LIMITS.batch) throw new GatewayMediaError("Gateway 附件总大小超过限制");
      const name = safeName(item.name);
      // Preserve the extension used by the native agent's image/file handling.
      const suffix = /\.[a-zA-Z0-9]{1,10}$/.exec(name)?.[0].toLowerCase() ?? ".bin";
      const hash = createHash("sha256").update(bytes).digest("hex");
      const path = join(directory, hash + suffix);
      const stat = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return undefined;
      });
      if (stat) {
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > GATEWAY_MEDIA_LIMITS.file || createHash("sha256").update(await readFile(path)).digest("hex") !== hash) {
          throw new GatewayMediaError("Gateway 附件缓存校验失败");
        }
      } else {
        if (used + bytes.byteLength > GATEWAY_MEDIA_LIMITS.cache) throw new GatewayMediaError("Gateway 附件缓存已满，请清理不再需要的附件后重试");
        await writeFile(path, bytes, { flag: "wx", mode: 0o600 });
        created.push(path);
        used += bytes.byteLength;
      }
      attachments.push({ name, path });
    }
    return attachments;
  } catch (error) {
    await Promise.all(created.map(path => unlink(path).catch(() => {})));
    throw error;
  }
}

/** Retain successful files for the native task's later turns and recovery. Never prune referenced files. */
export async function withGatewayMedia<T>(items: GatewayMediaSource[], consume: (attachments: Attachment[]) => Promise<T>,
  options: { directory?: string } = {}): Promise<T> {
  if (!items.length) return consume([]);
  const run = tail.then(async () => {
    try { return await prepare(items, options.directory ?? join(getGatewayDir(), "media")); }
    catch (error) {
      if (error instanceof GatewayMediaError) throw error;
      throw new GatewayMediaError("Gateway 附件本地缓存不可用，请检查磁盘空间和目录权限");
    }
  });
  tail = run.catch(() => {});
  return consume(await run);
}
