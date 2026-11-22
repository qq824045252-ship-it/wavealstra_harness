// UI port of Canban review.rs and review/sidebar.rs file navigation (390c057).
// Copyright 2026 JJy <jjyruby@gmail.com>. Licensed under Apache-2.0.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CodeReviewDecisionRequest, CodeReviewFile, CodeReviewGitComparison, CodeReviewGitList, CodeReviewGitRefs } from "@shared/code-review";
import { FileBadge } from "@/components/common/FileBadge";
import { IconGitBranch, IconRefresh, IconSearch } from "@/components/common/icons";
import { useAppStore } from "@/store/appStore";
import ReviewFileDetails, { gitSectionLabel, isGitFile, reviewFileKey, ReviewFileStats, reviewKindLabel, reviewStatusLabel } from "./code-review/ReviewFileDetails";
import { ReviewDialog } from "./code-review/ReviewDialog";
import { ReviewDecisionButton, ReviewDecisionStatus } from "./code-review/ReviewDecision";
import { InlineComposer, ReviewDraftFooter, type ActiveLine, type LineTarget, type PendingInlineComment, type ReviewDraft } from "./code-review/ReviewDraft";
import { readReviewDraft, saveReviewDraft } from "./code-review/reviewDraftStorage";
import "./code-review/CodeReview.css";

type Decision = CodeReviewDecisionRequest["action"];
type Feedback = { text: string; errors?: string[] };
type Source = "task" | CodeReviewGitComparison["mode"];

const NO_FILES: CodeReviewFile[] = [];
const NO_COMMENTS: PendingInlineComment[] = [];
const WORKTREE: CodeReviewGitComparison = { mode: "uncommitted" };
const POLL_INTERVAL = 1500;
const FILE_PAGE = 4;
const FILE_LOAD_DISTANCE = 320;
const sendingDrafts = new Set<string>();

function causeMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function ReviewFilePath({ name, path }: { name: string; path: string }): React.JSX.Element {
  const lastSlash = Math.max(path.lastIndexOf("/"), path.lastIndexOf("\\"));
  return <span className="code-review-file-path">
    <strong>{name}</strong>{lastSlash >= 0 && <small>{path.slice(0, lastSlash) || "/"}</small>}
  </span>;
}

interface WorkbenchProps {
  taskId: string;
  source: Source;
  comparison?: CodeReviewGitComparison;
  comparisonKey: string;
  draftScope: string;
  draftContext: string;
  toolbar: React.ReactNode;
  onRefreshRefs: () => void;
  onSelectCommit: (base: string, compare: string) => void;
}

