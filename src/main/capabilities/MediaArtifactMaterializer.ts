import { constants, createWriteStream } from "node:fs";
import { copyFile, mkdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { Readable } from "node:stream";
import { finished } from "node:stream/promises";
import type { ArtifactDescriptor, ArtifactKind } from "../../shared/artifact-types";
import type { ArtifactService } from "../artifact/ArtifactService";
import { isPathInsideOrEqual } from "../task/TaskExecutionWorkspace";
import type { GeneratedMediaItem, GeneratedMediaOutput, ToolExecutionContext } from "./BuiltinCapabilityRuntime";

const MAX_BYTES: Record<"image" | "video" | "audio", number> = {
  image: 64 * 1024 * 1024,
  video: 1024 * 1024 * 1024,
  audio: 256 * 1024 * 1024,
};

const EXT_BY_MIME: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
  "image/gif": ".gif",
  "image/avif": ".avif",
  "image/bmp": ".bmp",
  "image/x-icon": ".ico",
  "video/mp4": ".mp4",
  "video/webm": ".webm",
  "video/quicktime": ".mov",
  "audio/mpeg": ".mp3",
  "audio/mp3": ".mp3",
  "audio/wav": ".wav",
  "audio/x-wav": ".wav",
  "audio/ogg": ".ogg",
  "audio/mp4": ".m4a",
};

function safeFileName(input: string | undefined, fallback: string, mimeType: string): string {
  const wanted = basename(input?.trim() || fallback)
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/^\.+/, "")
    .slice(0, 160);
  const expectedExt = EXT_BY_MIME[mimeType.toLowerCase()];
  if (!expectedExt) throw new Error(`不支持的媒体类型：${mimeType}`);
  const suppliedExt = extname(wanted);
  const stem = suppliedExt ? wanted.slice(0, -suppliedExt.length) : wanted;
  return `${stem || fallback}${expectedExt}`;
}

function assertKindMime(kind: "image" | "video" | "audio", mimeType: string): void {
  const normalized = mimeType.trim().toLowerCase();
  if (!normalized.startsWith(`${kind}/`) || !EXT_BY_MIME[normalized]) {
    throw new Error(`Provider 返回的 ${kind} MIME 不受支持：${mimeType}`);
  }
}

async function writeRemote(url: string, target: string, limit: number, signal?: AbortSignal): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") throw new Error("Provider 媒体 URL 必须使用 HTTPS");
  const response = await fetch(parsed, { redirect: "follow", signal });
  if (!response.ok || !response.body) throw new Error(`媒体下载失败：HTTP ${response.status}`);
  const finalUrl = new URL(response.url);
  if (finalUrl.protocol !== "https:") throw new Error("Provider 媒体重定向必须保持 HTTPS");
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > limit) throw new Error(`媒体文件超过大小限制（${Math.ceil(limit / 1024 / 1024)} MiB）`);
  let received = 0;
  const stream = Readable.fromWeb(response.body as never);
  stream.on("data", (chunk: Buffer) => {
    received += chunk.length;
    if (received > limit) stream.destroy(new Error("媒体文件超过大小限制"));
  });
  await finished(stream.pipe(createWriteStream(target, { flags: "wx" })));
  // 空文件拦截：远端返回空 body 时拒绝留 0 字节文件
  const downloaded = await stat(target);
  if (downloaded.size <= 0) {
    await rm(target, { force: true });
    throw new Error("媒体下载结果为空（远端返回空内容，拒绝生成空文件）");
  }
}

export class MediaMaterializationPartialStateError extends Error {
  constructor(
    public readonly retainedPaths: string[],
    public readonly retainedArtifactIds: string[],
    public readonly originalMessage: string,
  ) {
    const artifacts = retainedArtifactIds.slice(0, 8).join(", ") || "none";
    const paths = retainedPaths.slice(0, 8).join(", ") || "none";
    super(`媒体批次失败且回滚不完整：${originalMessage}；残留 Artifact=${artifacts}；残留文件=${paths}`);
    this.name = "MediaMaterializationPartialStateError";
  }
}

interface MediaBatchEntry {
  path: string;
  artifact?: ArtifactDescriptor;
  service?: ArtifactService;
}
export interface MaterializedMediaResult {
  artifacts: ArtifactDescriptor[];
  paths: string[];
}

export class MediaArtifactMaterializer {
  constructor(
    private readonly artifactService: () => ArtifactService | null,
    private readonly onArtifactRegistered?: (path: string) => void,
  ) {}

