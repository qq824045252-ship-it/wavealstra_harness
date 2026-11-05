import { venvPythonRelativePath } from "../platform/runtime";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getPythonRuntimeService } from "../runtime/pythonRuntimeInstance";
import { parseProjectVersion, readPythonProjectSpec } from "../runtime/PythonProjectManifest";

export const DEFAULT_WHISPER_ROOT = join(homedir(), "Documents", "GitHub", "whisper-voice-ime");

/** 内置能力标识：受管环境按 profile 隔离，与临时代码环境互不影响 */
export const WHISPER_CAPABILITY_ID = "local-whisper";

export interface WhisperRuntimePaths {
  root: string;
  python: string;
  modelDir: string;
  available: boolean;
  detail: string;
  /** 解释器来源：managed = MyBuddy 受管环境；project-venv = 能力项目自带的 .venv */
  pythonSource: "managed" | "project-venv" | "none";
  /** 受管环境标识（pythonSource 为 managed 时有值），用于诊断 */
  environmentId?: string;
  pythonVersion?: string;
}

/**
 * 能力自身的 Python 规格：按它自己的 pyproject.toml 解析依赖与版本范围，
 * 不由 MyBuddy 猜包列表。profile 带能力版本 → 能力升级得到新环境，
 * 旧环境保持不动直到被回收，不会打断正在使用该能力的任务。
 */
function whisperCapabilitySpec(root: string) {
  const project = readPythonProjectSpec(root);
  let version = "unknown";
  try {
    const pyproject = join(root, "pyproject.toml");
    if (existsSync(pyproject)) version = parseProjectVersion(readFileSync(pyproject, "utf8")) ?? "unknown";
  } catch {
    /* 版本读不出不阻断，用 unknown 作为 profile 的一部分 */
  }
  return {
    spec: getPythonRuntimeService().specForBuiltinCapability(WHISPER_CAPABILITY_ID, version, project.spec),
    manifestDetail: project.detail,
  };
}

function missingAssets(root: string): Array<[string, string]> {
  return [
    ["transcribe_wav.py", join(root, "transcribe_wav.py")],
    ["whisper-medium-int8", join(root, "models", "whisper-medium-int8")],
  ].filter(([, path]) => !existsSync(path)) as Array<[string, string]>;
}

/**
 * 同步探测（不触发下载）。用于状态展示与能力自检。
 * 解释器优先级：受管环境（已就绪）→ 能力项目自带 .venv → 不可用。
 */
export function resolveWhisperRuntime(): WhisperRuntimePaths {
  const root = process.env.MYBUDDY_WHISPER_DIR || DEFAULT_WHISPER_ROOT;
  const modelDir = join(root, "models", "whisper-medium-int8");

  const absent = missingAssets(root);
  if (absent.length) return {
    root, python: "", modelDir, available: false, pythonSource: "none",
    detail: `缺少 ${absent.map(([name]) => name).join(", ")}；当前目录：${root}`,
  };
  const { spec } = whisperCapabilitySpec(root);
  const resolved = getPythonRuntimeService().store.resolve(spec);
  const legacyPython = join(root, ".venv", venvPythonRelativePath());

  let python: string;
  let pythonSource: WhisperRuntimePaths["pythonSource"];
  let environmentId: string | undefined;
  let pythonVersion: string | undefined;
  if (resolved.ok && resolved.pythonPath) {
    python = resolved.pythonPath;
    pythonSource = "managed";
    environmentId = resolved.environmentId;
    pythonVersion = resolved.pythonVersion;
  } else if (existsSync(legacyPython)) {
    python = legacyPython;
    pythonSource = "project-venv";
  } else {
    python = legacyPython;
    pythonSource = "none";
  }

  const missing = missingAssets(root);
  const pythonReady = pythonSource !== "none";
  const available = missing.length === 0 && pythonReady;
  const detail = !pythonReady
    ? `缺少 Python 解释器：受管环境未就绪，且能力目录未提供 .venv；当前目录：${root}`
    : missing.length === 0
      ? pythonSource === "managed"
        ? `本地 Whisper 配置/依赖路径检查通过（未验证真实转写）：${root}（受管环境 ${environmentId}，Python ${pythonVersion ?? "未知"}）`
        : `本地 Whisper 配置/依赖路径检查通过（未验证真实转写）：${root}（使用能力目录自带 .venv）`
      : `缺少 ${missing.map(([name]) => name).join(", ")}；当前目录：${root}`;

  return {
    root, python, modelDir, available, detail,
    pythonSource, environmentId, pythonVersion,
  };
}

