import { ExecutionUsageMetrics } from "./ExecutionUsageMetrics";
import { modelBadgeTitle, type ModelBadge } from "@/lib/modelBadge";
import type { HeaderUsage } from "@/lib/subagentHeaderMetrics";
import { IconChevronLeft } from "@/components/common/icons";
import "./SubagentChatHeader.css";

interface Props {
  taskTitle: string;
  name: string;
  subagentId: string;
  stateLabel: string;
  stateTone: "running" | "queued" | "completed" | "failed" | "cancelled";
  model?: ModelBadge;
  usage?: HeaderUsage;
  elapsed?: string;
  elapsedTitle: string;
  onBack: () => void;
}

/** Shared with the real Electron layout regression, no store or parent totals. */
export default function SubagentChatHeader(props: Props): React.JSX.Element {
  return <header className="subagent-detail-header">
    <div className="subagent-detail-identity">
      <div className="subagent-detail-heading">
        <button type="button" className="icon-btn" title="返回任务对话" aria-label="返回任务对话" onClick={props.onBack}><IconChevronLeft size={15} /></button>
        <button type="button" className="subagent-chat-crumb" title={`返回任务对话：${props.taskTitle}`} onClick={props.onBack}>{props.taskTitle}</button>
        <span className="subagent-chat-sep" aria-hidden>/</span>
        <strong className="subagent-detail-name" title={`${props.name} · id: ${props.subagentId}`}>{props.name}</strong>
      </div>
      <div className="subagent-detail-status">
        <span className={`ro-label ro-label--${props.stateTone}`}>{props.stateLabel}</span>
        {props.model && <span className="ro-model" title={modelBadgeTitle(props.model)}>{props.model.label}</span>}
      </div>
    </div>
    <ExecutionUsageMetrics usage={props.usage} elapsed={props.elapsed} elapsedTitle={props.elapsedTitle}/>
    <button type="button" className="icon-btn subagent-detail-close" title="关闭子代理对话" aria-label="关闭子代理对话" onClick={props.onBack}>✕</button>
  </header>;
}
