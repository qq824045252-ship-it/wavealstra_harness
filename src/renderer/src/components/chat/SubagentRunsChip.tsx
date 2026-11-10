/**
 * SubagentRunsChip — 聊天顶栏的「子代理查看」入口（替代原场景 chip）。
 *
 * 数据源与侧栏「概览」完全同一个 hook（useSubagentRuns），所以两处的名字、模型、
 * 用量、状态与工作目录不会出现两套说法；差异只允许是排版。
 *
 * 交互：点 chip 打开面板 → 点某一行进入该子代理的对话页（与主聊天共用外壳，
 * 页内任务处可导航回父任务）。排队中的条目还没建子会话，不给可点入口。
 */
import { useRef, useState } from "react";
import { useAppStore } from "@/store/appStore";
import { useDismissOnClickOutside } from "@/hooks/useDismissOnClickOutside";
import { useSubagentRuns } from "@/hooks/useSubagentRuns";
import { formatElapsed } from "@/components/artifact/overview/overviewRuntime";
import { formatTokenCount } from "@shared/token-format";
import { childDurationLabel } from "@/lib/subagentDetails";
import { IconChevronDown, IconChevronRight, IconUsers } from "@/components/common/icons";

type PopoverRow = {
  id: string;
  name: string;
  kind: "running" | "queued" | "done";
  stateLabel: string;
  /** 实际工作目录（有则显示「工作目录: …」） */
  cwd?: string;
  /** 没有 cwd 时的副行文案（任务首行/结果摘要） */
  text?: string;
  tokens?: number;
  duration?: string;
  openable: boolean;
};

const DOT_CLASS: Record<PopoverRow["kind"], string> = {
  running: "ro-dot--running",
  queued: "ro-dot--idle",
  done: "ro-dot--ok",
};

export default function SubagentRunsChip({ taskId }: { taskId: string }): React.JSX.Element | null {
  const runs = useSubagentRuns(taskId);
  const openSubagentView = useAppStore((s) => s.openSubagentView);
  const [open, setOpen] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  useDismissOnClickOutside(open, () => setOpen(false), anchorRef);

  // 没有任何子代理时不占位置：顶栏这一格只在有内容时出现
  if (runs.total === 0) return null;

  const rows: PopoverRow[] = [
    ...runs.vm.runningSubagents.map((row): PopoverRow => ({
      id: row.id,
      name: row.name,
      kind: "running",
      stateLabel: "运行中",
      cwd: row.cwd,
      text: row.work,
      tokens: row.usage?.contextTokens,
      duration: formatElapsed(row.elapsedMs),
      openable: true,
    })),
    ...runs.vm.queuedSubagents.map((row): PopoverRow => ({
      id: row.id,
      name: row.name,
      kind: "queued",
      stateLabel: "排队中",
      cwd: row.cwd,
      text: row.task,
      openable: false,
    })),
    ...runs.vm.doneSubagents.map((row): PopoverRow => ({
      id: row.id,
      name: row.name,
      kind: "done",
      stateLabel: row.state === "completed" ? "已完成" : row.state === "failed" ? "失败" : row.state === "unknown" ? "已结束" : "已取消",
      cwd: row.cwd,
      text: row.summary,
      tokens: row.usage?.contextTokens,
      duration: childDurationLabel(row.durationMs),
      openable: true,
    })),
  ];

  const label = runs.running > 0
    ? `${runs.running} 个运行中`
    : runs.queued > 0
      ? `${runs.queued} 个排队`
      : `${runs.total} 个子代理`;

  return (
    <div className="subagent-chip-anchor" ref={anchorRef}>
      <button
        type="button"
        className={`chat-mode-chip subagent-chip${runs.running > 0 ? " is-running" : ""}`}
        title="查看子代理（与右侧概览同一数据源）"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <IconUsers size={13} />
        <span>{label}</span>
        <IconChevronDown size={12} />
      </button>

      {open && (
        <div className="subagent-popover" role="dialog" aria-label="子代理列表">
          <div className="subagent-popover-head">
            <span className="subagent-popover-title">{runs.total} 个子智能体</span>
            {runs.vm.subagentConcurrency && runs.queued > 0 && (
              <span className="subagent-popover-concurrency">
                {runs.vm.subagentConcurrency.workers} 并发 · {runs.queued} 排队
              </span>
            )}
            <button
              type="button"
              className="icon-btn"
              title="收起"
              onClick={() => setOpen(false)}
            >
              <IconChevronDown size={13} style={{ transform: "rotate(180deg)" }} />
            </button>
          </div>
          {runs.vm.subagentConcurrency?.serializedReason && runs.queued > 0 && (
            <div className="subagent-popover-reason">{runs.vm.subagentConcurrency.serializedReason}</div>
          )}
          <ul className="subagent-popover-list">
            {rows.map((row) => (
              <li key={row.id}>
                <button
                  type="button"
                  className="subagent-popover-row"
                  disabled={!row.openable}
                  title={row.openable ? "打开该子代理的对话" : "排队中：子会话还没开始"}
                  onClick={() => {
                    if (!row.openable) return;
                    setOpen(false);
                    openSubagentView(taskId, row.id);
                  }}
                >
                  <span className={`ro-dot ${DOT_CLASS[row.kind]}`} aria-hidden />
                  <span className="subagent-popover-main">
                    <span className="subagent-popover-line">
                      <span className="subagent-popover-name">{row.name}</span>
                      <span className="subagent-popover-metrics">
                        {row.tokens !== undefined && row.tokens > 0 && (
                          <span title="上下文用量">{formatTokenCount(row.tokens)}</span>
                        )}
                        {row.duration && <span title="耗时">{row.duration}</span>}
                        <span className="subagent-popover-state">{row.stateLabel}</span>
                      </span>
                    </span>
                    <span className="subagent-popover-sub" title={row.cwd ?? row.text}>
                      {row.cwd ? `工作目录: ${row.cwd}${row.kind === "running" ? " · 可继续" : ""}` : row.text}
                    </span>
                  </span>
                  {row.openable && <IconChevronRight size={13} className="subagent-popover-chevron" />}
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
