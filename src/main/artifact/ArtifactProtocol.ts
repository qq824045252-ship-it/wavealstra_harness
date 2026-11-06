/**
 * ArtifactProtocol — V3.5 Wave 4B（§17/§101）
 *
 * mybuddy-artifact:// 协议层：URL parse / method 检查 / decode / 状态与 header 组装 /
 * register / unregister / urlFor。
 *
 * 职责边界：
 * - 只处理 HTTP/协议语义（Request → Response），不拼磁盘路径、不查 SQLite
 * - artifactId + subPath 的解码/剥离后交给 WebArtifactRuntime 解析
 * - 安全边界（traversal/root escape/symlink）在 Runtime，协议层只保证
 *   URL 语义正确 + 拒绝非法 method（405）
 *
 * 装配：main/index.ts 在 app ready 后调用 register()（scheme 特权注册在
 * registerSchemesAsPrivileged，早于 ready）。
 */
import { protocol } from "electron";

import { WebArtifactRuntime, type WebResourceResult } from "./WebArtifactRuntime";

/** 图片变体字节解析器（由 Artifact Domain 注入；字节只在这里出主进程） */
export type ArtifactImageVariantResolver = (
  artifactId: string,
  variant: "thumb" | "full",
) => Promise<{ data: Uint8Array; mimeType: string } | null>;

export class ArtifactProtocol {
  static readonly SCHEME = "mybuddy-artifact";
  /** 固定 ASCII host：Chromium 对非 ASCII host 做 IDN/punycode 转换，不能承载 id */
  static readonly HOST = "local";

  constructor(
    private readonly runtime: WebArtifactRuntime,
    private readonly imageVariant?: ArtifactImageVariantResolver,
  ) {}

  /** artifactId → 协议 URL（host 固定 ASCII，id encodeURIComponent 进 pathname 第一段） */
  static urlFor(artifactId: string): string {
    return `${ArtifactProtocol.SCHEME}://${ArtifactProtocol.HOST}/${encodeURIComponent(artifactId)}/`;
  }

  /** protocol.handle 处理器：Request → Response */
  async handle(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.hostname !== ArtifactProtocol.HOST) return this.text(404, "Not Found");
      if (request.method !== "GET" && request.method !== "HEAD") {
        return this.text(405, "Method Not Allowed");
      }
      const segments = url.pathname.replace(/^\//, "").split("/");
      const encodedId = segments[0] ?? "";
      if (!encodedId) return this.text(404, "Not Found");
      const artifactId = this.decode(encodedId);
      if (artifactId === null) return this.text(400, "Bad Request");
      // 图片内联链路（P0）：?variant=thumb/full 直接投递字节，renderer 不碰 base64。
      // thumb = 长边 1280 的降采样副本（主进程 LRU 缓存）；full = 原图，仅点击看原图时请求。
      const variant = url.searchParams.get("variant");
      if (variant === "thumb" || variant === "full") {
        if (!this.imageVariant) return this.text(404, "Not Found");
        const image = await this.imageVariant(artifactId, variant);
        if (!image) return this.text(404, "Not Found");
        const headers: Record<string, string> = {
          "content-type": image.mimeType,
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        };
        // Buffer（Uint8Array）在运行时是合法 BodyInit；仅 TS 泛型不兼容
        return new Response(request.method === "HEAD" ? null : (image.data as BodyInit), {
          status: 200,
          headers,
        });
      }
      let subPath = "";
      if (segments.length > 1) {
        const rest = segments.slice(1).join("/");
        const decoded = this.decode(rest);
        if (decoded === null) return this.text(400, "Bad Request");
        subPath = decoded;
      }
      const result = await this.runtime.resolve(artifactId, subPath);
      return this.fromResult(result, request.method === "HEAD");
    } catch {
      return this.text(500, "Internal Error");
    }
  }

  /** 注册协议处理器（app ready 后调用；scheme 特权已在 registerSchemesAsPrivileged） */
  register(): void {
    protocol.handle(ArtifactProtocol.SCHEME, (request) => this.handle(request));
  }

  /** 注销（应用退出 / 测试用）；重复调用安全 */
  unregister(): void {
    try {
      protocol.unhandle(ArtifactProtocol.SCHEME);
    } catch {
      /* 未注册过 */
    }
  }

  private decode(segment: string): string | null {
    try {
      return decodeURIComponent(segment);
    } catch {
      return null; // malformed percent-encoding
    }
  }

  private fromResult(result: WebResourceResult, head: boolean): Response {
    const headers: Record<string, string> = {
      "content-type": result.mimeType,
      "cache-control": result.cachePolicy,
      "x-content-type-options": "nosniff",
    };
    if (head) return new Response(null, { status: result.status, headers });
    // Buffer（Uint8Array<ArrayBufferLike>）在运行时是合法 BodyInit；仅 TS 泛型不兼容
    const body = result.body == null ? null : (result.body as BodyInit);
    return new Response(body, { status: result.status, headers });
  }

  private text(status: number, message: string): Response {
    return new Response(message, {
      status,
      headers: {
        "content-type": "text/plain; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  }
}
