import { piCodeModeExtraActiveTools } from "../../shared/pi-code-mode";
import type { BuiltinCapabilitiesConfigDto } from "../../shared/builtin-capabilities";
import type {
  AssemblyMcpFilterDto,
  AssemblySegmentDto,
  AssemblyTraceDto,
  ModeArtifactPolicy,
  ModeProfileDto,
  ModeToolPolicy,
  WelcomeMode,
} from "../../shared/mode-profile";
import { emptyArtifactPolicy } from "../../shared/mode-profile";
import type { ResolvedProjectContext } from "../../shared/project-domain";
import {
  formatProjectTodoLine,
  type ProjectPlanSummaryDto,
  type ProjectSharedContextSummary,
  type ProjectTodoStatus,
} from "../../shared/project-domain";
import type { ResolvedCapabilityDto, SourcedSkillPolicy } from "../../shared/runtime-policy";
import {
  filterSkillsForMode,
  formatSkillCatalogSection,
  type SkillRef,
} from "./SkillPolicy";
import { applyPromptContextBudget } from "./PromptContextBudget";
import { isEvidenceSegment } from "./EvidenceBudget";
import {
  MUTATING_BUILTIN_TOOLS,
  MYBUDDY_NATIVE_EXTENSION_TOOL_NAMES,
  NATIVE_CAPABILITY_TOOL_NAMES,
  READONLY_EXTRA_ACTIVE,
  WEB_ACCESS_TOOL_NAMES,
} from "../../shared/native-tools";

export { NATIVE_CAPABILITY_TOOL_NAMES, WEB_ACCESS_TOOL_NAMES };

export interface PromptAssemblyInput {
  welcomeMode: WelcomeMode;
  profile: ModeProfileDto;
  soul: { name: string; alias: string; persona: string };
  expertPrompt?: string | null;
  projectContext?: ResolvedProjectContext | null;
  capabilityTrace?: ResolvedCapabilityDto[];
  /** Original Mode → Project → Tag sources consumed by the real Skill filter. */
  skillPolicySources?: SourcedSkillPolicy[];
  permissionMode: string;
  platform: NodeJS.Platform;
  memoryEnabled: boolean;
  skills?: SkillRef[];
  /** 关闭技能场景过滤 */
  disableSkillFilter?: boolean;
  /** MCP 按模式过滤结果（装配检视） */
  mcpFilter?: AssemblyMcpFilterDto | null;
  /** 选中场景预设的提示词附加段（无 preset = null；仅新会话生效） */
  modePreset?: { id: string; label: string; content: string } | null;
  /** 当前任务工作目录（canonical taskRoot；写入边界说明用） */
  workspace?: string;
  /** 任务显式附加的资料库引用（TaskLibraryReference；不注入整个资料库） */
  libraryAttachments?: string | null;
  /** 已附加到任务的条目 id（Shared Context pinned 段去重用；缺省不去重） */
  libraryAttachedItemIds?: ReadonlySet<string>;
  /** 会话是否具备 library_* 工具（团队/BTW 瞬时会话无工具时，pinned/目录文案不提示不存在的工具） */
  libraryReadable?: boolean;
  /** 资料库目录摘要（可选；无资料时也可给空段说明） */
  libraryCatalog?: string | null;
  /** Workspace Shared Context 分层 digest（Task > Current > Parent > Root；同级隔离；archived 默认排除） */
  workspaceSharedContext?: string | null;
  /** Model-aware budget for the MyBuddy system assembly capsule. */
  contextBudgetChars?: number;
  /** Main sessions supply these facts through the request-only shared evidence budget. */
  ephemeralEvidence?: boolean;
}

function seg(
  id: string,
  title: string,
  source: AssemblySegmentDto["source"],
  content: string,
  sourceId?: string,
): AssemblySegmentDto {
  const text = content.trim();
  return { id, title, source, sourceId, chars: text.length, content: text };
}

/**
 * Project instruction/resource rendering shared by normal and transient Team/BTW sessions.
 * planReadOnly=true 时（团队子会话/BTW）：计划段渲染为只读变体，与工具能力面一致
 * （瞬时会话只挂 list/get，不挂 create/update）。
 */
