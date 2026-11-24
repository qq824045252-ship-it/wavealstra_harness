/**
 * 终端字体探测（不打包字体文件，全部使用本机已装字体）
 *
 * Oh My Posh 等提示符图标位于 Nerd Font PUA 区（U+E000–F8FF），普通等宽字体
 * （Cascadia Mono/Consolas）不覆盖，Windows 会回退到 Segoe UI Symbol 等 → 错字形
 * 或方框。系统默认优先使用实际安装的 Nerd Font。用户选择代码字体时，以所选字体
 * 测量字宽，保留 Nerd Font 作为缺字回退。
 *
 * 非 Mono 的 Nerd Font 图标常超过 1 格宽，会叠到后面的 CJK 路径上（看起来像
 * 中文被划掉）。候选优先 Mono / NFM。CJK 走微软雅黑等轮廓字体，避开宋体小字号点阵。
 */

/** 探测候选（按优先级）；本机装任一即命中。Mono 变体必须排在非 Mono 前面。 */
export const TERMINAL_FONT_CANDIDATES = [
  "CaskaydiaCove Nerd Font Mono",
  "CaskaydiaCove NFM",
  "MesloLGM Nerd Font Mono",
  "MesloLGS Nerd Font Mono",
  "JetBrainsMono Nerd Font Mono",
  "JetBrainsMono NFM",
  "FiraCode Nerd Font Mono",
  "FiraCode NFM",
  "CaskaydiaCove Nerd Font",
  "CaskaydiaCove NF",
  "MesloLGM Nerd Font",
  "JetBrainsMono Nerd Font",
  "FiraCode Nerd Font",
] as const;

/** 代码字号过小时，终端 CJK / Powerline 会糊成一条线；不低于 VS Code 默认 14。 */
export const TERMINAL_MIN_FONT_SIZE = 14;

/** 略大于 1，给 CJK 上下留空；再大 Powerline 色块会上下露缝。 */
export const TERMINAL_LINE_HEIGHT = 1.18;

const LATIN_FALLBACK = `"Cascadia Mono", Consolas, "Courier New"`;
const CJK_FALLBACK = `"Sarasa Term SC", "Sarasa Gothic SC", "Microsoft YaHei", "PingFang SC", "Noto Sans SC", DengXian`;

export interface TerminalFontSettings {
  codeFontSize: number;
  codeFontFamily: string;
}

export interface TerminalFontResolved {
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  rescaleOverlappingGlyphs: boolean;
}

/** 按候选顺序返回第一个本机可用的字体名；全部不可用返回 null */
export function pickFirstAvailableFont(
  candidates: readonly string[],
  installed: readonly string[],
): string | null {
  const available = new Set(installed.map((name) => name.toLowerCase()));
  return candidates.find((name) => available.has(name.toLowerCase())) ?? null;
}

export function resolveTerminalFontSize(codeFontSize: number): number {
  if (!Number.isFinite(codeFontSize)) return TERMINAL_MIN_FONT_SIZE;
  return Math.max(TERMINAL_MIN_FONT_SIZE, codeFontSize);
}

/**
 * 组装 xterm fontFamily：
 * 用户代码字体 → Nerd Font → 西文等宽 → CJK 轮廓 → 系统回退。
 */
export function buildTerminalFontFamily(nerdFont: string | null, preferred = ""): string {
  const parts: string[] = [];
  const pref = preferred.trim();
  if (pref) parts.push(pref);
  if (nerdFont) parts.push(`"${nerdFont}"`);
  parts.push(LATIN_FALLBACK, CJK_FALLBACK, "monospace");
  return parts.join(", ");
}

export function resolveTerminalFontOptions(
  nerdFont: string | null,
  settings: TerminalFontSettings,
): TerminalFontResolved {
  return {
    fontFamily: buildTerminalFontFamily(nerdFont, settings.codeFontFamily),
    fontSize: resolveTerminalFontSize(settings.codeFontSize),
    lineHeight: TERMINAL_LINE_HEIGHT,
    rescaleOverlappingGlyphs: true,
  };
}
