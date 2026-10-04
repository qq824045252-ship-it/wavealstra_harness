import { getPythonRuntimeService } from "../runtime/pythonRuntimeInstance";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SpeechCapabilityProvider, SpeechToTextInput, SpeechToTextOutput, ToolExecutionContext } from "./BuiltinCapabilityRuntime";
import { ensureWhisperRuntime, resolveWhisperRuntime } from "../voice/whisperAsr";

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

export function createLocalWhisperSpeechProvider(): SpeechCapabilityProvider {
  return {
    id: "local-whisper",
    label: "本地 Whisper · NPU",
    speechToText: transcribeWithLocalWhisper,
    async test(): Promise<string> {
      const runtime = resolveWhisperRuntime();
      if (!runtime.available) throw new Error(runtime.detail);
      return `本地 Whisper 已就绪 · ${runtime.root}`;
    },
  };
}
