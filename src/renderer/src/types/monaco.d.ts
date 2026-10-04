/**
 * Wave 5A — monaco-editor 子路径模块的类型垫片
 *
 * monaco-editor 0.56 的 package.json exports 只给根路径声明了 types，
 * `monaco-editor/<path>` 子路径（editor.api / languages 注册模块）无类型声明
 * → TS2307。运行时由 vite 按 exports 映射解析真实文件；此处只补类型。
 */
declare module "monaco-editor/editor/editor.api" {
  export * from "monaco-editor";
}

declare module "monaco-editor/editor/editor.worker" {
  const worker: unknown;
  export default worker;
}

declare module "monaco-editor/languages/definitions/*/register" {
  const register: unknown;
  export default register;
}

declare module "monaco-editor/languages/features/json/register" {
  const register: unknown;
  export default register;
}

declare module "@/lib/monacoWorkerEntry?worker&inline" {
  const WorkerCtor: new () => Worker;
  export default WorkerCtor;
}
