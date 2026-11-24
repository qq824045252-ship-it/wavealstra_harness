import type { AppSettingsDto, UserFontDto } from "@shared/agent-ipc";
import {
  DEFAULT_CODE_FONT_SIZE,
  DEFAULT_REPLY_LAYOUT,
  DEFAULT_UI_FONT_SIZE,
  CHAT_WIDTHS,
  NAVIGATION_FONT_ROLES,
  normalizeCodeFontSize,
  normalizeNavigationTypography,
  normalizeReplyFontSize,
  normalizeReplyFontWeight,
  normalizeReplyLayout,
  normalizeUiFontSize,
  normalizeUiFontWeight,
  type ReplyFontWeight,
  type NavigationTypography,
  type ReplyLayout,
  type UiFontWeight,
} from "@shared/typography";

export const DEFAULT_UI_FONT_FAMILY = '"Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';
export const DEFAULT_CODE_FONT_FAMILY = '"Cascadia Code", Consolas, "JetBrains Mono", monospace';
export const READING_FONT_FAMILY = '"Source Serif 4 Reading", "Noto Serif SC", "Source Han Serif SC", "Songti SC", SimSun, Georgia, serif';
export const FONT_SETTINGS_EVENT = "mybuddy-font-settings-changed";

const LEGACY_PCT = [85, 92, 100, 110, 125] as const;

export interface AppliedFontSettings {
  uiFontSize: number;
  codeFontSize: number;
  uiFontFamily: string;
  codeFontFamily: string;
  replyFontFamily: string;
  replyFontSize: number | null;
  replyFontWeight: ReplyFontWeight;
  uiFontWeight: UiFontWeight;
  navigationTypography: NavigationTypography;
  replyLayout: ReplyLayout;
}

/** 旧版 CSS zoom 百分比 / 0–4 档迁移为真实 UI 字号。 */
function legacyFontScaleToUiFontSize(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_UI_FONT_SIZE;
  const pct = Number.isInteger(raw) && raw >= 0 && raw <= 4
    ? (LEGACY_PCT[raw] ?? 105)
    : Math.min(150, Math.max(75, raw));
  return normalizeUiFontSize(Math.round((14 * pct) / 100));
}

export const DEFAULT_APPLIED_FONT_SETTINGS: Readonly<AppliedFontSettings> = {
  uiFontSize: DEFAULT_UI_FONT_SIZE,
  codeFontSize: DEFAULT_CODE_FONT_SIZE,
  uiFontFamily: "",
  codeFontFamily: "",
  replyFontFamily: "",
  replyFontSize: null,
  replyFontWeight: 400,
  uiFontWeight: 400,
  navigationTypography: {},
  replyLayout: DEFAULT_REPLY_LAYOUT,
};

let applied: AppliedFontSettings = { ...DEFAULT_APPLIED_FONT_SETTINGS };

export function resolveFontSettings(settings: Partial<AppliedFontSettings> & Pick<AppSettingsDto, "fontSize" | "fontFamily">): AppliedFontSettings {
  return {
    uiFontSize: normalizeUiFontSize(settings.uiFontSize ?? legacyFontScaleToUiFontSize(settings.fontSize)),
    codeFontSize: normalizeCodeFontSize(settings.codeFontSize),
    uiFontFamily: settings.uiFontFamily ?? settings.fontFamily ?? "",
    codeFontFamily: settings.codeFontFamily ?? "",
    replyFontFamily: settings.replyFontFamily ?? "",
    replyFontSize: normalizeReplyFontSize(settings.replyFontSize),
    replyFontWeight: normalizeReplyFontWeight(settings.replyFontWeight),
    uiFontWeight: normalizeUiFontWeight(settings.uiFontWeight),
    navigationTypography: normalizeNavigationTypography(settings.navigationTypography),
    replyLayout: normalizeReplyLayout(settings.replyLayout),
  };
}

export function getAppliedFontSettings(): AppliedFontSettings {
  return { ...applied };
}

/**
 * 通过字体变量应用排版设置，保持窗口布局和控件尺寸。
 */
