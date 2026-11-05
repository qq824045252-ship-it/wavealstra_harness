import { execFile } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, delimiter, join } from "node:path";
import { promisify } from "node:util";
import type { ToolExecutionContext } from "./BuiltinCapabilityRuntime";
import type { ImageRecognitionAdapter, OcrResult } from "./HttpOcrProvider";

/**
 * 本机 OCR（OCR_NPU CLI）适配器。
 *
 * 与 computer-use 的 `ocrWindow()` 走同一条已验证路径：
 *   OCR_NPU_CLI.exe --input_path <图片> --json --output_dir <目录>
 * stdout 最后一行是 `{ pages: [{ texts: [{ text, score, box: [[x,y], ...] }] }] }`，
 * 或者结果落在 `<output_dir>/<图片名>_ocr.json`。
 *
 * 这里只负责「找到 CLI / 启动一次识别 / 解析结果」，并保持纯解析函数可单测：
 * 不联网、不注册为 media provider、不碰 computer-use 的 provider 选择逻辑。
 */

const CLI_NAME = "OCR_NPU_CLI";
const CLI_FILE_NAMES = [`${CLI_NAME}.exe`, `${CLI_NAME}.cmd`, CLI_NAME] as const;
const CLI_SEARCH_EXECUTABLES = [`${CLI_NAME}.exe`, `${CLI_NAME}.cmd`, `${CLI_NAME}`] as const;

export const LOCAL_OCR_TIMEOUT_MS = 120_000;
const LOCAL_OCR_HELP_TIMEOUT_MS = 10_000;
const MAX_BUFFER = 16 * 1024 * 1024;
const LOCAL_OCR_RESOLVE_CACHE_MS = 5_000;
let localOcrResolveCache: { at: number; cli: string | undefined } | undefined;

/**
 * 能力项目在本机开发机上的默认位置。
 *
 * 与 `DEFAULT_WHISPER_ROOT`（`~/Documents/GitHub/whisper-voice-ime`）同一类约定：
 * 这是能力项目仓库的默认检出路径，不是某个人的硬编码绝对路径；打包安装版本仍走
 * `%LOCALAPPDATA%\Programs\OCR_NPU` 等标准位置。
 */
export function defaultLocalOcrCli(home: string = homedir()): string {
  return join(home, "Documents", "GitHub", "OCR_NPU", "dist", "OCR_NPU_CLI", `${CLI_NAME}.exe`);
}

export const LOCAL_OCR_SETUP_HINT = "设置 MYBUDDY_OCR_CLI 指向 OCR_NPU_CLI.exe（或 MYBUDDY_OCR_DIR 指向 CLI 所在目录），或把 CLI 安装到 %LOCALAPPDATA%\\Programs\\OCR_NPU。";

export interface LocalOcrResolveOptions {
  /** 默认 process.env；测试可注入。 */
  env?: Record<string, string | undefined>;
  /** 默认 existsSync；测试可注入。 */
  fileExists?: (candidate: string) => boolean;
  /** 默认 homedir()；决定开发机默认位置。 */
  homeDir?: string;
}

/**
 * 候选路径，按优先级：MYBUDDY_OCR_CLI → MYBUDDY_OCR_DIR → 系统标准安装位置 →
 * 能力项目默认位置 → PATH。返回的是「将要尝试的路径」，不代表都存在。
 */
export function localOcrSearchCandidates(options: LocalOcrResolveOptions = {}): string[] {
  const env = options.env ?? process.env;
  const home = options.homeDir ?? homedir();
  const candidates: string[] = [];
  const configured = env.MYBUDDY_OCR_CLI?.trim();
  if (configured) candidates.push(configured);
  const configuredDir = env.MYBUDDY_OCR_DIR?.trim();
  if (configuredDir) for (const name of CLI_FILE_NAMES) candidates.push(join(configuredDir, name));
  const localAppData = env.LOCALAPPDATA?.trim();
  if (localAppData) candidates.push(join(localAppData, "Programs", "OCR_NPU", `${CLI_NAME}.exe`));
  const programFiles = env.ProgramFiles?.trim();
  if (programFiles) candidates.push(join(programFiles, "OCR_NPU", `${CLI_NAME}.exe`));
  candidates.push(join(process.cwd(), "tools", "OCR_NPU", `${CLI_NAME}.exe`));
  candidates.push(defaultLocalOcrCli(home));
  for (const directory of (env.PATH ?? "").split(delimiter)) {
    if (!directory.trim()) continue;
    for (const name of CLI_SEARCH_EXECUTABLES) candidates.push(join(directory.trim(), name));
  }
  return [...new Set(candidates)];
}

