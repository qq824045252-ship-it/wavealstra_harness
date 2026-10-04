import { useEffect, useMemo, useRef } from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import Markdown from "@/components/common/Markdown";
import { splitMarkdownSections } from "@/lib/markdownDoc";

interface Props {
  content: string;
}

/** 按级别渲染真实 hN 元素（id 供锚点跳转） */
function createHeading(level: number, slug: string, text: string): React.JSX.Element {
  const Tag = `h${Math.min(Math.max(level, 1), 6)}` as keyof React.JSX.IntrinsicElements;
  return (
    <Tag id={slug} className={`md-section-heading md-section-heading--h${level}`}>
      {text}
    </Tag>
  );
}

/** 未渲染章节的高度估算（按行数 × 行高 + 标题高度），渲染后由 measureElement 校正 */
function estimateSectionHeight(estLines: number): number {
  return Math.min(Math.max(estLines * 26 + 36, 96), 8000);
}

/**
 * Wave 5A — Markdown Artifact 文档视图（§84 long-document performance）
 *
 * 长文档虚拟化：按标题切块 → 视口内渲染、视口外占位（估算高度，渲染后实测校正）。
 * 相比旧 ProgressiveMarkdownDocument（rAF 逐步全渲染），DOM 规模与首帧成本
 * 与视口成正比，80KB/111KB 文档不再整体挂载。
 *
 * 能力：标题锚点（含跨章节跳转：先 scrollToIndex 再 scrollIntoView）、
 * GFM 表格/任务列表/引用/脚注、代码块复制、链接/图片策略（lib/markdownDoc）。
 */
export default function MarkdownArtifactView({ content }: Props): React.JSX.Element {
  const sections = useMemo(() => splitMarkdownSections(content), [content]);
  const parentRef = useRef<HTMLDivElement>(null);
  const slugToSection = useMemo(() => {
    const map = new Map<string, number>();
    for (const section of sections) {
      if (section.heading) map.set(section.heading.slug, section.index);
    }
    return map;
  }, [sections]);

  const virtualizer = useVirtualizer({
    count: sections.length,
    getScrollElement: () => parentRef.current,
    estimateSize: (index) => estimateSectionHeight(sections[index]?.estLines ?? 0),
    overscan: 4,
  });

  // 容器内锚点点击：已渲染 → 直接滚动；未渲染 → 先滚到章节再滚动到锚点
  useEffect(() => {
    const parent = parentRef.current;
    if (!parent) return;
    const onContainerClick = (event: MouseEvent): void => {
      const target = event.target as HTMLElement | null;
      const anchor = target?.closest?.('a[href^="#"]') as HTMLAnchorElement | null;
      if (!anchor) return;
      const slug = (anchor.getAttribute("href") ?? "").slice(1);
      if (!slug) return;
      event.preventDefault();
      const existing = document.getElementById(slug);
      if (existing) {
        existing.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      const sectionIndex = slugToSection.get(slug);
      if (sectionIndex === undefined) return;
      virtualizer.scrollToIndex(sectionIndex, { align: "start" });
      // 章节渲染后（约 1-2 帧）再精确滚动到锚点
      window.setTimeout(() => {
        document.getElementById(slug)?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 150);
    };
    parent.addEventListener("click", onContainerClick);
    return () => parent.removeEventListener("click", onContainerClick);
  }, [slugToSection, virtualizer]);

  const items = virtualizer.getVirtualItems();

  return (
    <div ref={parentRef} className="md-doc-viewer">
      <div
        className="md-doc-viewer-inner"
        style={{ height: virtualizer.getTotalSize(), position: "relative" }}
      >
        {items.map((item) => {
          const section = sections[item.index];
          if (!section) return null;
          return (
            <div
              key={section.index}
              ref={virtualizer.measureElement}
              data-index={item.index}
              className="md-section"
              style={{
                position: "absolute",
                top: 0,
                left: 0,
                width: "100%",
                transform: `translateY(${item.start}px)`,
              }}
            >
              {section.heading &&
                createHeading(section.heading.level, section.heading.slug, section.heading.text)}
              {section.content && (
                <Markdown variant="document" anchors imagePolicy>
                  {section.content}
                </Markdown>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