export function assembleProjectContextSegments(
  projectContext?: ResolvedProjectContext | null,
  opts?: {
    planReadOnly?: boolean;
    excludePinnedItemIds?: ReadonlySet<string>;
    libraryReadable?: boolean;
  },
): AssemblySegmentDto[] {
  if (!projectContext) return [];
  const segments: AssemblySegmentDto[] = [];
  if (projectContext.instructions) {
    segments.push(
      seg(
        "project",
        `项目：${projectContext.project.name}`,
        "project",
        `## 项目长期指令：${projectContext.project.name}\n${clipText(projectContext.instructions, PROJECT_INSTRUCTIONS_MAX_CHARS, "（项目长期指令已截断，完整内容请查阅项目配置）")}`,
        projectContext.sourceId,
      ),
    );
  }
  if (projectContext.sharedContext) {
    const shared = renderProjectSharedContext(projectContext.sharedContext);
    if (shared) {
      segments.push(
        seg("projectSharedContext", `项目上下文：${projectContext.project.name}`, "project", shared, projectContext.sourceId),
      );
    }
    const pinned = renderProjectPinnedRefs(projectContext.sharedContext, opts?.excludePinnedItemIds, opts?.libraryReadable);
    if (pinned) {
      segments.push(
        seg("projectPinnedRefs", `项目固定资料：${projectContext.project.name}`, "project", pinned, projectContext.sourceId),
      );
    }
  }
  if (projectContext.resources.length) {
    segments.push(
      seg(
        "projectResources",
        `项目资源：${projectContext.project.name}`,
        "project",
        [
          "## 项目共享资源",
          ...projectContext.resources.map((resource) =>
            `### ${resource.title} [${resource.kind}]\n${resource.content}`
          ),
        ].join("\n\n"),
        projectContext.sourceId,
      ),
    );
  }
  // Project Memory 已收敛到统一 Memory Kernel；这里不再注入第二份项目记忆摘要。
  // 项目共享计划（Project Plan）：轻量摘要 + 使用指引，不是完整 todo dump。
  // 只有绑定项目的任务才会注入；详细列表经 project_plan_* 工具按需读取。
  if (projectContext.planSummary) {
    segments.push(
      seg(
        "projectPlan",
        `项目共享计划：${projectContext.project.name}`,
        "project",
        renderProjectPlanContext(projectContext.planSummary, !opts?.planReadOnly),
        projectContext.sourceId,
      ),
    );
  }
  return segments;
}

/* ---------------- Project Shared Context 段（预算内、可预测截断） ---------------- */

const SHARED_CONTEXT_GOAL_MAX_CHARS = 300;
const SHARED_CONTEXT_STAGE_MAX_CHARS = 200;
const PINNED_REFS_MAX_ITEMS = 10;
const PINNED_REFS_MAX_CHARS = 1500;
/** 项目长期指令（project 段）预算：超长截断，保留可读性（完整内容在项目配置中） */
const PROJECT_INSTRUCTIONS_MAX_CHARS = 2000;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function clipText(text: string, max: number, suffix: string): string {
  return text.length > max ? `${text.slice(0, max)}…${suffix}` : text;
}

/** Shared Context 段：goal + currentStage（instructions 已由 project 段承载，不重复注入） */
export function renderProjectSharedContext(summary: ProjectSharedContextSummary): string | null {
  const goal = summary.goal?.trim();
  const stage = summary.currentStage?.trim();
  if (!goal && !stage) return null;
  const lines = ["## 项目上下文（长期显式配置）", "这是项目的长期目标与当前阶段（人维护的显式上下文，不是 Agent 记忆）："];
  if (goal) lines.push(`- 项目目标：${clip(goal, SHARED_CONTEXT_GOAL_MAX_CHARS)}`);
  if (stage) lines.push(`- 当前阶段：${clip(stage, SHARED_CONTEXT_STAGE_MAX_CHARS)}`);
  return lines.join("\n");
}