/**
 * 解析本机 OCR CLI；没有可用 CLI 时返回 undefined。
 *
 * 默认调用（无注入选项）带 5 秒缓存：settings 快照会对每个媒体能力各调一次 services()，
 * 而候选路径含 PATH 扫描，不缓存会在每次快照里重复 stat 上百个路径。
 */
export function resolveLocalOcrCli(options: LocalOcrResolveOptions = {}): string | undefined {
  const cacheable = !options.env && !options.fileExists && !options.homeDir;
  if (cacheable && localOcrResolveCache && Date.now() - localOcrResolveCache.at < LOCAL_OCR_RESOLVE_CACHE_MS) return localOcrResolveCache.cli;
  const exists = options.fileExists ?? existsSync;
  let found: string | undefined;
  for (const candidate of localOcrSearchCandidates(options)) {
    if (exists(candidate)) { found = candidate; break; }
  }
  if (cacheable) localOcrResolveCache = { at: Date.now(), cli: found };
  return found;
}

export function isLocalOcrAvailable(options: LocalOcrResolveOptions = {}): boolean {
  return resolveLocalOcrCli(options) !== undefined;
}

/** 纯解析层的一行：像素框来自 CLI 的输入图像坐标；缺失时保持空数组，绝不伪造。 */
export interface LocalOcrLine {
  text: string;
  score?: number;
  box: Array<[number, number]>;
}

function flattenLocalOcrDocument(payload: unknown): LocalOcrLine[] | undefined {
  const pages = (payload as { pages?: unknown } | null)?.pages;
  if (!Array.isArray(pages)) return undefined;
  const lines: LocalOcrLine[] = [];
  for (const page of pages) {
    const texts = (page as { texts?: unknown } | null)?.texts;
    if (!Array.isArray(texts)) continue;
    for (const entry of texts) {
      const item = entry as { text?: unknown; score?: unknown; box?: unknown } | null;
      if (typeof item?.text !== "string" || !item.text.trim()) continue;
      const box: Array<[number, number]> = [];
      if (Array.isArray(item.box)) {
        for (const point of item.box as unknown[]) {
          if (!Array.isArray(point) || point.length < 2) continue;
          const [x, y] = [Number(point[0]), Number(point[1])];
          if (Number.isFinite(x) && Number.isFinite(y)) box.push([x, y]);
        }
      }
      const score = Number(item.score);
      lines.push({ text: item.text, ...(Number.isFinite(score) ? { score } : {}), box });
    }
  }
  return lines;
}

/** 把 CLI 行转成能力契约；只有真的拿到有效像素框才带 boxes。 */
function localOcrResult(lines: LocalOcrLine[]): OcrResult {
  const boxes: NonNullable<OcrResult["boxes"]> = [];
  for (const line of lines) {
    if (!line.box.length) continue;
    const xs = line.box.map((point) => point[0]);
    const ys = line.box.map((point) => point[1]);
    const x = Math.min(...xs);
    const y = Math.min(...ys);
    const width = Math.max(...xs) - x;
    const height = Math.max(...ys) - y;
    if (!(width > 0 && height > 0)) continue;
    boxes.push({ text: line.text, x, y, width, height, ...(line.score === undefined ? {} : { confidence: line.score }) });
  }
  return { text: lines.map((line) => line.text).join("\n"), ...(boxes.length ? { boxes } : {}) };
}

/**
 * 纯解析函数（便于无 NPU 单测）：stdout → { text, boxes? }。
 *
 * 从 stdout 末尾向前找可解析的 JSON 行（CLI 可能先打印进度日志）；
 * 找不到时回落到 `<output_dir>/<图片名>_ocr.json`。两处都没有 pages[].texts[] 结构才报错。
 */
export function parseLocalOcrJson(stdout: string, outputDir?: string, imagePath?: string): OcrResult {
  const lines = stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (!line.startsWith("{")) continue;
    try {
      const document = flattenLocalOcrDocument(JSON.parse(line));
      if (document) return localOcrResult(document);
    } catch { /* keep scanning */ }
  }
  if (outputDir && imagePath) {
    const stem = basename(imagePath).replace(/\.[^.]+$/, "");
    const file = join(outputDir, `${stem}_ocr.json`);
    if (existsSync(file)) {
      try {
        const document = flattenLocalOcrDocument(JSON.parse(readFileSync(file, "utf8")));
        if (document) return localOcrResult(document);
      } catch { /* fall through to the diagnostic error */ }
    }
  }
  throw new Error("本机 OCR 输出无法解析：stdout 与输出目录中都没有 pages[].texts[] 结构。");
}

