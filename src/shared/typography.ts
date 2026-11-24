export const DEFAULT_UI_FONT_SIZE = 15;
export const DEFAULT_CODE_FONT_SIZE = 13;

export const UI_FONT_WEIGHTS = [400, 500] as const;
export const REPLY_FONT_WEIGHTS = [400, 500, 600] as const;
export type UiFontWeight = (typeof UI_FONT_WEIGHTS)[number];
export type ReplyFontWeight = (typeof REPLY_FONT_WEIGHTS)[number];

export const NAVIGATION_FONT_ROLES = ["menu", "workspace", "task"] as const;
export const NAVIGATION_FONT_WEIGHTS = [400, 500, 600, 700] as const;
export type NavigationFontRole = (typeof NAVIGATION_FONT_ROLES)[number];
export type NavigationFontWeight = (typeof NAVIGATION_FONT_WEIGHTS)[number];

export interface NavigationFont {
  family: string;
  size: number | null;
  weight: NavigationFontWeight | null;
}

export type NavigationTypography = Partial<Record<NavigationFontRole, NavigationFont>>;
export const DEFAULT_NAVIGATION_FONT: NavigationFont = { family: "", size: null, weight: null };

export const REPLY_LINE_HEIGHTS = [1.5, 1.7, 1.95] as const;
export const REPLY_PARAGRAPH_GAPS = [0.55, 0.85, 1.2] as const;
export const CHAT_WIDTHS = { narrow: 620, standard: 744, wide: 1000 } as const;

export interface ReplyLayout {
  lineHeight: (typeof REPLY_LINE_HEIGHTS)[number];
  paragraphGap: (typeof REPLY_PARAGRAPH_GAPS)[number];
  width: keyof typeof CHAT_WIDTHS;
  headings: "subtle" | "prominent";
}

export const DEFAULT_REPLY_LAYOUT: ReplyLayout = { lineHeight: 1.7, paragraphGap: 0.85, width: "standard", headings: "subtle" };

function normalizeFontSize(raw: number, max: number): number {
  return Math.min(max, Math.max(12, Math.round(raw)));
}

export function normalizeUiFontSize(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw) ? normalizeFontSize(raw, 20) : DEFAULT_UI_FONT_SIZE;
}

export function normalizeCodeFontSize(raw: unknown): number {
  return typeof raw === "number" && Number.isFinite(raw) ? normalizeFontSize(raw, 20) : DEFAULT_CODE_FONT_SIZE;
}

export function normalizeReplyFontSize(raw: unknown): number | null {
  return typeof raw === "number" && Number.isFinite(raw) ? normalizeFontSize(raw, 24) : null;
}

export function normalizeUiFontWeight(raw: unknown): UiFontWeight {
  return raw === 500 ? 500 : 400;
}

export function normalizeReplyFontWeight(raw: unknown): ReplyFontWeight {
  return raw === 500 || raw === 600 ? raw : 400;
}

export function normalizeNavigationTypography(raw: unknown): NavigationTypography {
  if (!raw || typeof raw !== "object") return {};
  const saved = raw as Partial<Record<NavigationFontRole, Partial<NavigationFont>>>;
  const result: NavigationTypography = {};
  for (const role of NAVIGATION_FONT_ROLES) {
    const font = saved[role];
    if (!font) continue;
    const family = typeof font.family === "string" ? font.family.trim() : "";
    const size = typeof font.size === "number" && Number.isFinite(font.size) ? normalizeFontSize(font.size, 20) : null;
    const weight = NAVIGATION_FONT_WEIGHTS.find((option) => option === font.weight) ?? null;
    if (family || size !== null || weight !== null) result[role] = { family, size, weight };
  }
  return result;
}

export function normalizeReplyLayout(raw: unknown): ReplyLayout {
  const saved = raw && typeof raw === "object" ? raw as Partial<ReplyLayout> : {};
  return {
    lineHeight: REPLY_LINE_HEIGHTS.find((option) => option === saved.lineHeight) ?? DEFAULT_REPLY_LAYOUT.lineHeight,
    paragraphGap: REPLY_PARAGRAPH_GAPS.find((option) => option === saved.paragraphGap) ?? DEFAULT_REPLY_LAYOUT.paragraphGap,
    width: saved.width === "narrow" || saved.width === "wide" ? saved.width : DEFAULT_REPLY_LAYOUT.width,
    headings: saved.headings === "prominent" ? "prominent" : "subtle",
  };
}
