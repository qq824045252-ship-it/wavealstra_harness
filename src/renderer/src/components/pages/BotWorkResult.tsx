import { useState } from "react";
import type { BotMessageDto, WorkFeedbackDto } from "@shared/bot-conversation";
import type { WorkProjectionDto } from "@shared/bot-work";
import { fileNameFromPath } from "@/lib/localFilePath";
import ChatMarkdown from "./BotChatMarkdown";
import WorkFilePreview from "./WorkFilePreview";
import SavedFileActions from "./SavedFileActions";

import { previewManifestFor, type WorkFile } from "./workFileIdentity";
export { previewManifestFor, type WorkFile } from "./workFileIdentity";

/** Match exact paths within this execution, never a basename or the selected Task. */
export function workFiles(refs: string[], work?: WorkProjectionDto, executionId?: string): WorkFile[] {
  return [...new Set(refs)].map(ref => {
    const candidates = [...(work?.generatedArtifacts ?? []), ...(executionId ? work?.historicalGeneratedArtifacts ?? [] : [])]
      .filter(item => !executionId || item.bindingId === executionId)
      .sort((a, b) => b.sourceEntryId - a.sourceEntryId);
    const sources = candidates.filter(item => item.path === ref);
    const artifact = candidates.find(item => item.snapshotPath === ref) ?? (sources.length === 1 ? sources[0] : undefined);
    return { ref, name: fileNameFromPath(artifact?.path ?? ref), artifact };
  });
}

export function generatedWorkFiles(work: WorkProjectionDto): WorkFile[] {
  return (work.generatedArtifacts ?? []).map(artifact => ({ ref: artifact.snapshotPath ?? artifact.path,
    name: fileNameFromPath(artifact.path), artifact }));
}

function reportFile(file: WorkFile): boolean {
  return /\.(?:pdf|docx?|xlsx?|csv|tsv|json|jsonl|xml|ya?ml|pptx?|md|txt|html?|png|jpe?g|webp|svg)$/i.test(file.name);
}

export function BotReturnedFiles({ message }: { message: BotMessageDto }): React.JSX.Element | null {
  const report = message.collaborationResult?.report;
  if (message.status !== "completed" || !report) return null;
  const files = [...new Set(report.artifactRefs)].map(ref => {
    const file = report.files?.find(item => item.ref === ref);
    return { ref, name: file?.name ?? fileNameFromPath(ref), openPath: file?.openPath,
      previewManifestPath: file?.previewManifestPath ?? null };
  });
  return <WorkFiles files={files} primaryRefs={report.primaryArtifactRefs} compact />;
}

