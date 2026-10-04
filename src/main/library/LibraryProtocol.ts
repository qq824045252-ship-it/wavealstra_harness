/**
 * mybuddy-library:// 协议：资料库 HTML / CSV / 静态资源预览。
 *
 * URL：mybuddy-library://local/<itemId>/[filename]
 * - 无 subPath：条目自身
 * - filename：同空间按文件名解析（HTML 相对引用 CSV）
 */
import { protocol } from "electron";
import { existsSync, readFileSync, statSync } from "node:fs";
import type { LibraryService } from "./LibraryService";

export class LibraryProtocol {
  static readonly SCHEME = "mybuddy-library";
  static readonly HOST = "local";

  constructor(private readonly service: LibraryService) {}

  static urlFor(itemId: string): string {
    return `${LibraryProtocol.SCHEME}://${LibraryProtocol.HOST}/${encodeURIComponent(itemId)}/`;
  }

  async handle(request: Request): Promise<Response> {
    try {
      const url = new URL(request.url);
      if (url.hostname !== LibraryProtocol.HOST) return this.text(404, "Not Found");
      if (request.method !== "GET" && request.method !== "HEAD") {
        return this.text(405, "Method Not Allowed");
      }
      const segments = url.pathname.replace(/^\//, "").split("/");
      const encodedId = segments[0] ?? "";
      if (!encodedId) return this.text(404, "Not Found");
      const itemId = this.decode(encodedId);
      if (itemId === null) return this.text(400, "Bad Request");
      let subPath = "";
      if (segments.length > 1) {
        const rest = segments.slice(1).filter(Boolean).join("/");
        if (rest) {
          const decoded = this.decode(rest);
          if (decoded === null) return this.text(400, "Bad Request");
          subPath = decoded;
        }
      }
      const resolved = this.service.resolvePreview(itemId, subPath);
      if (!resolved || !existsSync(resolved.path)) return this.text(404, "Not Found");
      const st = statSync(resolved.path);
      if (!st.isFile()) return this.text(404, "Not Found");
      const body = readFileSync(resolved.path);
      if (request.method === "HEAD") {
        return new Response(null, {
          status: 200,
          headers: this.headers(resolved.mime, body.byteLength),
        });
      }
      let payload: Uint8Array = body;
      let mime = resolved.mime;
      if (!subPath && mime.includes("html")) {
        payload = new TextEncoder().encode(injectBase(body.toString("utf8"), itemId));
        mime = "text/html; charset=utf-8";
      }
      return new Response(payload as BodyInit, {
        status: 200,
        headers: this.headers(mime, payload.byteLength),
      });
    } catch {
      return this.text(500, "Internal Error");
    }
  }

  register(): void {
    protocol.handle(LibraryProtocol.SCHEME, (request) => this.handle(request));
  }

  unregister(): void {
    try {
      protocol.unhandle(LibraryProtocol.SCHEME);
    } catch {
      /* 未注册 */
    }
  }

  private decode(segment: string): string | null {
    try {
      return decodeURIComponent(segment);
    } catch {
      return null;
    }
  }

  private headers(mime: string, length: number): HeadersInit {
    return {
      "Content-Type": mime,
      "Content-Length": String(length),
      "Cache-Control": "no-store",
    };
  }

  private text(status: number, message: string): Response {
    return new Response(message, {
      status,
      headers: { "Content-Type": "text/plain; charset=utf-8" },
    });
  }
}

function injectBase(html: string, itemId: string): string {
  if (/<base\s/i.test(html)) return html;
  const href = `${LibraryProtocol.SCHEME}://${LibraryProtocol.HOST}/${encodeURIComponent(itemId)}/`;
  const tag = `<base href="${href}">`;
  if (/<head[^>]*>/i.test(html)) return html.replace(/<head[^>]*>/i, (m) => `${m}\n${tag}`);
  return `${tag}\n${html}`;
}
