import { existsSync } from "node:fs";
import { delimiter, join } from "node:path";
import { currentPlatformId, type PlatformId } from "../index";
import { executableInPath } from "../computer-use";

/**
 * OCR provider 的平台相关部分。
 *
 * 这里只做「候选路径 / provider 选择 / Linux 描述」，不执行 OCR：Windows 的
 * OCR 执行（OCR_NPU CLI 与 windows-ocr.ps1 的调用参数）仍留在
 * ComputerAutomationService.ocrWindow()，语义不变。
 *
 * 注意：候选路径不使用任何个人绝对路径（历史 `C:\Users\<someone>\...` 硬编码已删除），
 * 只来自环境变量、打包资源目录、系统标准安装位置与仓库内相对路径。
 */

/** 历史硬编码已删除；OCR_NPU CLI 的标准安装位置（Windows）与仓库相对位置。 */
export function ocrInstallCandidates(): string[] {
  const candidates: string[] = [];
  const localAppData = process.env.LOCALAPPDATA?.trim();
  if (localAppData) candidates.push(join(localAppData, "Programs", "OCR_NPU", "OCR_NPU_CLI.exe"));
  const programFiles = process.env.ProgramFiles?.trim();
  if (programFiles) candidates.push(join(programFiles, "OCR_NPU", "OCR_NPU_CLI.exe"));
  candidates.push(join(process.cwd(), "tools", "OCR_NPU", "OCR_NPU_CLI.exe"));
  return candidates;
}

/** 解析 OCR_NPU CLI：MYBUDDY_OCR_CLI 优先，其次标准安装位置，最后 PATH。 */
export function resolveOcrCli(): string | undefined {
  const configured = process.env.MYBUDDY_OCR_CLI?.trim();
  if (configured && existsSync(configured)) return configured;
  for (const candidate of ocrInstallCandidates()) if (existsSync(candidate)) return candidate;
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory.trim()) continue;
    for (const extension of [".exe", ".cmd", ""]) {
      const candidate = join(directory.trim(), `OCR_NPU_CLI${extension}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return undefined;
}

export type OcrProvider = { kind: "npu"; path: string } | { kind: "windows"; script: string };

/** 打包后 resources/windows-ocr.ps1；dev 下回落到仓库 scripts/ 或 cwd。 */
export function windowsOcrScriptPath(): string | undefined {
  const candidates: string[] = [];
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { app } = require("electron") as typeof import("electron");
    if (app?.isPackaged) candidates.push(join(process.resourcesPath, "windows-ocr.ps1"));
  } catch { /* node-only tests */ }
  candidates.push(join(__dirname, "..", "..", "scripts", "windows-ocr.ps1"));
  candidates.push(join(process.cwd(), "scripts", "windows-ocr.ps1"));
  return candidates.find((candidate) => existsSync(candidate));
}

/** Windows OCR provider 选择（与搬迁前完全一致：npu 优先，可强制 windows 脚本）。 */
export function resolveOcrProvider(): OcrProvider | undefined {
  const preference = (process.env.MYBUDDY_OCR_PROVIDER ?? "auto").trim().toLowerCase();
  if (preference !== "windows") {
    const cli = resolveOcrCli();
    if (cli) return { kind: "npu", path: cli };
  }
  const script = windowsOcrScriptPath();
  if (script) return { kind: "windows", script };
  return undefined;
}

/** OCR 不可用时的可诊断搜索清单（不含个人绝对路径）。 */
export function ocrSearchCandidates(): Array<string | undefined> {
  return [process.env.MYBUDDY_OCR_CLI, ...ocrInstallCandidates(), "windows-ocr.ps1"];
}

/* ------------------------------------------------------------------ */
/* Linux OCR provider 描述（供后续接线，不在此执行）                    */
/* ------------------------------------------------------------------ */

export const DEFAULT_LINUX_OCR_LANGUAGES = ["eng", "chi_sim"] as const;

export interface LinuxOcrProviderDescriptor {
  kind: "tesseract";
  command: string;
  /** tesseract 是否已在 PATH 中。 */
  available: boolean;
  defaultLanguages: string[];
  installHint: string;
  /** 后续接线直接用的 argv：`tesseract <image> stdout -l eng+chi_sim --psm 6`。 */
  buildArgs(imagePath: string, languages?: readonly string[]): string[];
}

export function describeLinuxOcrProvider(
  pathValue: string = process.env.PATH ?? "",
  platform: PlatformId = currentPlatformId,
): LinuxOcrProviderDescriptor | undefined {
  if (platform !== "linux") return undefined;
  return {
    kind: "tesseract",
    command: "tesseract",
    available: executableInPath("tesseract", pathValue) !== undefined,
    defaultLanguages: [...DEFAULT_LINUX_OCR_LANGUAGES],
    installHint: "sudo pacman -S --needed tesseract tesseract-data-eng tesseract-data-chi_sim",
    buildArgs(imagePath: string, languages?: readonly string[]): string[] {
      return [imagePath, "stdout", "-l", (languages ?? DEFAULT_LINUX_OCR_LANGUAGES).join("+"), "--psm", "6"];
    },
  };
}
