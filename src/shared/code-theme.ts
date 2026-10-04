export type CodeThemeId =
  | "vitesse"
  | "github"
  | "one"
  | "catppuccin"
  | "solarized"
  | "everforest"
  | "min"
  | "dracula"
  | "nord"
  | "tokyo-night"
  | "monokai";

export type CodeThemeMode = "dual" | "dark";

export interface CodeThemeOption {
  id: CodeThemeId;
  label: string;
  mode: CodeThemeMode;
}

export const DEFAULT_CODE_THEME: CodeThemeId = "everforest";

export const CODE_THEME_OPTIONS: ReadonlyArray<CodeThemeOption> = [
  { id: "vitesse", label: "Vitesse", mode: "dual" },
  { id: "github", label: "GitHub", mode: "dual" },
  { id: "one", label: "One", mode: "dual" },
  { id: "catppuccin", label: "Catppuccin", mode: "dual" },
  { id: "solarized", label: "Solarized", mode: "dual" },
  { id: "everforest", label: "Everforest", mode: "dual" },
  { id: "min", label: "Min", mode: "dual" },
  { id: "dracula", label: "Dracula", mode: "dark" },
  { id: "nord", label: "Nord", mode: "dark" },
  { id: "tokyo-night", label: "Tokyo Night", mode: "dark" },
  { id: "monokai", label: "Monokai", mode: "dark" },
];

const CODE_THEME_IDS = new Set<CodeThemeId>(CODE_THEME_OPTIONS.map((option) => option.id));

export function normalizeCodeTheme(raw: unknown): CodeThemeId {
  // 兼容刚引入代码主题时的内部 "default" 值，不把临时实现留成长期 UI 选项。
  if (raw === "default") return DEFAULT_CODE_THEME;
  return typeof raw === "string" && CODE_THEME_IDS.has(raw as CodeThemeId)
    ? (raw as CodeThemeId)
    : DEFAULT_CODE_THEME;
}
