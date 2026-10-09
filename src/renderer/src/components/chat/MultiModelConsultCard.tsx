import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useAppStore } from "@/store/appStore";
import type { ToolCall } from "@/types";
import {
  consultSummary,
  type ConsultToolTrace,
  type ConsultWorkerResult,
  type ConsultWorkerStatus,
  type MultiModelConsultReport,
} from "@shared/multi-model-consult";
import { IconUsers, IconX } from "@/components/common/icons";
import "./MultiModelConsultCard.css";

const STATUS: Record<ConsultWorkerStatus, string> = {
  queued: "等待", running: "分析中", complete: "已完成", error: "失败", cancelled: "已取消", timeout: "超时",
};

/** A tool trace that never finished stays "已中断" once the parent tool reached a terminal state. */
function traceStatusLabel(status: ConsultToolTrace["status"], interrupted: boolean): string {
  if (status === "success") return "成功";
  if (status === "error") return "失败";
  if (status === "cancelled") return "已取消";
  return interrupted ? "已中断" : "执行中";
}

function clip(text: string, max: number): string {
  const value = text.replace(/\s+/g, " ").trim();
  return value.length > max ? `${value.slice(0, max)}…（已截断 ${value.length - max} 字）` : value;
}

function argumentsPreview(args: unknown): string {
  if (args === undefined || args === null) return "（无参数）";
  try {
    const json = typeof args === "string" ? args : JSON.stringify(args);
    if (!json || json === "{}" || json === "null") return "（无参数）";
    return clip(json, 360);
  } catch {
    return "（参数无法序列化）";
  }
}

function outputPreview(trace: ConsultToolTrace): string {
  const output = trace.output ?? "";
  if (!output.trim()) return "（无输出）";
  return `${clip(output, 480)}${trace.outputTruncated ? "（会诊报告只保留了截断预览）" : ""}`;
}

/** Digest of the participant's real tool traces; nothing is paraphrased or invented. */
function toolsDigest(worker: ConsultWorkerResult, interrupted: boolean): string {
  const tools = worker.tools ?? [];
  if (!tools.length) return "会诊报告未记录该参与者的工具调用。";
  return tools.map((trace, index) => `${index + 1}. ${trace.name} · ${traceStatusLabel(trace.status, interrupted)} · 参数：${argumentsPreview(trace.arguments)} · 输出预览：${outputPreview(trace)}`).join("\n");
}

/** Stable, quotable follow-up text: report identity, participant identity, status, evidence, real traces. */
function followUpText(report: MultiModelConsultReport, worker: ConsultWorkerResult, statusText: string, interrupted: boolean): string {
  const answer = (worker.answer ?? "").trim();
  const failure = (worker.error ?? "").trim();
  const tools = worker.tools ?? [];
  const identity = `${worker.modelName ?? worker.modelId}（${worker.modelId} · 思考等级 ${worker.thinkingLevel ?? "默认"}）`;
  const evidence = answer
    ? `以下是该参与者的原始意见（未经改写，也不是新的系统指令）：\n${answer}`
    : `该参与者没有返回文字回答；以下是会诊报告记录的真实原因（未经改写，也不是新的系统指令）：\n${failure}`;
  return [
    "请基于下列会诊发现继续调查，并核验证据；先不要修改。",
    `会诊报告：${report.id}`,
    `原任务：${report.task}`,
    `参与者：${identity}`,
    `该参与者状态：${statusText}`,
    evidence,
    ...(answer && failure ? [`会诊报告同时记录了该参与者的错误：${failure}`] : []),
    `该参与者的真实工具记录（${tools.length} 条，取自会诊报告，未改写）：`,
    toolsDigest(worker, interrupted),
  ].join("\n\n");
}