/**
 * BTW 上下文段映射（纯函数，可测试）：
 * - projectPlan/projectMemory → 只读变体重渲染（摘要缺失则移除）；
 * - projectSharedContext/projectPinnedRefs → 用当前上下文重渲染（libraryReadable=false 文案）；
 * - library（catalog）→ 用当前任务项目重算（任务改绑后绝不残留旧项目内容）；
 * - libraryAttachments → 用当前任务重算；
 * - 其余（workspace 过滤后）原样透传。
 */
export function mapBtwProjectContextSegments(
  segments: ReadonlyArray<{ id: string; content: string }>,
  context: ResolvedProjectContext | null,
  opts: { catalog: string | null; attachments: string | null },
): string[] {
  const planSummary = context?.planSummary ?? null;
  const parts = segments
    .filter((s) => s.id !== "workspace")
    .map((s) => {
      if (s.id === "projectPlan") {
        return planSummary ? renderProjectPlanContext(planSummary, false) : null;
      }
      if (s.id === "projectMemory") {
        return null;
      }
      if (s.id === "projectSharedContext") {
        return context?.sharedContext ? renderProjectSharedContext(context.sharedContext) : null;
      }
      if (s.id === "projectPinnedRefs") {
        return context?.sharedContext
          ? renderProjectPinnedRefs(context.sharedContext, undefined, false)
          : null;
      }
      if (s.id === "library") {
        return opts.catalog;
      }
      if (s.id === "libraryAttachments") {
        return opts.attachments;
      }
      return s.content;
    })
    .filter((part): part is string => Boolean(part));
  // Evidence 段（projectPlan/projectSharedContext/...）在主会话装配里被
  // `ephemeralEvidence` 过滤掉，由每轮 request projection 提供。但 BTW 瞬时会话的
  // 工具面是只读的，必须保留「只读计划」使用指引，否则计划指引与工具面不一致
  // （test:project-agent 的 P1 收口断言）。这里在父装配缺失该段时按当前 context 补齐。
  if (planSummary && !segments.some((segment) => segment.id === "projectPlan")) {
    parts.push(renderProjectPlanContext(planSummary, false));
  }
  return parts;
}

/** Pinned Library 引用段：只给标题/id/类型（reference，不复制内容）；与任务显式附加去重。
 *  libraryReadable=false（团队/BTW 瞬时会话无 library_* 工具）时，文案不提示不存在的工具。 */
export function renderProjectPinnedRefs(
  summary: ProjectSharedContextSummary,
  excludeItemIds?: ReadonlySet<string>,
  libraryReadable = true,
): string | null {
  const pins = summary.pinned.filter((p) => !excludeItemIds?.has(p.itemId)).slice(0, PINNED_REFS_MAX_ITEMS);
  if (pins.length === 0) return null;
  const guidance = libraryReadable
    ? "需要内容时用 library_read 读取文本类；二进制/办公类返回受管路径，需要文件/预览工具。"
    : "本会话为只读分支，不提供资料库工具；如需内容请告知用户或由主任务（在项目上下文中的任务）读取。";
  const lines = ["## 项目固定资料（Pinned）", `项目长期固定引用的资料条目（只引用不复制）。${guidance}`];
  let used = lines[0]!.length + lines[1]!.length;
  for (const pin of pins) {
    const title = clip(pin.itemTitle ?? pin.itemId, 100);
    const line = `- [${pin.itemKind ?? "item"}] ${title} · id=${pin.itemId}`;
    if (used + line.length > PINNED_REFS_MAX_CHARS) break;
    used += line.length;
    lines.push(line);
  }
  return lines.join("\n");
}

const PLAN_STATUS_LABEL: Record<ProjectTodoStatus, string> = {
  todo: "待开始",
  doing: "进行中",
  paused: "已暂停",
  done: "已完成",
};

/**
 * Project Plan Context 段内容：
 * - 明确这是人维护、全项目任务共用的项目级共享计划；
 * - 概况计数 + 预算内 active slice（resolver 已裁剪）；
 * - writable=true（主任务）：指引读用 project_plan_list、改进展用 project_plan_update/create；
 * - writable=false（团队/BTW 瞬时会话，能力面只读）：只提示 list/get 可读，写由用户/主任务完成。
 */
