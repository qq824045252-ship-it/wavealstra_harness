/**
 * 扩展栏终端 ANSI 调色。
 *
 * 浅色主题若漏掉 bright* ，xterm 会用暗色默认值（brightYellow=#fce94f、
 * brightWhite=#eeeeec），白底上几乎看不见。Oh My Posh 真彩色同样按单元格
 * 背景做 minimumContrastRatio 校正。
 */
import type { ITheme } from "@xterm/xterm";

export const DARK_TERMINAL_THEME: ITheme = {
  background: "#101827",
  foreground: "#e9f0fc",
  cursor: "#e9f0fc",
  cursorAccent: "#101827",
  selectionBackground: "#354f7d",
  black: "#101827",
  red: "#f14c4c",
  green: "#23d18b",
  yellow: "#f5f543",
  blue: "#3b8eea",
  magenta: "#d670d6",
  cyan: "#29b8db",
  white: "#e9f0fc",
  brightBlack: "#8a8a8a",
  brightRed: "#f14c4c",
  brightGreen: "#23d18b",
  brightYellow: "#f5f543",
  brightBlue: "#3b8eea",
  brightMagenta: "#d670d6",
  brightCyan: "#29b8db",
  brightWhite: "#e9f0fc",
};

/** 浅色：黄/白必须足够深，否则 pwsh + Oh My Posh 的 cline / 路径会糊进背景。 */
const LIGHT_TERMINAL_BACKGROUND = "#f7efe3";
export const LIGHT_TERMINAL_THEME: ITheme = {
  background: LIGHT_TERMINAL_BACKGROUND,
  foreground: "#302720",
  cursor: "#302720",
  cursorAccent: LIGHT_TERMINAL_BACKGROUND,
  selectionBackground: "#e6d7c4",
  black: "#302720",
  red: "#c50f1f",
  green: "#0b7a0b",
  yellow: "#7a5c00",
  blue: "#0451a5",
  magenta: "#881798",
  cyan: "#0078a0",
  white: "#4a4a4a",
  brightBlack: "#5a5a5a",
  brightRed: "#b91c1c",
  brightGreen: "#0b7a0b",
  brightYellow: "#6b4f00",
  brightBlue: "#0451a5",
  brightMagenta: "#881798",
  brightCyan: "#0078a0",
  brightWhite: "#302720",
};

/** 浅色底上真彩色亮黄（#fce94f / #f5f543）必须拉到 AA 以上才看得见。 */
export const LIGHT_TERMINAL_CONTRAST_RATIO = 7;
export const DARK_TERMINAL_CONTRAST_RATIO = 1;

export function resolveTerminalTheme(theme: string): ITheme {
  return theme === "dark" ? DARK_TERMINAL_THEME : LIGHT_TERMINAL_THEME;
}

export function resolveTerminalContrastRatio(theme: string): number {
  return theme === "dark" ? DARK_TERMINAL_CONTRAST_RATIO : LIGHT_TERMINAL_CONTRAST_RATIO;
}
