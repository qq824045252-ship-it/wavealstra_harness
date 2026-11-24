export type AppTheme = "light" | "dark";
export type AppThemeMode = AppTheme | "system";

export const DESKTOP_PALETTES = [
  { id: "paper", label: "暖纸", light: { background: "#f1ebe0", foreground: "#2b2622", sample: "#a44731" }, dark: { background: "#1e1c18", foreground: "#f0e9dd", sample: "#f0a382" } },
  { id: "slate", label: "石板灰", light: { background: "#e9edf1", foreground: "#222832", sample: "#475d78" }, dark: { background: "#171b22", foreground: "#edf1f7", sample: "#a7bfdd" } },
  { id: "mist", label: "雾蓝", light: { background: "#e1ebf3", foreground: "#172d41", sample: "#215f85" }, dark: { background: "#121e2b", foreground: "#e7f2fb", sample: "#84c9ee" } },
  { id: "contrast", label: "高对比", light: { background: "#e4e4e4", foreground: "#101010", sample: "#003ca0" }, dark: { background: "#080808", foreground: "#ffffff", sample: "#a5ccff" } },
] as const;

export const DESKTOP_ACCENTS = [
  { id: "theme", label: "主题默认" },
  { id: "clay", label: "陶土", light: "#a44731", dark: "#f0a382" },
  { id: "blue", label: "湛蓝", light: "#245da5", dark: "#9dc4ff" },
  { id: "teal", label: "青绿", light: "#17644e", dark: "#8cdbbb" },
  { id: "violet", label: "紫藤", light: "#70469b", dark: "#d4a9fc" },
] as const;

export type DesktopPalette = (typeof DESKTOP_PALETTES)[number]["id"];
export type DesktopAccent = (typeof DESKTOP_ACCENTS)[number]["id"];

export interface DesktopAppearance {
  mode: AppThemeMode;
  palette: DesktopPalette;
  accent: DesktopAccent;
}

export const DESKTOP_CHROME: Record<AppTheme, { background: string; foreground: string }> = {
  light: DESKTOP_PALETTES[0].light,
  dark: DESKTOP_PALETTES[0].dark,
};

export function normalizeDesktopAppearance(raw: unknown): DesktopAppearance {
  const settings = raw && typeof raw === "object" ? raw as Partial<DesktopAppearance> : {};
  return {
    mode: settings.mode === "light" || settings.mode === "dark" ? settings.mode : "system",
    palette: DESKTOP_PALETTES.find(({ id }) => id === settings.palette)?.id ?? "paper",
    accent: DESKTOP_ACCENTS.find(({ id }) => id === settings.accent)?.id ?? "theme",
  };
}

export function desktopChrome(theme: AppTheme, palette: DesktopPalette) {
  return (DESKTOP_PALETTES.find(({ id }) => id === palette) ?? DESKTOP_PALETTES[0])[theme];
}