export function WorkFiles({ files, primaryRefs, compact = false, compactTitle = "本次交付" }: { files: WorkFile[]; primaryRefs?: string[]; compact?: boolean; compactTitle?: string }): React.JSX.Element | null {
  const [notice, setNotice] = useState("");
  const [selected, setSelected] = useState<{ file: WorkFile; target: string }>();
  if (!files.length) return null;
  const reports = files.filter(reportFile);
  const others = files.filter(file => !reportFile(file));
  const openable = (file: WorkFile) => Boolean(file.artifact || file.openPath);
  const ordered = primaryRefs === undefined ? (reports.length ? reports : files).filter(openable)
    : [...new Set(primaryRefs)].flatMap(ref => files.filter(file => file.ref === ref && openable(file)));
  const primary = compact ? ordered.slice(0, 3) : [];
  const remaining = compact ? files.filter(file => !primary.includes(file)) : [];
  const open = async (file: WorkFile) => {
    try {
      const target = file.openPath ?? file.artifact?.snapshotPath ?? file.artifact?.path;
      if (!target) throw new Error("此引用没有已登记的可打开文件");
      setSelected({ file, target });
      setNotice("");
    } catch (error) { setNotice(`无法打开文件：${error instanceof Error ? error.message : String(error)}`); }
  };
  const list = (items: WorkFile[]) => <ul className="bot-result-files">{items.map(file => <li key={file.artifact ? JSON.stringify([file.artifact.bindingId, file.artifact.path, file.artifact.digest, previewManifestFor(file)]) : JSON.stringify([file.ref, file.previewManifestPath])}>
    <div><strong title={file.name}>{file.name}</strong>{file.artifact && <small>{formatSize(file.artifact.sizeBytes)}</small>}</div>
    {!(file.artifact || file.openPath) && <small>未登记可打开文件</small>}
    {(file.artifact || file.openPath) && <SavedFileActions
      name={file.name}
      key={JSON.stringify([file.openPath ?? file.artifact?.snapshotPath, file.name])}
      request={file.openPath || file.artifact?.snapshotPath ? { snapshotPath: (file.openPath ?? file.artifact?.snapshotPath)!, name: file.name, manifestPath: previewManifestFor(file) } : undefined}
      onPreview={() => void open(file)} />}
    <details><summary>路径与版本</summary><p>{file.ref}</p>{file.artifact && <><p>原文件：{file.artifact.path}</p><p>SHA-256：{file.artifact.digest}</p><button type="button" onClick={() => void window.api?.showItemInFolder?.(file.artifact!.path)}>定位文件</button></>}</details>
  </li>)}</ul>;
  return <section className="bot-result-attachments" aria-label="成果附件">
    {compact ? <>
      {!!primary.length && <><h4>{compactTitle}</h4>{list(primary)}</>}
      {!!remaining.length && <details className="bot-result-other-files"><summary>其他文件与引用 · {remaining.length}</summary>{list(remaining)}</details>}
    </> : <>
      <h4>{reports.length ? "报告与数据" : "成果附件"} · {reports.length || files.length}</h4>
      {list(reports.length ? reports : files)}
      {reports.length > 0 && others.length > 0 && <details className="bot-result-other-files"><summary>其他文件与脚本 · {others.length}</summary>{list(others)}</details>}
    </>}
    {notice && <p role="alert">{notice}</p>}
    {selected && files.some(file => file.ref === selected.file.ref && (file.openPath ?? file.artifact?.snapshotPath ?? file.artifact?.path) === selected.target
      && (previewManifestFor(file)) === (previewManifestFor(selected.file))) &&
      <WorkFilePreview key={JSON.stringify([selected.target, previewManifestFor(selected.file)])} file={selected.file} target={selected.target} onClose={() => setSelected(undefined)} />}
  </section>;
}

