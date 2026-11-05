/**
 * modelBadge.ts — 模型「怎么显示」的纯展示层工具（不判断模型能否使用）。
 *
 * 事实来源：
 * - 子代理：运行时记录里的 resolvedModel（三级优先级解析值）/ actualModel（子进程实测值）；
 * - 主 Agent：任务级 activeModelId + 模型目录 name；
 * - 历史工具结果：output 里的「Resolved model: …」「Observed model: …」证据行。
 *
 * 约定：无法可靠确定模型时返回 undefined（宁缺毋伪造）；短标签只用于布局，
 * 完整标识与来源永远保留在 title 上，避免把截断值当成事实。
 */

export interface ModelBadge {
  /** 面板上的短标签（模型目录 name 优先，其次 id 末段） */
  label: string;
  /** 完整模型标识（provider/model 或子进程实测 id），用于 title */
  full: string;
  /** 来源文案：手动指定 / 继承父模型 / 角色指定 / 子代理默认 / 全局默认 */
  source?: string;
  /** 附加说明（如运行时解析值），仅用于 title */
  note?: string;
}

/** 子代理模型来源（与 SubagentSummaryDto.modelSource 对齐，额外容忍 role-map 旧值）。 */
const MODEL_SOURCE_LABELS: Record<string, string> = {
  invocation: "手动指定",
  parent: "继承父模型",
  role: "角色指定",
  "role-map": "角色映射",
  default: "子代理默认",
  global: "全局默认",
};

export function modelSourceLabel(source?: string | null): string | undefined {
  const key = (source ?? "").trim();
  if (!key) return undefined;
  return MODEL_SOURCE_LABELS[key] ?? key;
}

/** 调用方可能传入的占位值（不是真实模型 id）。 */
const SENTINEL_MODEL_LABELS: Record<string, string> = {
  "inherit-parent": "继承父模型",
  inherit: "继承父模型",
  auto: "自动选择",
  diverse: "多模型并行",
};

const MODEL_LABEL_MAX = 24;

/** 模型短标签：目录 name 优先，其次 id 末段（provider/model → model）；超长截断。 */
export function shortModelLabel(model: string, displayName?: string | null): string {
  const id = (model ?? "").trim();
  if (!id) return "";
  const sentinel = SENTINEL_MODEL_LABELS[id.toLowerCase()];
  if (sentinel) return sentinel;
  const name = (displayName ?? "").trim();
  const fromId = id.split(/[/\\:]/).filter(Boolean).pop() ?? id;
  const base = name || fromId;
  return base.length > MODEL_LABEL_MAX ? `${base.slice(0, MODEL_LABEL_MAX - 1)}…` : base;
}

/** 构造展示用 badge；模型标识为空时返回 undefined。 */
export function buildModelBadge(
  model: string | undefined | null,
  opts: { displayName?: string | null; source?: string | null; note?: string | null } = {},
): ModelBadge | undefined {
  const full = (model ?? "").trim();
  if (!full) return undefined;
  const label = shortModelLabel(full, opts.displayName);
  if (!label) return undefined;
  const source = (opts.source ?? "").trim() || undefined;
  const note = (opts.note ?? "").trim() || undefined;
  return { label, full, ...(source ? { source } : {}), ...(note ? { note } : {}) };
}

/** badge 的 title 文案：完整模型 + 来源 + 附加说明。 */
export function modelBadgeTitle(badge: ModelBadge): string {
  const parts = [`模型：${badge.full}`];
  if (badge.note) parts.push(badge.note);
  if (badge.source) parts.push(`来源：${badge.source}`);
  return parts.join(" · ");
}

export interface SubagentModelEvidenceLike {
  /** 调用时请求/记录里的模型 */
  model?: string | null;
  /** 三级优先级解析值 */
  resolvedModel?: string | null;
  /** 子进程实测值（Pi 消息上的 model） */
  actualModel?: string | null;
  modelSource?: string | null;
}

/**
 * 子代理 badge：实测值优先（真实在跑什么），缺失回退解析值/记录值。
 * resolved 与 actual 不一致时保留解析值到 note（不静默丢掉差异）。
 */
export function subagentModelBadge(
  record: SubagentModelEvidenceLike,
  names?: Record<string, string> | null,
): ModelBadge | undefined {
  const resolved = (record.resolvedModel ?? record.model ?? "").trim();
  const actual = (record.actualModel ?? "").trim();
  const identified = actual || resolved;
  if (!identified) return undefined;
  const displayName = names?.[identified] ?? (resolved ? names?.[resolved] : undefined);
  const note = actual && resolved && actual !== resolved ? `解析值 ${resolved}` : undefined;
  return buildModelBadge(identified, {
    displayName,
    source: modelSourceLabel(record.modelSource),
    note,
  });
}

/**
 * 从子代理工具结果里解析真实模型证据行（getResultOutput 会把证据放在正文前部）。
 * 只认结构化证据行，不猜测正文里的模型名。
 */
export function parseModelEvidenceFromOutput(output?: string | null): string | undefined {
  const text = output ?? "";
  if (!text) return undefined;
  const resolved = text.match(/Resolved model:\s*([^\s;]+)/i);
  if (resolved?.[1]) return resolved[1];
  const observed = text.match(/Observed model:\s*([^\s;]+)/i);
  return observed?.[1];
}