export function renderProjectPlanContext(summary: ProjectPlanSummaryDto, writable = true): string {
  if (summary.total === 0) {
    if (!writable) {
      return [
        "## 项目共享计划（Project Plan）",
        "本项目暂未建立共享计划项。项目共享计划由人维护、所有绑定本项目的任务共用，作用域仅限本项目。",
        "本会话只能只读查看项目计划（project_plan_list）。如需补充或修改计划项，请建议用户在项目「计划」页维护。",
      ].join("\n");
    }
    return [
      "## 项目共享计划（Project Plan）",
      "本项目暂未建立共享计划项。项目共享计划由人维护、所有绑定本项目的任务共用，作用域仅限本项目。",
      "若你的工作推进了项目进展（交付物、里程碑、待办变更），可用 project_plan_create 新增结构化计划项，或建议用户在项目「计划」页补充；需要时用 project_plan_list 读取最新计划。",
    ].join("\n");
  }
  const counts = (["todo", "doing", "paused", "done"] as const)
    .map((id) => `${PLAN_STATUS_LABEL[id]} ${summary.byStatus[id]}`)
    .join(" · ");
  const lines = [
    "## 项目共享计划（Project Plan）",
    "本项目有一份由人维护的项目级共享计划（项目「计划」页的结构化数据）。所有绑定本项目的 Agent 任务共用同一份，作用域仅限本项目。",
    `计划概况：共 ${summary.total} 项 — ${counts}`,
  ];
  if (summary.active.length > 0) {
    lines.push("当前焦点（进行中/高优先/临近截止，预算内子集）：");
    for (const item of summary.active) lines.push(`- ${formatProjectTodoLine(item)}`);
  }
  lines.push(
    writable
      ? "用法：开始工作前如需了解项目全貌，用 project_plan_list 读取完整计划（工具返回数据库实时状态）；" +
        "你的工作改变了项目进展时，用 project_plan_update 更新对应计划项、或用 project_plan_create 新增事项" +
        "（结构化单项操作，禁止整段重写计划；本会话不提供删除权限）。" +
        "计划可能被用户或其他任务随时更新，以工具返回为准。"
      : "用法：本会话只能只读查看项目计划（project_plan_list / project_plan_get，数据库实时状态）；" +
        "不能修改计划项——如需更新计划（状态/新增/调整），请告知用户，或由主任务（在项目上下文中的任务）完成。" +
        "计划可能被用户或其他任务随时更新，以工具返回为准。",
  );
  return lines.join("\n");
}

/**
 * 唯一 system 拼装入口：createSession 与 assemblePreview 共用。
 */
