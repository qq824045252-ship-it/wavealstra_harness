/**
 * 聊天/预览链接判定（main + renderer 共用）：
 *   - 全部 http(s)（含 localhost / 127.0.0.1）→ 系统外部浏览器
 *   - 磁盘 HTML 产物 / file 路径 → 右侧产物预览（openArtifact，不经本模块）
 *   - OpenDesign daemon 裸根（7456–7466 的 `/`）→ 无 Web Studio；有 HTML 产物才右侧预览
 *
 * isLocalHttpHref / isRemoteHttpHref 仍用于 OpenDesign 端口识别等，不再驱动「本机进扩展栏」。
 */
import {
  OPENDESIGN_DEFAULT_PORT,
  OPENDESIGN_PORT_RETRY_COUNT,
} from "./professional-tools";

export function isHttpHref(href: string | undefined): boolean {
  return Boolean(href && /^https?:\/\//i.test(href));
}

/** 本机 loopback http(s)：localhost / 127.0.0.1 / ::1 / 0.0.0.0 */
export function isLocalHttpHref(href: string | undefined): boolean {
  if (!href || !isHttpHref(href)) return false;
  try {
    const host = new URL(href).hostname.toLowerCase();
    return (
      host === "localhost" ||
      host === "127.0.0.1" ||
      host === "0.0.0.0" ||
      host === "::1" ||
      host === "[::1]"
    );
  } catch {
    return false;
  }
}

/** 公网/外网 http(s)（非 loopback）→ 系统浏览器。 */
export function isRemoteHttpHref(href: string | undefined): boolean {
  return isHttpHref(href) && !isLocalHttpHref(href);
}

/**
 * OpenDesign headless daemon 裸根地址（无路径或仅 `/`）。
 * headless 未挂 Web UI，`GET /` 恒为 Cannot GET /；真预览应是
 * `/api/projects/<id>/raw/<file.html>`（工具返回的 previewUrl）。
 */
export function isBareOpenDesignDaemonUrl(href: string | undefined): boolean {
  if (!href || !isLocalHttpHref(href)) return false;
  try {
    const u = new URL(href);
    const port = Number(u.port || (u.protocol === "https:" ? "443" : "80"));
    const max = OPENDESIGN_DEFAULT_PORT + OPENDESIGN_PORT_RETRY_COUNT;
    if (port < OPENDESIGN_DEFAULT_PORT || port > max) return false;
    const path = u.pathname || "/";
    return path === "/" || path === "";
  } catch {
    return false;
  }
}

/**
 * OpenDesign 可渲染的设计稿预览 URL（raw / powered 文件端点）。
 * 例：http://127.0.0.1:7456/api/projects/project-a9a4/raw/blackboard_welcome.html
 */
export function isOpenDesignPreviewFileUrl(href: string | undefined): boolean {
  if (!href || !isLocalHttpHref(href)) return false;
  try {
    const u = new URL(href);
    const port = Number(u.port || (u.protocol === "https:" ? "443" : "80"));
    const max = OPENDESIGN_DEFAULT_PORT + OPENDESIGN_PORT_RETRY_COUNT;
    if (port < OPENDESIGN_DEFAULT_PORT || port > max) return false;
    return /^\/api\/projects\/[^/]+\/(raw|powered)(\/|$)/i.test(u.pathname);
  } catch {
    return false;
  }
}
