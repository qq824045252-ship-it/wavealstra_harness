/**
 * Prompt Enhance（提示词增强）公共核心：chat / new-task 两个 surface 共用的
 * 类型与产品文案契约。
 *
 * 定位：把 ChatInput 内联的旧状态机收敛为公共核心（正式命名 Prompt Enhance）
 * （types / policy / usePromptEnhance / PromptEnhanceControl），chat（有 taskId）
 * 与 new-task 草稿态（无 taskId）共用同一套逻辑与 UI。
 */

export type EnhanceStatus = "idle" | "enhancing" | "applied" | "error" | "cancelled";
export type EnhanceSurface = "new-task" | "chat";

export interface PromptEnhanceContext {
  surface: EnhanceSurface;
  /** Renderer-only draft identity; never treated as a native Task id. */
  draftScope?: string;
  /** chat 用：当前任务 id（主进程据此解析 Mode/Tag/Expert/Skill/workspace 环境） */
  taskId?: string;
  /** new-task 可选：目标项目（无 taskId 时的执行环境锚点之一） */
  projectId?: string;
  /** new-task 可选：目标空间（无 taskId 时的执行环境锚点之一） */
  spaceId?: string;
  mode?: string;
  tag?: string;
  preset?: string;
  /** new-task 显式 Expert id（仅 id；随 IPC 发送，主进程校验存在/可用后注入环境）。
   *  chat 为 undefined（以任务为准）。expertIds 是它的指纹投影，两者在调用方同源。 */
  expertId?: string;
  expertIds?: string[];
  allowedSkillNames?: string[];
}

/** 统一文案常量（产品契约，禁止别的措辞） */
export const ENHANCE_LABEL = "增强提示词"; // 按钮 tooltip / aria-label
export const ENHANCE_ENHANCING_LABEL = "增强中…";
export const ENHANCE_RESTORE_LABEL = "恢复原文";
export const ENHANCE_FAILED_NOTICE = "增强失败，请重试";
export const ENHANCE_STALE_NOTICE = "输入内容已变化，增强结果未应用";
export const ENHANCE_UNDO_BLOCKED_NOTICE = "内容已修改，无法直接恢复";

/** 提示条短生命周期：6s 自动消失 */
export const ENHANCE_NOTICE_DURATION_MS = 6000;
