import { useEffect, useMemo, useRef, useState } from "react";
import { useDismissOnClickOutside } from "@/hooks/useDismissOnClickOutside";
import { useAppStore } from "@/store/appStore";
import type { ChatMessage, Skill } from "@/types";
import { IconX } from "@/components/common/icons";
import { formatTokenCount } from "@shared/token-format";
import type { AssemblyTraceDto } from "@shared/mode-profile";
import type { McpStatusSnapshotDto, RuntimeContextInspectionDto } from "@shared/agent-ipc";
import ManualCompactionControl from "./ManualCompactionControl";

const RING_SIZE = 16;
const RING_STROKE = 2.2;
const RING_R = (RING_SIZE - RING_STROKE) / 2;
const RING_C = 2 * Math.PI * RING_R;

/**
 * 字符 → token 的统一口径：约 4 个拉丁字符 ≈ 1 token。
 * 所有「按字符估算 token」的分类都必须走这个常量，不要在组件里重复写 /4。
 */
const CHARS_PER_TOKEN = 4;

export interface ContextCategory {
  key: string;
  label: string;
  color: string;
  /** 估算 token 数；null = 该分类没有可用数据来源（界面显示「—」，不伪装成 0） */
  tokens: number | null;
  /** tokens / contextWindow，一位小数；tokens 为 null 时为 null */
  percent: number | null;
}

/** 无激活任务时的稳定空数组：zustand selector 必须返回稳定引用，否则 useSyncExternalStore 死循环 */
const EMPTY_MESSAGES: ChatMessage[] = [];
const EMPTY_SKILLS: Skill[] = [];

function estimateChars(messages: ChatMessage[]): { dialog: number; tools: number } {
  let dialog = 0;
  let tools = 0;
  for (const m of messages) {
    const blocks = [...(m.blocks ?? []), ...(m.finalBlocks ?? [])];
    for (const b of blocks) {
      if (b.type === "text" || b.type === "thinking") dialog += b.text?.length ?? 0;
      else if (b.type === "callout") dialog += (b.title?.length ?? 0) + (b.text?.length ?? 0);
      else if (b.type === "detail") dialog += (b.title?.length ?? 0) + (b.content?.length ?? 0);
      else if (b.type === "file_table") {
        // 表格进上下文的其实是行文本，不是「一行 24 字符」的占位常数
        dialog += (b.title?.length ?? 0);
        for (const row of b.rows ?? []) dialog += (row.file?.length ?? 0) + (row.summary?.length ?? 0);
      } else if (b.type === "tool") {
        const t = b.toolCall;
        tools +=
          (t?.tool?.length ?? 0) +
          (t?.summary?.length ?? 0) +
          (t?.detail?.length ?? 0) +
          (t?.output?.length ?? 0);
      }
    }
    // 用户侧附属信息：这些内容确实进入请求，属于对话消息
    if (m.terminalContext && Number.isFinite(m.terminalContext.charCount)) {
      dialog += Math.max(0, m.terminalContext.charCount);
    }
    if (m.attachments?.length) {
      for (const a of m.attachments) dialog += (a.name?.length ?? 0) + (a.path?.length ?? 0);
    }
    if (m.taskReferences?.length) {
      for (const r of m.taskReferences) {
        dialog += r.title?.length ?? 0;
        for (const f of r.files ?? []) dialog += (f.name?.length ?? 0) + (f.path?.length ?? 0);
      }
    }
    if (m.selectionLabels?.length) {
      for (const label of m.selectionLabels) dialog += label?.length ?? 0;
    }
  }
  return { dialog, tools };
}

/** 装配检视里可归因的字符：system = 除技能目录外的全部段落，skill = 技能目录段落。 */
export interface AssemblyChars {
  systemChars: number;
  skillChars: number;
  /** 主进程最终允许的可见技能名（skillFilter.visible） */
  visibleSkills: string[];
}

