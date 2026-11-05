import { getPythonRuntimeService } from "../runtime/pythonRuntimeInstance";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpeechCapabilityProvider, SpeechToTextInput, SpeechToTextOutput, ToolExecutionContext } from "./BuiltinCapabilityRuntime";
import {
  describeWhisperRuntime,
  ensureWhisperRuntime,
  formatWhisperRuntimeReport,
  probeWhisperDependencies,
  WHISPER_PROBE_TIMEOUT_MS,
  type WhisperDependencyProbeResult,
  type WhisperRuntimeReport,
} from "../voice/whisperAsr";

const RESULT_PREFIX = "__MYBUDDY_TRANSCRIBE_RESULT__";
const TRANSCRIBE_TIMEOUT_MS = 30 * 60_000;

const PYTHON_TRANSCRIBE = String.raw`
import json
import sys
from pathlib import Path

root = Path(sys.argv[1]).resolve()
media = Path(sys.argv[2]).resolve()
out_dir = Path(sys.argv[3]).resolve()
sys.path.insert(0, str(root / "app"))

from voice_ime import WhisperTranscriber
from meeting_pipeline import transcribe_meeting_to_md

transcriber = WhisperTranscriber(str(root / "models" / "whisper-medium-int8"), "NPU", auto_start=False)
md_path, seg_count = transcribe_meeting_to_md(media, transcriber, output_dir=out_dir)
print("${RESULT_PREFIX}" + json.dumps({"path": str(md_path), "segments": seg_count}, ensure_ascii=False), flush=True)
`;

function transcriptFromMarkdown(markdown: string): string {
  return markdown
    .split(/\r?\n/)
    .filter((line) => {
      const text = line.trim();
      if (!text) return false;
      if (text === "---") return false;
      if (text.startsWith("# ") || text.startsWith("## ")) return false;
      if (text.startsWith("- ")) return false;
      return true;
    })
    .join("\n")
    .trim();
}