export function assemblePrompt(input: PromptAssemblyInput): AssemblyTraceDto {
  const segments: AssemblySegmentDto[] = [];
  const warnings: string[] = [];
  const { profile, welcomeMode } = input;

  segments.push(
    seg(
      "soul",
      "人设",
      "db",
      `## 人设\n名称：${input.soul.name}\n称呼用户：${input.soul.alias}\n${input.soul.persona}`,
    ),
  );

  const modeParts = [
    `## 场景模式：${profile.labelZh}`,
    ...profile.blocks.map((b) => {
      if (b.source === "user") {
        /* mark later */
      }
      return `### ${b.label}\n${b.content.trim()}`;
    }),
  ];
  const tool = profile.policy.toolPolicy;
  if (tool.prefer.length || tool.demote.length || tool.deny.length) {
    modeParts.push(
      [
        "### 工具偏好",
        tool.mode === "hard" ? "（硬约束：部分工具可能不可用）" : "（软偏好，按任务需要调整）",
        tool.prefer.length ? `- 优先：${tool.prefer.join(", ")}` : "",
        tool.demote.length ? `- 慎用：${tool.demote.join(", ")}` : "",
        tool.deny.length ? `- 避免：${tool.deny.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  const artPol: ModeArtifactPolicy = profile.policy.artifactPolicy ?? emptyArtifactPolicy();
  if (artPol.deny.length || artPol.allow.length) {
    modeParts.push(
      [
        "### 产物扩展名限制（显示过滤）",
        "（黑白名单仅用于产物面板显示过滤；文件写入不受影响，不会拦截 write/edit）",
        artPol.deny.length
          ? `- 黑名单 deny（禁止）：${artPol.deny.map((e) => `.${e}`).join(", ")}`
          : "- 黑名单：未配置",
        artPol.allow.length
          ? `- 白名单 allow（仅允许）：${artPol.allow.map((e) => `.${e}`).join(", ")}`
          : "- 白名单：未启用（allow 为空 = 不限制白名单）",
        "黑白名单按当前场景模式独立配置；不要用违规扩展名凑交付。",
        "若用户明确要求本场景未允许的文件类型，请建议切换场景（如代码交付 → 代码开发）。",
      ].join("\n"),
    );
  }
  const mcpPol = profile.policy.mcpPolicy;
  if (mcpPol.deny.length || mcpPol.allow.length || input.mcpFilter?.hidden.length) {
    modeParts.push(
      [
        "### MCP 场景策略",
        mcpPol.mode === "hard" ? "（硬约束：未授权 MCP 不会加载到本会话）" : "（软偏好）",
        mcpPol.allow.length ? `- 白名单 allow：${mcpPol.allow.join(", ")}` : "- 白名单：未启用（allow 为空）",
        mcpPol.deny.length ? `- 黑名单 deny：${mcpPol.deny.join(", ")}` : "",
        input.mcpFilter?.enabled.length
          ? `- 本会话启用：${input.mcpFilter.enabled.join(", ") || "（无）"}`
          : "",
        input.mcpFilter?.hidden.length
          ? `- 本会话隐藏：${input.mcpFilter.hidden.join(", ")}`
          : "",
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
  const modeHasUser = profile.blocks.some((b) => b.source === "user") || profile.hasUserOverride;
  segments.push(
    seg("mode", `场景模式：${profile.labelZh}`, modeHasUser ? "user" : "seed", modeParts.join("\n\n")),
  );

  segments.push(...assembleProjectContextSegments(input.projectContext, {
    excludePinnedItemIds: input.libraryAttachedItemIds,
    libraryReadable: input.libraryReadable ?? true,
  }));
  warnings.push(...(input.projectContext?.resourceWarnings ?? []));

  if (input.libraryAttachments?.trim()) {
    segments.push(seg("libraryAttachments", "已附加资料", "db", input.libraryAttachments.trim()));
  }
  if (input.libraryCatalog?.trim()) {
    segments.push(seg("library", "资料库", "db", input.libraryCatalog.trim()));
  }

  if (input.modePreset?.content?.trim()) {
    segments.push(
      seg(
        "modePreset",
        `场景预设：${input.modePreset.label}`,
        "tag",
        `## 场景预设：${input.modePreset.label}\n${input.modePreset.content.trim()}`,
        input.modePreset.id,
      ),
    );
  }

  if (input.expertPrompt?.trim()) {
    segments.push(seg("expert", "专家角色", "expert", input.expertPrompt.trim()));
  }

  const skillFilter = filterSkillsForMode(
    input.skills ?? [],
    welcomeMode,
    profile.policy.skillPolicy,
    {
      disableFilter: input.disableSkillFilter,
      policySources: input.skillPolicySources,
    },
  );
  const skillSection = formatSkillCatalogSection(welcomeMode, skillFilter);
  if (skillSection) {
    segments.push(seg("skillCatalog", "技能目录", "skill", skillSection));
  }

  if (input.memoryEnabled) {
    segments.push(
      seg(
        "memoryRules",
        "长期记忆规则",
        "runtime",
        "## 内置长期记忆\n应用会在本轮对话结束后自动提取和更新长期记忆。任务绑定项目时，项目共享记忆（事实、决策、约束、风险）会随本轮补充证据提供；需要更多或完整内容时用 memory_search / memory_get 查询，不要凭印象复述。用户说“记住”“以后按此执行”或“忘记”时，正常确认即可；除非用户明确要求编辑某个文件，否则不要为保存记忆而创建或修改 AGENTS.md、MEMORY.md、SOUL.md 或其他文件，也不要声称已经修改这些文件。",
      ),
    );
  } else {
    segments.push(
      seg(
        "memoryRules",
        "长期记忆已关闭",
        "runtime",
        "## 长期记忆已关闭\n本任务不得加载、恢复或搜索长期记忆。用户询问你是否记得某项信息时，只依据当前任务的可见对话作答；不要为了恢复记忆而搜索数据库、会话日志、AGENTS.md、MEMORY.md、SOUL.md 或其他本地文件。用户明确要求读取某个文件时不受此限制。",
      ),
    );
  }

  // Workspace location is context; Pi owns file access and tool execution.
  if (input.workspace?.trim()) {
    segments.push(
      seg(
        "workspace",
        "当前任务工作目录",
        "runtime",
        `## 当前任务工作目录\n${input.workspace.trim()}`,
      ),
    );
  }

  const budget = applyPromptContextBudget(
    input.ephemeralEvidence ? segments.filter((segment) => !isEvidenceSegment(segment.id)) : segments,
    input.contextBudgetChars,
  );
  const effectiveSegments = budget.segments;
  const totalChars = budget.usedChars;
  if (budget.truncatedSegmentIds.length > 0) {
    warnings.push(
      `System context raw=${budget.rawChars} chars, budget=${budget.limitChars}, used=${budget.usedChars}; truncated=${budget.truncatedSegmentIds.join(",")}`,
    );
  } else if (budget.rawChars > 12_000) {
    warnings.push(`System context ${budget.rawChars} chars (budget ${budget.limitChars})`);
  }
  for (const b of profile.blocks) {
    if (!b.content.trim()) warnings.push(`场景块「${b.label}」为空`);
  }
  if (tool.mode === "hard" && tool.deny.length) {
    warnings.push(`工具硬拒绝：${tool.deny.join(", ")}`);
  }
  if (mcpPol.mode === "hard" && mcpPol.deny.length) {
    warnings.push(`MCP 黑名单：${mcpPol.deny.join(", ")}`);
  }
  if (mcpPol.mode === "hard" && mcpPol.allow.length) {
    warnings.push(`MCP 白名单：仅 ${mcpPol.allow.join(", ")}`);
  }
  if (input.mcpFilter?.hidden.length) {
    warnings.push(`本会话隐藏 MCP：${input.mcpFilter.hidden.join(", ")}`);
  }
  if (artPol.deny.length) {
    warnings.push(
      `产物扩展名${artPol.mode === "hard" ? "硬" : "软"}黑名单：${artPol.deny.map((e) => `.${e}`).join(", ")}`,
    );
  }
  if (artPol.allow.length) {
    warnings.push(
      `产物扩展名${artPol.mode === "hard" ? "硬" : "软"}白名单：仅 ${artPol.allow.map((e) => `.${e}`).join(", ")}`,
    );
  }

  const mcpFilter: AssemblyMcpFilterDto = input.mcpFilter ?? {
    enabled: [],
    hidden: [],
    reasons: {},
    policyMode: mcpPol.mode,
  };

  return {
    welcomeMode,
    segments: effectiveSegments,
    skillFilter: {
      prefer: skillFilter.prefer,
      demote: skillFilter.demote,
      hide: skillFilter.hide,
      allow: skillFilter.allow,
      visible: skillFilter.visible.map((s) => s.name),
      demoted: skillFilter.demoted.map((s) => s.name),
      hidden: skillFilter.hidden.map((s) => s.name),
    },
    toolPolicy: tool,
    mcpPolicy: mcpPol,
    mcpFilter,
    capabilities: [
      ...(input.capabilityTrace ?? []).filter((item) => item.kind !== "skill"),
      ...skillFilter.capabilities,
    ],
    artifactPolicy: artPol,
    totalChars,
    contextBudget: {
      limitChars: budget.limitChars,
      rawChars: budget.rawChars,
      usedChars: budget.usedChars,
      truncatedSegmentIds: budget.truncatedSegmentIds,
    },
    warnings,
    effectiveAt: "new_session_only",
    appendParts: effectiveSegments.map((s) => s.content),
  };
}