function ReviewWorkbench({
  taskId, source, comparison, comparisonKey, draftScope, draftContext, toolbar, onRefreshRefs, onSelectCommit,
}: WorkbenchProps): React.JSX.Element {
  const isRunning = useAppStore((state) => state.tasks.find((item) => item.id === taskId)?.status === "in_progress");
  const isTask = source === "task";
  const [files, setFiles] = useState<CodeReviewFile[]>();
  const [gitList, setGitList] = useState<CodeReviewGitList | null>();
  const [selectedId, setSelectedId] = useState<string>();
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [pendingAction, setPendingAction] = useState<Decision>();
  const [rejection, setRejection] = useState<{ files: CodeReviewFile[]; skipped: number }>();
  const [feedback, setFeedback] = useState<Feedback>();
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set());
  const [visibleFiles, setVisibleFiles] = useState(FILE_PAGE);
  const [focus, setFocus] = useState<{ id: string }>();
  const [{ draft, storageError: draftStorageError }, setDraft] = useState(() => readReviewDraft(draftScope));
  const [activeLine, setActiveLine] = useState<ActiveLine>();
  const previousDraft = useRef(draft);
  const requestId = useRef(0);
  const reading = useRef(false);
  const deciding = useRef(false);
  const queuedRead = useRef<boolean | null>(null);
  const wasRunning = useRef(false);
  const viewport = useRef<HTMLDivElement>(null);
  const fileNodes = useRef(new Map<string, HTMLElement>());

  const refresh = useCallback(async (quiet = false): Promise<void> => {
    if (deciding.current || reading.current) {
      queuedRead.current = quiet && queuedRead.current !== false;
      return;
    }
    const api = window.api?.codeReview;
    if (!api) { setLoadError("代码审查服务不可用。"); setLoading(false); return; }
    const id = ++requestId.current;
    reading.current = true;
    if (!quiet) setLoading(true);
    try {
      if (isTask) {
        const current = await api.list(taskId);
        if (id !== requestId.current) return;
        setFiles(current);
      } else {
        const current = await api.gitList(taskId, comparison);
        if (id !== requestId.current) return;
        setGitList(current);
        setFiles(current?.files ?? []);
      }
      setLoadError("");
    } catch (cause) {
      if (id === requestId.current) setLoadError(causeMessage(cause));
    } finally {
      if (id === requestId.current) {
        reading.current = false;
        setLoading(false);
        const next = queuedRead.current;
        queuedRead.current = null;
        if (next !== null) void refresh(next);
      }
    }
  }, [taskId, isTask, comparison]);

  useEffect(() => {
    void refresh();
    return () => { requestId.current++; reading.current = false; queuedRead.current = null; };
  }, [refresh]);

  useEffect(() => {
    if (!isTask) return;
    return window.api?.codeReview?.onChanged?.((event) => {
      if (event.taskId === taskId) void refresh(true);
    });
  }, [taskId, isTask, refresh]);

  useEffect(() => {
    if (isTask) return;
    if (wasRunning.current && !isRunning) void refresh(true);
    wasRunning.current = isRunning;
    if (!isRunning || comparison?.mode === "compare" && comparison.compare !== "WORKDIR") return;
    const interval = window.setInterval(() => void refresh(true), POLL_INTERVAL);
    return () => window.clearInterval(interval);
  }, [comparison, isTask, isRunning, refresh]);

  useLayoutEffect(() => {
    if (!focus) return;
    const host = viewport.current;
    const file = fileNodes.current.get(focus.id);
    if (host && file) host.scrollTop += file.getBoundingClientRect().top - host.getBoundingClientRect().top;
  }, [focus]);

  const allFiles = files ?? NO_FILES;
  const fileIds = useMemo(() => new Set(allFiles.map((file) => file.id)), [allFiles]);
  const query = filter.trim().toLowerCase();
  const matchingFiles = query ? allFiles.filter((file) => file.path.toLowerCase().includes(query)) : allFiles;
  const pending = useMemo(() => isTask ? allFiles.filter((file) => file.status === "pending") : NO_FILES, [isTask, allFiles]);
  const rejectable = pending.filter((file) => file.canReject);
  const disabled = loading || Boolean(loadError) || Boolean(pendingAction);
  const commentsByFile = useMemo(() => {
    const groups = new Map<string, PendingInlineComment[]>();
    for (const comment of draft.comments) {
      const existing = groups.get(comment.fileId);
      if (existing) existing.push(comment);
      else groups.set(comment.fileId, [comment]);
    }
    return groups;
  }, [draft.comments]);

  function updateDraft(value: ReviewDraft): void {
    previousDraft.current = value;
    setDraft({ draft: value, storageError: !saveReviewDraft(draftScope, value) });
  }

  const setFileNode = useCallback((id: string, node: HTMLElement | null): void => {
    if (node) fileNodes.current.set(id, node);
    else fileNodes.current.delete(id);
  }, []);

  function focusFile(id: string): void {
    const index = allFiles.findIndex((file) => file.id === id);
    if (index < 0) return;
    const key = reviewFileKey(allFiles[index]);
    setSelectedId(key);
    setVisibleFiles((current) => Math.max(current, index + 1));
    setCollapsed((current) => {
      const next = new Set(current);
      for (let before = visibleFiles; before < index; before++) next.add(reviewFileKey(allFiles[before]));
      next.delete(key);
      return next;
    });
    setFocus({ id: key });
  }

  function toggleFile(id: string): void {
    setCollapsed((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });
  }

  function editComment(comment: PendingInlineComment): void {
    setActiveLine({ target: comment, comment, body: comment.body });
    focusFile(comment.fileId);
  }

  function changeActiveBody(body: string): void {
    setActiveLine((current) => current ? { ...current, body } : current);
  }

  function storeComment(comment: PendingInlineComment): void {
    const value = previousDraft.current;
    const index = value.comments.findIndex((item) => item.id === comment.id);
    const comments = [...value.comments];
    if (index < 0) comments.push(comment);
    else comments[index] = comment;
    updateDraft({ ...value, comments });
    setActiveLine(undefined);
  }

  function discardComment(comment: PendingInlineComment): void {
    const value = previousDraft.current;
    updateDraft({ ...value, comments: value.comments.filter((item) => item.id !== comment.id) });
    if (activeLine?.comment?.id === comment.id) setActiveLine(undefined);
  }

  function clearDeliveredDraft(submitted: ReviewDraft): void {
    const { draft: current } = readReviewDraft(draftScope);
    const delivered = new Map(submitted.comments.map((comment) => [comment.id, comment.body]));
    updateDraft({
      summary: submitted.summary === current.summary ? "" : current.summary,
      comments: current.comments.filter((comment) => delivered.get(comment.id) !== comment.body),
    });
  }

  async function decide(targets: CodeReviewFile[], action: Decision): Promise<void> {
    const api = window.api?.codeReview;
    if (!api || !isTask || deciding.current || !targets.length) return;
    if (useAppStore.getState().activeTaskId !== taskId) return;
    const id = ++requestId.current;
    reading.current = false;
    deciding.current = true;
    setPendingAction(action);
    setFeedback(undefined);
    setRejection(undefined);
    setLoading(false);
    try {
      const result = await api.decide({ taskId, ids: targets.map((file) => file.id), action });
      if (id !== requestId.current) return;
      setFiles(result.files);
      const errors = result.results.flatMap((item) => {
        if (item.status === "accepted" || item.status === "rejected") return [];
        const path = targets.find((file) => file.id === item.id)?.path ?? "文件";
        return [`${path} · ${item.reason ?? (item.status === "conflict" ? "版本已改变，请刷新并重新审查。" : "此变更无法处理。")}`];
      });
      const verb = action === "accept" ? "接受" : "拒绝";
      const succeeded = result.results.length - errors.length;
      setFeedback({ text: succeeded ? `已${verb} ${succeeded} 个文件。` : `未能${verb}所选变更。`, errors });
    } catch (cause) {
      if (id === requestId.current) setFeedback({ text: "处理变更失败。", errors: [causeMessage(cause)] });
    } finally {
      deciding.current = false;
      if (id === requestId.current) {
        setPendingAction(undefined);
        const next = queuedRead.current;
        queuedRead.current = null;
        if (next !== null) void refresh(next);
      }
    }
  }

  async function deliver(markdown: string, send: boolean): Promise<void> {
    const state = useAppStore.getState();
    if (state.activeTaskId !== taskId) throw new Error("任务已经切换，请回到原任务后提交审查。");
    if (sendingDrafts.has(draftScope)) throw new Error("原任务正在接收这份审查。");
    if (send) {
      const running = state.tasks.find((item) => item.id === taskId)?.status === "in_progress";
      sendingDrafts.add(draftScope);
      try {
        await state.sendMessage(markdown, undefined, undefined, running ? "followUp" : undefined,
          undefined, undefined, undefined, undefined, taskId);
      } finally {
        sendingDrafts.delete(draftScope);
      }
    } else {
      state.appendComposer(markdown, taskId);
      if (state.panelExpanded) state.togglePanelExpanded();
    }
  }

  return <>
    <header className="code-review-header">
      <div className="code-review-title">
        <IconGitBranch size={17} /><h2>代码审查</h2>
        {isTask && files && <span>{pending.length} 个待审查</span>}
      </div>
      <div className="code-review-actions">
        {isTask && <div className="code-review-decision-actions">
          <ReviewDecisionButton action="accept" variant="batch" label="全部接受" disabled={disabled || !pending.length}
            onClick={() => void decide(pending, "accept")} />
          <ReviewDecisionButton action="reject" variant="batch" label="全部拒绝" disabled={disabled || !rejectable.length}
            title={pending.length > rejectable.length ? "全部拒绝 · 部分变更无法安全撤销" : undefined}
            onClick={() => setRejection({ files: rejectable, skipped: pending.length - rejectable.length })} />
        </div>}
        <button className="code-review-icon" type="button" aria-label="刷新代码审查" title="刷新代码审查"
          disabled={loading || Boolean(pendingAction)} onClick={() => { onRefreshRefs(); void refresh(); }}><IconRefresh size={15} /></button>
      </div>
    </header>

    {toolbar}
    {loadError && <p role="alert" className="code-review-feedback is-error">读取代码审查失败。{loadError}</p>}
    {feedback && <div role={feedback.errors?.length ? "alert" : "status"} className={`code-review-feedback ${feedback.errors?.length ? "is-error" : ""}`}>
      <span>{feedback.text}</span>
      {feedback.errors?.length ? <ul>{feedback.errors.map((error, index) => <li key={index}>{error}</li>)}</ul> : null}
    </div>}
    {pendingAction && <p role="status" className="code-review-feedback">正在{pendingAction === "accept" ? "接受" : "拒绝"}变更…</p>}
    {gitList?.truncated && <p role="status" className="code-review-feedback">比较范围较大，当前只显示前 {allFiles.length} 个文件。</p>}

    <div className="code-review-columns" data-review-source={comparisonKey}>
      <nav className="code-review-files" aria-label="审查文件">
        <div className="code-review-files-header">
          <strong>文件{files && `（${allFiles.length}）`}</strong>
          {allFiles.length > 0 && <label className="code-review-search">
            <IconSearch size={14} />
            <input type="search" value={filter} aria-label="筛选变更文件" placeholder="筛选文件"
              onChange={(event) => setFilter(event.target.value)} />
          </label>}
        </div>
        <div className="code-review-file-list">
          {matchingFiles.map((file) => {
            const git = isGitFile(file);
            const label = git ? (file.untracked ? "未跟踪" : gitSectionLabel[file.section])
              : file.status === "pending" ? reviewKindLabel[file.kind] : reviewStatusLabel[file.status];
            const key = reviewFileKey(file);
            return <button type="button" key={key} className="code-review-file" aria-current={key === selectedId ? "true" : undefined}
              data-review-path={file.path} data-review-status={git ? undefined : file.status}
              data-review-section={git ? file.section : undefined} data-review-untracked={git && file.untracked ? "true" : undefined}
              title={`${file.path} · ${label}`}
              onClick={() => focusFile(file.id)}>
              <FileBadge name={file.name} size={16} />
              <ReviewFilePath {...file} />
              <span className="code-review-file-summary">
                {git || file.status === "pending"
                  ? <span className={`code-review-kind is-${file.kind}`}>{label}</span>
                  : <ReviewDecisionStatus status={file.status} />}
                <ReviewFileStats {...file} />
              </span>
            </button>;
          })}
          {query && !matchingFiles.length && <p className="code-review-message">没有匹配的文件。</p>}
        </div>
      </nav>

      <section className="code-review-body" aria-label="文件差异">
        <header className="code-review-diff-heading">
          <strong>差异</strong>
          {selectedId && <button type="button" className="code-review-button" onClick={() => {
            setSelectedId(undefined);
            if (viewport.current) {
              viewport.current.style.removeProperty("--review-anchor-padding");
              viewport.current.scrollTop = 0;
            }
          }}>回到顶部</button>}
        </header>
        <div className="code-review-diff-scroll" ref={viewport} tabIndex={0}
          onScroll={(event) => {
            const { scrollTop, scrollHeight, clientHeight } = event.currentTarget;
            if (scrollTop > 0 && visibleFiles < allFiles.length && scrollHeight - scrollTop - clientHeight <= FILE_LOAD_DISTANCE) {
              setVisibleFiles((count) => Math.min(count + FILE_PAGE, allFiles.length));
            }
          }}>
          {gitList && gitList.commits.length > 0 && <details className="code-review-commits">
            <summary>{gitList.commits.length} 个提交</summary>
            {gitList.commits.slice(0, 30).map((commit) => <button type="button" key={commit.sha}
              title={`${commit.subject} · ${commit.author} · ${commit.relativeTime}`}
              onClick={() => onSelectCommit(commit.parents[0] ?? `${commit.sha}^`, commit.sha)}>
              <code>{commit.shortSha}</code> {commit.subject}
            </button>)}
          </details>}
          {activeLine && !fileIds.has(activeLine.target.fileId) && <InlineComposer
            key={activeLine.comment?.id ?? "outdated"} active={activeLine}
            outdated onChange={changeActiveBody} onCancel={() => setActiveLine(undefined)} onSave={storeComment} />}
          {allFiles.slice(0, visibleFiles).map((file) => <ReviewFileDetails key={file.id} taskId={taskId} file={file}
            collapsed={collapsed.has(reviewFileKey(file))} decisionsDisabled={disabled} setFileNode={setFileNode}
            active={activeLine?.target.fileId === file.id ? activeLine : undefined} comments={commentsByFile.get(file.id) ?? NO_COMMENTS}
            onToggle={() => toggleFile(reviewFileKey(file))} onAccept={() => void decide([file], "accept")}
            onReject={() => setRejection({ files: [file], skipped: 0 })}
            onSelect={(target: LineTarget) => setActiveLine({ target, body: "" })} onEdit={editComment} onChangeActiveBody={changeActiveBody}
            onCancel={() => setActiveLine(undefined)} onSave={storeComment} onDiscard={discardComment} />)}
          {visibleFiles < allFiles.length && <button className="code-review-button code-review-more" type="button"
            onClick={() => setVisibleFiles((count) => Math.min(count + FILE_PAGE, allFiles.length))}>显示更多文件</button>}
          {!allFiles.length && <p className="code-review-message code-review-empty" role="status">
            {loading ? "正在读取代码变更…" : loadError ? "可刷新后重试。"
              : gitList === null ? "当前任务没有 Git 工作树。" : isTask ? "当前任务暂无代码变更。" : "此范围暂无 Git 变更。"}
          </p>}
        </div>
      </section>
    </div>

    {rejection && <ReviewDialog title="拒绝变更" onCancel={() => setRejection(undefined)}>
      <p>{rejection.files.length === 1 ? `拒绝 ${rejection.files[0].path} 的变更？` : `拒绝这些 ${rejection.files.length} 个文件的变更？`}</p>
      <p>拒绝后会撤销选中的任务修改。{rejection.skipped > 0 ? `另有 ${rejection.skipped} 个文件无法安全撤销。` : ""}</p>
      <div className="code-review-actions">
        <button type="button" className="btn" onClick={() => setRejection(undefined)}>取消</button>
        <ReviewDecisionButton action="reject" variant="confirm" label="确认拒绝"
          onClick={() => void decide(rejection.files, "reject")} />
      </div>
    </ReviewDialog>}
    <ReviewDraftFooter draft={draft} context={draftContext} fileIds={fileIds} onChange={updateDraft}
      onEdit={editComment} onSubmit={deliver} onDelivered={clearDeliveredDraft} storageError={draftStorageError} />
  </>;
}

