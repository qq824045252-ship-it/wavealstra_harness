import { DEFAULT_WELCOME_MODE } from "./mode-profile";
import type { WelcomeMode } from "./agent-ipc";
import { defaultModePresetId, isKnownModePresetId, WELCOME_MODES } from "./mode-profile";
import type { ProjectDto } from "./project-domain";
import type { ProjectTemplateDefinition } from "./project-template";

export interface ProjectTaskDefaultCandidate {
  projectId?: string;
  spaceId?: string;
  welcomeMode?: WelcomeMode;
  modePresetId?: string | null;
  updatedAt: number;
}

export interface ProjectTaskDefaults {
  spaceId?: string;
  welcomeMode: WelcomeMode;
  modePresetId: string | null;
  source: "recent-task" | "project-template" | "system-default";
}

/** 模板 taskSuggestions 原始形态（校验前的推荐值） */
export interface TemplateTaskSuggestion {
  recommendedModeId?: string;
  recommendedPresetId?: string;
}

/** 校验后的模板任务推荐（mode/preset 均已归一化到真实 Runtime Registry） */
export interface ResolvedTemplateTaskSuggestion {
  recommendedModeId: WelcomeMode;
  recommendedPresetId: string;
}

/**
 * 校验模板推荐值（实施文档 §14）：
 * - recommendedModeId 非法/缺失 → 整条丢弃（null），不允许虚构模式
 * - recommendedPresetId 不属于该 mode → 用该 mode 的默认 preset
 * 绝不信任模板静态数据，禁止直接透传。
 */
export function resolveTemplateTaskSuggestion(
  suggestion: TemplateTaskSuggestion | null | undefined,
): ResolvedTemplateTaskSuggestion | null {
  const modeId = suggestion?.recommendedModeId;
  if (!modeId || !WELCOME_MODES.includes(modeId as WelcomeMode)) return null;
  const mode = modeId as WelcomeMode;
  return {
    recommendedModeId: mode,
    recommendedPresetId: isKnownModePresetId(mode, suggestion?.recommendedPresetId)
      ? (suggestion?.recommendedPresetId as string)
      : defaultModePresetId(mode),
  };
}

/**
 * 从 Project 反查模板任务推荐（实施文档 §8.1 / §13）：
 * project.templateId → templates registry → taskSuggestions。
 * - templateId 为空 / 模板不存在 / 推荐不合法 → graceful fallback（null）
 * - 绝不阻塞 Task 创建
 */
export function resolveProjectTemplateTaskSuggestion(
  project: Pick<ProjectDto, "templateId">,
  templates: readonly ProjectTemplateDefinition[],
): ResolvedTemplateTaskSuggestion | null {
  if (!project.templateId) return null;
  const template = templates.find((item) => item.id === project.templateId);
  return resolveTemplateTaskSuggestion(template?.taskSuggestions);
}

/**
 * 默认值优先级（实施文档 §9 / §10 / §15）：
 * Folder: explicit project default > recent task. Mode/preset: recent task > template > system.
 *
 * Template 只用于「第一次帮助你起步」；最近 Task 反映用户最近真实工作方式，
 * 因此 recent task 必须优先，且模板推荐不持久化到 Project。
 */
export function resolveProjectTaskDefaults(args: {
  tasks: readonly ProjectTaskDefaultCandidate[];
  projectId: string;
  defaultSpaceId?: string;
  templateSuggestion?: TemplateTaskSuggestion | null;
}): ProjectTaskDefaults {
  const { tasks, projectId, templateSuggestion } = args;
  const recent = tasks
    .filter((task) => task.projectId === projectId)
    .sort((left, right) => right.updatedAt - left.updatedAt)[0];
  if (recent) {
    return {
      spaceId: args.defaultSpaceId ?? recent.spaceId,
      welcomeMode: recent.welcomeMode ?? DEFAULT_WELCOME_MODE,
      modePresetId: recent.modePresetId ?? null,
      source: "recent-task",
    };
  }
  const suggestion = resolveTemplateTaskSuggestion(templateSuggestion);
  if (suggestion) {
    return {
      welcomeMode: suggestion.recommendedModeId,
      ...(args.defaultSpaceId ? { spaceId: args.defaultSpaceId } : {}),
      modePresetId: suggestion.recommendedPresetId,
      source: "project-template",
    };
  }
  return { ...(args.defaultSpaceId ? { spaceId: args.defaultSpaceId } : {}), welcomeMode: "working", modePresetId: null, source: "system-default" };
}
