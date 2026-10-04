export type Theme = "light" | "dark";

const STORAGE_KEY = "mybuddy-theme";

export function applyTheme(theme: Theme): void {
  if (typeof document === "undefined") return;
  document.documentElement.dataset.theme = theme;
  document.documentElement.style.colorScheme = theme;
  try {
    localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    /* private mode */
  }
  if (window.api?.setTheme) {
    window.api.setTheme(theme);
  }
}

export function syncNativeTheme(): void {
  const theme =
    document.documentElement.dataset.theme === "dark"
      ? "dark"
      : document.documentElement.dataset.theme === "light"
        ? "light"
        : getInitialTheme();
  if (window.api?.setTheme) {
    window.api.setTheme(theme);
  }
}

export function getStoredTheme(): Theme | null {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    if (value === "light" || value === "dark") return value;
  } catch {
    /* ignore */
  }
  return null;
}

export function getInitialTheme(): Theme {
  const stored = getStoredTheme();
  if (stored) return stored;
  if (typeof window !== "undefined" && window.matchMedia("(prefers-color-scheme: dark)").matches) {
    return "dark";
  }
  return "light";
}
