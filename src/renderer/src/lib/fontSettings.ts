import type { UserFontDto } from "@shared/agent-ipc";

export const DEFAULT_UI_FONT_SIZE = 15;
export const DEFAULT_CODE_FONT_SIZE = 13;
export const DEFAULT_UI_FONT_FAMILY = '"Segoe UI", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif';
export const DEFAULT_CODE_FONT_FAMILY = '"Cascadia Code", Consolas, "JetBrains Mono", monospace';
export const FONT_SETTINGS_EVENT = "mybuddy-font-settings-changed";

const LEGACY_PCT = [85, 92, 100, 110, 125] as const;

export interface AppliedFontSettings {
  uiFontSize: number;
  codeFontSize: number;
  uiFontFamily: string;
  codeFontFamily: string;
}

export function normalizeUiFontSize(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_UI_FONT_SIZE;
  return Math.min(20, Math.max(12, Math.round(raw)));
}

export function normalizeCodeFontSize(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_CODE_FONT_SIZE;
  return Math.min(20, Math.max(12, Math.round(raw)));
}

/** 旧版 CSS zoom 百分比 / 0–4 档迁移为真实 UI 字号。 */
export function legacyFontScaleToUiFontSize(raw: unknown): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return DEFAULT_UI_FONT_SIZE;
  const pct = Number.isInteger(raw) && raw >= 0 && raw <= 4
    ? (LEGACY_PCT[raw] ?? 105)
    : Math.min(150, Math.max(75, raw));
  return normalizeUiFontSize(Math.round((14 * pct) / 100));
}

let applied: AppliedFontSettings = {
  uiFontSize: DEFAULT_UI_FONT_SIZE,
  codeFontSize: DEFAULT_CODE_FONT_SIZE,
  uiFontFamily: "",
  codeFontFamily: "",
};

export function getAppliedFontSettings(): AppliedFontSettings {
  return { ...applied };
}

/**
 * 应用真实字体设置：只修改字体族/字号变量，不再使用 CSS zoom。
 * UI 与代码字体分开；空 family 表示使用各自默认字体栈。
 */
export function applyFontSettings(input: Partial<AppliedFontSettings>): AppliedFontSettings {
  applied = {
    uiFontSize: normalizeUiFontSize(input.uiFontSize ?? applied.uiFontSize),
    codeFontSize: normalizeCodeFontSize(input.codeFontSize ?? applied.codeFontSize),
    uiFontFamily: typeof input.uiFontFamily === "string" ? input.uiFontFamily : applied.uiFontFamily,
    codeFontFamily: typeof input.codeFontFamily === "string" ? input.codeFontFamily : applied.codeFontFamily,
  };

  const root = document.documentElement;
  root.style.setProperty("--font-ui", applied.uiFontFamily.trim() || DEFAULT_UI_FONT_FAMILY);
  root.style.setProperty("--font-mono", applied.codeFontFamily.trim() || DEFAULT_CODE_FONT_FAMILY);
  root.style.setProperty("--font-ui-size", `${applied.uiFontSize}px`);
  root.style.setProperty("--font-code-size", `${applied.codeFontSize}px`);

  // 清理旧版本遗留的内联 zoom / font-family，避免字号再次被整体缩放。
  document.body.style.removeProperty("zoom");
  document.body.style.removeProperty("font-family");
  document.body.style.removeProperty("font-size");

  window.dispatchEvent(
    new CustomEvent<AppliedFontSettings>(FONT_SETTINGS_EVENT, { detail: getAppliedFontSettings() }),
  );
  return getAppliedFontSettings();
}

const loadedFamilies = new Set<string>();

function toArrayBuffer(data: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (data instanceof ArrayBuffer) return data;
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy.buffer;
}

/** 用 FontFace 载入用户导入字体（幂等） */
export async function ensureUserFontLoaded(font: UserFontDto): Promise<void> {
  if (loadedFamilies.has(font.family) || document.fonts.check(`16px "${font.family}"`)) {
    loadedFamilies.add(font.family);
    return;
  }
  const raw = await window.api?.agent?.readUserFont?.(font.id);
  if (!raw) throw new Error(`无法读取字体：${font.fileName}`);
  const face = new FontFace(font.family, toArrayBuffer(raw), {
    style: "normal",
    weight: "400",
  });
  await face.load();
  document.fonts.add(face);
  loadedFamilies.add(font.family);
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
