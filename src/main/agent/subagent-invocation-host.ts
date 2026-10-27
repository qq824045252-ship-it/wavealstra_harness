/**
 * 在扩展加载前把 PI_CLI_PATH / PI_NODE_PATH 写进 process.env。
 * 子代理 worker 是独立 node 进程，jiti 扩展里 require.resolve 打不穿
 * pi-coding-agent 的 package exports，必须由宿主用实路径注入。
 */
import { existsSync } from "node:fs";
import { nodeExecutableName, pathListSeparator, programFilesDefault } from "../platform/runtime";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { app } from "electron";

function firstExisting(paths: string[]): string | null {
  for (const p of paths) {
    if (p && existsSync(p)) return p;
  }
  return null;
}

function collectRoots(): string[] {
  const roots: string[] = [];
  try {
    roots.push(process.cwd());
  } catch {
    /* ignore */
  }
  try {
    const appPath = app?.getAppPath?.();
    if (appPath) roots.push(appPath);
  } catch {
    /* ignore */
  }
  try {
    roots.push(join(dirname(fileURLToPath(import.meta.url)), "..", "..", ".."));
  } catch {
    /* ignore */
  }
  return [...new Set(roots)];
}

export function resolveHostPiCliPath(): string | null {
  if (process.env.PI_CLI_PATH && existsSync(process.env.PI_CLI_PATH)) return process.env.PI_CLI_PATH;
  const rel = join("node_modules", "@earendil-works", "pi-coding-agent", "dist", "cli.js");
  return firstExisting(collectRoots().map((root) => join(root, rel)));
}

export function resolveHostNodePath(): string | null {
  if (process.env.PI_NODE_PATH && existsSync(process.env.PI_NODE_PATH)) return process.env.PI_NODE_PATH;
  const exe = nodeExecutableName();
  const fromPath = (process.env.PATH ?? process.env.Path ?? "")
    .split(pathListSeparator())
    .map((dir) => join(dir, exe));
  const programFiles = process.env.ProgramFiles ?? programFilesDefault();
  const extras = programFiles ? [join(programFiles, "nodejs", exe)] : [];
  return firstExisting([...fromPath, ...extras]);
}

export function installSubagentInvocationEnv(): void {
  const cli = resolveHostPiCliPath();
  if (cli && !process.env.PI_CLI_PATH) process.env.PI_CLI_PATH = cli;
  const node = resolveHostNodePath();
  if (node && !process.env.PI_NODE_PATH) process.env.PI_NODE_PATH = node;
}