function formatSize(bytes: number): string {
  return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export function BotResultReport({ message, work, renderMarkdown }: { message: BotMessageDto; work?: WorkProjectionDto;
  renderMarkdown: (text: string) => React.JSX.Element }): React.JSX.Element {
  return <WorkReport report={message.workFeedback!.report!} originalText={message.text} executionId={message.workFeedback?.executionId} work={work} renderMarkdown={renderMarkdown} />;
}

/** Presentation-only subtraction: never rewrite the persisted message or infer semantic equivalence. */
export function additionalReportRecord(report: NonNullable<WorkFeedbackDto["report"]>, originalText: string): string {
  let original = originalText.replace(/\r\n/g, "\n").trim();
  // WorkConversationFeedback prefixes every delivered message with the exact
  // Work title. It is already the card heading, not supplemental evidence.
  const titlePrefix = `【${report.title}】`;
  if (original === titlePrefix) return "";
  if (original.startsWith(`${titlePrefix}\n`)) original = original.slice(titlePrefix.length + 1).trim();
  const displayed = resultBodyText(report).replace(/\r\n/g, "\n").trim();
  if (!original || original === displayed) return "";
  // Structured projections may omit JSON fields; keep their source intact.
  if (report.structured && !report.completion || !displayed) return original;
  const at = original.indexOf(displayed);
  if (at < 0 || (at > 0 && original[at - 1] !== "\n")
    || (at + displayed.length < original.length && original[at + displayed.length] !== "\n")) return original;
  let remainder = original.slice(0, at) + original.slice(at + displayed.length);
  // These are host-generated wrappers already represented by the card's badge,
  // notices and attachments. Unknown prefixes/suffixes always remain accessible.
  remainder = remainder.replace(/^(?:后台成果|历史执行成果（不代表当前要求已完成）)，(?:结果已返回|已采纳|未采纳|已被后续成果替代)\n/, "");
  const representedLines = new Set(report.notices);
  if (report.artifactRefs.length) {
    representedLines.add(`成果：${report.artifactRefs[0]}`);
    for (const ref of report.artifactRefs.slice(1)) representedLines.add(ref);
  }
  return remainder.split("\n").filter(line => !representedLines.has(line)).join("\n").trim();
}

/** A foreground goal review is the user reply. Worker conclusions remain source
 * evidence and must never override the review simply because they are JSON. */
export function resultBodyText(report: NonNullable<WorkFeedbackDto["report"]>): string {
  return report.completion ? report.summary : report.structured?.conclusions.map(item => item.text).join("\n") ?? report.summary;
}

export function WorkReport({ report, originalText, executionId, work, renderMarkdown, presentation = "conversation" }: {
  report: NonNullable<WorkFeedbackDto["report"]>; originalText: string; executionId?: string; work?: WorkProjectionDto;
  renderMarkdown: (text: string) => React.JSX.Element;
  presentation?: "conversation" | "detail" | "record";
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const bodyText = resultBodyText(report);
  const notices = [...new Set(report.notices)].filter(notice => presentation !== "detail"
    || !bodyText.replace(/\r\n/g, "\n").includes(notice.replace(/\r\n/g, "\n").trim()));
  const unprojectedJson = !report.completion && !report.structured && /^(?:```(?:json)?\s*)?[{[]/.test(bodyText.trim());
  const long = presentation === "conversation" && !unprojectedJson && (bodyText.length > 800 || bodyText.split("\n").length > 12);
  const additionalRecord = unprojectedJson
    ? (originalText.includes(report.summary) ? originalText : [report.summary, originalText].filter(Boolean).join("\n\n"))
    : additionalReportRecord(report, originalText);
  // Milestones carry an immutable host snapshot. A later Work cache refresh
  // must not upgrade mutable evidence or replace the early saved version.
  const files: WorkFile[] = report.milestone ? [...new Set(report.artifactRefs)].map(ref => ({ ref,
    name: report.files?.find(file => file.ref === ref)?.name ?? fileNameFromPath(ref),
    openPath: report.files?.find(file => file.ref === ref)?.openPath,
    previewManifestPath: report.files?.find(file => file.ref === ref)?.previewManifestPath ?? null }))
    : workFiles(report.artifactRefs, work, executionId).map(file => ({ ...file,
      name: report.files?.find(item => item.ref === file.ref)?.name ?? file.name,
      openPath: report.files?.find(item => item.ref === file.ref)?.openPath,
      previewManifestPath: report.files?.find(item => item.ref === file.ref)?.previewManifestPath ?? null }));
  const sourceConclusions = report.structured?.conclusions ?? [];
  const detailFiles = report.primaryArtifactRefs === undefined ? files.filter(reportFile) : files.filter(file => report.primaryArtifactRefs?.includes(file.ref));
  const hasDetails = Boolean(report.teamFacts?.length || sourceConclusions.length || report.structured?.observations.length || report.sourceNotices?.length || additionalRecord);
  const status = !report.current ? (report.milestone ? "历史阶段成果" : "历史成果") : report.milestone ? "阶段成果" : report.completion
    ? report.completion.nextStep === "ask" ? "需要你补充" : report.completion.nextStep === "continue" ? "继续处理中"
      : { completed: "已完成", partial: "部分完成", unknown: "尚未核实" }[report.completion.outcome]
    : { proposed: "结果已返回", accepted: "负责人已核验", rejected: "未通过核验", superseded: "已被新成果替代" }[report.reviewStatus];
  return <section className="bot-result-report" aria-label={`成果：${report.title}`}>
    {presentation !== "detail" && <header><h3>{report.title}</h3><span className="bot-status-badge" data-outcome={report.completion?.outcome}>{status}</span></header>}
    <div className={`bot-result-body ${long && !expanded ? "is-collapsed" : ""}`}>
      {unprojectedJson ? <p>原始报告已保留，尚未整理成可读结论。请展开执行详情查看，不代表目标已完成。</p>
        : <>{presentation === "conversation" && !report.completion && report.structured && <h4>本次请求的结论</h4>}{renderMarkdown(bodyText)}</>}
    </div>
    {long && <button className="bot-result-expand" type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "收起长报告" : "展开完整报告"}</button>}
    {notices.length > 0 && <section className="bot-result-limitations" aria-label="需要注意"><h4>需要注意</h4><ul className="bot-result-notices">{notices.map((notice, i) => <li key={i}>{notice}</li>)}</ul></section>}
    <WorkFiles files={presentation === "detail" ? (report.primaryArtifactRefs === undefined && !detailFiles.length ? files : detailFiles) : files} primaryRefs={report.primaryArtifactRefs} compact={presentation === "conversation"} compactTitle={report.milestone ? "当前可用文件" : "本次交付"} />
    {presentation !== "detail" && hasDetails && <details className="bot-result-details"><summary>执行详情与来源</summary>
      {!!report.sourceNotices?.length && <section aria-label="执行报告中的限制"><h4>执行报告中的限制</h4><ul>{report.sourceNotices.map((notice,index) => <li key={index}>{notice}</li>)}</ul></section>}
      {report.teamFacts?.length ? <section aria-label="汇总时的执行事实"><h4>汇总时的执行事实</h4><ul>{report.teamFacts.map((fact, index) => <li key={index}>
        <strong>{fact.displayName}</strong>：{{ completed: "执行结束", failed: "执行失败", stopped: "执行停止", invalidated: "执行已失效", unknown: "执行结果未知", not_started: "未启动", running: "执行中", submitted: "已派发", pending: "准备中" }[fact.executionStatus] ?? fact.executionStatus}
        {fact.failureReason && <p>{fact.failureSummary ?? fact.failureReason}</p>}
        <details><summary>分工与执行来源</summary><p>{fact.responsibility}</p>{fact.failureReason && <p>{fact.failureReason}</p>}{fact.sourceRefs.map(ref => <p key={ref}><code>{ref}</code></p>)}</details>
      </li>)}</ul></section> : null}
      {!!sourceConclusions.length && <section aria-label="结论来源">{sourceConclusions.map((item,index) => <details key={index}><summary>关联请求与来源 {index + 1}</summary>
        {report.completion && renderMarkdown(item.text)}<p>{item.requestText}</p><p>引用关联不代表结论已自动证实。</p>
        <ul>{item.sources.map(source => <li key={source.ref}>{source.label}<details><summary>来源标识</summary><code>{source.ref}</code></details></li>)}</ul>
      </details>)}</section>}
      {report.structured?.observations.length ? <details aria-label="额外观察"><summary>额外观察（不增加任务要求）· {report.structured.observations.length}</summary>
        {report.structured.observations.map((text, index) => <div key={index}>{renderMarkdown(text)}</div>)}
      </details> : null}
      {additionalRecord && <details className="bot-original-report"><summary>{unprojectedJson ? "完整报告（原始格式）" : "补充原始记录"}</summary><p>成果记录：{{ proposed: "已生成，尚未登记采纳", accepted: "已采纳", rejected: "未采纳", superseded: "已被后续成果替代" }[report.reviewStatus]}。</p>{renderMarkdown(additionalRecord)}</details>}
    </details>}
  </section>;
}

/** Detail-panel prose can contain tables; it must not resolve through another Task. */
export function WorkResultText({ text }: { text: string }): React.JSX.Element {
  return <ChatMarkdown text={text} streaming={false} resolveTaskFiles={false} />;
}
