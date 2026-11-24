import {
  DESKTOP_ACCENTS, desktopChrome, normalizeDesktopAppearance,
  type AppTheme, type AppThemeMode, type DesktopAppearance,
} from "@shared/desktop-theme";

export type Theme = AppTheme;

const STORAGE_KEY = "mybuddy-desktop-appearance";
export const SYSTEM_DARK_MEDIA = "(prefers-color-scheme: dark)";

export function applyTheme(theme: Theme, appearance: DesktopAppearance): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.theme = theme;
  root.dataset.palette = appearance.palette;
  root.style.colorScheme = theme;
  root.style.setProperty("--desktop-chrome", desktopChrome(theme, appearance.palette).background);
  const accent = DESKTOP_ACCENTS.find((option) => option.id === appearance.accent);
  const accentColor = accent && "light" in accent ? accent[theme] : "";
  root.style.setProperty("--accent-override", accentColor);
  root.style.setProperty("--accent-button-ink-override", accentColor ? (theme === "dark" ? "#15191e" : "#ffffff") : "");
  syncNativeTheme(appearance);
}

export function cacheDesktopAppearance(appearance: DesktopAppearance): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(appearance));
  } catch {
    /* private mode */
  }
}

export function syncNativeTheme(appearance: DesktopAppearance): void {
  window.api?.setTheme?.(appearance.mode, appearance.palette);
}

export function getInitialAppearance(fallback: AppThemeMode = "system"): DesktopAppearance {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value) return normalizeDesktopAppearance(JSON.parse(value));
    const legacy = localStorage.getItem("mybuddy-theme");
    if (legacy === "light" || legacy === "dark") return normalizeDesktopAppearance({ mode: legacy });
  } catch {
    /* ignore */
  }
  return normalizeDesktopAppearance({ mode: fallback });
}

export function resolveTheme(mode: AppThemeMode): Theme {
  if (mode !== "system") return mode;
  return typeof window !== "undefined" && window.matchMedia?.(SYSTEM_DARK_MEDIA)?.matches ? "dark" : "light";
}