  async materialize(
    kind: "image" | "video" | "audio",
    output: GeneratedMediaOutput,
    context: ToolExecutionContext,
    titlePrefix: string,
  ): Promise<MaterializedMediaResult> {
    context.signal?.throwIfAborted();
    if (!output.items.length) throw new Error("Provider 没有返回媒体文件");
    const root = resolve(context.taskRoot);
    const directory = resolve(root, "generated", kind);
    if (!isPathInsideOrEqual(root, directory)) throw new Error("生成目录越出任务工作区");
    await mkdir(directory, { recursive: true });

    const artifacts: ArtifactDescriptor[] = [];
    const paths: string[] = [];
    const batch: MediaBatchEntry[] = [];
    try {
      for (let index = 0; index < output.items.length; index += 1) {
        context.signal?.throwIfAborted();
        const item = output.items[index];
        assertKindMime(kind, item.mimeType);
        const name = safeFileName(item.fileName, `${kind}-${Date.now()}-${index + 1}`, item.mimeType);
        const target = resolve(directory, `${randomUUID().slice(0, 8)}-${name}`);
        const temporary = `${target}.partial`;
        if (!isPathInsideOrEqual(root, target)) throw new Error("生成文件越出任务工作区");
        try {
          await this.writeItem(item, temporary, root, kind, context.signal);
          context.signal?.throwIfAborted();
          await rename(temporary, target);
        } catch (error) {
          try { await rm(temporary, { force: true }); } catch { /* best effort */ }
          throw error;
        }

        const entry: MediaBatchEntry = { path: target };
        batch.push(entry);
        paths.push(target);
        context.signal?.throwIfAborted();
        const service = this.artifactService();
        if (service) {
          const artifact = await service.register({
            taskId: context.taskId,
            kind: kind as ArtifactKind,
            title: output.items.length > 1 ? `${titlePrefix} ${index + 1}` : titlePrefix,
            mimeType: item.mimeType,
            capabilities: {
              originalKind: kind,
              provider: output.provider,
              model: output.model,
              requestId: output.requestId,
              width: item.width,
              height: item.height,
              durationSeconds: item.durationSeconds,
            },
            workspaceFile: { entryFile: target, rootDir: root },
            producerMessageId: context.producerMessageId,
            producerToolCallId: context.toolCallId,
          });
          entry.artifact = artifact;
          entry.service = service;
          artifacts.push(artifact);
          context.signal?.throwIfAborted();
          try { this.onArtifactRegistered?.(target); }
          catch { /* artifact registration is committed; emission dedupe is best-effort */ }
        }
      }
      context.signal?.throwIfAborted();
      return { artifacts, paths };
    } catch (error) {
      const retainedPaths: string[] = [];
      const retainedArtifactIds: string[] = [];
      for (const entry of [...batch].reverse()) {
        let canDeleteFile = true;
        if (entry.artifact && entry.service) {
          try {
            entry.service.remove(entry.artifact.id);
          } catch {
            retainedArtifactIds.push(entry.artifact.id);
            canDeleteFile = false;
          }
        }
        if (canDeleteFile) {
          try { await rm(entry.path, { force: true }); }
          catch { retainedPaths.push(entry.path); }
        } else {
          retainedPaths.push(entry.path);
        }
      }
      if (retainedPaths.length || retainedArtifactIds.length) {
        throw new MediaMaterializationPartialStateError(
          [...new Set(retainedPaths)],
          [...new Set(retainedArtifactIds)],
          error instanceof Error ? error.message : String(error),
        );
      }
      throw error;
    }
  }
  private async writeItem(
    item: GeneratedMediaItem,
    target: string,
    root: string,
    kind: "image" | "video" | "audio",
    signal?: AbortSignal,
  ): Promise<void> {
    const sources = Number(Boolean(item.bytes)) + Number(Boolean(item.url)) + Number(Boolean(item.localPath));
    if (sources !== 1) throw new Error("Provider 媒体项必须且只能提供 bytes、url 或 localPath 之一");
    if (item.bytes) {
      // 空字节拦截：0 字节截图/媒体此前会落盘成 0 字节文件，viewer 无限“解码中…”（如 e471654c-browser-screenshot.png）
      if (item.bytes.byteLength <= 0) throw new Error("Provider 媒体字节为空（截图可能失败，拒绝生成空文件）");
      if (item.bytes.byteLength > MAX_BYTES[kind]) throw new Error("Provider 媒体字节超过大小限制");
      await writeFile(target, item.bytes, { flag: "wx" });
      return;
    }
    if (item.url) {
      await writeRemote(item.url, target, MAX_BYTES[kind], signal);
      return;
    }
    const local = await realpath(resolve(item.localPath!));
    const realRoot = await realpath(root);
    if (!isPathInsideOrEqual(realRoot, local)) throw new Error("Provider 返回的本地媒体必须位于任务工作区内");
    const info = await stat(local);
    if (!info.isFile() || info.size <= 0) throw new Error("Provider 本地媒体为空或无效，拒绝生成空文件");
    if (info.size > MAX_BYTES[kind]) throw new Error("Provider 本地媒体超过大小限制");
    await copyFile(local, target, constants.COPYFILE_EXCL);
  }
}
