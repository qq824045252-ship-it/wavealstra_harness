import type { PermissionMode } from "@/types";

/** 权限模式展示文案（对齐官方 MyBuddy，避免口语化「全自动」） */
export const PERMISSION_LABEL: Record<PermissionMode, string> = {
  default: "默认权限",
  readonly: "只读模式",
  auto: "允许完全访问",
};

export const PERMISSION_HINT: Record<PermissionMode, string> = {
  default: "当前为默认权限，敏感操作将在执行前请求你确认。",
  readonly: "当前为只读模式，仅允许读取与分析，不会修改文件或执行命令。",
  auto: "当前权限为允许完全访问，请注意数据安全，建议执行可信任的任务。",
};

export const FULL_ACCESS_CONFIRM = {
  title: "确认允许完全访问?",
  body: "开启允许完全访问后，AI 将减少确认步骤，并可直接执行更多操作，包括敏感操作、文件修改或外部执行。\n仅建议在您信任当前任务时使用。",
  checkbox: "我已了解风险，并愿意继续",
  cancel: "取消",
  confirm: "允许完全访问",
} as const;
