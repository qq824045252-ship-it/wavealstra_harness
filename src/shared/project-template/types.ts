/** Project Template 纯共享层：类型契约（禁止 import electron / node 模块） */

import type { ProjectPoliciesDto } from "../project-domain";

/** 模板静态定义（UI 模板卡片 / 解析 / 落库的单一事实来源） */
export interface ProjectTemplateDefinition {
  id: string;
  name: string;
  description: string;
  icon?: string;
  /** 中文 markdown 工作说明；无则省略（空白模板） */
  instructions?: string;
  /**
   * 模板对「新任务」的推荐值（仅新任务默认提示）。
   *
   * 它们是 creation-time / new-task hints，不是 Project Runtime 属性：
   * - 绝不持久化为 Project 字段（welcomeMode / modePresetId 只属于 Task）
   * - Project 从不拥有 Mode/Tag，Task 是 Mode/Tag 的唯一运行时所有者
   * - 只经 project.templateId → 模板注册表反查后作为首个任务的默认值
   */
  taskSuggestions?: {
    recommendedModeId?: string;
    recommendedPresetId?: string;
  };
  /** 模板附带的项目策略建议（Partial，未写的维度在解析时视为空） */
  policies?: Partial<ProjectPoliciesDto>;
  /** 建议初始资源（仅供 UI 展示/预填，本轮不参与落库） */
  suggestedResources?: Array<{ kind: "text" | "file" | "url"; title: string; value: string }>;
}

/** 用户机器上可查询的能力注册表（UI 传入；缺省时解析器保守视为全部已具备） */
export interface TemplateCapabilityRegistries {
  experts?: readonly { id: string; enabled?: boolean }[];
  skills?: readonly { id: string; enabled?: boolean }[];
  connectors?: readonly { id: string; available?: boolean; connected?: boolean }[];
  mcps?: readonly { id: string; installed?: boolean }[];
}

/** 模板 + 注册表解析后的完整结果（缺失能力只进 missing 列表与 warnings，绝不 throw） */
export interface ResolvedProjectTemplate {
  template: ProjectTemplateDefinition;
  /** 空串表示无 instructions */
  instructions: string;
  /** 解析出的新任务推荐（仅作新建任务默认提示；空白模板为 undefined） */
  taskSuggestion?: {
    recommendedModeId?: string;
    recommendedPresetId?: string;
  };
  resolvedExperts: string[];
  missingExperts: string[];
  resolvedSkills: string[];
  missingSkills: string[];
  resolvedConnectors: string[];
  missingConnectors: string[];
  resolvedMcps: string[];
  missingMcps: string[];
  /** 每个缺失能力一条中文 warning，如 "Penpot MCP 尚未配置" */
  warnings: string[];
}

/** 新建项目表单草稿（UI 状态与模板默认值合并后的中间形态） */
export interface ProjectCreationDraft {
  name: string;
  /** 空串 = 未填 */
  description: string;
  templateId: string;
  instructions: string;
  experts: string[];
  skills: string[];
  connectors: string[];
  mcps: string[];
  resourceBudgetChars: number;
  /** 用户是否手动改过对应字段（false 时切换模板会用新模板默认值覆盖） */
  dirty: {
    name: boolean;
    description: boolean;
    instructions: boolean;
    experts: boolean;
    skills: boolean;
    connectors: boolean;
    mcps: boolean;
    budget: boolean;
  };
}
