/**
 * FreeCadInterop — FreeCAD 双向互操作（P1 #1）。
 *
 * 原则：优先复用现有 ProfessionalToolRuntime + FreeCADCmd 受管脚本（不依赖脆弱
 * MCP addon 作为唯一链路；MCP 保留为高级 GUI 能力）。禁止杀用户手工打开的 FreeCAD
 * （我们只 spawn 独立的 FreeCADCmd 控制台进程，从不触碰 GUI 会话）。
 *
 * 能力：
 * - openInFreeCAD：确保 FreeCAD portable 运行（prepareForProvider）→ shell.openPath
 * - resolveFreeCadCmd：定位 portable FreeCADCmd（MyBuddyTools/FreeCAD-* 目录/bin/）
 * - runScript：受管 FreeCAD Python 脚本执行（fc_args 契约；超时/abort 由调用方控制）
 * - fcstd/step 导出：FreeCADCmd 原生（Import.export 等）；FCStd 由 FreeCAD 自身产生
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { shell } from "electron";
import { FCSTD_READBACK_FREECAD_SCRIPT, TECHVIEW_FREECAD_SCRIPT } from "./freecad-scripts";
import { discoverPortableExecutable } from "../professional-tools/ProfessionalToolRuntime";

export interface FreeCadInteropOptions {
  toolsRoot: string;
  /** 已废弃：FreeCAD 不再走受管专业工具 Runtime */
  runtime?: unknown;
  /** 打开外部文件（默认 electron shell.openPath；测试可注入） */
  openPath?: (path: string) => Promise<string>;
  /** FreeCADCmd 覆盖路径（测试/显式指定） */
  freeCadCmd?: string | null;
}

export interface FreeCadInteropResult {
  ok: boolean;
  detail: string;
}

export interface FreeCadRunOptions {
  /** 脚本 Python 源码（运行于 FreeCAD 自身 Python 3.11 环境） */
  script: string;
  /** 脚本参数：经 JSON 文件传递，脚本内用 fc_args() 读取 */
  args?: string[];
  /** 超时 */
  timeoutMs?: number;
  /** abort 信号 */
  signal?: AbortSignal;
}

export interface FreeCadRunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
  /** 脚本绝对路径（任务内受管目录） */
  scriptPath: string;
}

export class FreeCadInterop {
  private readonly toolsRoot: string;
  private readonly openPath: (path: string) => Promise<string>;
  private readonly explicitFreeCadCmd: string | null;

  constructor(options: FreeCadInteropOptions) {
    this.toolsRoot = options.toolsRoot;
    this.openPath = options.openPath ?? ((p) => shell.openPath(p));
    this.explicitFreeCadCmd = options.freeCadCmd ?? null;
  }

  /** 定位 portable FreeCADCmd.exe（MyBuddyTools/FreeCAD-* 目录/bin/freecadcmd.exe） */
  resolveFreeCadCmd(): string | null {
    if (this.explicitFreeCadCmd && existsSync(this.explicitFreeCadCmd)) return this.explicitFreeCadCmd;
    return discoverPortableExecutable(
      this.toolsRoot,
      "freecadcmd.exe",
      /^FreeCAD(?:[-_].*)?$/i,
      {
        exists: existsSync,
        listDirectories: (dir) => {
          try {
            return readdirSync(dir, { withFileTypes: true })
              .filter((e) => e.isDirectory())
              .map((e) => e.name);
          } catch {
            return [];
          }
        },
      },
    );
  }

  get available(): boolean {
    return this.resolveFreeCadCmd() !== null;
  }

  /** 在 FreeCAD 中打开文件（STEP 或 FCStd）。 */
  async openInFreeCAD(filePath: string): Promise<FreeCadInteropResult> {
    if (!filePath || !existsSync(filePath)) {
      return { ok: false, detail: `文件不存在: ${filePath}` };
    }
    const result = await this.openPath(filePath);
    if (result) {
      return { ok: false, detail: `打开失败: ${result}` };
    }
    return { ok: true, detail: `已在 FreeCAD 中打开: ${filePath}` };
  }

