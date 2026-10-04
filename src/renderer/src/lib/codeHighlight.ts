/**
 * Wave 5A — Shiki 生产集成（V3.5 §52/§84 冻结决策）
 *
 * 决策（spike-1f-shiki-decision.md）：
 *   - 静态代码 Artifact 默认：Shiki + JavaScript RegExp engine（非 Oniguruma WASM）
 *   - 生产实现：shiki/core（createHighlighterCore）+ 语言子集 + 双主题
 *   - 大文件：首帧纯文本 + 后台分块高亮（10.9k 行 warm ≈ 641ms 不能阻塞首帧）
 *
 * 本模块为纯逻辑（无 DOM 依赖），可在 node 中直接单测（esbuild bundle）。
 * 主题切换成本：tokens 双主题变体一次 tokenize 完成；换主题只重建可见行 HTML。
 */
import { createHighlighterCore, type HighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "@shikijs/engine-javascript";
import { bundledLanguages } from "shiki/langs";
import { bundledThemes } from "shiki/themes";

export type CodeTheme = "light" | "dark";

/** 语言子集（spike 1F：MyBuddy 实际语言，bundle 从 ~10MB 压到 1-2MB 级） */
export const SUPPORTED_LANGS = [
  "typescript",
  "javascript",
  "json",
  "python",
  "shellscript",
  "markdown",
  "css",
  "html",
  "yaml",
] as const;

export type SupportedLang = (typeof SUPPORTED_LANGS)[number];

/** Artifact language 字段 → Shiki lang id 映射（含别名） */
const LANG_ALIASES: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "javascript",
  tsx: "typescript",
  py: "python",
  python3: "python",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  shell: "shellscript",
  md: "markdown",
  gfm: "markdown",
  yml: "yaml",
  jsonc: "json",
  json5: "json",
  xml: "html",
  xsl: "html",
  xslt: "html",
  svg: "html",
};

const DUAL_THEMES = { light: "github-light", dark: "github-dark" } as const;

let highlighterPromise: Promise<HighlighterCore> | null = null;

/** 惰性单例：首次 tokenize 才初始化（init ≈ 19ms，含 grammar 编译预热） */
export function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = createHighlighterCore({
      themes: [bundledThemes["github-light"], bundledThemes["github-dark"]],
      langs: SUPPORTED_LANGS.map((l) => bundledLanguages[l]),
      engine: createJavaScriptRegexEngine(),
    });
  }
  return highlighterPromise;
}

/** 预热（可提前调用；失败静默，首次使用时重试） */
export function prewarmHighlighter(): void {
  void getHighlighter().catch(() => {
    highlighterPromise = null;
  });
}

export function normalizeLanguage(language: string | undefined | null): string | null {
  const raw = (language ?? "").trim().toLowerCase();
  if (!raw) return null;
  if ((SUPPORTED_LANGS as readonly string[]).includes(raw)) return raw;
  const aliased = LANG_ALIASES[raw];
  if (aliased) return aliased;
  // 语言不存在时降级为 null（纯文本），不抛错
  return null;
}

// ---------- 降级阈值（大文件策略，spike 1F/1G 数据驱动） ----------

/** 超过该行数：跳过整篇 tokenize，纯文本 + 虚拟列表（10.9k 行 641ms 不可阻塞） */
export const PLAIN_TEXT_LINE_THRESHOLD = 30_000;
/** 超过该字节数：同样跳过 tokenize */
export const PLAIN_TEXT_BYTE_THRESHOLD = 3 * 1024 * 1024;
/** 超过该行数：高亮完成后分块换入（每块行数） */
export const CHUNK_SWAP_LINE_THRESHOLD = 2_000;
export const CHUNK_SIZE = 400;
/** 超过该字节数：编辑态（Monaco）降级为只读提示（spike 1G：1MB+ 建议降级） */
export const EDIT_DISABLED_BYTE_THRESHOLD = 1024 * 1024;

export interface DegradationPolicy {
  plainText: boolean; // 完全不做语法高亮
  chunkedSwap: boolean; // 高亮完成后分块换入（异步）
  editDisabled: boolean; // 编辑模式不可用
  reason: string | null;
}

