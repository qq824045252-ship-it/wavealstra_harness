/**
 * 终端字体探测（不打包字体文件，全部使用本机已装字体）
 *
 * Oh My Posh 等提示符图标位于 Nerd Font PUA 区（U+E000–F8FF），普通等宽字体
 * （Cascadia Mono/Consolas）不覆盖，Windows 会回退到 Segoe UI Symbol 等 → 错字形
 * 或方框。方案：启动时用 document.fonts.check 探测本机候选 Nerd Font，命中者放
 * fontFamily 第一位 —— xterm 以首字体测量字宽，必须排最前，否则图标错位。
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

export type FontSpecChecker = (spec: string) => boolean;

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
  check: FontSpecChecker,
): string | null {
  for (const name of candidates) {
    try {
      if (check(`16px "${name}"`)) return name;
    } catch {
      /* 个别字体名导致 check 抛错：跳过继续 */
    }
  }
  return null;
}

export function resolveTerminalFontSize(codeFontSize: number): number {
  if (!Number.isFinite(codeFontSize)) return TERMINAL_MIN_FONT_SIZE;
  return Math.max(TERMINAL_MIN_FONT_SIZE, codeFontSize);
}

/**
 * 组装 xterm fontFamily：
 * Nerd Font（测量基准）→ 用户代码字体 → 西文等宽 → CJK 轮廓 → 系统回退。
 * 用户字体不得抢第一位，否则 Powerline 按错误字宽排版，中文路径会被三角形切开。
 */
export function buildTerminalFontFamily(nerdFont: string | null, preferred = ""): string {
  const parts: string[] = [];
  if (nerdFont) parts.push(`"${nerdFont}"`);
  const pref = preferred.trim();
  if (pref) parts.push(pref);
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