export function applyFontSettings(input: Partial<AppliedFontSettings>): AppliedFontSettings {
  applied = resolveFontSettings({ ...applied, ...input });

  const root = document.documentElement;
  const uiFamily = applied.uiFontFamily.trim();
  const codeFamily = applied.codeFontFamily.trim();
  const replyFamily = applied.replyFontFamily.trim();
  root.style.setProperty("--font-ui", uiFamily ? `${uiFamily}, ${DEFAULT_UI_FONT_FAMILY}` : DEFAULT_UI_FONT_FAMILY);
  root.style.setProperty("--font-mono", codeFamily ? `${codeFamily}, ${DEFAULT_CODE_FONT_FAMILY}` : DEFAULT_CODE_FONT_FAMILY);
  root.style.setProperty("--font-ui-size", `${applied.uiFontSize}px`);
  root.style.setProperty("--font-code-size", `${applied.codeFontSize}px`);
  root.style.setProperty("--font-ui-weight", String(applied.uiFontWeight));
  root.style.setProperty("--font-reply", replyFamily ? `${replyFamily}, var(--font-ui)` : "var(--font-ui)");
  root.style.setProperty("--font-reply-size", applied.replyFontSize === null ? "var(--font-ui-size)" : `${applied.replyFontSize}px`);
  root.style.setProperty("--font-reply-weight", String(applied.replyFontWeight));
  for (const role of NAVIGATION_FONT_ROLES) {
    const font = applied.navigationTypography[role];
    root.style.setProperty(`--font-${role}-family`, font?.family ? `${font.family}, var(--font-ui)` : "");
    root.style.setProperty(`--font-${role}-size`, font?.size == null ? "" : `${font.size}px`);
    root.style.setProperty(`--font-${role}-weight`, font?.weight == null ? "" : String(font.weight));
  }
  root.style.setProperty("--reply-line-height", String(applied.replyLayout.lineHeight));
  root.style.setProperty("--reply-paragraph-gap", `${applied.replyLayout.paragraphGap}em`);
  root.style.setProperty("--preferred-chat-width", `${CHAT_WIDTHS[applied.replyLayout.width]}px`);
  root.dataset.replyHeadings = applied.replyLayout.headings;

  // 清理旧版本遗留的内联 zoom / font-family，避免字号再次被整体缩放。
  document.body.style.removeProperty("zoom");
  document.body.style.removeProperty("font-family");
  document.body.style.removeProperty("font-size");

  window.dispatchEvent(
    new CustomEvent<AppliedFontSettings>(FONT_SETTINGS_EVENT, { detail: getAppliedFontSettings() }),
  );
  return getAppliedFontSettings();
}

const loadedFonts = new Map<string, Promise<FontFace>>();

function toArrayBuffer(data: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data;
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy.buffer;
}

async function readUserFontFace(font: UserFontDto): Promise<FontFace> {
  const raw = await window.api?.agent?.readUserFont?.(font.id);
  if (!raw) throw new Error(`无法读取字体：${font.fileName}`);
  const face = new FontFace(font.family, toArrayBuffer(raw), {
    style: "normal",
    weight: "400",
  });
  return face.load();
}

export async function ensureUserFontLoaded(font: UserFontDto): Promise<void> {
  let pending = loadedFonts.get(font.id);
  if (!pending) {
    pending = readUserFontFace(font);
    loadedFonts.set(font.id, pending);
  }
  try {
    const face = await pending;
    if (loadedFonts.get(font.id) === pending) document.fonts.add(face);
  } catch (err) {
    if (loadedFonts.get(font.id) === pending) loadedFonts.delete(font.id);
    throw err;
  }
}

export async function unloadUserFont(id: string): Promise<void> {
  const pending = loadedFonts.get(id);
  loadedFonts.delete(id);
  const face = await pending?.catch(() => undefined);
  if (face) document.fonts.delete(face);
}

export async function ensureAllUserFontsLoaded(fonts: UserFontDto[]): Promise<void> {
  for (const f of fonts) {
    try {
      await ensureUserFontLoaded(f);
    } catch (err) {
      console.warn("[fonts] load failed", f.id, err);
    }
  }
}

export function userFontCssFamily(family: string): string {
  if (/[\s,]/.test(family)) return `"${family.replace(/"/g, "")}"`;
  return family;
}
