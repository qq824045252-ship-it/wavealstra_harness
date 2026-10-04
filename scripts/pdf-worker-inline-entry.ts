/**
 * PDF Runtime E2E — 真实内联 legacy pdfjs worker（仅测试打包使用）
 *
 * 生产链路：vite `?worker&inline` 把 pdfWorkerEntry（legacy worker）打成内联
 * blob worker。esbuild 测试 bundle 不支持 vite worker 语法，本文件用 esbuild
 * `?raw` 加载预先打包好的 legacy worker IIFE，构造等价的 blob worker：
 *   - 同 flavor：legacy（与主线程 pdfjs-dist/legacy/build/pdf.mjs 一致，R24）
 *   - 同形态：真实 Worker 线程（不是主线程 fake worker）
 *   - pdfjs 主线程校验 `workerPort instanceof Worker`（pdf.mjs），
 *     因此必须继承原生 Worker，不能用普通包装类（会抛 Invalid workerPort type）。
 *
 * 这是 wave5c-e2e（preview stub → fake worker 主线程路径，legacy polyfill 掩盖
 * toHex 缺口）抓不到的运行时问题面：真实 worker 作用域没有主线程 legacy
 * polyfill，若 worker 是 modern build 会报 `n2.toHex is not a function`。
 *
 * 由 scripts/build-pdf-runtime-preview.mjs 先生成 out/tests/pdf.worker.legacy.iife.js
 * （IIFE，classic blob worker；WasmImage 动态 import 已替换为 Promise.reject 降级）
 * 及其文本副本 .iife.txt。
 *
 * 嵌入方式：Vite 的 `?raw` 后缀是 Vite 特性，esbuild 会忽略它并按普通 JS 模块
 * 打包（IIFE 无导出 → default 为 undefined → Blob 内容变成字符串 "undefined" →
 * worker 启动即 SyntaxError）。因此这里导入 `.txt` 副本，由测试打包配置的
 * text loader（build-pdf-runtime-preview.mjs 中 loader: { ".txt": "text" }）
 * 原样返回文件内容字符串。
 */
// eslint-disable-next-line import/no-unresolved
import workerCode from "../out/tests/pdf.worker.legacy.iife.txt";

let objectUrl: string | null = null;

function workerBlobUrl(): string {
  if (objectUrl === null) {
    objectUrl = URL.createObjectURL(new Blob([workerCode], { type: "text/javascript" }));
  }
  return objectUrl;
}

// 诊断钩子（E2E）：暴露内联的 worker 源码，供主进程校验完整性
(globalThis as unknown as Record<string, unknown>).__pdfWorkerCode = workerCode;

export default class PdfRuntimeInlineWorker extends Worker {
  constructor() {
    super(workerBlobUrl());
    // worker 内部错误（含解析错误）主动上报到页面 console，E2E 可见
    this.onerror = (event) => {
      console.error(`[pdf-worker-inline] onerror: ${event.message} @ ${event.filename}:${event.lineno}`);
    };
  }

  terminate(): void {
    super.terminate();
    if (objectUrl !== null) {
      URL.revokeObjectURL(objectUrl);
      objectUrl = null;
    }
  }
}