/**
 * 「检查」用的结构化视图：在 resolveWhisperRuntime() 之上补齐缺失项清单，
 * 让调用方能报告 root / pythonSource / 受管环境 / modelDir / 缺什么，
 * 而不是只拿到一句泛化文本。
 */
export interface WhisperRuntimeReport {
  root: string;
  python: string;
  pythonSource: WhisperRuntimePaths["pythonSource"];
  environmentId?: string;
  pythonVersion?: string;
  modelDir: string;
  available: boolean;
  /** 缺失的资源名（transcribe_wav.py / whisper-medium-int8 的目录名） */
  missingAssets: string[];
  detail: string;
}

export function describeWhisperRuntime(): WhisperRuntimeReport {
  const runtime = resolveWhisperRuntime();
  return {
    root: runtime.root,
    python: runtime.python,
    pythonSource: runtime.pythonSource,
    environmentId: runtime.environmentId,
    pythonVersion: runtime.pythonVersion,
    modelDir: runtime.modelDir,
    available: runtime.available,
    missingAssets: missingAssets(runtime.root).map(([name]) => name),
    detail: runtime.detail,
  };
}

/** 「检查」结果里始终出现的路径摘要（root / pythonSource / modelDir 是排障入口）。 */
export function formatWhisperRuntimeReport(report: WhisperRuntimeReport): string {
  const parts = [
    `root=${report.root}`,
    `pythonSource=${report.pythonSource}`,
    `modelDir=${report.modelDir}`,
  ];
  if (report.pythonSource === "managed") {
    parts.push(`受管环境=${report.environmentId ?? "未知"}${report.pythonVersion ? `（Python ${report.pythonVersion}）` : ""}`);
  } else if (report.python) {
    parts.push(`python=${report.python}`);
  }
  return parts.join(" · ");
}

/** 无推理依赖探测：只查解释器版本与关键模块是否可导入，不加载模型、不需要音频样本。 */
export interface WhisperDependencyProbeResult {
  ok: boolean;
  detail: string;
  pythonVersion?: string;
  missingModules?: string[];
}

/** 转写实际会用到的顶层模块；用 find_spec 判断存在性（不 import，避免拖入重依赖）。 */
export const WHISPER_DEPENDENCY_MODULES = ["openvino_genai", "openvino", "numpy", "soundfile"] as const;
export const WHISPER_PROBE_TIMEOUT_MS = 15_000;
const WHISPER_PROBE_PREFIX = "__MYBUDDY_WHISPER_PROBE__";
const WHISPER_PROBE_SCRIPT = [
  "import importlib.util, json, sys",
  "names = json.loads(sys.argv[1])",
  "missing = []",
  "for name in names:",
  "    try:",
  "        found = importlib.util.find_spec(name) is not None",
  "    except Exception:",
  "        found = False",
  "    if not found:",
  "        missing.append(name)",
  `print(${JSON.stringify(WHISPER_PROBE_PREFIX)} + json.dumps({"version": sys.version.split()[0], "missing": missing}))`,
].join("\n");

/**
 * 用解析到的解释器跑一次有界探测（默认 15s）。任何失败都降级为可读 detail，
 * 不抛出未处理异常——检查失败不应该打断设置页。
 */