function TaskReview({ taskId }: { taskId: string }): React.JSX.Element {
  const task = useAppStore((state) => state.tasks.find((item) => item.id === taskId));
  const workspace = useAppStore((state) => task?.cwd ?? state.spaces.find((item) => item.id === task?.spaceId)?.path ?? "");
  const [refs, setRefs] = useState<CodeReviewGitRefs | null>();
  const [source, setSource] = useState<Source>("task");
  const [base, setBase] = useState("");
  const [compare, setCompare] = useState("HEAD");
  const [threeDot, setThreeDot] = useState(true);
  const [refsError, setRefsError] = useState("");
  const refsTicket = useRef(0);

  const readRefs = useCallback((): void => {
    const api = window.api?.codeReview;
    if (!api) return;
    const ticket = ++refsTicket.current;
    void api.gitRefs(taskId).then((result) => {
      if (ticket !== refsTicket.current) return;
      setRefs(result);
      setRefsError("");
    }).catch((cause: unknown) => {
      if (ticket === refsTicket.current) setRefsError(causeMessage(cause));
    });
  }, [taskId]);

  useEffect(() => {
    readRefs();
    return () => { refsTicket.current++; };
  }, [readRefs, workspace]);

  const actualBase = base || refs?.defaultBase || "HEAD";
  const comparison = useMemo<CodeReviewGitComparison | undefined>(() => {
    if (source === "task") return undefined;
    if (source === "uncommitted") return WORKTREE;
    return { mode: "compare", base: actualBase, compare, threeDot };
  }, [source, actualBase, compare, threeDot]);
  const comparisonKey = comparison?.mode === "compare"
    ? `${comparison.base}${comparison.threeDot ? "..." : ".."}${comparison.compare}` : source;
  const scope = JSON.stringify([taskId, workspace, comparisonKey]);
  const context = source === "task" ? (task?.title || "任务变更")
    : source === "uncommitted" ? "Git 未提交变更" : comparisonKey;
  const refChoices = (value: string): string[] => [...new Set([...(refs?.refs ?? []), value])];

  return <ReviewWorkbench key={scope} taskId={taskId} source={source} comparison={comparison}
    comparisonKey={comparisonKey} draftScope={scope} draftContext={context} onRefreshRefs={readRefs}
    onSelectCommit={(parent, sha) => { setBase(parent); setCompare(sha); setThreeDot(false); setSource("compare"); }}
    toolbar={<div className="code-review-source">
      <label>审查来源<select aria-label="审查来源" value={source}
        onChange={(event) => setSource(event.target.value as Source)}>
        <option value="task">任务变更</option>
        <option value="uncommitted" disabled={!refs}>Git 未提交变更</option>
        <option value="compare" disabled={!refs}>Git 引用比较</option>
      </select></label>
      {source === "compare" && <>
        <label>基准<select aria-label="比较基准" value={actualBase} onChange={(event) => setBase(event.target.value)}>
          {refChoices(actualBase).map((ref) => <option key={ref}>{ref}</option>)}
        </select></label>
        <button type="button" className="code-review-button" aria-label="使用共同祖先作为比较基准"
          title={threeDot ? "从两个引用的共同祖先开始" : "直接比较两个引用"} aria-pressed={threeDot}
          onClick={() => setThreeDot((current) => !current)}>{threeDot ? "..." : ".."}</button>
        <label>目标<select aria-label="比较目标" value={compare} onChange={(event) => setCompare(event.target.value)}>
          {refChoices(compare).filter((ref) => ref !== "WORKDIR").map((ref) => <option key={ref}>{ref}</option>)}
          <option value="WORKDIR">工作树</option>
        </select></label>
      </>}
      {refsError && <span role="status">读取 Git 引用失败。{refsError}</span>}
    </div>} />;
}

export default function ChangesView({ taskId }: { taskId: string | null }): React.JSX.Element {
  return <section className="code-review" aria-label="代码审查面板">
    {taskId ? <TaskReview key={taskId} taskId={taskId} /> : <p className="code-review-message">打开一个任务以查看代码变更。</p>}
  </section>;
}