export function measureAssemblyChars(assembly: AssemblyTraceDto | null | undefined): AssemblyChars | null {
  if (!assembly || !Array.isArray(assembly.segments)) return null;
  let systemChars = 0;
  let skillChars = 0;
  for (const segment of assembly.segments) {
    const chars = Number.isFinite(segment?.chars) ? Math.max(0, segment.chars) : 0;
    if (segment?.source === "skill") skillChars += chars;
    else systemChars += chars;
  }
  const visible = assembly.skillFilter?.visible;
  return {
    systemChars,
    skillChars,
    visibleSkills: Array.isArray(visible) ? visible : [],
  };
}

/**
 * 技能目录段只能拿到「整段字符数」，连接器没有独立段落（连接器 = CLI + 配套技能）。
 * 因此按可见目录条目的字符占比把实测目录字符拆成「技能 / 连接器」：
 * - 目录为空 → 连接器贡献确定是 0；
 * - 可见技能名一个都解析不到 → 无法归因，连接器返回 null（界面显示「—」）。
 * 条目格式来源：主进程 SkillPolicy.formatSkillCatalogSection（- **名称**：描述）。
 */
export function splitSkillCatalogChars(
  skillChars: number,
  visibleNames: string[],
  skills: Skill[],
): { skills: number; connectors: number | null } {
  const total = Number.isFinite(skillChars) ? Math.max(0, skillChars) : 0;
  const names = visibleNames.filter((name): name is string => typeof name === "string");
  if (names.length === 0) return { skills: total, connectors: 0 };

  const byName = new Map((skills ?? []).map((skill) => [skill.name, skill]));
  let allWeight = 0;
  let connectorWeight = 0;
  let resolved = 0;
  for (const name of names) {
    const skill = byName.get(name);
    if (!skill) continue;
    resolved += 1;
    const descriptionChars = skill.description?.length ? skill.description.length : 4; // "无描述"
    const weight = Math.max(8, 6 + name.length + descriptionChars);
    allWeight += weight;
    if ((skill.source ?? "").startsWith("connector:")) connectorWeight += weight;
  }
  if (resolved === 0 || allWeight <= 0) return { skills: total, connectors: null };
  const connectors = total * (connectorWeight / allWeight);
  return { skills: total - connectors, connectors };
}

export interface CategoryInput {
  messages: ChatMessage[];
  usedTokens: number | null;
  windowTokens: number;
  /** 装配检视（主进程 inspectRuntimeContext）；取不到时系统提示词退回启发式、技能/连接器显示「—」 */
  assembly?: AssemblyTraceDto | null;
  /** renderer store 的技能列表（含 source，用于把目录字符拆给连接器） */
  skills?: Skill[];
  /**
   * 主进程实测的 MCP 元工具定义字符数（inspection.mcpContext.chars）：有值时优先用它算 MCP 分类。
   * null/undefined = 取不到（该任务没有已打开的 bot），退回 mcpServers 的「确定为零 / 未知」判定。
   */
  mcpChars?: number | null;
  /**
   * 任务级 MCP 会话里「带工具进入上下文」的服务器数（仅在没有 mcpChars 时作为降级判据）：
   * 0 = 确定没有 MCP 工具（成本确定为零，可显示 0%）；undefined/null 或 >0 = 字符数未知（显示「—」）。
   */
  mcpServers?: number | null;
}

/**
 * MCP 分类的 token 口径：主进程实测的元工具定义字符数优先（chars / 4）；
 * 拿不到字符数时，只有「会话里确实没有 MCP 工具」才能确定成本为 0，其余情况是未知（null → 「—」）。
 */
function resolveMcpTokens(input: CategoryInput): number | null {
  const chars = input.mcpChars;
  if (typeof chars === "number" && Number.isFinite(chars) && chars >= 0) {
    return chars / CHARS_PER_TOKEN;
  }
  return input.mcpServers === 0 ? 0 : null;
}

/**
 * 分类占比：口径 = 字符 / 4 ≈ tokens，各分类按 Pi 回报的 used 等比归一，
 * 总和不等于 used 的浮点差额归入「对话消息」。没有数据来源的分类 tokens = null → 界面「—」。
 */
