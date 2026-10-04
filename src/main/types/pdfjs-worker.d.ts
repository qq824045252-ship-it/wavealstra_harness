/**
 * pdfjs-dist legacy worker 模块类型垫片（main 进程 fake-worker 模式）。
 * 与 renderer 的 types/pdfjs.d.ts 同构；仅在主进程抽取器中使用 WorkerMessageHandler。
 */
declare module "pdfjs-dist/legacy/build/pdf.worker.min.mjs" {
  export const WorkerMessageHandler: unknown;
}
