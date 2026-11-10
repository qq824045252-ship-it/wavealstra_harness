/**
 * Prompt Enhance 纯函数策略：触发门控 / 撤销判定 / stale 指纹。
 * 全部无副作用，与 UI 解耦，可独立单测。
 */
import { ENHANCE_UNDO_BLOCKED_NOTICE, type PromptEnhanceContext } from "./types";

export interface EnhanceGate {
  text: string;
  context: PromptEnhanceContext;
  /** 增强中（防双击） */
  enhancing: boolean;
  /** BTW 激活：临时岔题问答，与就地改写语义互斥 */
  btwActive: boolean;
}

/**
 * 触发门控（全部满足才可用）：
 * - text.trim() 非空；
 * - 不在增强中（单飞，禁止并发请求）；
 * - 不在 BTW 模式；
 * - surface==="chat" 要求 taskId 非空（主进程拒绝无任务请求）；
 * - surface==="new-task" 不做额外要求：主进程对无 projectId/spaceId 的草稿
 *   会回退全局默认上下文（纯只读，无副作用），保证顶层「新建任务」也可用。
 */
export function canTriggerEnhance(gate: EnhanceGate): boolean {
  if (!gate.text?.trim()) return false;
  if (gate.enhancing) return false;
  if (gate.btwActive) return false;
  const ctx = gate.context;
  if (ctx.surface === "chat") return Boolean(ctx.taskId);
  // new-task 草稿态：允许（主进程以默认上下文兜底）
  return true;
}

/** 撤销状态：original = 触发前的原文；applied = 已写入的增强结果 */
export interface EnhanceUndoState {
  original: string;
  applied: string;
}

export type EnhanceUndoResolution =
  | { kind: "noop" }
  | { kind: "restore"; text: string }
  | { kind: "blocked"; message: string };

/**
 * 撤销判定（纯函数）：
 * - 无 undo 状态 → noop；
 * - 当前文本仍等于 applied（用户未在增强后编辑）→ 恢复 original；
 * - 用户已编辑过 → blocked（绝不覆盖用户新内容）。
 */
export function resolveUndo(undo: EnhanceUndoState | null, current: string): EnhanceUndoResolution {
  if (!undo) return { kind: "noop" };
  if (current !== undo.applied) {
    return { kind: "blocked", message: ENHANCE_UNDO_BLOCKED_NOTICE };
  }
  return { kind: "restore", text: undo.original };
}

/**
 * stale 指纹：稳定序列化 surface/sourceText/taskId/projectId/spaceId/mode/tag/preset/
 * expertId/expertIds/allowedSkillNames（字段顺序固定，同输入 → 同输出）。
 * expertIds / allowedSkillNames 先 canonical sort 再序列化（数组顺序不影响指纹），
 * 排序在副本上进行，绝不修改原数组。
 * 用于增强结果返回时判定「触发后输入或上下文是否已变化」。
 */
export function buildFingerprint(context: PromptEnhanceContext, sourceText: string): string {
  // 副本上排序：不修改调用方传入的数组
  const expertIds = context.expertIds ? [...context.expertIds].sort() : undefined;
  const allowedSkillNames = context.allowedSkillNames
    ? [...context.allowedSkillNames].sort()
    : undefined;
  const fields = {
    surface: context.surface,
    draftScope: context.draftScope,
    sourceText,
    taskId: context.taskId,
    projectId: context.projectId,
    spaceId: context.spaceId,
    mode: context.mode,
    tag: context.tag,
    preset: context.preset,
    // IPC 实际发送的显式 Expert（与 expertIds 同源）：指纹中的 expert 与模型看到的保持一致
    expertId: context.expertId,
    expertIds,
    allowedSkillNames,
  };
  return JSON.stringify(fields);
}
