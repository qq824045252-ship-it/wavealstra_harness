/**
 * Artifact Domain IPC 契约 — V3.5 Wave 2 冻结版（§6/§20）
 *
 * 与 Native Surface 命令（ArtifactIpc: preview/setRect/reload/hide/show/close）
 * 完全分离：Domain 管"数据从哪来、谁是真相"，Surface 管"视图在哪里、何时显示"。
 *
 * 本文件只定义契约；通道注册在 Wave 3 接入 main 时完成。
 * Renderer Artifact projection 唯一写入源 = snapshot + created/updated/removed 事件（§20）。
 */
import type {
  ArtifactDescriptor,
  ArtifactLoadState,
  ArtifactSnapshot,
  ArtifactUpdatedEvent,
  ArtifactRemovedEvent,
  ArtifactCreatedEvent,
} from "./artifact-types";

export const ArtifactDomainIpc = {
  /** renderer → main：取单个 artifact（registry 优先，miss 回源 repository） */
  get: "artifact-domain:get",
  /** renderer → main：取 task 的 artifact 列表（lazy hydrate 入口） */
  list: "artifact-domain:list",
  /** renderer → main：取 task 快照（含 load state，§25；首次触发 legacy migration） */
  snapshot: "artifact-domain:snapshot",
  /** renderer → main：注册新 artifact（3C：Artifact create 唯一通道） */
  register: "artifact-domain:register",
  /** renderer → main：读取 artifact 内容（managed→storage；workspace-file→fs+root 边界） */
  readContent: "artifact-domain:readContent",
  /** renderer → main：删除 task 的全部 artifact（task 生命周期，§3B.6） */
  removeTask: "artifact-domain:removeTask",
  /** renderer → main：删除单个 artifact（产物列/文件树删除） */
  remove: "artifact-domain:remove",
  /** main → renderer：artifact 创建事件 */
  created: "artifact-domain:created",
  /** main → renderer：artifact 内容/版本变化事件（version++ 后推送，§70） */
  updated: "artifact-domain:updated",
  /** main → renderer：artifact 移除事件 */
  removed: "artifact-domain:removed",
} as const;

/**
 * 图片内联链路的协议 URL（P0：renderer 不碰图片 base64）。
 *
 * 字节全部由主进程 mybuddy-artifact:// 协议按需投递：
 * - variant=thumb：长边 1280 的降采样副本 + 进程内缓存（聊天内联 <img> 用）
 * - variant=full：原图（仅"查看原图"/产物面板点击时加载）
 * query 里的 mime/bytes/width/height 只是元数据，供 ImageArtifactView 显示格式、
 * 体积和透明背景棋盘格，避免为了几十字节再跑一次 IPC。
 */
export type ArtifactImageVariant = "thumb" | "full";

export interface ArtifactImageMeta {
  mime?: string;
  bytes?: number;
  width?: number;
  height?: number;
  /**
   * 产物版本，作为 URL 缓存键写成 `v=`。
   * Chromium 按 URL 分键缓存自定义协议响应：没有版本参数就只能 `no-store`，
   * 虚拟列表滚出 overscan 卸载 <img> 后再滚回来会重新发请求并重新解码位图。
   */
  version?: number;
}

/** 允许出现在图片协议 URL 上的 query 参数 —— 唯一白名单，协议层与 renderer 共用 */
const ARTIFACT_IMAGE_PARAMS = new Set(["variant", "mime", "bytes", "w", "h", "v"]);

export function artifactImageUrl(
  artifactId: string,
  variant: ArtifactImageVariant,
  meta: ArtifactImageMeta = {},
): string {
  const params = new URLSearchParams({ variant });
  if (meta.mime) params.set("mime", meta.mime);
  if (typeof meta.bytes === "number") params.set("bytes", String(meta.bytes));
  if (typeof meta.width === "number") params.set("w", String(meta.width));
  if (typeof meta.height === "number") params.set("h", String(meta.height));
  if (typeof meta.version === "number") params.set("v", String(meta.version));
  return `mybuddy-artifact://local/${encodeURIComponent(artifactId)}/?${params.toString()}`;
}

export interface ParsedArtifactImageUrl {
  artifactId: string;
  /** 无 ?variant= 时为 null（`ArtifactProtocol.urlFor` 生成的宿主 URL 不带 variant） */
  variant: ArtifactImageVariant | null;
  meta: ArtifactImageMeta;
}

