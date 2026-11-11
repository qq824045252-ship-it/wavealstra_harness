import WebSearchCard from "./WebSearchCard";
import MultiModelConsultCard from "./MultiModelConsultCard";
import { useState } from "react";
import type { ToolCall } from "@/types";
import {
  IconAlert,
  IconCheck,
  IconChevronRight,
  IconCircle,
} from "@/components/common/icons";

const STATUS_TEXT: Record<ToolCall["status"], string> = {
  pending_approval: "",
  running: "执行中",
  success: "",
  error: "失败",
  denied: "已拒绝",
};

const STATUS_CLASS: Record<ToolCall["status"], string> = {
  pending_approval: "warning",
  running: "",
  success: "success",
  error: "error",
  denied: "",
};


interface Props {
  messageId: string;
  toolCall: ToolCall;
}

function acpPermissionLabel(option: NonNullable<ToolCall["acpPermissionOptions"]>[number]): string {
  const raw = option.name.trim();
  if (option.kind.startsWith("reject")) return "拒绝";
  if (/bypass/i.test(raw)) return "切换自动放行";
  if (!option.kind.endsWith("always")) return option.kind.startsWith("allow") ? "允许一次" : raw;

  const scope = /all projects?/i.test(raw)
    ? "所有项目"
    : /(?:this|current) project/i.test(raw)
      ? "当前项目"
      : /(?:this|current) session/i.test(raw)
        ? "本次会话"
        : /(?:this|current) command/i.test(raw)
          ? "此命令"
          : "";
  const quoted = raw.match(/[`'“"]([^`'”"]+)[`'”"]/u)?.[1]?.trim();
  const allowTarget = raw.match(/always allow\s+(.+?)(?:\s+commands?|\s+in\s+|$)/i)?.[1]
    ?.replace(/[`'“”"]/gu, "")
    .trim();
  const target = quoted || allowTarget || "";
  const compactTarget = target.length > 22 ? `${target.slice(0, 21)}…` : target;

  if (scope && compactTarget) return `${scope} · ${compactTarget}`;
  if (scope) return `${scope}始终允许`;
  if (compactTarget) return `始终允许 · ${compactTarget}`;
  return "始终允许";
}

export default function ToolCallCard({ messageId, toolCall }: Props): React.JSX.Element {
  const needsApproval = toolCall.status === "pending_approval";
  const [open, setOpen] = useState(needsApproval);

  const body = [toolCall.detail, toolCall.output].filter(Boolean).join("\n\n");
  const isAcpPermission = toolCall.approvalKind === "acp";

  const statusBeforeSummary = toolCall.status === "running";
  const displaySummary = toolCall.status === "running"
    ? toolCall.summary.replace(/^Ran\s+/i, "")
    : toolCall.status === "pending_approval" && /^(approval needed|需要授权)$/i.test(toolCall.summary.trim())
      ? "旧版待处理记录"
      : toolCall.summary;
  const statusIcon =
    toolCall.status === "success" ? (
      <IconCheck size={13} />
    ) : toolCall.status === "running" ? (
      <IconCircle size={11} />
    ) : (
      <IconAlert size={13} />
    );

  if (toolCall.webSearch) return <WebSearchCard toolCall={toolCall} />;

  if (toolCall.tool === "multi_model_consult") return <MultiModelConsultCard toolCall={toolCall} />;

  if (needsApproval && isAcpPermission) {
    return (
      <div className="tool-row tool-row--pending_approval tool-row--acp-approval">
        <div className="approval-acp-shell">
          <button
            type="button"
            className="approval-acp-header"
            aria-expanded={open}
            onClick={() => setOpen(!open)}
          >
            <span className="tool-row-icon"><IconAlert size={13} /></span>
            <span className="approval-acp-heading">需要授权</span>
            <span className="approval-acp-subtitle">选择允许范围后继续</span>
            <span className={`approval-acp-chevron${open ? " open" : ""}`}>
              <IconChevronRight size={12} />
            </span>
          </button>

          {open && (
            <div className="approval-acp-body">
              {body && <div className="tool-row-output approval-acp-output">{body}</div>}
              <div className="approval-external-actions">
                {(toolCall.acpPermissionOptions ?? []).map((option) => {
                  const rejecting = option.kind.startsWith("reject");
                  const persistent = option.kind.endsWith("always");
                  const bypass = /bypass/i.test(option.name);
                  return (
                    <button
                      key={option.optionId}
                      className={`btn approval-acp-action${rejecting ? " approval-acp-action--reject danger-ghost" : bypass ? " approval-acp-action--bypass" : persistent ? " approval-acp-action--persistent" : " approval-acp-action--once"}`}
                      title={option.name}
                      disabled={!toolCall.externalRunId}
                      onClick={() => {
                        if (!toolCall.externalRunId) return;
                        void window.api?.externalAgent?.resolvePermission?.({
                          runId: toolCall.externalRunId,
                          toolCallId: toolCall.id,
                          optionId: option.optionId,
                        });
                      }}
                    >
                      {acpPermissionLabel(option)}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className={`tool-row tool-row--${toolCall.status}`} data-tool-call-id={toolCall.id}
      data-parent-tool-call-id={toolCall.parentToolCallId} style={toolCall.parentToolCallId ? { marginLeft: 14 } : undefined}>
      <button className="tool-row-header" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className={`tool-row-icon ${toolCall.status === "running" ? "running" : ""}`}>
          {statusIcon}
        </span>
        {statusBeforeSummary && (
          <span className={`tool-row-status ${STATUS_CLASS[toolCall.status]}`}>
            {STATUS_TEXT[toolCall.status]}
          </span>
        )}
        {toolCall.parentToolCallId && <span className="tool-row-status" title={`父调用：${toolCall.parentToolCallId}`}>↳ 子调用</span>}
        <span className="tool-row-summary">{displaySummary}</span>
        {!statusBeforeSummary && STATUS_TEXT[toolCall.status] && (
          <span className={`tool-row-status ${STATUS_CLASS[toolCall.status]}`}>
            {STATUS_TEXT[toolCall.status]}
          </span>
        )}
        <span
          className="tool-row-icon"
          style={{ transform: open ? "rotate(90deg)" : undefined }}
        >
          <IconChevronRight size={12} />
        </span>
      </button>

      {open && body && <div className="tool-row-output">{body}</div>}

    </div>
  );
}