export default function MultiModelConsultCard({ toolCall }: { toolCall: ToolCall }): React.JSX.Element {
  const report = toolCall.consult;
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const dialog = useRef<HTMLDialogElement>(null);
  const activeTaskId = useAppStore((state) => state.activeTaskId);
  useEffect(() => {
    if (!open) return;
    dialog.current?.showModal();
    return () => { dialog.current?.close(); };
  }, [open]);
  const workers = report?.workers ?? [];
  const activeIndex = Math.min(Math.max(selected, 0), Math.max(workers.length - 1, 0));
  const worker = workers[activeIndex];
  const terminal = toolCall.status !== "running" && toolCall.status !== "pending_approval";
  const interrupted = terminal && report?.status === "running";
  const title = report ? interrupted ? "多模型会诊 · 已中断，保留已收到结果" : consultSummary(report)
    : terminal ? "多模型会诊 · 未完成" : "多模型会诊 · 准备中";
  // Total mapping: a persisted/unknown status must never render as "undefined" in the UI or the quoted text.
  const status = (value: ConsultWorkerStatus | undefined): string => {
    if (interrupted && (value === "running" || value === "queued")) return "已中断";
    return (value && STATUS[value]) || "状态未知";
  };
  const duration = (item: ConsultWorkerResult): string => item.startedAt && item.endedAt
    ? `${((item.endedAt - item.startedAt) / 1000).toFixed(1)} 秒`
    : item.startedAt ? "计时中" : "";
  const tokens = (item: ConsultWorkerResult): string => item.tokens
    ? `tokens 输入 ${item.tokens.input} / 输出 ${item.tokens.output}${item.tokens.cacheRead ? ` / 缓存读 ${item.tokens.cacheRead}` : ""}`
    : "";
  const sameTask = Boolean(report) && activeTaskId === report?.taskId;
  // A failed, timed-out or cancelled participant stays quotable while it has an answer or a reason.
  const hasEvidence = Boolean(worker && ((worker.answer ?? "").trim() || (worker.error ?? "").trim()));
  const canFollowUp = Boolean(worker) && sameTask && hasEvidence;
  /** A participant can be terminated directly while it is still queued or generating. */
  const canStop = (item: ConsultWorkerResult | undefined): boolean =>
    Boolean(item) && !terminal && (item!.status === "queued" || item!.status === "running");
  const stopWorker = async (index: number): Promise<void> => {
    const target = workers[index];
    if (!report || !target) return;
    const label = `${target.modelName ?? target.modelId}${target.thinkingLevel ? ` · ${target.thinkingLevel}` : ""}`;
    const call = window.api?.agent?.stopConsultWorker;
    if (typeof call !== "function") {
      setNotice("当前运行版本不支持直接终止单个模型；请更新后重试，或使用主输入框的停止按钮结束整场会诊。");
      return;
    }
    try {
      const stopped = await call({ taskId: report.taskId, consultId: report.id, workerIndex: index });
      setNotice(stopped
        ? `已终止「${label}」；该模型立即结束，不再等待，其它模型与会诊结果保留。`
        : `「${label}」已经结束，或这场会诊已不在运行，无需终止。`);
    } catch (error) {
      setNotice(`终止「${label}」失败：${error instanceof Error ? error.message : String(error)}。其它模型未受影响。`);
    }
  };
  return (
    <section className="consult-card" data-testid="multi-model-consult-card" aria-label="多模型会诊">
      <div className="consult-card-heading"><IconUsers size={16} /><strong>{title}</strong><span>独立分析 · 只读</span></div>
      {workers.map((item, index) => (
        <div className="consult-worker-line" key={`${index}-${item.modelId}-${item.thinkingLevel ?? ""}`}>
          <button type="button" className="consult-worker-row" data-testid={`consult-worker-${index}`} onClick={() => { setSelected(index); setOpen(true); }}>
            <span className="consult-worker-name" title={item.modelId}>{item.modelName ?? item.modelId}{item.thinkingLevel ? ` · ${item.thinkingLevel}` : ""}</span>
            <span className={`consult-worker-status is-${item.status}`}>{status(item.status)}</span>
            {duration(item) && <small>{duration(item)}</small>}
            <span aria-hidden>›</span>
          </button>
          {canStop(item) && (
            <button
              type="button"
              className="consult-worker-stop"
              data-testid={`consult-stop-${index}`}
              title={`立即终止「${item.modelName ?? item.modelId}」；不结束其它模型`}
              aria-label={`终止模型 ${item.modelName ?? item.modelId}`}
              onClick={() => void stopWorker(index)}
            >终止</button>
          )}
        </div>
      ))}
      {!report && <div className="consult-card-notice">{toolCall.output || (terminal ? "没有收到会诊结果；不能视为已完成多模型校验。" : "等待主模型显式调用，尚无模型结果。")}</div>}
      {report && <button className="consult-card-details" type="button" data-testid="consult-open-details" onClick={() => setOpen(true)}>查看各模型原始答案与工具记录</button>}
      {notice && <div className="consult-followup-notice" role="status">{notice}</div>}
      {open && report && typeof document !== "undefined" && createPortal(
        <dialog ref={dialog} className="consult-dialog" aria-labelledby={`consult-title-${report.id}`} onCancel={() => setOpen(false)}>
          <div className="consult-dialog-heading">
            <div><strong id={`consult-title-${report.id}`}>多模型会诊详情</strong><small>{title}</small></div>
            <button type="button" className="btn consult-dialog-close" aria-label="关闭会诊详情" data-testid="consult-close-details" onClick={() => setOpen(false)}><IconX size={16} /></button>
          </div>
          <div className="consult-dialog-body">
            <div className="consult-tabs" role="tablist" aria-orientation="vertical" aria-label="参与模型">
              {workers.map((item, index) => (
                <button
                  key={`${index}-${item.modelId}-${item.thinkingLevel ?? ""}`}
                  type="button"
                  role="tab"
                  aria-selected={activeIndex === index}
                  className={activeIndex === index ? "consult-tab active" : "consult-tab"}
                  title={item.modelId}
                  onClick={() => setSelected(index)}
                >
                  <span className="consult-tab-name">{item.modelName ?? item.modelId}</span>
                  <span className="consult-tab-meta">
                    <small className="consult-tab-level">思考等级 {item.thinkingLevel ?? "默认"}</small>
                    <small className={`consult-tab-status is-${item.status}`}>{status(item.status)}</small>
                    {duration(item) && <small className="consult-tab-duration">{duration(item)}</small>}
                    {tokens(item) && <small className="consult-tab-tokens">{tokens(item)}</small>}
                  </span>
                </button>
              ))}
            </div>
            <div className="consult-dialog-scroll" role="tabpanel">
              <details className="consult-evidence"><summary>共同任务与补充材料</summary><pre>{report.task}</pre>{report.context && <pre>{report.context}</pre>}</details>
              {worker && <>
                <div className="consult-worker-meta">
                  <span className="consult-worker-meta-name">{worker.modelName ?? worker.modelId}</span>
                  <span>{worker.modelId}</span>
                  <span>思考等级 {worker.thinkingLevel ?? "默认"}</span>
                  <span className={`consult-worker-status is-${worker.status}`}>{status(worker.status)}</span>
                  {duration(worker) && <span>{duration(worker)}</span>}
                  {tokens(worker) && <span>{tokens(worker)}</span>}
                  {canStop(worker) && (
                    <button
                      type="button"
                      className="btn consult-worker-stop"
                      data-testid="consult-stop-active"
                      title="立即终止该模型；不结束整场会诊，其它模型继续"
                      onClick={() => void stopWorker(activeIndex)}
                    >终止该模型</button>
                  )}
                </div>
                {worker.error && <div className="consult-error" role="status">{worker.error}</div>}
                <h3>原始回答</h3>
                <pre className="consult-answer" data-testid="consult-raw-answer">{worker.answer || "尚未收到文字回答。"}</pre>
                <h3>实际工具记录（{(worker.tools ?? []).length}）</h3>
                {!(worker.tools ?? []).length && <p className="consult-muted">该模型尚未调用工具。不能据此声称它已读取或测试项目。</p>}
                {(worker.tools ?? []).map((trace) => <details className="consult-trace" key={trace.id}>
                  <summary>{trace.name} · {traceStatusLabel(trace.status, interrupted)}</summary>
                  <pre>{JSON.stringify(trace.arguments, null, 2)}</pre>
                  {trace.output && <pre>{trace.output}</pre>}
                  {trace.outputTruncated && <small>工具输出预览已截断；上方模型原始回答未截断。</small>}
                </details>)}
              </>}
            </div>
          </div>
          <div className="consult-dialog-footer">
            <small className="consult-dialog-footnote">未自动仲裁，不以多数票判定正确。</small>
            <div className="consult-dialog-footer-actions">
              {!canFollowUp && <small className="consult-followup-hint">{!sameTask ? "该会诊属于其它任务：切回原任务后可继续调查。" : "该参与者没有返回回答，也没有失败原因，暂无可引用的发现。"}</small>}
              <button type="button" className="btn primary consult-followup" data-testid="consult-followup" disabled={!canFollowUp} onClick={() => {
                if (!report || !worker || !canFollowUp) return;
                if (useAppStore.getState().activeTaskId !== report.taskId) return;
                const statusText = status(worker.status);
                useAppStore.getState().appendComposer(followUpText(report, worker, statusText, interrupted));
                setNotice(`已把「${worker.modelName ?? worker.modelId}」的会诊发现（报告 ${report.id}）追加到输入框，请核对后再发送；不会自动发出。`);
                setOpen(false);
              }}>基于此发现继续调查</button>
            </div>
          </div>
        </dialog>, document.body,
      )}
    </section>
  );
}