/** 硬策略：从可用工具列表中剔除 deny；readonly 优先由调用方处理 */
export function resolveSessionTools(
  permissionMode: string,
  toolPolicy: ModeToolPolicy,
  allTools?: string[],
): string[] | undefined {
  if (permissionMode === "readonly") {
    return ["read", "grep", "find", "ls"];
  }
  if (toolPolicy.mode !== "hard" || !toolPolicy.deny?.length) {
    return allTools; // undefined = pi 默认全工具
  }
  const deny = new Set(toolPolicy.deny.map((t) => t.toLowerCase()));
  const base =
    allTools ??
    ["read", "grep", "find", "ls", "write", "edit", "bash"];
  const filtered = base.filter((t) => !deny.has(t.toLowerCase()));
  return filtered.length > 0 ? filtered : ["read", "ls"];
}

/**
 * 工具名权威清单已下沉到 src/shared/native-tools.ts（单一真相源）：
 *  - NATIVE_CAPABILITY_TOOL_NAMES / WEB_ACCESS_TOOL_NAMES 在此 re-export 以兼容既有导入；
 *  - MUTATING_BUILTIN_TOOLS / READONLY_EXTRA_ACTIVE 由 McpSideEffectPolicy /
 *    pi-event-mapper 共用，消除清单漂移。
 */

