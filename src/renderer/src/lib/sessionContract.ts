/**
 * Renderer → Main 的「显式 vs 默认」请求契约（纯函数，可单测）。
 *
 * 冻结优先级：用户显式选择 > Tag/Preset 建议 > Mode/base 建议 > 系统默认。
 * renderer 只有在「用户显式选择过」时才把当前值作为 explicit 传给主进程；
 * 否则传 undefined，由主进程 createSession 按 Tag/Mode/系统默认链解析。
 * 关键：boot 时从设置/默认解析出的 activeModelId / permissionMode 是「继承值」，
 * 不是显式选择——不能把它们当作 explicit 恒量传递（那会遮蔽 Tag 建议）。
 */
import type { PermissionMode } from "@shared/agent-ipc";

export interface ExplicitChoice<T> {
  /** 用户是否在本会话内显式选择过（boot 继承值 = false） */
  explicit: boolean;
  /** 当前值（未选择时可为空） */
  value: T | null;
}

/**
 * 模型请求值：仅显式选择时传值；否则 undefined → 主进程按 Tag 建议 → 默认解析。
 * 注意：显式选择也允许传 "default" 之外的任意合法模型 id。
 */
export function toRequestModelId(choice: ExplicitChoice<string | null>): string | undefined {
  if (!choice.explicit) return undefined;
  return choice.value?.trim() || undefined;
}

/**
 * 权限请求值：仅显式选择时传值；否则 undefined → 主进程按 Tag 建议 → Mode 建议 → 系统默认。
 * 显式选择 "default" 也是显式（用户明确放弃 Tag 的 readonly/auto 建议）。
 */
export function toRequestPermissionMode(
  choice: ExplicitChoice<PermissionMode | null>,
): PermissionMode | undefined {
  if (!choice.explicit) return undefined;
  return choice.value ?? undefined;
}
