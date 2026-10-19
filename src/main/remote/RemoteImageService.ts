import { open, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import type { ArtifactService } from '../artifact/ArtifactService';
import type { AppDatabase } from '../db/AppDatabase';
import type { ArtifactDescriptor } from '../../shared/artifact-types';
import type { RemoteImageArtifact, RemoteTaskHistory } from '../../../shared/src/remote-contract';

const MAX_IMAGE_BYTES = 16 * 1024 * 1024;
const MAX_STORED_BYTES = Math.ceil(MAX_IMAGE_BYTES * 4 / 3) + 1024;
const INTERNAL_IMAGE_TOOLS = new Set(['browser_exec', 'ui_exec', 'computer_exec', 'describe_image']);
export type RemoteArtifactReader = Pick<ArtifactService, 'get' | 'getSnapshot' | 'entryPathOf' | 'listMessageRefs'>;
export class RemoteImageError extends Error {
  constructor(readonly status: number, message: string) { super(message); }
}
function inside(root: string, target: string): boolean {
  const rel = relative(resolve(root), resolve(target));
  return rel !== '..' && !rel.startsWith('..' + sep) && !isAbsolute(rel);
}
function rasterCandidate(d: ArtifactDescriptor): boolean {
  return d.kind === 'image' && !/svg/i.test(d.mimeType ?? '')
    && !/\.svg$/i.test(d.source.type === 'workspace-file' ? d.source.entryFile : d.title ?? '');
}
/** Derive Content-Type from bytes, never trust a model-supplied filename/MIME. */
export function remoteRasterMime(bytes: Buffer): string | null {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137,80,78,71,13,10,26,10]))
    && bytes.toString('ascii', 12, 16) === 'IHDR') return 'image/png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return 'image/jpeg';
  if (bytes.length >= 10 && /GIF8[79]a/.test(bytes.toString('ascii', 0, 6))) return 'image/gif';
  if (bytes.length >= 16 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return 'image/webp';
  if (bytes.length >= 26 && bytes.toString('ascii', 0, 2) === 'BM') return 'image/bmp';
  if (bytes.length >= 16 && bytes.toString('ascii', 4, 8) === 'ftyp' && /^(avif|avis)$/.test(bytes.toString('ascii', 8, 12))) return 'image/avif';
  return null;
}

/** Same Artifact Domain as desktop; no URL proxy and no caller-supplied file paths. */
export class RemoteImageService {
  constructor(private readonly db: Pick<AppDatabase, 'getTask'>, private readonly source: () => RemoteArtifactReader | null | undefined) {}

  enrichHistory(taskId: string, history: RemoteTaskHistory): RemoteTaskHistory {
    const task = this.db.getTask(taskId);
    const source = this.source();
    if (!task || !source) return { ...history, imageArtifacts: [] };
    const descriptors = source.getSnapshot(taskId).artifacts.filter(d => d.taskId === taskId && rasterCandidate(d));
    const images: RemoteImageArtifact[] = descriptors.map(d => {
      const entry = d.source.type === 'workspace-file' ? d.source.entryFile : typeof d.capabilities.diskPath === 'string' ? d.capabilities.diskPath : undefined;
      const sources: string[] = entry ? [entry] : [];
      if (entry && task.cwd && inside(task.cwd, entry)) sources.push(relative(task.cwd, entry).replace(/\\/g, '/'));
      return { id: d.id, name: d.title || (entry ? basename(entry) : '生成图片'), kind: 'image', version: d.version,
        mimeType: d.mimeType, sources, createdByMessageId: d.createdByMessageId, createdByToolCallId: d.createdByToolCallId };
    });
    const refs = source.listMessageRefs(taskId);
    return { ...history, imageArtifacts: images, messages: history.messages.map(message => {
      if (message.role !== 'assistant') return message;
      const tools = new Map((message.tools ?? []).map(t => [t.id, t.tool]));
      const linked = images.filter(image => {
        const tool = image.createdByToolCallId ? tools.get(image.createdByToolCallId) : undefined;
        if (tool && INTERNAL_IMAGE_TOOLS.has(tool)) return false;
        return image.createdByMessageId === message.id || Boolean(tool) || refs.some(ref => ref.artifactId === image.id
          && (ref.messageId === message.id || Boolean(ref.toolCallId && tools.has(ref.toolCallId) && !INTERNAL_IMAGE_TOOLS.has(tools.get(ref.toolCallId)!))));
      });
      if (!linked.length) return message;
      const artifacts = new Map((message.artifacts ?? []).map(a => [a.id, a]));
      for (const image of linked) artifacts.set(image.id, { id: image.id, name: image.name, kind: image.kind });
      return { ...message, artifacts: [...artifacts.values()] };
    }) };
  }