export async function probeWhisperDependencies(
  python: string,
  options: { timeoutMs?: number } = {},
): Promise<WhisperDependencyProbeResult> {
  if (!python) return { ok: false, detail: "没有可用的 Python 解释器路径" };
  const timeoutMs = options.timeoutMs && options.timeoutMs > 0 ? options.timeoutMs : WHISPER_PROBE_TIMEOUT_MS;
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: WhisperDependencyProbeResult): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const child = spawn(python, ["-c", WHISPER_PROBE_SCRIPT, JSON.stringify([...WHISPER_DEPENDENCY_MODULES])], {
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const timer = setTimeout(() => {
      try { child.kill(); } catch { /* best effort */ }
      finish({ ok: false, detail: `依赖探测超时（${Math.round(timeoutMs / 1000)}s）` });
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { stdout = (stdout + chunk).slice(-100_000); });
    child.stderr.on("data", (chunk: string) => { stderr = (stderr + chunk).slice(-100_000); });
    child.once("error", (error) => finish({ ok: false, detail: `无法启动解释器：${error.message}` }));
    child.once("close", (code) => {
      if (settled) return;
      const line = stdout.split(/\r?\n/).find((item) => item.startsWith(WHISPER_PROBE_PREFIX));
      if (code !== 0 || !line) {
        const reason = (stderr.trim() || stdout.trim()).slice(-400);
        finish({ ok: false, detail: `解释器探测失败${code == null ? "" : `（exit ${code}）`}${reason ? `：${reason}` : ""}` });
        return;
      }
      try {
        const parsed = JSON.parse(line.slice(WHISPER_PROBE_PREFIX.length)) as { version?: unknown; missing?: unknown };
        const version = typeof parsed.version === "string" ? parsed.version : undefined;
        const missing = Array.isArray(parsed.missing)
          ? parsed.missing.filter((item): item is string => typeof item === "string")
          : [];
        if (missing.length > 0) {
          finish({
            ok: false,
            pythonVersion: version,
            missingModules: missing,
            detail: `缺少 Python 模块：${missing.join("、")}（Python ${version ?? "未知"}）`,
          });
          return;
        }
        finish({
          ok: true,
          pythonVersion: version,
          missingModules: [],
          detail: `Python ${version ?? "未知"}，${WHISPER_DEPENDENCY_MODULES.join(" / ")} 均可导入`,
        });
      } catch (error) {
        finish({ ok: false, detail: `依赖探测输出无法解析：${error instanceof Error ? error.message : String(error)}` });
      }
    });
  });
}

/**
 * 异步准备：真正执行转写前调用。
 * 受管环境缺失时按能力自己的 pyproject.toml 下载安装；准备失败则回退能力目录
 * 自带 .venv（若存在），两者都没有才报不可用——绝不静默改用系统 python。
 */
export async function ensureWhisperRuntime(signal?: AbortSignal): Promise<WhisperRuntimePaths> {
  const rootBeforePreparation = process.env.MYBUDDY_WHISPER_DIR || DEFAULT_WHISPER_ROOT;
  const absent = missingAssets(rootBeforePreparation);
  if (absent.length) {
    return {
      root: rootBeforePreparation, python: "", modelDir: join(rootBeforePreparation, "models", "whisper-medium-int8"),
      available: false, pythonSource: "none",
      detail: `缺少 ${absent.map(([name]) => name).join(", ")}；当前目录：${rootBeforePreparation}；未准备环境或启动转写`,
    };
  }
  const probe = resolveWhisperRuntime();
  if (probe.pythonSource === "managed" || probe.pythonSource === "project-venv") {
    const missing = missingAssets(probe.root);
    if (missing.length === 0) return probe;
  }

  const root = process.env.MYBUDDY_WHISPER_DIR || DEFAULT_WHISPER_ROOT;
  const { spec } = whisperCapabilitySpec(root);
  const resolution = await getPythonRuntimeService().resolveForExecution(spec, {
    signal,
    label: WHISPER_CAPABILITY_ID,
  });

  const modelDir = join(root, "models", "whisper-medium-int8");
  const missing = missingAssets(root);

  if (!resolution.ok) {
    const legacyPython = join(root, ".venv", venvPythonRelativePath());
    if (existsSync(legacyPython) && missing.length === 0) {
      return {
        root, python: legacyPython, modelDir,
        available: true,
        detail: `受管环境准备失败（${resolution.failureStage}），已回退能力目录自带 .venv：${root}`,
        pythonSource: "project-venv",
      };
    }
    return {
      root, python: legacyPython, modelDir,
      available: false,
      detail: `本地 Whisper 不可用：受管环境准备失败（${resolution.failureStage}）— ${resolution.detail}`,
      pythonSource: "none",
    };
  }
  const available = missing.length === 0;
  return {
    root, python: resolution.pythonPath, modelDir,
    available,
    detail: available
      ? `本地 Whisper 配置/依赖路径检查通过（未验证真实转写）：${root}（受管环境 ${resolution.environmentId}，Python ${resolution.pythonVersion}）`
      : `缺少 ${missing.map(([name]) => name).join(", ")}；当前目录：${root}`,
    pythonSource: "managed",
    environmentId: resolution.environmentId,
    pythonVersion: resolution.pythonVersion,
  };
}
