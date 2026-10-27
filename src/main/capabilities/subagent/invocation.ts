/**
 * invocation.ts — pi CLI/运行时启动命令解析（A，可测试）。
 *
 * Windows/Electron（MyBuddy）：绝不复用宿主二进制；node.exe + pi CLI JS 入口，
 * shell:false（无 shell 注入面）。解析失败返回 null（结构化诊断，不静默 ENOENT）。
 */
import { nodeExecutableName, pathListSeparator, programFilesDefault } from "../../platform/runtime";

import * as path from "node:path";

/** 尽力包解析（ESM 环境无 require 时返回 null；CJS 从宿主依赖解析；不抛出）。 */
export function tryRequireResolve(spec: string): string | null {
  try {
    const g = globalThis as { require?: NodeRequire };
    const req = typeof require === "function" ? require : g.require;
    if (typeof req !== "function") return null;
    return req.resolve(spec);
  } catch {
    return null;
  }
}

function cliFromPkgRoot(pkgRoot: string): string {
  return path.join(pkgRoot, "dist", "cli.js");
}

function hostModuleCliCandidates(env: NodeJS.ProcessEnv): string[] {
  const roots: string[] = [];
  try {
    roots.push(process.cwd());
  } catch {
    /* ignore */
  }
  try {
    if (typeof process.execPath === "string" && process.execPath) {
      roots.push(path.dirname(process.execPath));
    }
  } catch {
    /* ignore */
  }
  const out: string[] = [];
  for (const root of roots) {
    out.push(cliFromPkgRoot(path.join(root, "node_modules", "@earendil-works", "pi-coding-agent")));
    out.push(cliFromPkgRoot(path.join(root, "..", "node_modules", "@earendil-works", "pi-coding-agent")));
    out.push(cliFromPkgRoot(path.join(root, "..", "..", "node_modules", "@earendil-works", "pi-coding-agent")));
  }
  const home = env.USERPROFILE ?? env.HOME ?? "";
  if (env.APPDATA) {
    out.push(
      cliFromPkgRoot(path.join(env.APPDATA, "npm", "node_modules", "@earendil-works", "pi-coding-agent")),
    );
  }
  if (home) {
    out.push(
      cliFromPkgRoot(path.join(home, ".pi", "agent", "npm", "node_modules", "@earendil-works", "pi-coding-agent")),
    );
  }
  return out;
}

/**
 * 定位 pi CLI 的 JS 入口（dist/cli.js）。
 * 优先级：env.PI_CLI_PATH → 包解析 → 宿主 node_modules 实路径 → npm 全局安装路径。
 *
 * 注意：pi-coding-agent 的 package exports 不含 dist/cli.js，require.resolve 子路径会失败，
 * 必须走 package 根目录拼 dist/cli.js。
 */
export function resolvePiCliJs(
  env: NodeJS.ProcessEnv,
  resolvePkg: (spec: string) => string | null,
  exists: (p: string) => boolean,
): string | null {
  if (env.PI_CLI_PATH && exists(env.PI_CLI_PATH)) return env.PI_CLI_PATH;
  try {
    const direct = resolvePkg("@earendil-works/pi-coding-agent/dist/cli.js");
    if (direct && exists(direct)) return direct;
  } catch {
    /* continue */
  }
  try {
    const main = resolvePkg("@earendil-works/pi-coding-agent");
    if (main) {
      const sibling = path.join(path.dirname(main), "cli.js");
      if (exists(sibling)) return sibling;
      const fromRoot = cliFromPkgRoot(path.dirname(path.dirname(main)));
      if (exists(fromRoot)) return fromRoot;
    }
  } catch {
    /* continue */
  }
  for (const candidate of hostModuleCliCandidates(env)) {
    if (candidate && exists(candidate)) return candidate;
  }
  return null;
}

/** 解析真实 node 可执行文件（Electron 宿主不能当子进程解释器，除非 ELECTRON_RUN_AS_NODE）。 */
export function resolveSystemNode(
  env: NodeJS.ProcessEnv,
  exists: (p: string) => boolean,
): string | null {
  if (env.PI_NODE_PATH && exists(env.PI_NODE_PATH)) return env.PI_NODE_PATH;
  const exe = nodeExecutableName();
  const pathEnv = env.PATH ?? env.Path ?? "";
  for (const dir of pathEnv.split(pathListSeparator())) {
    if (!dir) continue;
    const candidate = path.join(dir, exe);
    if (exists(candidate)) return candidate;
  }
  const programFiles = env.ProgramFiles ?? programFilesDefault();
  if (programFiles) {
    const candidate = path.join(programFiles, "nodejs", exe);
    if (exists(candidate)) return candidate;
  }
  return null;
}

/**
 * 解析子代理进程的启动命令。
 * - Electron/Windows：node.exe + pi CLI JS（PI_NODE_PATH 可覆盖 node；PI_CLI_PATH 可覆盖 CLI）
 * - 其它 Node 运行时：execPath + 明确解析的 Pi CLI；绝不把宿主脚本当成 Pi。
 * 返回 null = 无法定位（调用方给出可诊断错误）。
 */
export function resolvePiInvocation(
  env: NodeJS.ProcessEnv,
  execPath: string,
  isElectron: boolean,
  resolvePkg: (spec: string) => string | null = tryRequireResolve,
  exists: (p: string) => boolean = (p) => {
    try {
      return require("node:fs").existsSync(p);
    } catch {
      return false;
    }
  },
): { command: string; args: string[] } | null {
  if (isElectron) {
    const cliJs = resolvePiCliJs(env, resolvePkg, exists);
    if (!cliJs) return null;
    const nodePath = resolveSystemNode(env, exists);
    if (nodePath) return { command: nodePath, args: [cliJs] };
    return { command: env.PI_NODE_PATH || "node", args: [cliJs] };
  }
  // The host may be a test runner or embedding application, not Pi's CLI.
  // Never launch process.argv[1] as a Pi worker.
  const cliJs = resolvePiCliJs(env, resolvePkg, exists);
  if (!cliJs) return null;
  return { command: execPath, args: [cliJs] };
}
