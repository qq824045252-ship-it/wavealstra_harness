/**
 * 环境规格 → 稳定身份。
 *
 * 为什么不在 shared/python-runtime.ts 里：那份契约会被 renderer 打进 bundle，
 * 而 node:crypto 在 renderer 构建中不可解析（rollup 直接报
 * `"createHash" is not exported by "__vite-browser-external"`）。
 * 身份计算只在主进程发生，放这里既能用 crypto，也保证 shared 契约保持纯净。
 */
import { createHash } from "node:crypto";
import { currentNodePlatform, pythonProjectCacheKey } from "../platform/runtime";
import { DEFAULT_PYTHON_REQUEST, type PythonEnvironmentSpec } from "../../shared/python-runtime";

/** Commas in version bounds and extras belong to one requirement. */
export function splitPythonDependencies(text: string): string[] {
  const result: string[] = [];
  let start = 0, depth = 0, quote = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) { if (ch === quote && text[i - 1] !== "\\") quote = ""; continue; }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (ch === "[") depth++;
    if (ch === "]") depth--;
    if (depth === 0 && (ch === "\n" || (ch === "," && /^\s*[A-Za-z0-9]/.test(text.slice(i + 1))))) {
      result.push(text.slice(start, i).trim()); start = i + 1;
    }
  }
  result.push(text.slice(start).trim());
  return result.filter(Boolean);
}

/** 规范化规格：去空、去重、依赖按不区分大小写排序，保证同义规格得到同一 id。 */
export function normalizePythonEnvironmentSpec(spec: PythonEnvironmentSpec | undefined): {
  python: string;
  dependencies: string[];
} {
  const python = (spec?.python ?? DEFAULT_PYTHON_REQUEST).trim() || DEFAULT_PYTHON_REQUEST;
  if (!/^[0-9<>=!~.*,\s]+$/.test(python) || !/\d/.test(python)) throw new Error("Python must be a version or version range");
  const seen = new Map<string, string>();
  for (const raw of spec?.dependencies ?? []) {
    const dep = String(raw ?? "").trim();
    if (!dep) continue;
    if (dep.startsWith("-") || /[\r\n]/.test(dep)) throw new Error("Invalid Python dependency");
    seen.set(dep.toLowerCase(), dep);
  }
  const dependencies = [...seen.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
    .map(([, original]) => original);
  return { python, dependencies };
}

/**
 * 环境 id = 规范化规格（含 profile）的 sha256 前 16 位。
 * 纯函数，可单测；不含时间戳/随机数，因此跨进程稳定、可复用。
 */
export function pythonEnvironmentSpecId(spec: PythonEnvironmentSpec | undefined): string {
  const normalized = normalizePythonEnvironmentSpec(spec);
  const profile = (spec?.profile ?? "").trim();
  const payload = JSON.stringify({
    v: 2,
    platform: currentNodePlatform,
    arch: process.arch,
    profile,
    python: normalized.python,
    dependencies: normalized.dependencies,
  });
  return createHash("sha256").update(payload, "utf8").digest("hex").slice(0, 16);
}

/** 规格摘要，用于 UI 一行展示。 */
export function describePythonEnvironmentSpec(spec: PythonEnvironmentSpec | undefined): string {
  const normalized = normalizePythonEnvironmentSpec(spec);
  const profile = (spec?.profile ?? "").trim();
  const prefix = profile ? `${profile} · ` : "";
  if (normalized.dependencies.length === 0) return `${prefix}Python ${normalized.python} · 基础环境`;
  return `${prefix}Python ${normalized.python} · ${normalized.dependencies.join(", ")}`;
}

/**
 * 项目目录的查找键。
 *
 * Windows 路径大小写不敏感且分隔符两种写法都常见（`C:\proj` 与 `c:/proj` 指同一目录），
 * 直接拿原始字符串做主键会让「绑定过的项目」在换个写法后就查不到，
 * 于是同一个项目被反复询问——正好违反「保存绑定关系，不反复询问」。
 */
export function pythonProjectDirKey(dir: string, platform: NodeJS.Platform = currentNodePlatform): string {
  return pythonProjectCacheKey(dir, platform);
}

/** 项目绑定的稳定短 id：同一目录在重启前后得到同一个 environmentId。 */
export function pythonProjectBindingId(dirKey: string): string {
  return createHash("sha256").update(`python-project:${dirKey}`, "utf8").digest("hex").slice(0, 12);
}