  /**
   * 受管 FreeCAD 脚本执行（P1 #1 双向自动化核心）：
   * 写脚本到 scriptsDir → FreeCADCmd 执行 → 返回 stdout/stderr/exitCode。
   * 脚本契约：参数经 <script>.args.json 传递，脚本内 `fc_args()` 读取。
   * 不触碰用户 GUI FreeCAD（独立 FreeCADCmd 控制台进程）。
   */
  runScript(
    scriptsDir: string,
    scriptName: string,
    options: FreeCadRunOptions,
  ): Promise<FreeCadRunResult> {
    const freeCadCmd = this.resolveFreeCadCmd();
    if (!freeCadCmd) {
      return Promise.reject(new Error("未发现 FreeCADCmd；请安装 portable FreeCAD（MyBuddyTools/FreeCAD-*）"));
    }
    const args = options.args ?? [];
    const argsFile = join(scriptsDir, `${scriptName}.args.json`);
    const scriptPath = join(scriptsDir, `${scriptName}.py`);
    mkdirSync(scriptsDir, { recursive: true });
    writeFileSync(argsFile, JSON.stringify(args), "utf-8");
    // wrapper：fc_args() 读取 args 文件（FreeCAD 会重置 sys.argv，实测 1.1.x）
    const wrapper =
      "import sys as _sys\n" +
      "import json as _json\n" +
      `_FC_ARGS_FILE = ${JSON.stringify(argsFile)}\n` +
      "def fc_args():\n" +
      "    _a = _json.loads(open(_FC_ARGS_FILE, encoding='utf-8').read())\n" +
      "    _sys.argv = [_sys.argv[0]] + _a\n" +
      "    return _a\n" +
      options.script;
    writeFileSync(scriptPath, wrapper, "utf-8");
    return new Promise<FreeCadRunResult>((resolvePromise, rejectPromise) => {
      const timeoutMs = options.timeoutMs ?? 180_000;
      const child = spawn(freeCadCmd, [scriptPath], {
        cwd: scriptsDir,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        killTree(child);
        rejectPromise(new Error(`FreeCAD 脚本超时（${timeoutMs}ms）: ${scriptName}.py`));
      }, timeoutMs);
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        killTree(child);
        rejectPromise(new Error("FreeCAD 脚本已取消（abort）"));
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout?.setEncoding("utf-8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.setEncoding("utf-8");
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      child.once("error", (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        rejectPromise(error);
      });
      child.once("exit", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        resolvePromise({
          exitCode: code ?? -1,
          stdout: stdout.slice(-8000),
          stderr: stderr.slice(-8000),
          scriptPath,
        });
      });
    });
  }

