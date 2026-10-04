/**
 * Wave 5A — Monaco editor.worker 入口包装
 *
 * vite 的 `?worker&inline` 只支持相对路径/别名，不支持裸说明符
 * （`monaco-editor/esm/vs/editor/editor.worker.js?worker` 会解析失败）。
 * 本文件作为可被 `@/lib/monacoWorkerEntry?worker&inline` 命中的别名入口，
 * 把 monaco worker 代码打入内联 blob worker（CSP script-src blob: 放行）。
 */
export * from "monaco-editor/editor/editor.worker";