export function buildCategories(input: CategoryInput): ContextCategory[] {
  const palette = [
    { key: "system", label: "系统提示词", color: "#34c759" },
    { key: "tools", label: "工具及子智能体", color: "#f5a623" },
    { key: "dialog", label: "对话消息", color: "#8b5cf6" },
    { key: "skills", label: "技能", color: "#3b82f6" },
    { key: "mcp", label: "MCP", color: "#94a3b8" },
    { key: "connectors", label: "连接器", color: "#64748b" },
  ] as const;

  const used = input.usedTokens;
  const windowTokens =
    Number.isFinite(input.windowTokens) && input.windowTokens > 0 ? input.windowTokens : 0;

  const unknown = (): ContextCategory[] =>
    palette.map((p) => ({ ...p, tokens: null, percent: null }));

  // 没有可用总量（未回报 / 0 / 窗口未知）：全部按「未知」展示，不用 0 冒充
  if (used == null || !Number.isFinite(used) || used <= 0 || windowTokens <= 0) {
    return unknown();
  }

  const { dialog: dialogChars, tools: toolChars } = estimateChars(input.messages);
  const measured = measureAssemblyChars(input.assembly);

  // 系统提示词：装配检视的实测字符优先；拿不到才用启发式兜底（脚注里如实说明）
  let systemTokens = measured
    ? measured.systemChars / CHARS_PER_TOKEN
    : Math.min(used * 0.12, Math.max(800, windowTokens * 0.02));
  let toolsTokens = toolChars / CHARS_PER_TOKEN;

  let skillsTokens: number | null = null;
  let connectorTokens: number | null = null;
  if (measured) {
    const split = splitSkillCatalogChars(measured.skillChars, measured.visibleSkills, input.skills ?? []);
    skillsTokens = split.skills / CHARS_PER_TOKEN;
    connectorTokens = split.connectors == null ? null : split.connectors / CHARS_PER_TOKEN;
  }
  // MCP 元工具定义由主进程实测（inspection.mcpContext.chars）→ 可算真实比例；
  // 只有「会话里确实没有任何 MCP 工具」才确定是 0，其余取不到字符数时保持未知（「—」）。
  let mcpTokens: number | null = resolveMcpTokens(input);

  let dialogTokens = dialogChars / CHARS_PER_TOKEN;
  const knownTotal = (): number =>
    systemTokens + toolsTokens + (skillsTokens ?? 0) + (connectorTokens ?? 0) + (mcpTokens ?? 0);

  if (dialogTokens > 0) {
    // 有可读消息正文：按实测份额等比缩放到 Pi 回报的总量（保持比例，不虚增对话）
    const rawTotal = knownTotal() + dialogTokens;
    const scale = rawTotal > 0 ? used / rawTotal : 1;
    systemTokens *= scale;
    toolsTokens *= scale;
    dialogTokens *= scale;
    if (skillsTokens != null) skillsTokens *= scale;
    if (connectorTokens != null) connectorTokens *= scale;
    if (mcpTokens != null) mcpTokens *= scale;
  } else if (knownTotal() >= used) {
    // 没有消息正文可估，且已知分类已超过总量：把它们等比压回 used，对话记 0
    const scale = knownTotal() > 0 ? used / knownTotal() : 0;
    systemTokens *= scale;
    toolsTokens *= scale;
    if (skillsTokens != null) skillsTokens *= scale;
    if (connectorTokens != null) connectorTokens *= scale;
    if (mcpTokens != null) mcpTokens *= scale;
    dialogTokens = 0;
  } else {
    // 没有消息正文（历史尚未加载完 / 正文不在此进程）：余额是真实上下文，归「对话消息」，
    // 不再像旧实现那样恒等于 0%
    dialogTokens = used - knownTotal();
  }

  // 浮点差额归入对话消息，保证各分类之和 === used（误差远小于 1 token）
  const sum =
    systemTokens + toolsTokens + dialogTokens + (skillsTokens ?? 0) + (connectorTokens ?? 0) + (mcpTokens ?? 0);
  dialogTokens = Math.max(0, dialogTokens + (used - sum));

  const values: Record<string, number | null> = {
    system: systemTokens,
    tools: toolsTokens,
    dialog: dialogTokens,
    skills: skillsTokens,
    mcp: mcpTokens,
    connectors: connectorTokens,
  };

  return palette.map((p) => {
    const raw = values[p.key];
    if (raw == null || !Number.isFinite(raw)) return { ...p, tokens: null, percent: null };
    const tokens = Math.max(0, raw);
    return { ...p, tokens, percent: Math.round((tokens / windowTokens) * 1000) / 10 };
  });
}

