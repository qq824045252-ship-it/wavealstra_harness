/** 内置 Project 模板（纯共享层，7 个；id 为固定 kebab-case，后续 UI 直接依赖） */

import { defaultModePresetId } from "../mode-profile";
import type { ProjectTemplateDefinition } from "./types";

/*
 * capability 引用 id 真实性说明（2026-08-13 仓库侦察）：
 * - 真实 id（本机/mybuddy 市场存在，解析时能命中）：
 *   · 专家 code-review-expert、product-management、ui-designer（mybuddyskills-main/experts/ 目录名）
 *   · MCP penpot（src/shared/mode-profile.ts DESIGN_PROVIDER_MCP_IDS + 用户 ~/.mybuddy/plugins/mcp/mcp.json）
 *   · 技能 github（mybuddyskills-main/skills/github）
 * - 约定值 id（本机不存在同名能力，resolver 会 graceful degrade → missing + warning）：
 *   · debug-expert / requirement-analyst / research-analyst / office-assistant / knowledge-curator
 *   · testing / documentation / requirements / roadmap / web-search / report-writing / docx / xlsx / pptx / ui-design / diagram / note-taking
 *   · 连接器 web-search（产品有 WebAccess(pi-web-access) 能力，但 Connector 市场无该 id）
 *   · MCP pi（Pi 适配器扩展 id 为 pi-mcp-adapter，MCP 策略按用户 mcp.json 服务器名匹配，无固定 "pi" 服务器名）
 *   说明：skill 的 prefer 名单在运行时是模糊匹配（id/name/description 子串），
 *   如 git→github、docx→minimax-docx、pptx→pptx-generator、diagram→drawio，仍能命中真实技能。
 */

