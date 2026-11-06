import { isArtifactImageUrl, parseArtifactImageUrl } from "@shared/artifact-ipc";
import type { ArtifactDescriptor } from "@shared/artifact-types";
import type { ChatMessage } from "@/types";

/** Only browser-safe image sources bypass the Artifact Domain. Never load arbitrary file URLs. */
export function directChatImageSource(source: string): string | null {
  const value = source.trim();
  if (/^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,[a-z\d+/=\s]+$/i.test(value)) return value;
  // 本应用构造的产物图片协议 URL（字节由主进程投递，renderer 不碰 base64）
  if (isArtifactImageUrl(value)) return value;
  try {
    const url = new URL(value);
    if (url.protocol === "https:" && !url.username && !url.password) return url.href;
  } catch { /* Local references are resolved against registered artifacts below. */ }
  return null;
}

/** SVGs created before the kind fix may still be persisted as kind=image. */
export function isSvgArtifact(descriptor: ArtifactDescriptor): boolean {
  if (descriptor.kind === "svg") return true;
  const entry =
    descriptor.source.type === "workspace-file"
      ? descriptor.source.entryFile
      : typeof descriptor.capabilities.diskPath === "string"
        ? descriptor.capabilities.diskPath
        : descriptor.title;
  return typeof entry === "string" && /\.svg(?:$|[?#])/i.test(entry);
}

function isChatVisualArtifact(descriptor: ArtifactDescriptor): boolean {
  return descriptor.kind === "image" || isSvgArtifact(descriptor);
}

/**
 * 视觉产物索引（P3：进入任务就卡）。
 *
 * descriptors 是 store 里按 taskId 切好的稳定数组引用；每次渲染都全量 filter
 * 一遍（一条 38 图消息 × 每张图每次重渲染）是进入会话时的主要 CPU 开销之一。
 * 按数组身份缓存 taskId → 视觉产物列表：数组没换就只算一次。
 */
const visualArtifactIndex = new WeakMap<readonly ArtifactDescriptor[], Map<string, ArtifactDescriptor[]>>();

function visualArtifactsFor(
  descriptors: readonly ArtifactDescriptor[],
  taskId: string | null,
): ArtifactDescriptor[] {
  let byTask = visualArtifactIndex.get(descriptors);
  if (!byTask) {
    byTask = new Map();
    visualArtifactIndex.set(descriptors, byTask);
  }
  const key = taskId ?? "";
  const cached = byTask.get(key);
  if (cached) return cached;
  const built = descriptors.filter((d) => d.taskId === taskId && isChatVisualArtifact(d));
  byTask.set(key, built);
  return built;
}

/** Strip only the harmless XML declaration/BOM commonly emitted by SVG authoring tools. */
function normalizeSvgDocumentText(source: string): string | null {
  const value = source
    .trim()
    .replace(/^\uFEFF/, "")
    .trimStart()
    .replace(/^<\?xml\s+[\s\S]*?\?>\s*/i, "");
  return /^<svg[\s>]/i.test(value) && /<\/svg\s*>$/i.test(value) ? value : null;
}

/** Decode only a registered Artifact payload; arbitrary assistant-authored SVG data URLs stay blocked. */
export function svgTextFromArtifactContent(content: string): string | null {
  const value = content.trim();
  const rawSvg = normalizeSvgDocumentText(value);
  if (rawSvg) return rawSvg;
  const match = /^data:image\/svg\+xml(?:;charset=[^;,]+)?(;base64)?,(.*)$/is.exec(value);
  if (!match) return null;
  try {
    if (!match[1]) return normalizeSvgDocumentText(decodeURIComponent(match[2]!));
    const binary = atob(match[2]!.replace(/\s+/g, ""));
    const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
    return normalizeSvgDocumentText(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return null;
  }
}

function normalizePath(source: string): string | null {
  let value = source.trim();
  value = value.replace(/^file:\/\/localhost\//i, "/").replace(/^file:\/\//i, "");
  value = value.replace(/\\/g, "/").replace(/^\/([a-z]:\/)/i, "$1");
  if (/[\0\r\n]/.test(value)) return null;
  const absolute = value.startsWith("/");
  const parts: string[] = [];
  for (const part of value.split("/")) {
    if (!part || part === ".") continue;
    if (part === "..") {
      if (!parts.length || /^[a-z]:$/i.test(parts[parts.length - 1]!)) return null;
      parts.pop();
    } else parts.push(part);
  }
  return `${absolute ? "/" : ""}${parts.join("/")}`.toLowerCase();
}

/** Match exact task paths, never basename/suffix: two directories may contain the same filename. */
export function resolveChatImageArtifact(
  source: string,
  descriptors: readonly ArtifactDescriptor[],
  taskId: string | null,
  cwd?: string,
): ArtifactDescriptor | undefined {
  const images = visualArtifactsFor(descriptors, taskId);
  if (/^mybuddy-artifact:/i.test(source)) {
    // 与协议层、`<img src>` 判定共用同一份 URL 解析（白名单只在 artifact-ipc）。
    // 这里允许无 variant 的宿主 URL：正文可能引用产物入口而非图片变体。
    const parsed = parseArtifactImageUrl(source);
    return parsed ? images.find((d) => d.id === parsed.artifactId) : undefined;
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(source) && !/^(?:file:|[a-z]:[\\/])/i.test(source)) return undefined;
  let decoded: string;
  try { decoded = decodeURIComponent(source); } catch { return undefined; }
  const path = normalizePath(decoded);
  if (!path) return undefined;
  const absolute = /^(?:[a-z]:\/|\/)/i.test(path);
  const target = absolute ? path : cwd ? normalizePath(`${cwd}/${path}`) : null;
  if (!target) return undefined;
  return images.find((d) => {
    const entry = d.source.type === "workspace-file" ? d.source.entryFile : d.capabilities.diskPath;
    return typeof entry === "string" && normalizePath(entry) === target;
  });
}

const INTERNAL_IMAGE_TOOLS = new Set(["browser_exec", "ui_exec", "computer_exec", "describe_image"]);

/** Persisted tool-call provenance survives history's regenerated message IDs. No orphan guessing. */
export function messageImageArtifacts(
  message: ChatMessage,
  descriptors: readonly ArtifactDescriptor[],
  taskId: string | null,
): ArtifactDescriptor[] {
  const tools = new Map(
    message.blocks.filter((b) => b.type === "tool").map((b) => [b.toolCall.id, b.toolCall.tool]),
  );
  return visualArtifactsFor(descriptors, taskId).filter((d) => {
    const tool = d.createdByToolCallId ? tools.get(d.createdByToolCallId) : undefined;
    if (tool && INTERNAL_IMAGE_TOOLS.has(tool)) return false;
    return d.createdByMessageId === message.id || Boolean(d.createdByMessageId && message.sourceMessageIds?.includes(d.createdByMessageId)) || Boolean(tool);
  });
}
