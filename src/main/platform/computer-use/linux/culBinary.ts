import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const CUL_PACKAGE_BIN = join("node_modules", "@agent-sh", "computer-use-linux", "npm", "bin");

/**
 * 定位 computer-use-linux（CUL）的原生二进制。
 *
 * 打包后 `app.asar` 里的二进制不可执行，必须落在 `app.asar.unpacked`；dev 下从
 * 仓库/`node_modules` 逐级向上找（pnpm 的软链落在 `node_modules/@agent-sh/...`，
 * 真实文件在 `.pnpm/<pkg@ver>/node_modules/...`，两条都要覆盖）。
 * 任何一步失败都返回 `undefined`（由调用方转成 `supported:false` + 安装提示），不抛异常。
 */
export function resolveCulBinary(options: {
  platform?: NodeJS.Platform;
  arch?: string;
  envBin?: string;
  resourcesPath?: string;
  startDir?: string;
} = {}): string | undefined {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  if (platform !== "linux") return undefined;
  const binaryName = `computer-use-linux-linux-${arch}`;
  // `MYBUDDY_CUL_BIN` 是唯一的显式覆盖口（测试/自定义安装位置）；给了就必须存在，
  // 不再回落到 node_modules —— 否则「覆盖成不存在的路径」测不出来。
  const explicit = (options.envBin ?? process.env.MYBUDDY_CUL_BIN)?.trim();
  if (explicit) return existsSync(explicit) ? explicit : undefined;
  for (const directory of culBinaryDirectories(options)) {
    const candidate = join(directory, binaryName);
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** 候选目录（按优先级）：打包资源 → 从自身位置向上找 → cwd 向上找。 */
export function culBinaryDirectories(options: {
  resourcesPath?: string;
  startDir?: string;
} = {}): string[] {
  const directories: string[] = [];
  const resourcesPath = options.resourcesPath ?? (process as NodeJS.Process & { resourcesPath?: string }).resourcesPath;
  if (resourcesPath) {
    directories.push(join(resourcesPath, "app.asar.unpacked", CUL_PACKAGE_BIN));
    directories.push(join(resourcesPath, "app", "node_modules", "@agent-sh", "computer-use-linux", "npm", "bin"));
  }
  for (const start of [options.startDir ?? packageDirectory(), process.cwd()]) {
    if (!start) continue;
    directories.push(...ancestorCulBinDirectories(start));
  }
  return [...new Set(directories)];
}

/**
 * 搜索起点目录。
 *
 * 主进程（CJS）有 `__dirname`；esbuild 打成 ESM 的测试包里没有 `__dirname`，
 * 直接引用会抛 ReferenceError，所以退回入口脚本所在目录（测试从仓库根跑）。
 */
function packageDirectory(): string | undefined {
  if (typeof __dirname === "string") return __dirname;
  const entry = process.argv[1];
  return entry ? dirname(entry) : undefined;
}

/** 从 start 逐级向上，收集 `<dir>/node_modules/@agent-sh/...` 与 pnpm 真实目录。 */
function ancestorCulBinDirectories(start: string): string[] {
  const found: string[] = [];
  let current = resolve(start);
  for (let depth = 0; depth < 8; depth += 1) {
    const direct = join(current, CUL_PACKAGE_BIN);
    if (existsSync(direct)) found.push(direct);
    found.push(...pnpmCulBinDirectories(join(current, "node_modules", ".pnpm")));
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return found;
}

/** pnpm 只在 `.pnpm/<pkg>@<ver>/node_modules/@agent-sh/computer-use-linux` 放真文件。 */
function pnpmCulBinDirectories(pnpmRoot: string): string[] {
  if (!existsSync(pnpmRoot)) return [];
  try {
    return readdirSync(pnpmRoot)
      .filter((entry) => entry.startsWith("@agent-sh+computer-use-linux@"))
      .map((entry) => join(pnpmRoot, entry, "node_modules", "@agent-sh", "computer-use-linux", "npm", "bin"))
      .filter((directory) => existsSync(directory));
  } catch {
    return [];
  }
}

/** CUL 的 cosmic helper / indicator 与主二进制同目录；spawn 时用环境变量指过去。 */
export function culHelperPaths(binaryPath: string): { cosmicHelper?: string; indicator?: string } {
  const directory = dirname(binaryPath);
  const cosmicHelper = join(directory, "computer-use-linux-cosmic");
  const indicator = join(directory, "computer-use-linux-indicator");
  return {
    cosmicHelper: existsSync(cosmicHelper) ? cosmicHelper : undefined,
    indicator: existsSync(indicator) ? indicator : undefined,
  };
}

export interface CulDoctorReport {
  raw: string;
  capabilities?: {
    accessibility?: string[];
    input?: string[];
    screenshot?: string[];
    window_control?: string[];
    preferred?: Record<string, string>;
  };
  accessibility?: { at_spi_bus?: string; toolkit_accessibility?: boolean | null };
  input?: { uinput?: string; wtype?: string; ydotool?: string; ydotoold?: string; xdotool?: string };
  platform?: Record<string, string>;
  session?: { xdg_session_type?: string; wayland_display?: string; xdg_current_desktop?: string; desktop_session?: string };
  [key: string]: unknown;
}

/**
 * 同步读取 `computer-use-linux doctor`（一次性 CLI，不常驻；约 1–3 秒）。
 *
 * 只在探测/诊断路径调用，不在每次动作前调用。任何失败都返回 `undefined`，
 * 由调用方给出「CUL 不可用」的可诊断原因。
 */
export function runCulDoctor(binaryPath: string, timeoutMs = 15_000): CulDoctorReport | undefined {
  let raw: string;
  try {
    raw = execFileSync(binaryPath, ["doctor"], {
      encoding: "utf8",
      timeout: timeoutMs,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 8 * 1024 * 1024,
    });
  } catch {
    return undefined;
  }
  try {
    const parsed = JSON.parse(raw) as CulDoctorReport;
    return { ...parsed, raw };
  } catch {
    return { raw };
  }
}
