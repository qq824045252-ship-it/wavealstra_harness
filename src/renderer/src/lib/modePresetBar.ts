/**
 * 场景模式 Preset Bar 纯逻辑（UI 用，可 node 单测）。
 * 渲染层只负责把这里的 chips 画出来；可用性/锁定/选中语义全部集中在此。
 */
import type { ModePresetDto } from "../../../shared/mode-profile";

export interface PresetBarChip {
  id: string;
  label: string;
  description?: string;
  selected: boolean;
  disabled: boolean;
  title?: string;
}

export interface PresetBarInput {
  presets: ModePresetDto[];
  /** 当前选中 preset id（null = 未选中） */
  selectedPresetId: string | null;
  /** 已配置 + 启用 + 已安装的 MCP server 名（来自 mcp:listServers） */
  availableMcpServerNames: Set<string>;
  /** 任务已有消息或 session（与 welcomeMode 相同锁定语义） */
  locked: boolean;
}

/** 任务锁定语义：已有消息或 session 即锁定（与 welcomeMode 一致） */
export function isTaskModeLocked(task: {
  messages?: unknown[];
  sessionFile?: string;
} | null | undefined): boolean {
  return Boolean(task && ((task.messages?.length ?? 0) > 0 || task.sessionFile));
}

/**
 * 生成 preset bar chips（三种顶层模式通用）：
 * - locked（任务已有消息/session）→ 全部 disabled + 说明 title
 * - preset 声明了 providerMcpIds 且对应 MCP 未配置/未启用 → disabled + 说明 title（不 silent fallback）
 * - 无 providerMcpIds 的 preset（working/coding prompt-only 等）始终可选
 */
export function buildPresetBarChips(input: PresetBarInput): PresetBarChip[] {
  return input.presets.map((p) => {
    const providerIds = p.providerMcpIds ?? [];
    const providerMissing =
      providerIds.length > 0 && !providerIds.every((id) => input.availableMcpServerNames.has(id));
    let disabled = input.locked || providerMissing;
    let title: string | undefined;
    if (input.locked) {
      title = "任务已开始，场景预设已锁定（与欢迎模式一致）；换预设请复制为新任务";
    } else if (providerMissing) {
      const names = providerIds.map(providerDisplayName).join(" / ");
      title = `${names} 未配置或已停用，请先在 MCP 设置中启用`;
    }
    return {
      id: p.id,
      label: p.label,
      description: p.description,
      selected: p.id === input.selectedPresetId,
      disabled,
      title,
    };
  });
}

/** 集中式 provider 显示名（未知 id 原样显示，不散落 if/else） */
function providerDisplayName(id: string): string {
  const known: Record<string, string> = {
    penpot: "Penpot MCP",
    canva: "Canva MCP",
    "drawio-ai": "Draw.io AI MCP",
  };
  return known[id] ?? id;
}
