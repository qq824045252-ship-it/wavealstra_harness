// UI port of Canban review/diff.rs and review/context.rs (390c057).
// Copyright 2026 JJy <jjyruby@gmail.com>. Licensed under Apache-2.0.
import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { IconChevronDown, IconChevronUp, IconConversation } from "@/components/common/icons";
import { getCanbanReviewEngine } from "../../../../../../vendor/canban-review/engine";
import { InlineComposer, PendingCommentCard, type ActiveLine, type LineTarget, type PendingInlineComment } from "./ReviewDraft";

type Engine = Awaited<ReturnType<typeof getCanbanReviewEngine>>;
type Parsed = Awaited<ReturnType<Engine["parse"]>>;
type Hunk = Parsed["hunks"][number];
type DiffLine = Hunk["lines"][number];
type Expansion = Parameters<Engine["expandGap"]>[2];
type Direction = Parameters<Engine["expandGap"]>[3];
type GapKind = Parameters<Engine["expandGap"]>[0];

interface Gap {
  index: number;
  kind: GapKind;
  previous?: Hunk;
  next?: Hunk;
  total: number | null;
}

interface RenderedHunk {
  hunk: Hunk;
  gap: Gap;
  expansion: Expansion;
}

interface ViewportAnchor {
  selector: string;
  y: number;
  viewport: HTMLElement;
}

const NO_EXPANSION: Expansion = { fromTop: 0, fromBottom: 0 };
const lineKey = ({ line, side }: LineTarget): string => side + ":" + line;

interface Props {
  fileId: string;
  path: string;
  section: string;
  kind: string;
  patch: string;
  loadContext?: () => Promise<string[] | null>;
  active?: ActiveLine;
  comments: PendingInlineComment[];
  onSelect: (target: LineTarget) => void;
  onEdit: (comment: PendingInlineComment) => void;
  onChangeActiveBody: (body: string) => void;
  onCancel: () => void;
  onSave: (comment: PendingInlineComment) => void;
  onDiscard: (comment: PendingInlineComment) => void;
}

