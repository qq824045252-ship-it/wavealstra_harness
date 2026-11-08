import { resolveWelcomeMode, type WelcomeMode } from "./mode-profile";

export interface PiCodeModeState {
  policy: "coding-only";
  welcomeMode: WelcomeMode;
  configured: boolean;
  /** null means there is no bound native session; it is not an enabled claim. */
  active: boolean | null;
  models: boolean;
}
export function isPiCodeModeEnabled(mode: unknown): boolean {
  return resolveWelcomeMode(mode) === "coding";
}
/** Additional native tool names at the post-bind activation boundary; independent of MCP readiness. */
export function piCodeModeExtraActiveTools(mode: unknown): string[] {
  return isPiCodeModeEnabled(mode) ? ["codemode", "tool_search"] : ["tool_search"];
}
export function piCodeModeState(mode: unknown, active: boolean | null): PiCodeModeState {
  const welcomeMode = resolveWelcomeMode(mode);
  return { policy: "coding-only", welcomeMode, configured: isPiCodeModeEnabled(welcomeMode), active, models: isPiCodeModeEnabled(welcomeMode) };
}
export function piCodeModeLabel(mode: unknown, observed?: PiCodeModeState | null): { text: string; title: string; phase: "enabled" | "disabled" | "pending" } {
  const welcomeMode = resolveWelcomeMode(mode), configured = isPiCodeModeEnabled(welcomeMode);
  const current = observed?.welcomeMode === welcomeMode ? observed : null;
  if (current?.active === true) return { text: "已启用", phase: "enabled", title: "Pi 原生 Code Mode 已在当前会话启用；模型自行决定直接调用或脚本编排。" };
  if (current?.active === false) return { text: "未启用", phase: "disabled", title: configured ? "当前 Pi 会话未启用 Code Mode；请检查工具权限或排除配置。" : "自动规则：仅代码开发场景启用。MCP 仍可通过原生工具搜索和直接调用使用。" };
  return { text: configured ? "待启用" : "未启用", phase: configured ? "pending" : "disabled", title: configured ? "自动规则：代码开发会话启动时启用。当前尚无已绑定的原生会话状态。" : "自动规则：日常办公和通用模式不启用 Code Mode；不影响 MCP 使用。" };
}