  async read(taskId: string, artifactId: string, version?: number): Promise<{ bytes: Buffer; mimeType: string; version: number }> {
    const source = this.source();
    const d = source?.get(artifactId);
    if (!this.db.getTask(taskId) || !source || !d || d.taskId !== taskId || !rasterCandidate(d)) throw new RemoteImageError(404, '图片产物不存在');
    if (version !== undefined && version !== d.version) throw new RemoteImageError(409, '图片版本已变化，请刷新');
    const entry = source.entryPathOf(d.id);
    if (!entry || !inside(d.source.rootDir, entry)) throw new RemoteImageError(404, '图片文件不可用');
    let bytes: Buffer;
    try {
      // Resolve symlinks/junctions too. A registered path is not carte blanche to read outside its root.
      const [root, physical] = await Promise.all([realpath(d.source.rootDir), realpath(entry)]);
      if (!inside(root, physical)) throw new RemoteImageError(404, '图片文件不可用');
      const handle = await open(physical, 'r');
      try {
        const before = await handle.stat();
        if (!before.isFile()) throw new RemoteImageError(404, '图片文件不可用');
        if (before.size > MAX_STORED_BYTES) throw new RemoteImageError(413, '图片超过 16 MB 预览限制');
        const storage = Buffer.alloc(before.size);
        let offset = 0;
        while (offset < storage.length) {
          const read = await handle.read(storage, offset, storage.length - offset, offset);
          if (!read.bytesRead) throw new RemoteImageError(409, '图片正在变化，请重试');
          offset += read.bytesRead;
        }
        const after = await handle.stat();
        const pathNow = await realpath(entry);
        const identity = await stat(pathNow);
        // 只把「文件被替换」或「尺寸变化」视为内容不可信；单纯的 mtime 抖动
        // （OneDrive/网盘同步、时间戳精度、生成器 touch）不应让预览失败。
        if (pathNow !== physical || before.size !== after.size || identity.ino !== before.ino || identity.dev !== before.dev) {
          throw new RemoteImageError(409, '图片正在变化，请重试');
        }
        bytes = storage;
      } finally { await handle.close(); }
    } catch (error) {
      if (error instanceof RemoteImageError) throw error;
      throw new RemoteImageError(404, '图片文件不可用');
    }
    if (d.source.type === 'managed-content') {
      const data = /^data:image\/(?:png|jpeg|jpg|gif|webp|bmp|avif);base64,([a-z\d+/=\s]+)$/i.exec(bytes.toString('utf8').trim());
      if (!data) throw new RemoteImageError(415, '该产物不是可预览的图片');
      bytes = Buffer.from(data[1]!.replace(/\s/g, ''), 'base64');
    }
    if (bytes.length > MAX_IMAGE_BYTES) throw new RemoteImageError(413, '图片超过 16 MB 预览限制');
    const mimeType = remoteRasterMime(bytes);
    if (!mimeType) throw new RemoteImageError(415, '该产物不是可预览的图片');
    return { bytes, mimeType, version: d.version };
  }
}
