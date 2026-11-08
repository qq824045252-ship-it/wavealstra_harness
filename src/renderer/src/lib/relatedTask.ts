/**
 * 通用“从当前任务创建关联任务”能力 — 纯函数层（node 可单测）。
 *
 * 与 review 无关：同一条路径支持 coding→code-review、code-review→修复、
 * 场景切换实现、同场景整理等任何场景，只靠参数组合。
 * 不新增 DB 关系：源任务引用复用现有 refTask 文本机制（taskReference.ts）。
 */
import type { PermissionMode } from "@shared/agent-ipc";
import {
  defaultModePresetId,
  resolveEffectiveModePolicy,
  resolveModePreset,
  type ModeProfileDto,
  type WelcomeMode,
} from "@shared/mode-profile";
import type { RefFileItem } from "./refTaskArtifacts";
import { buildTaskReferenceBlock, wrapReferenceContext } from "./taskReference";

/** 关联任务最终规格（createRelatedTask 的输入，全部字段已解析完毕） */
export interface RelatedTaskSpec {
  title: string;
  welcomeMode: WelcomeMode;
  modePresetId: string;
  /** 目标专家（未安装时由调用方安装/引导；null = 不召唤专家） */
  expertId?: string | null;
  permissionMode: PermissionMode;
  /** 已解析模型；undefined = 让会话走默认模型解析 */
  modelId?: string;
  /** 首条消息正文（含源任务引用块） */
  instruction: string;
}

export interface ResolveRelatedTaskOptions {
  /** 源任务标题（用于标题与引用块） */
  sourceTitle: string;
  welcomeMode: WelcomeMode;
  modePresetId?: string;
  expertId?: string | null;
  permissionMode?: PermissionMode;
  modelId?: string;
  /** 回退链底：系统默认权限 */
  fallbackPermission: PermissionMode;
  /** 回退链底：源任务/当前模型 */
  fallbackModelId?: string;
  /** 首条指令；缺省 = 引用源任务继续 */
  instruction?: string;
  /** suggestedModelId 可用性校验（无效建议安全降级，不阻塞） */
  isModelAvailable: (modelId: string) => boolean;
  /** 目标模式 profile（null 时跳过 Tag 建议解析，仅用显式参数） */
  profile: ModeProfileDto | null;
}

/**
 * 关联任务策略解析（统一决策点）：
 * - Tag：显式 modePresetId ?? 目标模式默认
 * - 权限：显式 > Tag/Preset 建议 > Mode/base 建议 > fallback（系统默认）
 * - 模型：显式 > Tag/Preset 建议（须可用，无效降级）> fallback
 * - 专家：仅显式传参（推荐只是推荐，不强绑定）
 */
export function resolveRelatedTaskSpec(options: ResolveRelatedTaskOptions): RelatedTaskSpec {
  const modePresetId = options.modePresetId ?? defaultModePresetId(options.welcomeMode);
  let suggestedPermission: PermissionMode | null = null;
  let suggestedModel: string | null = null;
  if (options.profile) {
    const preset = resolveModePreset(options.profile.policy, modePresetId);
    const effective = resolveEffectiveModePolicy(options.profile.policy, preset);
    suggestedPermission = effective.suggestedPermissionMode;
    suggestedModel = effective.suggestedModelId;
  }
  const permissionMode =
    options.permissionMode ?? suggestedPermission ?? options.fallbackPermission;
  const modelId =
    options.modelId ??
    (suggestedModel && options.isModelAvailable(suggestedModel) ? suggestedModel : undefined) ??
    options.fallbackModelId;
  return {
    title: options.sourceTitle ? `关联：${options.sourceTitle}` : "关联任务",
    welcomeMode: options.welcomeMode,
    modePresetId,
    expertId: options.expertId,
    permissionMode,
    modelId,
    instruction: options.instruction ?? "请先了解源任务内容（见引用任务），再完成本任务目标。",
  };
}

/** 组装首条消息：指令 + 引用块（复用现有 refTask 文本机制） */
export function buildRelatedTaskPrompt(
  instruction: string,
  source: {
    title: string;
    spaceName?: string;
    cwd?: string;
    messages?: Array<{ role: "user" | "assistant"; text: string }>;
    files?: RefFileItem[];
  },
): string {
  const block = buildTaskReferenceBlock({
    id: "",
    title: source.title,
    spaceName: source.spaceName,
    cwd: source.cwd,
    messages: source.messages,
    files: source.files,
  });
  const hidden = wrapReferenceContext(block);
  return hidden ? `${instruction}\n\n${hidden}` : instruction;
}
