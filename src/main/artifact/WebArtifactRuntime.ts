/**
 * WebArtifactRuntime — V3.5 Wave 4B（§17/§101）
 *
 * Artifact Web 运行时解析层：把 artifactId + 相对路径解析为 Web 资源。
 *
 * 职责边界：
 * - 输入：artifactId（由 ArtifactProtocol 从 URL 解码）+ subPath（相对资源路径）
 * - 输出：统一 WebResourceResult（status/body/mimeType/cachePolicy）
 * - 内部：ArtifactSourceResolver（唯一 Domain 访问入口，不直接查 SQLite）
 * - 区分 workspace-file（磁盘 entry + rootDir 内相对资源）与
 *   managed-content（storage 入口内容 + storage 目录内相对资源）
 *
 * 安全 contract（本模块核心职责）：
 *   请求只能解析到当前 Artifact 允许的 root 内（§17 enforce root boundary）。
 *   防御：../ 段逃逸、%2e%2e 编码绕过、绝对路径、盘符跳转、UNC path、
 *   query/hash 剥离、null byte、symlink/junction escape（realpath 双重校验）。
 *
 * PreviewHost / Protocol 都不拼磁盘路径；路径安全只在此处。
 */
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { join, sep } from "node:path";

/**
 * Artifact 来源解析器（装配处注入，基于 ArtifactService —— Runtime 唯一 Domain 入口）。
 * 原 ArtifactPreviewHost 内定义，4B 迁至此并扩展 rootOf。
 */
export interface ArtifactSourceResolver {
  /** workspace-file 的 entryFile 绝对路径；非 workspace-file / 未知 id → null */
  filePathOf(artifactId: string): string | null;
  /** 入口文档内容；managed-content → Domain storage 读取；workspace-file → null（走磁盘） */
  contentOf(artifactId: string): Promise<string | null>;
  /** 资源解析 root 边界：workspace-file → rootDir；managed-content → storage 目录；未知 → null */
  rootOf(artifactId: string): string | null;
}

export interface WebResourceResult {
  status: 200 | 403 | 404 | 500;
  /** 文本或二进制内容；错误态为 null */
  body: string | Uint8Array | null;
  mimeType: string;
  cachePolicy: "no-store";
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
};

export function mimeFor(file: string): string {
  const dot = file.lastIndexOf(".");
  if (dot < 0) return "application/octet-stream";
  return MIME[file.slice(dot).toLowerCase()] ?? "application/octet-stream";
}

/**
 * 把 subPath 安全解析到 root 内；任何逃逸 → null。
 *
 * 规则：
 * - 拒绝 null byte / 绝对路径 / 盘符 / UNC（先转反斜杠归一）
 * - ".." 段向上越界 → null（%2e%2e 已在 URL decode 后还原为 ".."）
 * - 解析结果必须位于 root 字符串边界内
 * - realpath 双重校验：防 symlink/junction 逃出 root（root 与目标都解析物理路径）
 */
export function resolveWithinRoot(root: string, subPath: string): string | null {
  if (subPath.includes("\0")) return null;
  const normalized = subPath.replace(/\\/g, "/");
  if (normalized.startsWith("/")) return null; // 绝对路径
  if (/^[a-zA-Z]:/.test(normalized)) return null; // 盘符跳转
  if (normalized.startsWith("//")) return null; // UNC path

  const out: string[] = [];
  for (const segment of normalized.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return null; // 越出 root
      out.pop();
      continue;
    }
    if (segment.includes("\0")) return null;
    out.push(segment);
  }
  if (out.length === 0) return root;

  const resolved = join(root, ...out);
  // 字符串边界（防 /root2/.. 前缀误判）
  if (resolved !== root && !resolved.startsWith(root + sep)) return null;

  // 物理边界：symlink / junction escape（Windows junction 无需特权即可创建）
  try {
    const realRoot = realpathSync(root);
    const realTarget = existsSync(resolved) ? realpathSync(resolved) : null;
    if (realTarget && realTarget !== realRoot && !realTarget.startsWith(realRoot + sep)) {
      return null;
    }
  } catch {
    return null;
  }
  return resolved;
}

export class WebArtifactRuntime {
  constructor(private readonly resolver: ArtifactSourceResolver) {}

  /**
   * 解析 Artifact 资源（subPath 为空 = 入口文档）。
   * 404：artifact/资源不存在；403：路径逃逸或边界外。
   */
  async resolve(artifactId: string, subPath: string): Promise<WebResourceResult> {
    const root = this.resolver.rootOf(artifactId);

    // 入口文档
    if (subPath === "") {
      const content = await this.resolver.contentOf(artifactId);
      if (content != null) {
        return {
          status: 200,
          body: content,
          mimeType: "text/html; charset=utf-8",
          cachePolicy: "no-store",
        };
      }
      const entryFile = this.resolver.filePathOf(artifactId);
      if (entryFile && root) {
        const result = this.readFile(entryFile, root);
        return result ?? notFound();
      }
      return notFound();
    }

    // 相对资源：必须落在 root 边界内
    if (!root) return notFound();
    const target = resolveWithinRoot(root, subPath);
    if (target === null) return forbidden();
    if (!existsSync(target) || !statSync(target).isFile()) return notFound();
    return this.readFile(target, root) ?? notFound();
  }

  /** 读文件并校验其在 root 物理边界内（entry 文件也受 root 约束）；文本按 UTF-8，二进制原样 */
  private readFile(file: string, root: string): WebResourceResult | null {
    try {
      const realRoot = realpathSync(root);
      const realFile = realpathSync(file);
      if (realFile !== realRoot && !realFile.startsWith(realRoot + sep)) return null;
      const mime = mimeFor(file);
      const body: string | Uint8Array = mime.includes("charset")
        ? readFileSync(file, "utf-8")
        : readFileSync(file);
      return { status: 200, body, mimeType: mime, cachePolicy: "no-store" };
    } catch {
      return null;
    }
  }
}

function notFound(): WebResourceResult {
  return { status: 404, body: null, mimeType: "text/plain; charset=utf-8", cachePolicy: "no-store" };
}

function forbidden(): WebResourceResult {
  return { status: 403, body: null, mimeType: "text/plain; charset=utf-8", cachePolicy: "no-store" };
}