export default function CodeReviewDiff({
  fileId, path, section, kind, patch, loadContext, active, comments,
  onSelect, onEdit, onChangeActiveBody, onCancel, onSave, onDiscard,
}: Props): React.JSX.Element {
  const [prepared, setPrepared] = useState<{ engine: Engine; diff: Parsed }>();
  const [error, setError] = useState("");
  const [showPatch, setShowPatch] = useState(false);
  const [expansions, setExpansions] = useState<ReadonlyMap<number, Expansion>>(new Map());
  const [headers, setHeaders] = useState<ReadonlyMap<number, string>>(new Map());
  const [fileLines, setFileLines] = useState<string[]>();
  const [contextLoading, setContextLoading] = useState(false);
  const [contextError, setContextError] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const anchor = useRef<ViewportAnchor>(null);
  const mounted = useRef(false);
  const loading = useRef(false);

  useEffect(() => {
    mounted.current = true;
    let current = true;
    void getCanbanReviewEngine().then(async (engine) => {
      const diff = await engine.parse(patch, path);
      if (current) setPrepared({ engine, diff });
    }).catch((cause: unknown) => {
      if (current) setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { current = false; mounted.current = false; };
  }, [patch, path]);

  useLayoutEffect(() => {
    const location = anchor.current;
    anchor.current = null;
    if (!location) return;
    const element = root.current?.querySelector(location.selector);
    if (!element) return;
    const { viewport } = location;
    const targetScroll = viewport.scrollTop + element.getBoundingClientRect().top - location.y;
    const extra = targetScroll - (viewport.scrollHeight - viewport.clientHeight);
    if (extra > 0.5) {
      const previous = Number.parseFloat(viewport.style.getPropertyValue("--review-anchor-padding")) || 0;
      viewport.style.setProperty("--review-anchor-padding", `${previous + extra}px`);
    }
    viewport.scrollTop = targetScroll;
  }, [expansions]);

  const pendingByLine = useMemo(() => {
    const groups = new Map<string, PendingInlineComment[]>();
    for (const comment of comments) {
      const key = lineKey(comment);
      const items = groups.get(key);
      if (items) items.push(comment);
      else groups.set(key, [comment]);
    }
    return groups;
  }, [comments]);

  if (error) return <p className="code-review-message" role="alert">无法读取 Canban 差异。{error}</p>;
  if (!prepared) return <p className="code-review-message" role="status">正在读取差异…</p>;

  const { engine, diff } = prepared;
  const { hunks, autoFoldReason } = diff;
  if (!hunks.length) return <p className="code-review-message">没有可显示的文本差异。</p>;
  if (autoFoldReason != null && !showPatch && !active) {
    return <div className="code-review-fold-summary">
      <span>{autoFoldReason === "generated" ? "生成文件或锁文件" : `大型差异（${autoFoldReason} 行）`}</span>
      <button type="button" className="code-review-button" onClick={() => setShowPatch(true)}>展开差异</button>
    </div>;
  }

  const canExpand = Boolean(loadContext && kind !== "added" && kind !== "deleted");
  const lastHunk = hunks[hunks.length - 1];
  const trailing: Gap = {
    index: hunks.length, kind: "trailing", previous: lastHunk,
    total: fileLines ? Math.max(0, fileLines.length + 1 - lastHunk.exitNew) : null,
  };
  const renderedHunks: RenderedHunk[] = hunks.map((hunk, index) => {
    const previous = hunks[index - 1];
    const gap: Gap = {
      index, kind: previous ? "between" : "leading", previous, next: hunk,
      total: Math.max(0, hunk.entryNew - (previous?.exitNew ?? 1)),
    };
    return { hunk, gap, expansion: expansions.get(index) ?? NO_EXPANSION };
  });

  async function expand(gap: Gap, direction: Direction): Promise<void> {
    if (!loadContext || loading.current) return;
    loading.current = true;
    setContextLoading(true);
    setContextError("");
    try {
      const lines = fileLines ?? await loadContext();
      if (!mounted.current) return;
      if (!lines) throw new Error("当前版本的上下文不可用。");
      const total = gap.total ?? Math.max(0, lines.length + 1 - lastHunk.exitNew);
      const expansion = await engine.expandGap(gap.kind, total, expansions.get(gap.index) ?? NO_EXPANSION, direction);
      const header = gap.next && expansion.fromBottom > 0
        ? await engine.formatHunkHeader(gap.next, expansion.fromBottom) : undefined;
      if (!mounted.current) return;

      const viewport = root.current?.closest<HTMLElement>(".code-review-diff-scroll");
      const aboveSelector = `[data-hunk-end="${gap.index - 1}"]`;
      const belowSelector = `[data-hunk-start="${gap.index}"]`;
      const above = root.current?.querySelector(aboveSelector);
      const below = root.current?.querySelector(belowSelector);
      const useBelow = Boolean(below && (direction === "up" || !above ||
        direction === "all" && viewport && above.getBoundingClientRect().top < viewport.getBoundingClientRect().top));
      const element = useBelow ? below : above;
      if (viewport && element) {
        anchor.current = { viewport, selector: useBelow ? belowSelector : aboveSelector, y: element.getBoundingClientRect().top };
      }
      setFileLines(lines);
      if (header) setHeaders((current) => new Map(current).set(gap.index, header));
      setExpansions((current) => new Map(current).set(gap.index, expansion));
    } catch (cause) {
      if (mounted.current) setContextError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      loading.current = false;
      if (mounted.current) setContextLoading(false);
    }
  }

  let activeRendered = false;
  const renderedComments = new Set<string>();

  function renderLine(line: DiffLine, key: string, markers: Record<string, number> = {}): React.JSX.Element {
    if (line.kind === "\\") return <div key={key} className="code-review-hunk">{line.text}</div>;
    const side = line.kind === "-" ? "LEFT" : "RIGHT";
    const target: LineTarget = { fileId, path, section, line: (side === "LEFT" ? line.oldLine : line.newLine ?? line.oldLine) ?? 1, side, snippet: line.text };
    const identity = lineKey(target);
    const label = `批注${side === "LEFT" ? "原" : "新"}第 ${target.line} 行`;
    const isActive = !activeRendered && active && lineKey(active.target) === identity;
    if (isActive) activeRendered = true;
    const lineComments = (pendingByLine.get(identity) ?? []).filter((comment) => !renderedComments.has(comment.id));
    for (const comment of lineComments) renderedComments.add(comment.id);
    const tone = line.kind === "+" ? "is-added" : line.kind === "-" ? "is-deleted" : "";
    return <Fragment key={key}>
      <div className={`code-review-line ${tone}${isActive ? " is-active" : ""}`}
        data-old-line={line.oldLine ?? ""} data-new-line={line.newLine ?? ""} {...markers}
        onClick={() => {
          if (window.getSelection()?.isCollapsed !== false) onSelect(target);
        }}>
        <span className="code-review-line-number" aria-hidden="true">{line.oldLine}</span>
        <span className="code-review-line-number" aria-hidden="true">{line.newLine}</span>
        <button type="button" className="code-review-line-note" aria-label={label} title={label}
          onClick={(event) => { event.stopPropagation(); onSelect(target); }}><IconConversation size={14} /></button>
        <span className="code-review-line-marker" aria-hidden="true">{line.kind}</span>
        <code>{line.text}</code>
      </div>
      {lineComments.map((comment) => <PendingCommentCard key={comment.id} comment={comment}
        onEdit={() => onEdit(comment)} onDiscard={() => onDiscard(comment)} />)}
      {isActive && <InlineComposer key={active.comment?.id ?? identity} active={active}
        onChange={onChangeActiveBody} onCancel={onCancel} onSave={onSave} />}
    </Fragment>;
  }

  function contextRows(oldStart: number, newStart: number, count: number): React.JSX.Element[] {
    if (!fileLines) return [];
    return Array.from({ length: count }, (_, offset) => {
      const oldLine = oldStart + offset;
      const newLine = newStart + offset;
      return renderLine({ kind: " ", oldLine, newLine, text: fileLines[newLine - 1] ?? "" }, `context-${newLine}`);
    });
  }

  function renderGap(gap: Gap, { fromTop, fromBottom }: Expansion): React.JSX.Element | null {
    const remaining = gap.total === null ? null : Math.max(0, gap.total - fromTop - fromBottom);
    const header = headers.get(gap.index) ?? gap.next?.header ?? "";
    const hasContext = canExpand && remaining !== 0;
    if (!hasContext && !header) return null;
    const step = remaining === null ? engine.contextStep : Math.min(engine.contextStep, remaining);
    const split = gap.kind === "between" && (remaining ?? 0) > engine.contextStep;
    const direction = gap.kind === "leading" ? "up" : gap.kind === "trailing" ? "down" : "all";
    const expandButton = (way: Direction, count: number): React.JSX.Element => {
      const label = way === "all" ? `展开其余 ${count} 行` : `向${way === "up" ? "上" : "下"}展开 ${count} 行`;
      return <button type="button" className="code-review-fold-button" aria-label={label} title={label}
        disabled={contextLoading} onClick={() => void expand(gap, way)}>
        {way === "up" ? <IconChevronUp size={14} /> : <IconChevronDown size={14} />}{label}
      </button>;
    };

    return <div className="code-review-hunk">
      {header && <code>{header}</code>}
      {hasContext && <div className="code-review-gap">
        {split ? <>{expandButton("down", step)}{expandButton("up", step)}</> : expandButton(direction, step)}
        {remaining !== null && remaining > step && <span>隐藏 {remaining} 行</span>}
      </div>}
    </div>;
  }

  const body = renderedHunks.map(({ hunk, gap, expansion }) => {
    const { fromTop, fromBottom } = expansion;
    const lastContent = hunk.lines.length - (hunk.endsWithNoNewline ? 2 : 1);
    return <Fragment key={gap.index}>
      {gap.previous && contextRows(gap.previous.exitOld, gap.previous.exitNew, fromTop)}
      {renderGap(gap, expansion)}
      {contextRows(hunk.entryOld - fromBottom, hunk.entryNew - fromBottom, fromBottom)}
      {hunk.lines.map((line, index) => {
        const markers: Record<string, number> = {};
        if (index === 0) markers["data-hunk-start"] = gap.index;
        if (index === lastContent) markers["data-hunk-end"] = gap.index;
        return renderLine(line, `hunk-${gap.index}-${index}`, markers);
      })}
    </Fragment>;
  });
  const tailExpansion = expansions.get(trailing.index) ?? NO_EXPANSION;
  const tailRows = contextRows(lastHunk.exitOld, lastHunk.exitNew, tailExpansion.fromTop);
  const unattachedComments = comments.filter((comment) => !renderedComments.has(comment.id));

  return <div className="code-review-diff" ref={root} role="region" aria-label={`${path} 的代码差异`} aria-busy={contextLoading}>
    {contextError && <p className="code-review-feedback is-error" role="alert">{contextError}</p>}
    {unattachedComments.map((comment) => <PendingCommentCard key={comment.id} comment={comment}
      onEdit={() => onEdit(comment)} onDiscard={() => onDiscard(comment)} />)}
    {active && !activeRendered && <InlineComposer key={active.comment?.id ?? lineKey(active.target)} active={active}
      onChange={onChangeActiveBody} onCancel={onCancel} onSave={onSave} />}
    {body}{tailRows}{!lastHunk.endsWithNoNewline && renderGap(trailing, tailExpansion)}
  </div>;
}