export function degradationPolicy(lines: number, bytes: number): DegradationPolicy {
  const plainText = lines > PLAIN_TEXT_LINE_THRESHOLD || bytes > PLAIN_TEXT_BYTE_THRESHOLD;
  const chunkedSwap = !plainText && lines > CHUNK_SWAP_LINE_THRESHOLD;
  const editDisabled = bytes > EDIT_DISABLED_BYTE_THRESHOLD;
  const reason = plainText
    ? `超大文件（${lines.toLocaleString()} 行 / ${(bytes / 1024 / 1024).toFixed(1)} MB）：已禁用语法高亮`
    : editDisabled
      ? `文件超过 1MB：编辑模式不可用（spike 1G 降级策略）`
      : null;
  return { plainText, chunkedSwap, editDisabled, reason };
}

// ---------- Token 模型（双主题变体，一次 tokenize） ----------

export interface TokenVariant {
  color: string;
  fontStyle: number; // 0=normal 1=italic 2=bold 3=bold+italic
}

export interface DualToken {
  content: string;
  light: TokenVariant;
  dark: TokenVariant;
}

export type TokenLine = DualToken[];

export interface TokenizedCode {
  lines: TokenLine[];
  /** 未识别语言时为 null（纯文本展示） */
  lang: string | null;
  /** 语言已识别但 tokenize 失败时的降级标记 */
  failed: boolean;
}

interface ShikiTokenWithVariants {
  content: string;
  variants: {
    light?: { color?: string; fontStyle?: number };
    dark?: { color?: string; fontStyle?: number };
  };
}

/**
 * 整篇 tokenize（双主题一次完成）。
 * 注意：大文件调用前先查 degradationPolicy —— 本函数会阻塞 ~641ms/10.9k 行，
 * 调用方必须放在后台任务中执行。
 */
export async function tokenizeCode(code: string, language?: string | null): Promise<TokenizedCode> {
  const lang = normalizeLanguage(language);
  if (!lang) return { lines: [], lang: null, failed: false };
  try {
    const hi = await getHighlighter();
    const tokens = hi.codeToTokensWithThemes(code, {
      lang,
      themes: DUAL_THEMES,
    }) as unknown as ShikiTokenWithVariants[][];
    const lines: TokenLine[] = tokens.map((line) =>
      line.map((t) => ({
        content: t.content,
        light: {
          color: t.variants.light?.color ?? "",
          fontStyle: t.variants.light?.fontStyle ?? 0,
        },
        dark: {
          color: t.variants.dark?.color ?? "",
          fontStyle: t.variants.dark?.fontStyle ?? 0,
        },
      })),
    );
    return { lines, lang, failed: false };
  } catch (error) {
    console.warn("[codeHighlight] tokenize failed, degrade to plain text", error);
    return { lines: [], lang, failed: true };
  }
}

// ---------- 行 HTML 构建（纯函数，可单测） ----------

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

const FONT_STYLE_CSS = ["", "italic", "font-weight:600", "italic;font-weight:600"];

/** 单行 tokens → HTML（按主题）。空白 token（无颜色/无样式）不产出 span，减少 DOM 节点。 */
export function tokenLineToHtml(line: TokenLine, theme: CodeTheme): string {
  if (line.length === 0) return "";
  let html = "";
  for (const token of line) {
    if (token.content.length === 0) continue;
    const variant = theme === "light" ? token.light : token.dark;
    const styled = variant.fontStyle > 0 || variant.color;
    if (!styled && /^\s+$/.test(token.content)) continue; // 无样式的纯空白 token 无视觉信息
    const style = styled
      ? ` style="${[
          variant.color ? `color:${variant.color}` : "",
          FONT_STYLE_CSS[variant.fontStyle] ?? "",
        ]
          .filter(Boolean)
          .join(";")}"`
      : "";
    html += `<span${style}>${escapeHtml(token.content)}</span>`;
  }
  return html;
}

/** 纯文本行 HTML（降级路径） */
export function plainLineToHtml(line: string): string {
  return escapeHtml(line);
}

/** 语言徽章显示名 */
export function languageBadge(language: string | null | undefined): string {
  const raw = (language ?? "").trim().toLowerCase();
  if (raw === "xml" || raw === "xsl" || raw === "xslt") return "xml";
  const norm = normalizeLanguage(language);
  if (!norm) return "text";
  if (norm === "shellscript") return "shell";
  return norm;
}