  /**
   * TechDraw 最小闭环（FreeCADCmd console）：真实 DrawPage + 三视图 + 尺寸 → techdraw.svg + techdraw.fcstd。
   * 脚本源 = freecad-scripts.ts（TECHVIEW_FREECAD_SCRIPT，主链切换后独立）。
   */
  async techdraw(
    inputPath: string,
    outDir: string,
    opts: { format?: string; includeDims?: boolean; timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<{ files: Record<string, string>; format: string; exitCode: number; engine: string }> {
    const freeCadCmd = this.resolveFreeCadCmd();
    if (!freeCadCmd) throw new Error("未发现 FreeCADCmd；请安装 portable FreeCAD（MyBuddyTools/FreeCAD-*）");
    if (!existsSync(inputPath)) throw new Error(`输入文件不存在: ${inputPath}`);
    mkdirSync(outDir, { recursive: true });
    const result = await this.runScript(outDir, "_techdraw", {
      script: TECHVIEW_FREECAD_SCRIPT,
      args: [inputPath, outDir, "210", "148", opts.includeDims === false ? "0" : "1"],
      timeoutMs: opts.timeoutMs ?? 180_000,
      signal: opts.signal,
    });
    if (result.exitCode !== 0 && !result.stdout.includes("done")) {
      throw new Error(`TechDraw 执行失败（exit=${result.exitCode}）：\n${result.stderr.slice(-2000)}`);
    }
    const files: Record<string, string> = {};
    const svgPath = join(outDir, "techdraw.svg");
    const fcstdPath = join(outDir, "techdraw.fcstd");
    if (existsSync(svgPath)) files.svg = svgPath;
    if (existsSync(fcstdPath)) files.fcstd = fcstdPath;
    if (Object.keys(files).length === 0) {
      throw new Error(`TechDraw 未产出文件：\nstdout=${result.stdout.slice(-1500)}\nstderr=${result.stderr.slice(-1500)}`);
    }
    return { files, format: opts.format ?? "svg", exitCode: result.exitCode, engine: "freecadcmd-techdraw" };
  }

  /**
   * FCStd 受管结构化读回（FreeCADCmd console）：对象/类型/参数/形状摘要 + STEP 导出。
   * 脚本源 = freecad-scripts.ts（FCSTD_READBACK_FREECAD_SCRIPT，主链切换后独立）。
   * 边界（诚实声明）：受管结构化读回，非完整参数化读回；参数化语义保留在源 FCStd。
   */
  async fcstdReadback(
    fcstdPath: string,
    outDir: string,
    opts: { timeoutMs?: number; signal?: AbortSignal } = {},
  ): Promise<{
    summary: Record<string, unknown>;
    files: Record<string, string>;
    exitCode: number;
    engine: string;
  }> {
    const freeCadCmd = this.resolveFreeCadCmd();
    if (!freeCadCmd) throw new Error("未发现 FreeCADCmd；请安装 portable FreeCAD（MyBuddyTools/FreeCAD-*）");
    if (!existsSync(fcstdPath)) throw new Error(`FCStd 文件不存在: ${fcstdPath}`);
    mkdirSync(outDir, { recursive: true });
    const result = await this.runScript(outDir, "_fcstd_readback", {
      script: FCSTD_READBACK_FREECAD_SCRIPT,
      args: [fcstdPath, outDir],
      timeoutMs: opts.timeoutMs ?? 180_000,
      signal: opts.signal,
    });
    if (result.exitCode !== 0 && !result.stdout.includes("done")) {
      throw new Error(`FCStd 读回执行失败（exit=${result.exitCode}）：\n${result.stderr.slice(-2000)}`);
    }
    const summaryPath = join(outDir, "readback.json");
    const stepPath = join(outDir, "readback.step");
    if (!existsSync(summaryPath)) {
      throw new Error(`FCStd 读回未产出摘要：\nstdout=${result.stdout.slice(-1500)}\nstderr=${result.stderr.slice(-1500)}`);
    }
    const summary = JSON.parse(readFileSync(summaryPath, "utf8")) as Record<string, unknown>;
    const files: Record<string, string> = { readback: summaryPath };
    if (existsSync(stepPath)) files.step = stepPath;
    return { summary, files, exitCode: result.exitCode, engine: "freecadcmd-readback" };
  }

  /** FreeCADCmd 绝对路径（FCStd 转换/脚本执行用） */
  freeCadCmdPath(): string | null {
    return this.resolveFreeCadCmd();
  }

  /** 生成 FCStd 的推荐路径（模型目录下） */
  fcstdOutputPath(modelDir: string): string {
    return join(modelDir, "model.fcstd");
  }
}

/** Windows 整树杀（同 TaskExecutionIsolation 策略） */
function killTree(child: { pid?: number; kill: () => void }): void {
  if (child.pid == null) return;
  if (process.platform === "win32") {
    try {
      spawn("taskkill", ["/PID", String(child.pid), "/T", "/F"], {
        windowsHide: true,
        stdio: "ignore",
      });
      return;
    } catch {
      /* fall through */
    }
  }
  try {
    child.kill();
  } catch {
    /* */
  }
}
