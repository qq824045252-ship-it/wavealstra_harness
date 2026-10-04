/**
 * Wave 5A — Markdown 文档视图纯逻辑（§84 long-document performance）
 *
 * 职责：
 *   - splitMarkdownSections：fence 安全的标题分块（虚拟化的切片单位）
 *   - slugifyHeading：GFM 风格锚点 slug（中文安全、重复去重）
 *   - 链接/图片策略分类器（纯函数）
 *
 * 无 DOM 依赖，可在 node 中直接单测。
 */

export interface DocSection {
  /** 全局序号（虚拟列表 key） */
  index: number;
  /** 章节正文（不含自身标题行） */
  content: string;
  /** 首个标题（可能无） */
  heading: { level: number; text: string; slug: string } | null;
  /** 估算行数（高度估算用） */
  estLines: number;
}

/** 无标题文档的分块目标行数（避免整篇一个巨型 section） */
const FALLBACK_SECTION_LINES = 600;

const ATX_HEADING_RE = /^(#{1,6})\s+(.+?)\s*#*\s*$/;
const FENCE_RE = /^\s*(```|~~~)/;

/**
 * 按 ATX 标题切分文档；fence 内的 `#` 不切；无标题文档按行数兜底切块。
 * 保持每个 section 语义完整（不打断代码块/表格）。
 */
export function splitMarkdownSections(content: string): DocSection[] {
  if (!content || content.trim() === "") return [];
  const raw = content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  const lines = raw.split("\n");
  const sections: DocSection[] = [];

  let current: string[] = [];
  let currentHeading: DocSection["heading"] = null;
  let inFence = false;
  let fenceMarker: string | null = null;
  let estLines = 0;

  const seenSlugs = new Map<string, number>();

  const slugify = (text: string): string => uniqueSlug(slugifyHeading(text), seenSlugs);

  const flush = (): void => {
    // 去掉尾部空行
    while (current.length > 0 && current[current.length - 1].trim() === "") current.pop();
    if (current.length === 0 && !currentHeading) return;
    sections.push({
      index: sections.length,
      content: current.join("\n"),
      heading: currentHeading,
      estLines: Math.max(current.length, currentHeading ? 1 : 0),
    });
    current = [];
    currentHeading = null;
    estLines = 0;
  };

  for (const line of lines) {
    const isFence = FENCE_RE.test(line);
    if (isFence && !inFence) {
      inFence = true;
      fenceMarker = line.trim().slice(0, 3);
      current.push(line);
      estLines += 1;
      continue;
    }
    if (inFence && isFence) {
      const marker = line.trim().slice(0, 3);
      if (marker === fenceMarker) inFence = false;
      current.push(line);
      estLines += 1;
      continue;
    }
    if (inFence) {
      current.push(line);
      estLines += 1;
      continue;
    }
    const m = ATX_HEADING_RE.exec(line.trimEnd());
    if (m) {
      if (currentHeading === null && current.length === 0) {
        // 文档开头标题：作为第一个 section 的 heading
        currentHeading = { level: m[1].length, text: m[2].trim(), slug: slugify(m[2].trim()) };
        continue;
      }
      // 新标题 → flush 上一个 section
      flush();
      currentHeading = { level: m[1].length, text: m[2].trim(), slug: slugify(m[2].trim()) };
      continue;
    }
    current.push(line);
    estLines += 1;

    // 无标题兜底：超长无标题区按行数切块
    if (currentHeading === null && estLines >= FALLBACK_SECTION_LINES && current.length > 0) {
      flush();
    }
  }
  flush();
  return sections;
}

/** GFM 风格 slug：小写、去标点、空白→`-`；中文/Unicode 保留 */
export function slugifyHeading(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** 重复 slug 追加 -1/-2（GitHub 风格） */
export function uniqueSlug(slug: string, seen: Map<string, number>): string {
  const count = seen.get(slug) ?? 0;
  seen.set(slug, count + 1);
  if (count === 0) return slug;
  return `${slug}-${count}`;
}

// ---------- 链接 / 图片策略（§84 link/image policy） ----------

export type ImagePolicy = "render" | "placeholder";

/**
 * 图片 src 分类：
 *   - data: / blob:        → render（自包含内容，CSP img-src data: blob: 放行）
 *   - http(s):             → render（由应用 CSP img-src 'self' data: blob: 决定是否显示）
 *   - 其余（相对路径等）    → placeholder（Markdown 文本无资源根，无法解析）
 */
export function classifyImageSrc(src: string): ImagePolicy {
  const s = src.trim().toLowerCase();
  if (s.startsWith("data:") || s.startsWith("blob:")) return "render";
  if (s.startsWith("http://") || s.startsWith("https://")) return "render";
  return "placeholder";
}

/**
 * 链接 href 分类：
 *   - #anchor        → 文档内锚点（组件内滚动处理）
 *   - 全部 http(s)   → 系统外部浏览器（含 localhost / 127.0.0.1）
 *   - 文件类         → 产物跳转（沿用 MdFileLink；磁盘 .html 走右侧预览）
 *   - OD daemon 裸根 → 有 HTML 产物则右侧预览，否则系统浏览器
 *
 * loopback / OD 判定与 main 共用 `shared/link-policy`。
 */
export {
  isLocalHttpHref,
  isRemoteHttpHref,
  isBareOpenDesignDaemonUrl,
  isOpenDesignPreviewFileUrl,
} from "../../../shared/link-policy";

export function isAnchorHref(href: string | undefined): boolean {
  return Boolean(href && href.startsWith("#"));
}

export function isExternalHref(href: string | undefined): boolean {
  return Boolean(href && /^https?:\/\//i.test(href));
}
