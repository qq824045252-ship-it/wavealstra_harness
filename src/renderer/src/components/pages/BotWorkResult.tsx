import { useState } from "react";
import type { BotMessageDto } from "@shared/bot-conversation";
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
  const [expanded, setExpanded] = useState(false);
  const report = message.workFeedback!.report!;
  const long = report.summary.length > 1600 || report.summary.split("\n").length > 20;
  const files = workFiles(report.artifactRefs, work, message.workFeedback?.executionId).map(file => ({ ...file,
    name: report.files?.find(item => item.ref === file.ref)?.name ?? file.name,
    openPath: report.files?.find(item => item.ref === file.ref)?.openPath }));
  return <section className="bot-result-report" aria-label={`成果：${report.title}`}>
    <header><h3>{report.title}</h3><span className="bot-status-badge">{!report.current ? "历史成果" : {
      proposed: "成果已生成 · 待核验", accepted: "负责人已核验", rejected: "未通过核验", superseded: "已被新成果替代",
    }[report.reviewStatus]}</span></header>
    <div className={`bot-result-body ${long && !expanded ? "is-collapsed" : ""}`}>{renderMarkdown(report.summary)}</div>
    {long && <button className="bot-result-expand" type="button" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "收起长报告" : "展开完整报告"}</button>}
    {report.notices.length > 0 && <ul className="bot-result-notices">{report.notices.map((notice, i) => <li key={i}>{notice}</li>)}</ul>}
    <WorkFiles files={files} />
    <details className="bot-original-report"><summary>原始消息与完整记录</summary>{renderMarkdown(message.text)}</details>
  </section>;
}

/** Detail-panel prose can contain tables; it must not resolve through another Task. */
export function WorkResultText({ text }: { text: string }): React.JSX.Element {
  return <ChatMarkdown text={text} streaming={false} resolveTaskFiles={false} />;
}
