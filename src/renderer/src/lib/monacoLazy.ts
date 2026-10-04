/**
 * Wave 5A — Monaco 编辑态 lazy-load（V3.5 §53 冻结决策）
 *
 * 决策（spike-1g-monaco-decision.md）：
 *   - 静态查看 = Shiki；只有用户进入编辑态才 dynamic import Monaco
 *   - 冷加载 485-577ms + worker 203-210ms 绝不允许进入首屏成本
 *   - 关闭编辑态必须 editor.dispose() + model.dispose()（否则内存不回收，1G 实测）
 *   - 1MB+ 文件提示只读/超大文件降级（本文件导出 EDIT_DISABLED_BYTE_THRESHOLD 由调用方判定）
 *
 * 打包（vite）：
 *   - dynamic import 产出独立 chunk（~MB 级，仅编辑态加载）
 *   - worker：vite `?worker&inline` 内联 blob worker（monaco 0.56 exports map 只放行
 *     `monaco-editor/<path>` 形式说明符，deep `esm/` 路径不可直接 import）
 */

export type MonacoModule = typeof import("monaco-editor/editor/editor.api");

// vite `?worker&inline`：worker 内联为 blob URL（CSP script-src blob: 放行）；
// 只随本模块（编辑态）加载，不进首屏 chunk。
// eslint-disable-next-line import/no-unresolved
import EditorWorker from "@/lib/monacoWorkerEntry?worker&inline";

/** Monaco 语言 id 映射（basic-languages 注册名） */
const MONACO_LANG_IDS: Record<string, string> = {
  typescript: "typescript",
  javascript: "javascript",
  json: "json",
  python: "python",
  shellscript: "shell",
  markdown: "markdown",
  css: "css",
  html: "html",
  yaml: "yaml",
  xml: "html",
};

let monacoPromise: Promise<MonacoModule> | null = null;

function setupWorkerEnvironment(): void {
  const env = self as unknown as {
    MonacoEnvironment?: { getWorker: () => Worker };
  };
  if (env.MonacoEnvironment) return;
  env.MonacoEnvironment = {
    getWorker: () => new EditorWorker(),
  };
}

/** 按需加载（幂等）：editor.api + 语言贡献。返回后即可 create。 */
export function loadMonaco(): Promise<MonacoModule> {
  if (!monacoPromise) {
    monacoPromise = (async () => {
      setupWorkerEnvironment();
      const [monaco] = await Promise.all([
        import("monaco-editor/editor/editor.api"),
        import("monaco-editor/languages/definitions/typescript/register"),
        import("monaco-editor/languages/definitions/javascript/register"),
        import("monaco-editor/languages/features/json/register"),
        import("monaco-editor/languages/definitions/python/register"),
        import("monaco-editor/languages/definitions/shell/register"),
        import("monaco-editor/languages/definitions/markdown/register"),
      ]);
      return monaco;
    })().catch((error) => {
      // 失败后允许重试
      monacoPromise = null;
      throw error;
    });
  }
  return monacoPromise;
}

export function monacoLanguageFor(language: string | null | undefined): string {
  const norm = (language ?? "").trim().toLowerCase();
  return MONACO_LANG_IDS[norm] ?? (norm || "plaintext");
}

export interface MonacoSession {
  editor: import("monaco-editor/editor/editor.api").editor.IStandaloneCodeEditor;
  model: import("monaco-editor/editor/editor.api").editor.ITextModel;
  /** 释放 editor + model（幂等） */
  dispose: () => void;
}

/**
 * 创建编辑会话。必须持有返回值，退出编辑态时调用 dispose()。
 * dispose 后不可再使用 editor 引用。
 */
export async function createMonacoSession(
  container: HTMLElement,
  content: string,
  language: string | null | undefined,
  theme: "light" | "dark",
): Promise<MonacoSession> {
  const monaco = await loadMonaco();
  const langId = monacoLanguageFor(language);
  const model = monaco.editor.createModel(content, langId);
  const editor = monaco.editor.create(container, {
    model,
    theme: theme === "dark" ? "vs-dark" : "vs",
    automaticLayout: true,
    fontSize: 13,
    fontFamily: "var(--font-mono)",
    minimap: { enabled: true, maxColumn: 80 },
    scrollBeyondLastLine: false,
    lineNumbersMinChars: 4,
    wordWrap: "off",
    tabSize: 2,
    renderWhitespace: "none",
    padding: { top: 12, bottom: 12 },
    scrollbar: { verticalScrollbarSize: 10, horizontalScrollbarSize: 10 },
  });
  let disposed = false;
  return {
    editor,
    model,
    dispose: () => {
      if (disposed) return;
      disposed = true;
      editor.dispose();
      model.dispose();
    },
  };
}