/**
 * 传给 createAgentSession 的工具选择。
 *
 * Pi SDK：`tools` 是封闭白名单——一旦传入，扩展工具（web_search 等）会被丢掉。
 * 因此 deny / readonly 必须用 `excludeTools`，不要再传内置四件套/七件套 allowlist。
 */
export interface SessionToolSelection {
  /** 不要传封闭 allowlist；undefined = 内置默认 + 全部扩展工具 */
  tools?: string[];
  excludeTools?: string[];
  /** readonly 时补上不在 Pi 默认 active 集里的只读内置工具 */
  extraActiveTools?: string[];
}

export function resolveSessionToolSelection(
  permissionMode: string,
  toolPolicy: ModeToolPolicy,
  capabilities?: BuiltinCapabilitiesConfigDto,
): SessionToolSelection {
  const capabilityExclusions = capabilities && !capabilities.execution.terminalEnabled ? ["bash", "powershell"] : [];
  if (permissionMode === "readonly") {
    return {
      excludeTools: [...new Set([...MUTATING_BUILTIN_TOOLS, ...capabilityExclusions])],
      extraActiveTools: [...READONLY_EXTRA_ACTIVE],
    };
  }
  if (toolPolicy.mode === "hard" && toolPolicy.deny?.length) {
    return { excludeTools: [...new Set([...toolPolicy.deny, ...capabilityExclusions])] };
  }
  return capabilityExclusions.length ? { excludeTools: capabilityExclusions } : {};
}

export function activateResolvedSessionTools(
  session: {
    getActiveToolNames(): string[];
    getAllTools(): Array<{ name: string }>;
    setActiveToolsByName(names: string[]): void;
  },
  selection: SessionToolSelection,
  welcomeMode?: WelcomeMode,
): void {
  const registered = new Set(session.getAllTools().map((tool) => tool.name));
  const exclude = new Set((selection.excludeTools ?? []).map((name) => name.toLowerCase()));
  const next = new Set(session.getActiveToolNames().filter((name) => !exclude.has(name.toLowerCase())));
  for (const name of [...(selection.extraActiveTools ?? []), ...piCodeModeExtraActiveTools(welcomeMode)]) {
    if (registered.has(name) && !exclude.has(name.toLowerCase())) next.add(name);
  }
  // Pi restores the persisted loadout on resume, which can predate installed
  // product tools. Reconcile our registered defaults without resetting Pi/MCP
  // selections or bypassing the current policy's exclusions.
  for (const name of [...NATIVE_CAPABILITY_TOOL_NAMES, ...MYBUDDY_NATIVE_EXTENSION_TOOL_NAMES]) {
    if (registered.has(name) && !exclude.has(name.toLowerCase())) next.add(name);
  }
  session.setActiveToolsByName([...next]);
}