/**
 * 百分比文案：null → 「—」；真实小额被四舍五入成 0.0% 时显示「<0.1%」，
 * 避免「有内容却显示 0%」的假象（1.048M 窗口下 1 千 token 才 0.1%）。
 */
export function formatCategoryPercent(category: ContextCategory): string {
  if (category.tokens == null || category.percent == null) return "—";
  if (category.tokens > 0 && category.percent <= 0) return "<0.1%";
  return `${category.percent}%`;
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
  const taskMessages = useAppStore((s) => {
    const task = s.tasks.find((t) => t.id === s.activeTaskId);
    return task?.messages ?? EMPTY_MESSAGES;
  });
  const historyMessages = useAppStore((s) => {
    const task = s.tasks.find((t) => t.id === s.activeTaskId);
    return task?.historyWindow?.messages ?? EMPTY_MESSAGES;
  });
  const skills = useAppStore((s) => s.skills ?? EMPTY_SKILLS);

  const [open, setOpen] = useState(false);
  const [hover, setHover] = useState(false);
  const anchorRef = useRef<HTMLDivElement>(null);
  useDismissOnClickOutside(open, () => setOpen(false), anchorRef);

  // 装配检视：只在弹窗打开时按需读取（只读 IPC，不改主进程状态）
  const [assembly, setAssembly] = useState<AssemblyTraceDto | null>(null);
  /** 主进程实测的 MCP 元工具定义字符数；null = 取不到（该任务没有已打开的 bot）→ 走旧降级口径 */
  const [mcpContext, setMcpContext] = useState<{
    chars: number;
    tools: number;
    servers: number;
  } | null>(null);
  const [mcpUsage, setMcpUsage] = useState<{ servers: number; tools: number } | null>(null);
  const probedTaskRef = useRef<string | null>(null);

  useEffect(() => {
    if (!open || !activeTaskId) return;
    let cancelled = false;
    if (probedTaskRef.current !== activeTaskId) {
      probedTaskRef.current = activeTaskId;
      setAssembly(null);
      setMcpContext(null);
      setMcpUsage(null);
    }
    const agentApi = window.api?.agent;
    if (typeof agentApi?.inspectRuntimeContext === "function") {
      void agentApi
        .inspectRuntimeContext(activeTaskId)
        .then((value: RuntimeContextInspectionDto | undefined) => {
          if (cancelled) return;
          setAssembly(value?.assembly ?? null);
          setMcpContext(value?.mcpContext ?? null);
        })
        .catch(() => {
          if (!cancelled) {
            setAssembly(null);
            setMcpContext(null);
          }
        });
    }
    const mcpApi = window.api?.mcp;
    if (typeof mcpApi?.status === "function") {
      void mcpApi
        .status(activeTaskId)
        .then((snapshot: McpStatusSnapshotDto | null) => {
          if (cancelled) return;
          setMcpUsage(
            snapshot
              ? {
                  servers: (snapshot.servers ?? []).filter((s) => !s.disabled && s.status !== "disabled").length,
                  tools: Number.isFinite(snapshot.totalTools) ? snapshot.totalTools : 0,
                }
              : null,
          );
        })
        .catch(() => {
          if (!cancelled) setMcpUsage(null);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [open, activeTaskId]);

  /** 分页历史（上拉加载）会替换 ChatView 的正文，弹窗要把两段都算进对话消息 */
  const messages = useMemo(() => {
    if (historyMessages === EMPTY_MESSAGES || historyMessages.length === 0) return taskMessages;
    const seen = new Set(taskMessages.map((m) => m.id));
    const earlier = historyMessages.filter((m) => !seen.has(m.id));
    return earlier.length === 0 ? taskMessages : [...earlier, ...taskMessages];
  }, [historyMessages, taskMessages]);

  const activeModel = models.find((m) => m.id === activeModelId);
  const windowTokens = (contextUsedTokens != null ? contextWindowTokens : activeModel?.contextWindow) || contextWindowTokens || 128_000;
  const used = contextUsedTokens;
  const unknown = used == null;
  const pct = unknown
    ? 0
    : Math.min(100, Math.round((used / windowTokens) * 1000) / 10);
  const dashOffset = RING_C * (1 - pct / 100);

  const usedLabel = unknown ? "—" : (contextEstimated ? "约 " : "") + formatTokenCount(used);
  const winLabel = formatTokenCount(windowTokens);
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
    { key: "cacheRead", label: "缓存读取", tokens: contextCacheReadTokens, color: "#34c759" },
    { key: "output", label: "输出", tokens: contextOutputTokens, color: "#8b5cf6" },
  ];
  const hasTokenDetail = tokenDetail.some((t) => t.tokens != null);

  const categories = useMemo(() => {
    // 优先用主进程实测的元工具字符数；只有取不到时才按「有没有 MCP 工具」降级判定
    const mcpServersInContext =
      mcpUsage == null ? undefined : mcpUsage.tools > 0 ? Math.max(mcpUsage.servers, 1) : 0;
    return buildCategories({
      messages,
      usedTokens: used,
      windowTokens,
      assembly,
      skills,
      mcpChars: mcpContext?.chars ?? null,
      mcpServers: mcpServersInContext,
    });
  }, [messages, used, windowTokens, assembly, skills, mcpContext, mcpUsage]);

  const categoryHint = (key: string, tokens: number | null): string | undefined => {
    if (key === "mcp") {
      if (mcpContext) {
        return `MCP 元工具定义 ${mcpContext.chars} 字符（${mcpContext.tools} 个元工具 / ${mcpContext.servers} 个服务），按 ${CHARS_PER_TOKEN} 字符 ≈ 1 token 估算；不含工具调用结果与服务器工具清单的运行时开销。`;
      }
      if (tokens != null) return "本会话没有 MCP 工具进入上下文，成本为 0。";
      const counts = mcpUsage
        ? `当前会话有 ${mcpUsage.servers} 个 MCP 服务 / ${mcpUsage.tools} 个工具；`
        : "";
      return `${counts}主进程未返回该任务的 MCP 元工具字符数（会话未启动），因此不估算 token。`;
    }
    if (tokens != null) return undefined;
    if (key === "skills" || key === "connectors") {
      return "未取到装配检视的技能目录字符数（主进程未返回），无法估算。";
    }
    return undefined;
  };

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
                    {formatTokenCount(t.tokens)}
                  </span>
                </span>
              ))}
            </div>
          )}

          <div className="context-usage-popup-bar" aria-hidden>
            {categories.map((c) => {
              if (c.tokens == null) return null;
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

          <ul className="context-usage-popup-list">
            {categories.map((c) => (
              <li
                key={c.key}
                className="context-usage-popup-item"
                title={categoryHint(c.key, c.tokens)}
              >
                <span className="context-usage-popup-dot" style={{ background: c.color }} />
                <span className="context-usage-popup-label">{c.label}</span>
                <span className="context-usage-popup-val">{formatCategoryPercent(c)}</span>
              </li>
            ))}
          </ul>
          {activeTaskId && <ManualCompactionControl key={activeTaskId} taskId={activeTaskId} executing={executing} contextWindow={windowTokens} />}
        </div>
      )}
    </div>
  );
}
