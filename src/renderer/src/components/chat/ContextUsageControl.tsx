import { useMemo, useRef, useState } from "react";
import { useDismissOnClickOutside } from "@/hooks/useDismissOnClickOutside";
import { useAppStore } from "@/store/appStore";
import type { ChatMessage } from "@/types";
import { IconX } from "@/components/common/icons";
import ManualCompactionControl from "./ManualCompactionControl";

const RING_SIZE = 16;
const RING_STROKE = 2.2;
const RING_R = (RING_SIZE - RING_STROKE) / 2;
const RING_C = 2 * Math.PI * RING_R;

export interface ContextCategory {
  key: string;
  label: string;
  color: string;
  tokens: number;
  percent: number;
}

function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0";
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return `${Math.round(n)}`;
}

/** 无激活任务时的稳定空数组：zustand selector 必须返回稳定引用，否则 useSyncExternalStore 死循环 */
const EMPTY_MESSAGES: ChatMessage[] = [];

function estimateChars(messages: ChatMessage[]): { dialog: number; tools: number } {
  let dialog = 0;
  let tools = 0;
  for (const m of messages) {
    const blocks = [...m.blocks, ...(m.finalBlocks ?? [])];
    for (const b of blocks) {
      if (b.type === "text" || b.type === "thinking") dialog += b.text.length;
      else if (b.type === "callout") dialog += (b.title?.length ?? 0) + b.text.length;
      else if (b.type === "detail") dialog += b.title.length + b.content.length;
      else if (b.type === "file_table") {
        dialog += (b.title?.length ?? 0) + b.rows.length * 24;
      } else if (b.type === "tool") {
        const t = b.toolCall;
        tools +=
          (t.tool?.length ?? 0) +
          (t.summary?.length ?? 0) +
          (t.detail?.length ?? 0) +
          (t.output?.length ?? 0);
      }
    }
    if (m.attachments?.length) dialog += m.attachments.length * 32;
  }
  return { dialog, tools };
}

/** 用会话消息启发式拆分用量；总量以 pi 回报为准，比例供弹窗展示 */
function buildCategories(
  messages: ChatMessage[],
  usedTokens: number | null,
  windowTokens: number,
): ContextCategory[] {
  // 技能后：MCP、连接器各自单独一行（不再合并为「连接器及MCP」）
  const palette = [
    { key: "system", label: "系统提示词", color: "#34c759" },
    { key: "tools", label: "工具及子智能体", color: "#f5a623" },
    { key: "dialog", label: "对话消息", color: "#8b5cf6" },
    { key: "skills", label: "技能", color: "#3b82f6" },
    { key: "mcp", label: "MCP", color: "#94a3b8" },
    { key: "connectors", label: "连接器", color: "#64748b" },
  ] as const;

  const used = usedTokens ?? 0;
  if (used <= 0) {
    return palette.map((p) => ({ ...p, tokens: 0, percent: 0 }));
  }

  const { dialog: dialogChars, tools: toolChars } = estimateChars(messages);
  // chars/4 ≈ tokens
  let dialogEst = dialogChars / 4;
  let toolsEst = toolChars / 4;
  // 系统提示等固定成本粗估（无更细数据时占一部分）
  let systemEst = Math.min(used * 0.12, Math.max(800, windowTokens * 0.02));
  let skillsEst = 0;
  let mcpEst = 0;
  let connectorsEst = 0;

  const raw = systemEst + toolsEst + dialogEst + skillsEst + mcpEst + connectorsEst;
  if (raw <= 0) {
    dialogEst = used;
  } else {
    // 按比例缩放到真实 used
    const scale = used / raw;
    systemEst *= scale;
    toolsEst *= scale;
    dialogEst *= scale;
    skillsEst *= scale;
    mcpEst *= scale;
    connectorsEst *= scale;
  }

  const values = [systemEst, toolsEst, dialogEst, skillsEst, mcpEst, connectorsEst];
  // 消除浮点误差，把差额塞进对话
  const sum = values.reduce((a, b) => a + b, 0);
  values[2] += used - sum;

  return palette.map((p, i) => {
    const tokens = Math.max(0, values[i] ?? 0);
    const percent = Math.round((tokens / windowTokens) * 1000) / 10;
    return { ...p, tokens, percent };
  });
}

