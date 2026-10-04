/**
 * 新建项目（Template-first 创建流程）renderer 纯函数层。
 * 只放可单测的纯计算：draft 计数、模板摘要、registries 构造、创建前 payload 校验。
 * IPC / React 状态留在 NewProjectModal 内，避免 JSX 里串大量业务逻辑。
 */
import {
  buildProjectCreationPlan,
  validateProjectName,
  type ProjectCreationDraft,
  type TemplateCapabilityRegistries,
} from "@shared/project-template";
import {
  MAX_PROJECT_RESOURCE_BUDGET_CHARS,
  MIN_PROJECT_RESOURCE_BUDGET_CHARS,
  type ProjectCreateRequest,
} from "@shared/project-domain";

export interface DraftCapabilityCounts {
  experts: number;
  skills: number;
  connectors: number;
  mcps: number;
}

/** 从 draft 计算能力计数（模板摘要「默认配置」行） */
export function countDraftCapabilities(
  draft: Pick<ProjectCreationDraft, "experts" | "skills" | "connectors" | "mcps">,
): DraftCapabilityCounts {
  return {
    experts: draft.experts.length,
    skills: draft.skills.length,
    connectors: draft.connectors.length,
    mcps: draft.mcps.length,
  };
}

export interface TemplateSummaryLine {
  counts: DraftCapabilityCounts;
}

/**
 * 格式化模板摘要行数据：仅能力计数（Expert/Skill/Connector/MCP）。
 * Mode/Tag 不是 Project 属性，不混入 Project Capability Summary（实施文档 §20）。
 */
export function buildTemplateSummary(
  draft: Pick<ProjectCreationDraft, "experts" | "skills" | "connectors" | "mcps">,
): TemplateSummaryLine {
  return { counts: countDraftCapabilities(draft) };
}

/** 拼接「默认配置」一行文案，如「2 个专家 · 3 个技能 · 0 个连接器 · 1 个 MCP」 */
export function formatTemplateSummaryLine(summary: TemplateSummaryLine): string {
  const { counts } = summary;
  return `${counts.experts} 个专家 · ${counts.skills} 个技能 · ${counts.connectors} 个连接器 · ${counts.mcps} 个 MCP`;
}

export interface CapabilityRegistryInput {
  experts?: readonly { id: string; enabled?: boolean }[];
  skills?: readonly { id: string; enabled?: boolean }[];
  connectors?: readonly { id: string; installed?: boolean; enabled?: boolean }[];
  mcps?: readonly { id: string; installed?: boolean; disabled?: boolean }[];
}

/**
 * 构造 resolver 使用的注册表（TemplateCapabilityRegistries）。
 * - 未安装/显式停用的能力 → enabled/available/installed=false，resolver 会把它归入 missing + warning
 * - 传 undefined 的维度保持 undefined（resolver 保守视为全部具备）
 */
export function buildCapabilityRegistries(input: CapabilityRegistryInput): TemplateCapabilityRegistries {
  return {
    experts: input.experts?.map((item) => ({ id: item.id, enabled: item.enabled })),
    skills: input.skills?.map((item) => ({ id: item.id, enabled: item.enabled })),
    connectors: input.connectors?.map((item) => ({
      id: item.id,
      available: item.installed !== false,
      connected: item.enabled !== false && item.installed !== false,
    })),
    mcps: input.mcps?.map((item) => ({ id: item.id, installed: item.installed !== false && item.disabled !== true })),
  };
}

/** 预算字段兜底：NaN / 越界 → 夹到 [MIN, MAX]（防御脏输入） */
export function clampResourceBudgetChars(raw: number): number {
  if (!Number.isFinite(raw)) return MIN_PROJECT_RESOURCE_BUDGET_CHARS;
  return Math.min(MAX_PROJECT_RESOURCE_BUDGET_CHARS, Math.max(MIN_PROJECT_RESOURCE_BUDGET_CHARS, Math.round(raw)));
}

export type CreationPlanResult =
  | { ok: true; request: ProjectCreateRequest; warnings: string[] }
  | { ok: false; error: string };

/**
 * 提交前校验 + 物化创建计划：
 * 1) validateProjectName（trim / 空 / 40 上限）
 * 2) 预算夹取（NaN / 越界防御）
 * 3) buildProjectCreationPlan(draft, registries) → request + warnings
 * 校验失败返回 { ok:false, error }，不 throw。
 */
export function validateAndBuildCreationPlan(
  draft: ProjectCreationDraft,
  registries?: TemplateCapabilityRegistries,
): CreationPlanResult {
  const nameCheck = validateProjectName(draft.name);
  if (!nameCheck.ok) return { ok: false, error: nameCheck.error };
  const plan = buildProjectCreationPlan(
    { ...draft, name: nameCheck.name, resourceBudgetChars: clampResourceBudgetChars(draft.resourceBudgetChars) },
    registries,
  );
  return { ok: true, request: plan.request, warnings: plan.warnings };
}
