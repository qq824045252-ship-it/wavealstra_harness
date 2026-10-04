/**
 * Project Config Rail Detail 纯逻辑层（实施规划 §5/§6/§9）。
 * 只放可单测的纯计算：分区元数据 / 搜索 / Draft 克隆 / 选项划分。
 * 不依赖 window / DOM；Policy 状态转换复用 @shared/project-policy-editor。
 */
import type { ProjectPoliciesDto } from "@shared/project-domain";
import type { ProjectConfigSection } from "./projectConfigRail";

export interface ProjectConfigDetailMeta {
  /** Detail 标题（如「项目指令」「专家」） */
  title: string;
  /** Detail 顶部说明 */
  description: string;
  /** 搜索框 placeholder */
  searchPlaceholder?: string;
}

/** 各分区 Detail 元数据（§11-§14） */
export const PROJECT_DETAIL_META: Record<ProjectConfigSection, ProjectConfigDetailMeta> = {
  instructions: {
    title: "项目指令",
    description: "定义 AI 在这个项目中长期遵循的目标、背景、原则和工作方式。",
  },
  experts: {
    title: "专家",
    description: "为这个项目准备长期可用的专家。",
    searchPlaceholder: "搜索专家",
  },
  skills: {
    title: "技能",
    description: "为这个项目准备长期可用的技能。",
    searchPlaceholder: "搜索技能",
  },
  connectors: {
    title: "连接器",
    description: "允许这个项目使用已经配置好的外部服务。",
    searchPlaceholder: "搜索连接器",
  },
  mcp: {
    title: "MCP",
    description: "选择这个项目允许使用的 MCP 工具来源。",
    searchPlaceholder: "搜索 MCP",
  },
};

/** §16：Capability Detail 顶部统一弱提示（Summary 不显示） */
export const PROJECT_CAPABILITY_SCOPE_HINT =
  "项目配置定义长期可用范围；具体任务的 Mode 与场景可能进一步限制能力。";

export interface CapabilitySearchItem {
  id: string;
  name: string;
  description?: string;
}

/** §12：搜索至少匹配 name / description（category 无 Registry 元数据时不引入第二套） */
export function filterCapabilityItems<T extends CapabilitySearchItem>(
  items: readonly T[],
  query: string | null | undefined,
): T[] {
  const normalized = (query ?? "").trim().toLowerCase();
  if (!normalized) return [...items];
  return items.filter(
    (item) =>
      item.name.toLowerCase().includes(normalized) ||
      (item.description ?? "").toLowerCase().includes(normalized),
  );
}

/** §18：已配置但 Registry 中已消失的项统一标记「不可用」，不自动删除 ID */
export const UNAVAILABLE_LABEL = "不可用";

/**
 * Draft 深拷贝：进入 Detail 时复制 Project 当前 Policies（§6），
 * 只在 Save 时写回；Detail 关闭后销毁（§20）。
 */
export function clonePolicies(policies: ProjectPoliciesDto): ProjectPoliciesDto {
  return {
    expert: {
      allow: [...policies.expert.allow],
      deny: [...policies.expert.deny],
      recommended: [...policies.expert.recommended],
    },
    skill: {
      prefer: [...policies.skill.prefer],
      demote: [...policies.skill.demote],
      hide: [...policies.skill.hide],
      allow: [...policies.skill.allow],
    },
    connector: {
      allow: [...policies.connector.allow],
      deny: [...policies.connector.deny],
      recommended: [...policies.connector.recommended],
    },
    mcp: {
      mode: policies.mcp.mode,
      allow: [...policies.mcp.allow],
      deny: [...policies.mcp.deny],
    },
  };
}

export interface CapabilityOption extends CapabilitySearchItem {
  /** Registry 中不存在（配置残留） */
  missing?: boolean;
  /** 附加状态标签（如 Connector 的已连接/未连接） */
  statusLabel?: string;
  /** 图标（emoji / skill icon） */
  emoji?: string;
}

/** §9：Available = 全 Registry 中未被当前策略引用的项 */
export function splitCapabilityOptions(
  all: readonly CapabilityOption[],
  referencedIds: readonly string[],
): { available: CapabilityOption[] } {
  const referenced = new Set(referencedIds);
  return { available: all.filter((item) => !referenced.has(item.id)) };
}

/**
 * §13/§14：Connector / MCP 全局管理入口映射（文案与目标页，不允许串）。
 * Rail 只做 Project 选择 + Policy；全局安装/OAuth/账号/server 配置在全局 Hub 页。
 * Expert / Skill 无全局管理入口（undefined）。
 */
export const CAPABILITY_MANAGE_ENTRY: Record<
  "experts" | "skills" | "connectors" | "mcp",
  { label: string; page: "connectors" | "mcp" } | undefined
> = {
  experts: undefined,
  skills: undefined,
  connectors: { label: "管理连接器", page: "connectors" },
  mcp: { label: "管理 MCP", page: "mcp" },
};
