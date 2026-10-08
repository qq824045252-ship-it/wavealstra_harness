import type { ArtifactDescriptor } from "@shared/artifact-types";
import type { ChatMessage } from "@/types";

/** Only browser-safe image sources bypass the Artifact Domain. Never load arbitrary file URLs. */
export function directChatImageSource(source: string): string | null {
  const value = source.trim();
  if (/^data:image\/(?:png|jpe?g|gif|webp|avif|bmp);base64,[a-z\d+/=\s]+$/i.test(value)) return value;
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
  const images = descriptors.filter((d) => d.taskId === taskId && isChatVisualArtifact(d));
  if (/^mybuddy-artifact:/i.test(source)) {
    try {
      const url = new URL(source);
      if (url.hostname !== "local" || url.search || url.hash) return undefined;
      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length !== 1) return undefined;
      return images.find((d) => d.id === decodeURIComponent(parts[0]!));
    } catch { return undefined; }
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
  return descriptors.filter((d) => {
    if (d.taskId !== taskId || !isChatVisualArtifact(d)) return false;
    const tool = d.createdByToolCallId ? tools.get(d.createdByToolCallId) : undefined;
    if (tool && INTERNAL_IMAGE_TOOLS.has(tool)) return false;
    return d.createdByMessageId === message.id || Boolean(d.createdByMessageId && message.sourceMessageIds?.includes(d.createdByMessageId)) || Boolean(tool);
  });
}
