export type AppTheme = "light" | "dark";

export const DESKTOP_CHROME: Record<AppTheme, { background: string; foreground: string }> = {
  light: { background: "#f1ebe0", foreground: "#2b2622" },
  dark: { background: "#1e1c18", foreground: "#f0e9dd" },
};
