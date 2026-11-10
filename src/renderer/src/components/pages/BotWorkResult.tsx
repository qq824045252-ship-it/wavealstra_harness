import { useState } from "react";
import type { BotMessageDto, WorkFeedbackDto } from "@shared/bot-conversation";
import type { WorkProjectionDto } from "@shared/bot-work";
import { fileNameFromPath } from "@/lib/localFilePath";
import ChatMarkdown from "@/components/chat/ChatMarkdown";

type GeneratedFile = NonNullable<WorkProjectionDto["generatedArtifacts"]>[number];
export interface WorkFile { ref: string; name: string; artifact?: GeneratedFile; openPath?: string }

/** Match exact paths within this execution, never a basename or the selected Task. */
export function workFiles(refs: string[], work?: WorkProjectionDto, executionId?: string): WorkFile[] {
  return [...new Set(refs)].map(ref => {
    const candidates = [...(work?.generatedArtifacts ?? []), ...(executionId ? work?.historicalGeneratedArtifacts ?? [] : [])]
      .filter(item => !executionId || item.bindingId === executionId);
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

export function WorkFiles({ files }: { files: WorkFile[] }): React.JSX.Element | null {
  const [notice, setNotice] = useState("");
  if (!files.length) return null;
  const reports = files.filter(reportFile);
  const others = files.filter(file => !reportFile(file));
  const open = async (file: WorkFile) => {
    try {
      if (!window.api?.openFolder) throw new Error("文件打开接口不可用");
      const target = file.openPath ?? file.artifact?.snapshotPath ?? file.artifact?.path;
      if (!target) throw new Error("此引用没有已登记的可打开文件");
      await window.api.openFolder(target);
      setNotice("");
    } catch (error) { setNotice(`无法打开文件：${error instanceof Error ? error.message : String(error)}`); }
  };
  const list = (items: WorkFile[]) => <ul className="bot-result-files">{items.map(file => <li key={file.artifact ? JSON.stringify([file.artifact.bindingId, file.artifact.path, file.artifact.digest]) : file.ref}>
    <div><strong title={file.name}>{file.name}</strong>{file.artifact && <small>{formatSize(file.artifact.sizeBytes)}</small>}</div>
    {(file.artifact || file.openPath) && <button type="button" onClick={() => void open(file)}>{file.artifact?.snapshotPath || file.openPath ? "打开保存版本" : "打开文件"}</button>}
    <details><summary>路径与版本</summary><p>{file.ref}</p>{file.artifact && <><p>原文件：{file.artifact.path}</p><p>SHA-256：{file.artifact.digest}</p><button type="button" onClick={() => void window.api?.showItemInFolder?.(file.artifact!.path)}>定位文件</button></>}</details>
  </li>)}</ul>;
  return <section className="bot-result-attachments" aria-label="成果附件">
    <h4>{reports.length ? "报告与数据" : "成果附件"} · {reports.length || files.length}</h4>
    {list(reports.length ? reports : files)}
    {reports.length > 0 && others.length > 0 && <details className="bot-result-other-files"><summary>其他文件与脚本 · {others.length}</summary>{list(others)}</details>}
    {notice && <p role="alert">{notice}</p>}
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
  const original = originalText.replace(/\r\n/g, "\n").trim();
  const displayed = (report.structured?.conclusions.map(item => item.text).join("\n") ?? report.summary).replace(/\r\n/g, "\n").trim();
  if (!original || original === displayed) return "";
  // Structured projections may omit JSON fields; keep their source intact.
  if (report.structured || !displayed) return original;
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

export function WorkReport({ report, originalText, executionId, work, renderMarkdown }: {
  report: NonNullable<WorkFeedbackDto["report"]>; originalText: string; executionId?: string; work?: WorkProjectionDto;
  renderMarkdown: (text: string) => React.JSX.Element;
}): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const unprojectedJson = !report.structured && /^(?:```(?:json)?\s*)?[{[]/.test(report.summary.trim());
  const bodyText = report.structured?.conclusions.map(item => item.text).join("\n") ?? report.summary;
  const long = !unprojectedJson && (bodyText.length > 1600 || bodyText.split("\n").length > 20);
  const additionalRecord = unprojectedJson
    ? (originalText.includes(report.summary) ? originalText : [report.summary, originalText].filter(Boolean).join("\n\n"))
    : additionalReportRecord(report, originalText);
  const files = workFiles(report.artifactRefs, work, executionId).map(file => ({ ...file,
    name: report.files?.find(item => item.ref === file.ref)?.name ?? file.name,
    openPath: report.files?.find(item => item.ref === file.ref)?.openPath }));
  return <section className="bot-result-report" aria-label={`成果：${report.title}`}>
    <header><h3>{report.title}</h3><span className="bot-status-badge">{!report.current ? "历史成果" : {
      proposed: "结果已返回", accepted: "负责人已核验", rejected: "未通过核验", superseded: "已被新成果替代",
    }[report.reviewStatus]}</span></header>
    <div className={`bot-result-body ${long && !expanded ? "is-collapsed" : ""}`}>
      {report.structured ? <section aria-label="本次请求的结论"><h4>本次请求的结论</h4>{report.structured.conclusions.map((item, index) => <article key={index}>
        {renderMarkdown(item.text)}<details><summary>关联请求与来源</summary><p>{item.requestText}</p>
        <p>引用关联不代表结论已自动证实。</p><ul>{item.sources.map(source => <li key={source.ref}>{source.label}<details><summary>来源标识</summary><code>{source.ref}</code></details></li>)}</ul>
        </details></article>)}</section> : unprojectedJson ? <p>报告已返回；此记录未生成可读投影，请展开下方完整报告查看原始内容。</p> : renderMarkdown(report.summary)}
    </div>
    {report.teamFacts && <section aria-label="汇总时的执行事实"><h4>汇总时的执行事实</h4><ul>{report.teamFacts.map((fact, index) => <li key={index}>
      <strong>{fact.displayName}</strong>：{{ completed: "执行结束", failed: "执行失败", stopped: "执行停止", invalidated: "执行已失效", unknown: "执行结果未知", not_started: "未启动", running: "执行中", submitted: "已派发", pending: "准备中" }[fact.executionStatus] ?? fact.executionStatus}
      {fact.failureReason && <p role="status">{fact.failureSummary ?? fact.failureReason}</p>}
      <details><summary>分工与执行来源</summary><p>{fact.responsibility}</p>{fact.failureReason && <p>{fact.failureReason}</p>}{fact.sourceRefs.map(ref => <p key={ref}><code>{ref}</code></p>)}</details>
    </li>)}</ul></section>}
    {report.structured?.observations.length ? <details aria-label="额外观察"><summary>额外观察（不增加任务要求）· {report.structured.observations.length}</summary>
      {report.structured.observations.map((text, index) => <div key={index}>{renderMarkdown(text)}</div>)}
    </details> : null}
    {long && <button className="bot-result-expand" type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "收起长报告" : "展开完整报告"}</button>}
    {report.notices.length > 0 && <ul className="bot-result-notices">{report.notices.map((notice, i) => <li key={i}>{notice}</li>)}</ul>}
    <WorkFiles files={files} />
    {additionalRecord && <details className="bot-original-report"><summary>{unprojectedJson ? "完整报告（原始格式）" : "补充原始记录"}</summary><p>成果记录：{{ proposed: "已生成，尚未登记采纳", accepted: "已采纳", rejected: "未采纳", superseded: "已被后续成果替代" }[report.reviewStatus]}。这是成果记录状态，不是新的操作授权请求。</p>{renderMarkdown(additionalRecord)}</details>}
  </section>;
}

/** Detail-panel prose can contain tables; it must not resolve through another Task. */
export function WorkResultText({ text }: { text: string }): React.JSX.Element {
  return <ChatMarkdown text={text} streaming={false} resolveTaskFiles={false} />;
}
