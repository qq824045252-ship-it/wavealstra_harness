/**
 * Wave 5C — pdfjs worker 模块类型垫片
 *
 * vite `?worker&inline` 后缀 import 无类型声明；运行时由 vite 内联为 blob worker。
 */
declare module "@/lib/pdfWorkerEntry?worker&inline" {
  const WorkerCtor: new () => Worker;
  export default WorkerCtor;
}

declare module "pdfjs-dist/legacy/build/pdf.worker.min.mjs";

/**
 * pdfjs fake-worker 注册点：主线程 fallback 模式显式安装 WorkerMessageHandler
 * （与 pdf.worker.min.mjs 自身的 globalThis.pdfjsWorker 注册同构，显式化避免
 * 依赖 import 副作用）。pdf.js 的 PDFWorker.#initialize 检测到它就走 fake worker。
 */
declare var pdfjsWorker: { WorkerMessageHandler: unknown } | null | undefined;