export interface LocalOcrRunOptions { timeoutMs: number; signal?: AbortSignal }
export type LocalOcrRunner = (cli: string, args: string[], options: LocalOcrRunOptions) => Promise<{ stdout: string }>;

const execFileAsync = promisify(execFile);

/** 默认执行器：不经过 shell（真实 CLI 是 .exe），支持超时与 AbortSignal。 */
async function runLocalOcrCli(cli: string, args: string[], options: LocalOcrRunOptions): Promise<{ stdout: string }> {
  const { stdout } = await execFileAsync(cli, args, {
    timeout: options.timeoutMs,
    windowsHide: true,
    maxBuffer: MAX_BUFFER,
    ...(options.signal ? { signal: options.signal } : {}),
  });
  return { stdout: String(stdout) };
}

function isAbortError(error: unknown): boolean {
  const name = (error as { name?: unknown } | null)?.name;
  return name === "AbortError" || name === "CanceledError";
}

export interface LocalOcrProviderOptions {
  /** 默认 resolveLocalOcrCli；测试注入假的 CLI 路径。 */
  resolveCli?: () => string | undefined;
  /** 默认 execFile；测试注入假 CLI 输出。 */
  run?: LocalOcrRunner;
  timeoutMs?: number;
}

/** 统一的「未安装」诊断信息：设置提示 + 少量候选路径（PATH 可能很长，截断展示）。 */
export function localOcrUnavailableMessage(): string {
  const candidates = localOcrSearchCandidates();
  const sample = candidates.slice(0, 8).join("；");
  return `未找到本机 OCR_NPU_CLI。${LOCAL_OCR_SETUP_HINT}已查找 ${candidates.length} 个候选位置，例如：${sample}`;
}

function missingCliError(): Error {
  return new Error(localOcrUnavailableMessage());
}

/** 图片文字识别的本机适配器；每行文本按需带输入像素框，从不伪造位置。 */
export function createLocalOcrAdapter(options: LocalOcrProviderOptions = {}): ImageRecognitionAdapter {
  return {
    async recognize(imagePath: string, context: ToolExecutionContext): Promise<OcrResult> {
      const cli = (options.resolveCli ?? resolveLocalOcrCli)();
      if (!cli) throw missingCliError();
      if (!existsSync(imagePath)) throw new Error(`图片不存在：${imagePath}`);
      const run = options.run ?? runLocalOcrCli;
      const workDir = mkdtempSync(join(tmpdir(), "mybuddy-ocr-"));
      try {
        const outputDir = join(workDir, "out");
        mkdirSync(outputDir, { recursive: true });
        let stdout: string;
        try {
          ({ stdout } = await run(cli, ["--input_path", imagePath, "--json", "--output_dir", outputDir], {
            timeoutMs: options.timeoutMs ?? LOCAL_OCR_TIMEOUT_MS,
            signal: context.signal,
          }));
        } catch (error) {
          if (context.signal?.aborted || isAbortError(error)) throw new Error("图片文字识别已取消");
          const detail = error instanceof Error ? error.message : String(error);
          throw new Error(`本机 OCR 执行失败（${cli}）：${detail}`);
        }
        return parseLocalOcrJson(stdout, outputDir, imagePath);
      } finally {
        try { rmSync(workDir, { recursive: true, force: true }); } catch { /* best effort */ }
      }
    },
  };
}

/**
 * 「检查」按钮用的配置检查：只确认 CLI 存在并可启动（可选 --help 探测），
 * 不发送样本、不做推理，返回可诊断的 detail。
 */
export async function probeLocalOcr(options: LocalOcrProviderOptions = {}): Promise<string> {
  const cli = (options.resolveCli ?? resolveLocalOcrCli)();
  if (!cli) throw missingCliError();
  const run = options.run ?? runLocalOcrCli;
  let probe: string;
  try {
    const result = await run(cli, ["--help"], { timeoutMs: LOCAL_OCR_HELP_TIMEOUT_MS });
    probe = result.stdout.trim() ? "--help 探测通过" : "--help 已执行（无输出）";
  } catch (error) {
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === "number") probe = `--help 返回 exit ${code}（可执行文件已启动）`;
    else if (code === "ETIMEDOUT" || (error as { killed?: unknown } | null)?.killed === true) probe = "--help 探测超时（可执行文件已启动；未做推理）";
    else {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`找到本机 OCR_NPU_CLI 但无法启动（${cli}）：${detail}`);
    }
  }
  return `配置检查通过；未发送样本、未执行推理。本机 CLI：${cli}（${probe}）。`;
}