/**
 * 解析本应用构造的产物图片协议 URL —— 全仓唯一真源。
 *
 * 三个消费方的口径必须一致，所以只能有一份实现：协议层决定投递哪份字节、
 * renderer 判定一个 src 能不能内联、markdown 图片引用解析回 artifact。
 *
 * `requireVariant` 区分两种语义：作为 `<img src>` 必须带 variant；
 * 作为"正文引用了哪个产物"的引用解析允许宿主 URL（无 variant）。
 */
export function parseArtifactImageUrl(
  value: string,
  options?: { requireVariant?: boolean },
): ParsedArtifactImageUrl | null {
  try {
    const url = new URL(value.trim());
    if (url.protocol !== "mybuddy-artifact:" || url.hostname !== "local" || url.hash) return null;
    const segments = url.pathname.split("/").filter(Boolean);
    // 只接受 single-segment：多段是 HTML 产物的子资源路径，不属于图片 URL
    if (segments.length !== 1) return null;
    for (const key of url.searchParams.keys()) {
      if (!ARTIFACT_IMAGE_PARAMS.has(key)) return null;
    }
    const variant = url.searchParams.get("variant");
    if (variant !== null && variant !== "thumb" && variant !== "full") return null;
    if (options?.requireVariant && variant === null) return null;
    const artifactId = decodeURIComponent(segments[0]!);
    const num = (key: string): number | undefined => {
      const raw = url.searchParams.get(key);
      if (raw === null) return undefined;
      const parsed = Number(raw);
      return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
    };
    return {
      artifactId,
      variant,
      meta: {
        mime: url.searchParams.get("mime") ?? undefined,
        bytes: num("bytes"),
        width: num("w"),
        height: num("h"),
        version: num("v"),
      },
    };
  } catch {
    return null;
  }
}

/** 只允许本应用构造的 single-segment 产物图片 URL，挡掉任意 file/网络协议注入 */
export function isArtifactImageUrl(value: string): boolean {
  return parseArtifactImageUrl(value, { requireVariant: true }) !== null;
}

export function artifactImageMeta(value: string): ArtifactImageMeta {
  return parseArtifactImageUrl(value, { requireVariant: true })?.meta ?? {};
}

/** artifact-domain:get 请求 */
export interface ArtifactDomainGetRequest {
  taskId: string;
  artifactId: string;
}

/** artifact-domain:list / snapshot / removeTask 请求 */
export interface ArtifactDomainTaskRequest {
  taskId: string;
}

/** artifact-domain:remove 请求 */
export interface ArtifactDomainRemoveRequest {
  artifactId: string;
}

/** artifact-domain:register 请求 = ArtifactRegistration（含 content/workspaceFile 二选一） */
export type ArtifactDomainRegisterRequest = import("./artifact-types").ArtifactRegistration;

/** artifact-domain:readContent 请求 */
export interface ArtifactDomainReadContentRequest {
  artifactId: string;
}

/** artifact-domain:readContent 响应 */
export interface ArtifactDomainReadContentResponse {
  content: string;
  language?: string;
  /** 原始 kind（docx/xlsx/pptx/image/pdf 等细分） */
  kind?: string;
  path?: string;
  /** 图像固有尺寸（文件头，不解码）：内联展示用它预留行高 */
  width?: number;
  height?: number;
  /**
   * 图像的内联缩略图（协议 URL + 尺寸元数据，不含 base64）。
   * 图像 content 是 ?variant=full 的协议 URL 而非原始字节；原图字节永远不经过 IPC。
   */
  thumbnail?: import("./agent-ipc").WorkspaceFileThumbnailDto;
  /** 原图文件大小（供面板显示） */
  bytes?: number;
}

/** artifact-domain:get 响应 */
export interface ArtifactDomainGetResponse {
  artifact: ArtifactDescriptor | null;
}

/** artifact-domain:list 响应 */
export interface ArtifactDomainListResponse {
  artifacts: ArtifactDescriptor[];
  state: ArtifactLoadState;
}

export type ArtifactDomainSnapshotResponse = ArtifactSnapshot;

/** 事件 payload（main → renderer，走 webContents.send） */
export type ArtifactDomainEvent =
  | { type: "created"; payload: ArtifactCreatedEvent }
  | { type: "updated"; payload: ArtifactUpdatedEvent }
  | { type: "removed"; payload: ArtifactRemovedEvent };
