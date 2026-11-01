import { venvPythonRelativePath } from "../platform/runtime";
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
