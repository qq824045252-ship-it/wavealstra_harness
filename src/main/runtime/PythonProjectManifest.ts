/**
 * 从真实 Python 项目的清单推导依赖规格。
 *
 * 用途：内置能力（如本地 Whisper）与用户项目本身就带 pyproject.toml /
 * requirements.txt / .python-version。这类对象的环境必须由它们自己的清单决定，
 * 而不是由 MyBuddy 猜一份包列表——否则「真实 Python 项目仍能使用自己的环境」
 * 就是一句空话。
 *
 * 解析刻意保持最小且纯函数：只取 [project].dependencies 数组、requires-python、
 * .python-version 与 requirements.txt 的非注释行。不实现完整 TOML。
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { PythonEnvironmentSpec } from "../../shared/python-runtime";

export type PythonManifestSource = "pyproject" | "requirements" | "python-version" | "none";

export interface PythonProjectSpecResult {
  spec: PythonEnvironmentSpec;
  /** 实际读到依赖的来源，便于诊断"为什么是这个包列表" */
  source: PythonManifestSource;
  projectDir: string;
  /** 清单里声明的 requires-python 原文（可能为空） */
  requiresPython: string | null;
  detail: string;
}

/** 去掉行内注释与首尾引号；PEP 508 里的 `#` 极少见，按 requirements.txt 惯例处理。 */
function stripRequirementLine(line: string): string {
  return line
    .replace(/#.*$/, "")
    .trim()
    .replace(/^["']|["']$/g, "")
    .replace(/,\s*$/, "")
    .trim();
}

/**
 * 提取 `[project]` 段下的 `dependencies = [ ... ]`。
 * 只认标准缩进的多行数组写法（uv/poetry/setuptools 生成的都是这种）。
 */
export function parsePyprojectDependencies(text: string): string[] {
  const lines = text.split(/\r?\n/);
  let inProject = false;
  let inDependencies = false;
  let depth = 0;
  const result: string[] = [];

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^\[/.test(line)) {
      inProject = line === "[project]";
      inDependencies = false;
      depth = 0;
      continue;
    }
    if (!inProject) continue;

    if (!inDependencies) {
      const match = line.match(/^dependencies\s*=\s*(.*)$/);
      if (!match) continue;
      const rest = match[1];
      if (!rest.startsWith("[")) continue;
      inDependencies = true;
      depth = 0;
      for (const char of rest) {
        if (char === "[") depth += 1;
        else if (char === "]") depth -= 1;
      }
      collectArrayItems(rest, result);
      if (depth <= 0) inDependencies = false;
      continue;
    }

    for (const char of line) {
      if (char === "[") depth += 1;
      else if (char === "]") depth -= 1;
    }
    collectArrayItems(line, result);
    if (depth <= 0) inDependencies = false;
  }
  return result.filter(Boolean);
}

function collectArrayItems(line: string, out: string[]): void {
  // TOML dependency elements are quoted strings; commas/brackets inside are PEP 508 syntax.
  const strings = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(#.*$)/g;
  for (const match of line.matchAll(strings)) {
    if (match[3]) break;
    const value = match[1] !== undefined ? JSON.parse('"' + match[1] + '"') as string : match[2];
    if (value?.trim()) out.push(value.trim());
  }
}

/** 提取 `[project]` 段的 requires-python。 */
export function parseRequiresPython(text: string): string | null {
  const lines = text.split(/\r?\n/);
  let inProject = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^\[/.test(line)) {
      inProject = line === "[project]";
      continue;
    }
    if (!inProject) continue;
    const match = line.match(/^requires-python\s*=\s*["'](.+?)["']/);
    if (match) return match[1].trim();
  }
  return null;
}

/** 提取 `[project]` 段的 version；用于内置能力环境的 profile（能力升级 → 新环境）。 */
export function parseProjectVersion(text: string): string | null {
  const lines = text.split(/\r?\n/);
  let inProject = false;
  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (/^\[/.test(line)) {
      inProject = line === "[project]";
      continue;
    }
    if (!inProject) continue;
    const match = line.match(/^version\s*=\s*["'](.+?)["']/);
    if (match) return match[1].trim();
  }
  return null;
}

/** requirements.txt → 依赖列表；跳过选项行（-r/-e/--index-url 等）与空行。 */
export function parseRequirementsText(text: string): string[] {
  const result: string[] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = stripRequirementLine(rawLine);
    if (!line) continue;
    if (line.startsWith("-")) continue;
    result.push(line);
  }
  return result;
}

/**
 * requires-python（如 ">=3.10,<3.13"）→ uv 可接受的版本选择子。
 * 保留完整约束，交给 uv 选择兼容的解释器。
 */
export function pythonRequestFromRequires(requiresPython: string | null): string | null {
  if (!requiresPython) return null;
  return /\d+\.\d+/.test(requiresPython) ? requiresPython.trim() : null;
}

/**
 * 读取项目清单并推导规格。找不到任何清单时返回空规格 + source:"none"，
 * 调用方据此决定是走基础环境还是明确报"无法确定依赖"。
 */
export function readPythonProjectSpec(projectDir: string): PythonProjectSpecResult {
  const pyprojectPath = join(projectDir, "pyproject.toml");
  const requirementsPath = join(projectDir, "requirements.txt");
  const pythonVersionPath = join(projectDir, ".python-version");

  const pinnedVersion = existsSync(pythonVersionPath)
    ? readFileSync(pythonVersionPath, "utf8").trim() || null
    : null;

  if (existsSync(pyprojectPath)) {
    const text = readFileSync(pyprojectPath, "utf8");
    const dependencies = parsePyprojectDependencies(text);
    const requiresPython = parseRequiresPython(text);
    const python = pinnedVersion ?? pythonRequestFromRequires(requiresPython) ?? undefined;
    const spec: PythonEnvironmentSpec = { dependencies };
    if (python) spec.python = python;
    return {
      spec,
      source: "pyproject",
      projectDir,
      requiresPython,
      detail: `已按 ${pyprojectPath} 解析 ${dependencies.length} 项依赖`,
    };
  }

  if (existsSync(requirementsPath)) {
    const dependencies = parseRequirementsText(readFileSync(requirementsPath, "utf8"));
    const spec: PythonEnvironmentSpec = { dependencies };
    if (pinnedVersion) spec.python = pinnedVersion;
    return {
      spec,
      source: "requirements",
      projectDir,
      requiresPython: null,
      detail: `已按 ${requirementsPath} 解析 ${dependencies.length} 项依赖`,
    };
  }

  const spec: PythonEnvironmentSpec = {};
  if (pinnedVersion) spec.python = pinnedVersion;
  return {
    spec,
    source: pinnedVersion ? "python-version" : "none",
    projectDir,
    requiresPython: null,
    detail: pinnedVersion
      ? `未找到依赖清单，仅按 .python-version 固定为 ${pinnedVersion}`
      : "未找到 pyproject.toml / requirements.txt / .python-version",
  };
}
