// UI port of Canban review/model.rs, review/diff.rs and review/submit.rs (390c057).
// Copyright 2026 JJy <jjyruby@gmail.com>. Licensed under Apache-2.0.
import { useId, useState } from "react";
import { IconConversation, IconCopy, IconX } from "@/components/common/icons";
import { getCanbanReviewEngine } from "../../../../../../vendor/canban-review/engine";

export interface LineTarget {
  fileId: string;
  path: string;
  section: string;
  line: number;
  side: "LEFT" | "RIGHT";
  snippet: string;
}

export interface PendingInlineComment extends LineTarget {
  id: string;
  body: string;
}

export interface ReviewDraft {
  summary: string;
  comments: PendingInlineComment[];
}

export interface ActiveLine {
  target: LineTarget;
  comment?: PendingInlineComment;
  body: string;
}

export function lineLabel({ path, side, line }: LineTarget): string {
  return `${path} · ${side === "LEFT" ? "原" : "新"}第 ${line} 行`;
}

export function InlineComposer({ active, outdated = false, onChange, onCancel, onSave }: {
  active: ActiveLine;
  outdated?: boolean;
  onChange: (body: string) => void;
  onCancel: () => void;
  onSave: (comment: PendingInlineComment) => void;
}): React.JSX.Element {
  const { body } = active;
  const inputId = useId();
  return <form className="code-review-note" onSubmit={(event) => {
    event.preventDefault();
    if (!body.trim()) return;
    onSave({ ...active.target, id: active.comment?.id ?? crypto.randomUUID(), body: body.trim() });
  }}>
    <label htmlFor={inputId}>{lineLabel(active.target)}</label>
    {outdated && <span>来自较早的文件版本</span>}
    <textarea autoFocus id={inputId} aria-label="行内审查意见" value={body} rows={3} maxLength={4000}
      onChange={(event) => onChange(event.target.value)} />
    <div className="code-review-actions">
      <button type="button" className="code-review-button" onClick={onCancel}>取消</button>
      <button type="submit" className="code-review-button code-review-primary" disabled={!body.trim()}>保存到审查</button>
    </div>
  </form>;
}

export function PendingCommentCard({ comment, outdated = false, onEdit, onDiscard }: {
  comment: PendingInlineComment;
  outdated?: boolean;
  onEdit: () => void;
  onDiscard: () => void;
}): React.JSX.Element {
  return <article className="code-review-comment">
    <header>
      <strong>{lineLabel(comment)}</strong>
      {outdated && <span>来自较早的文件版本</span>}
      <span className="code-review-actions">
        <button type="button" className="code-review-button" onClick={onEdit}>编辑</button>
        <button type="button" className="code-review-icon" aria-label={`删除批注 ${lineLabel(comment)}`} onClick={onDiscard}><IconX size={14} /></button>
      </span>
    </header>
    <p>{comment.body}</p>
  </article>;
}

export function ReviewDraftFooter({ draft, context, fileIds, onChange, onEdit, onSubmit, onDelivered, storageError }: {
  draft: ReviewDraft;
  context: string;
  fileIds: ReadonlySet<string>;
  onChange: (draft: ReviewDraft) => void;
  onEdit: (comment: PendingInlineComment) => void;
  onSubmit: (markdown: string, send: boolean) => Promise<void>;
  onDelivered: (draft: ReviewDraft) => void;
  storageError: boolean;
}): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState("");
  const count = draft.comments.length;
  const canSubmit = Boolean(count || draft.summary.trim());

  async function submit(mode: "copy" | "input" | "send"): Promise<void> {
    setBusy(true);
    setFeedback("");
    try {
      const engine = await getCanbanReviewEngine();
      const markdown = await engine.formatPendingMarkdown(context, draft.summary, draft.comments);
      if (mode === "copy") {
        await navigator.clipboard.writeText(markdown);
        setFeedback("已复制审查意见。");
      } else {
        await onSubmit(markdown, mode === "send");
        if (mode === "send") onDelivered(draft);
        setOpen(false);
        setFeedback(mode === "send" ? "审查意见已发送到原任务。" : "审查意见已加入任务输入。");
      }
    } catch (cause) {
      setFeedback(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  return <footer className="code-review-draft">
    {storageError && <p role="alert" className="code-review-feedback is-error">本地草稿无法更新。请复制审查意见以保留本次修改。</p>}
    {open && <div className="code-review-draft-content" aria-label="审查草稿">
      {draft.comments.map((comment) => <PendingCommentCard key={comment.id} comment={comment}
        outdated={!fileIds.has(comment.fileId)} onEdit={() => onEdit(comment)}
        onDiscard={() => onChange({ ...draft, comments: draft.comments.filter((item) => item.id !== comment.id) })} />)}
      <label className="code-review-summary">
        总体意见
        <textarea rows={3} aria-label="总体审查意见" maxLength={8000} value={draft.summary}
          onChange={(event) => onChange({ ...draft, summary: event.target.value })} />
      </label>
    </div>}
    <div className="code-review-draft-bar">
      <div className="code-review-title">
        <IconConversation size={15} />
        <span>{count ? `${count} 条待提交批注` : "审查意见"}</span>
        {feedback && <span role="status">{feedback}</span>}
      </div>
      <div className="code-review-actions">
        {open && <button type="button" className="code-review-button" disabled={!canSubmit || busy}
          aria-label="复制审查 Markdown" title="复制审查 Markdown" onClick={() => void submit("copy")}><IconCopy size={14} /></button>}
        {open && <button type="button" className="code-review-button" disabled={!canSubmit || busy}
          onClick={() => void submit("input")}>加入任务输入</button>}
        {open && <button type="button" className="code-review-button code-review-primary" disabled={!canSubmit || busy}
          title="发送到原任务" onClick={() => void submit("send")}>{busy ? "正在处理…" : "发送审查"}</button>}
        <button type="button" className="code-review-button" aria-expanded={open}
          onClick={() => setOpen((current) => !current)}>{open ? "收起草稿" : "查看审查草稿"}</button>
      </div>
    </div>
  </footer>;
}
