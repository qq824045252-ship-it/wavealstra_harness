export const DEFAULT_UI_FONT_SIZE = 15;
export const DEFAULT_CODE_FONT_SIZE = 13;

export const UI_FONT_WEIGHTS = [400, 500] as const;
export const REPLY_FONT_WEIGHTS = [400, 500, 600] as const;
export type UiFontWeight = (typeof UI_FONT_WEIGHTS)[number];
export type ReplyFontWeight = (typeof REPLY_FONT_WEIGHTS)[number];

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
