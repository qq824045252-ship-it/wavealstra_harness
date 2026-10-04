/** 新建项目创建流程：草稿管理 + 模板策略物化（纯函数，可直接交给 window.api.db.createProject） */

import { DEFAULT_PROJECT_RESOURCE_BUDGET_CHARS, type ProjectPoliciesDto, type ProjectCreateRequest } from "../project-domain";
import { getProjectTemplate } from "./builtins";
import { resolveProjectTemplate } from "./resolver";
import type { ProjectCreationDraft, ProjectTemplateDefinition, TemplateCapabilityRegistries } from "./types";

/** 模板引用的能力 id（draft 预填 / 切换模板默认值） */
function templateReferences(template: ProjectTemplateDefinition): {
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

function requireTemplate(templateId: string): ProjectTemplateDefinition {
  const template = getProjectTemplate(templateId);
  if (!template) throw new Error(`未知项目模板：${templateId}`);
  return template;
}

/** 归一化 id 列表：trim、去空、去重（大小写不敏感，保序） */
export function normalizeIdList(values: readonly string[] | undefined): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of values ?? []) {
    const id = raw.trim();
    if (!id || seen.has(id.toLowerCase())) continue;
    seen.add(id.toLowerCase());
    out.push(id);
  }
  return out;
}

/** 新建草稿：模板默认值全部进入 draft，dirty 全 false */
export function createDraftFromTemplate(templateId: string): ProjectCreationDraft {
  const template = requireTemplate(templateId);
  const refs = templateReferences(template);
  return {
    name: "",
    description: "",
    templateId,
    instructions: template.instructions ?? "",
    experts: refs.experts,
    skills: refs.skills,
    connectors: refs.connectors,
    mcps: refs.mcps,
    resourceBudgetChars: DEFAULT_PROJECT_RESOURCE_BUDGET_CHARS,
    dirty: {
      name: false,
      description: false,
      instructions: false,
      experts: false,
      skills: false,
      connectors: false,
      mcps: false,
      budget: false,
    },
  };
}

/**
 * 切换模板：
 * - dirty=true 的字段保留用户值；dirty=false 的字段换成新模板默认值
 * - name/description 永不因切换模板改变
 * - 模板不声明 resourceBudgetChars，故预算字段保持原值
 */
export function applyTemplateToDraft(draft: ProjectCreationDraft, templateId: string): ProjectCreationDraft {
  const template = requireTemplate(templateId);
  const refs = templateReferences(template);
  return {
    ...draft,
    templateId,
    instructions: draft.dirty.instructions ? draft.instructions : (template.instructions ?? ""),
    experts: draft.dirty.experts ? draft.experts : refs.experts,
    skills: draft.dirty.skills ? draft.skills : refs.skills,
    connectors: draft.dirty.connectors ? draft.connectors : refs.connectors,
    mcps: draft.dirty.mcps ? draft.mcps : refs.mcps,
  };
}

/** 草稿是否有任何用户改动 */
export function isDraftDirty(draft: ProjectCreationDraft): boolean {
  return Object.values(draft.dirty).some(Boolean);
}

/** 项目名称校验：trim；空 → 错误；> 40 字符 → 错误（与现有 UI NAME_MAX=40 一致） */
export function validateProjectName(raw: string): { ok: true; name: string } | { ok: false; error: string } {
  const name = raw.trim();
  if (!name) return { ok: false, error: "项目名称不能为空" };
  if (name.length > 40) return { ok: false, error: "项目名称不能超过 40 字符" };
  return { ok: true, name };
}

/**
 * 物化创建计划：把 draft 的用户选择合并进模板 policies。
 * - experts/connectors → allow（保留模板 recommended 中未被用户移除的项为 recommended）
 * - skills → prefer；mcps → allow
 * - 不写 deny/hide（deny 属高级策略，本轮不进入简单 UI 默认值）
 */
export function buildProjectCreationPlan(
  draft: ProjectCreationDraft,
  registries?: TemplateCapabilityRegistries,
): { request: ProjectCreateRequest; warnings: string[] } {
  const template = requireTemplate(draft.templateId);
  const recommendedExperts = new Set(normalizeIdList(template.policies?.expert?.recommended).map((id) => id.toLowerCase()));
  const recommendedConnectors = new Set(normalizeIdList(template.policies?.connector?.recommended).map((id) => id.toLowerCase()));

  const experts = normalizeIdList(draft.experts);
  const connectors = normalizeIdList(draft.connectors);

  const policies: ProjectPoliciesDto = {
    expert: {
      allow: experts,
      deny: [],
      recommended: experts.filter((id) => recommendedExperts.has(id.toLowerCase())),
    },
    skill: {
      prefer: normalizeIdList(draft.skills),
      demote: [],
      hide: [],
      allow: [],
    },
    connector: {
      allow: connectors,
      deny: [],
      recommended: connectors.filter((id) => recommendedConnectors.has(id.toLowerCase())),
    },
    mcp: {
      mode: template.policies?.mcp?.mode === "soft" ? "soft" : "hard",
      allow: normalizeIdList(draft.mcps),
      deny: [],
    },
  };

  return {
    request: {
      name: draft.name,
      description: draft.description || undefined,
      instructions: draft.instructions || undefined,
      templateId: draft.templateId || undefined,
      policies,
      resourceBudgetChars: draft.resourceBudgetChars,
    },
    warnings: resolveProjectTemplate(draft.templateId, registries).warnings,
  };
}