/** 模板列表（顺序固定：产品研发、软件开发、调研分析、办公协作、设计创意、长期知识项目、空白项目最后） */
export const PROJECT_TEMPLATES: readonly ProjectTemplateDefinition[] = [
  {
    id: "product-development",
    name: "产品研发",
    description: "从需求、设计、验证到交付",
    icon: "📦",
    taskSuggestions: { recommendedModeId: "working", recommendedPresetId: defaultModePresetId("working") },
    instructions: `# 产品研发模式

## 角色
你是产品研发伙伴：协助拆解需求、设计方案、验证可行性并推动交付。

## 工作方式
- 先澄清目标用户与核心问题，再进入方案设计；重要假设用最小验证快速检验。
- 需求变更时同步更新项目说明与任务清单，保持「需求 → 设计 → 验证 → 交付」的闭环。

## 交付标准
- 每个里程碑有明确的验收标准与产出物（需求文档、原型、验证结论）。
- 收尾时输出简要复盘：目标达成情况、关键决策与遗留风险。`,
    policies: {
      expert: { allow: [], deny: [], recommended: ["product-management", "requirement-analyst"] },
      skill: { prefer: ["requirements", "roadmap"], demote: [], hide: [], allow: [] },
    },
  },
  {
    id: "software-development",
    name: "软件开发",
    description: "开发、Review、测试与持续维护",
    icon: "💻",
    taskSuggestions: { recommendedModeId: "coding", recommendedPresetId: "bugfix-test" },
    instructions: `# 软件开发模式

## 角色
你是软件开发工程师：按规范完成功能开发、代码评审、测试与持续维护。

## 工作方式
- 动手前先明确任务范围与验收标准；改动遵循仓库既有约定，保持最小变更。
- 完成后自查：类型检查、相关测试、关键路径走查；涉及他人代码先说明理由。

## 交付标准
- 代码可读、有注释覆盖业务意图；测试通过且覆盖新增行为。
- 维护期记录已知问题与后续优化项，避免技术债无声累积。`,
    policies: {
      expert: { allow: [], deny: [], recommended: ["code-review-expert", "debug-expert"] },
      skill: { prefer: ["github", "testing", "documentation"], demote: [], hide: [], allow: [] },
      mcp: { mode: "hard", allow: ["pi"], deny: [] },
    },
  },
  {
    id: "research-analysis",
    name: "调研分析",
    description: "搜索资料、分析信息并形成结论",
    icon: "🔍",
    taskSuggestions: { recommendedModeId: "working", recommendedPresetId: defaultModePresetId("working") },
    instructions: `# 调研分析模式

## 角色
你是调研分析师：系统搜集资料、交叉验证信息并形成可执行的结论。

## 工作方式
- 先定义调研问题与结论框架，再按来源分类收集；关键结论标注来源与时效。
- 对矛盾信息做交叉验证，明确区分事实、推断与不确定项。

## 交付标准
- 输出结构化报告：背景 → 发现 → 分析 → 结论 → 建议，附资料来源清单。
- 未验证的信息明确标注，不臆造数据与结论。`,
    policies: {
      expert: { allow: [], deny: [], recommended: ["research-analyst"] },
      skill: { prefer: ["web-search", "report-writing"], demote: [], hide: [], allow: [] },
      connector: { allow: [], deny: [], recommended: ["web-search"] },
    },
  },
  {
    id: "office-collaboration",
    name: "办公协作",
    description: "文档、表格、演示与日常工作",
    icon: "📎",
    taskSuggestions: { recommendedModeId: "working", recommendedPresetId: defaultModePresetId("working") },
    instructions: `# 办公协作模式

## 角色
你是办公助手：负责文档、表格、演示与日常事务的整理与产出。

## 工作方式
- 先确认用途与受众，再选择合适载体（文档/表格/演示）与格式规范。
- 数据类工作保留口径说明，模板类工作保持风格统一，方便复用。

## 交付标准
- 产出内容结构清晰、格式规范、无错别字与明显疏漏。
- 涉及敏感信息时先与用户确认范围，不擅自外发。`,
    policies: {
      expert: { allow: [], deny: [], recommended: ["office-assistant"] },
      skill: { prefer: ["docx", "xlsx", "pptx"], demote: [], hide: [], allow: [] },
    },
  },
  {
    id: "design-creative",
    name: "设计创意",
    description: "UI、网页、流程图与视觉设计",
    icon: "🎨",
    taskSuggestions: { recommendedModeId: "working", recommendedPresetId: "web-prototype" },
    instructions: `# 设计创意模式

## 角色
你是设计创意伙伴：覆盖 UI、网页、流程图与视觉设计，兼顾美观与可用性。

## 工作方式
- 先对齐设计目标与约束（品牌、受众、平台），再探索方案；重要设计给出对比选项。
- 善用设计类 MCP（如 Penpot / Draw.io）与可视化工具落地产物。

## 交付标准
- 交付物包含设计说明：意图、交互要点与实现建议，便于后续开发还原。
- 保持视觉一致性：色彩、间距、字体遵循统一规范。`,
    policies: {
      expert: { allow: [], deny: [], recommended: ["ui-designer"] },
      skill: { prefer: ["ui-design", "diagram"], demote: [], hide: [], allow: [] },
      mcp: { mode: "hard", allow: ["penpot"], deny: [] },
    },
  },
  {
    id: "long-term-knowledge",
    name: "长期知识项目",
    description: "持续整理资料、经验、规范与知识",
    icon: "📚",
    taskSuggestions: { recommendedModeId: "working", recommendedPresetId: defaultModePresetId("working") },
    instructions: `# 长期知识项目模式

## 角色
你是知识管理员：持续整理资料、经验、规范与知识，让项目成为可复用的知识资产。

## 工作方式
- 建立清晰的分类与命名规范，新知识即时归档，避免堆积后无法回溯。
- 定期沉淀：把零散经验整理为规范、清单或知识库条目。

## 交付标准
- 知识条目带来源、时间与适用场景；检索路径清晰，新人可快速上手。
- 每轮整理结束给出新增/更新摘要与下一步建议。`,
    policies: {
      expert: { allow: [], deny: [], recommended: ["knowledge-curator"] },
      skill: { prefer: ["note-taking", "documentation"], demote: [], hide: [], allow: [] },
    },
  },
  {
    id: "blank",
    name: "空白项目",
    description: "不使用 Blueprint，从零开始",
    icon: "▫",
    // blank：无 instructions、无 policies、无 taskSuggestions —— 由用户完全自定义
  },
];

const TEMPLATE_BY_ID = new Map(PROJECT_TEMPLATES.map((template) => [template.id, template]));

/** 全部内置模板（拷贝，调用方可安全修改） */
export function listProjectTemplates(): ProjectTemplateDefinition[] {
  return PROJECT_TEMPLATES.map((template) => ({ ...template }));
}

export function getProjectTemplate(id: string): ProjectTemplateDefinition | undefined {
  const template = TEMPLATE_BY_ID.get(id);
  return template ? { ...template } : undefined;
}

export function isBlankTemplate(id: string): boolean {
  return id === "blank";
}
