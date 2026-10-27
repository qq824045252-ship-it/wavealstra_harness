import { existsSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { PythonProjectBinding } from "../../shared/python-runtime";
import { currentNodePlatform, pythonVenvInterpreterParts } from "../platform/runtime";
import { readPythonProjectSpec } from "./PythonProjectManifest";
import { pythonProjectDirKey } from "./python-environment-spec";

/**
 * 项目 Python 的零配置发现。
 *
 * 这里只识别项目目录内的虚拟环境，避免把 PATH / 系统 Python 猜成“项目环境”。
 * uv、Poetry、PDM 在使用 in-project venv 时都会落到 .venv；同时兼容传统 venv/env。
 * 找不到就返回 null，由上层继续使用 MyBuddy 受管 Python。
 */
export function discoverProjectPython(
  startDir: string,
  platform: NodeJS.Platform = currentNodePlatform,
): PythonProjectBinding | null {
  const raw = (startDir ?? "").trim();
  if (!raw) return null;

  let current = resolve(raw);
  // 解释器相对路径片段由平台边界给出（Windows: Scripts/python.exe；POSIX: bin/python）
  const interpreterParts = [".venv", "venv", "env"].map((dir) => [dir, ...pythonVenvInterpreterParts(platform)]);

  for (;;) {
    if (existsSync(current) && statSync(current).isDirectory()) {
      for (const parts of interpreterParts) {
        const pythonPath = join(current, ...parts);
        if (!existsSync(pythonPath)) continue;
        const manifest = readPythonProjectSpec(current);
        const manifestName =
          manifest.source === "pyproject"
            ? "pyproject.toml"
            : manifest.source === "requirements"
              ? "requirements.txt"
              : manifest.source === "python-version"
                ? ".python-version"
                : null;
        return {
          projectDir: current,
          dirKey: pythonProjectDirKey(current, platform),
          pythonPath,
          pythonVersion: null,
          manifestPath: manifestName ? join(current, manifestName) : null,
          boundAt: 0,
        };
      }
    }

    const parent = dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}
