// UI port of Canban review/diff.rs file cards (390c057).
// Copyright 2026 JJy <jjyruby@gmail.com>. Licensed under Apache-2.0.
import { lazy, Suspense, useEffect, useRef, useState } from "react";
import type { CodeReviewDetail, CodeReviewFile, CodeReviewGitFile } from "@shared/code-review";
import { IconChevronDown, IconChevronRight } from "@/components/common/icons";
import type { ActiveLine, LineTarget, PendingInlineComment } from "./ReviewDraft";
import { ReviewDecisionButton, ReviewDecisionStatus } from "./ReviewDecision";

const CodeReviewDiff = lazy(() => import("./CodeReviewDiff"));

export const reviewKindLabel: Record<CodeReviewFile["kind"], string> = {
  added: "新增", modified: "修改", deleted: "删除", renamed: "重命名",
};

export const reviewStatusLabel: Record<CodeReviewFile["status"], string> = {
  pending: "待审查", accepted: "已接受", rejected: "已拒绝",
};

export const gitSectionLabel: Record<CodeReviewGitFile["section"], string> = {
  staged: "已暂存", unstaged: "未暂存", compare: "引用比较",
};

export function isGitFile(file: CodeReviewFile): file is CodeReviewGitFile {
  return "section" in file;
}

export function reviewFileKey(file: CodeReviewFile): string {
  return isGitFile(file) ? `${file.section}\0${file.path}` : file.path;
}

export function ReviewFileStats({ additions, deletions, statsAvailable }: Pick<CodeReviewFile, "additions" | "deletions" | "statsAvailable">): React.JSX.Element | null {
  if (statsAvailable === false || (!additions && !deletions)) return null;
  return <span className="code-review-stats" aria-label={`新增 ${additions} 行，删除 ${deletions} 行`}>
    {additions > 0 && <span className="code-review-added">+{additions}</span>}
    {deletions > 0 && <span className="code-review-deleted">−{deletions}</span>}
  </span>;
}

interface Props {
  taskId: string;
  file: CodeReviewFile;
  collapsed: boolean;
  decisionsDisabled: boolean;
  active?: ActiveLine;
  comments: PendingInlineComment[];
  setFileNode: (id: string, node: HTMLElement | null) => void;
  onToggle: () => void;
  onAccept: () => void;
  onReject: () => void;
  onSelect: (target: LineTarget) => void;
  onEdit: (comment: PendingInlineComment) => void;
  onChangeActiveBody: (body: string) => void;
  onCancel: () => void;
  onSave: (comment: PendingInlineComment) => void;
  onDiscard: (comment: PendingInlineComment) => void;
}

export default function ReviewFileDetails({
  taskId, file, collapsed, decisionsDisabled, active, comments, setFileNode, onToggle,
  onAccept, onReject, onSelect, onEdit, onChangeActiveBody, onCancel, onSave, onDiscard,
}: Props): React.JSX.Element {
  const [detail, setDetail] = useState<CodeReviewDetail | null>();
  const [detailError, setDetailError] = useState("");
  const [retry, setRetry] = useState(0);
  const descriptor = useRef(file);
  descriptor.current = file;

  useEffect(() => {
    if (collapsed || detail !== undefined) return;
    const api = window.api?.codeReview;
    if (!api) return;
    const requested = descriptor.current;
    let current = true;
    setDetailError("");
    const read = isGitFile(requested) ? api.gitDetail(taskId, requested) : api.detail(taskId, requested.id);
    void read.then((result) => {
      if (current) setDetail(result);
    }, (cause: unknown) => {
      if (current) setDetailError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => { current = false; };
  }, [taskId, file.id, retry, collapsed, detail]);

  const git = isGitFile(file) ? file : undefined;
  const reason = file.reason ?? detail?.reason;
  const sourceLabel = git ? (git.untracked ? "未跟踪" : gitSectionLabel[git.section]) : "";
  const path = git?.oldPath && git.oldPath !== file.path ? `${git.oldPath} → ${file.path}` : file.path;

  async function readContext(): Promise<string[] | null> {
    const content = detail?.after;
    if (content == null) return null;
    if (content === "") return [];
    const lines = content.split(/\r?\n/);
    if (content.endsWith("\n")) lines.pop();
    return lines;
  }

  return <section className="code-review-detail" ref={(element) => setFileNode(reviewFileKey(file), element)}
    aria-label={`${file.path} 的文件差异`} data-review-file={file.path} data-review-section={git?.section}>
    <header className="code-review-file-header">
      <button type="button" className="code-review-icon" aria-expanded={!collapsed}
        aria-label={`${collapsed ? "展开" : "折叠"} ${file.path}`} onClick={onToggle}>
        {collapsed ? <IconChevronRight size={15} /> : <IconChevronDown size={15} />}
      </button>
      <div className="code-review-file-title">
        <h3 title={path}>{path}</h3>
        <div className="code-review-file-meta">
          <span>{reviewKindLabel[file.kind]}{sourceLabel && ` · ${sourceLabel}`}</span>
          {!git && file.status !== "pending" && <ReviewDecisionStatus status={file.status} />}
          <ReviewFileStats {...(detail ?? file)} />
          {comments.length > 0 && <span>{comments.length} 条批注</span>}
        </div>
      </div>
      {!git && file.status === "pending" && <div className="code-review-decision-actions">
        <ReviewDecisionButton action="accept" label={`接受 ${file.path}`} disabled={decisionsDisabled} onClick={onAccept} />
        <ReviewDecisionButton action="reject" label={`拒绝 ${file.path}`} disabled={decisionsDisabled || !file.canReject}
          title={!file.canReject ? `拒绝 ${file.path} · ${reason ?? "此变更无法安全撤销"}` : undefined} onClick={onReject} />
      </div>}
    </header>
    {!collapsed && <>
      {reason && <p className="code-review-file-reason">{reason}</p>}
      {detailError ? <div className="code-review-message" role="alert">
        <p>读取差异失败。{detailError}</p>
        <button className="code-review-button" type="button" onClick={() => setRetry((n) => n + 1)}>重试</button>
      </div> : detail === undefined ? <p className="code-review-message" role="status">正在读取文件差异…</p>
        : detail === null ? <p className="code-review-message">此版本已更新，请刷新文件列表。</p>
          : !detail.patch ? <p className="code-review-message">没有可显示的文本差异。</p>
            : <Suspense fallback={<p className="code-review-message" role="status">正在加载差异视图…</p>}>
              <CodeReviewDiff fileId={file.id} path={file.path} kind={file.kind}
                section={git ? sourceLabel : ""} patch={detail.patch} loadContext={detail.after == null ? undefined : readContext}
                active={active} comments={comments} onSelect={onSelect} onEdit={onEdit} onChangeActiveBody={onChangeActiveBody} onCancel={onCancel}
                onSave={onSave} onDiscard={onDiscard} />
            </Suspense>}
    </>}
  </section>;
}
