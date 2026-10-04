/**
 * Wave 5C — pdfjs worker 入口包装
 *
 * vite 的 `?worker&inline` 只支持相对路径/别名，不支持裸说明符
 * （`pdfjs-dist/legacy/build/pdf.worker.min.mjs?worker&inline` 会解析失败）。
 * 本文件作为 `@/lib/pdfWorkerEntry?worker&inline` 的别名入口，把 pdfjs worker
 * 代码打入内联 blob worker（CSP script-src blob: 放行）。
 *
 * BUILD FLAVOR 约束（R24）：主线程 API 与 worker 必须同一 flavor。
 * 主线程用 `pdfjs-dist/legacy/build/pdf.mjs`（见 pdfRuntime.ts），
 * 因此 worker 必须用 `pdfjs-dist/legacy/build/pdf.worker.min.mjs`。
 * DO NOT mix legacy main with modern worker：modern worker 依赖
 * Uint8Array.prototype.toHex 等较新的运行时能力，legacy 主线程的 polyfill
 * 不会进入真实 worker 作用域 → `n2.toHex is not a function`。
 */
export * from "pdfjs-dist/legacy/build/pdf.worker.min.mjs";