interface Props {
  executing?: boolean;
}

export default function ContextUsageControl({ executing = false }: Props): React.JSX.Element {
  const activeTaskId = useAppStore((s) => s.activeTaskId);
  const compacting = useAppStore(s => Boolean(s.activeTaskId && s.compactionByTask[s.activeTaskId]?.status === "running"));
  const activeModelId = useAppStore((s) => s.activeModelId);
  const models = useAppStore((s) => s.models);
  const contextUsedTokens = useAppStore((s) => s.contextUsedTokens);
  const contextEstimated = useAppStore((s) => s.contextEstimated);
  const contextWindowTokens = useAppStore((s) => s.contextWindowTokens);
  const contextCacheHitRate = useAppStore((s) => s.contextCacheHitRate);
  const contextInputTokens = useAppStore((s) => s.contextInputTokens);
  const contextCacheReadTokens = useAppStore((s) => s.contextCacheReadTokens);
  const contextOutputTokens = useAppStore((s) => s.contextOutputTokens);
  const messages = useAppStore((s) => {
    const task = s.tasks.find((t) => t.id === s.activeTaskId);
    return task?.messages ?? EMPTY_MESSAGES;
  });

  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  useDismissOnClickOutside(open, () => setOpen(false), anchorRef);

  const activeModel = models.find((m) => m.id === activeModelId);
  const windowTokens = (contextUsedTokens != null ? contextWindowTokens : activeModel?.contextWindow) || contextWindowTokens || 128_000;
  const used = contextUsedTokens;
  const unknown = used == null;
  const pct = unknown
    ? 0
    : Math.min(100, Math.round((used / windowTokens) * 1000) / 10);
  const dashOffset = RING_C * (1 - pct / 100);

  const usedLabel = unknown ? "—" : (contextEstimated ? "约 " : "") + formatTokens(used);
  const winLabel = formatTokens(windowTokens);
  const usageText = unknown
    ? `上下文窗口 ${winLabel}`
    : `${pct}% · ${usedLabel} / ${winLabel} 上下文已使用`;

  const summaryText = compacting ? "正在压缩上下文 · " + usageText : usageText;
  const cacheUnknown = contextCacheHitRate == null;
  const cachePct = cacheUnknown ? null : Math.round(contextCacheHitRate! * 1000) / 10;
  const cacheColor =
    cachePct == null ? "var(--fg-muted)" : cachePct >= 60 ? "#34c759" : "#f5a623";

  const tokenDetail = [
    { key: "input", label: "输入", tokens: contextInputTokens, color: "#f5a623" },
    { key: "cacheRead", label: "缓存读", tokens: contextCacheReadTokens, color: "#34c759" },
    { key: "output", label: "输出", tokens: contextOutputTokens, color: "#8b5cf6" },
  ];
  const hasTokenDetail = tokenDetail.some((t) => t.tokens != null);

  const categories = useMemo(
    () => buildCategories(messages, used, windowTokens),
    [messages, used, windowTokens],
  );

  const ringColor =
    pct >= 90 ? "var(--danger, #e05a5a)" : pct >= 70 ? "#f5a623" : "var(--primary, #3b82f6)";

  return (
    <div className="context-usage-anchor" ref={anchorRef}>
      <button
        type="button"
        className={`context-usage-ring-btn ${executing || compacting ? "live" : ""} ${open ? "open" : ""}`}
        aria-label={summaryText}
        title={summaryText}
        aria-busy={compacting}
        onMouseEnter={() => setHover(true)}
        onMouseLeave={() => setHover(false)}
        onClick={() => setOpen((v) => !v)}
      >
        <svg
          className="context-usage-ring"
          width={RING_SIZE}
          height={RING_SIZE}
          viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
          aria-hidden
        >
          <circle
            className="context-usage-ring-track"
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RING_R}
            fill="none"
            strokeWidth={RING_STROKE}
          />
          <circle
            className="context-usage-ring-fill"
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RING_R}
            fill="none"
            strokeWidth={RING_STROKE}
            stroke={ringColor}
            strokeLinecap="round"
            strokeDasharray={RING_C}
            strokeDashoffset={unknown ? RING_C : dashOffset}
            transform={`rotate(-90 ${RING_SIZE / 2} ${RING_SIZE / 2})`}
          />
        </svg>
      </button>

      {hover && !open && (
        <div className="context-usage-tooltip" role="tooltip">
          {summaryText}
        </div>
      )}

      {open && (
        <div className="context-usage-popup" onClick={(e) => e.stopPropagation()}>
          <div className="context-usage-popup-head">
            <span className="context-usage-popup-title">上下文用量</span>
            <button
              type="button"
              className="context-usage-popup-close"
              aria-label="关闭"
              onClick={() => setOpen(false)}
            >
              <IconX size={14} />
            </button>
          </div>

          <div className="context-usage-popup-summary">
            <span className="context-usage-popup-pct">
              {unknown ? "—" : `${contextEstimated ? "约 " : ""}${pct}%`}
            </span>
            <span className="context-usage-popup-used">
              已使用 {usedLabel}/{winLabel}
            </span>
          </div>

          <div className="context-usage-popup-cache">
            <span className="context-usage-popup-cache-label">缓存命中率</span>
            <span
              className="context-usage-popup-cache-val"
              style={{ color: cacheColor }}
              title={
                cacheUnknown
                  ? "暂无调用数据"
                  : "cacheRead / (input + cacheRead + cacheWrite)，覆盖本会话全部模型调用"
              }
            >
              {cachePct == null ? "—" : `${cachePct}%`}
            </span>
          </div>

          {hasTokenDetail && (
            <div className="context-usage-popup-tokens">
              {tokenDetail.map((t) => (
                <span key={t.key} className="context-usage-popup-token-item">
                  <span className="context-usage-popup-token-dot" style={{ background: t.color }} />
                  <span className="context-usage-popup-token-label">{t.label}</span>
                  <span className="context-usage-popup-token-val">
                    {t.tokens == null ? "—" : formatTokens(t.tokens)}
                  </span>
                </span>
              ))}
            </div>
          )}

          <div className="context-usage-popup-bar" aria-hidden>
            {categories.map((c) => {
              const w = windowTokens > 0 ? (c.tokens / windowTokens) * 100 : 0;
              if (w <= 0) return null;
              return (
                <span
                  key={c.key}
                  className="context-usage-popup-seg"
                  style={{ width: `${w}%`, background: c.color }}
                />
              );
            })}
            {unknown || pct <= 0 ? <span className="context-usage-popup-seg empty" /> : null}
          </div>

          <div className="settings-row-desc">以下分类为界面历史估算，不代表压缩后的实际请求构成。</div>
          <ul className="context-usage-popup-list">
            {categories.map((c) => (
              <li key={c.key} className="context-usage-popup-item">
                <span className="context-usage-popup-dot" style={{ background: c.color }} />
                <span className="context-usage-popup-label">{c.label}</span>
                <span className="context-usage-popup-val">
                  {unknown ? "—" : `${c.percent}%`}
                </span>
              </li>
            ))}
          </ul>
          {activeTaskId && <ManualCompactionControl key={activeTaskId} taskId={activeTaskId} executing={executing} contextWindow={windowTokens} />}
        </div>
      )}
    </div>
  );
}
