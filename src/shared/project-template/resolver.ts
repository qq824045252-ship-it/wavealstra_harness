/** 模板解析：把模板定义 + 本机能力注册表解析为可直接展示/落库的结果（纯函数） */

import { getProjectTemplate } from "./builtins";
import type {
  ProjectTemplateDefinition,
  ResolvedProjectTemplate,
  TemplateCapabilityRegistries,
} from "./types";

interface RegistrySet {
  experts: Set<string>;
  skills: Set<string>;
  connectors: Set<string>;
  mcps: Set<string>;
}

/** 把注册表归一化为「可用 id 集合」（大小写不敏感；显式禁用项视为不可用） */
function collectRegistries(registries?: TemplateCapabilityRegistries): RegistrySet | null {
  if (!registries) return null;
  const collect = (
    items: readonly { id: string; enabled?: boolean; available?: boolean; connected?: boolean; installed?: boolean }[] | undefined,
    disabledIf?: (item: { enabled?: boolean; available?: boolean; connected?: boolean; installed?: boolean }) => boolean,
  ): Set<string> => {
    const set = new Set<string>();
    for (const item of items ?? []) {
      const id = item.id.trim();
      if (!id) continue;
      if (disabledIf?.(item)) continue;
      set.add(id.toLowerCase());
    }
    return set;
  };
  return {
    experts: collect(registries.experts, (item) => item.enabled === false),
    skills: collect(registries.skills, (item) => item.enabled === false),
    connectors: collect(registries.connectors, (item) => item.available === false || item.connected === false),
    mcps: collect(registries.mcps, (item) => item.installed === false),
  };
}

function resolveList(
  referenced: string[] | undefined,
  available: Set<string> | null,
  warning: (id: string) => string,
): { resolved: string[]; missing: string[]; warnings: string[] } {
  const resolved: string[] = [];
  const missing: string[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();
  for (const raw of referenced ?? []) {
    const id = raw.trim();
    if (!id || seen.has(id.toLowerCase())) continue;
    seen.add(id.toLowerCase());
    // 未提供注册表时保守处理：全部视为已具备（离线创建流程也能走）
    if (available === null || available.has(id.toLowerCase())) {
      resolved.push(id);
    } else {
      missing.push(id);
      warnings.push(warning(id));
    }
  }
  return { resolved, missing, warnings };
}

/**
 * Project Template 与 Blueprint 共用的 capability 解析核心。
 * optional/missing 只形成 warnings，调用方仍可继续物化可用部分。
 */
export function resolveCapabilityReferences(
  refs: { experts?: string[]; skills?: string[]; connectors?: string[]; mcps?: string[] },
  registries?: TemplateCapabilityRegistries,
): {
  resolved: { experts: string[]; skills: string[]; connectors: string[]; mcps: string[] };
  missing: { experts: string[]; skills: string[]; connectors: string[]; mcps: string[] };
  warnings: string[];
} {
  const available = collectRegistries(registries);
  const experts = resolveList(refs.experts, available?.experts ?? null, (id) => `${id} 专家尚未配置`);
  const skills = resolveList(refs.skills, available?.skills ?? null, (id) => `${id} 技能尚未配置`);
  const connectors = resolveList(refs.connectors, available?.connectors ?? null, (id) => `${id} 连接器尚未配置`);
  const mcps = resolveList(refs.mcps, available?.mcps ?? null, (id) => `${id} MCP 尚未配置`);
  return {
    resolved: {
      experts: experts.resolved,
      skills: skills.resolved,
      connectors: connectors.resolved,
      mcps: mcps.resolved,
    },
    missing: {
      experts: experts.missing,
      skills: skills.missing,
      connectors: connectors.missing,
      mcps: mcps.missing,
    },
    warnings: [...experts.warnings, ...skills.warnings, ...connectors.warnings, ...mcps.warnings],
  };
}

function policyReferences(template: ProjectTemplateDefinition): {
  experts: string[];
  skills: string[];
  connectors: string[];
  mcps: string[];
} {
  return {
    experts: template.policies?.expert?.recommended ?? [],
    skills: template.policies?.skill?.prefer ?? [],
    connectors: template.policies?.connector?.recommended ?? [],
    mcps: template.policies?.mcp?.allow ?? [],
  };
}

/**
 * 解析模板 + 注册表。
 * - 未知 templateId → throw（UI 只传已知 id，属调用方 bug）
 * - 缺失能力只进 missing 列表与 warnings，绝不 throw
 * - 未提供 registries（保守）：模板引用的 id 全部视为 resolved，warnings 为空
 */
export function resolveProjectTemplate(
  templateId: string,
  registries?: TemplateCapabilityRegistries,
): ResolvedProjectTemplate {
  const template = getProjectTemplate(templateId);
  if (!template) throw new Error(`未知项目模板：${templateId}`);

  const refs = policyReferences(template);
  const capabilities = resolveCapabilityReferences(refs, registries);

  return {
    template,
    instructions: template.instructions ?? "",
    taskSuggestion: template.taskSuggestions?.recommendedModeId
      ? { ...template.taskSuggestions }
      : undefined,
    resolvedExperts: capabilities.resolved.experts,
    missingExperts: capabilities.missing.experts,
    resolvedSkills: capabilities.resolved.skills,
    missingSkills: capabilities.missing.skills,
    resolvedConnectors: capabilities.resolved.connectors,
    missingConnectors: capabilities.missing.connectors,
    resolvedMcps: capabilities.resolved.mcps,
    missingMcps: capabilities.missing.mcps,
    warnings: capabilities.warnings,
  };
}