async function transcribeWithLocalWhisper(
  input: SpeechToTextInput,
  context: ToolExecutionContext,
): Promise<SpeechToTextOutput> {
  const runtime = await ensureWhisperRuntime(context.signal);
  if (!runtime.available) {
    throw new Error(`本地 Whisper 不可用：${runtime.detail}`);
  }

  const tempDir = mkdtempSync(join(tmpdir(), "mybuddy-whisper-"));
  try {
    const result = await new Promise<{ path: string; segments: number }>((resolve, reject) => {
      const release = runtime.environmentId ? getPythonRuntimeService().acquireExecution(runtime.environmentId) : () => {};
      const child = spawn(runtime.python, ["-u", "-c", PYTHON_TRANSCRIBE, runtime.root, input.audioPath, tempDir], {
        cwd: runtime.root,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: { ...process.env, PYTHONUNBUFFERED: "1", PYTHONIOENCODING: "utf-8" },
      });
      child.once("close", release);
      child.once("error", release);
      let stdout = "";
      let stderr = "";
      let settled = false;
      const finish = (error?: Error, value?: { path: string; segments: number }): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        context.signal?.removeEventListener("abort", onAbort);
        if (error) reject(error);
        else resolve(value!);
      };
      const onAbort = (): void => {
        try { child.kill(); } catch { /* best effort */ }
        finish(new Error("语音转文字已取消"));
      };
      const timer = setTimeout(() => {
        try { child.kill(); } catch { /* best effort */ }
        finish(new Error("本地 Whisper 转写超时"));
      }, TRANSCRIBE_TIMEOUT_MS);

      context.signal?.addEventListener("abort", onAbort, { once: true });
      child.stdout.setEncoding("utf8");
      child.stderr.setEncoding("utf8");
      child.stdout.on("data", (chunk: string) => {
        stdout = (stdout + chunk).slice(-1_000_000);
      });
      child.stderr.on("data", (chunk: string) => {
        stderr = (stderr + chunk).slice(-1_000_000);
      });
      child.once("error", (error) => finish(error));
      child.once("exit", (code) => {
        if (settled) return;
        const line = stdout.split(/\r?\n/).reverse().find((item) => item.startsWith(RESULT_PREFIX));
        if (code !== 0 || !line) {
          const detail = (stderr || stdout).trim().slice(-2_000);
          finish(new Error(`本地 Whisper 转写失败${code == null ? "" : `（exit ${code}）`}${detail ? `：${detail}` : ""}`));
          return;
        }
        try {
          const parsed = JSON.parse(line.slice(RESULT_PREFIX.length)) as { path?: unknown; segments?: unknown };
          if (typeof parsed.path !== "string") throw new Error("缺少输出路径");
          finish(undefined, {
            path: parsed.path,
            segments: typeof parsed.segments === "number" ? parsed.segments : 0,
          });
        } catch (error) {
          finish(new Error(`本地 Whisper 返回无效结果：${error instanceof Error ? error.message : String(error)}`));
        }
      });
    });

    const markdown = readFileSync(result.path, "utf8");
    const text = transcriptFromMarkdown(markdown);
    if (!text) throw new Error("本地 Whisper 未返回可用文本");
    return {
      text,
      language: input.language ?? "zh",
      provider: "local-whisper",
      metadata: {
        device: "NPU",
        model: "whisper-medium-int8",
        segments: result.segments,
        runtimeRoot: runtime.root,
      },
    };
  } finally {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

/** 「检查」的结构化结果：ok 与 detail 分离，便于 UI 分行内提示与诊断。 */
export interface LocalWhisperDiagnosis {
  ok: boolean;
  detail: string;
  report: WhisperRuntimeReport;
}

export interface LocalWhisperDiagnoseOptions {
  /** 测试注入点：默认用 probeWhisperDependencies 起子进程探测。 */
  probe?: (python: string, options: { timeoutMs?: number }) => Promise<WhisperDependencyProbeResult>;
  timeoutMs?: number;
}

/**
 * 检查本机 Whisper 配置并做一次「无推理」依赖探测。
 *
 * 只验证：路径/资源存在、解释器来源、解释器能跑起来且关键模块可导入。
 * 不加载模型、不需要音频样本、超时有界（默认 15s）；探测失败降级为 detail 文本。
 */
export async function diagnoseLocalWhisper(options: LocalWhisperDiagnoseOptions = {}): Promise<LocalWhisperDiagnosis> {
  const report = describeWhisperRuntime();
  const summary = formatWhisperRuntimeReport(report);
  if (!report.available) {
    const reason = report.missingAssets.length > 0 ? `缺少 ${report.missingAssets.join("、")}` : report.detail;
    return { ok: false, report, detail: `本机 Whisper 不可用：${reason}；${summary}` };
  }
  let probe: WhisperDependencyProbeResult;
  try {
    probe = await (options.probe ?? probeWhisperDependencies)(report.python, {
      timeoutMs: options.timeoutMs ?? WHISPER_PROBE_TIMEOUT_MS,
    });
  } catch (error) {
    probe = { ok: false, detail: `依赖探测进程异常：${error instanceof Error ? error.message : String(error)}` };
  }
  const version = probe.pythonVersion ? ` · Python ${probe.pythonVersion}` : "";
  if (!probe.ok) {
    return {
      ok: false,
      report,
      detail: `本机 Whisper 配置检查通过（未运行模型推理），但依赖探测未通过：${probe.detail}；${summary}${version}`,
    };
  }
  return {
    ok: true,
    report,
    detail: `本机 Whisper 检查通过（未运行模型推理）：${summary}${version} · 依赖探测：${probe.detail}`,
  };
}

export function createLocalWhisperSpeechProvider(options: LocalWhisperDiagnoseOptions = {}): SpeechCapabilityProvider {
  return {
    id: "local-whisper",
    label: "本地 Whisper · NPU",
    speechToText: transcribeWithLocalWhisper,
    async test(): Promise<string> {
      const diagnosis = await diagnoseLocalWhisper(options);
      // 配置缺失与依赖探测失败都走失败态：抛出的错误由上层 MediaCapabilityServices.test()
      // 的 catch 转成 ok:false 并带上原因（既有契约），不是未捕获崩溃。
      if (!diagnosis.ok) throw new Error(diagnosis.detail);
      return diagnosis.detail;
    },
  };
}
