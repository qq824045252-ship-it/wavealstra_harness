/**
 * Artifact Ingestion helper — Wave 3C
 *
 * Renderer writer → ArtifactService.register 的归一化适配层：
 * - renderer ArtifactKind（markdown/code/html/svg/image/table/pdf/docx/xlsx/pptx）
 *   ↔ Domain ArtifactKind（markdown/code/html/svg/image/pdf/office）映射
 * - 原始 kind 存 capabilities.originalKind（渲染细分保留）
 * - workspace root 判定：root 内 → workspace-file（安全边界）；root 外 → managed-content copy
 *
 * 原则（3C）：Renderer 只触发 intent + 提供数据；Artifact 生命周期全部在 Main Domain。
 */
import type { ArtifactKind as DomainArtifactKind, ArtifactDescriptor, ArtifactRegistration } from "../../../shared/artifact-types";
import type { Artifact, ArtifactKind as RendererArtifactKind } from "@/types";
import { languageFromName } from "./workspace";

/** renderer kind → Domain kind */
export function toDomainKind(kind: RendererArtifactKind): DomainArtifactKind {
  switch (kind) {
    case "markdown":
    case "code":
    case "html":
    case "svg":
    case "image":
    case "video":
    case "audio":
    case "pdf":
      return kind;
    case "docx":
    case "xlsx":
    case "pptx":
      return "office";
    case "table":
    default:
      return "markdown";
  }
}

/** Domain kind → renderer kind（无 originalKind 时的兜底；office 细分丢失时给 docx） */
export function toRendererKind(d: {
  kind: DomainArtifactKind;
  capabilities?: Record<string, unknown>;
  title?: string;
  source?: ArtifactDescriptor["source"];
}): RendererArtifactKind {
  // Compatibility for SVGs registered by older builds as kind=image. The file
  // extension is part of the trusted descriptor, so repair the view kind at the
  // projection boundary without mutating the persisted historical row.
  const sourceName =
    d.source?.type === "workspace-file"
      ? d.source.entryFile
      : typeof d.capabilities?.diskPath === "string"
        ? d.capabilities.diskPath
        : d.title;
  if (typeof sourceName === "string" && /\.svg(?:$|[?#])/i.test(sourceName)) return "svg";
  const original = d.capabilities?.originalKind;
  if (typeof original === "string") {
    const candidates: RendererArtifactKind[] = [
      "markdown", "code", "html", "svg", "image", "video", "audio", "table", "pdf", "docx", "xlsx", "pptx",
    ];
    if ((candidates as string[]).includes(original)) return original as RendererArtifactKind;
  }
  switch (d.kind) {
    case "markdown":
    case "code":
    case "html":
    case "svg":
    case "image":
    case "video":
    case "audio":
    case "pdf":
      return d.kind;
    case "office":
      return "docx";
    case "cad":
      // Mechanical CAD 二进制产物（FCStd 等）：渲染侧按代码/文本卡片回退，内容为 base64 data URI
      return "code";
    default:
      return "docx";
  }
}

/** 文件是否在 workspace root 内（安全边界判定；不区分大小写 + 分隔符归一） */
export function isInsideRoot(root: string | undefined, filePath: string | undefined): boolean {
  if (!root || !filePath) return false;
  const base = root.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const target = filePath.replace(/\\/g, "/").toLowerCase();
  return target === base || target.startsWith(`${base}/`);
}

/** 打开文件的渲染内容缓存（3C 桥：只服务渲染，非真相） */
export interface ArtifactRenderPayload {
  name: string;
  kind: RendererArtifactKind;
  content: string;
  language?: string;
  path?: string;
  /**
   * 内容版本绑定（§5.2 hotfix）：cache 有效条件 = payload.artifactVersion === descriptor.version；
   * 否则一律 stale，必须重新 readContent hydration。
   */
  artifactVersion: number;
}

/**
 * descriptor → renderer Artifact 派生（3E：reader 直读 projection；不再经 task.artifacts 桥）。
 * content 只来自 renderCache（打开的 artifact）；未打开的历史 artifact content 为空，
 * 渲染/引用需要时走 artifactDomain.readContent（3D/3E）。
 */
export function toRendererArtifact(d: ArtifactDescriptor, cache?: ArtifactRenderPayload): Artifact {
  const name =
    d.title ??
    cache?.name ??
    (d.source.type === "workspace-file" ? (d.source.entryFile.split(/[\\/]/).pop() ?? d.id) : d.id);
  return {
    id: d.id,
    name,
    kind: toRendererKind(d),
    content: cache?.content ?? "",
    language: cache?.language ?? languageFromName(name),
    path:
      d.source.type === "workspace-file"
        ? d.source.entryFile
        : typeof d.capabilities?.diskPath === "string"
          ? d.capabilities.diskPath
          : cache?.path,
    capabilities: d.capabilities,
  };
}

/**
 * 构造注册输入：workspace root 内 → workspace-file（不复制内容）；
 * root 外 → managed-content（复制内容，受 ArtifactStorage 管辖）。
 */
export function buildRegistration(
  taskId: string,
  input: {
    name: string;
    kind: RendererArtifactKind;
    content: string;
    language?: string;
    path?: string;
    workspaceRoot?: string;
  },
): ArtifactRegistration {
  const kind = toDomainKind(input.kind);
  const diskPath = input.path?.trim();
  const capabilities: Record<string, unknown> = { originalKind: input.kind };
  if (diskPath) capabilities.diskPath = diskPath;
  if (diskPath && isInsideRoot(input.workspaceRoot, diskPath)) {
    return {
      taskId,
      kind,
      title: input.name,
      capabilities,
      workspaceFile: { entryFile: diskPath, rootDir: input.workspaceRoot! },
    };
  }
  // 绝对路径在任务 cwd 外（技能写到空间目录、ProjectLibre 落盘等）：
  // 仍按 workspace-file 登记，rootDir 用文件所在目录，保证预览/拖出有 path。
  if (diskPath && (/^[A-Za-z]:[\\/]/.test(diskPath) || diskPath.startsWith("/") || diskPath.startsWith("\\\\"))) {
    const rootDir = diskPath.replace(/[\\/]+$/, "").replace(/[\\/][^\\/]+$/, "") || diskPath;
    return {
      taskId,
      kind,
      title: input.name,
      capabilities,
      workspaceFile: { entryFile: diskPath, rootDir },
    };
  }
  return { taskId, kind, title: input.name, capabilities, content: input.content };
}
